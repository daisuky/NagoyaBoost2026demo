import { randomUUID } from 'node:crypto';
import { CONSENT_VERSION, equal, issue, verify, fail, newRoom } from './security.mjs';
import { archiveConfigured } from './drive.mjs';
import { cloudflareSessions, turnCredentials } from './cloudflare.mjs';
export function createHandler(env = process.env, injected = {}) {
  const sessions = injected.sessions || cloudflareSessions(env);
  const turn = injected.turn || (() => turnCredentials(env));
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const ownOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const origins = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (origin && origin !== ownOrigin && !origins.includes(origin)) return res.status(403).json({ error: '許可されていない接続元です' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POSTを使用してください' });
    const configured = ['CF_SIGNALING_URL', 'SIGNALING_SERVICE_SECRET', 'CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN', 'APP_SESSION_SECRET', 'IPPO_ACCESS_CODE'].every(key => env[key]) && env.APP_SESSION_SECRET?.length >= 32 && env.IPPO_ACCESS_CODE?.length >= 32 && env.SIGNALING_SERVICE_SECRET?.length >= 32;
    const body = req.body || {};
    if (body.action === 'health') return res.status(200).json({ configured, provider: 'cloudflare-turn', archiveConfigured: archiveConfigured(env), archiveLabel: env.ARCHIVE_LABEL || '収集チーム', consentVersion: CONSENT_VERSION });
    try {
      if (!configured) throw fail(503, '通話サーバーは未設定です。管理者がCloudflare TURNと接続管理を設定してください。');
      if (!['create', 'join', 'heartbeat', 'consent', 'status', 'start', 'stop', 'leave', 'end', 'signal'].includes(body.action)) throw fail(400, '操作を確認してください');
      if (JSON.stringify(body).length > 20000) throw fail(413, '入力が長すぎます');
      if (['create', 'join'].includes(body.action)) {
        const name = String(body.name || '').trim().slice(0, 40); if (!name) throw fail(400, '表示名を入力してください');
        let room, role;
        if (body.action === 'create') {
          if (!equal(body.accessCode || '', env.IPPO_ACCESS_CODE)) throw fail(401, '通話作成の合言葉が違います。収集担当者から受け取った合言葉を確認してください');
          room = injected.room || newRoom(); role = 'host';
        } else {
          const invite = verify(env.APP_SESSION_SECRET, body.invite);
          if (!invite.invite || invite.role !== 'guest' || invite.scope) throw fail(403, '招待リンクを確認してください');
          room = invite.room; role = 'guest';
        }
        const actor = { role, participantId: injected.participantId || randomUUID() };
        const iceServers = await turn();
        const status = await sessions(room, body.action, actor, { name });
        const credentials = { room, ...actor, iceServers, status, auth: issue(env.APP_SESSION_SECRET, { room, ...actor }) };
        if (role === 'host') {
          credentials.invite = issue(env.APP_SESSION_SECRET, { room, role: 'guest', invite: true });
          credentials.archiveAuth = issue(env.APP_SESSION_SECRET, { room, role, scope: 'archive' }, Date.now(), 7 * 86400000);
        }
        return res.status(body.action === 'create' ? 201 : 200).json(credentials);
      }
      const auth = verify(env.APP_SESSION_SECRET, String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (auth.invite || auth.scope || !/^[a-f0-9-]{36}$/.test(auth.participantId || '')) throw fail(403, '参加後の認証が必要です');
      const { action, ...payload } = body;
      return res.status(200).json(await sessions(auth.room, action, { role: auth.role, participantId: auth.participantId }, payload));
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.status ? error.message : '通話サービスへの接続に失敗しました。時間をおいて再試行してください。' });
    }
  };
}
