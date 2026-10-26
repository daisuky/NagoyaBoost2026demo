import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = 'http://127.0.0.1:8790';
const room = `ippo-${randomUUID()}`;
const actors = { host: { role: 'host', participantId: randomUUID() }, guest: { role: 'guest', participantId: randomUUID() } };
async function call(action, role = 'host', payload = {}, authorized = true) {
  const response = await fetch(`${base}/rooms/${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer local-integration-test-secret-32-characters' } : {}) }, body: JSON.stringify({ action, actor: actors[role], payload }) });
  if (!response.ok) return { status: response.status };
  return { status: response.status, ...await response.json() };
}
assert.equal((await call('create', 'host', { name: 'test' }, false)).status, 401);
assert.equal((await call('create', 'host', { name: 'test' })).status, 200);
await call('join', 'guest', { name: 'test' });
for (const role of ['host', 'guest']) { await call('heartbeat', role, { connected: true }); await call('consent', role, { allowed: true }); }
assert.equal((await call('start')).recording, true);
assert.equal((await call('consent', 'guest', { allowed: false })).recording, false);
const signal = { id: randomUUID(), type: 'offer', generation: 1, data: { description: { type: 'offer', sdp: 'local-test' } } };
await call('signal', 'host', signal);
const received = await call('status', 'guest'); assert.equal(received.signals.length, 1);
assert.equal((await call('heartbeat', 'guest', { cursor: received.signals[0].seq })).signals.length, 0);
await call('end'); assert.equal((await call('status')).status, 410);
console.log('PASS: workerd + SQLite Durable Object: private authentication, persistent session, consent, recording, signaling, acknowledgement and end.');
