import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { Credentials } from './core/types';
import { identityApi, getIdentity, probeIdentityStorage, prepareIdentity, localBook, makeContactLink, claimContact, exchangeDetails, approveContact, createEnrollment, approveEnrollment, receiveEnrollment, readCard, verifyIncoming, resetLocalIdentity } from './core/identity';
import { storageFailure } from './core/environment.mjs';
import type { Health, Directory, Contact, RingResult } from './core/identity';
import { notifications, armRingtone, ringOnce } from './adapters/notifications';
type Props = { active: boolean; showMembers: boolean; start: (role: 'create' | 'join', credentials: Credentials) => Promise<void>; onBusy?: (busy: boolean) => void };
type Pending = NonNullable<Awaited<ReturnType<typeof exchangeDetails>>>;
const labels: Record<string, string> = { preparing: '呼び出しを準備中', ringing: '応答を待っています', accepted: '応答しました', declined: '相手が応答を辞退しました', busy: '相手は通話中です', cancelled: '呼び出しを取り消しました', expired: '応答がありませんでした', completed: '通話は終了しました' };
export function TeamCalls({ active, showMembers, start, onBusy }: Props) {
  const [health, setHealth] = useState<Health>(), [directory, setDirectory] = useState<Directory>();
  const [contacts, setContacts] = useState<Contact[]>([]), [pairs, setPairs] = useState<Pending[]>([]);
  const [name, setName] = useState(''), [accessCode, setAccessCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [link, setLink] = useState(''), [qr, setQr] = useState(''), [pasted, setPasted] = useState(''), [ringId, setRingId] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [fragment, setFragment] = useState(() => new URLSearchParams(location.hash.slice(1)));
  const [enrolling, setEnrolling] = useState(false), [readyIncoming, setReadyIncoming] = useState('');
  const [storage, setStorage] = useState<'checking' | 'ready' | 'unavailable'>('checking'), [storageMessage, setStorageMessage] = useState('');
  const [registrationState, setRegistrationState] = useState<'checking' | 'none' | 'confirmed' | 'unverified'>('checking');
  const [checkingDirectory, setCheckingDirectory] = useState(false), [clock, setClock] = useState(Date.now());
  const identityEpoch = useRef(0);
  const mounted = useRef(true), working = useRef(false), enabled = useRef(false), hadActive = useRef(false), polling = useRef(false);
  const nameOf = (id?: string) => contacts.find(c => c.userId === id)?.name || '未登録の相手';
  const refresh = useCallback(async () => {
    if (!enabled.current || polling.current) return;
    polling.current = true;
    setCheckingDirectory(true);
    const epoch = identityEpoch.current;
    try {
      const book = await localBook.get();
      if (book.enrollment) { if (await receiveEnrollment()) { setNotice('端末を追加しました。電話帳も暗号化して引き継ぎました。'); setEnrolling(false); setLink(''); } else { setEnrolling(true); return; } }
      const me = await getIdentity();
      if (!mounted.current || epoch !== identityEpoch.current) return;
      if (!me) { setDirectory(undefined); setContacts([]); setPairs([]); setRegistrationState('none'); return; }
      const value = await identityApi('contacts', 'status'), local = await localBook.get();
      const pending = (await Promise.all(value.exchanges.map(exchangeDetails))).filter((x): x is Pending => !!x);
      const current = await getIdentity();
      if (mounted.current && epoch === identityEpoch.current && current?.deviceId === me.deviceId && current?.userId === me.userId) { setDirectory(value); setContacts(local.contacts); setPairs(pending); setRegistrationState('confirmed'); }
    } catch (e) {
      if (mounted.current && epoch === identityEpoch.current) {
        setError((e as Error).message); setRegistrationState('unverified');
        if ([401, 403].includes((e as { status?: number }).status || 0)) setDirectory(undefined);
        try { const latest = await localBook.get(); if (epoch === identityEpoch.current) setEnrolling(!!latest.enrollment); }
        catch (storageError) { if (epoch === identityEpoch.current) { setDirectory(undefined); setStorage('unavailable'); setStorageMessage(storageFailure(storageError)); } }
      }
    }
    finally { polling.current = false; if (mounted.current) setCheckingDirectory(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const epoch = identityEpoch.current;
    void probeIdentityStorage().then(async () => {
      const book = await localBook.get(), me = await getIdentity();
      if (mounted.current && epoch === identityEpoch.current) { setStorage('ready'); setName(book.name); setContacts(book.contacts); setEnrolling(!!book.enrollment); setRegistrationState(previous => previous === 'confirmed' ? previous : me ? 'unverified' : 'none'); }
    }).catch(e => { if (mounted.current) { setStorage('unavailable'); setStorageMessage(storageFailure(e)); setDirectory(undefined); setRegistrationState('unverified'); } });
    void identityApi<Health>('contacts', 'health').then(h => { if (mounted.current) { enabled.current = h.enabled; setHealth(h); if (h.enabled) void refresh(); } }).catch(e => setError(e.message));
    const hash = () => { const f = new URLSearchParams(location.hash.slice(1)); if (f.has('contact') || f.has('device')) { setFragment(f); history.replaceState(null, '', location.pathname + location.search); } };
    if (fragment.has('contact') || fragment.has('device')) history.replaceState(null, '', location.pathname + location.search);
    const poll = () => { if (document.visibilityState === 'visible' && !working.current) void refresh(); };
    const timer = setInterval(poll, 3000);
    window.addEventListener('hashchange', hash); document.addEventListener('visibilitychange', poll); navigator.serviceWorker?.addEventListener('message', poll);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('hashchange', hash); document.removeEventListener('visibilitychange', poll); navigator.serviceWorker?.removeEventListener('message', poll); };
  }, [refresh]);
  useEffect(() => { let cancelled = false; if (link) void QRCode.toDataURL(link, { width: 280, margin: 2, errorCorrectionLevel: 'L' }).then(x => { if (!cancelled) setQr(x); }).catch(() => setQr('')); else setQr(''); return () => { cancelled = true; }; }, [link]);
  useEffect(() => { if (!link) return; setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [link]);
  const run = async (fn: () => Promise<unknown>) => {
    if (working.current) return; working.current = true; setBusy(true); onBusy?.(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); onBusy?.(false); await refresh(); }
  };
  const saveName = async () => { const book = await localBook.get(); book.name = name.trim().slice(0, 40); if (!book.name) throw new Error('表示名を入力してください'); await localBook.put(book); };
  const reset = async () => {
    if (polling.current) throw new Error('登録状態を確認中です。確認が終わってから初期化してください。');
    identityEpoch.current++;
    await resetLocalIdentity();
    setDirectory(undefined); setRegistrationState('none'); setContacts([]); setPairs([]); setName(''); setLink(''); setQr(''); setEnrolling(false); setChecked({}); setFragment(new URLSearchParams());
    setNotice('この起動場所の本人情報と電話帳を初期化しました。録音は残しています。Safariや別の起動場所の情報は変更していません。');
  };
  const recheck = async () => {
    try { await probeIdentityStorage(); setStorage('ready'); setStorageMessage(''); }
    catch (e) { setStorage('unavailable'); setStorageMessage(storageFailure(e)); return; }
    await refresh();
  };
  const incoming = directory?.calls.find(c => c.callee === directory.self && c.state === 'ringing' && c.expiresAt > Date.now());
  const current = directory?.calls.find(c => c.id === ringId) || directory?.calls.find(c => ['preparing', 'ringing', 'accepted'].includes(c.state) && [c.callerDevice, c.answeredBy].includes(directory.deviceId));
  const ownsCurrent = !!current && [current.callerDevice, current.answeredBy].includes(directory?.deviceId);
  useEffect(() => {
    setReadyIncoming(''); let cancelled = false;
    if (incoming) void verifyIncoming(incoming).then(() => { if (!cancelled) setReadyIncoming(incoming.id); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [incoming?.id]);
  useEffect(() => { if (active && readyIncoming && readyIncoming !== ringId) void identityApi('incoming', 'busy', { id: readyIncoming }).then(refresh).catch(() => {}); }, [active, readyIncoming, ringId, refresh]);
  useEffect(() => {
    if (!readyIncoming || active) return;
    ringOnce(); const timer = setInterval(() => { if (document.visibilityState === 'visible' && incoming && incoming.expiresAt > Date.now()) ringOnce(); }, 3000);
    return () => clearInterval(timer);
  }, [readyIncoming, active]);
  useEffect(() => {
    if (active) hadActive.current = !!ringId;
    else if (hadActive.current) { hadActive.current = false; void identityApi('incoming', 'finish', { id: ringId }).then(refresh).catch(e => setError(e.message)); }
  }, [active, ringId, refresh]);
  useEffect(() => { if (active && current && ['declined', 'busy', 'cancelled', 'expired', 'completed'].includes(current.state)) window.dispatchEvent(new CustomEvent('ippo-ring-ended', { detail: { room: current.room } })); }, [active, current?.state]);
  const place = (contact: Contact) => run(async () => {
    await armRingtone().catch(() => {}); const id = crypto.randomUUID(); setRingId(id);
    try { const r = await identityApi<RingResult>('incoming', 'ring', { id, userId: contact.userId }); await refresh(); await start('create', r.credentials); }
    catch (e) { await identityApi('incoming', 'finish', { id }).catch(() => {}); throw e; }
  });
  const answer = () => run(async () => {
    if (!incoming || incoming.id !== readyIncoming) throw new Error('着信を確認してください');
    await verifyIncoming(incoming); await armRingtone().catch(() => {});
    const id = incoming.id; setRingId(id);
    // A losing device must never finish the winning device's call.
    const r = await identityApi<{ credentials: Credentials }>('incoming', 'accept', { id });
    try { await start('join', r.credentials); } catch (e) { await identityApi('incoming', 'finish', { id }).catch(() => {}); throw e; }
  });
  const importLink = () => {
    try { const u = new URL(pasted.trim()); if (u.origin !== new URL(import.meta.env.VITE_API_BASE_URL || location.origin).origin) throw new Error('このアプリのリンクを入力してください'); const f = new URLSearchParams(u.hash.slice(1)); if (!f.has('contact') && !f.has('device')) throw new Error('登録リンクを入力してください'); setFragment(f); setPasted(''); } catch (e) { setError((e as Error).message); }
  };
  const deviceRequest = fragment.get('device');
  let linkExpiresAt: number | undefined;
  if (link) { try { const f = new URLSearchParams(link.split('#')[1]); linkExpiresAt = readCard(f.get('contact') || f.get('device') || '').expiresAt; } catch { /* Old links may have no expiry metadata. */ } }
  const linkExpired = !!linkExpiresAt && clock >= linkExpiresAt;
  let deviceCode = ''; if (deviceRequest) { try { deviceCode = readCard(deviceRequest).key.slice(-12); } catch { deviceCode = '無効なリンク'; } }
  if (active) return current?.state === 'ringing' ? <section className="content-card team-call-state">応答を待っています<button className="text-button" disabled={busy} onClick={() => void run(() => identityApi('incoming', 'cancel', { id: current.id }))}>呼び出しを取り消す</button></section> : null;
  if (!showMembers && !incoming) return null;
  return <section className="team-calls identity-calls content-card" aria-label="端末の電話帳">
    <div className="section-header"><div><span className="eyebrow">YOUR CONTACTS</span><h2>登録した相手に連絡する</h2></div></div>
    <div className="identity-diagnostics" aria-label="この画面の保存・登録状況">
      <h3>この画面の保存・登録状況</h3>
      <p>本人情報・電話帳の保存領域：{storage === 'checking' ? '確認中' : storage === 'ready' ? '読み書き確認済み' : storageMessage}</p>
      <p>本人登録：{registrationState === 'checking' ? '確認中' : registrationState === 'none' ? 'この起動場所には本人情報がありません。他の起動場所での登録状況は分かりません。' : registrationState === 'confirmed' ? 'この画面の本人情報でサーバー登録を確認済み' : 'サーバー側の登録を確認できていません。未登録とは断定していません。'}</p>
      {directory && <p>この起動場所の識別番号：{directory.deviceId.slice(-12)} ／ 登録した相手：{contacts.filter(c => c.confirmed).length}人</p>}
      <p>Safari・ホーム画面アプリ・メッセージアプリ内では保存先が分かれることがあります。他の起動場所の保存先には直接アクセスできません。</p>
      <button className="button secondary" disabled={busy} onClick={() => void run(recheck)}>保存と登録の状態を再確認</button>
    </div>
    {!health?.enabled && <p className="fineprint">連絡先からの呼び出しは準備中です。下の招待リンク方式で通話できます。</p>}
    {error && <p className="modal-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {health?.enabled && storage === 'ready' && <>
      {!health.pushConfigured && <p className="fineprint">通知は未設定です。相手がアプリを開いている場合だけ着信を確認できます。</p>}
      <label>自分の表示名（今開いている場所に保存）<input maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="相手に伝える名前" /></label>
      {directory ? <button className="text-button" disabled={busy} onClick={() => void run(saveName)}>表示名を保存</button> : registrationState !== 'checking' && !enrolling && !deviceRequest && !fragment.has('contact') && <div className="team-setup"><label>初回登録の合言葉<input type="password" autoComplete="off" value={accessCode} onChange={e => setAccessCode(e.target.value)} /></label><button className="button primary" disabled={busy || !name.trim() || !accessCode} onClick={() => void run(async () => { await saveName(); await prepareIdentity(); setDirectory(await identityApi('contacts', 'register', { accessCode })); setAccessCode(''); })}>新しい利用者として登録</button><button className="button secondary" disabled={busy} onClick={() => void run(async () => { setLink(await createEnrollment()); setEnrolling(true); setNotice('追加用リンクを作りました。登録済みのSafari・ホーム画面アプリ・別端末で開き、端末キーを照合して承認してください。'); })}>別の起動場所・端末から本人情報を引き継ぐ</button></div>}
      {fragment.has('contact') && <div className="info-box"><p>LINEで届いた相手登録リンクです。自分の表示名を入力して進んでください。</p><button className="button primary" disabled={busy || !name.trim()} onClick={() => void run(async () => { await saveName(); setDirectory(await claimContact(fragment.get('contact')!)); setFragment(new URLSearchParams()); setNotice('双方の画面に出る確認コードをLINEで照合してください。まだ呼び出せません。'); })}>連絡先の交換を進める</button></div>}
      {deviceRequest && <div className="info-box"><p>自分の追加端末ですか？ 追加端末に表示された端末キー末尾 <strong>{deviceCode}</strong> と一致することを確認してください。他人から届いた端末追加リンクは承認しないでください。</p><label className="team-check"><input type="checkbox" checked={!!checked.device} onChange={e => setChecked({ ...checked, device: e.target.checked })} />自分の端末で、キーも一致しています</label><button className="button primary" disabled={busy || !directory || !checked.device} onClick={() => void run(async () => { await approveEnrollment(deviceRequest); setFragment(new URLSearchParams()); setNotice('追加端末を承認しました。追加端末の画面で登録完了を確認してください。'); })}>自分の端末として承認</button></div>}
      {pairs.filter(p => !directory?.contacts.some(c => c.userId === p.userId)).map(p => <div className="team-pending" key={p.id}><strong>{p.name}との確認コード：{p.code}</strong><p>LINEの個別トークで、このコードが双方の画面で一致することを確認してください。</p><label className="team-check"><input type="checkbox" checked={!!checked[p.id]} onChange={e => setChecked({ ...checked, [p.id]: e.target.checked })} />LINEで相手とコードの一致を確認した</label><button className="button secondary" disabled={busy || p.mine || !checked[p.id]} onClick={() => void run(async () => setDirectory(await approveContact(directory!.exchanges.find(x => x.id === p.id)!)))}>{p.mine ? '相手の承認を待っています' : '確認して相手を登録'}</button></div>)}
      {incoming && <div className="team-incoming" role="alert"><h3>{nameOf(incoming.caller)}から着信</h3><p>応答した1台だけが通話します。録音は別途同意が必要です。</p><button className="button primary" disabled={busy || readyIncoming !== incoming.id} onClick={answer}>応答する</button><button className="button secondary" disabled={busy} onClick={() => void run(() => identityApi('incoming', 'decline', { id: incoming.id }))}>断る</button></div>}
      {current && <p role="status">{current.state === 'accepted' && !ownsCurrent ? '別の端末で応答しました' : labels[current.state]}{current.state === 'accepted' && !active && ownsCurrent && <button className="text-button" onClick={() => void run(() => identityApi('incoming', 'finish', { id: current.id }))}>前の通話を終了する</button>}{['preparing', 'ringing'].includes(current.state) && ownsCurrent && <button className="text-button" disabled={busy} onClick={() => void run(() => identityApi('incoming', 'cancel', { id: current.id }))}>呼び出しを取り消す</button>}</p>}
      {directory && <><div className="invitation-actions"><h3>友だちを招待・再招待する</h3><p>登録できなかった相手にも、ここから新しいリンクを作って送り直せます。電話帳の初期化は不要です。</p><button className="button primary" disabled={busy || registrationState !== 'confirmed'} onClick={() => void run(async () => { await saveName(); setLink(await makeContactLink()); setNotice('新しい招待リンクです。相手に今から開けるか確認してから、個別トークで送ってください。10分間・1人用です。'); })}>新しい招待リンクを作る・送り直す</button><ol><li>新しいリンクを作って相手に送る</li><li>相手が名前を入力して登録を進める</li><li>双方の確認コードを照合して承認する</li></ol><p>LINEやMessenger内で進まない場合は、相手にSafariなどで開いてもらうか、登録済みのホーム画面アプリの「招待リンクを貼り付ける」を案内してください。</p></div><div className="team-grid">{contacts.filter(c => c.confirmed && directory.contacts.some(x => x.userId === c.userId)).map((c, i) => <div className="team-member" key={c.userId}><button disabled={busy} onClick={() => void place(c)}><span className="team-avatar">{c.name.slice(0, 1)}</span><strong>{c.name}</strong><small>この相手だけを呼び出す</small></button><button className="text-button" disabled={busy} onClick={() => void run(async () => { const value = prompt('この端末に表示する名前', c.name); if (value?.trim()) { const book = await localBook.get(); book.contacts.find(x => x.userId === c.userId)!.name = value.trim().slice(0, 40); await localBook.put(book); } })}>名前を変更</button>{i > 0 && <button className="text-button" disabled={busy} onClick={() => void run(async () => { const book = await localBook.get(), n = book.contacts.findIndex(x => x.userId === c.userId); [book.contacts[n - 1], book.contacts[n]] = [book.contacts[n], book.contacts[n - 1]]; await localBook.put(book); })}>上に移動</button>}<button className="text-button" disabled={busy} onClick={() => { if (confirm(`${c.name}との呼び出し許可を解除しますか？`)) void run(async () => { await identityApi('contacts', 'remove', { userId: c.userId }); const book = await localBook.get(); book.contacts = book.contacts.filter(x => x.userId !== c.userId); await localBook.put(book); }); }}>登録解除</button></div>)}</div>

      <div className="team-notifications"><span>この端末の通知：{directory.notifications ? '登録済み' : '未登録'}</span><button className="button secondary" disabled={busy || !health.pushConfigured} onClick={() => void run(async () => { const subscribing = notifications.subscribe(health.publicKey); void armRingtone().catch(() => {}); await identityApi('contacts', 'subscribe', { subscription: await subscribing }); })}>通知を有効にする</button>{directory.notifications && <button className="text-button" disabled={busy} onClick={() => void run(async () => { await identityApi('contacts', 'subscribe', { subscription: null }); await notifications.unsubscribe(); })}>通知を停止</button>}</div>
      <details><summary>自分の登録端末（{directory.devices.length}台）</summary>{directory.devices.map(d => <p key={d.id}>端末 {d.id.slice(-12)}{d.id === directory.deviceId ? '（この端末）' : ''}<button className="text-button" disabled={busy} onClick={() => { if (confirm('この端末と、この端末から追加した端末の権限を解除しますか？録音は削除しません。')) void run(async () => { await identityApi('contacts', 'revoke', { deviceId: d.id }); if (d.id === directory.deviceId) setDirectory(undefined); }); }}>端末を解除</button></p>)}</details></>}
      {link && <div className="team-link"><h3>{enrolling ? '本人情報を引き継ぐリンク' : '相手へ送る新しい招待リンク'}</h3><p role="status">{linkExpiresAt ? linkExpired ? 'このリンクは表示上の期限を過ぎました。新しいリンクを作って送り直してください。' : `有効期限：${new Date(linkExpiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}（端末の時刻表示）・残り約${Math.ceil((linkExpiresAt - clock) / 60000)}分` : '期限を取得できません。この表示だけでリンクが有効とは断定できません。'}</p><label>登録リンク<input readOnly value={link} onFocus={e => e.target.select()} /></label>{qr && <img width="280" height="280" style={{ maxWidth: '100%', height: 'auto' }} src={qr} alt="登録リンクのQRコード" />}{enrolling && <p>追加端末キー末尾：{(() => { try { return readCard(new URLSearchParams(link.split('#')[1]).get('device')!).key.slice(-12); } catch { return ''; } })()}</p>}<button className="button secondary" disabled={busy || linkExpired} onClick={() => void run(async () => { await navigator.clipboard.writeText(link); setNotice('リンクをコピーしました。'); })}>リンクをコピー</button>{!enrolling && !linkExpired && typeof navigator.share === 'function' && <button className="button secondary" onClick={() => void navigator.share({ title: '一歩の記録', text: '通話アプリの連絡先登録をお願いします。', url: link }).catch(() => {})}>LINEなどで送る</button>}</div>}
      <details className="invitation-import"><summary>招待リンクを受け取った・貼り付ける</summary><p>iPhoneでホーム画面のアプリへ登録するときは、LINEからリンクをコピーし、ここへ貼り付けられます。</p><label>登録リンク<input value={pasted} onChange={e => setPasted(e.target.value)} /></label><button className="button secondary" disabled={!pasted || busy} onClick={importLink}>登録リンクを開く</button></details>
      <details className="identity-advanced"><summary>詳しい操作・初期化（最終手段）</summary><p>再招待やアプリの更新のために初期化する必要はありません。Safariとホーム画面アプリでは、初期化する範囲も別です。</p><p>この端末の電話帳と認証鍵を削除して、新しい利用者として登録し直します。録音は削除しません。相手との連絡先交換はやり直しになります。紛失端末の権限は別の登録済み端末から解除してください。</p><button className="button danger" disabled={busy || checkingDirectory} onClick={() => { if (confirm('今開いている場所の電話帳と認証鍵を削除しますか？相手との再登録が必要になります。録音は残ります。')) void run(reset); }}>この起動場所の電話帳と認証鍵を初期化</button></details>
      <p className="fineprint">名前と電話帳、秘密鍵は今開いている場所の保存領域に保管します。別の起動場所との常時同期はありません。iPhoneの通知はホーム画面に追加したアプリで許可してください。消音・集中モードや通信状態により通知が届かない場合があります。</p>
    </>}
  </section>;
}
