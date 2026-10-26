// Operator-only OAuth + Google-hosted Picker. Tokens never enter the browser.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { folderId, verifyFolder } from './drive-folder.mjs';

export async function startDriveSetup({ env = process.env, fetcher = fetch, save, port = 53682 } = {}) {
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    if (!env[key]) throw new Error(`.envに${key}を設定してください`);
  }
  const target = folderId(env.GOOGLE_DRIVE_TARGET_FOLDER_ID);
  if (env.GOOGLE_DRIVE_TARGET_FOLDER_ID && !target) throw new Error('収集先フォルダのID／URLが無効です');
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  let processing = false, finished = false, origin, redirect;
  const persist = save || (async values => {
    let file = await readFile('.env', 'utf8');
    for (const [key, value] of Object.entries(values)) {
      const line = `${key}=${value}`;
      file = new RegExp(`^${key}=.*$`, 'm').test(file) ? file.replace(new RegExp(`^${key}=.*$`, 'm'), () => line) : `${file}\n${line}\n`;
    }
    await writeFile('.env', file, { mode: 0o600 });
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    const reply = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error })); };
    if (req.headers.host !== new URL(origin).host) return reply(403, '接続元が無効です');
    const url = new URL(req.url, origin);
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state || !url.searchParams.get('code') || processing || finished) return reply(400, 'OAuth応答が無効です。セットアップを再実行してください。');
    // Only Google's explicit Picker selection can establish the destination.
    const selected = url.searchParams.get('picked_file_ids') || '';
    if (!folderId(selected) || folderId(selected) !== selected || (target && selected !== target)) return reply(400, '指定された収集先フォルダを一つ選択してください。');
    processing = true;
    try {
      const response = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }), signal: AbortSignal.timeout(12000)
      });
      const token = await response.json();
      if (!response.ok || !token.refresh_token || !token.access_token) throw new Error('OAuth failed');
      const folder = await verifyFolder(fetcher, token.access_token, selected, target);
      await persist({ GOOGLE_DRIVE_REFRESH_TOKEN: token.refresh_token, GOOGLE_DRIVE_FOLDER_ID: folder.id, GOOGLE_DRIVE_TARGET_FOLDER_ID: folder.id });
      finished = true;
      const name = String(folder.name).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>収集用Driveの接続完了</title><style>body{font:18px/1.8 system-ui;background:#f6f7f1;color:#203b32;max-width:720px;margin:64px auto;padding:24px}</style><h1>収集用Driveを接続しました</h1><p>保存先：${name}</p><p>接続情報はこのPCの.envに保存しました。Vercelの非公開設定への反映と、実際の保存確認を続けます。</p><a href="https://drive.google.com/drive/folders/${folder.id}" rel="noreferrer">保存先を開く</a><script>history.replaceState(null,'','/complete')</script></html>`);
      console.log('既存フォルダへの接続情報を.envへ保存しました。');
      server.close();
    } catch (error) { reply(400, error.message.includes('フォルダ') || error.message.includes('権限') ? error.message : 'Google接続に失敗しました。セットアップを再実行してください。'); }
    finally { processing = false; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`; redirect = `${origin}/callback`;
  const query = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', trigger_onepick: 'true', allow_multiple: 'false', allow_folder_selection: 'true', mimetypes: 'application/vnd.google-apps.folder', ...(target ? { file_ids: target } : {}) });
  server.setTimeout(120000);
  const deadline = setTimeout(() => { finished = true; server.closeAllConnections(); server.close(); }, 10 * 60 * 1000); deadline.unref();
  server.on('close', () => clearTimeout(deadline));
  return { server, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const setup = await startDriveSetup();
  console.log('収集担当者のGoogleアカウントで認証し、Googleの画面で既存の収集先フォルダを選択してください。');
  console.log(setup.authorizationUrl);
}
