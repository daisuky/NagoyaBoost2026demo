export type Consent = { record: boolean; drive: boolean; seenAt: number; consentAt?: string; version: string };
export type Participant = { identity: string; participantId: string; name: string; connected: boolean; consent: Consent };
export type Signal = { seq: number; type: 'offer' | 'answer' | 'candidate' | 'relay-request'; generation: number; data: any };
export type CallStatus = { version: number; recording: boolean; allowed: boolean; participants: Participant[]; serverTime: string; ended: boolean; signals: Signal[] };
export type Credentials = { auth: string; iceServers: RTCIceServer[]; room: string; role: 'host' | 'guest'; participantId: string; status: CallStatus; invite?: string; archiveAuth?: string };
export type Recording = {
  id: string; consultationId: string; title: string; createdAt: string; endedAt?: string;
  state: 'recording' | 'local' | 'interrupted' | 'saved'; mimeType: string;
  tracks: { id: string; speakerId: string; speakerName: string; startedAt: string; chunkCount: number; bytes?: number }[];
  audioBytes?: number;
  upload?: { state: 'uploading' | 'failed' | 'blocked'; attempts: number; error?: string; nextRetryAt?: number };
  consent: Participant[]; events: { at: string; reason: string }[];
  driveFiles: Record<string, string>; driveFolderId?: string; driveAccount?: string;
  archiveAuth?: string;
};
export interface RecordingStore {
  list(): Promise<Recording[]>; put(recording: Recording): Promise<void>;
  append(recordingId: string, trackId: string, index: number, data: Blob): Promise<void>;
  audio(recording: Recording, trackId: string): Promise<Blob>; remove(id: string): Promise<void>;
}
export interface AudioRecorder {
  stop(reason: string): Promise<void>;
}
export interface DriveArchive { upload(recording: Recording, progress: (message: string) => void): Promise<Recording> }
