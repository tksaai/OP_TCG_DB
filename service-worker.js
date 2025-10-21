// service-worker.js (最終修正版)

const CACHE_NAME = 'op-card-db-v4'; // ★★★ キャッシュ名を新しいバージョンに変更 ★★★

// アプリの骨格となる基本的なファイルのみをキャッシュ対象とする
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// 1. インストールイベント：App Shellをキャッシュする
self.addEventListener('install', event => {
  console.log('Service Worker: Installイベント発生');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: App Shellをキャッシュ中...');
        // addAllは一つでも失敗すると全体が失敗するため、個別にキャッシュする方が堅牢
        return Promise.all(
          urlsToCache.map(url => {
            return cache.add(url).catch(error => {
              console.error(`キャッシュ追加失敗: ${url}`, error);
            });
          })
        );
      })
  );
});

// 2. アクティベートイベント：古いキャッシュを削除する
self.addEventListener('activate', event => {
  console.log('Service Worker: Activateイベント発生');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => {
          // CACHE_NAMEと異なる名前のキャッシュは古いものと判断して削除
          return cacheName !== CACHE_NAME;
        }).map(cacheName => {
          console.log(`Service Worker: 古いキャッシュ '${cacheName}' を削除中`);
          return caches.delete(cacheName);
        })
      );
    })
  );
});

// 3. フェッチイベント：リクエストを横取りしてキャッシュを返す
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュヒット：キャッシュからレスポンスを返す
        if (response) {
          return response;
        }

        // キャッシュミス：ネットワークから取得し、画像なら動的にキャッシュする
        return fetch(event.request).then(
          networkResponse => {
            // Google Driveの画像レスポンスのみを動的にキャッシュ
            if (networkResponse && networkResponse.status === 200 && event.request.url.includes('drive.google.com')) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseToCache);
              });
            }
            return networkResponse;
          }
        );
      })
  );
});
