import { readFile, writeFile } from 'node:fs/promises';
import webpush from 'web-push';
let file; try { file = await readFile('.env', 'utf8'); } catch { throw new Error('先にnpm run setupで.envを準備してください'); }
if (/^WEB_PUSH_PRIVATE_KEY=.+$/m.test(file)) throw new Error('通知鍵は設定済みです。既存の通知登録を壊さないよう鍵の再生成を停止しました');
const subject = file.match(/^WEB_PUSH_SUBJECT=(.*)$/m)?.[1].trim();
if (!subject) throw new Error('WEB_PUSH_SUBJECTへ自分のHTTPS URLまたはmailto:連絡先を設定してください');
const url = new URL(subject);
if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('WEB_PUSH_SUBJECTはHTTPS URLまたはmailto:連絡先が必要です');
const keys = webpush.generateVAPIDKeys();
for (const [name, value] of Object.entries({ WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: subject })) {
  file = new RegExp(`^${name}=.*$`, 'm').test(file) ? file.replace(new RegExp(`^${name}=.*$`, 'm'), () => `${name}=${value}`) : `${file}\n${name}=${value}\n`;
}
await writeFile('.env', file, { mode: 0o600 });
console.log('通知鍵を.envに保存しました。Vercelの非公開設定に同じ3項目を登録してください。鍵は表示しません。');
