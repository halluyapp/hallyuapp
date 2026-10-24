/* global self, caches, clients, URL */
/**
 * Hallyu Versioned Service Worker — Automatic Deployment Update + Web Push Handler.
 *
 * `enhance-web-html.mjs` stamps the exact git commit + build timestamp into `SW_BUILD_ID` on every
 * production export so browsers immediately detect byte changes when a new build deploys, activate
 * the updated worker with `skipWaiting()`, purge stale `hallyu-assets-*` caches on `activate`,
 * serve hashed `/_expo/static/` bundles fast, and ALWAYS fetch HTML documents & `version.json`
 * fresh from network (`cache: 'no-store'`) so returning users are never trapped on an old build.
 */
const SW_BUILD_ID = '__HALLYU_SW_BUILD_ID__';
const ASSET_CACHE = `hallyu-assets-${SW_BUILD_ID}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('hallyu-assets-') && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Never intercept cross-origin API calls (Supabase REST/Auth/Storage/TMDB) or APK downloads
  if (url.origin !== self.location.origin || url.pathname.endsWith('.apk')) {
    return;
  }

  // Always network-fresh (`no-store`) for `version.json`, `manifest.json`, and `sw.js`
  if (
    url.pathname.endsWith('/version.json') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/sw.js')
  ) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // HTML navigations: Network-First (`no-store`) so new deployments take effect immediately;
  // fall back to cached shell ONLY if the user has zero network connectivity.
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Content-hashed bundles (`/_expo/static/...` & `/assets/...`): Cache-First inside `ASSET_CACHE`
  if (url.pathname.includes('/_expo/static/') || url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          if (hit) return hit;
          return fetch(req).then((res) => {
            if (res && res.status === 200) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          });
        }),
      ),
    );
  }
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
