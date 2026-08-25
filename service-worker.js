/*
 * Service Worker for OP-TCG DB PWA (GitHub Pages compatible)
 * ファイル名を元の名前に修正
 * HEADリクエストで cache.put しないように修正
 */

// === 1. 定数 ===
const CACHE_APP_SHELL = 'app-shell-v34';
const CACHE_CARD_DATA = 'card-data-v12';
// v2: 配信を WebP に一本化したタイミングで、古い JPEG/PNG のキャッシュを捨てる
const CACHE_IMAGES = 'card-images-v2';
// 全画像キャッシュを実行すると数千枚たまるため、上限を決めて古いものから捨てる
const MAX_IMAGE_CACHE_ENTRIES = 8000;

const CARDS_JSON_PATH = './cards.json';
const PROVISIONAL_CARDS_JSON_PATH = './provisional-cards.json';
const IMAGE_MANIFEST_PATH = './image-manifest.json';
const CARD_FEATURES_PATH = './card-features.json';
const FURIGANA_OVERRIDES_PATH = './furigana-overrides.json';
const CARD_DATA_FILES = [
    CARDS_JSON_PATH,
    PROVISIONAL_CARDS_JSON_PATH,
    IMAGE_MANIFEST_PATH,
    CARD_FEATURES_PATH,
    FURIGANA_OVERRIDES_PATH
];

// GitHub Pagesのリポジトリ名を考慮し、パスを `./` から始める
// ファイル名を元の名前に修正
const APP_SHELL_FILES = [
    './', // ルート (index.html を想定)
    './index.html',
    './style.css',
    './image-import.js',
    './image-import-worker.js',
    './app.js', // ファイル名を修正
    './manifest.json',
    './icons/iconx192.png',
    './icons/iconx512.png',
    'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js' // CDNはそのまま
];

// === 2. インストール (Install) イベント ===
self.addEventListener('install', (event) => {
    console.log('[SW] Install event');
    
    event.waitUntil(
        caches.open(CACHE_APP_SHELL)
            .then((cache) => {
                console.log('[SW] Caching App Shell...');
                return Promise.all(APP_SHELL_FILES.map(fileUrl => (
                    cache.add(fileUrl).catch(error => {
                        console.error(`[SW] Failed to cache app shell file: ${fileUrl}`, error);
                    })
                )));
            })
            .then(() => caches.open(CACHE_CARD_DATA))
            .then((cache) => {
                console.log('[SW] Caching initial card data...');
                return Promise.all(CARD_DATA_FILES.map(file => cache.add(file).catch(err => {
                    console.error(`[SW] Failed to cache initial ${file}`, err);
                })));
            })
            .then(() => {
                console.log('[SW] Install complete.');
                 // インストールが成功したらすぐに新しいSWをアクティブにする準備を促す
                 // ただし、即時アクティブ化はクライアント側で制御 (SKIP_WAITING)
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
            return self.clients.claim();
        })
    );
});


// === 4. フェッチ (Fetch) イベント ===
self.addEventListener('fetch', (event) => {
    // GETリクエスト以外は Service Worker で処理せず、そのままネットワークに流す
    // これにより HEAD リクエストの問題を回避
    if (event.request.method !== 'GET') {
        // console.log(`[SW] Ignoring non-GET request: ${event.request.method} ${event.request.url}`);
        return; // Service Worker は何もしない（ブラウザが通常通り処理）
    }

    const url = new URL(event.request.url);
    const requestPath = url.pathname;
    
    // GitHub Pagesのリポジトリ名を考慮
    const basePath = new URL(self.registration.scope).pathname;
    let relativePath = './';
    if (requestPath.startsWith(basePath)) {
         relativePath = './' + requestPath.substring(basePath.length);
    } 

    // console.log(`[SW] Handling GET: ${requestPath}, Relative: ${relativePath}, Base: ${basePath}`);

    // 1. カードデータと画像マニフェスト (Network First)
    if (CARD_DATA_FILES.includes(relativePath)) {
        event.respondWith(networkFirst(event.request, CACHE_CARD_DATA));
        return;
    }

    // 2. アプリシェル (Stale-While-Revalidate)
    if (APP_SHELL_FILES.includes(relativePath) || url.origin === 'https://cdn.jsdelivr.net') {
        event.respondWith(staleWhileRevalidate(event.request, CACHE_APP_SHELL));
        return;
    }
    
    // 3. カード画像 (Cards/) (Cache First)
    if (requestPath.startsWith(basePath + 'Cards/') || requestPath.startsWith(basePath + 'CardsWebP/')) {
        event.respondWith(cacheFirst(event.request, CACHE_IMAGES));
        return;
    }

    // 4. 上記以外 (キャッシュ対象外) のGETリクエストも、
    //    デフォルト動作（ネットワーク）に任せる
    //    明示的に書くなら event.respondWith(fetch(event.request));
});

