import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('user guide is linked from the app and covers primary workflows', async () => {
    const [appHtml, guideHtml, guideCss, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('guide/index.html', root), 'utf8'),
        readFile(new URL('guide/guide.css', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(appHtml, /href="guide\/"/);
    for (const section of ['cards', 'decks', 'manage', 'import', 'collection', 'pwa']) {
        assert.match(guideHtml, new RegExp(`id="${section}"`));
    }
    assert.match(guideHtml, /OP_TCG_DB_User_Manual\.pdf/);
    assert.match(guideHtml, /調整履歴を使う/u);
    assert.match(guideHtml, /使用した調整/u);
    assert.match(guideCss, /@media print/);
    assert.match(worker, /relativePath\.startsWith\('\.\/guide\/'\)/);
});

test('every guide screenshot exists', async () => {
    for (const name of [
        'cards.png',
        'filter.png',
        'leader-select.png',
        'deck-editor.png',
        'deck-menu.png',
        'adjustment-history.png',
        'image-import.png',
        'collection.png',
        'settings.png'
    ]) {
        await access(new URL(`guide/assets/${name}`, root));
    }
});

test('downloadable PDF manual is generated', async () => {
    const manual = await stat(new URL('guide/OP_TCG_DB_User_Manual.pdf', root));
    assert.ok(manual.size > 100_000);
});
