import test from 'node:test';
import assert from 'node:assert/strict';
import { turnCredentials, cloudflareSessions } from '../server/cloudflare.mjs';
import worker, { CallRoom, ContactDirectory } from '../cloudflare/signaling/index.mjs';
import { qualityWindow } from '../src/core/quality.mjs';
test('TURN uses official API with bounded TTL and returns short-lived ICE credentials only', async () => {
  const env = { CLOUDFLARE_TURN_KEY_ID: 'key-id', CLOUDFLARE_TURN_API_TOKEN: 'private' };
  const ice = await turnCredentials(env, async (url, options) => {
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
    assert.equal(JSON.parse(options.body).ttl, 10800); assert.equal(options.headers.Authorization, 'Bearer private');
    return Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'short', credential: 'temporary', extra: 'hidden' }] });
  });
  assert.equal(ice[0].urls.length, 2); assert.equal(ice[0].extra, undefined);
  await assert.rejects(turnCredentials(env, async () => Response.json({ iceServers: [{ urls: 'stun:test' }] })), { status: 502 });
  await assert.rejects(turnCredentials(env, async () => new Response('', { status: 401 })), { status: 502 });
});
test('signaling worker refuses unauthenticated requests before looking up a room', async () => {
  const env = { SIGNALING_SERVICE_SECRET: 's'.repeat(32), ROOMS: { idFromName() { throw new Error('must not run'); } } };
  assert.equal((await worker.fetch(new Request('https://example/rooms/ippo-x', { method: 'POST' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://example/', { method: 'POST', headers: { Authorization: `Bearer ${env.SIGNALING_SERVICE_SECRET}` } }), env)).status, 404);
  await assert.rejects(cloudflareSessions({ CF_SIGNALING_URL: 'http://insecure', SIGNALING_SERVICE_SECRET: 'x' })('ippo-x', 'status', {}), { status: 503 });
});
test('Durable Object stores state across instances, schedules expiry, and deletes it at alarm', async () => {
  const saved = new Map(); let alarm, alarmWrites = 0;
  const ctx = { blockConcurrencyWhile: fn => fn(), storage: { get: async k => saved.get(k), put: async (k, v) => saved.set(k, v), setAlarm: async at => { alarm = at; alarmWrites++; }, deleteAll: async () => saved.clear() } };
  const actor = { role: 'host', participantId: '12345678-1234-1234-1234-123456789abc' };
  const req = action => new Request('https://example/', { method: 'POST', body: JSON.stringify({ action, actor, payload: { name: 'test' } }) });
  assert.equal((await new CallRoom(ctx).fetch(req('create'))).status, 200);
  assert.ok(alarm > Date.now()); assert.equal((await new CallRoom(ctx).fetch(req('status'))).status, 200);
  assert.equal(alarmWrites, 1);
  await new CallRoom(ctx).alarm(); assert.equal(saved.size, 0);
  assert.equal((await new CallRoom(ctx).fetch(req('status'))).status, 410);
});
test('quality policy ignores isolated bursts and counter resets, triggers only sustained loss or delay', () => {
  let previous;
  const sample = (i, lost = 0, rtt = 0.1) => { previous = qualityWindow(previous, { at: i * 2000, received: i * 100, lost, rtt }); return previous; };
  sample(0); assert.equal(sample(1, 20).bad, 1); assert.equal(sample(2, 20).bad, 0);
  for (let i = 3; i <= 6; i++) sample(i, 20, 0.7);
  assert.equal(previous.bad, 4);
  assert.equal(qualityWindow(previous, { at: 14000, received: 1, lost: 0, rtt: 0.7 }).bad, 0);
});

test('contact directory persists device ownership and avoids writes for unchanged status polling', async () => {
  const saved = new Map(); let writes = 0, alarm = null;
  const ctx = { blockConcurrencyWhile: fn => fn(), storage: {
    get: async k => structuredClone(saved.get(k)), put: async (k,v) => { writes++; saved.set(k, structuredClone(v)); },
    getAlarm: async () => alarm, setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = null; }
  } };
  const actor = { id: '12345678-1234-1234-1234-123456789abc', proof: 'a'.repeat(64) };
  const request = (action, payload) => new Request('https://worker.example/directory', { method: 'POST', body: JSON.stringify({ action, actor, payload }) });
  assert.equal((await new ContactDirectory(ctx).fetch(request('register', { ...actor, memberId: 'member1' }))).status, 200);
  const before = writes;
  assert.equal((await new ContactDirectory(ctx).fetch(request('status'))).status, 200);
  assert.equal(writes, before); assert.equal(alarm, null);
  const response = await new ContactDirectory(ctx).fetch(request('invite', { id: '23456789-1234-1234-1234-123456789abc', token: 'b'.repeat(64), memberId: 'member2' }));
  assert.equal(response.status, 200); assert.ok(alarm > Date.now());
  const state = saved.get('state'); state.invites[Object.keys(state.invites)[0]].expiresAt = Date.now() - 1;
  await new ContactDirectory(ctx).alarm();
  assert.equal(Object.keys(saved.get('state').invites).length, 0); assert.equal(Object.keys(saved.get('state').devices).length, 1);
});
