const CACHE_NAME = 'sedori-lab-tools-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './research/',
  './research/index.html',
  './research/app.js',
  './research/style.css',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
];

// インストール: アセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 有効化: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ: ネットワーク優先、失敗時はキャッシュ
self.addEventListener('fetch', event => {
  // 外部APIはキャッシュしない
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
