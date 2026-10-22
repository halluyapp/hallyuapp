/* global self, clients, URL */
/**
 * Hallyu Cross-Platform Web Push & Offline Shell Service Worker (Apple iOS 16.4+ & Desktop Web).
 * Handles encrypted W3C Web Push notifications from `push-dispatch` and routes lock-screen taps
 * directly into the matching deep-linked Hallyu route.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Hallyu',
    body: 'New activity in your rooms',
    path: '/',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        title: parsed.title || 'Hallyu',
        body: parsed.body || 'Tap to view on Hallyu',
        path: (parsed.data && parsed.data.path) || parsed.path || '/',
      };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const scopeUrl = new URL(self.registration.scope);
  const iconUrl = new URL('./apple-touch-icon.png', scopeUrl).toString();
  const cleanRel = String(payload.path || '/').replace(/^\//, '');
  const targetUrl = new URL(cleanRel ? `./${cleanRel}` : './', scopeUrl).toString();

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: iconUrl,
      badge: iconUrl,
      tag: `hallyu-${Date.now()}`,
      renotify: true,
      data: { url: targetUrl },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) {
            return client.navigate(targetUrl);
          }
          return client;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
