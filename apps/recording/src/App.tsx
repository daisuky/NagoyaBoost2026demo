import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CallController, View } from './adapters/call';
import { store } from './adapters/storage';
import { archive, manifest } from './adapters/drive';
import { api } from './core/api';
import type { Recording } from './core/types';
import type { Credentials } from './core/types';
import { TeamCalls } from './TeamCalls';
import { createAutoArchive } from './core/auto-archive.mjs';

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />, arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    phone: <path d="M8 3H4a1 1 0 0 0-1 1c0 9 8 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a15 15 0 0 1-6-6l2-2-2-5Z" />,
    record: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></>,
    folder: <path d="M3 7V5h6l2 2h10v13H3V7Z" />, settings: <><path d="M4 7h16M4 17h16" /><circle cx="8" cy="7" r="3" fill="currentColor" /><circle cx="16" cy="17" r="3" fill="currentColor" /></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    shield: <><path d="m12 2 8 4v6c0 5-8 9-8 9s-8-4-8-9V6l8-4Z" /><path d="m8 11 3 3 5-5" /></>,
    cloud: <path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11M12 21V11m-4 4 4-4 4 4" />,
    check: <path d="m5 12 4 4L19 6" />, close: <path d="m6 6 12 12M6 18 18 6" />,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
    book: <><path d="M12 5c-3-2-6-2-10 0v15c4-2 7-2 10 0 3-2 6-2 10 0V5c-4-2-7-2-10 0ZM12 5v15" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.record}</svg>;
}
const formatDate = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
type Health = { configured: boolean; archiveConfigured: boolean; archiveLabel: string };

