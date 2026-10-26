import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../server/handler.mjs';
import { issue, verify } from '../server/security.mjs';
import { command } from '../shared/session.mjs';
const env = { CF_SIGNALING_URL: 'https://signaling.example', SIGNALING_SERVICE_SECRET: 's'.repeat(32), CLOUDFLARE_TURN_KEY_ID: 'testkey', CLOUDFLARE_TURN_API_TOKEN: 'private-turn-token', APP_SESSION_SECRET: 'a'.repeat(32), IPPO_ACCESS_CODE: 'p'.repeat(32) };
function fixture() {
  const states = new Map();
  const handler = createHandler(env, {
    turn: async () => [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'short', credential: 'short-secret' }],
    sessions: async (room, action, actor, payload) => { const result = command(states.get(room), { action, actor, payload }); states.set(room, result.state); return result.response; }
  });
  const call = async (action, fields = {}, auth, headers = {}) => {
    const req = { method: 'POST', headers: { host: 'localhost', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }, body: { action, ...fields } };
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res); return res;
  };
  return { call };
}
async function pair() {
  const { call } = fixture();
  const host = (await call('create', { name: 'host', accessCode: env.IPPO_ACCESS_CODE })).body;
  const guest = (await call('join', { name: 'guest', invite: host.invite })).body;
  return { call, host, guest };
}
test('API authorizes two-party recording, fails on disconnection and preserves revoked consent', async () => {
  const { call, host, guest } = await pair();
  assert.equal((await call('start', {}, host.auth)).code, 409);
  for (const c of [host, guest]) { await call('heartbeat', { connected: true }, c.auth); await call('consent', { allowed: true }, c.auth); }
  assert.equal((await call('start', {}, guest.auth)).code, 403);
  assert.equal((await call('start', {}, host.auth)).body.recording, true);
  await call('consent', { allowed: false }, guest.auth);
  assert.equal((await call('heartbeat', { connected: true, allowed: true }, guest.auth)).body.allowed, false);
  assert.equal((await call('start', {}, host.auth)).code, 409);
  await call('consent', { allowed: true }, guest.auth);
  await call('start', {}, host.auth);
  assert.equal((await call('heartbeat', { connected: false }, guest.auth)).body.recording, false);
});
test('API rejects origins, invite/archive scope misuse, forged participant identity and ended rooms', async () => {
  const { call, host } = await pair();
  assert.equal((await call('status', {}, host.auth, { origin: 'https://untrusted.example' })).code, 403);
  assert.equal((await call('not-real', {}, host.auth)).code, 400);
  for (const token of [host.invite, host.archiveAuth]) assert.equal((await call('consent', { allowed: true }, token)).code, 403);
  const forged = issue(env.APP_SESSION_SECRET, { room: host.room, role: 'host', participantId: '12345678-1234-1234-1234-123456789abc' });
  assert.equal((await call('status', {}, forged)).code, 403);
  await call('end', {}, host.auth);
  assert.equal((await call('join', { name: 'visitor', invite: host.invite })).code, 410);
});
test('room creation protects keys and gives only host a room-scoped archive capability', async () => {
  const { call } = fixture();
  assert.equal((await call('create', { name: 'collector', accessCode: 'wrong' })).code, 401);
  const result = await call('create', { name: 'collector', accessCode: env.IPPO_ACCESS_CODE });
  assert.equal(result.code, 201); assert.ok(result.body.iceServers[0].credential);
  const archive = verify(env.APP_SESSION_SECRET, result.body.archiveAuth);
  assert.equal(archive.scope, 'archive'); assert.equal(archive.room, result.body.room);
  assert.ok(!JSON.stringify(result.body).includes(env.CLOUDFLARE_TURN_API_TOKEN));
  const guest = await call('join', { name: 'guest', invite: result.body.invite });
  assert.equal(guest.body.archiveAuth, undefined);
  assert.equal((await call('join', { name: 'third', invite: result.body.invite })).code, 409);
  assert.equal((await call('health')).body.provider, 'cloudflare-turn');
});
