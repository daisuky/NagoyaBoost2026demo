import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload, prepareUpload, driveClient } from '../server/drive.mjs';
import { sendResumable } from '../src/core/upload.mjs';
const body = { recordingId: '12345678-1234-1234-1234-123456789abc', slot: 'host', mimeType: 'audio/webm', bytes: 10, digest: 'a'.repeat(64) };
test('archive rejects paths, unexpected formats and oversized uploads', () => {
  assert.doesNotThrow(() => validateUpload(body));
  for (const change of [{ slot: '../secret' }, { recordingId: '../foo' }, { mimeType: 'text/html' }, { bytes: 0 }, { bytes: 600 * 1024 * 1024 }, { digest: 'wrong' }]) assert.throws(() => validateUpload({ ...body, ...change }));
});
test('archive retries find already completed content and do not upload duplicates', async () => {
  const result = await prepareUpload({ GOOGLE_DRIVE_FOLDER_ID: 'fixed-folder' }, { room: 'a-room' }, body, undefined, async path => {
    assert.match(path, /files\?/);
    const params = new URL(path, 'https://www.googleapis.com/').searchParams;
    assert.equal(params.get('supportsAllDrives'), 'true'); assert.equal(params.get('includeItemsFromAllDrives'), 'true');
    return Response.json({ files: [{ id: 'existing-file', size: '10', appProperties: { sha256: body.digest } }] });
  });
  assert.deepEqual(result, { complete: true, id: 'existing-file' });
});
test('browser receives only a constrained upload URL, never the owner access token', async () => {
  let n = 0;
  const result = await prepareUpload({ GOOGLE_DRIVE_FOLDER_ID: 'fixed-folder' }, { room: 'a-room' }, body, 'https://ippo.example', async (path, options) => {
    if (++n === 1) return Response.json({ files: [] });
    assert.equal(new URL(path, 'https://www.googleapis.com/').searchParams.get('supportsAllDrives'), 'true');
    const metadata = JSON.parse(options.body); assert.deepEqual(metadata.parents, ['fixed-folder']); assert.match(metadata.appProperties.ippoKey, /a-room/);
    assert.equal(options.headers.Origin, 'https://ippo.example');
    return new Response('', { headers: { location: 'https://www.googleapis.com/upload/test-session' } });
  });
  assert.deepEqual(result, { complete: false, uploadUrl: 'https://www.googleapis.com/upload/test-session' });
});
test('revoked owner authorization is reported without returning token material', async () => {
  await assert.rejects(() => driveClient({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_DRIVE_REFRESH_TOKEN: 'private', GOOGLE_DRIVE_FOLDER_ID: 'x' }, async () => Response.json({ error: 'invalid_grant' }, { status: 400 })), /収集担当者の再接続/);
});
test('resumable upload probes server acknowledgement after final response is lost', async () => {
  let n = 0;
  const result = await sendResumable('https://example.test', new Blob(['hello']), async (_url, init) => {
    if (++n === 1) throw new Error('lost response');
    assert.equal(init.headers['Content-Range'], 'bytes */5'); return Response.json({ id: 'completed' });
  });
  assert.equal(result.id, 'completed'); assert.equal(n, 2);
});
test('resumable upload uses exact byte ranges for multiple chunks', async () => {
  const size = 4 * 1024 * 1024; let n = 0;
  const result = await sendResumable('https://example.test', new Blob([new Uint8Array(size + 3)]), async (_url, init) => {
    if (++n === 1) { assert.equal(init.headers['Content-Range'], `bytes 0-${size - 1}/${size + 3}`); return new Response(null, { status: 308, headers: { Range: `bytes=0-${size - 1}` } }); }
    assert.equal(init.headers['Content-Range'], `bytes ${size}-${size + 2}/${size + 3}`); return Response.json({ id: 'file' });
  }); assert.equal(result.id, 'file');
});
