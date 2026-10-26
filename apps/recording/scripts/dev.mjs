import http from 'node:http';
import { createServer } from 'vite';
import { loadEnv } from 'vite';
Object.assign(process.env, loadEnv('development', process.cwd(), ''));
process.env.ALLOWED_ORIGINS ||= 'http://localhost:5173,http://127.0.0.1:5173';
const { default: handler } = await import('../api/call.js');
const { default: archive } = await import('../api/archive.js');
const { default: contacts } = await import('../api/contacts.js');
const { default: incoming } = await import('../api/incoming.js');
const { turnCredentials } = await import('../server/cloudflare.mjs');
const api = http.createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.url === '/api/qa-production-call') {
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.IPPO_ENABLE_TURN_QA !== '1' || req.method !== 'POST' || !['http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin)) return res.status(403).json({ error: '本番接続QAはローカルで明示的に有効化してください' });
    let origin;
    try {
      const configured = new URL(process.env.IPPO_QA_API_ORIGIN || '');
      if (configured.protocol !== 'https:' || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) throw new Error('Invalid QA origin');
      origin = configured.origin;
    } catch { return res.status(503).json({ error: '検証先のHTTPSオリジンをIPPO_QA_API_ORIGINへ設定してください' }); }
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return res.status(413).json({ error: 'Too large' }); }
      const body = JSON.parse(raw);
      if (body.action === 'create') body.accessCode = process.env.IPPO_ACCESS_CODE;
      const upstream = await fetch(origin + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      return res.status(upstream.status).json(await upstream.json());
    } catch { return res.status(502).json({ error: '本番接続QAとの通信に失敗しました' }); }
  }
  // Local-only, opt-in QA. This route is never included in the Vercel API.
  if (req.url === '/api/qa-turn') {
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.IPPO_ENABLE_TURN_QA !== '1' || req.method !== 'POST' || !['http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin)) return res.status(403).json({ error: 'TURN QAはローカルで明示的に有効化してください' });
    try {
      const [host, guest] = await Promise.all([turnCredentials(process.env, fetch, 600), turnCredentials(process.env, fetch, 600)]);
      return res.json({ host, guest });
    } catch { return res.status(502).json({ error: 'TURN検証用の短期認証情報を発行できません' }); }
  }
  const routes = { '/api/call': handler, '/api/archive': archive, '/api/contacts': contacts, '/api/incoming': incoming };
  if (!routes[req.url]) return res.status(404).json({ error: 'Not found' });
  try { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return res.status(413).json({ error: 'Too large' }); }
    req.body = raw ? JSON.parse(raw) : {}; await routes[req.url](req, res);
  } catch { res.status(400).json({ error: 'リクエストを確認してください' }); }
});
api.listen(8788, '127.0.0.1');
const vite = await createServer(); await vite.listen(); vite.printUrls();
function close() { api.close(); void vite.close().then(() => process.exit()); }
process.on('SIGINT', close); process.on('SIGTERM', close);
