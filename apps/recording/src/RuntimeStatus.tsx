import { useEffect, useRef, useState } from 'react';
import { launchContext } from './core/environment.mjs';
declare const __APP_BUILD__: string;
const versionUrl = () => `/version.json?check=${Date.now()}-${Math.random().toString(36).slice(2)}`;
const buildLabel = (value: string) => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });

export function RuntimeStatus({ busy }: { busy: boolean }) {
  const [latest, setLatest] = useState(''), [message, setMessage] = useState(''), [checking, setChecking] = useState(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const launch = launchContext(navigator.userAgent, standalone);
  async function check() {
    setChecking(true);
    try {
      if (import.meta.env.DEV) { setMessage('開発用画面です。本番の更新状況とは別です。'); return; }
      const response = await fetch(versionUrl(), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('version unavailable');
      const value = await response.json();
      if (typeof value.build !== 'string' || !Number.isFinite(Date.parse(value.build))) throw new Error('invalid version');
      setLatest(value.build); setMessage(value.build === __APP_BUILD__ ? 'この画面は最新版です。' : '新しい版があります。通話や送信をしていないときに更新してください。');
    } catch { setLatest(''); setMessage('最新版を確認できません。通信が戻ってから再確認してください。'); }
    finally { setChecking(false); }
  }
  useEffect(() => { void check(); }, []);
  async function update() {
    if (busy) return;
    setChecking(true); setMessage('データを消さずに更新を確認しています…');
    try {
      const response = await fetch(versionUrl(), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('version unavailable');
      const value = await response.json(); if (typeof value.build !== 'string' || !Number.isFinite(Date.parse(value.build))) throw new Error('invalid version');
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.update();
        if (registration.installing) await new Promise<void>((resolve, reject) => {
          const worker = registration.installing!;
          const timeout = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('install timeout')); }, 15000);
          const changed = () => { if (['installed', 'activated', 'redundant'].includes(worker.state)) { clearTimeout(timeout); worker.removeEventListener('statechange', changed); worker.state === 'redundant' ? reject(new Error('install failed')) : resolve(); } };
          worker.addEventListener('statechange', changed); changed();
        });
        if (busyRef.current) throw new Error('call became busy');
        if (registration.waiting) await new Promise<void>((resolve, reject) => {
          const worker = registration.waiting!;
          const timeout = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('activation timeout')); }, 10000);
          const changed = () => { if (worker.state === 'activated') { clearTimeout(timeout); worker.removeEventListener('statechange', changed); resolve(); } };
          worker.addEventListener('statechange', changed); worker.postMessage({ type: 'ACTIVATE_UPDATE' }); changed();
        });
      }
      if (busyRef.current) throw new Error('call became busy');
      window.location.reload();
    } catch { setMessage('更新できませんでした。登録情報や録音は削除していません。通信を確認して再試行してください。'); setChecking(false); }
  }
  return <section className="runtime-status" aria-label="起動・更新状況">
    <strong>開いている場所：{launch.label}</strong>
    <p>{window.isSecureContext ? '安全な接続で開いています。' : '安全な接続ではありません。HTTPSのURLで開いてください。'} マイク：{typeof navigator.mediaDevices?.getUserMedia === 'function' ? '対応機能あり（許可と音声は通話前に確認）' : 'この起動場所では利用できません'}</p>
    <p>表示中の版（日本時間）：<time dateTime={__APP_BUILD__}>{buildLabel(__APP_BUILD__)}</time>{latest && latest !== __APP_BUILD__ && <> ／ 配信中：<time dateTime={latest}>{buildLabel(latest)}</time></>}</p>
    <p role="status">{message || '最新版を確認中…'}</p>
    <div className="runtime-actions"><button className="button secondary" disabled={checking} onClick={() => void check()}>最新版を確認</button><button className="button secondary" disabled={busy || checking} onClick={() => void update()}>データを残して更新・再読み込み</button></div>
    {busy && <p>通話・録音・送信などの操作中は再読み込みできません。</p>}
    {launch.embedded && <p>アプリ内の画面かもしれません。登録や通話が進まない場合は、メニューの「Safariで開く」などを使ってください。名前だけで動作不可とは判定していません。</p>}
  </section>;
}
