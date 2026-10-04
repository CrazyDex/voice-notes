// Офлайн-кэш + заголовки COOP/COEP (включают многопоточность WebAssembly — распознавание на CPU в 2–3 раза быстрее).
// Модели кэширует сама transformers.js.
const SHELL = 'vn-shell-v15', CDN = 'vn-cdn-v1';
const FILES = ['./', 'index.html', 'app.js', 'audio.js', 'pc.js', 'asr-worker.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'vendor/ogg-opus-decoder.min.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('vn-') && k !== SHELL && k !== CDN).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// На iPhone изоляцию не включаем: многопоточный WebAssembly с общей памятью там часто роняет Safari
const IOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
function isolate(r) {
  if (IOS || !r || r.status === 0 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.searchParams.has('check')) return; // проверка обновлений — прямо в сеть, без кэша
  if (url.origin === location.origin) {
    // сначала сеть (чтобы обновления доходили), без сети — кэш
    // no-cache: браузер обязан сверить файл с сайтом (иначе GitHub Pages отдаёт старое до 10 минут)
    const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
    e.respondWith(fresh.then((r) => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then((ca) => ca.put(req, c)); } return isolate(r); })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')).then(isolate)));
  } else if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(CDN).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))));
  }
});
