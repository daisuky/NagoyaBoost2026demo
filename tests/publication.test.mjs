import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile } from '../scripts/check-publication.mjs';

test('publication gate rejects private files even when explicitly staged', () => {
  for (const path of ['apps/recording/.env', '.env.production', 'private/account.json', 'client_secret_demo.json', 'ios/signing.P12', 'signing.mobileprovision', 'recordings/sample.m4a', '.dev.vars.local', 'apps/recording/docs/screenshots/drive.jpg']) {
    assert.ok(inspectFile(path, Buffer.from('{}')).length, path);
  }
});

test('publication gate rejects inline private keys and configured example credentials', () => {
  const privateKey = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.ok(inspectFile('src/config.js', Buffer.from(privateKey)).length);
  for (const name of ['GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_FOLDER_ID', 'IPPO_ACCESS_CODE', 'WEB_PUSH_PRIVATE_KEY']) {
    assert.ok(inspectFile('apps/recording/.env.example', Buffer.from(`${name}=fixture-only`)).length);
  }
});

test('publication gate allows blank configuration and generated test credentials', () => {
  assert.deepEqual(inspectFile('apps/recording/.env.example', Buffer.from('GOOGLE_CLIENT_SECRET=\nIPPO_ACCESS_CODE=\nALLOWED_ORIGINS=http://localhost:5173\n')), []);
  assert.deepEqual(inspectFile('tests/identity.test.mjs', Buffer.from('const keys = crypto.generateKeyPairSync("ec");')), []);
});
