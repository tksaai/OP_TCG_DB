// service-worker.js
const CACHE_NAME = 'op-card-db-v1';
// キャッシュするファイルのリスト
const urlsToCache = [
  '/',
  'index.html',
  'style.css',
  'app.js',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  'icons/icon-192x192.png',
  'icons/icon-512x512.png'
];

// インストール時にApp Shellをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// fetchイベントでキャッシュファースト戦略
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュがあればそれを返す
        if (response) {
          return response;
        }
        //なければネットワークから取得
        return fetch(event.request);
      })
  );
});