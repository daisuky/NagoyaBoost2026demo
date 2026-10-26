import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, LEASE_MS, SESSION_MS } from '../shared/session.mjs';
function fixture() {
  let state, now = 100000;
  const actors = { host: { role: 'host', participantId: randomUUID() }, guest: { role: 'guest', participantId: randomUUID() } };
  const run = (action, role = 'host', payload = {}) => { const result = command(state, { action, actor: actors[role], payload }, now); state = result.state; return result.response; };
  run('create', 'host', { name: 'host' }); run('join', 'guest', { name: 'guest' });
  return { run, advance: ms => { now += ms; }, actors, state: () => state };
}
test('consent requires current connected leases, expires without resuming recording, and ends irreversibly', () => {
  const f = fixture();
  for (const role of ['host', 'guest']) { f.run('heartbeat', role, { connected: true }); f.run('consent', role, { allowed: true }); }
  assert.equal(f.run('start').recording, true);
  f.advance(LEASE_MS); assert.equal(f.run('status').recording, false);
  for (const role of ['host', 'guest']) f.run('heartbeat', role, { connected: true });
  assert.equal(f.run('status').allowed, true); assert.equal(f.run('status').recording, false);
  f.run('leave', 'guest'); assert.throws(() => f.run('start'), { status: 410 });
});
test('heartbeat never changes consent and session cannot outlive its two-hour limit', () => {
  const f = fixture(); f.run('consent', 'guest', { allowed: true }); f.run('consent', 'guest', { allowed: false });
  assert.equal(f.run('heartbeat', 'guest', { connected: true, allowed: true }).participants[1].consent.record, false);
  f.advance(SESSION_MS); assert.throws(() => f.run('status'), { status: 410 });
});
test('signals are role bound, generation ordered, deduplicated and acknowledged only by recipient', () => {
  const f = fixture(); const id = randomUUID();
  const offer = { id, type: 'offer', generation: 1, data: { description: { type: 'offer', sdp: 'test' } } };
  assert.throws(() => f.run('signal', 'guest', offer), { status: 403 });
  f.run('signal', 'host', offer); f.run('signal', 'host', offer);
  assert.equal(f.run('status').signals.length, 0);
  const guest = f.run('status', 'guest'); assert.equal(guest.signals.length, 1);
  const seq = guest.signals[0].seq;
  f.run('heartbeat', 'host', { cursor: seq }); assert.equal(f.run('status', 'guest').signals.length, 1);
  assert.equal(f.run('heartbeat', 'guest', { cursor: seq }).signals.length, 0);
  assert.throws(() => f.run('signal', 'guest', { id: randomUUID(), type: 'answer', generation: 0, data: {} }), { status: 409 });
  assert.throws(() => f.run('signal', 'host', { ...offer, id: randomUUID(), generation: 3 }), { status: 409 });
  f.run('signal', 'host', { ...offer, id: randomUUID(), generation: 2 });
  assert.ok(f.run('status').version > guest.version);
});
