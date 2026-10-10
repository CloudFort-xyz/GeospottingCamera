// App-shell service worker.
//
// Each version precaches the complete shell into its own cache, bypassing the
// HTTP cache (GitHub Pages sends max-age=600), so a cache always holds one
// consistent build. Requests are served cache-first from that cache only; there
// is no per-file background revalidation, which could mix builds. A new version
// waits until the page asks it to take over (user taps "Reload").
//
// VERSION is replaced with the commit SHA by the deploy workflow.
const VERSION = 'v1.3.0';
const CACHE = `geospotting-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/settings.js', 'js/geo.js', 'js/camera.js',
  'js/exif.js', 'js/zip.js', 'js/csv.js', 'js/export.js', 'js/geomath.js', 'js/compass.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('geospotting-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: true });
    return cached || fetch(req);
  })());
});
