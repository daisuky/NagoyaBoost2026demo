import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('notification setup requires an operator subject and keeps generated keys local', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ippo-demo-notifications-'));
  const file = join(cwd, '.env');
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../apps/recording/scripts/setup-notifications.mjs', import.meta.url))], { cwd, encoding: 'utf8' });
  try {
    const empty = 'WEB_PUSH_SUBJECT=\nWEB_PUSH_PRIVATE_KEY=\nWEB_PUSH_PUBLIC_KEY=\n';
    await writeFile(file, empty);
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), empty);
    await writeFile(file, empty.replace('WEB_PUSH_SUBJECT=', 'WEB_PUSH_SUBJECT=https://demo.example'));
    const configured = run(); assert.equal(configured.status, 0);
    const saved = await readFile(file, 'utf8');
    const key = saved.match(/^WEB_PUSH_PRIVATE_KEY=(.+)$/m)?.[1];
    assert.ok(key); assert.ok(!configured.stdout.includes(key)); assert.ok(!configured.stderr.includes(key));
    assert.match(saved, /^WEB_PUSH_SUBJECT=https:\/\/demo\.example$/m);
    assert.notEqual(run().status, 0); assert.equal(await readFile(file, 'utf8'), saved);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
