import test from 'node:test';
import assert from 'node:assert/strict';
import { issue, verify } from '../server/security.mjs';
import { recordAllowed, CONSENT_VERSION, LEASE_MS } from '../shared/session.mjs';
const secret = 'test-secret-that-is-at-least-32-characters';
const room = 'ippo-12345678-1234-1234-1234-123456789abc';
test('capabilities reject tampering, expiry and arbitrary rooms', () => {
  const token = issue(secret, { room, role: 'host' }, 1000);
  assert.equal(verify(secret, token, 1001).room, room);
  assert.throws(() => verify(secret, `${token}x`, 1001));
  assert.throws(() => verify(secret, token, 8000000));
  assert.throws(() => verify(secret, issue(secret, { room: '../other', role: 'host' }, 1000), 1001));
});
test('recording requires exactly two different roles, current leases, record and archive consent', () => {
  const now = 20000;
  const participant = role => ({ identity: role, connected: true, consent: { seenAt: now, record: true, drive: true, version: CONSENT_VERSION } });
  const pair = [participant('host'), participant('guest')];
  assert.equal(recordAllowed(pair, now), true);
  assert.equal(recordAllowed(pair.slice(0, 1), now), false);
  assert.equal(recordAllowed([pair[0], pair[0]], now), false);
  assert.equal(recordAllowed([...pair, participant('other')], now), false);
  assert.equal(recordAllowed(pair, now + LEASE_MS), false);
  assert.equal(recordAllowed(pair, now - 1), false);
  for (const override of [{ record: false }, { drive: false }, { version: 'old' }]) {
    const next = structuredClone(pair); next[1].consent = { ...next[1].consent, ...override };
    assert.equal(recordAllowed(next, now), false);
  }
  const absentLease = structuredClone(pair); delete absentLease[1].consent.seenAt; assert.equal(recordAllowed(absentLease, now), false);
});
