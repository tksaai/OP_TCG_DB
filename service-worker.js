/*
 * Service Worker for OP-TCG DB PWA (GitHub Pages compatible)
 * ファイル名を元の名前に修正
 */

// === 1. 定数 ===
const CACHE_APP_SHELL = 'app-shell-v1';
const CACHE_CARD_DATA = 'card-data-v1';
const CACHE_IMAGES = 'card-images-v1';

// GitHub Pagesのリポジトリ名を考慮し、パスを `./` から始める
// ファイル名を元の名前に修正
const APP_SHELL_FILES = [
    './', // ルート (index.html を想定)
    './index.html',
    './style.css',
    './app.js', // ファイル名を修正
    './manifest.json',
    './icons/iconx192.png',
    './icons/iconx512.png',
    'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js' // CDNはそのまま
];

// cards.json のパスを相対パスに
const CARDS_JSON_PATH = './cards.json';


// === 2. インストール (Install) イベント ===
self.addEventListener('install', (event) => {
    console.log('[SW] Install event');
    
    event.waitUntil(
        caches.open(CACHE_APP_SHELL)
            .then((cache) => {
                console.log('[SW] Caching App Shell...');
                // addAllはアトミック。一つでも失敗すると全体が失敗する。
                return cache.addAll(APP_SHELL_FILES)
                    .catch(err => {
                        console.error('[SW] Failed to cache app shell files:', err, APP_SHELL_FILES);
                        // 個別のファイルキャッシュ失敗をログに出力
                        APP_SHELL_FILES.forEach(fileUrl => {
                            fetch(fileUrl).catch(fetchErr => console.error(`[SW] Failed to fetch: ${fileUrl}`, fetchErr));
                        });
                        // インストール失敗として扱う
                        throw err; 
                    });
            })
            .then(() => caches.open(CACHE_CARD_DATA))
            .then((cache) => {
                console.log('[SW] Caching initial card data...');
                // cards.json のキャッシュも試行
                return cache.add(CARDS_JSON_PATH).catch(err => {
                    console.error(`[SW] Failed to cache initial ${CARDS_JSON_PATH}`, err);
                    // cards.jsonの初回キャッシュ失敗はインストール失敗としない
                });
            })
            .then(() => {
                console.log('[SW] Install complete.');
                 // インストールが成功したらすぐに新しいSWをアクティブにする準備を促す
                 // ただし、即時アクティブ化はクライアント側で制御 (SKIP_WAITING)
                // return self.skipWaiting(); // ここでは呼ばない
            })
            .catch(error => {
                console.error('[SW] Installation failed:', error);
            })
    );
});


// === 3. アクティベート (Activate) イベント ===
self.addEventListener('activate', (event) => {
    console.log('[SW] Activate event');
    
    // 古いキャッシュを削除
    const cacheWhitelist = [CACHE_APP_SHELL, CACHE_CARD_DATA, CACHE_IMAGES];
    
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        console.log(`[SW] Deleting old cache: ${cacheName}`);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            console.log('[SW] Activation complete. Claiming clients...');
            // 新しいSWが即座にページを制御できるようにする
            // これにより、更新後の初回リロードで新しいSWが使われる
            return self.clients.claim();
        })
    );
});


// === 4. フェッチ (Fetch) イベント ===
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const requestPath = url.pathname;
    
    // GitHub Pagesのリポジトリ名を考慮 (例: /repo-name/index.html)
    // Service Worker のスコープからの相対パスを使う
    const basePath = new URL(self.registration.scope).pathname; // 例: /repo-name/
    // リクエストパスがベースパスで始まっているか確認し、相対パスを生成
    let relativePath = './';
    if (requestPath.startsWith(basePath)) {
         relativePath = './' + requestPath.substring(basePath.length); // 例: ./index.html
    } else {
         // Service Worker のスコープ外のリクエスト (CDNなど) はそのまま処理
         // console.log(`[SW] Fetch: Outside scope - ${requestPath}`);
         // event.respondWith(fetch(event.request)); // 下で処理するのでここでは何もしない
    }


    // console.log(`[SW] Fetching: ${requestPath}, Relative: ${relativePath}, Base: ${basePath}`);

    // 1. アプリシェル (Stale-While-Revalidate)
    // APP_SHELL_FILES に含まれるか、 または CDN の URL かどうか
    if (APP_SHELL_FILES.includes(relativePath) || url.origin === 'https://cdn.jsdelivr.net') {
        event.respondWith(staleWhileRevalidate(event.request, CACHE_APP_SHELL));
        return;
    }
    
    // 2. カードデータ (cards.json) (Network First)
    if (relativePath === CARDS_JSON_PATH) {
        event.respondWith(networkFirst(event.request, CACHE_CARD_DATA));
        return;
    }
    
    // 3. カード画像 (Cards/) (Cache First)
    // ベースパス + 'Cards/' で始まるか確認
    if (requestPath.startsWith(basePath + 'Cards/')) {
        event.respondWith(cacheFirst(event.request, CACHE_IMAGES));
        return;
    }

    // 4. その他 (ネットワークのみ)
    // console.log(`[SW] Fetch: Passing through ${requestPath}`);
    // ここで respondWith を呼ばないと、ブラウザのデフォルト動作（ネットワークフェッチ）になる
    // 明示的に書く場合は以下
    // event.respondWith(fetch(event.request)); 
});

