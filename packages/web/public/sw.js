const CACHE = 'kross-cloud-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response || caches.match('/')))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kross 需要你的确认', {
      body: data.body || '有一个工具调用正在等待审批',
      icon: '/icon.svg',
      data: { url: data.url || '/' },
      actions: [
        { action: 'approve', title: '批准' },
        { action: 'reject', title: '拒绝' }
      ]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = new URL(event.notification.data?.url || '/', self.location.origin);
  if (event.action === 'approve' || event.action === 'reject') {
    rawUrl.searchParams.set('approval', event.action);
  }
  event.waitUntil(self.clients.openWindow(rawUrl.toString()));
});
