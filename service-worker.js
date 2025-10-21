const CACHE_NAME = 'op-card-db-v7'; // ★★★ さらにキャッシュ名を新しいバージョンに変更 ★★★

const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  // ▼▼▼ icons/ を追記 ▼▼▼
  './icons/iconx192.png',
  './icons/iconx512.png'
];

self.addEventListener('install', event => {
  console.log(`Service Worker: Installイベント発生 (${CACHE_NAME})`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: App Shellをキャッシュ中...');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.error('App Shellのキャッシュに失敗:', err);
      })
  );
});

self.addEventListener('activate', event => {
  console.log(`Service Worker: Activateイベント発生 (${CACHE_NAME})`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => cacheName !== CACHE_NAME)
        .map(cacheName => {
          console.log(`Service Worker: 古いキャッシュ '${cacheName}' を削除中`);
          return caches.delete(cacheName);
        })
      );
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request).then(
          networkResponse => {
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
