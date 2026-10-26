import test from 'node:test';
import assert from 'node:assert/strict';
import { folderId, verifyFolder } from '../scripts/drive-folder.mjs';
import { startDriveSetup } from '../scripts/setup-drive.mjs';

test('existing folders accept another owner with add permission, and reject read-only or mismatched destinations', async () => {
  assert.equal(folderId('https://drive.google.com/drive/folders/team-folder?usp=sharing'), 'team-folder');
  assert.equal(folderId('https://evil.example/drive/folders/team-folder'), ''); assert.equal(folderId({}), '');
  const folder = { id: 'team-folder', name: 'Team archive', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true }, ownedByMe: false, driveId: 'shared-drive' };
  const mock = async (url, init) => {
    assert.equal(new URL(url).searchParams.get('supportsAllDrives'), 'true'); assert.equal(init.headers.Authorization, 'Bearer operator-access'); return Response.json(folder);
  };
  assert.equal((await verifyFolder(mock, 'operator-access', 'team-folder', 'team-folder')).id, folder.id);
  await assert.rejects(() => verifyFolder(mock, 'operator-access', 'other', 'team-folder'), /指定/);
  for (const change of [{ capabilities: { canAddChildren: false } }, { trashed: true }, { mimeType: 'text/plain' }]) await assert.rejects(() => verifyFolder(async () => Response.json({ ...folder, ...change }), 'operator-access', 'team-folder'));
});

test('Google-hosted Picker callback binds state and one fixed folder, and never returns tokens to the browser', async t => {
  let saved, exchanges = 0;
  const { server, authorizationUrl } = await startDriveSetup({
    port: 0, env: { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'private-client', GOOGLE_DRIVE_TARGET_FOLDER_ID: 'team-folder' },
    save: async values => { saved = values; },
    fetcher: async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        exchanges++; assert.ok(init.body.get('code_verifier')); assert.equal(init.body.get('client_secret'), 'private-client');
        return Response.json({ access_token: 'short-access', refresh_token: 'private-refresh' });
      }
      assert.equal(init.method, undefined); // Never creates folders or changes sharing.
      assert.match(url, /files\/team-folder\?/);
      return Response.json({ id: 'team-folder', name: '<Team archive>', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const auth = new URL(authorizationUrl), redirect = auth.searchParams.get('redirect_uri'), origin = new URL(redirect).origin;
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(auth.searchParams.get('trigger_onepick'), 'true'); assert.equal(auth.searchParams.get('file_ids'), 'team-folder');
  assert.equal(auth.searchParams.get('allow_folder_selection'), 'true'); assert.equal(auth.searchParams.get('allow_multiple'), 'false');
  const callback = new URL(redirect); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'test');
  assert.equal((await fetch(`${redirect}?state=wrong&code=test&picked_file_ids=team-folder`)).status, 400);
  assert.equal((await fetch(callback)).status, 400); // OAuth without explicit Picker selection cannot choose a folder.
  callback.searchParams.set('picked_file_ids', 'wrong-folder'); assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set('picked_file_ids', 'team-folder,another'); assert.equal((await fetch(callback)).status, 400);
  assert.equal((await fetch(`${origin}/picker-config`, { method: 'POST' })).status, 400); assert.equal(saved, undefined); assert.equal(exchanges, 0);
  callback.searchParams.set('picked_file_ids', 'team-folder');
  const response = await fetch(callback), html = await response.text(); assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;Team archive&gt;')); assert.ok(html.includes('/complete'));
  for (const value of ['short-access','private-refresh','private-client']) assert.ok(!html.includes(value));
  assert.deepEqual(saved, { GOOGLE_DRIVE_REFRESH_TOKEN: 'private-refresh', GOOGLE_DRIVE_FOLDER_ID: 'team-folder', GOOGLE_DRIVE_TARGET_FOLDER_ID: 'team-folder' });
});
