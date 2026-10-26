import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoArchive } from '../src/core/auto-archive.mjs';
function fixture(records, upload) {
  const data = new Map(records.map(r => [r.id, structuredClone(r)])), errors = [], busy = [];
  let clock = 1000;
  const store = { list: async () => structuredClone([...data.values()]), put: async r => data.set(r.id, structuredClone(r)) };
  const options = { store, upload, onError: text => errors.push(text), onBusy: b => busy.push(b), now: () => clock };
  return { queue: createAutoArchive(options), options, data, errors, busy, advance: ms => { clock += ms; } };
}
const recording = (id, state = 'local') => ({ id, state, archiveAuth: 'test-archive-capability', tracks: [], driveFiles: {} });
test('ending two recordings queues both serially, without dropping or duplicating an upload', async () => {
  const started = [], gate = Promise.withResolvers();
  const f = fixture([recording('one'), recording('two')], async r => { started.push(r.id); if (r.id === 'one') await gate.promise; });
  const first = f.queue.enqueue(recording('one')), duplicate = f.queue.enqueue(recording('one'));
  const second = f.queue.enqueue(recording('two'));
  assert.equal(first, duplicate); assert.equal(f.queue.busy(), true);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, ['one']);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(started, ['one', 'two']); assert.equal(f.data.get('two').state, 'saved'); assert.equal(f.busy.at(-1), false);
});
test('failed uploads retain recording data and are automatically retried after restart', async () => {
  let offline = true;
  const f = fixture([recording('one')], async r => { if (offline) throw new Error('offline'); r.driveFiles.host = 'google-file'; });
  await f.queue.enqueue(recording('one'));
  assert.equal(f.data.get('one').state, 'local'); assert.equal(f.data.get('one').upload.state, 'failed');
  assert.match(f.errors[0], /端末の音声は削除していません/);
  offline = false;
  const restarted = createAutoArchive(f.options); await restarted.retryPending(true);
  assert.equal(f.data.get('one').state, 'saved'); assert.equal(f.data.get('one').upload, undefined);
  assert.equal(f.data.get('one').driveFiles.host, 'google-file');
});
test('retry waits for backoff, resumes a persisted uploading marker and never auto-sends interrupted audio', async () => {
  const called = [];
  const f = fixture([{ ...recording('retry'), upload: { state: 'failed', attempts: 1, nextRetryAt: 5000 } }, { ...recording('crashed'), upload: { state: 'uploading', attempts: 1 } }, recording('review', 'interrupted'), recording('active', 'recording'), recording('done', 'saved')], async r => called.push(r.id));
  await f.queue.retryPending(); assert.deepEqual(called, ['crashed']);
  f.advance(5000); await f.queue.retryPending(); assert.deepEqual(called, ['crashed', 'retry']);
  await f.queue.enqueue(recording('review', 'interrupted'), true); assert.equal(called.at(-1), 'review');
  assert.equal(f.data.get('active').state, 'recording');
});
test('expired archive authorization requires manual action instead of looping automatic retries', async () => {
  let count = 0;
  const f = fixture([recording('one')], async () => { count++; throw Object.assign(new Error('expired'), { status: 401 }); });
  await f.queue.retryPending(true); await f.queue.retryPending(true);
  assert.equal(count, 1); assert.equal(f.data.get('one').upload.state, 'blocked');
  assert.equal(f.data.get('one').state, 'local');
});
test('a saved record is re-read under the cross-tab lock and not uploaded again', async () => {
  let sent = 0, locks = 0;
  const f = fixture([recording('one')], async () => { sent++; });
  const queue = createAutoArchive({ ...f.options, withLock: async (id, work) => { locks++; f.data.set(id, recording(id, 'saved')); return work(); } });
  await queue.enqueue(recording('one')); assert.equal(locks, 1); assert.equal(sent, 0);
});
