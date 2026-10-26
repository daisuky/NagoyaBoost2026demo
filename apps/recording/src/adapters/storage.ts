import type { Recording, RecordingStore } from '../core/types';
const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('ippo-recordings', 1);
  request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('recordings', { keyPath: 'id' }); db.createObjectStore('chunks', { keyPath: ['recordingId', 'trackId', 'index'] }); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function transaction<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode), request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('端末保存が中断されました'));
  });
}
export const store: RecordingStore = {
  list: async () => (await transaction<Recording[]>('recordings', 'readonly', s => s.getAll())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  put: async recording => { await transaction('recordings', 'readwrite', s => s.put(recording)); },
  append: async (recordingId, trackId, index, data) => { await transaction('chunks', 'readwrite', s => s.put({ recordingId, trackId, index, data })); },
  audio: async (recording, trackId) => {
    const rows = await transaction<{ data: Blob }[]>('chunks', 'readonly', s => s.getAll(IDBKeyRange.bound([recording.id, trackId, 0], [recording.id, trackId, Number.MAX_SAFE_INTEGER])));
    if (!rows.length) throw new Error('この音声はまだ端末にありません');
    return new Blob(rows.map(r => r.data), { type: recording.mimeType });
  },
  remove: async id => {
    await transaction('chunks', 'readwrite', s => s.delete(IDBKeyRange.bound([id, '', 0], [id, '\uffff', Number.MAX_SAFE_INTEGER])));
    await transaction('recordings', 'readwrite', s => s.delete(id));
  }
};
