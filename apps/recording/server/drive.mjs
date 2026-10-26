import { fail } from './security.mjs';
export const archiveConfigured = env => ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'].every(k => !!env[k]);
export async function driveClient(env, fetcher = fetch) {
  if (!archiveConfigured(env)) throw fail(503, '収集用Google Driveは未接続です。収集担当者が接続してください。');
  const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(12000) });
  const token = await response.json(); if (!response.ok || !token.access_token) throw fail(503, '収集用Driveの接続が切れています。収集担当者の再接続が必要です。');
  return async (path, init = {}) => {
    const result = await fetcher(`https://www.googleapis.com/${path}`, { ...init, headers: { Authorization: `Bearer ${token.access_token}`, ...init.headers }, signal: AbortSignal.timeout(12000) });
    if (!result.ok) throw fail(502, '収集用Driveへの保存に失敗しました。容量と接続を確認してください。');
    return result;
  };
}
export function validateUpload(body) {
  if (!/^[a-f0-9-]{36}$/.test(body.recordingId || '') || !['host', 'guest', 'manifest'].includes(body.slot)) throw fail(400, '録音情報が無効です');
  const audio = body.slot !== 'manifest';
  if (!(audio ? ['audio/webm', 'audio/mp4'].includes(body.mimeType) : body.mimeType === 'application/json')) throw fail(400, '音声形式が無効です');
  if (!Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > (audio ? 512 * 1024 * 1024 : 64000)) throw fail(413, '保存できるファイルサイズを超えています');
  if (!/^[a-f0-9]{64}$/.test(body.digest || '')) throw fail(400, '音声の確認情報が無効です');
}
export async function prepareUpload(env, auth, body, origin, injectedDrive) {
  validateUpload(body);
  const drive = injectedDrive || await driveClient(env);
  const key = `${auth.room}:${body.recordingId}:${body.slot}`;
  const q = `'${env.GOOGLE_DRIVE_FOLDER_ID.replace(/'/g, "\\'")}' in parents and trashed = false and appProperties has { key='ippoKey' and value='${key}' }`;
  const found = await (await drive(`drive/v3/files?${new URLSearchParams({ q, fields: 'files(id,size,appProperties)', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`)).json();
  const existing = found.files?.find(f => f.appProperties?.sha256 === body.digest && Number(f.size) === body.bytes);
  if (existing) return { complete: true, id: existing.id };
  const ext = body.slot === 'manifest' ? 'json' : body.mimeType === 'audio/mp4' ? 'm4a' : 'webm';
  const name = `${auth.room}_${body.recordingId}_${body.slot}.${ext}`;
  const result = await drive('upload/drive/v3/files?uploadType=resumable&fields=id,size&supportsAllDrives=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': body.mimeType, 'X-Upload-Content-Length': String(body.bytes), ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ name, parents: [env.GOOGLE_DRIVE_FOLDER_ID], appProperties: { ippoKey: key, sha256: body.digest }, description: '一歩の記録 L0音声原本。文字起こし・AI分析は自動実行しません。' })
  });
  const uploadUrl = result.headers.get('location');
  if (!uploadUrl || !uploadUrl.startsWith('https://www.googleapis.com/')) throw fail(502, 'Driveの送信先を確認できませんでした');
  return { complete: false, uploadUrl };
}
