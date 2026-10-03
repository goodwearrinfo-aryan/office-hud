// Office HUD service worker.
//
// The app is a local dashboard that must stay readable when the hive is being
// rebuilt or the server is restarting, so the shell is cached and API reads are
// served stale-while-revalidate. Writes are never cached or replayed.

const VERSION = 'office-hud-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/** Only successful GETs of read-only endpoints are worth storing. */
function isCacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API reads: serve from cache immediately, refresh in the background.
  if (url.pathname.startsWith('/api/')) {
    if (request.headers.get('upgrade') === 'websocket') return;
    // Telemetry is always truth and must never be served from cache.
    if (url.pathname === '/api/live/status' || url.pathname === '/api/live/streamStatus') return;
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navigations: network first so a rebuild is picked up, cache as a fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Hashed build assets are immutable: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      }))
    );
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Refresh in the background; the tab gets data immediately.
    network.catch(() => undefined);
    return cached;
  }

  const response = await network;
  if (response) return response;

  return new Response(
    JSON.stringify({ error: 'offline', offline: true }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// Let the page ask for an immediate takeover after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
