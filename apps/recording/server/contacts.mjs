import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { equal, fail, newRoom } from './security.mjs';
import { teamMembers } from '../shared/directory.mjs';
import { createHandler } from './handler.mjs';
import webpush from 'web-push';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuidFor = value => { const h = hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const key = () => `${randomUUID()}.${randomBytes(32).toString('base64url')}`;
export function deviceActor(value) {
  const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value || '');
  if (!match) throw fail(401, 'この端末を登録してください');
  return { id: match[1], proof: hash(value) };
}
export function validateSubscription(value) {
  if (value === null) return null;
  let url; try { url = new URL(value?.endpoint); } catch { throw fail(400, '通知先が無効です'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || value.endpoint.length > 4096 || !(host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com'))) throw fail(400, '対応する通知サービスを登録してください');
  if (!/^[A-Za-z0-9_-]{87}$/.test(value.keys?.p256dh || '') || !/^[A-Za-z0-9_-]{22}$/.test(value.keys?.auth || '')) throw fail(400, '通知鍵が無効です');
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
export function directoryService(env) {
  return async (action, actor, payload = {}) => {
    const url = new URL('/directory', env.CF_SIGNALING_URL);
    if (url.protocol !== 'https:') throw fail(503, '接続管理の設定を確認してください');
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.SIGNALING_SERVICE_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, actor, payload }), signal: AbortSignal.timeout(10000) });
    const result = await res.json(); if (!res.ok) throw fail(res.status, result.error || '呼び出し情報を更新できません'); return result;
  };
}
export function createContactsHandler(kind, env = process.env, injected = {}) {
  const directory = injected.directory || directoryService(env);
  const callApi = async (action, fields, room, participantId, auth) => {
    if (injected.callApi) return injected.callApi(action, fields, room, participantId, auth);
    const handler = createHandler(env, { room, participantId });
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await handler({ method: 'POST', headers: { host: 'internal', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: { action, ...fields } }, res);
    if (res.code >= 400) throw fail(res.code, res.value.error); return res.value;
  };
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const own = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    if (origin && origin !== own && !(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).includes(origin)) return res.status(403).json({ error: '許可されていない接続元です' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POSTを使用してください' });
    try {
      const p = req.body || {};
      if (JSON.stringify(p).length > 16000) throw fail(413, '入力が長すぎます');
      const members = teamMembers(env.TEAM_MEMBER_NAMES);
      const enabled = env.CALLING_ENABLED === '1' && !!env.CF_SIGNALING_URL && env.SIGNALING_SERVICE_SECRET?.length >= 32 && env.APP_SESSION_SECRET?.length >= 32 && env.IPPO_ACCESS_CODE?.length >= 32;
      const pushConfigured = !!(env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT);
      if (kind === 'contacts' && p.action === 'health') return res.json({ enabled, pushConfigured, publicKey: pushConfigured ? env.WEB_PUSH_PUBLIC_KEY : '', members });
      if (!enabled) throw fail(503, 'メンバー呼び出しは準備中です。招待リンクで通話できます');
      const rawKey = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const actor = rawKey ? deviceActor(rawKey) : null;
      const nameOf = memberId => members.find(m => m.id === memberId)?.name || 'メンバー';
      if (kind === 'contacts') {
        if (p.action === 'register') {
          if (!equal(p.accessCode || '', env.IPPO_ACCESS_CODE)) throw fail(401, '通話作成の合言葉が違います');
          const credential = key(); const a = deviceActor(credential);
          const value = await directory('register', null, { ...a, memberId: p.memberId, replace: p.replace === true });
          return res.status(201).json({ ...value, credential });
        }
        if (p.action === 'invite') {
          const token = randomBytes(32).toString('base64url'), id = randomUUID();
          const value = await directory('invite', actor, { id, token: hash(token), memberId: p.memberId });
          return res.json({ ...value, id, token, memberId: p.memberId });
        }
        if (p.action === 'redeem') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(p.token || '')) throw fail(400, '登録リンクを確認してください');
          const credential = rawKey || key(), a = deviceActor(credential);
          const value = await directory('redeem', actor, { ...a, inviteId: p.inviteId, token: hash(p.token), memberId: p.memberId });
          return res.json({ ...value, credential });
        }
        if (!['status', 'approve', 'remove', 'unregister', 'subscribe'].includes(p.action)) throw fail(400, '操作を確認してください');
        const payload = p.action === 'subscribe' ? { subscription: validateSubscription(p.subscription) } : { id: p.id, memberId: p.memberId };
        return res.json(await directory(p.action, actor, payload));
      }
      if (p.action === 'status') return res.json(await directory('status', actor));
      if (p.action === 'ring') {
        const call = await directory('ring', actor, { id: p.id, memberId: p.memberId, room: newRoom() });
        if (call.state !== 'preparing') {
          const value = await directory('credentials', actor, { id: p.id });
          const { subscription, ...publicCall } = call; return res.json({ call: publicCall, ...value });
        }
        let host;
        try {
          const status = await directory('status', actor);
          host = await callApi('create', { name: nameOf(status.self), accessCode: env.IPPO_ACCESS_CODE }, call.room, uuidFor(`${p.id}:host`));
          let push = call.subscription ? 'failed' : 'unavailable';
          if (call.subscription && pushConfigured) {
            try {
              const send = injected.sendPush || webpush.sendNotification;
              await send(call.subscription, JSON.stringify({ type: 'incoming', callId: p.id, expiresAt: call.expiresAt }), { TTL: Math.max(0, Math.floor((call.expiresAt - Date.now()) / 1000)), urgency: 'high', topic: p.id.replaceAll('-', '').slice(0, 32), timeout: 8000, vapidDetails: { subject: env.WEB_PUSH_SUBJECT, publicKey: env.WEB_PUSH_PUBLIC_KEY, privateKey: env.WEB_PUSH_PRIVATE_KEY } });
              push = 'submitted';
            } catch (error) { if ([404, 410].includes(error.statusCode)) { push = 'expired-subscription'; await directory('push-expired', actor, { id: p.id, endpoint: call.subscription.endpoint }); } }
          }
          const ready = await directory('ready', actor, { id: p.id, host, invite: host.invite, push });
          return res.json({ call: ready, credentials: host });
        } catch (error) {
          await directory('cancel', actor, { id: p.id }).catch(() => {});
          if (host) await callApi('end', {}, null, null, host.auth).catch(() => {});
          throw error;
        }
      }
      if (p.action === 'accept') {
        const value = await directory('accept', actor, { id: p.id });
        const cached = await directory('guest-credentials', actor, { id: p.id });
        if (cached.credentials) return res.json(cached);
        const status = await directory('status', actor);
        const credentials = await callApi('join', { invite: value.invite, name: nameOf(status.self) }, value.room, uuidFor(`${p.id}:guest`));
        return res.json(await directory('guest', actor, { id: p.id, credentials }));
      }
      if (!['decline', 'busy', 'cancel', 'finish'].includes(p.action)) throw fail(400, '操作を確認してください');
      return res.json(await directory(p.action, actor, { id: p.id }));
    } catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : '呼び出しに失敗しました。再試行してください' }); }
  };
}
