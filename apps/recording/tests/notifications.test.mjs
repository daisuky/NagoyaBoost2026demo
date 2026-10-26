import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = {}, shown = [], messages = [], opened = [];
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://app.example' }, registration: { showNotification: async (title, options) => shown.push({ title, ...options }) }, clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
  vm.runInNewContext(source, { self, URL, Date, caches: {} });
  const dispatch = async (name, event) => { let promise; handlers[name]({ ...event, waitUntil(value) { promise = value; } }); await promise; };
  return { self, shown, messages, opened, dispatch };
}
test('push shows a visible generic notification, deduplicates by call ID and never exposes invitation', async () => {
  const f = fixture(), callId = '12345678-1234-1234-1234-123456789abc';
  await f.dispatch('push', { data: { json: () => ({ type: 'incoming', callId, expiresAt: Date.now() + 60000 }) } });
  assert.match(f.shown[0].body, /着信/); assert.equal(f.shown[0].tag, `ippo-call-${callId}`);
  assert.equal(f.shown[0].data.invite, undefined); assert.equal(f.shown[0].data.callId, callId);
  await f.dispatch('push', { data: { json: () => ({ type: 'incoming', callId, expiresAt: Date.now() - 1 }) } });
  assert.match(f.shown[1].body, /ありました/);
});
test('notification clicks open only the application origin and focus an existing app without navigating a live call', async () => {
  const f = fixture();
  await f.dispatch('notificationclick', { notification: { close() {}, data: { callId: 'https://evil.example' } } });
  assert.equal(f.opened[0], 'https://app.example/');
  let focused = false, message;
  f.self.clients.matchAll = async () => [{ url: 'https://app.example/', postMessage: value => { message = value; }, focus: async () => { focused = true; } }];
  await f.dispatch('notificationclick', { notification: { close() {}, data: { callId: '12345678-1234-1234-1234-123456789abc' } } });
  assert.equal(f.opened.length, 1); assert.equal(focused, true); assert.equal(message.type, 'incoming-changed');
});

const adapterSource = ts.transpileModule(await readFile(new URL('../src/adapters/notifications.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function adapterFixture(ready, events, timer = setTimeout) {
  const context = { exports: {}, Uint8Array, atob, Promise, setTimeout: timer, clearTimeout, window: { PushManager: true, Notification: true }, Notification: { requestPermission() { events.push('permission'); return Promise.resolve('granted'); } }, navigator: { serviceWorker: { ready } } };
  vm.runInNewContext(adapterSource, context); return context.exports.notifications;
}
test('notification permission is requested in the click stack and changed VAPID keys renew the subscription', async () => {
  const events = [], key = Buffer.alloc(65, 4).toString('base64url');
  const registration = { pushManager: {
    getSubscription: async () => ({ options: { applicationServerKey: new Uint8Array([1]).buffer }, unsubscribe: async () => { events.push('unsubscribe'); } }),
    subscribe: async options => { assert.equal(options.userVisibleOnly, true); events.push('subscribe'); return { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/test' }) }; }
  } };
  const adapter = adapterFixture(Promise.resolve(registration), events);
  const pending = adapter.subscribe(key); assert.deepEqual(events, ['permission']);
  await pending; assert.deepEqual(events, ['permission', 'unsubscribe', 'subscribe']);
});
test('missing service worker does not leave notification setup hanging indefinitely', async () => {
  const adapter = adapterFixture(new Promise(() => {}), [], callback => { queueMicrotask(callback); return 0; });
  await assert.rejects(adapter.subscribe(Buffer.alloc(65, 4).toString('base64url')), /公開アプリを再読み込み/);
});
