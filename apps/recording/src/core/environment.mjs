export function launchContext(userAgent = '', standalone = false) {
  if (standalone) return { label: 'ホーム画面アプリ', embedded: false };
  if (/FBAN|FBAV|FB_IAB|Messenger/i.test(userAgent)) return { label: 'Messenger・Facebook内の可能性', embedded: true };
  if (/\bLine\/|Instagram/i.test(userAgent)) return { label: 'LINE・Instagram内の可能性', embedded: true };
  if (/Version\/.*Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent)) return { label: 'Safari系（アプリ内起動との区別はできません）', embedded: false };
  return { label: 'ブラウザー（起動元は判定できません）', embedded: false };
}
export function storageFailure(error) {
  if (['SecurityError', 'NotAllowedError'].includes(error?.name)) return 'この起動場所では保存領域へのアクセスが拒否されました。通常のブラウザーまたはホーム画面アプリで開いてください。';
  if (error?.name === 'QuotaExceededError') return '保存容量が不足している可能性があります。未送信の録音を消さず、端末の空き容量を確認してください。';
  return 'この画面の保存領域を確認できませんでした。通信エラーや未登録とは区別して扱っています。再確認してください。';
}
