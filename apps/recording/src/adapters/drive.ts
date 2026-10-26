import type { DriveArchive, Recording } from '../core/types';
import { store } from './storage';
import { sendResumable } from '../core/upload.mjs';
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export function manifest(recording: Recording) {
  return {
    schema: 'ippo-recording/1', layer: 'L0', mode: 'human', consultation_id: recording.consultationId, recording_id: recording.id,
    title: recording.title, started_at: recording.createdAt, ended_at: recording.endedAt,
    tracks: recording.tracks.map(track => ({ ...track, file_id: recording.driveFiles[track.speakerId] })),
    consent: recording.consent, events: recording.events, transcription: { status: 'not_requested', execution: 'manual_windows' },
    ai_analysis: { allowed: false }, shared_knowledge: { allowed: false }
  };
}
export const archive: DriveArchive = {
  async upload(recording, progress) {
    if (!recording.archiveAuth) throw new Error('送信の権限がありません。音声をダウンロードして収集担当者に渡してください。');
    const send = async (slot: string, blob: Blob) => {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      const response = await fetch(`${base}/api/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${recording.archiveAuth}` }, body: JSON.stringify({ recordingId: recording.id, slot, bytes: blob.size, mimeType: slot === 'manifest' ? 'application/json' : recording.mimeType.split(';')[0], digest }), signal: AbortSignal.timeout(25000) });
      const plan = await response.json(); if (!response.ok) throw Object.assign(new Error(plan.error || 'Driveに接続できません'), { status: response.status });
      const result = plan.complete ? plan : await sendResumable(plan.uploadUrl, blob, fetch, percent => progress(`${slot === 'manifest' ? '記録情報' : slot === 'host' ? '作成者の音声' : '相手の音声'}を送信中 ${percent}%`));
      if (!result.id) throw new Error('Drive保存の完了を確認できません');
      recording.driveFiles[slot] = result.id; await store.put(recording);
    };
    for (const track of recording.tracks) {
      progress(`${track.speakerName}の音声を確認中…`);
      const blob = await store.audio(recording, track.id); await send(track.speakerId, blob);
    }
    progress('同意・記録情報を送信中…');
    await send('manifest', new Blob([JSON.stringify(manifest(recording), null, 2)], { type: 'application/json' }));
    recording.state = 'saved'; await store.put(recording); return recording;
  }
};
