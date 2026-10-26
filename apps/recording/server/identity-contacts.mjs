import { randomUUID, createHash } from 'node:crypto';
import { verifyEnvelope, verifyCertificate } from '../shared/identity-crypto.mjs';
import { equal, fail, newRoom } from './security.mjs';
import { validateSubscription } from './contacts.mjs';
import { createHandler } from './handler.mjs';
import webpush from 'web-push';
const uuidFor = value => { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
export function createIdentityHandler(kind, env = process.env, injected = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const own = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const origin = req.headers.origin;
    if (origin && origin !== own && !(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).includes(origin)) return res.status(403).json({ error: '許可されていない接続元です' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POSTを使用してください' });
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 20000) throw fail(413, '入力が長すぎます');
      const enabled = env.IDENTITY_CALLING_ENABLED === '1' && !!env.CF_SIGNALING_URL && env.SIGNALING_SERVICE_SECRET?.length >= 32 && env.APP_SESSION_SECRET?.length >= 32 && env.IPPO_ACCESS_CODE?.length >= 32;
      const pushConfigured = !!(env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT);
      if (kind === 'contacts' && body.action === 'health') return res.json({ enabled, protocol: 'identity-v1', pushConfigured, publicKey: pushConfigured ? env.WEB_PUSH_PUBLIC_KEY : '' });
      if (!enabled) throw fail(503, '連絡先からの呼び出しは準備中です。招待リンクで通話できます');
      const audience = `ippo-${kind}-v1`;
      const actor = await verifyEnvelope(body.envelope, audience);
      const { action, fields: p = {} } = body.envelope.data;
      const allowed = kind === 'contacts' ? ['register', 'status', 'exchange-create', 'exchange-claim', 'exchange-approve', 'remove', 'enroll-result', 'enroll-approve', 'revoke', 'subscribe'] : ['status', 'ring', 'accept', 'decline', 'busy', 'cancel', 'finish'];
      if (!allowed.includes(action)) throw fail(400, '操作を確認してください');
      const send = async (command, payload = {}, internal = false) => {
        const request = { action: command, payload, internal, envelope: body.envelope, audience };
        if (injected.directory) return injected.directory(request, actor);
        const url = new URL('/identity-directory', env.CF_SIGNALING_URL);
        if (url.protocol !== 'https:') throw fail(503, '接続管理の設定を確認してください');
        const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.SIGNALING_SERVICE_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
        const value = await r.json(); if (!r.ok) throw fail(r.status, value.error || '登録情報を更新できません'); return value;
      };
      const call = async (action, fields, room, participantId, auth) => {
        if (injected.callApi) return injected.callApi(action, fields, room, participantId, auth);
        const handler = createHandler(env, { room, participantId });
        const result = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
        await handler({ method: 'POST', headers: { host: 'internal', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: { action, ...fields } }, result);
        if (result.code >= 400) throw fail(result.code, result.value.error); return result.value;
      };
      if (action === 'register') {
        if (!equal(p.accessCode || '', env.IPPO_ACCESS_CODE)) throw fail(401, '初回登録の合言葉が違います');
        return res.status(201).json(await send(action, { certificate: body.envelope.certificate, bootstrap: true }, true));
      }
      if (action === 'enroll-approve') {
        const added = await verifyCertificate(p.certificate);
        if (added.userId !== actor.userId || !p.certificate.chain.length || p.certificate.chain.at(-1).key === actor.publicKey) throw fail(403, '追加する端末を確認してください');
        const chain = p.certificate.chain;
        if (chain.at(-2)?.key !== actor.publicKey && !(chain.length === 1 && p.certificate.root === actor.publicKey)) throw fail(403, 'この端末が承認した鍵ではありません');
        return res.json(await send(action, { id: p.id, token: p.token, book: p.book, certificate: p.certificate, verifiedUser: added.userId, verifiedDevice: added.deviceId, verifiedKey: added.publicKey }, true));
      }
      if (action === 'subscribe') return res.json(await send(action, { subscription: validateSubscription(p.subscription) }));
      if (kind === 'contacts') return res.json(await send(action, { ...p, ...(action === 'exchange-claim' ? { certificate: body.envelope.certificate } : {}) }));
      if (action === 'ring') {
        const value = await send('ring', { id: p.id, userId: p.userId, room: newRoom(), offer: body.envelope });
        if (value.state !== 'preparing') return res.json({ call: value, ...await send('credentials', { id: p.id }, true) });
        let host;
        try {
          // Names stay in each phonebook. Recording metadata uses opaque speaker identifiers.
          host = await call('create', { name: `利用者 ${actor.userId.slice(0, 8)}`, accessCode: env.IPPO_ACCESS_CODE }, value.room, uuidFor(`${p.id}:host`));
          let delivered = 0;
          if (pushConfigured) await Promise.allSettled(value.subscriptions.map(async ({ subscription }) => {
            const sendPush = injected.sendPush || webpush.sendNotification;
            await sendPush(subscription, JSON.stringify({ type: 'incoming', callId: p.id, expiresAt: value.expiresAt }), { TTL: Math.max(0, Math.floor((value.expiresAt - Date.now()) / 1000)), urgency: 'high', topic: p.id.replaceAll('-', '').slice(0, 32), timeout: 8000, vapidDetails: { subject: env.WEB_PUSH_SUBJECT, publicKey: env.WEB_PUSH_PUBLIC_KEY, privateKey: env.WEB_PUSH_PRIVATE_KEY } }); delivered++;
          }));
          const ready = await send('ready', { id: p.id, host, push: delivered ? 'submitted' : 'unavailable' }, true);
          return res.json({ call: ready, credentials: host });
        } catch (e) { await send('cancel', { id: p.id }, true).catch(() => {}); if (host) await call('end', {}, null, null, host.auth).catch(() => {}); throw e; }
      }
      if (action === 'accept') {
        const value = await send(action, { id: p.id });
        const cached = await send('guest-credentials', { id: p.id }, true);
        if (cached.credentials) return res.json(cached);
        const credentials = await call('join', { invite: value.invite, name: `利用者 ${actor.userId.slice(0, 8)}` }, value.room, uuidFor(`${p.id}:guest:${actor.deviceId}`));
        return res.json(await send('guest', { id: p.id, credentials }, true));
      }
      return res.json(await send(action, { id: p.id }));
    } catch (e) { return res.status(e.status || 502).json({ error: e.status ? e.message : '呼び出しに失敗しました。再試行してください' }); }
  };
}
