// Wormhouse Service Worker – wird beim Build erzeugt (vite.config.js), die
// Platzhalter VERSION und ASSETS füllt der Build mit allen Dateien aus dist/.
// Strategie: Beim Installieren alles vorab cachen → Einzelspieler/Hotseat laufen
// komplett offline. Seitenaufrufe holen online die frische Version (kurzer
// Timeout), sonst die gecachte. Dateien mit Hash im Namen kommen direkt aus dem
// Cache. /api (Mehrspieler-WebSockets) geht nie durch den Cache.
const VERSION = __VERSION__;
const ASSETS = __ASSETS__;
const CACHE = `wormhouse-${VERSION}`;
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' umgeht den HTTP-Cache, damit keine alten Dateien hineinrutschen.
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('wormhouse-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Raumlinks (?r=CODE) & Co. landen alle auf derselben Seite.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([fetch(req), timeout(NAV_TIMEOUT_MS)]);
        if (res.ok && url.pathname === '/') cache.put('/', res.clone());
        return res;
      } catch {
        return (await cache.match('/')) || (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  })());
});
