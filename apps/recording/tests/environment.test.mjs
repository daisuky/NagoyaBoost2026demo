import test from 'node:test';
import assert from 'node:assert/strict';
import { launchContext, storageFailure } from '../src/core/environment.mjs';

test('launch context prioritizes standalone and treats embedded-browser names as hints', () => {
  assert.equal(launchContext('FBAN Messenger', true).label, 'ホーム画面アプリ');
  assert.match(launchContext('Mozilla Version/18 Safari/605').label, /Safari系.*区別はできません/);
  assert.equal(launchContext('Mozilla FBAN/Messenger').embedded, true);
  assert.match(launchContext('Mozilla FBAN/Messenger').label, /可能性/);
  assert.equal(launchContext('unrecognized').embedded, false);
});
test('storage failures distinguish access denial, quota, and an unknown cause', () => {
  assert.match(storageFailure({ name: 'SecurityError' }), /アクセスが拒否/);
  assert.match(storageFailure({ name: 'QuotaExceededError' }), /容量/);
  assert.doesNotMatch(storageFailure(new Error('network')), /アクセスが拒否/);
  assert.match(storageFailure(new Error('network')), /確認できません/);
});
