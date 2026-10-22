import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('user guide and legal pages are linked from the app and cover primary workflows', async () => {
    const [appHtml, guideHtml, guideCss, privacyHtml, termsHtml, legalCss, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('guide/index.html', root), 'utf8'),
        readFile(new URL('guide/guide.css', root), 'utf8'),
        readFile(new URL('privacy/index.html', root), 'utf8'),
        readFile(new URL('terms/index.html', root), 'utf8'),
        readFile(new URL('legal/legal.css', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(appHtml, /href="guide\/"/);
    assert.match(appHtml, /href="privacy\/"/);
    assert.match(appHtml, /href="terms\/"/);
    for (const section of ['cards', 'decks', 'manage', 'import', 'collection', 'pwa', 'sync']) {
        assert.match(guideHtml, new RegExp(`id="${section}"`));
    }
    assert.match(guideHtml, /OP_TCG_DB_User_Manual\.pdf/);
    assert.match(guideHtml, /調整履歴を使う/u);
    assert.match(guideHtml, /使用した調整/u);
    assert.match(guideHtml, /カード効果をテキストで確認する/u);
    assert.match(guideHtml, /「効果・情報」を押します/u);
    assert.match(guideHtml, /「画像に戻る」を押します/u);
    assert.match(guideHtml, /この端末から保存/u);
    assert.match(guideHtml, /\.\.\/privacy\//u);
    assert.match(guideHtml, /\.\.\/terms\//u);
    assert.match(guideCss, /@media print/);
    assert.match(worker, /relativePath\.startsWith\('\.\/guide\/'\)/);
    assert.match(worker, /\.\/privacy\/index\.html/u);
    assert.match(worker, /\.\/terms\/index\.html/u);
    assert.match(privacyHtml, /drive\.appdata/u);
    assert.match(privacyHtml, /Google API Services User Data Policy/u);
    assert.match(privacyHtml, /非表示アプリデータを削除/u);
    assert.match(termsHtml, /非公式の個人開発ツール/u);
    assert.match(legalCss, /\.legal-section/u);
});

test('every guide screenshot exists', async () => {
    for (const name of [
        'cards.png',
        'card-text-view.png',
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
