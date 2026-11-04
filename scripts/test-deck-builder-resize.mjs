import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, style, source, manifest] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('style.css', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('manifest.json', root), 'utf8').then(JSON.parse)
]);

test('app shell extends into safe areas in installed mobile mode', () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /name="theme-color" content="#1e1e1e"/);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color, '#1e1e1e');
    assert.match(style, /--safe-area-top: env\(safe-area-inset-top, 0px\)/);
    assert.match(style, /--safe-area-bottom: env\(safe-area-inset-bottom, 0px\)/);
    assert.match(style, /height: 100dvh/);
});

test('deck builder exposes an accessible horizontal resize separator', () => {
    assert.match(html, /id="deck-builder-resizer"/);
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-controls="card-list-container deck-builder-panel"/);
    assert.match(html, /aria-orientation="horizontal"/);
    assert.match(html, /tabindex="0"/);
    assert.match(style, /\.deck-builder-resizer[\s\S]*touch-action: none/);
    assert.match(style, /cursor: row-resize/);
    assert.match(style, /flex: 0 0 var\(--deck-builder-panel-height\)/);
});

test('deck builder resize supports pointer, keyboard, persistence, and viewport changes', () => {
    assert.match(source, /DECK_BUILDER_SPLIT_STORAGE_KEY = 'deckBuilderSplitRatio'/);
    assert.match(source, /addEventListener\('pointerdown'/);
    assert.match(source, /addEventListener\('pointermove'/);
    assert.match(source, /addEventListener\('pointerup'/);
    assert.match(source, /setPointerCapture/);
    assert.match(source, /event\.key === 'ArrowUp'/);
    assert.match(source, /event\.key === 'ArrowDown'/);
    assert.match(source, /localStorage\.setItem\(DECK_BUILDER_SPLIT_STORAGE_KEY/);
    assert.match(source, /window\.visualViewport\?\.addEventListener\('resize', refreshSplit\)/);
    assert.match(source, /dom\.deckBuilderResizer\.hidden = !visible/);
});
