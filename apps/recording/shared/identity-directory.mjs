import { failIdentity as fail } from './identity-crypto.mjs';
const idOk = x => typeof x === 'string' && /^[a-f0-9-]{36}$/.test(x);
const tokenOk = x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x);
const pairKey = (a, b) => [a, b].sort().join(':');
const live = c => ['preparing', 'ringing', 'accepted'].includes(c.state);
export function pruneIdentity(state, now) {
  for (const collection of [state.exchanges, state.enrollments]) for (const [id, item] of Object.entries(collection)) if (item.expiresAt <= now) delete collection[id];
  for (const [id, at] of Object.entries(state.nonces)) if (at + 240000 < now) delete state.nonces[id];
  for (const [id, c] of Object.entries(state.calls)) {
    if (['preparing', 'ringing'].includes(c.state) && c.expiresAt <= now) c.state = 'expired';
    if (c.state === 'accepted' && c.until <= now) c.state = 'completed';
    if (!live(c)) { delete c.host; delete c.guest; delete c.invite; }
    if (c.createdAt + 86400000 <= now) delete state.calls[id];
  }
  return state;
}
export function identityCommand(previous, { action, actor: a, payload: p = {}, nonce, internal = false }, now = Date.now()) {
  const s = pruneIdentity(structuredClone(previous || { users: {}, devices: {}, pairs: {}, exchanges: {}, enrollments: {}, calls: {}, nonces: {} }), now);
  if (!a?.userId || !a?.deviceId) fail(401, 'この端末を登録してください');
  if (!internal && !['status', 'enroll-result'].includes(action)) {
    if (!idOk(nonce) || s.nonces[`${a.deviceId}:${nonce}`]) fail(409, 'この操作は処理済みです。もう一度操作してください');
    s.nonces[`${a.deviceId}:${nonce}`] = now;
  }
  const registered = () => {
    const d = s.devices[a.deviceId];
    if (!d || d.revoked || d.userId !== a.userId || d.publicKey !== a.publicKey) fail(401, 'この端末は未登録または解除済みです');
    return d;
  };
  const add = certificate => {
    if (s.devices[a.deviceId]?.revoked) fail(403, '解除された端末は再登録できません');
    s.users[a.userId] ||= { root: a.root };
    if (s.users[a.userId].root !== a.root) fail(403, '利用者の鍵が一致しません');
    if (!s.devices[a.deviceId]) {
      if (Object.values(s.devices).filter(d => d.userId === a.userId && !d.revoked).length >= 8) fail(409, '登録できる端末は8台までです');
      s.devices[a.deviceId] = { userId: a.userId, publicKey: a.publicKey, certificate, subscription: null, rate: [] };
    }
    return s.devices[a.deviceId];
  };
  const paired = (b) => s.pairs[pairKey(a.userId, b)]?.approved;
  const visible = c => ({ id: c.id, caller: c.caller, callee: c.callee, callerDevice: c.callerDevice, answeredBy: c.answeredBy, state: c.state, expiresAt: c.expiresAt, room: c.room, push: c.push || 'pending', offer: c.offer });
  const snapshot = () => ({ self: a.userId, deviceId: a.deviceId,
    contacts: Object.values(s.pairs).filter(x => x.approved && x.users.includes(a.userId)).map(x => ({ userId: x.users.find(u => u !== a.userId) })),
    exchanges: Object.entries(s.exchanges).filter(([, x]) => x.owner === a.userId || x.claimant === a.userId).map(([id, x]) => ({ id, owner: x.owner, claimant: x.claimant, ownerRoot: x.ownerRoot, claimantRoot: x.claimantRoot, card: x.card, approvals: x.approvals, expiresAt: x.expiresAt })),
    devices: Object.entries(s.devices).filter(([, d]) => d.userId === a.userId && !d.revoked).map(([id]) => ({ id })),
    enrollments: Object.entries(s.enrollments).filter(([, x]) => x.userId === a.userId).map(([id, x]) => ({ id, key: x.key, expiresAt: x.expiresAt })),
    calls: Object.values(s.calls).filter(c => c.caller === a.userId || c.callee === a.userId).sort((x, y) => y.createdAt - x.createdAt).slice(0, 20).map(visible), notifications: !!s.devices[a.deviceId]?.subscription });
  let result;
  if (action === 'register') {
    // The API verifies the team bootstrap code; it is never proof of an existing identity.
    if (!internal || !p.bootstrap || a.deviceId !== a.userId) fail(403, '初回登録の合言葉を確認してください');
    if (s.users[a.userId] && !s.devices[a.deviceId]) fail(403, '登録済み端末から追加してください');
    add(p.certificate); result = snapshot();
  } else if (action === 'exchange-claim') {
    const x = s.exchanges[p.id];
    if (!x || x.token !== p.token || x.owner === a.userId) fail(410, '登録リンクは無効または期限切れです');
    if (x.claimant && x.claimant !== a.userId) fail(409, 'このリンクは使用済みです');
    if (!s.devices[a.deviceId] && a.deviceId !== a.userId) fail(403, '登録済み端末から追加してください');
    if (typeof p.card !== 'string' || p.card.length > 4000) fail(400, '連絡先情報を確認してください');
    add(p.certificate); x.claimant = a.userId; x.claimantRoot = a.root; x.card = p.card; result = snapshot();
  } else if (action === 'enroll-result') {
    const e = s.enrollments[p.id];
    if (!e) result = { certificate: null };
    else { if (e.key !== a.publicKey || e.token !== p.token) fail(403, '端末追加情報が一致しません'); result = { certificate: e.certificate, book: e.book }; }
  } else {
    const device = registered();
    if (action === 'status') result = snapshot();
    else if (action === 'exchange-create') {
      if (!idOk(p.id) || !tokenOk(p.token)) fail(400, 'リンクを作成できません');
      if (Object.values(s.exchanges).filter(x => x.owner === a.userId).length >= 16) fail(429, '発行したリンクが多すぎます。10分後にお試しください');
      if (s.exchanges[p.id]) fail(409, 'リンクが重複しています');
      s.exchanges[p.id] = { owner: a.userId, ownerRoot: a.root, token: p.token, approvals: [], expiresAt: now + 600000 }; result = { expiresAt: now + 600000 };
    } else if (action === 'exchange-approve') {
      const x = s.exchanges[p.id];
      if (!x?.claimant || ![x.owner, x.claimant].includes(a.userId)) fail(403, '相手登録を確認できません');
      if (!x.approvals.includes(a.userId)) x.approvals.push(a.userId);
      if (x.approvals.length === 2) s.pairs[pairKey(x.owner, x.claimant)] = { users: [x.owner, x.claimant], approved: true };
      result = snapshot();
    } else if (action === 'remove') {
      delete s.pairs[pairKey(a.userId, p.userId)];
      for (const [id, x] of Object.entries(s.exchanges)) if ([x.owner, x.claimant].includes(a.userId) && [x.owner, x.claimant].includes(p.userId)) delete s.exchanges[id];
      for (const c of Object.values(s.calls)) if ([c.caller, c.callee].includes(a.userId) && [c.caller, c.callee].includes(p.userId)) c.state = 'cancelled';
      result = snapshot();
    } else if (action === 'enroll-approve') {
      if (!idOk(p.id) || !tokenOk(p.token) || !internal || p.verifiedUser !== a.userId || typeof p.book !== 'string' || p.book.length > 12000) fail(403, '追加する端末の署名を確認できません');
      const existing = s.enrollments[p.id];
      if (existing) { if (existing.userId !== a.userId || existing.key !== p.verifiedKey || existing.token !== p.token) fail(409, '端末追加情報が重複しています'); return { state: s, response: snapshot() }; }
      if (Object.values(s.enrollments).filter(x => x.userId === a.userId).length >= 8) fail(429, '端末追加が続いています。しばらく待ってください');
      const e = s.enrollments[p.id] = { userId: a.userId, key: p.verifiedKey, token: p.token, certificate: p.certificate, book: p.book, expiresAt: now + 600000 };
      const id = p.verifiedDevice;
      if (s.devices[id]?.revoked) fail(403, '解除済み端末です');
      if (Object.values(s.devices).filter(d => d.userId === a.userId && !d.revoked).length >= 8) fail(409, '登録できる端末は8台までです');
      s.devices[id] = { userId: a.userId, publicKey: e.key, certificate: e.certificate, subscription: null, rate: [] }; result = snapshot();
    } else if (action === 'revoke') {
      const d = s.devices[p.deviceId];
      if (!d || d.userId !== a.userId) fail(403, '端末を確認できません');
      // Descendant certificates are revoked too; a removed device cannot delegate around revocation.
      const keys = new Set([d.publicKey]); let changed;
      do { changed = false; for (const other of Object.values(s.devices)) if (!keys.has(other.publicKey) && (keys.has(other.certificate?.root) || other.certificate?.chain?.some(step => keys.has(step.key)))) { keys.add(other.publicKey); changed = true; } } while (changed);
      for (const other of Object.values(s.devices)) if (keys.has(other.publicKey)) { other.revoked = true; other.subscription = null; }
      for (const c of Object.values(s.calls)) if ([c.callerDevice, c.answeredBy].includes(p.deviceId)) c.state = 'completed';
      result = { revoked: true };
    } else if (action === 'subscribe') { device.subscription = p.subscription; result = snapshot(); }
    else if (action === 'ring') {
      if (!paired(p.userId)) fail(403, '相手との確認・登録を完了してください');
      if (!idOk(p.id) || !/^ippo-[a-f0-9-]{36}$/.test(p.room)) fail(400, '呼び出し情報が無効です');
      const existing = s.calls[p.id];
      if (existing) { if (existing.callerDevice !== a.deviceId || existing.callee !== p.userId) fail(403, '呼び出しを確認できません'); result = visible(existing); }
      else {
        device.rate = device.rate.filter(t => t > now - 60000);
        if (device.rate.length >= 5) fail(429, '発信が続いています。少し待ってください');
        if (Object.values(s.calls).some(c => live(c) && [c.caller, c.callee].some(u => [a.userId, p.userId].includes(u)))) fail(409, 'あなたか相手が通話中です');
        device.rate.push(now);
        const c = s.calls[p.id] = { id: p.id, caller: a.userId, callerDevice: a.deviceId, callee: p.userId, room: p.room, state: 'preparing', createdAt: now, expiresAt: now + 60000, offer: p.offer };
        result = visible(c);
      }
      result.subscriptions = Object.entries(s.devices).filter(([, d]) => d.userId === p.userId && !d.revoked && d.subscription).map(([id, d]) => ({ id, subscription: d.subscription }));
    } else {
      const c = s.calls[p.id];
      if (!c || ![c.caller, c.callee].includes(a.userId)) fail(404, '着信が見つかりません');
      const caller = c.callerDevice === a.deviceId, winner = c.answeredBy === a.deviceId;
      if (action === 'ready') {
        if (!internal || !caller || !live(c)) fail(409, '呼び出しは終了しています');
        if (c.state === 'preparing') { c.host = p.host; c.invite = p.host.invite; c.state = 'ringing'; c.push = p.push; }
      } else if (action === 'credentials') {
        if (!caller || !['ringing', 'accepted'].includes(c.state)) fail(403, 'この端末の通話ではありません'); result = { credentials: c.host };
      } else if (action === 'accept') {
        if (a.userId !== c.callee || !paired(c.caller) || !['ringing', 'accepted'].includes(c.state) || (c.answeredBy && !winner)) fail(409, '別の端末で応答済み、または終了した着信です');
        c.state = 'accepted'; c.answeredBy = a.deviceId; c.until ||= now + 7200000; result = { room: c.room, invite: c.invite };
      } else if (action === 'guest' || action === 'guest-credentials') {
        if (!winner || c.state !== 'accepted') fail(403, '応答した端末だけが通話できます');
        if (action === 'guest') { if (!internal) fail(403, '操作が無効です'); c.guest ||= p.credentials; } result = { credentials: c.guest || null };
      } else if (action === 'cancel') { if (!caller || !['preparing', 'ringing'].includes(c.state)) fail(409, '呼び出しは終了しています'); c.state = 'cancelled'; }
      else if (action === 'decline' || action === 'busy') { if (a.userId !== c.callee || c.state !== 'ringing') fail(409, '着信は終了しています'); c.state = action === 'busy' ? 'busy' : 'declined'; }
      else if (action === 'finish') { if (!caller && !winner) fail(403, 'この端末の通話ではありません'); c.state = 'completed'; }
      else fail(400, '操作を確認してください');
      result ||= visible(c);
    }
  }
  return { state: pruneIdentity(s, now), response: result };
}
