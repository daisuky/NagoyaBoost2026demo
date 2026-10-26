import test from 'node:test';
import assert from 'node:assert/strict';
import { b64, sign, verifyEnvelope, verifyCertificate, confirmationCode, digest } from '../shared/identity-crypto.mjs';
import { identityCommand } from '../shared/identity-directory.mjs';
import { createIdentityHandler } from '../server/identity-contacts.mjs';
import { IdentityDirectory } from '../cloudflare/signaling/index.mjs';
const now = Date.now();
async function identity(parent) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const key = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const certificate = parent ? { root: parent.certificate.root, chain: [...parent.certificate.chain, { key, signature: await sign(parent.privateKey, { purpose: 'ippo-device-v1', root: parent.certificate.root, parent: parent.actor.publicKey, key }) }] } : { root: key, chain: [] };
  return { privateKey: keys.privateKey, certificate, actor: await verifyCertificate(certificate) };
}
const [a, b, c, b2, b3] = await (async () => { const a = await identity(), b = await identity(), c = await identity(), b2 = await identity(b); return [a, b, c, b2, await identity(b2)]; })();
const envelope = async (me, action, fields = {}, endpoint = 'contacts', at = now) => {
  const data = { audience: `ippo-${endpoint}-v1`, action, fields, at, nonce: crypto.randomUUID() }; return { certificate: me.certificate, data, signature: await sign(me.privateKey, data) };
};
function fixture() {
  let state;
  const command = (me, action, payload = {}, internal = false, nonce = crypto.randomUUID(), at = now) => { const r = identityCommand(state, { action, actor: me.actor, payload, internal, nonce }, at); state = r.state; return r.response; };
  const register = me => command(me, 'register', { bootstrap: true, certificate: me.certificate }, true);
  register(a); register(b); register(c);
  const pair = () => { const id = crypto.randomUUID(), token = 't'.repeat(43); command(a, 'exchange-create', { id, token }); command(b, 'exchange-claim', { id, token, certificate: b.certificate, card: 'encrypted-card' }); command(a, 'exchange-approve', { id }); command(b, 'exchange-approve', { id }); return id; };
  const add = (parent, me) => command(parent, 'enroll-approve', { id: crypto.randomUUID(), token: 'u'.repeat(43), certificate: me.certificate, verifiedUser: me.actor.userId, verifiedDevice: me.actor.deviceId, verifiedKey: me.actor.publicKey, book: 'encrypted-book' }, true);
  return { command, register, pair, add, state: () => state };
}
test('real P-256 signatures reject tampering, wrong audience, stale packets and substituted keys', async () => {
  const e = await envelope(a, 'status'); assert.equal((await verifyEnvelope(e, 'ippo-contacts-v1', now)).userId, a.actor.userId);
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', a.privateKey));
  await assert.rejects(verifyEnvelope({ ...e, data: { ...e.data, action: 'ring' } }, 'ippo-contacts-v1', now), { status: 401 });
  await assert.rejects(verifyEnvelope(e, 'ippo-incoming-v1', now), { status: 401 });
  await assert.rejects(verifyEnvelope(e, 'ippo-contacts-v1', now + 120001), { status: 401 });
  await assert.rejects(verifyEnvelope({ ...e, certificate: b.certificate }, 'ippo-contacts-v1', now), { status: 401 });
});
test('device delegation keeps one user ID with separate keys and rejects forged approval', async () => {
  assert.equal(b2.actor.userId, b.actor.userId); assert.notEqual(b2.actor.deviceId, b.actor.deviceId);
  assert.equal(b3.actor.userId, b.actor.userId);
  const forged = structuredClone(b2.certificate); forged.chain[0].key = c.actor.publicKey;
  await assert.rejects(verifyCertificate(forged), { status: 401 });
  assert.equal(await confirmationCode('exchange', a.certificate.root, b.certificate.root), await confirmationCode('exchange', b.certificate.root, a.certificate.root));
  assert.notEqual(await confirmationCode('exchange', a.certificate.root, b.certificate.root), await confirmationCode('exchange', a.certificate.root, c.certificate.root));
});
test('one-use contact link requires both approvals and cannot be claimed by another user', () => {
  const f = fixture(), id = crypto.randomUUID(), token = 't'.repeat(43);
  f.command(a, 'exchange-create', { id, token });
  assert.throws(() => f.command(b, 'exchange-claim', { id, token: 'x'.repeat(43), certificate: b.certificate, card: 'opaque' }), { status: 410 });
  f.command(b, 'exchange-claim', { id, token, certificate: b.certificate, card: 'opaque' });
  assert.throws(() => f.command(c, 'exchange-claim', { id, token, certificate: c.certificate, card: 'opaque' }), { status: 409 });
  const ring = () => f.command(a, 'ring', { id: crypto.randomUUID(), userId: b.actor.userId, room: `ippo-${crypto.randomUUID()}` });
  assert.throws(ring, { status: 403 }); f.command(a, 'exchange-approve', { id }); assert.throws(ring, { status: 403 });
  f.command(b, 'exchange-approve', { id }); assert.equal(ring().state, 'preparing');
  assert.equal(f.command(c, 'status').contacts.length, 0);
});
test('multi-device ringing routes only to the chosen user; first answer exclusively obtains media credentials', () => {
  const f = fixture(); f.pair(); f.add(b, b2);
  const sub = id => ({ endpoint: `https://fcm.googleapis.com/${id}`, keys: { auth: 'x', p256dh: 'y' } });
  f.command(a, 'subscribe', { subscription: sub('caller') }); f.command(b, 'subscribe', { subscription: sub('phone') }); f.command(b2, 'subscribe', { subscription: sub('pc') }); f.command(c, 'subscribe', { subscription: sub('unrelated') });
  const id = crypto.randomUUID(), room = `ippo-${crypto.randomUUID()}`;
  const ring = f.command(a, 'ring', { id, userId: b.actor.userId, room, offer: 'signed-offer' });
  assert.deepEqual(ring.subscriptions.map(x => x.subscription.endpoint).sort(), ['https://fcm.googleapis.com/pc', 'https://fcm.googleapis.com/phone']);
  f.command(a, 'ready', { id, host: { invite: 'private-invite', auth: 'host-secret' }, push: 'submitted' }, true);
  f.command(b2, 'accept', { id });
  assert.throws(() => f.command(b, 'accept', { id }), { status: 409 });
  assert.throws(() => f.command(b, 'guest-credentials', { id }, true), { status: 403 });
  assert.throws(() => f.command(b, 'finish', { id }), { status: 403 });
  assert.throws(() => f.command(b2, 'credentials', { id }, true), { status: 403 });
  f.command(b2, 'guest', { id, credentials: { auth: 'winner-only' } }, true);
  assert.equal(f.command(b2, 'guest-credentials', { id }, true).credentials.auth, 'winner-only');
  const snapshot = JSON.stringify(f.command(b, 'status'));
  assert.ok(!snapshot.includes('host-secret') && !snapshot.includes('winner-only') && !snapshot.includes('private-invite'));
  f.command(b2, 'finish', { id }); assert.equal(f.state().calls[id].guest, undefined);
});
test('revocation removes push, prevents reenrollment and revokes descendant devices without affecting the root', () => {
  const f = fixture(); f.add(b, b2); f.add(b2, b3);
  f.command(b, 'revoke', { deviceId: b2.actor.deviceId });
  assert.throws(() => f.command(b2, 'status'), { status: 401 }); assert.throws(() => f.command(b3, 'status'), { status: 401 });
  assert.throws(() => f.add(b, b2), { status: 403 });
  assert.equal(f.command(b, 'status').devices.length, 1);
  assert.equal(f.state().devices[b2.actor.deviceId].subscription, null);
});
test('replayed mutations, expired exchange, cancelled and expired calls cannot be reused', () => {
  const f = fixture(), nonce = crypto.randomUUID(), id = crypto.randomUUID();
  f.command(a, 'exchange-create', { id, token: 't'.repeat(43) }, false, nonce);
  assert.throws(() => f.command(a, 'exchange-create', { id, token: 't'.repeat(43) }, false, nonce), { status: 409 });
  assert.throws(() => f.command(b, 'exchange-claim', { id, token: 't'.repeat(43), card: 'opaque' }, false, crypto.randomUUID(), now + 600001), { status: 410 });
  f.pair(); const callId = crypto.randomUUID(); f.command(a, 'ring', { id: callId, userId: b.actor.userId, room: `ippo-${crypto.randomUUID()}` });
  f.command(a, 'ready', { id: callId, host: { invite: 'x' } }, true);
  assert.throws(() => f.command(b, 'accept', { id: callId }, false, crypto.randomUUID(), now + 60001), { status: 409 });
});
test('central reset preserves cryptographic IDs but does not silently restore contact permission', () => {
  const f = fixture(); f.pair(); const userId = a.actor.userId;
  const rebuilt = fixture(); assert.equal(rebuilt.command(a, 'status').self, userId);
  assert.equal(rebuilt.command(a, 'status').contacts.length, 0);
  assert.throws(() => rebuilt.command(a, 'ring', { id: crypto.randomUUID(), userId: b.actor.userId, room: `ippo-${crypto.randomUUID()}` }), { status: 403 });
});
test('API enforces rollout flag, real signatures, pairing and rejects browser-supplied internal commands', async () => {
  const f = fixture(); let calls = 0;
  const env = { IDENTITY_CALLING_ENABLED: '1', CF_SIGNALING_URL: 'https://worker.example', SIGNALING_SERVICE_SECRET: 's'.repeat(32), APP_SESSION_SECRET: 'a'.repeat(32), IPPO_ACCESS_CODE: 'p'.repeat(32) };
  const injected = { directory: async (request, actor) => { const r = identityCommand(f.state(), { ...request, actor, nonce: request.envelope.data.nonce }); /* isolated status only */ return r.response; }, callApi: () => { calls++; } };
  const invoke = async (kind, body, customEnv = env) => {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await createIdentityHandler(kind, customEnv, injected)({ method: 'POST', headers: { host: 'test' }, body }, res); return res;
  };
  assert.equal((await invoke('contacts', { action: 'health' }, { ...env, IDENTITY_CALLING_ENABLED: '0' })).value.enabled, false);
  assert.equal((await invoke('contacts', { envelope: await envelope(a, 'status') })).code, 200);
  assert.equal((await invoke('contacts', { envelope: await envelope(a, 'ready') })).code, 400);
  assert.equal((await invoke('contacts', { envelope: await envelope(a, 'register', { accessCode: 'wrong' }) })).code, 401);
  const tampered = await envelope(a, 'status'); tampered.data.fields = { userId: b.actor.userId };
  assert.equal((await invoke('contacts', { envelope: tampered })).code, 401);
  assert.equal((await invoke('incoming', { envelope: await envelope(a, 'ring', { id: crypto.randomUUID(), userId: c.actor.userId }, 'incoming') })).code, 403);
  assert.equal(calls, 0);
});
test('Worker verifies device signatures and persists replay protection across instances', async () => {
  const saved = new Map(); let alarm = null;
  const ctx = { blockConcurrencyWhile: fn => fn(), storage: { get: async k => structuredClone(saved.get(k)), put: async (k, v) => saved.set(k, structuredClone(v)), getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } } };
  const request = body => new Request('https://worker.example/identity-directory', { method: 'POST', body: JSON.stringify(body) });
  const registerEnvelope = await envelope(a, 'register');
  assert.equal((await new IdentityDirectory(ctx).fetch(request({ action: 'register', internal: true, audience: 'ippo-contacts-v1', payload: { certificate: a.certificate, bootstrap: true }, envelope: registerEnvelope }))).status, 200);
  const e = await envelope(a, 'exchange-create', { id: crypto.randomUUID(), token: await digest('secret') });
  const command = { action: 'exchange-create', audience: 'ippo-contacts-v1', payload: e.data.fields, envelope: e };
  assert.equal((await new IdentityDirectory(ctx).fetch(request(command))).status, 200);
  assert.equal((await new IdentityDirectory(ctx).fetch(request(command))).status, 409);
  const altered = structuredClone(command); altered.envelope.data.action = 'status';
  assert.equal((await new IdentityDirectory(ctx).fetch(request(altered))).status, 401);
  assert.ok(alarm > now);
});
test('API simultaneously accepting two devices returns guest credentials only once and pushes only the recipient devices', async () => {
  const f = fixture(); f.pair(); f.add(b, b2);
  const sub = id => ({ endpoint: `https://fcm.googleapis.com/${id}`, keys: { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) } });
  f.command(b, 'subscribe', { subscription: sub('phone') }); f.command(b2, 'subscribe', { subscription: sub('pc') }); f.command(c, 'subscribe', { subscription: sub('unrelated') });
  let state = f.state(), joins = 0; const pushed = [];
  const env = { IDENTITY_CALLING_ENABLED: '1', CF_SIGNALING_URL: 'https://worker.example', SIGNALING_SERVICE_SECRET: 's'.repeat(32), APP_SESSION_SECRET: 'a'.repeat(32), IPPO_ACCESS_CODE: 'p'.repeat(32), WEB_PUSH_PUBLIC_KEY: 'test', WEB_PUSH_PRIVATE_KEY: 'test', WEB_PUSH_SUBJECT: 'https://test.example' };
  const injected = {
    directory: async (request, actor) => { const r = identityCommand(state, { ...request, actor, nonce: request.envelope.data.nonce }); state = r.state; return r.response; },
    sendPush: async (subscription, body) => { pushed.push(subscription.endpoint); assert.ok(!body.includes('invite') && !body.includes('auth')); },
    callApi: async action => { if (action === 'create') return { invite: 'host-invite', auth: 'host-only' }; joins++; await new Promise(resolve => setTimeout(resolve, 10)); return { auth: 'guest-only' }; }
  };
  const invoke = async (me, action, fields) => {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await createIdentityHandler('incoming', env, injected)({ method: 'POST', headers: { host: 'test' }, body: { envelope: await envelope(me, action, fields, 'incoming', Date.now()) } }, res); return res;
  };
  const id = crypto.randomUUID();
  assert.equal((await invoke(a, 'ring', { id, userId: b.actor.userId })).value.credentials.auth, 'host-only');
  assert.deepEqual(pushed.sort(), ['https://fcm.googleapis.com/pc', 'https://fcm.googleapis.com/phone']);
  const responses = await Promise.all([invoke(b, 'accept', { id }), invoke(b2, 'accept', { id })]);
  assert.deepEqual(responses.map(r => r.code).sort(), [200, 409]); assert.equal(joins, 1);
  const loser = responses[0].code === 200 ? b2 : b;
  assert.equal((await invoke(loser, 'finish', { id })).code, 403);
  const winner = responses[0].code === 200 ? b : b2;
  assert.equal((await invoke(winner, 'accept', { id })).value.credentials.auth, 'guest-only'); assert.equal(joins, 1);
});
