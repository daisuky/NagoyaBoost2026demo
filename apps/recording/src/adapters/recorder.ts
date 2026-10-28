import type { Recording, AudioRecorder } from '../core/types';
import { store } from './storage';
export function recordingMime() {
  if (typeof MediaRecorder === 'undefined') throw new Error('この端末では録音に対応していません。最新のSafariまたはChromeを利用してください。');
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('この端末の録音形式に対応していません'); return mime;
}
export async function startRecorder(recording: Recording, tracks: { stream: MediaStream; speakerId: string; speakerName: string }[], onFailure: (message: string) => void): Promise<AudioRecorder> {
  if (tracks.length !== 2) throw new Error('二人の音声を接続してから録音してください');
  const context = new AudioContext({ latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  const nodes: AudioNode[] = [];
  let queue = Promise.resolve(), failed = false, stopping: Promise<void> | undefined;
  let recorder: MediaRecorder | undefined, resolveStopped = () => {};
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const failure = (message = '端末への音声保存に失敗しました。空き容量を確認してください。') => {
    if (failed) return; failed = true; onFailure(message);
  };
  const cleanup = async () => {
    context.onstatechange = null;
    nodes.forEach(node => node.disconnect());
    destination.disconnect(); destination.stream.getTracks().forEach(track => track.stop());
    // Only our mixed output is stopped; input streams belong to the call.
    await context.close();
  };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('録音用の音声処理を開始できません。通話画面から再試行してください。')), 5000); })]);
    } finally { clearTimeout(timer); }
    if (context.state !== 'running') throw new Error('録音用の音声処理が停止しています');
    for (const track of tracks) {
      const source = context.createMediaStreamSource(track.stream), gain = context.createGain();
      // Mix both sides on the same clock, leaving headroom when they overlap.
      gain.gain.value = 0.5;
      source.connect(gain); gain.connect(destination); nodes.push(source, gain);
    }
    recording.audioLayout = 'conversation';
    recording.speakers = tracks.map(({ speakerId, speakerName }) => ({ speakerId, speakerName }));
    recording.tracks = [{ id: crypto.randomUUID(), speakerId: 'conversation', speakerName: '会話（二人の音声）', startedAt: new Date().toISOString(), chunkCount: 0 }];
    await store.put(recording);
    recorder = new MediaRecorder(destination.stream, { mimeType: recording.mimeType, audioBitsPerSecond: 64000 });
    let count = 0;
    recorder.ondataavailable = event => {
      if (!event.data.size) return; const index = count++;
      queue = queue.then(async () => {
        const track = recording.tracks[0];
        await store.append(recording.id, track.id, index, event.data);
        track.chunkCount = index + 1; track.bytes = (track.bytes || 0) + event.data.size;
        await store.put(recording);
      }).catch(() => failure());
    };
    recorder.onstop = () => { resolveStopped(); if (!stopping) failure('端末が録音を中断しました。保存済みの音声を確認してください。'); };
    recorder.onerror = () => failure('端末の録音処理でエラーが発生しました。保存済みの音声を確認してください。');
    recorder.start(2000);
    context.onstatechange = () => {
      if (!stopping && context.state !== 'running') failure('端末が録音用の音声処理を中断しました。通話は終了せず、保存済みの音声を確認できます。');
    };
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') { recorder.stop(); await stopped; }
    await queue; await cleanup(); recording.state = 'interrupted'; await store.put(recording).catch(() => {}); throw error;
  }
  return { stop(reason) {
    // Defer work so the stopping marker exists before a synchronous stop event.
    return stopping ||= Promise.resolve().then(async () => {
      context.onstatechange = null;
      if (recorder!.state !== 'inactive') recorder!.stop(); else resolveStopped();
      await stopped; await queue;
      try {
        const track = recording.tracks[0]; track.bytes = (await store.audio(recording, track.id)).size;
        if (!track.bytes) failure();
      } catch { failure(); }
      recording.audioBytes = recording.tracks.reduce((sum, track) => sum + (track.bytes || 0), 0);
      recording.endedAt = new Date().toISOString(); recording.state = failed || !['user', 'call-ended'].includes(reason) ? 'interrupted' : 'local';
      recording.events.push({ at: recording.endedAt, reason });
      try { await store.put(recording); } finally { await cleanup(); }
    });
  } };
}
