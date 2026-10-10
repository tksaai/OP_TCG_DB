import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('cache refresh UI preserves user data stores', async () => {
    const html = await readFile(new URL('index.html', root), 'utf8');
    const source = await readFile(new URL('app.js', root), 'utf8');
    const start = source.indexOf('async function refreshAppCache()');
    const end = source.indexOf('// === 8. PWA', start);
    const refreshFunction = source.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(html, /id="refresh-app-cache-btn"/);
    assert.match(refreshFunction, /caches\.delete/);
    assert.match(refreshFunction, /registration\.update/);
    assert.doesNotMatch(refreshFunction, /localStorage\.(?:clear|removeItem)/);
    assert.doesNotMatch(refreshFunction, /deleteDB/);
});

test('service worker cache version is advanced for the current data release', async () => {
    const source = await readFile(new URL('service-worker.js', root), 'utf8');
    assert.match(source, /CACHE_APP_SHELL = 'app-shell-v54'/);
    assert.match(source, /CACHE_CARD_DATA = 'card-data-v18'/);
    assert.match(source, /BLOCK_ICON_RULES_PATH/);
    assert.match(source, /OWNED_CACHE_PREFIXES/);
    assert.match(source, /isOwnedCache && !cacheWhitelist\.includes/);
});

test('image display and bulk cache use the same cache version', async () => {
    const appSource = await readFile(new URL('app.js', root), 'utf8');
    const workerSource = await readFile(new URL('service-worker.js', root), 'utf8');
    const appCache = appSource.match(/const CACHE_IMAGES = '([^']+)'/)?.[1];
    const workerCache = workerSource.match(/const CACHE_IMAGES = '([^']+)'/)?.[1];

    assert.equal(appCache, workerCache);
});

test('image cache trimming is batched instead of scanning after every miss', async () => {
    const source = await readFile(new URL('service-worker.js', root), 'utf8');
    const cacheFirstStart = source.indexOf('async function cacheFirst');
    const cacheFirstEnd = source.indexOf('/**\n * Network First', cacheFirstStart);
    const cacheFirstFunction = source.slice(cacheFirstStart, cacheFirstEnd);

    assert.match(source, /IMAGE_CACHE_TRIM_INTERVAL = 100/);
    assert.match(cacheFirstFunction, /trimImageCacheWhenDue/);
    assert.doesNotMatch(cacheFirstFunction, /trimCache\(cacheName/);
});

test('startup data revalidates and the first card render stays bounded', async () => {
    const source = await readFile(new URL('app.js', root), 'utf8');

    assert.match(source, /fetch\(IMAGE_MANIFEST_PATH, \{ cache: 'no-cache' \}\)/);
    assert.match(source, /fetch\(CARDS_JSON_PATH, \{ cache: 'no-cache' \}\)/);
    assert.match(source, /const INITIAL_RENDER_COUNT = 120/);
    assert.match(source, /const RENDER_CHUNK_SIZE = 120/);
    assert.match(source, /img\.decoding = 'async'/);
});

test('official card master updates automatically without touching user stores', async () => {
    const source = await readFile(new URL('app.js', root), 'utf8');
    const start = source.indexOf('async function checkCardDataVersion()');
    const end = source.indexOf('async function checkCardDataByFetching()', start);
    const versionCheck = source.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(
        versionCheck,
        /await fetchAndUpdateCardData\(serverLastModified, cardsData, serverHash, diff\)/
    );
    assert.doesNotMatch(versionCheck, /showDbUpdateNotification/);
    assert.doesNotMatch(versionCheck, /STORE_DECKS|STORE_COLLECTION|STORE_OPENING_SESSIONS/);
});

test('app shell loads a revisioned script and bypasses stale HTTP cache', async () => {
    const html = await readFile(new URL('index.html', root), 'utf8');
    const appSource = await readFile(new URL('app.js', root), 'utf8');
    const workerSource = await readFile(new URL('service-worker.js', root), 'utf8');
    const version = appSource.match(/const APP_VERSION = '([^']+)'/)?.[1];

    assert.ok(version);
    assert.match(html, new RegExp(`image-import\\.js\\?v=${version}`));
    assert.match(html, new RegExp(`eight-pack-leader\\.js\\?v=${version}`));
    assert.match(html, new RegExp(`deck-variants\\.js\\?v=${version}`));
    assert.match(html, new RegExp(`proxy-print\\.js\\?v=${version}`));
    assert.match(html, new RegExp(`app\\.js\\?v=${version}`));
    assert.match(workerSource, new RegExp(`image-import\\.js\\?v=${version}`));
    assert.match(workerSource, new RegExp(`eight-pack-leader\\.js\\?v=${version}`));
    assert.match(workerSource, new RegExp(`deck-variants\\.js\\?v=${version}`));
    assert.match(workerSource, new RegExp(`proxy-print\\.js\\?v=${version}`));
    assert.match(workerSource, new RegExp(`app\\.js\\?v=${version}`));
    assert.match(workerSource, /cache: 'reload'/);
    assert.match(workerSource, /new Request\(request, \{ cache: 'no-cache' \}\)/);
});
