// Private Worker command boundary. Device proofs are SHA-256 digests, never raw keys.
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const DEFAULT_MEMBERS = [
  { id: 'member1', name: 'メンバー1', priority: true },
  { id: 'member2', name: 'メンバー2', priority: true },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `member${i + 3}`, name: `メンバー${i + 3}`, priority: false }))
];
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const validProof = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function teamMembers(raw) {
  if (!raw) return DEFAULT_MEMBERS;
  const names = JSON.parse(raw);
  if (!Array.isArray(names) || names.length !== 8 || names.some(n => typeof n !== 'string' || !n.trim() || n.length > 40)) fail(503, 'メンバー名の設定を確認してください');
  return DEFAULT_MEMBERS.map((m, i) => ({ ...m, name: names[i].trim() }));
}
export function pruneDirectory(state, now) {
  for (const [id, invite] of Object.entries(state.invites)) if (invite.expiresAt <= now) delete state.invites[id];
  for (const call of Object.values(state.calls)) {
    if (['preparing', 'ringing'].includes(call.state) && call.expiresAt <= now) call.state = 'expired';
    if (call.state === 'accepted' && call.sessionUntil <= now) call.state = 'completed';
  }
  for (const [id, call] of Object.entries(state.calls)) if (call.createdAt + 86400000 <= now) delete state.calls[id];
  const terminal = Object.values(state.calls).filter(c => !['preparing', 'ringing', 'accepted'].includes(c.state)).sort((a, b) => b.createdAt - a.createdAt);
  for (const c of terminal) { delete c.host; delete c.guest; delete c.invite; }
  for (const c of terminal.slice(100)) delete state.calls[c.id];
  return state;
}
export function directoryCommand(previous, request, now = Date.now()) {
  const state = pruneDirectory(structuredClone(previous || { devices: {}, pairs: {}, invites: {}, calls: {} }), now);
  const { action, actor, payload: p = {} } = request;
  const member = id => DEFAULT_MEMBERS.some(m => m.id === id);
  const deviceFor = memberId => Object.values(state.devices).find(d => d.memberId === memberId);
  const addDevice = () => {
    if (!member(p.memberId) || !validId(p.id) || !validProof(p.proof)) fail(400, '端末の登録情報を確認してください');
    const previousDevice = deviceFor(p.memberId);
    if (previousDevice) {
      if (action !== 'register' || !p.replace) fail(409, 'このメンバーは別の端末で登録済みです。再登録を選ぶと以前の相手登録が解除されます');
      for (const [id, pair] of Object.entries(state.pairs)) if (pair.members.includes(previousDevice.id)) delete state.pairs[id];
      for (const [id, invite] of Object.entries(state.invites)) if (invite.owner === previousDevice.id) delete state.invites[id];
      for (const c of Object.values(state.calls)) if ([c.caller, c.callee].includes(previousDevice.id)) c.state = 'cancelled';
      delete state.devices[previousDevice.id];
    }
    const device = { id: p.id, proof: p.proof, memberId: p.memberId, subscription: null, rate: [] };
    state.devices[device.id] = device; return device;
  };
  let self;
  if (!['register', 'redeem'].includes(action)) {
    self = state.devices[actor?.id];
    if (!self || self.proof !== actor?.proof) fail(401, 'この端末を登録してください');
  }
  const paired = (a, b) => Object.values(state.pairs).some(pair => pair.approved && pair.members.includes(a) && pair.members.includes(b));
  const visibleCall = call => ({ id: call.id, caller: state.devices[call.caller]?.memberId, callee: state.devices[call.callee]?.memberId, state: call.state, expiresAt: call.expiresAt, room: call.room, push: call.push || 'pending' });
  const snapshot = () => ({ self: self.memberId, contacts: Object.values(state.devices).filter(d => d.id !== self.id && paired(self.id, d.id)).map(d => ({ memberId: d.memberId, notifications: !!d.subscription })), pending: Object.entries(state.pairs).filter(([, pair]) => !pair.approved && pair.owner === self.id).map(([id, pair]) => ({ id, memberId: state.devices[pair.members.find(x => x !== self.id)]?.memberId })), calls: Object.values(state.calls).filter(c => c.caller === self.id || c.callee === self.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(visibleCall), notifications: !!self.subscription });
  let response;
  if (action === 'register') { self = addDevice(); response = snapshot(); }
  else if (action === 'invite') {
    if (!member(p.memberId) || p.memberId === self.memberId || !validProof(p.token) || !validId(p.id)) fail(400, '登録する相手を選んでください');
    if (Object.values(state.invites).filter(i => i.owner === self.id).length >= 8) fail(429, '登録リンクを発行済みです。10分後にお試しください');
    state.invites[p.id] = { owner: self.id, memberId: p.memberId, token: p.token, expiresAt: now + 600000 };
    response = { expiresAt: now + 600000 };
  } else if (action === 'redeem') {
    const invite = state.invites[p.inviteId];
    const completed = state.pairs[p.inviteId];
    if (!invite && completed && actor && completed.members.includes(actor.id) && completed.owner !== actor.id) {
      self = state.devices[actor.id];
      if (self?.proof !== actor.proof || self.memberId !== p.memberId) fail(403, '登録を確認できません');
      return { state, response: snapshot() };
    }
    if (!invite || invite.token !== p.token || !state.devices[invite.owner]) fail(410, '登録リンクは無効または期限切れです');
    if (p.memberId !== invite.memberId) fail(403, '指定されたメンバーとして登録してください');
    // An already registered device can pair without replacing its credentials.
    self = actor && state.devices[actor.id];
    if (self) { if (self.proof !== actor.proof || self.memberId !== invite.memberId) fail(403, 'この端末のメンバーが一致しません'); }
    else self = addDevice();
    state.pairs[p.inviteId] = { owner: invite.owner, members: [invite.owner, self.id], approved: false };
    delete state.invites[p.inviteId]; response = snapshot();
  } else if (action === 'approve') {
    const pair = state.pairs[p.id]; if (!pair || pair.owner !== self.id) fail(403, '登録を確認できません');
    pair.approved = true; response = snapshot();
  } else if (action === 'remove') {
    const other = deviceFor(p.memberId);
    for (const [id, pair] of Object.entries(state.pairs)) if (pair.members.includes(self.id) && pair.members.includes(other?.id)) delete state.pairs[id];
    for (const c of Object.values(state.calls)) if ([c.caller, c.callee].includes(self.id) && [c.caller, c.callee].includes(other?.id)) c.state = 'cancelled';
    response = snapshot();
  } else if (action === 'unregister') {
    for (const [id, pair] of Object.entries(state.pairs)) if (pair.members.includes(self.id)) delete state.pairs[id];
    for (const [id, invite] of Object.entries(state.invites)) if (invite.owner === self.id) delete state.invites[id];
    for (const c of Object.values(state.calls)) if ([c.caller, c.callee].includes(self.id)) c.state = 'cancelled';
    delete state.devices[self.id]; response = { removed: true };
  } else if (action === 'subscribe') { self.subscription = p.subscription; response = snapshot(); }
  else if (action === 'status') response = snapshot();
  else if (action === 'ring') {
    const other = deviceFor(p.memberId);
    if (!other || !paired(self.id, other.id)) fail(403, '相手との登録を完了してください');
    if (!validId(p.id) || !/^ippo-[a-f0-9-]{36}$/.test(p.room)) fail(400, '呼び出し情報が無効です');
    const existing = state.calls[p.id];
    if (existing) { if (existing.caller !== self.id || existing.callee !== other.id) fail(403, '呼び出しを確認できません'); response = { ...visibleCall(existing), duplicate: true, subscription: other.subscription }; }
    else {
      self.rate = self.rate.filter(t => t > now - 60000);
      if (self.rate.length >= 5) fail(429, '発信が続いています。少し待ってください');
      const occupied = Object.values(state.calls).some(c => ['preparing', 'ringing', 'accepted'].includes(c.state) && [c.caller, c.callee].some(d => d === self.id || d === other.id));
      if (occupied) fail(409, 'あなたか相手が通話中、または呼び出し中です');
      self.rate.push(now);
      const call = state.calls[p.id] = { id: p.id, caller: self.id, callee: other.id, state: 'preparing', room: p.room, createdAt: now, expiresAt: now + 60000 };
      response = { ...visibleCall(call), subscription: other.subscription };
    }
  } else {
    const call = state.calls[p.id];
    if (!call || ![call.caller, call.callee].includes(self.id)) fail(404, '着信が見つかりません');
    if (action === 'ready') {
      if (call.caller !== self.id || !['preparing', 'ringing', 'accepted'].includes(call.state)) fail(409, '呼び出しは終了しています');
      if (call.state === 'preparing') { call.host = p.host; call.invite = p.invite; call.state = 'ringing'; call.push = p.push; }
    } else if (action === 'credentials') {
      if (call.caller !== self.id || !['ringing', 'accepted'].includes(call.state)) fail(409, '呼び出しは終了しています');
      response = { credentials: call.host };
    } else if (action === 'push-expired') {
      if (call.caller !== self.id) fail(403, '呼び出しを確認できません');
      const other = state.devices[call.callee];
      if (other?.subscription?.endpoint === p.endpoint) other.subscription = null;
    } else if (action === 'accept') {
      if (call.callee !== self.id || !['ringing', 'accepted'].includes(call.state) || !paired(call.caller, call.callee)) fail(409, '着信は終了しています');
      call.state = 'accepted'; call.sessionUntil ||= now + 7200000;
      response = { invite: call.invite, room: call.room };
    } else if (action === 'guest') {
      if (call.callee !== self.id || call.state !== 'accepted') fail(409, '着信は終了しています');
      if (!call.guest) call.guest = p.credentials;
      response = { credentials: call.guest };
    } else if (action === 'guest-credentials') {
      if (call.callee !== self.id || call.state !== 'accepted') fail(409, '着信は終了しています');
      response = { credentials: call.guest || null };
    } else if (action === 'decline' || action === 'busy') {
      if (call.callee !== self.id || call.state !== 'ringing') fail(409, '着信は終了しています'); call.state = action === 'busy' ? 'busy' : 'declined';
    } else if (action === 'cancel') {
      if (call.caller !== self.id || !['preparing', 'ringing'].includes(call.state)) fail(409, '呼び出しは終了しています'); call.state = 'cancelled';
    } else if (action === 'finish') { call.state = 'completed'; }
    else fail(400, '操作を確認してください');
    response ||= visibleCall(call);
  }
  return { state: pruneDirectory(state, now), response };
}
