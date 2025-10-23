const CACHE_NAME = 'op-card-pwa-v14'; // ★★★ 更新のたびにこのバージョン番号を上げる

const APP_SHELL_URLS = [
  './', './index.html', './style.css', './app.js', './manifest.json', './cards.json',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  './icons/iconx192.png', './icons/iconx512.png'
];

self.addEventListener('install', event => {
  console.log(`Service Worker: Install (${CACHE_NAME})`);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  console.log(`Service Worker: Activate (${CACHE_NAME})`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('message', event => {
    if (event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
    // 画像キャッシュの処理は省略
});