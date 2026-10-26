import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
let source;
try { source = await readFile('.env', 'utf8'); } catch { source = await readFile('.env.example', 'utf8'); }
for (const line of (await readFile('.env.example', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=/);
  if (match && !new RegExp(`^${match[1]}=`, 'm').test(source)) source += `\n${line}\n`;
}
for (const name of ['APP_SESSION_SECRET', 'IPPO_ACCESS_CODE', 'SIGNALING_SERVICE_SECRET']) {
  if (new RegExp(`^${name}=\\s*$`, 'm').test(source)) source = source.replace(new RegExp(`^${name}=\\s*$`, 'm'), `${name}=${randomBytes(32).toString('base64url')}`);
}
await writeFile('.env', source, { mode: 0o600 });
console.log('.envを準備しました。秘密の接続キーはファイル内に保存し、画面には表示していません。');
