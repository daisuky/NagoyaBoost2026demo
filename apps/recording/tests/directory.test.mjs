import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { directoryCommand, DEFAULT_MEMBERS, teamMembers } from '../shared/directory.mjs';
const proof = letter => letter.repeat(64);
function fixture() {
  let state, now = Date.now();
  const call = (action, actor, payload = {}) => { const result = directoryCommand(state, { action, actor, payload }, now); state = result.state; return result.response; };
  const register = (memberId, letter) => { const actor = { id: randomUUID(), proof: proof(letter) }; call('register', null, { ...actor, memberId }); return actor; };
  const pair = (a, memberId, letter) => {
    const id = randomUUID(), token = proof('f'); call('invite', a, { id, token, memberId });
    const b = { id: randomUUID(), proof: proof(letter) };
    call('redeem', b, { ...b, memberId, inviteId: id, token }); return { b, id, token };
  };
  return { call, register, pair, advance: ms => { now += ms; }, state: () => state };
}
test('eight fixed member slots use generic display names and are configurable', () => {
  assert.equal(DEFAULT_MEMBERS.length, 8); assert.deepEqual(DEFAULT_MEMBERS.filter(m => m.priority).map(m => m.name), ['メンバー1', 'メンバー2']);
  assert.equal(teamMembers(JSON.stringify(['A','B','C','D','E','F','G','H']))[2].id, 'member3');
  assert.throws(() => teamMembers('["only one"]'));
});
test('pair links are single use, require owner approval and authenticate both devices', () => {
  const f = fixture(), a = f.register('member1', 'a'), { b, id, token } = f.pair(a, 'member2', 'b');
  assert.equal(f.call('status', b).contacts.length, 0);
  assert.throws(() => f.call('ring', b, { id: randomUUID(), memberId: 'member1', room: `ippo-${randomUUID()}` }), /登録/);
  assert.throws(() => f.call('approve', b, { id }), /確認/);
  assert.throws(() => f.call('status', { ...a, proof: proof('c') }), /登録/);
  assert.equal(f.call('approve', a, { id }).contacts[0].memberId, 'member2');
  assert.equal(f.call('status', b).contacts[0].memberId, 'member1');
  // Lost redeem responses can be retried only by the already bound device.
  assert.equal(f.call('redeem', b, { ...b, memberId: 'member2', inviteId: id, token }).self, 'member2');
  assert.throws(() => f.call('redeem', null, { id: randomUUID(), proof: proof('c'), memberId: 'member2', inviteId: id, token }), /期限/);
  f.call('remove', b, { memberId: 'member1' }); assert.equal(f.call('status', a).contacts.length, 0);
});
test('expired links and occupied member slots cannot replace another device', () => {
  const f = fixture(), a = f.register('member1', 'a'), id = randomUUID(), token = proof('f');
  f.call('invite', a, { id, memberId: 'member2', token }); f.advance(600001);
  assert.throws(() => f.call('redeem', null, { id: randomUUID(), proof: proof('b'), memberId: 'member2', inviteId: id, token }), /期限/);
  assert.throws(() => f.register('member1', 'c'), /登録済み/);
});
function readyPair() {
  const f = fixture(), a = f.register('member1', 'a'), { b, id } = f.pair(a, 'member2', 'b'); f.call('approve', a, { id });
  const ring = () => { const callId = randomUUID(); f.call('ring', a, { id: callId, memberId: 'member2', room: `ippo-${randomUUID()}` }); f.call('ready', a, { id: callId, host: { auth: 'private-host' }, invite: 'private-invite', push: 'submitted' }); return callId; };
  return { ...f, a, b, ring };
}
test('ring ownership, busy state, cancellation and acceptance races are serialized', () => {
  const f = readyPair(), id = f.ring();
  assert.throws(() => f.call('ring', f.b, { id: randomUUID(), memberId: 'member1', room: `ippo-${randomUUID()}` }), /通話中/);
  assert.throws(() => f.call('accept', f.a, { id }), /終了/);
  const accepted = f.call('accept', f.b, { id }); assert.equal(accepted.invite, 'private-invite');
  assert.throws(() => f.call('cancel', f.a, { id }), /終了/);
  assert.equal(f.call('accept', f.b, { id }).invite, accepted.invite);
  assert.throws(() => f.call('credentials', f.b, { id }), /終了/);
  assert.ok(!JSON.stringify(f.call('status', f.b)).includes('private-'));
  f.call('finish', f.b, { id }); const next = f.ring(); f.call('cancel', f.a, { id: next });
  assert.throws(() => f.call('accept', f.b, { id: next }), /終了/);
});
test('call expiry, duplicate IDs, rate limits and unregister do not leave callable relationships', () => {
  const f = readyPair(), id = f.ring();
  assert.equal(f.call('ring', f.a, { id, memberId: 'member2', room: `ippo-${randomUUID()}` }).id, id);
  f.advance(60001); assert.equal(f.call('status', f.b).calls[0].state, 'expired');
  assert.throws(() => f.call('accept', f.b, { id }), /終了/);
  for (let i = 0; i < 5; i++) { const next = f.ring(); f.call('cancel', f.a, { id: next }); }
  assert.throws(() => f.ring(), /発信/);
  f.call('unregister', f.b); assert.equal(f.call('status', f.a).contacts.length, 0);
  assert.throws(() => f.call('status', f.b), /登録/);
});
test('trusted operator replacement revokes old device and all its relationships', () => {
  const f = readyPair(); f.ring();
  const replacement = { id: randomUUID(), proof: proof('c') };
  f.call('register', null, { ...replacement, memberId: 'member1', replace: true });
  assert.throws(() => f.call('status', f.a), /登録/);
  assert.equal(f.call('status', replacement).contacts.length, 0);
  assert.equal(f.call('status', f.b).contacts.length, 0);
});

test('idempotency IDs stay bound to the same recipient and busy replies cannot be accepted', () => {
  const f = readyPair(); const { b: c, id: pairId } = f.pair(f.a, 'member3', 'c');
  f.call('approve', f.a, { id: pairId });
  const id = f.ring();
  assert.throws(() => f.call('ring', f.a, { id, memberId: 'member3', room: `ippo-${randomUUID()}` }), /確認/);
  assert.throws(() => f.call('busy', c, { id }), /見つかりません/);
  assert.equal(f.call('busy', f.b, { id }).state, 'busy');
  assert.throws(() => f.call('accept', f.b, { id }), /終了/);
  assert.ok(!f.state().calls[id].host);
});
