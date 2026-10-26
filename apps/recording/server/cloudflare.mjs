import { fail } from './security.mjs';
export function cloudflareSessions(env, fetcher = fetch) {
  return async (room, action, actor, payload = {}) => {
    const url = new URL(`/rooms/${room}`, env.CF_SIGNALING_URL);
    if (url.protocol !== 'https:') throw fail(503, '接続管理サーバーはHTTPSで設定してください');
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SIGNALING_SERVICE_SECRET}` }, body: JSON.stringify({ action, actor, payload }), signal: AbortSignal.timeout(8000) });
    const value = await response.json();
    if (!response.ok) throw fail([400, 403, 409, 410, 413, 429].includes(response.status) ? response.status : 502, value.error || '接続状態を確認できません');
    return value;
  };
}
export async function turnCredentials(env, fetcher = fetch, ttl = 10800) {
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 10800) throw fail(400, 'TURN認証の有効期間を確認してください');
  if (!/^[a-zA-Z0-9_-]+$/.test(env.CLOUDFLARE_TURN_KEY_ID || '')) throw fail(503, 'Cloudflare TURNキーを設定してください');
  const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}` }, body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw fail(502, 'Cloudflare TURNの認証情報を発行できません');
  const value = await response.json();
  const iceServers = (Array.isArray(value.iceServers) ? value.iceServers : []).map(s => ({
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && /^(stun|turn|turns):/.test(u) && !/:53(?:\?|$)/.test(u)),
    ...(typeof s.username === 'string' && typeof s.credential === 'string' ? { username: s.username, credential: s.credential } : {})
  })).filter(s => s.urls.length);
  if (!iceServers.some(s => s.credential && s.urls.some(u => /^turns?:/.test(u)))) throw fail(502, 'TURNの接続情報が不完全です');
  return iceServers;
}
