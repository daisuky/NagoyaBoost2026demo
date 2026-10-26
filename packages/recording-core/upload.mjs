// Resume from Google's acknowledged byte offset after a lost response.
/** @param {string} url @param {Blob} blob @param {typeof fetch} fetcher @param {(percent: number) => void} progress */
export async function sendResumable(url, blob, fetcher = fetch, progress = () => {}) {
  const size = blob.size; let offset = 0, failures = 0;
  const acknowledged = response => {
    const range = response.headers.get('Range'); return range ? Number(range.match(/(\d+)$/)?.[1]) + 1 : 0;
  };
  while (offset < size) {
    try {
      const end = Math.min(offset + 4 * 1024 * 1024, size);
      const response = await fetcher(url, { method: 'PUT', headers: { 'Content-Type': blob.type, 'Content-Range': `bytes ${offset}-${end - 1}/${size}` }, body: blob.slice(offset, end), signal: AbortSignal.timeout(60000) });
      if (response.ok) return await response.json();
      if (response.status === 308) { const next = acknowledged(response); if (next <= offset || next > size) throw new Error('送信位置を確認できません'); offset = next; progress(Math.round(offset / size * 100)); continue; }
      if (![429, 500, 502, 503, 504].includes(response.status)) throw Object.assign(new Error(`Drive保存が中断されました (${response.status})。端末の音声から再送できます。`), { terminal: true });
      throw new Error('Driveが応答しません');
    } catch (error) {
      if (error.terminal || ++failures > 3) throw error;
      await new Promise(resolve => setTimeout(resolve, failures * 600));
      const probe = await fetcher(url, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, signal: AbortSignal.timeout(15000) });
      if (probe.ok) return await probe.json();
      if (probe.status !== 308) throw new Error('Drive保存を再開できません。音声は端末に残っています。');
      offset = acknowledged(probe);
    }
  }
  throw new Error('Drive保存の完了を確認できません');
}
