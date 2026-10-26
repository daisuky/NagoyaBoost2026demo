// Web implementation; native delivery will add an APNs/FCM adapter and server transport.
export interface NotificationAdapter {
  supported(): boolean;
  subscribe(publicKey: string): Promise<PushSubscriptionJSON>;
  unsubscribe(): Promise<void>;
}
async function readyRegistration() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<ServiceWorkerRegistration>((_, reject) => { timer = setTimeout(() => reject(new Error('通知の準備ができていません。公開アプリを再読み込みしてください。ローカルでは本番ビルドのプレビューを使ってください。')), 8000); })
    ]);
  } finally { clearTimeout(timer); }
}
export const notifications: NotificationAdapter = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  async subscribe(publicKey) {
    if (!this.supported()) throw new Error('iPhoneではホーム画面に追加し、追加したアプリから通知を有効にしてください');
    if (await Notification.requestPermission() !== 'granted') throw new Error('通知が許可されていません。端末の通知設定を確認してください');
    const registration = await readyRegistration();
    let existing = await registration.pushManager.getSubscription();
    const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const currentKey = existing?.options.applicationServerKey;
    if (existing && (!currentKey || !bytes.every((b, i) => new Uint8Array(currentKey)[i] === b) || currentKey.byteLength !== bytes.length)) { await existing.unsubscribe(); existing = null; }
    const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    return subscription.toJSON();
  },
  async unsubscribe() {
    if (!this.supported()) return;
    const registration = await readyRegistration();
    await (await registration.pushManager.getSubscription())?.unsubscribe();
  }
};
let audio: AudioContext | undefined;
export async function armRingtone() {
  audio ||= new AudioContext(); await audio.resume();
}
export function ringOnce() {
  if (!audio || audio.state !== 'running') return;
  for (let i = 0; i < 2; i++) {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    const at = audio.currentTime + i * 0.24;
    oscillator.frequency.value = 660; gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.035, at + 0.02); gain.gain.linearRampToValueAtTime(0, at + 0.16);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(at); oscillator.stop(at + 0.18);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
