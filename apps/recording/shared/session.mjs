export const CONSENT_VERSION = '2026-10-17-v1';
export const LEASE_MS = 15000;
export const SESSION_MS = 2 * 60 * 60 * 1000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const participant = (actor, name, now) => ({ identity: actor.role, participantId: actor.participantId, name, connected: false, seenAt: now, consent: { record: false, drive: false, version: CONSENT_VERSION } });
const fresh = (p, now) => p && now - p.seenAt >= 0 && now - p.seenAt < LEASE_MS;
export function recordAllowed(participants, now = Date.now()) {
  return participants.length === 2 && ['host', 'guest'].every(role => participants.some(p => p.identity === role && p.connected === true && Number.isFinite(p.consent.seenAt) && fresh(p.consent, now) && p.consent.record === true && p.consent.drive === true && p.consent.version === CONSENT_VERSION));
}
export function snapshot(state, actor, now) {
  const participants = Object.values(state.participants).map(p => ({ identity: p.identity, participantId: p.participantId, name: p.name, connected: p.connected && fresh(p, now), consent: { ...p.consent, seenAt: p.seenAt } }));
  const allowed = recordAllowed(participants, now);
  return { version: state.version, recording: state.recording && allowed, allowed, participants, serverTime: new Date(now).toISOString(), ended: state.ended,
    signals: state.signals.filter(s => s.to === actor.participantId).map(({ to, at, ...s }) => s) };
}
// Runs serially in one Durable Object per room, after Vercel verifies identity.
export function command(previous, request, now = Date.now()) {
  const { action, actor, payload = {} } = request;
  if (!actor || !['host', 'guest'].includes(actor.role) || !/^[a-f0-9-]{36}$/.test(actor.participantId || '')) fail(403, '参加情報を確認してください');
  let state = previous ? structuredClone(previous) : undefined;
  if (action === 'create') {
    if (state && !state.ended && state.expiresAt > now && actor.role === 'host' && state.participants.host.participantId === actor.participantId) return { state, response: snapshot(state, actor, now) };
    if (state || actor.role !== 'host') fail(409, '通話はすでに作成されています');
    state = { expiresAt: now + SESSION_MS, ended: false, recording: false, version: 0, generation: 0, participants: { host: participant(actor, payload.name, now) }, signals: [], dedup: [], sequence: 0 };
  } else {
    if (!state || state.ended || state.expiresAt <= now) fail(410, '通話は終了しています。新しく作成してください');
    if (action === 'join') {
      if (actor.role === 'guest' && state.participants.guest?.participantId === actor.participantId) return { state, response: snapshot(state, actor, now) };
      if (actor.role !== 'guest' || state.participants.guest) fail(409, '相手はすでに参加しています。再参加する場合は通話を作り直してください');
      state.participants.guest = participant(actor, payload.name, now);
    } else {
      const self = state.participants[actor.role];
      if (!self || self.participantId !== actor.participantId) fail(403, 'この通話への参加権限がありません');
      if (action === 'heartbeat') {
        self.seenAt = now; self.connected = payload.connected === true;
        const cursor = Number(payload.cursor || 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > state.sequence) fail(400, '受信位置を確認してください');
        state.signals = state.signals.filter(s => s.to !== actor.participantId || s.seq > cursor);
      } else if (action === 'consent') {
        if (typeof payload.allowed !== 'boolean') fail(400, '同意内容を確認してください');
        self.consent = { record: payload.allowed, drive: payload.allowed, version: CONSENT_VERSION, consentAt: new Date(now).toISOString() };
        if (!payload.allowed) state.recording = false;
      } else if (action === 'start') {
        if (actor.role !== 'host') fail(403, '録音は通話の作成者が開始します');
        if (!snapshot(state, actor, now).allowed) fail(409, '二人の音声接続と録音・Drive保存への同意が必要です');
        state.recording = true;
      } else if (action === 'stop') state.recording = false;
      else if (action === 'leave' || action === 'end') {
        self.connected = false; self.consent.record = self.consent.drive = false;
        state.recording = false; state.ended = true;
      } else if (action === 'signal') {
        const { id, type, generation, data } = payload;
        if (!/^[a-f0-9-]{36}$/.test(id || '') || !Number.isSafeInteger(generation) || generation < 0 || JSON.stringify(data ?? null).length > 16000) fail(400, '接続情報を確認してください');
        if (!['offer', 'answer', 'candidate', 'relay-request'].includes(type)) fail(400, '接続情報を確認してください');
        if ((type === 'offer' && actor.role !== 'host') || (['answer', 'relay-request'].includes(type) && actor.role !== 'guest')) fail(403, '接続操作の権限がありません');
        const peer = state.participants[actor.role === 'host' ? 'guest' : 'host'];
        if (!peer) fail(409, '相手の参加を待ってください');
        if (!state.dedup.includes(id)) {
          if (type === 'offer') {
            if (generation !== state.generation + 1) fail(409, '接続情報の順序が変わりました');
            state.generation = generation; state.recording = false;
          } else if (generation !== state.generation) fail(409, '古い接続情報です');
          state.signals = state.signals.filter(s => now - s.at < 60000);
          if (state.signals.length >= 256) fail(429, '接続情報が多すぎます。通話を作り直してください');
          state.signals.push({ seq: ++state.sequence, to: peer.participantId, type, generation, data, at: now });
          state.dedup.push(id); state.dedup = state.dedup.slice(-256);
        }
      } else if (action !== 'status') fail(400, '操作を確認してください');
    }
  }
  if (!snapshot(state, actor, now).allowed) state.recording = false;
  state.version++;
  return { state, response: snapshot(state, actor, now) };
}
