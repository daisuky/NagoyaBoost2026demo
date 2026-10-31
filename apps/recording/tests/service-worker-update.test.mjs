import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = {}, removed = []; let activated = 0, claimed = 0;
  const self = { location: { origin: 'https://app.example' }, addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => { activated++; }, clients: { claim: async () => { claimed++; } } };
  vm.runInNewContext(source, { self, URL, Response, caches: { keys: async () => ['ippo-shell-old', 'ippo-shell-__BUILD_ID__', 'unrelated-cache'], delete: async key => removed.push(key) } });
  const dispatch = async (type, fields = {}) => { let promise; handlers[type]({ ...fields, waitUntil: value => { promise = value; } }); await promise; };
  return { handlers, removed, dispatch, activated: () => activated, claimed: () => claimed };
}
test('worker only activates immediately after an explicit update request', async () => {
  const f = fixture(); assert.equal(f.activated(), 0);
  await f.dispatch('message', { data: { type: 'unrelated' } }); assert.equal(f.activated(), 0);
  await f.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } }); assert.equal(f.activated(), 1);
});
test('activation removes only old app-shell caches and claims clients', async () => {
  const f = fixture(); await f.dispatch('activate');
  assert.deepEqual(f.removed, ['ippo-shell-old']); assert.equal(f.claimed(), 1);
});
test('version requests bypass offline caches, so an old version cannot be reported as current', () => {
  const f = fixture(); let intercepted = false;
  f.handlers.fetch({ request: { method: 'GET', url: 'https://app.example/version.json' }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});
