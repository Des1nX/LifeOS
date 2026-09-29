/* LifeOS service worker -- offline app shell with a versioned cache.
 *
 * - Caches only the app's own files (LifeOS.html, index.html, manifest.json, icons). It never opens, reads,
 *   changes or deletes IndexedDB: the user's data lives there and is not the service worker's business.
 * - Pages (navigations) are network-first: online you always get the newest LifeOS.html (and the cached copy is
 *   refreshed); offline the cached copy opens. Other files are served from the cache and refreshed in the background.
 * - Release a new version by bumping CACHE_VERSION: the new worker installs its own cache, activates at once and
 *   removes every older "lifeos-" cache. Caches of other apps on the same origin are left alone.
 */
const CACHE_VERSION = 'lifeos-v1';
const CACHE_PREFIX = 'lifeos-';
const SHELL = ['./LifeOS.html', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // one missing optional file must not block the rest of the shell
    await Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

async function removeOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter(n => n.startsWith(CACHE_PREFIX) && n !== CACHE_VERSION).map(n => caches.delete(n)));
}
self.addEventListener('activate', event => {
  event.waitUntil((async () => { await removeOldCaches(); await self.clients.claim(); })());
});
// An outgoing worker may still finish a request in the moment of the switch; the current worker sweeps again after
// its own requests (at most once a minute), so an old version's cache never survives.
let lastSweep = 0;
function sweepSoon(event) { const now = Date.now(); if (now - lastSweep > 60000) { lastSweep = now; event.waitUntil(removeOldCaches().catch(() => {})); } }

// Writes go only into this worker's cache while it still exists: an outgoing worker (replaced by a newer version)
// must not recreate the cache its successor just removed. Reads fall back to any lifeos cache.
async function putIfCurrent(req, res) {
  if (await caches.has(CACHE_VERSION)) await (await caches.open(CACHE_VERSION)).put(req, res);
}
async function matchAny(req) { return caches.match(req, { ignoreSearch: true }); }

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  sweepSoon(event);

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') putIfCurrent(req, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        return (await matchAny(req)) || (await caches.match('./LifeOS.html')) ||
          new Response('LifeOS is offline and not cached yet.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await matchAny(req);
    const refresh = fetch(req).then(res => { if (res && res.ok && res.type === 'basic') putIfCurrent(req, res.clone()).catch(() => {}); return res; });
    if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
    return refresh;
  })());
});
