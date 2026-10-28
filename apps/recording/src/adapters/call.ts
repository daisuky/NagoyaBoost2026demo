import type { CallStatus, Credentials, Recording, AudioRecorder, Signal } from '../core/types';
import { api } from '../core/api';
import { qualityWindow } from '../core/quality.mjs';
import { recordingMime, startRecorder } from './recorder';

export type View = { connection: string; credentials?: Credentials; status?: CallStatus; recordingId?: string; muted: boolean; speaking: string[]; route?: 'direct' | 'relay' | 'unknown'; message?: string; audioBlocked?: boolean };
type Options = { request?: typeof api; media?: () => Promise<MediaStream>; playbackMuted?: boolean };

export class CallController {
  credentials?: Credentials; status?: CallStatus; recorder?: AudioRecorder; recording?: Recording;
  pc?: RTCPeerConnection; local?: MediaStream; remote = new MediaStream(); audio?: HTMLAudioElement;
  connection = 'disconnected'; route: View['route'] = 'unknown'; message = ''; audioBlocked = false;
  timer?: ReturnType<typeof setInterval>; statsTimer?: ReturnType<typeof setInterval>; disconnectTimer?: ReturnType<typeof setTimeout>;
  polling = false; closed = false; epoch = 0; muted = false; cursor = 0; generation = 0; remoteGeneration = 0;
  relayRequested = false; negotiating = false; descriptionSent = false; connectedAt = 0; quality: any;
  candidates: { generation: number; candidate: RTCIceCandidateInit }[] = [];
  pendingLocal: RTCIceCandidateInit[] = [];
  operation = Promise.resolve(); outbox = Promise.resolve();
  waitingSuspended = false; resumingWaiting = false;
  pageVisible = true; recoveryStarted = 0; resumingCall = false;
  private request: typeof api; private media: () => Promise<MediaStream>; private playbackMuted: boolean;
  constructor(private change: (view: View) => void, private error: (message: string) => void, private saved: () => void, options: Options = {}) {
    this.request = options.request || api;
    this.playbackMuted = options.playbackMuted === true;
    this.media = options.media || (() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
  }
  emit() { this.change({ connection: this.connection, credentials: this.credentials, status: this.status, recordingId: this.recorder ? this.recording?.id : undefined, muted: this.muted, speaking: [], route: this.route, message: this.message, audioBlocked: this.audioBlocked }); }
  async call(action: string, fields: Record<string, unknown> = {}) {
    if (!this.credentials) throw new Error('通話に参加してください');
    const status = await this.request<CallStatus>(action, fields, this.credentials.auth);
    this.accept(status); return status;
  }
  accept(status: CallStatus) {
    if (this.status && status.version <= this.status.version) return;
    this.status = status;
    // An ended room naturally has allowed=false. Handle normal remote hangup
    // first so its final recording is eligible for automatic Drive upload.
    if (status.ended && !this.closed) {
      void this.leave(false, '通話が終了しました。録音は自動でDriveへ送信します。');
      return;
    }
    // A delayed pre-start heartbeat can still say recording=false while the
    // start command is in flight. It must not cancel an unstarted recorder.
    // Revoked consent always cancels, including a pending start.
    if (!status.allowed) void this.stop('consent-or-status-ended');
    else if (!status.recording && this.recorder) void this.stop('user');
    this.emit();
  }
  async connect(action: 'create' | 'join', fields: Record<string, unknown>, credentials?: Credentials) {
    this.closed = false;
    try {
      // Request a duplex audio session where the browser supports it.
      const session = typeof navigator !== 'undefined' && (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) { try { session.type = 'play-and-record'; } catch { /* Optional browser API. */ } }
      this.local = await this.media();
      if (this.closed) { this.local.getTracks().forEach(t => t.stop()); throw new Error('通話の開始を中断しました。もう一度お試しください。'); }
      if (document.visibilityState !== 'visible') throw new Error('通話画面に戻ってから、もう一度開始してください。');
      this.credentials = credentials || await this.request<Credentials>(action, fields);
      if (this.closed) throw new Error('通話の開始を中断しました。もう一度お試しください。');
      this.status = this.credentials.status;
      this.audio = document.createElement('audio'); this.audio.muted = this.playbackMuted; this.audio.autoplay = true; this.audio.style.display = 'none';
      document.body.append(this.audio);
      this.makePeer('all');
      if (document.visibilityState !== 'visible') await this.visibility(false);
      await this.poll();
      if (this.closed) throw new Error(this.message || '通話を開始できませんでした。もう一度お試しください。');
      if (!this.waitingSuspended) this.monitor();
      this.emit();
    } catch (error) { await this.leave(false); throw error; }
  }
  monitor() {
    clearInterval(this.timer); clearInterval(this.statsTimer);
    this.timer = setInterval(() => void this.poll(), 1000);
    this.statsTimer = setInterval(() => void this.stats(), 2000);
  }
  async visibility(visible: boolean) {
    this.pageVisible = visible;
    if (this.closed || !this.credentials) return;
    if (!visible) {
      if (this.waitingSuspended) return;
      // Keep an unused invitation while its host switches apps to send it.
      // No microphone, transport, recording or background polling survives.
      if (this.credentials.role === 'host' && this.generation === 0 && this.status?.participants.length === 1) {
        this.waitingSuspended = true;
        clearInterval(this.timer); clearInterval(this.statsTimer); clearTimeout(this.disconnectTimer);
        const pc = this.pc; this.pc = undefined; pc?.close();
        this.local?.getTracks().forEach(t => t.stop());
        this.connection = 'waiting'; this.message = '招待を保持しています。通話画面に戻るとマイクの準備を再開します。'; this.emit();
        return;
      }
      this.recoveryStarted = 0;
      this.message = '画面を切り替えても、同じ通話と録音を継続します。';
      // Visibility is not a media disconnection or a consent withdrawal.
      // Keep the same microphone, peer, recorder and server recording state.
      await this.poll(); this.emit();
      return;
    }
    this.recoveryStarted = 0;
    if (!this.waitingSuspended) { await this.restoreCall(); return; }
    if (this.resumingWaiting) return;
    this.resumingWaiting = true;
    try {
      const stream = await this.media();
      if (this.closed || document.visibilityState !== 'visible') { stream.getTracks().forEach(t => t.stop()); return; }
      stream.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
      this.local = stream; this.waitingSuspended = false; this.message = '';
      this.makePeer('all'); await this.poll();
      if (!this.closed && !this.waitingSuspended) this.monitor();
    } catch (error) {
      if (!this.waitingSuspended && !this.closed) await this.leave(false, '音声接続の準備を再開できないため終了しました。新しい通話を作成してください。');
      this.error(`マイクの準備を再開できません。${(error as Error).message}`);
    }
    finally { this.resumingWaiting = false; }
  }
  async restoreCall() {
    if (this.closed || !this.credentials || this.resumingCall) return;
    this.resumingCall = true;
    try {
      await this.poll(); if (this.closed) return;
      if (!this.local?.getAudioTracks().some(track => track.readyState === 'live')) {
        await this.stop('track-ended');
        const stream = await this.media();
        if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
        this.local?.getTracks().forEach(track => track.stop()); this.local = stream;
        const track = stream.getAudioTracks()[0]; track.enabled = !this.muted;
        const sender = this.pc?.getSenders().find(sender => sender.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(track);
      }
      // play() can remain pending while a browser waits for playback permission.
      // It must never block restoration of the call or its supervision.
      void this.resumeAudio();
      if (this.pc?.connectionState !== 'connected' && !this.negotiating) {
        if (this.credentials.role === 'host') await this.offer(this.relayRequested);
        else if (!this.relayRequested) await this.useRelay();
        else await this.send('relay-request', null);
      }
      this.message = this.pc?.connectionState === 'connected' ? (this.status?.recording ? '同じ通話と録音を継続しています。' : '通話を継続しています。') : '音声の再接続を確認しています。';
    } catch (error) {
      if ([401, 403, 410].includes((error as { status?: number }).status || 0)) await this.leave(false, '通話が終了したか、参加情報の有効期限が切れました。');
      else { this.recoveryStarted ||= Date.now(); this.message = '接続を確認しています。録音は停止中です。'; }
    } finally { this.resumingCall = false; this.emit(); }
  }
  makePeer(policy: RTCIceTransportPolicy) {
    const previous = this.pc;
    const pc = this.pc = new RTCPeerConnection({ iceServers: this.credentials!.iceServers, iceTransportPolicy: policy });
    previous?.close(); this.remote.getTracks().forEach(track => track.stop());
    this.remote = new MediaStream(); if (this.audio) this.audio.srcObject = this.remote;
    this.connection = 'connecting'; this.route = 'unknown'; this.quality = undefined; this.connectedAt = 0;
    this.remoteGeneration = 0; this.candidates = []; this.pendingLocal = []; this.descriptionSent = false;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer); this.disconnectTimer = undefined;
    this.local!.getAudioTracks().forEach(track => pc.addTrack(track, this.local!));
    pc.ontrack = event => {
      if (this.closed || this.pc !== pc) return;
      this.remote.addTrack(event.track);
      event.track.onended = () => { if (this.pc === pc) void this.stop('track-ended'); };
      event.track.onmute = () => { if (this.pc === pc) void this.stop('track-muted'); };
      void this.resumeAudio(); this.emit();
    };
    pc.onicecandidate = event => {
      if (!event.candidate || this.closed || this.pc !== pc) return;
      const candidate = event.candidate.toJSON();
      if (!this.descriptionSent) this.pendingLocal.push(candidate);
      else void this.send('candidate', candidate).catch(e => { if (this.pc === pc && !this.closed) this.error(e.message); });
    };
    pc.onconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      this.connection = pc.connectionState;
      if (pc.connectionState === 'connected') {
        this.connectedAt ||= Date.now();
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer); this.disconnectTimer = undefined;
      } else {
        void this.stop('connection-interrupted');
        if (['failed', 'disconnected'].includes(pc.connectionState) && !this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => { this.disconnectTimer = undefined; void this.useRelay('音声の接続が不安定なため中継経路を試しています。').catch(e => this.error(e.message)); }, pc.connectionState === 'failed' ? 0 : 8000);
        }
      }
      this.emit(); void this.poll();
    };
    this.emit();
  }
  async resumeAudio() {
    try { await this.audio?.play(); this.audioBlocked = false; }
    catch { this.audioBlocked = true; }
    this.emit();
  }
  send(type: Signal['type'], data: unknown, generation = this.generation) {
    const id = crypto.randomUUID();
    const task = this.outbox.then(async () => {
      if (this.closed) return;
      // Retrying the same ID is safe even if the first response was lost.
      for (let attempt = 0; ; attempt++) {
        try { await this.call('signal', { id, type, generation, data }); return; }
        catch (error) { if (attempt >= 1 || this.closed) throw error; }
      }
    });
    this.outbox = task.catch(() => {}); return task;
  }
  async flushCandidates() {
    this.descriptionSent = true;
    const candidates = this.pendingLocal.splice(0);
    for (const candidate of candidates) await this.send('candidate', candidate);
  }
  async offer(relay: boolean) {
    let pc = this.pc;
    if (!pc || this.closed || this.negotiating || this.credentials?.role !== 'host') return;
    if (pc.signalingState !== 'stable') throw new Error('接続の準備中です。少し待ってから再試行してください');
    this.negotiating = true; this.descriptionSent = false;
    await this.stop('route-change');
    try {
      await this.outbox;
      // Some browsers retain the working direct pair after a policy-only ICE
      // restart. A fresh transport ensures a user-requested relay is enforced.
      const recreate = relay && pc.getConfiguration().iceTransportPolicy !== 'relay';
      if (relay) this.relayRequested = true;
      if (recreate) { this.makePeer('relay'); pc = this.pc!; }
      this.generation++;
      const offer = await pc.createOffer({ iceRestart: this.generation > 1 && !recreate });
      await pc.setLocalDescription(offer);
      await this.send('offer', { description: pc.localDescription!.toJSON(), relay, recreate });
      await this.flushCandidates();
    } catch (error) { this.negotiating = false; throw error; }
  }
  async receive(signal: Signal) {
    let pc = this.pc; if (!pc || this.closed) return;
    if (signal.type === 'relay-request') {
      if (this.relayRequested && !this.negotiating) await this.offer(true);
      else await this.useRelay('相手の接続状況に合わせて中継経路を試しています。');
      return;
    }
    if (signal.type === 'offer') {
      if (this.credentials?.role !== 'guest' || signal.generation <= this.remoteGeneration) return;
      await this.stop('route-change'); this.negotiating = true; this.descriptionSent = false;
      this.generation = signal.generation;
      if (signal.data.relay) {
        this.relayRequested = true;
        if (signal.data.recreate || pc.getConfiguration().iceTransportPolicy !== 'relay') { this.makePeer('relay'); pc = this.pc!; }
        this.message = '中継経路へ切り替えています。';
      }
      await pc.setRemoteDescription(signal.data.description); this.remoteGeneration = signal.generation;
      await pc.setLocalDescription(await pc.createAnswer());
      await this.send('answer', { description: pc.localDescription!.toJSON() });
      await this.flushCandidates(); this.negotiating = false;
    } else if (signal.type === 'answer') {
      if (signal.generation !== this.generation || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(signal.data.description); this.remoteGeneration = signal.generation; this.negotiating = false;
    } else if (signal.type === 'candidate') {
      if (signal.generation < this.generation) return;
      this.candidates.push({ generation: signal.generation, candidate: signal.data });
    }
    const waiting = this.candidates.splice(0);
    for (const item of waiting) {
      if (item.generation === this.remoteGeneration && pc.remoteDescription) await pc.addIceCandidate(item.candidate);
      else if (item.generation >= this.generation) this.candidates.push(item);
    }
  }
  async poll() {
    if (this.polling || this.closed || this.waitingSuspended || !this.credentials) return;
    this.polling = true;
    try {
      const status = await this.call('heartbeat', { cursor: this.cursor, connected: this.pc?.connectionState === 'connected' && !this.negotiating });
      if (this.closed || this.waitingSuspended) return;
      for (const signal of status.signals || []) {
        if (signal.seq <= this.cursor) continue;
        await this.receive(signal); this.cursor = signal.seq;
      }
      if (!this.waitingSuspended && this.credentials.role === 'host' && this.generation === 0 && status.participants.length === 2) await this.offer(false);
      if (this.recoveryStarted) { this.recoveryStarted = 0; this.message = '接続を確認できました。録音は作成者が手動で再開してください。'; }
      this.emit();
    } catch (error) {
      const terminal = [401, 403, 410].includes((error as { status?: number }).status || 0);
      await this.stop(terminal ? 'call-ended' : 'server-unavailable');
      if (terminal) await this.leave(false, '通話が終了したか、参加情報の有効期限が切れました。新しい通話を作成してください。');
      else {
        // Fail closed for recording, but preserve voice during brief outages.
        if (this.status) this.status = { ...this.status, allowed: false, recording: false };
        this.message = '接続管理との通信を再試行しています。音声通話は維持を試み、録音は停止しています。';
        if (this.pageVisible) {
          this.recoveryStarted ||= Date.now();
          // A signaling outage must not tear down a still-live voice call.
          // Recording stays stopped until consent/status can be checked again.
        }
        this.emit();
      }
    } finally { this.polling = false; }
  }
  async useRelay(message = '中継経路を試しています。切り替え後に音声を確認してください。') {
    if (this.closed || !this.pc || !this.credentials) return;
    if (this.relayRequested || this.route === 'relay') { this.message = '現在は中継経路です。改善しない場合はネットワークを変更してください。'; this.emit(); return; }
    if (this.negotiating) throw new Error('接続の準備中です。少し待ってから再試行してください');
    this.message = message; await this.stop('route-change'); this.emit();
    if (this.credentials.role === 'host') await this.offer(true);
    else { this.relayRequested = true; await this.send('relay-request', null); }
  }
  async stats() {
    const pc = this.pc;
    if (!pc || this.closed || pc.connectionState !== 'connected') return;
    try {
      const report = await pc.getStats(); if (pc !== this.pc || this.closed) return;
      let pair: any; let inbound: any;
      report.forEach(item => { if (item.type === 'transport' && item.selectedCandidatePairId) pair = report.get(item.selectedCandidatePairId); if (item.type === 'inbound-rtp' && (item.kind || item.mediaType) === 'audio') inbound = item; });
      if (!pair) report.forEach(item => { if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) pair = item; });
      if (pair) {
        const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
        this.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : local?.candidateType && remote?.candidateType ? 'direct' : 'unknown';
      }
      if (inbound) {
        this.quality = qualityWindow(this.quality, { at: Date.now(), received: inbound.packetsReceived || 0, lost: Math.max(0, inbound.packetsLost || 0), rtt: pair?.currentRoundTripTime });
        if (this.quality.bad >= 4 && Date.now() - this.connectedAt > 12000) {
          if (this.route === 'direct' && !this.relayRequested) await this.useRelay('音声の欠落や遅延が続いているため、中継経路を試しています。');
          else this.message = '音声の欠落や遅延が続いています。ネットワークの状態を確認してください。';
        }
      }
      this.emit();
    } catch { /* Some browsers expose only a subset of WebRTC statistics. */ }
  }
  async consent(allowed: boolean) { if (!allowed) await this.stop('consent-withdrawn'); await this.call('consent', { allowed }); }
  async mute() { this.muted = !this.muted; this.local?.getAudioTracks().forEach(track => { track.enabled = !this.muted; }); this.emit(); }
  async start(title: string) {
    const task = this.operation.then(async () => {
      const c = this.credentials; if (!c || c.role !== 'host' || this.recorder) return;
      if (!this.pageVisible || document.visibilityState !== 'visible') throw new Error('録音は通話画面に戻ってから開始してください');
      if (this.pc?.connectionState !== 'connected' || this.negotiating) throw new Error('音声の接続が完了するまでお待ちください');
      const epoch = this.epoch;
      const status = await this.call('start');
      if (!this.status?.allowed || !this.status.recording) return;
      const tracks = [this.local!, this.remote].map((stream, index) => {
        const track = stream.getAudioTracks().find(t => t.readyState === 'live' && !t.muted);
        const speakerId = index === 0 ? 'host' : 'guest';
        if (!track) throw new Error('二人の音声の接続を待ってから録音してください');
        return { stream: new MediaStream([track]), speakerId, speakerName: status.participants.find(p => p.identity === speakerId)?.name || speakerId };
      });
      if (epoch !== this.epoch || this.closed) { await this.call('stop'); return; }
      this.recording = { id: crypto.randomUUID(), consultationId: c.room, title: title.trim() || '新しい対話', createdAt: new Date().toISOString(), state: 'recording', mimeType: recordingMime(), tracks: [], consent: status.participants, events: [{ at: status.serverTime, reason: 'both-consented' }], driveFiles: {}, archiveAuth: c.archiveAuth };
      this.recorder = await startRecorder(this.recording, tracks, message => { this.error(message); void this.stop('recording-error'); });
      if (epoch !== this.epoch || this.closed || !this.status?.allowed || !this.status.recording) { await this.recorder.stop('interrupted-during-start'); this.recorder = undefined; this.saved(); }
      this.emit();
    });
    this.operation = task.catch(() => {});
    try { await task; } catch (error) { await this.call('stop').catch(() => {}); throw error; }
  }
  stop(reason = 'user') {
    this.epoch++;
    const task = this.operation.then(async () => {
      const recorder = this.recorder; if (!recorder) return;
      this.recorder = undefined; this.emit(); await recorder.stop(reason); this.saved();
      if (this.credentials && !this.closed) await this.call('stop').catch(() => {});
      this.emit();
    });
    this.operation = task.catch(error => this.error((error as Error).message)); return task;
  }
  async leave(end: boolean, message?: string) {
    if (message) this.message = message;
    this.closed = true; this.connection = 'disconnected';
    clearInterval(this.timer); clearInterval(this.statsTimer); clearTimeout(this.disconnectTimer);
    this.pc?.close(); this.local?.getTracks().forEach(t => t.stop()); this.remote.getTracks().forEach(t => t.stop());
    this.audio?.remove(); this.audio = undefined;
    await this.stop('call-ended');
    if (this.credentials) await this.request(end ? 'end' : 'leave', {}, this.credentials.auth).catch(() => {});
    this.emit();
  }
}
