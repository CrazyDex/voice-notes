// Офлайн-кэш: оболочка приложения + библиотеки с CDN. Модели кэширует сама transformers.js.
const SHELL = 'vn-shell-v1', CDN = 'vn-cdn-v1';
const FILES = ['./', 'index.html', 'app.js', 'audio.js', 'asr-worker.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('vn-') && k !== SHELL && k !== CDN).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // сначала сеть (чтобы обновления доходили), без сети — кэш
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then((ca) => ca.put(req, c)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
  } else if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(CDN).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))));
  }
});
