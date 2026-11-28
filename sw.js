// Офлайн-кэш: сначала сеть, без сети — сохранённая копия.
// Кэшируем только файлы приложения и библиотеку Firebase, запросы к облаку не трогаем.
const CACHE = 'kassa-v14';
const FILES = ['./', './index.html', './boss.html', './app.css?v=14', './app.js?v=14', './sync.js?v=14', './firebase-config.js?v=14',
  './manifest.webmanifest', './boss.webmanifest', './icon.svg', './icon-boss.svg', './icon-180.png', './icon-boss-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const ours = url.origin === location.origin || url.hostname === 'www.gstatic.com';
  if (e.request.method !== 'GET' || !ours) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match(url.pathname.endsWith('boss.html') ? './boss.html' : './index.html')))
  );
});
