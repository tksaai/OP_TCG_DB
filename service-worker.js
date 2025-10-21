const CACHE_NAME = 'op-card-pwa-v2'; // キャッシュ名を変更

const APP_SHELL_URLS = [
  './', './index.html', './style.css', './app.js', './manifest.json', './cards.json',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  './icons/iconx192.png', './icons/iconx512.png'
];

self.addEventListener('install', event => {
  console.log('Service Worker: Install');
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL_URLS)));
});

self.addEventListener('activate', event => {
  console.log('Service Worker: Activate');
  event.waitUntil(caches.keys().then(cacheNames => {
    return Promise.all(
      cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
    );
  }));
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      // キャッシュがあればそれを返す
      if (response) {
        return response;
      }
      // なければネットワークから取得
      return fetch(event.request);
    })
  );
});

// app.jsからのメッセージを受け取る
self.addEventListener('message', event => {
    if (event.data.type === 'CACHE_IMAGES') {
        const imageUrls = event.data.payload;
        event.waitUntil(
            caches.open(CACHE_NAME).then(async (cache) => {
                let processed = 0;
                for (const url of imageUrls) {
                    try {
                        // 既にキャッシュになければ追加
                        const cachedResponse = await cache.match(url);
                        if (!cachedResponse) {
                            await cache.add(url);
                        }
                    } catch (e) {
                        console.warn(`画像のキャッシュに失敗: ${url}`);
                    }
                    processed++;
                    // 100件ごとに進捗を通知
                    if (processed % 100 === 0 || processed === imageUrls.length) {
                        event.source.postMessage({
                            type: 'CACHE_PROGRESS',
                            payload: { processed, total: imageUrls.length }
                        });
                    }
                }
                event.source.postMessage({ type: 'CACHE_COMPLETE' });
            })
        );
    }
});