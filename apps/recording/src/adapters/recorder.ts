import type { Recording, AudioRecorder } from '../core/types';
import { store } from './storage';
export function recordingMime() {
  if (typeof MediaRecorder === 'undefined') throw new Error('この端末では録音に対応していません。最新のSafariまたはChromeを利用してください。');
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('この端末の録音形式に対応していません'); return mime;
}
export async function startRecorder(recording: Recording, tracks: { stream: MediaStream; speakerId: string; speakerName: string }[], onFailure: (message: string) => void): Promise<AudioRecorder> {
  let queue = Promise.resolve(), failed = false;
  const recorders: MediaRecorder[] = [];
  const completions: Promise<void>[] = [];
  recording.tracks = tracks.map(track => ({ id: crypto.randomUUID(), speakerId: track.speakerId, speakerName: track.speakerName, startedAt: new Date().toISOString(), chunkCount: 0 }));
  await store.put(recording);
  const failure = () => { if (failed) return; failed = true; onFailure('端末への音声保存に失敗しました。空き容量を確認してください。'); };
  try {
    tracks.forEach((track, i) => {
      const recorder = new MediaRecorder(track.stream, { mimeType: recording.mimeType, audioBitsPerSecond: 64000 }); recorders.push(recorder);
      let count = 0;
      recorder.ondataavailable = event => {
        if (!event.data.size) return; const index = count++;
        queue = queue.then(async () => { await store.append(recording.id, recording.tracks[i].id, index, event.data); recording.tracks[i].chunkCount = index + 1; recording.tracks[i].bytes = (recording.tracks[i].bytes || 0) + event.data.size; await store.put(recording); }).catch(failure);
      };
      completions.push(new Promise(resolve => { recorder.onstop = () => resolve(); }));
      recorder.onerror = failure; recorder.start(2000);
    });
  } catch (error) { recorders.forEach(r => { if (r.state !== 'inactive') r.stop(); }); await Promise.all(completions); await queue; recording.state = 'interrupted'; await store.put(recording); throw error; }
  let stopping: Promise<void> | undefined;
  return { stop(reason) {
    return stopping ||= (async () => {
      recorders.forEach(recorder => { if (recorder.state !== 'inactive') recorder.stop(); });
      await Promise.all(completions); await queue;
      // Read back committed chunks before declaring the recording complete.
      for (const track of recording.tracks) {
        try { track.bytes = (await store.audio(recording, track.id)).size; if (!track.bytes) failure(); }
        catch { failure(); }
      }
      recording.audioBytes = recording.tracks.reduce((sum, track) => sum + (track.bytes || 0), 0);
      recording.endedAt = new Date().toISOString(); recording.state = failed || !['user', 'call-ended', 'page-hidden'].includes(reason) ? 'interrupted' : 'local';
      recording.events.push({ at: recording.endedAt, reason }); await store.put(recording);
    })();
  } };
}
