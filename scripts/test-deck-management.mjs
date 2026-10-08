import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('leader selection includes artwork variants and supports replacement', async () => {
    const [html, app, css] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8')
    ]);

    assert.match(html, /id="deck-change-leader-btn"/);
    assert.match(app, /currentMode === 'leader_select'\) return 'all'/);
    assert.match(app, /function startLeaderChangeSelection\(/);
    assert.match(app, /function returnToDeckEditAfterLeaderSelection\(/);
    assert.match(app, /editingDeckLeaderVariantId = selectedVariantId/);
    assert.match(css, /\.deck-change-leader-btn/);
});

test('deck duplication keeps composition but starts without tournament history', async () => {
    const app = await readFile(new URL('app.js', root), 'utf8');

    assert.match(app, /createDeckMenuItem\('複製', 'copy', \(\) => duplicateDeck\(deck\)\)/u);
    assert.match(app, /async function duplicateDeck\(deck\)/);
    assert.match(app, /cards: \{ \.\.\.\(deck\.cards \|\| \{\}\) \}/);
    assert.match(app, /tournaments: \[\]/);
});

test('deck action menu is clamped between the fixed header and footer', async () => {
    const [app, css] = await Promise.all([
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8')
    ]);

    assert.match(app, /function positionDeckActionMenu\(menu, button\)/);
    assert.match(app, /headerBottom/);
    assert.match(app, /footerTop/);
    assert.match(app, /visualViewport/);
    assert.match(css, /\.deck-action-menu\s*\{[^}]*position: fixed/s);
    assert.match(css, /\.deck-action-menu\s*\{[^}]*overflow-y: auto/s);
});
