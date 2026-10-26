import { startRecorder, recordingMime } from '../src/adapters/recorder';
import { store } from '../src/adapters/storage';
import type { Recording } from '../src/core/types';
const button = document.querySelector<HTMLButtonElement>('#run')!, result = document.querySelector('#result')!;
button.onclick = async () => {
  button.disabled = true; result.textContent = '検証中…';
  const context = new AudioContext(), id = crypto.randomUUID();
  const log = (message: string) => { result.textContent += `\n${message}`; };
  try {
    await context.resume();
    const tracks = ['host', 'guest'].map((speakerId, i) => {
      const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination(); oscillator.frequency.value = i ? 880 : 440; oscillator.connect(destination); oscillator.start();
      return { stream: destination.stream, speakerId, speakerName: `合成音声${i + 1}` };
    });
    const recording: Recording = { id, consultationId: `ippo-${crypto.randomUUID()}`, title: 'QA合成音声（自動削除）', createdAt: new Date().toISOString(), state: 'recording', mimeType: recordingMime(), tracks: [], consent: [], events: [], driveFiles: {} };
    const recorder = await startRecorder(recording, tracks, message => { throw new Error(message); });
    await new Promise(resolve => setTimeout(resolve, 4500)); await recorder.stop('user');
    if (recording.state !== 'local' || recording.tracks.length !== 2) throw new Error('録音状態が不正');
    log('PASS: 話者別2トラックを録音し、停止を確定');
    for (const track of recording.tracks) {
      const blob = await store.audio(recording, track.id);
      if (blob.size < 100 || track.chunkCount < 2) throw new Error('音声チャンクが不足');
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      if (audio.duration < 4) throw new Error('音声長が不足');
      log(`PASS: ${track.speakerId} / ${track.chunkCount}チャンク / ${blob.size}bytes / ${audio.duration.toFixed(2)}秒 をIndexedDBから復元・デコード`);
    }
    const restored = (await store.list()).find(r => r.id === id); if (restored?.state !== 'local') throw new Error('メタデータ復元に失敗');
    log('PASS: 保存した録音メタデータを復元');
    await store.remove(id); if ((await store.list()).some(r => r.id === id)) throw new Error('削除に失敗');
    log('PASS: 検証データを削除'); log('全ブラウザー検証に合格（実マイク・実通話・実Driveは別途検証）');
  } catch (error) { log(`FAIL: ${(error as Error).message}`); }
  finally { await context.close(); await store.remove(id); button.disabled = false; }
};