export function App() {
  const [tab, setTab] = useState('home');
  const [records, setRecords] = useState<Recording[]>([]);
  const [health, setHealth] = useState<Health>();
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState(''), [title, setTitle] = useState('今日の対話'), [accessCode, setAccessCode] = useState('');
  const [invite, setInvite] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invite') || '');
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(''), [uploadStatus, setUploadStatus] = useState('');
  const [view, setView] = useState<View>({ connection: 'disconnected', muted: false, speaking: [] });
  const [mic, setMic] = useState(false), [micLevel, setMicLevel] = useState(0);
  const [now, setNow] = useState(Date.now());
  const controller = useRef<CallController | null>(null), sending = useRef(false), mounted = useRef(true);
  const uploads = useRef<ReturnType<typeof createAutoArchive> | null>(null);
  const micStop = useRef<() => void>(() => {});
  const reload = async () => { const list = await store.list(); if (mounted.current) setRecords(list); };
  if (!uploads.current) uploads.current = createAutoArchive({
    store, upload: archive.upload,
    onBusy: (value: boolean) => { sending.current = value; },
    onProgress: (id: string, text: string) => { if (mounted.current) { setUploading(id); setUploadStatus(text); } },
    onSaved: () => { if (mounted.current) setNotice('収集用Driveへの保存が完了しました。端末のコピーも保持しています。'); },
    onError: (message: string) => { if (mounted.current) setError(message); },
    onChange: () => { if (mounted.current) void reload().catch(e => setError(e.message)); }
  });
  const send = (recording: Recording, manual = false) => uploads.current!.enqueue(recording, manual);
  const retryUploads = (force = false) => {
    if (navigator.onLine !== false) void uploads.current!.retryPending(force).catch(e => { if (mounted.current) setError(e.message); });
  };
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const list = await store.list();
      for (const recording of list.filter(r => r.state === 'recording')) { recording.state = 'interrupted'; recording.events.push({ at: new Date().toISOString(), reason: 'recovered-after-reload' }); await store.put(recording); }
      await reload();
      retryUploads(true);
    })().catch(e => setError(`端末の保存領域を開けません。${e.message}`));
    void api<Health>('health').then(setHealth).catch(() => setError('サーバーへの接続を確認できません。設定画面から再確認できます。'));
    if (invite) { setDialog('join'); history.replaceState(null, '', location.pathname); }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const hide = () => { const visible = document.visibilityState === 'visible'; if (!visible) micStop.current(); else retryUploads(); void controller.current?.visibility(visible).catch(e => setError(e.message)); };
    const online = () => retryUploads(true);
    const retryTimer = setInterval(() => { if (document.visibilityState === 'visible') retryUploads(); }, 30000);
    window.addEventListener('online', online);
    const before = (e: BeforeUnloadEvent) => { if ((controller.current && !controller.current.closed) || controller.current?.recording?.state === 'recording' || sending.current) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('visibilitychange', hide); window.addEventListener('beforeunload', before);
    const ringEnded = (event: Event) => { if ((event as CustomEvent).detail?.room === controller.current?.credentials?.room) void controller.current?.leave(true); };
    window.addEventListener('ippo-ring-ended', ringEnded);
    return () => { mounted.current = false; clearInterval(timer); clearInterval(retryTimer); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', hide); window.removeEventListener('beforeunload', before); window.removeEventListener('ippo-ring-ended', ringEnded); micStop.current(); void controller.current?.leave(false); };
  }, []);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const connect = () => run(async () => {
    micStop.current();
    if (controller.current) await controller.current.leave(false);
    const { CallController } = await import('./adapters/call');
    const call = controller.current = new CallController(setView, setError, () => { if (call.recording?.state === 'local') void send(call.recording); else void reload(); });
    const code = invite.includes('#') ? new URLSearchParams(invite.split('#')[1]).get('invite') || '' : invite.trim();
    await call.connect(dialog!, { name, accessCode, invite: code }); setDialog(null); setAccessCode(''); setTab('home');
  });
  const connected = !!view.credentials && !controller.current?.closed;
  const startTeamCall = async (role: 'create' | 'join', credentials: Credentials) => {
    if (controller.current && !controller.current.closed) throw new Error('現在の通話を終了してから呼び出してください');
    setView({ connection: 'connecting', muted: false, speaking: [] });
    micStop.current();
    const { CallController } = await import('./adapters/call');
    const call = controller.current = new CallController(setView, setError, () => { if (call.recording?.state === 'local') void send(call.recording); else void reload(); });
    setTab('home'); setDialog(null);
    await call.connect(role, {}, credentials);
  };
  const host = view.credentials?.role === 'host';
  const self = view.status?.participants.find(p => p.identity === view.credentials?.role);
  const elapsed = view.recordingId ? Math.max(0, Math.floor((now - Date.parse(controller.current?.recording?.createdAt || new Date().toISOString())) / 1000)) : 0;
  const inviteUrl = view.credentials?.invite ? `${(import.meta.env.VITE_API_BASE_URL || location.origin).replace(/\/$/, '')}/#invite=${view.credentials.invite}` : '';
  const testMic = () => run(async () => {
    if (mic) { micStop.current(); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
    const context = new AudioContext(), source = context.createMediaStreamSource(stream), analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    let frame = 0; setMic(true);
    const update = () => { const values = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(values); setMicLevel(Math.min(100, values.reduce((a, b) => a + b, 0) / values.length * 1.8)); frame = requestAnimationFrame(update); }; update();
    micStop.current = () => { cancelAnimationFrame(frame); stream.getTracks().forEach(t => t.stop()); void context.close(); setMic(false); setMicLevel(0); };
  });
  const statusLabel = (r: Recording) => r.state === 'saved' ? 'Drive保存済み' : r.state === 'recording' ? '録音中' : r.upload?.state === 'blocked' ? 'Drive未送信・保存権限を確認' : r.upload?.state === 'failed' ? 'Drive未送信・自動再送待ち' : r.state === 'interrupted' ? '中断・音声を確認' : '端末保存済み・Drive送信待ち';
  const audioSize = (r: Recording) => r.audioBytes === undefined ? '' : r.audioBytes < 1000000 ? `${Math.round(r.audioBytes / 1000)} KB` : `${(r.audioBytes / 1000000).toFixed(1)} MB`;
  const recordList = (limit?: number) => <div className="record-list">{records.length === 0 ? <div className="empty"><span className="empty-icon"><Icon name="folder" size={27} /></span><strong>ここから、対話が積み重なっていく。</strong><p>録音した対話がここに並びます。<br />まずは、最初の通話を始めてみましょう。</p></div> : records.slice(0, limit).map(recording => <article className="record-row" key={recording.id}>
    <span className="file-symbol"><Icon name="record" size={22} /></span><div className="record-copy"><h3>{recording.title}</h3><p>{formatDate(recording.createdAt)}<span>·</span>{recording.tracks.map(t => t.speakerName).join(' / ')}{audioSize(recording) && <><span>·</span>{audioSize(recording)}（2人分）</>}</p><span className={`small-state ${recording.state === 'saved' ? 'good' : 'pending'}`}>{uploading === recording.id ? uploadStatus || '送信準備中…' : statusLabel(recording)}</span></div>
    <div className="record-actions"><button className="icon-button" title="音声と記録情報をダウンロード" aria-label={`${recording.title}をダウンロード`} disabled={recording.state === 'recording'} onClick={() => void run(async () => { for (const track of recording.tracks) download(await store.audio(recording, track.id), `${recording.id}_${track.speakerId}.${recording.mimeType.includes('mp4') ? 'm4a' : 'webm'}`); download(new Blob([JSON.stringify(manifest(recording), null, 2)], { type: 'application/json' }), `${recording.id}_session.json`); })}><Icon name="download" /></button>
    {recording.state !== 'saved' && recording.state !== 'recording' && <button className="text-button" disabled={!!uploading} onClick={() => void send(recording, true)}>Driveへ送信</button>}
    {recording.state !== 'recording' && <button className="icon-button" title="端末の記録を削除" aria-label={`${recording.title}の端末コピーを削除`} disabled={!!uploading} onClick={() => { if (confirm('この端末の音声と記録を削除します。Drive保存済みの原本は残ります。未送信の音声は復元できません。削除しますか？')) void run(async () => { await store.remove(recording.id); await reload(); }); }}><Icon name="trash" size={17} /></button>}</div>
  </article>)}</div>;

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('home'); }}><img src="/icon.svg" alt="" /><span>一歩の記録<small>IPPO RECORDING SESSION</small></span></a><div className="workspace-label">対話のワークスペース</div><nav aria-label="メインメニュー">{[['home','phone','対話をはじめる'],['records','folder','対話の記録'],['guide','book','使い方'],['settings','settings','接続設定']].map(([id, icon, label]) => <button key={id} onClick={() => setTab(id)} className={tab === id ? 'nav-item selected' : 'nav-item'}><Icon name={icon} /><span>{label}</span>{id === 'records' && <small>{records.length}</small>}</button>)}</nav><div className="sidebar-note"><div className="note-mark">“</div><p>話すことで、<br />見えてくる一歩がある。</p><span>一つひとつの対話を、大切に。</span></div><div className="sidebar-bottom"><span className="version-dot" />PWA 初期版 <span>v0.2</span></div></aside>
    <div className="main-shell"><header className="topbar"><span>ワークスペース <span className="breadcrumb">/</span> <strong>{tab === 'home' ? '対話をはじめる' : tab === 'records' ? '対話の記録' : tab === 'guide' ? '使い方' : '接続設定'}</strong></span><span className={`connection-pill ${health?.archiveConfigured ? '' : 'not-ready'}`}><span />{health?.archiveConfigured ? '収集用Drive 接続済み' : '収集用Drive 未接続'}</span></header>
    <main><div className="page-heading"><div><p className="eyebrow">{tab === 'home' ? 'A SMALL STEP, THROUGH CONVERSATION' : 'YOUR CONVERSATION WORKSPACE'}</p><h1>{tab === 'home' ? <>対話を、明日の一歩に<span>。</span></> : tab === 'records' ? '積み重ねた、対話の記録。' : tab === 'guide' ? 'はじめての、一歩。' : '収集の準備を整える。'}</h1><p className="page-sub">{tab === 'home' ? '大切な話を、安心して話せる場所。二人の対話を、そのまま記録します。' : tab === 'records' ? 'この端末で録音した対話を振り返り、収集用Driveへ送信できます。' : tab === 'guide' ? '招待から保存まで。通話する二人で、確認しておきたいこと。' : '利用者のGoogleログインは不要。収集担当者が保存先を接続します。'}</p></div><span className="edition">HUMAN TO HUMAN<br /><strong>声から、はじめる。</strong></span></div>
    {error && <div className="alert" role="alert"><span>{error}</span><button className="icon-button" aria-label="エラーを閉じる" onClick={() => setError('')}><Icon name="close" size={18} /></button></div>}
    <TeamCalls active={connected} showMembers={tab === 'home'} start={startTeamCall} />
    {!connected && view.message && <div className="notice" role="status"><span>{view.message}</span></div>}
    {notice && <div className="notice" role="status"><Icon name="check" size={18} /><span>{notice}</span><button className="icon-button" aria-label="通知を閉じる" onClick={() => setNotice('')}><Icon name="close" size={18} /></button></div>}
    {uploading && <div className="notice" role="status"><Icon name="cloud" /><span>録音を端末に保存し、Driveへ自動送信しています。{uploadStatus}</span></div>}
    {tab === 'home' && <>
      {connected ? <section className="call-panel"><div className="section-header"><div><span className="eyebrow">LIVE CONVERSATION</span><h2>{title}</h2></div><span className={view.status?.recording ? 'recording-tag' : 'subtle-tag'}>{view.status?.recording ? `● 録音中 ${host ? `${String(Math.floor(elapsed / 60)).padStart(2,'0')}:${String(elapsed % 60).padStart(2,'0')}` : ''}` : view.connection === 'connected' ? '通話中・録音待機' : '音声を接続しています…'}</span></div><div className="participants">{['host','guest'].map(role => { const p = view.status?.participants.find(x => x.identity === role); return <div key={role} className={`participant ${view.speaking.includes(role) ? 'speaking' : ''}`}><div className="avatar">{p?.name?.slice(0,1) || '…'}</div><h3>{p?.name || '相手の参加を待っています'}</h3><p>{role === view.credentials?.role ? 'あなた' : '通話の相手'} · {p?.consent.record ? '録音・保存に同意済み' : '同意待ち'}</p></div>; })}</div>
      {host && inviteUrl && <div className="invite-box"><span>相手に招待リンクを送ってください<small>2時間有効 · 相手の参加前は、別のアプリへ移ってリンクを送れます</small></span><button className="button secondary" onClick={() => void run(async () => { await navigator.clipboard.writeText(inviteUrl); setNotice('招待リンクをコピーしました。'); })}><Icon name="copy" size={17} />リンクをコピー</button></div>}
      <p className="fineprint">通話経路：{view.route === 'relay' ? 'Cloudflare TURN 中継' : view.route === 'direct' ? '端末間の直接接続' : '接続を確認中'}。{view.message}</p>{controller.current?.waitingSuspended && <button className="button secondary" disabled={busy} onClick={() => void run(() => controller.current!.visibility(true))}>マイクの準備を再開</button>}{!view.status?.recording && !controller.current?.waitingSuspended && <button className="button secondary" disabled={busy} onClick={() => void run(() => controller.current!.restoreCall())}>接続を確認</button>}{view.audioBlocked && <button className="button secondary" onClick={() => void controller.current?.resumeAudio()}>相手の音声を再生する</button>}<label className="consent-box"><input type="checkbox" disabled={busy} checked={self?.consent.record || false} onChange={e => void run(() => controller.current!.consent(e.target.checked))} /><span>この通話の録音と、{health?.archiveLabel || '収集チーム'}のGoogle Driveへの保存に同意します。<small>録音・保存のための同意です。AI分析・共通知識への利用許可は含みません。取り消すと録音を停止します。</small></span></label><div className="call-controls"><button className="button secondary" disabled={busy} onClick={() => void run(() => controller.current!.mute())}><Icon name="mic" />{view.muted ? 'マイクをオン' : 'マイクをオフ'}</button>{host && <button className={`button ${view.recordingId ? 'danger-soft' : 'primary'}`} disabled={busy || (!view.recordingId && !view.status?.allowed)} onClick={() => void run(() => view.recordingId ? controller.current!.stop('user') : controller.current!.start(title))}><Icon name={view.recordingId ? 'stop' : 'record'} />{view.recordingId ? '録音を止めて保存' : '双方の録音を開始'}</button>}<button className="button secondary" disabled={busy || view.route === 'relay'} onClick={() => void run(() => controller.current!.useRelay())}>中継経路を試す</button><button className="button danger" disabled={busy} onClick={() => void run(() => controller.current!.leave(true))}><Icon name="phone" />通話を終了</button></div><p className="fineprint">画面の切り替え・ロックでは録音を停止し、通話は維持を試みます。戻ったら音声を確認し、録音は手動で再開してください。</p></section>
      : <div className="start-grid"><section className="hero-card"><div className="hero-top"><span className="hero-chip"><span />ふたりで、話す。</span><span className="hero-number">01 / CONVERSATION</span></div><div className="wave-art" aria-hidden="true">{[17,29,47,34,60,86,53,39,63,96,71,44,28,52,78,58,31,48,69,44,26,37,21,15].map((h,i) => <i key={i} style={{ height: h }} />)}</div><div className="hero-copy"><h2>声を交わす。<br />気づきを残す。</h2><p>リンクひとつで、相手を招待。<br />二人の声を分けて、大切に保存します。</p></div><button className="button hero-button" onClick={() => setDialog('create')}><Icon name="plus" size={19} />新しい通話をはじめる<Icon name="arrow" size={18} /></button><div className="hero-foot"><Icon name="shield" size={15} />双方が同意してから、録音を開始。</div></section><div className="right-stack"><section className="join-card"><span className="card-icon"><Icon name="phone" size={23} /></span><h2>招待されていますか？</h2><p>相手から届いた招待リンクで、<br />同じ通話に参加できます。</p><button className="text-button" onClick={() => setDialog('join')}>招待リンクから参加する<Icon name="arrow" size={17} /></button></section><section className="mic-card"><div className="mic-heading"><span className="card-icon pale"><Icon name="mic" /></span><div><h3>話す前に、音のチェック。</h3><p>マイクが使えるか確認できます。</p></div></div>{mic && <div className="meter" role="meter" aria-label="マイク音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(micLevel)}><i style={{width:`${micLevel}%`}} /></div>}<button className="button secondary compact" disabled={busy} onClick={testMic}>{mic ? 'チェックを終了する' : 'マイクをテスト'}</button></section></div></div>}
      <div className="trust-strip"><div><Icon name="shield" size={19} /><span>同意を、何より大切に。</span></div><div><Icon name="cloud" size={19} /><span>収集チームのDriveへ保存。</span></div><div><Icon name="book" size={19} /><span>振り返りは、あとからゆっくり。</span></div></div><section className="records-section"><div className="section-header"><div><span className="eyebrow">YOUR RECENT CONVERSATIONS</span><h2>最近の対話</h2></div><button className="text-button" onClick={() => setTab('records')}>すべての記録<Icon name="arrow" size={16} /></button></div>{recordList(3)}</section>
    </>}
    {tab === 'records' && <section className="records-section standalone"><div className="section-header"><h2>この端末の記録 <span className="count">{records.length}</span></h2><span className="fineprint">端末のコピーは手動で削除するまで保持します</span></div>{recordList()}</section>}
    {tab === 'guide' && <section className="content-card"><div className="steps">{[['01','通話を作って、相手を招待。','作成者は表示名と、収集担当者から受け取った「通話作成の合言葉」を入力します。作成後に招待リンクを相手に渡します。相手は表示名だけで参加できます。Googleへのログインは不要です。'],['02','二人で同意して、録音を開始。','二人が録音と収集用Driveへの保存に同意したら、作成者が録音を開始します。話者別に音声を保存するので、イヤホンの利用をおすすめします。'],['03','録音を止めて、収集用Driveへ。','録音停止後は端末に保存し、収集担当者のDriveへ自動送信します。失敗時は「対話の記録」から再送できます。送信権限は通話作成から7日間です。'],['04','後日、Windowsで振り返る。','収集担当者がDriveから音声原本を取り込み、必要なものだけ文字起こし・人手校正します。録音だけでAI分析や共通知識化は始まりません。']].map(([n,h,p]) => <div className="step" key={n}><span>{n}</span><div><h2>{h}</h2><p>{p}</p></div></div>)}</div><div className="info-box"><h3>iPhoneでは</h3><p>Safariで公開URLを開き、共有メニューから「ホーム画面に追加」で利用できます。画面を離れると録音を停止し、通話は維持を試みます。戻ったら音声を確認してください。iPhoneでの画面ロック中の継続は実機確認が必要です。</p></div><details><summary>データの扱い・削除</summary><p>音声は作成者の端末に一時保存し、収集担当者のDriveへ送信します。Driveの閲覧権限は運用メンバーが管理します。端末の削除ボタンはDrive原本を削除しません。原本削除・保存期間・利用目的の問い合わせは、招待した収集担当者へ連絡してください。</p></details></section>}
    {tab === 'settings' && <section className="content-card"><h2>収集チームの接続状況</h2><div className="setting-row"><div><h3>音声通話</h3><p>端末間のWebRTC通話。直接つながらない場合はCloudflare TURNで中継します。</p></div><span className={`small-state ${health?.configured ? 'good' : 'pending'}`}>{health?.configured ? '設定済み' : '管理者の設定が必要'}</span></div><div className="setting-row"><div><h3>収集用Google Drive</h3><p>{health?.archiveLabel || '収集チーム'}が利用するチームの保存先。</p></div><span className={`small-state ${health?.archiveConfigured ? 'good' : 'pending'}`}>{health?.archiveConfigured ? '設定済み' : '収集担当者の接続が必要'}</span></div><p className="fineprint">設定済みの表示は接続情報の登録状況です。実際の通話・保存で接続を確認します。</p><button className="button secondary" disabled={busy} onClick={() => void run(async () => { setHealth(await api<Health>('health')); setNotice('設定状況を更新しました。'); })}>設定状況を再確認</button><div className="info-box"><h3>運用を担当する方へ</h3><p>Google連携は収集担当者が一度だけ行います。追加権限のあるチームの既存フォルダーを選んで接続します。保存先は収集メンバーだけが開ける共有範囲にしてください。設定手順はリポジトリのREADMEにあります。</p></div><h3>アプリを端末に追加</h3><p>iPhone：Safariの共有 → ホーム画面に追加。<br />PC：対応ブラウザーのアドレスバーにあるインストールを選択。</p></section>}
    <footer><span><img src="/icon.svg" alt="" />一日一歩。一つの対話から。</span><a href="/privacy.html" target="_blank" rel="noreferrer">データの扱い</a><span>IPPO RECORDING SESSION <span className="footer-dot">·</span> v0.2</span></footer></main></div>
    {dialog && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="modal"><div className="section-header"><span className="eyebrow">LET'S TALK</span><button className="icon-button" aria-label="閉じる" disabled={busy} onClick={() => setDialog(null)}><Icon name="close" /></button></div><h2 id="dialog-title">{dialog === 'create' ? '新しい対話をはじめる。' : '招待された通話に参加。'}</h2><p>Googleログインは不要です。録音中はこの画面を開いてください。</p><form onSubmit={e => { e.preventDefault(); void connect(); }}><label>あなたの表示名<input autoFocus required maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="例：だいすけ" autoComplete="nickname" /></label>{dialog === 'create' ? <><label>対話のタイトル<input maxLength={80} value={title} onChange={e => setTitle(e.target.value)} placeholder="今日の対話" /></label><label>通話作成の合言葉<input required type="password" value={accessCode} onChange={e => setAccessCode(e.target.value)} autoComplete="off" placeholder="収集担当者から受け取った合言葉" aria-describedby="access-code-help" /></label><p id="access-code-help" className="fineprint">通話を作る人だけが使う、収集チーム共通の合言葉です。収集担当者から受け取り、貼り付けてください。招待される相手には不要です。</p></> : <label>招待リンク<input required value={invite} onChange={e => setInvite(e.target.value)} placeholder="届いたリンクを貼り付け" /></label>}{!health?.configured && <div className="info-box compact-info">通話サーバーの設定が必要です。収集担当者が接続設定を完了すると利用できます。</div>}<button className="button primary full" disabled={busy || !health?.configured} type="submit"><Icon name="phone" size={18} />{busy ? '接続しています…' : dialog === 'create' ? '通話を作成する' : '通話に参加する'}</button></form>{error && <p className="modal-error" role="alert">{error}</p>}</section></div>}
  </div>;
}
