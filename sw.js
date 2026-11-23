// Lane Tester web app – service worker. Network first (so a new version on GitHub Pages is picked up at once),
// cache as fallback (so the tester still opens when the kiosk network drops).
const CACHE = 'lane-tester-202611231914';
const SHELL = ["./","./index.html","./manifest.webmanifest","./app/css/app.css","./app/img/signifi-logo.png","./app/index.html","./app/js/app.js","./app/js/defaults.js","./app/js/jconnect.js","./app/js/machine.js","./app/js/webshim.js","./icons/icon-192.png","./icons/icon-512.png"];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./app/index.html'))));
});
