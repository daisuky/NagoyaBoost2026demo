const CACHE = 'ippo-shell-__BUILD_ID__';
const BUILD_ASSETS = [] /* build-assets */;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest', ...BUILD_ASSETS]))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
// API, OAuth, Drive and audio are never cached. Assets are cached only on this origin.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? await caches.match('/') : Response.error())));
});
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data; try { data = event.data?.json(); } catch { data = null; }
    const valid = data?.type === 'incoming' && /^[a-f0-9-]{36}$/.test(data.callId || '');
    const live = valid && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now();
    await self.registration.showNotification('一歩の記録', {
      body: live ? '着信があります。開いて応答してください。' : '呼び出しがありました。アプリで確認してください。',
      icon: '/icon-192.png', badge: '/icon-192.png',
      tag: valid ? `ippo-call-${data.callId}` : 'ippo-call',
      data: { callId: valid ? data.callId : '' }
    });
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'incoming-changed' });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const id = event.notification.data?.callId || '';
    const url = new URL(/^[a-f0-9-]{36}$/.test(id) ? `/#incoming=${id}` : '/', self.location.origin);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { existing.postMessage({ type: 'incoming-changed' }); await existing.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
