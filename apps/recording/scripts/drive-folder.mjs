// drive.file requires the operator to select existing folders through Google Picker.
export function folderId(value = '') {
  if (typeof value !== 'string') return '';
  if (/^[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin === 'https://drive.google.com') return url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/)?.[1] || '';
  } catch { /* Invalid targets must never become new personal folders. */ }
  return '';
}
export async function verifyFolder(fetcher, accessToken, selectedId, expectedId = '') {
  if (!folderId(selectedId) || folderId(selectedId) !== selectedId || (expectedId && selectedId !== expectedId)) throw new Error('指定された収集先フォルダを選択してください。');
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,mimeType,trashed,driveId,capabilities(canAddChildren)' });
  const response = await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(selectedId)}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('フォルダへのアクセスを確認できません。Pickerで選び、Googleアカウントの権限を確認してください。');
  const folder = await response.json();
  if (folder.id !== selectedId || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('有効な保存先フォルダではありません。');
  if (!folder.capabilities?.canAddChildren) throw new Error('このアカウントにはファイルを追加する権限がありません。編集者／投稿者の権限が必要です。');
  return folder;
}
