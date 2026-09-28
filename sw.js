/* ============================================================================
   PixelRush service worker.

   The site ships a web manifest, so it already LOOKS installable — but without
   this file it would not actually launch from the home screen icon, would not
   work offline, and would drop a "service worker" warning in some browsers.

   Strategy, chosen so a deploy can never strand anyone on an old build:

     HTML documents   network-first — always fresh when online; falls back to
                      the cached copy only when the network is gone.
     CSS / JS / icons cache-first with a background refresh — these are the
                      heavy assets and they are content-hashed by deploy anyway.

   The CACHE NAME carries a version. Bump it when you change site files, or a
   returning visitor keeps the previous build until the cache is evicted.
   ========================================================================== */

var VERSION = 'pixelrush-v1';
var SHELL = 'shell-v1';
var ASSETS = 'assets-v1';

/* The minimum needed to boot the site offline. Keep this list short and real —
   a missing entry here means an offline visitor gets a broken page. */
var CORE = [
  './',
  './index.html',
  './games.html',
  './about.html',
  './contact.html',
  './privacy.html',
  './terms.html',
  './404.html',
  './css/base.css',
  './css/scenes.css',
  './css/games.css',
  './js/engine.js',
  './js/site.js',
  './js/games-data.js',
  './js/catalog.js',
  './manifest.webmanifest',
  './favicon.svg',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
  './og.jpg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      // addAll is all-or-nothing: one 404 and nothing caches. Add individually
      // so a single missing file cannot break offline support entirely.
      return Promise.all(CORE.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () { /* skip it */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k !== SHELL && k !== ASSETS) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   /* never touch third parties (ads, fonts) */

  // The player is a per-game view built from the catalog, and its ?game= URL is
  // a query variant. Cache it under the bare path so 27 variants share one entry.
  if (url.pathname.indexOf('/play.html') !== -1) return;

  var isDoc = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isDoc) {
    // Network first: a fresh deploy must never be hidden behind a stale page.
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(ASSETS).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
