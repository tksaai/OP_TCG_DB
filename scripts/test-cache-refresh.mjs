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

test('service worker cache version is advanced for the recognition fix', async () => {
    const source = await readFile(new URL('service-worker.js', root), 'utf8');
    assert.match(source, /CACHE_APP_SHELL = 'app-shell-v38'/);
    assert.match(source, /OWNED_CACHE_PREFIXES/);
    assert.match(source, /isOwnedCache && !cacheWhitelist\.includes/);
});
