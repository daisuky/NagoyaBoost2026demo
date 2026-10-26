import { verify, fail } from '../server/security.mjs';
import { prepareUpload } from '../server/drive.mjs';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  const own = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  if (origin && origin !== own && !allowed.includes(origin)) return res.status(403).json({ error: '許可されていない接続元です' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTを使用してください' });
  try {
    if (!process.env.APP_SESSION_SECRET || process.env.APP_SESSION_SECRET.length < 32) throw fail(503, 'サーバー未設定です');
    const auth = verify(process.env.APP_SESSION_SECRET, String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (auth.role !== 'host' || auth.scope !== 'archive' || auth.invite) throw fail(403, '録音の作成者だけが送信できます');
    return res.status(200).json(await prepareUpload(process.env, auth, req.body || {}, origin));
  } catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : 'Driveへ接続できませんでした' }); }
}
