// Serial, idempotent upload scheduling. Recording/audio data stays in IndexedDB.
export function createAutoArchive({ store, upload, onBusy = busy => {}, onProgress = (id, text) => {}, onSaved = recording => {}, onError = message => {}, onChange = () => {}, now = Date.now, withLock = (id, work) => globalThis.navigator?.locks ? navigator.locks.request(`ippo-archive-${id}`, work) : work() }) {
  const pending = new Map();
  let tail = Promise.resolve();
  const eligible = r => r.state === 'local' && r.archiveAuth && r.upload?.state !== 'blocked';
  function enqueue(recording, manual = false) {
    if (pending.has(recording.id)) return pending.get(recording.id);
    // Set this synchronously so beforeunload sees pending work immediately.
    onBusy(true);
    const job = tail.then(() => withLock(recording.id, async () => {
      let current = recording;
      try {
        current = (await store.list()).find(r => r.id === recording.id);
        if (!current || current.state === 'saved' || current.state === 'recording' || (!manual && !eligible(current))) return false;
        current.upload = { state: 'uploading', attempts: (current.upload?.attempts || 0) + 1 };
        await store.put(current); onProgress(current.id, 'Driveへの自動保存を準備しています…'); onChange();
        await upload(current, text => onProgress(current.id, text));
        current.state = 'saved'; delete current.upload;
        await store.put(current); onSaved(current); return true;
      } catch (error) {
        if (current) {
          const blocked = [401, 403].includes(error.status);
          const attempts = current.upload?.attempts || 1;
          current.upload = { state: blocked ? 'blocked' : 'failed', attempts, error: error.message || '送信に失敗しました', nextRetryAt: now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)) };
          await store.put(current).catch(() => {});
          onError(`Drive未送信：${current.upload.error}。端末の音声は削除していません。${blocked ? '音声のダウンロード、または保存権限の確認が必要です。' : '通信復帰時・次回起動時に再送します。'}`);
        } else onError(error.message || '端末の録音を確認できません');
        return false;
      } finally { onProgress('', ''); onChange(); }
    }));
    pending.set(recording.id, job);
    tail = job.catch(() => {});
    void job.finally(() => { pending.delete(recording.id); onBusy(pending.size > 0); }).catch(() => {});
    return job;
  }
  async function retryPending(force = false) {
    const list = await store.list();
    const jobs = list.filter(r => eligible(r) && (force || !r.upload?.nextRetryAt || r.upload.nextRetryAt <= now())).map(r => enqueue(r));
    await Promise.all(jobs);
  }
  return { enqueue, retryPending, busy: () => pending.size > 0 };
}