// === 5. キャッシュ戦略 ===

/**
 * キャッシュ件数の上限を超えたぶんを、古い順に削除する
 * (Cache Storage の keys() は追加順を保つ)
 * @param {string} cacheName
 * @param {number} maxEntries
 */
async function trimCache(cacheName, maxEntries) {
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        if (keys.length <= maxEntries) return;
        const excess = keys.slice(0, keys.length - maxEntries);
        await Promise.all(excess.map(request => cache.delete(request)));
        console.log(`[SW] Trimmed ${excess.length} entries from ${cacheName}`);
    } catch (error) {
        console.warn(`[SW] Failed to trim ${cacheName}`, error);
    }
}

/**
 * Cache First (Cache, falling back to Network) - GETのみ対応
 * @param {Request} request - GET Request
 * @param {string} cacheName
 */
async function cacheFirst(request, cacheName) {
    try {
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        
        if (cachedResponse) {
            return cachedResponse;
        }
        
        const networkResponse = await fetch(request);
        // GETリクエストの結果のみキャッシュする
        if (networkResponse && networkResponse.ok) {
            // cache.put は GET リクエストのみサポート
             await cache.put(request, networkResponse.clone());
             if (cacheName === CACHE_IMAGES) {
                 await trimCache(cacheName, MAX_IMAGE_CACHE_ENTRIES);
             }
        } else if (networkResponse) {
             console.warn(`[SW] Cache First: Received non-OK response for ${request.url}: ${networkResponse.status}`);
        }
        return networkResponse;
    } catch (error) {
        console.error(`[SW] Cache First: Failed for ${request.url}`, error);
        return new Response(null, { status: 404, statusText: 'Not Found (Offline or Error)' });
    }
}

/**
 * Network First (Network, falling back to Cache) - GETのみ対応
 * @param {Request} request - GET Request
 * @param {string} cacheName
 */
async function networkFirst(request, cacheName) {
    try {
        const networkResponse = await fetch(request);
        
        // ネットワークが成功した場合のみキャッシュを更新 (GETのみ)
        if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(cacheName);
             await cache.put(request, networkResponse.clone());
        } else if (networkResponse) {
             console.warn(`[SW] Network First: Received non-OK response for ${request.url}: ${networkResponse.status}`);
             return networkResponse; // OKでなくてもレスポンスは返す
        }
        return networkResponse;
        
    } catch (error) {
        // ネットワークエラー (オフラインなど)
        console.warn(`[SW] Network First: Fetch failed for ${request.url}. Trying cache...`, error);
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            return cachedResponse;
        } else {
            console.error(`[SW] Network First: Fetch failed and no cache available for ${request.url}`);
             return new Response(null, { status: 503, statusText: 'Service Unavailable (Offline)' });
        }
    }
}

/**
 * Stale-While-Revalidate - GETのみ対応
 * @param {Request} request - GET Request
 * @param {string} cacheName
 */
async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cachedResponsePromise = cache.match(request);
    
    // ネットワークからのレスポンスを取得し、キャッシュを更新するPromise (GETのみ)
    const networkUpdatePromise = fetch(request).then(async (networkResponse) => {
        // GETリクエストの結果のみキャッシュする
        if (networkResponse && networkResponse.ok) {
           await cache.put(request, networkResponse.clone());
        } else if (networkResponse) {
             // console.warn(`[SW] SWR: Received non-OK response for ${request.url}: ${networkResponse.status}`);
        }
        return networkResponse; // ネットワークレスポンスを返す
    }).catch(err => {
        console.warn(`[SW] SWR: Network fetch failed for ${request.url}`, err);
        return null; // ネットワーク失敗を示す
    });

    // キャッシュがあればそれを返し、裏でネットワーク更新を実行
    const cachedResponse = await cachedResponsePromise;
    if (cachedResponse) {
        return cachedResponse;
    }

    // キャッシュがなければネットワークの結果を待つ
    const networkResponse = await networkUpdatePromise;
    if (networkResponse) {
        return networkResponse;
    }

    // 両方失敗した場合
    console.error(`[SW] SWR: Failed to get ${request.url} from cache and network.`);
    return new Response(null, { status: 503, statusText: 'Service Unavailable (Offline or Error)' });
}


// === 6. メッセージ (Message) イベント ===
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW] Received SKIP_WAITING message. Activating new SW...');
        self.skipWaiting();
    }
});

