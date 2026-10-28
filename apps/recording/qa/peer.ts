import { CallController } from '../src/adapters/call';
import { command } from '../shared/session.mjs';
import { store } from '../src/adapters/storage';
import type { CallStatus, Credentials } from '../src/core/types';
import type { api } from '../src/core/api';
const button = document.querySelector<HTMLButtonElement>('#run')!, result = document.querySelector('#result')!;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, description: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (condition()) return; await pause(100); }
  throw new Error(`${description}がタイムアウト`);
}
button.onclick = async () => {
  button.disabled = true; result.textContent = '検証中…';
  const log = (text: string) => { result.textContent += `\n${text}`; };
  const context = new AudioContext(); await context.resume();
  const controllers: CallController[] = [], errors: string[] = [], recordIds: string[] = [], iceErrors = new Set<string>();
  const pendingRequests = new Map<number, string>(); let requestSequence = 0;
  const diagnostics = setInterval(() => {
    const target = document.querySelector('#diagnostics');
    if (target) target.textContent = JSON.stringify({ pending: [...pendingRequests.values()], calls: controllers.map(c => ({ role: c.credentials?.role, closed: c.closed, visible: c.pageVisible, polling: c.polling, negotiating: c.negotiating, recording: !!c.recorder, state: c.recording?.state, connection: c.pc?.connectionState, version: c.status?.version, allowed: c.status?.allowed, serverRecording: c.status?.recording })) }, null, 2);
  }, 1000);
  const production = document.querySelector<HTMLInputElement>('#production')!.checked;
  const realTurn = document.querySelector<HTMLInputElement>('#cloudflare')!.checked || production;
  const initialRelay = document.querySelector<HTMLInputElement>('#initial-relay')!.checked;
  let ice: { host: RTCIceServer[]; guest: RTCIceServer[] } = { host: [], guest: [] };
  let state: any;
  const identities = new Map<string, { role: string; participantId: string }>();
  const signalCounts: Record<string, number> = {};
  let hostCredential: Credentials;
  const request = (async (action: string, fields: Record<string, any> = {}, auth?: string) => {
    if (production) {
      const sequence = ++requestSequence; pendingRequests.set(sequence, action);
      try {
      const response = await fetch('/api/qa-production-call', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ action, ...fields }) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(`${action}: ${value.error || response.status}`), { status: response.status });
      if (action === 'create') hostCredential = value;
      return value;
      } finally { pendingRequests.delete(sequence); }
    }
    if (['create', 'join'].includes(action)) {
      const role = action === 'create' ? 'host' : 'guest', participantId = crypto.randomUUID();
      const actor = { role, participantId }, token = crypto.randomUUID(); identities.set(token, actor);
      const applied = command(state, { action, actor, payload: fields }); state = applied.state;
      const c = { room: `ippo-12345678-1234-1234-1234-123456789abc`, role, participantId, auth: token, iceServers: ice[role], status: applied.response, ...(role === 'host' ? { invite: 'test' } : {}) } as Credentials;
      if (role === 'host') hostCredential = c;
      return c;
    }
    if (action === 'signal') {
      const actor = identities.get(auth!);
      const kind = fields.type === 'candidate' ? fields.data?.candidate?.match(/ typ (\w+)/)?.[1] || 'unknown' : fields.type;
      const key = `${actor?.role}:generation${fields.generation}:${kind}`; signalCounts[key] = (signalCounts[key] || 0) + 1;
    }
    const applied = command(state, { action, actor: identities.get(auth!), payload: fields }); state = applied.state;
    return applied.response as CallStatus;
  }) as typeof api;
  const media = (frequency: number) => async () => {
    const source = context.createOscillator(), target = context.createMediaStreamDestination();
    source.frequency.value = frequency; source.connect(target); source.start(); return target.stream;
  };
  const make = (frequency: number) => {
    const controller = new CallController(() => {}, message => { errors.push(message); log(`ERROR: ${message}`); }, () => {}, { request, media: media(frequency), playbackMuted: true });
    controllers.push(controller); return controller;
  };
  try {
    if (production) log('診断条件: 実Vercel API・Cloudflare接続管理・TURNを使用。マイク・Drive保存は使わない');
    if (realTurn && !production) {
      const response = await fetch('/api/qa-turn', { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error);
      ice = await response.json();
      if (document.querySelector<HTMLInputElement>('#tls-only')!.checked) {
        for (const role of ['host', 'guest'] as const) ice[role] = ice[role].map(server => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => /^turns:.*:443\?transport=tcp$/.test(url)) })).filter(server => server.urls.length);
        if (ice.host.length === 0 || ice.guest.length === 0) throw new Error('TLS 443のTURN候補がない');
        log('診断条件: TURN over TLS / TCP 443のみ');
      }
      log('PASS: Cloudflareから両者それぞれ10分有効のTURN認証情報を発行');
    }
    const host = make(440), guest = make(880);
    await host.connect('create', { name: '合成host' });
    if (initialRelay) host.pc!.setConfiguration({ ...host.pc!.getConfiguration(), iceTransportPolicy: 'relay' });
    if (!host.credentials?.invite || host.connection === 'disconnected') throw new Error('招待待機に失敗');
    log('PASS: 作成者が招待待機状態になった');
    if (!initialRelay) {
      await host.visibility(false);
      if (host.closed || !host.waitingSuspended || host.pc || host.local?.getTracks().some(t => t.readyState !== 'ended')) throw new Error('招待を送る間のマイク解放・招待保持に失敗');
      log('PASS: 招待を送るための画面離脱でマイクを解放し、通話の招待を保持');
    }
    await guest.connect('join', { name: '合成guest', invite: hostCredential!.invite });
    if (!initialRelay) {
      await host.visibility(true);
      if (host.closed || host.waitingSuspended) throw new Error('招待待機からの再開に失敗');
      log('PASS: 相手が参加した後に画面へ戻り、新しいマイクで接続を再開');
    }
    if (initialRelay) guest.pc!.setConfiguration({ ...guest.pc!.getConfiguration(), iceTransportPolicy: 'relay' });
    if (controllers.some(c => !c.audio?.muted)) throw new Error('検証のスピーカー出力が消音されていない');
    for (const c of controllers) c.pc!.onicecandidateerror = event => iceErrors.add(`ICE ${c.credentials?.role}: ${event.errorCode} / ${event.url} / ${event.errorText.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')}`);
    await until(() => controllers.every(c => c.pc?.connectionState === 'connected'), '2者のP2P接続');
    await until(() => controllers.every(c => c.remote.getAudioTracks().length === 1), '双方向音声トラック');
    await pause(2500); await host.stats(); await guest.stats();
    const expectedRoute = initialRelay ? 'relay' : 'direct';
    if (host.route !== expectedRoute || guest.route !== expectedRoute) throw new Error(`${expectedRoute}接続を確認できない`);
    log(`PASS: 2つの実RTCPeerConnectionが${expectedRoute}接続し、双方向の音声を受信`);
    await host.consent(true); await guest.consent(true);
    await until(() => !!host.status?.allowed, '双方の同意反映');
    await host.start('QA WebRTC 合成音声');
    recordIds.push(host.recording!.id);
    await pause(4500); await host.stop('user');
    const recording = host.recording!;
    for (const track of recording.tracks) {
      const blob = await store.audio(recording, track.id), audio = await context.decodeAudioData(await blob.arrayBuffer());
      if (audio.duration < 4 || blob.size < 100 || recording.tracks.length !== 1 || track.speakerId !== 'conversation') throw new Error('会話音声が不足');
      log(`PASS: ${track.speakerId} の音声を録音・復元・デコード (${audio.duration.toFixed(2)}秒)`);
    }
    const peers = controllers.map(c => c.pc);
    log('STEP: 作成者の画面切替に向けて録音を開始');
    await host.start('QA 作成者の画面切替'); recordIds.push(host.recording!.id); await pause(500);
    const ongoingRecorder = host.recorder, ongoingId = host.recording!.id;
    log('STEP: 作成者の画面切替通知を送信');
    await host.visibility(false);
    if (host.recorder !== ongoingRecorder || controllers.some((c, i) => c.closed || c.pc !== peers[i] || c.pc?.connectionState !== 'connected')) throw new Error('作成者の画面切替で通話または録音が切断された');
    await pause(1000);
    log('STEP: 作成者の復帰通知を送信');
    await host.visibility(true); await until(() => !!host.status?.allowed, '作成者復帰後の接続確認');
    if (host.recorder !== ongoingRecorder) throw new Error('画面復帰で録音が入れ替わった');
    log('PASS: 作成者の画面切替と復帰で同じ通話・録音を維持');
    await guest.visibility(false);
    const receivedBytes = async () => {
      let bytes = 0; (await host.pc!.getStats()).forEach(item => { if (item.type === 'inbound-rtp') bytes += item.bytesReceived || 0; }); return bytes;
    };
    const beforeBytes = await receivedBytes(); await pause(1500);
    if (await receivedBytes() <= beforeBytes || controllers.some((c, i) => c.closed || c.pc !== peers[i])) throw new Error('画面を離れた相手の音声を継続受信できない');
    await guest.visibility(true); await until(() => !!host.status?.allowed, '相手復帰後の接続確認');
    if (host.recorder !== ongoingRecorder || host.recording!.id !== ongoingId) throw new Error('相手の画面切替で録音が切れた');
    log('PASS: 相手の画面切替でも双方向の音声と同じ録音を維持');
    await pause(1500); await host.stop('user');
    for (const track of host.recording!.tracks) {
      const audio = await context.decodeAudioData(await (await store.audio(host.recording!, track.id)).arrayBuffer());
      if (audio.duration < 4) throw new Error('画面切替をまたぐ会話音声が不足');
      const samples = audio.getChannelData(0), offset = Math.floor(audio.sampleRate), length = Math.floor(audio.sampleRate);
      for (const frequency of [440, 880]) {
        let real = 0, imaginary = 0;
        for (let i = 0; i < length; i++) { const phase = 2 * Math.PI * frequency * i / audio.sampleRate; real += samples[offset + i] * Math.cos(phase); imaginary += samples[offset + i] * Math.sin(phase); }
        if (2 * Math.hypot(real, imaginary) / length < 0.05) throw new Error('会話音声に片方の声がない');
      }
      log(`PASS: 両者の画面切替をまたいだ一つの会話音声に両方の声を確認 (${audio.duration.toFixed(2)}秒)`);
    }
    await host.start('QA 同意撤回'); recordIds.push(host.recording!.id); await pause(500); await guest.consent(false);
    await until(() => !host.recorder, '同意撤回による停止');
    log('PASS: 相手の同意撤回で録音を停止');
    await guest.consent(true); await until(() => !!host.status?.allowed, '同意の再反映');
    const before = host.generation;
    await host.offer(false);
    await until(() => !host.negotiating && !guest.negotiating && host.generation === before + 1, 'ICE再交渉');
    log('PASS: ICE restartで再交渉し、録音を自動再開しない');
    if (host.recorder) throw new Error('再交渉後に録音が再開された');
    await guest.useRelay();
    await until(() => controllers.every(c => c.pc?.getConfiguration().iceTransportPolicy === 'relay') && !host.negotiating, '中継への切り替え要求');
    log('PASS: 相手からの中継要求で両端のICE方針をrelayへ変更・再交渉（実TURN接続は未検証）');
    if (realTurn) {
      await until(() => controllers.every(c => c.pc?.connectionState === 'connected' && c.route === 'relay'), '実TURN経路の選択');
      log('PASS: 両者の選択済みICE経路が実際にCloudflare TURNへ切り替わった');
      await until(() => !!host.status?.allowed, 'TURN経路での双方の接続確認');
      await host.start('QA Cloudflare TURN 合成音声'); recordIds.push(host.recording!.id);
      await pause(4500); await host.stop('user');
      for (const track of host.recording!.tracks) {
        const blob = await store.audio(host.recording!, track.id), audio = await context.decodeAudioData(await blob.arrayBuffer());
        const samples = audio.getChannelData(0), rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
        if (audio.duration < 4 || rms < 0.01) throw new Error('TURN経路の音声が不足または無音');
        log(`PASS: TURN経由の${track.speakerId}音声を録音・復元 (${audio.duration.toFixed(2)}秒 / RMS ${rms.toFixed(3)})`);
      }
    }
    await host.leave(true);
    await until(() => guest.closed, '相手側の終了');
    if (controllers.some(c => c.local?.getTracks().some(t => t.readyState !== 'ended'))) throw new Error('マイクの解放に失敗');
    if (errors.length) throw new Error(errors.join('; '));
    log('PASS: 両者の接続終了と音声トラックの解放');
    log(realTurn ? '実Cloudflare TURN経由の音声・録音検証に合格。別ネットワーク二台・iPhone実機は別途検証が必要。' : '全検証に合格。Cloudflare TURN実回線・iPhone実機は別途検証が必要。');
  } catch (error) {
    log(`FAIL: ${(error as Error).stack}`);
    for (const message of iceErrors) log(message);
    log(`Signaling: ${JSON.stringify(signalCounts)}`);
    for (const c of controllers) {
      log(JSON.stringify({ role: c.credentials?.role, connection: c.pc?.connectionState, ice: c.pc?.iceConnectionState, gathering: c.pc?.iceGatheringState, signaling: c.pc?.signalingState, policy: c.pc?.getConfiguration().iceTransportPolicy, generation: c.generation, remoteGeneration: c.remoteGeneration, pendingCandidates: c.candidates.length }));
      for (const [side, description] of [['local', c.pc?.localDescription], ['remote', c.pc?.remoteDescription]] as const) log(`${side} SDP candidate types: ${description?.sdp.match(/typ \w+/g)?.join(',') || '(none)'}`);
      const stats = await c.pc?.getStats();
      stats?.forEach(item => { if (item.type === 'candidate-pair') log(JSON.stringify({ type: item.type, state: item.state, nominated: item.nominated, requestsSent: item.requestsSent, responsesReceived: item.responsesReceived })); if (['local-candidate', 'remote-candidate'].includes(item.type)) log(JSON.stringify({ type: item.type, candidateType: item.candidateType, protocol: item.protocol, relayProtocol: item.relayProtocol })); });
    }
  }
  finally {
    clearInterval(diagnostics);
    for (const c of controllers) await c.leave(false);
    for (const id of recordIds) await store.remove(id);
    await context.close(); button.disabled = false;
  }
};
