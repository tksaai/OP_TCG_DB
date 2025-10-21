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
```*   `CACHE_NAME`を`v7`に更新しました。

---

### 次のステップ

1.  GitHub上で、`icons` フォルダの中に `iconx192.png` と `iconx512.png` が存在することを最終確認してください。
2.  `index.html`, `manifest.json`, `service-worker.js` の3ファイルを、上記の内容で更新します。
3.  **5分ほど待ちます。**
4.  ブラウザでサイトにアクセスし、**開発者ツールの「Application」タブ → 「Storage」 → 「Clear site data」を必ず実行**してください。
5.  **スーパーリロード**（`Ctrl+Shift+R`）を実行します。

これでファイルパスが完全に一致し、Service Workerのインストールが成功するはずです。
コンソールのエラーがすべて消え、カード一覧が表示されれば、ついに完成となります。