// === 5. キャッシュ戦略 ===

/**
 * Cache First (Cache, falling back to Network)
 * @param {Request} request
 * @param {string} cacheName
 */
async function cacheFirst(request, cacheName) {
    try {
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        
        if (cachedResponse) {
            // console.log(`[SW] Cache First: Found ${request.url} in cache.`);
            return cachedResponse;
        }
        
        // console.log(`[SW] Cache First: Not in cache. Fetching ${request.url}`);
        const networkResponse = await fetch(request);
        // レスポンスが正常(2xx)ならキャッシュにも保存
        // (リダイレクト(3xx)などはキャッシュしない方が安全な場合もある)
        if (networkResponse && networkResponse.ok) {
            // レスポンスはストリームなので、クローンして片方をキャッシュに
            // putは非同期なのでawaitする
             await cache.put(request, networkResponse.clone());
        } else if (networkResponse) {
             console.warn(`[SW] Cache First: Received non-OK response for ${request.url}: ${networkResponse.status}`);
        }
        return networkResponse;
    } catch (error) {
        console.error(`[SW] Cache First: Failed for ${request.url}`, error);
        // オフライン時の画像フォールバックなどをここに追加可能
        // 例: return caches.match('./icons/placeholder.png');
        // エラーレスポンスを返す
        return new Response(null, { status: 404, statusText: 'Not Found (Offline or Error)' });
    }
}

/**
 * Network First (Network, falling back to Cache)
 * @param {Request} request
 * @param {string} cacheName
 */
async function networkFirst(request, cacheName) {
    try {
        // console.log(`[SW] Network First: Fetching ${request.url}`);
        const networkResponse = await fetch(request);
        
        // ネットワークが成功したら、キャッシュを更新
        if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(cacheName);
            // 非同期でキャッシュ更新
            await cache.put(request, networkResponse.clone());
        } else if (networkResponse) {
             console.warn(`[SW] Network First: Received non-OK response for ${request.url}: ${networkResponse.status}`);
             // OKでないレスポンスでも、とりあえずそれを返す (サーバーエラーなど)
             return networkResponse;
        }
        return networkResponse;
        
    } catch (error) {
        // ネットワークエラー (オフラインなど)
        console.warn(`[SW] Network First: Fetch failed for ${request.url}. Trying cache...`, error);
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            console.log(`[SW] Network First: Found ${request.url} in cache (fallback).`);
            return cachedResponse;
        } else {
            console.error(`[SW] Network First: Fetch failed and no cache available for ${request.url}`);
             // オフライン用のJSONなどを返すことも検討
            // return new Response(JSON.stringify({ error: "Offline" }), { headers: { 'Content-Type': 'application/json' }});
             return new Response(null, { status: 503, statusText: 'Service Unavailable (Offline)' });
        }
    }
}

/**
 * Stale-While-Revalidate
 * @param {Request} request
 * @param {string} cacheName
 */
async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    
    // キャッシュからのレスポンスを試みるPromise
    const cachedResponsePromise = cache.match(request);
    
    // ネットワークからのレスポンスを取得し、キャッシュを更新するPromise
    const networkUpdatePromise = fetch(request).then(async (networkResponse) => {
        if (networkResponse && networkResponse.ok) {
            // 正常なレスポンスならキャッシュを更新
           await cache.put(request, networkResponse.clone());
        } else if (networkResponse) {
             console.warn(`[SW] SWR: Received non-OK response for ${request.url}: ${networkResponse.status}`);
        }
        return networkResponse; // ネットワークレスポンスを返す
    }).catch(err => {
        console.warn(`[SW] SWR: Network fetch failed for ${request.url}`, err);
        return null; // ネットワーク失敗を示す
    });

    // キャッシュがあればそれを返し、裏でネットワーク更新を実行
    const cachedResponse = await cachedResponsePromise;
    if (cachedResponse) {
        // console.log(`[SW] SWR: Returning cached ${request.url} (stale).`);
        return cachedResponse;
    }

    // キャッシュがなければネットワークの結果を待つ
    // console.log(`[SW] SWR: No cache. Waiting for network ${request.url}`);
    const networkResponse = await networkUpdatePromise;
    if (networkResponse) {
        return networkResponse;
    }

    // 両方失敗した場合
    console.error(`[SW] SWR: Failed to get ${request.url} from cache and network.`);
    // 適切なエラーレスポンスを返す (例: オフラインページ)
    // return caches.match('./offline.html');
    return new Response(null, { status: 503, statusText: 'Service Unavailable (Offline or Error)' });
}


// === 6. メッセージ (Message) イベント ===
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW] Received SKIP_WAITING message. Activating new SW...');
        // skipWaiting() を呼ぶと、新しいSWが即座に Activate フェーズに入る
        self.skipWaiting();
    }
});
