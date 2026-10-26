import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createContactsHandler, deviceActor, validateSubscription } from '../server/contacts.mjs';
import { directoryCommand } from '../shared/directory.mjs';
import { createHandler } from '../server/handler.mjs';
import { command } from '../shared/session.mjs';
const env = { CALLING_ENABLED: '1', APP_SESSION_SECRET: 's'.repeat(32), IPPO_ACCESS_CODE: 'a'.repeat(32), SIGNALING_SERVICE_SECRET: 'b'.repeat(32), CF_SIGNALING_URL: 'https://worker.example', CLOUDFLARE_TURN_KEY_ID: 'key', CLOUDFLARE_TURN_API_TOKEN: 'test', WEB_PUSH_PUBLIC_KEY: 'public', WEB_PUSH_PRIVATE_KEY: 'private', WEB_PUSH_SUBJECT: 'https://app.example' };
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } };
function fixture(overrides = {}, sendPush = async () => {}) {
  let state; const rooms = new Map();
  const directory = async (action, actor, payload) => { const result = directoryCommand(state, { action, actor, payload }); state = result.state; return result.response; };
  const callApi = async (action, fields, room, participantId, auth) => {
    const handler = createHandler(env, { room, participantId, turn: async () => [{ urls: ['turn:example.org'], username: 'short', credential: 'short' }], sessions: async (id, a, actor, payload) => { const r = command(rooms.get(id), { action: a, actor, payload }); rooms.set(id, r.state); return r.response; } });
    const res = response(); await handler({ method: 'POST', headers: { host: 'app.example', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: { action, ...fields } }, res);
    if (res.code >= 400) throw Object.assign(new Error(res.value.error), { status: res.code }); return res.value;
  };
  const handlers = Object.fromEntries(['contacts','incoming'].map(kind => [kind, createContactsHandler(kind, { ...env, ...overrides }, { directory, callApi, sendPush })]));
  const call = async (kind, action, fields = {}, credential, headers = {}) => { const res = response(); await handlers[kind]({ method: 'POST', headers: { host: 'app.example', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...headers }, body: { action, ...fields } }, res); return res; };
  return { call, rooms };
}
function response() { return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; }, end() {} }; }
async function pair(f) {
  const a = (await f.call('contacts', 'register', { memberId: 'member1', accessCode: env.IPPO_ACCESS_CODE })).value.credential;
  const link = (await f.call('contacts', 'invite', { memberId: 'member2' }, a)).value;
  const b = (await f.call('contacts', 'redeem', { memberId: 'member2', inviteId: link.id, token: link.token })).value.credential;
  await f.call('contacts', 'approve', { id: link.id }, a); return { a, b };
}
test('feature flag and device credentials isolate public setup and private state', async () => {
  const f = fixture({ CALLING_ENABLED: '0' }); assert.equal((await f.call('contacts', 'health')).value.enabled, false);
  assert.equal((await f.call('contacts', 'register', { memberId: 'member1', accessCode: env.IPPO_ACCESS_CODE })).code, 503);
  const g = fixture(); assert.equal((await g.call('contacts', 'register', { memberId: 'member1', accessCode: 'bad' })).code, 401);
  assert.equal((await g.call('contacts', 'status')).code, 401);
  assert.equal((await g.call('contacts', 'health', {}, null, { origin: 'https://evil.example' })).code, 403);
  assert.throws(() => deviceActor('arbitrary-id')); assert.throws(() => deviceActor('private-host'));
});
test('subscription URLs cannot turn push delivery into arbitrary outgoing requests', () => {
  assert.equal(validateSubscription(subscription).endpoint, subscription.endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/test','https://127.0.0.1/test','https://fcm.googleapis.com.evil.test/a','https://fcm.googleapis.com:8443/a','https://user@fcm.googleapis.com/a','https://evil.test/a']) assert.throws(() => validateSubscription({ ...subscription, endpoint }));
  assert.throws(() => validateSubscription({ ...subscription, keys: {} }));
});
test('paired users ring without shared code; responses never disclose peer push endpoint or host archive token', async () => {
  let push;
  const f = fixture({}, async (sub, payload, options) => { push = { sub, data: JSON.parse(payload), options }; }); const { a, b } = await pair(f);
  await f.call('contacts', 'subscribe', { subscription }, b);
  const id = randomUUID(), first = await f.call('incoming', 'ring', { id, memberId: 'member2' }, a);
  assert.equal(first.code, 200); assert.equal(first.value.call.state, 'ringing');
  assert.equal(push.data.callId, id); assert.equal(push.data.invite, undefined); assert.ok(push.options.TTL <= 60);
  assert.equal(first.value.credentials.role, 'host');
  const repeated = await f.call('incoming', 'ring', { id, memberId: 'member2' }, a);
  assert.ok(!JSON.stringify(repeated.value).includes(subscription.endpoint));
  const status = await f.call('incoming', 'status', {}, b);
  assert.ok(!JSON.stringify(status.value).includes(first.value.credentials.archiveAuth));
  const replies = await Promise.all([f.call('incoming', 'accept', { id }, b), f.call('incoming', 'accept', { id }, b)]);
  assert.ok(replies.every(r => r.code === 200)); assert.equal(replies[0].value.credentials.participantId, replies[1].value.credentials.participantId);
  assert.equal(replies[0].value.credentials.role, 'guest'); assert.equal(replies[0].value.credentials.archiveAuth, undefined);
  assert.equal((await f.call('incoming', 'cancel', { id }, a)).code, 409);
});
test('expired subscriptions and push failure retain foreground calling with explicit status', async () => {
  const f = fixture({}, async () => { throw { statusCode: 410 }; }); const { a, b } = await pair(f);
  await f.call('contacts', 'subscribe', { subscription }, b);
  const result = await f.call('incoming', 'ring', { id: randomUUID(), memberId: 'member2' }, a);
  assert.equal(result.code, 200); assert.equal(result.value.call.push, 'expired-subscription');
  assert.equal((await f.call('contacts', 'status', {}, b)).value.notifications, false);
});
