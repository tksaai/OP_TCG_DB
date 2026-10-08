import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('deck-variants.js', root), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ window }));
const variants = window.OPTCGDeckVariants;
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy deck counts default to normal artwork', () => {
    assert.deepEqual(plain(variants.normalizeVariantCounts({
        'OP01-001': 4,
        'OP01-002': 2
    })), {
        'OP01-001::OP01-001': 4,
        'OP01-002::OP01-002': 2
    });
});

test('normal and parallel artwork can share the four-copy limit', () => {
    const state = variants.setVariantCount(
        { 'OP01-001': 2 },
        { 'OP01-001::OP01-001': 2 },
        'OP01-001::OP01-001_p1',
        3
    );

    assert.deepEqual(plain(state.cards), { 'OP01-001': 4 });
    assert.deepEqual(plain(state.cardVariants), {
        'OP01-001::OP01-001': 2,
        'OP01-001::OP01-001_p1': 2
    });
});

test('compact storage keeps only explicit parallel selections', () => {
    const compact = variants.compactVariantCounts(
        { 'OP01-001': 4 },
        {
            'OP01-001::OP01-001': 1,
            'OP01-001::OP01-001_p1': 2,
            'OP01-001::OP01-001_r1': 1
        }
    );
    assert.deepEqual(plain(compact), {
        'OP01-001::OP01-001_p1': 2,
        'OP01-001::OP01-001_r1': 1
    });
    assert.deepEqual(plain(variants.normalizeVariantCounts({ 'OP01-001': 4 }, compact)), {
        'OP01-001::OP01-001_p1': 2,
        'OP01-001::OP01-001_r1': 1,
        'OP01-001::OP01-001': 1
    });
});

test('setting a canonical card count to zero removes every artwork', () => {
    const state = variants.setCardCount(
        { 'OP01-001': 4 },
        {
            'OP01-001::OP01-001': 2,
            'OP01-001::OP01-001_p1': 2
        },
        'OP01-001',
        0
    );
    assert.deepEqual(plain(state.cards), {});
    assert.deepEqual(plain(state.cardVariants), {});
});

test('deck builder exposes opt-in parallel selection and persists artwork choices', async () => {
    const [html, app, css] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8')
    ]);

    assert.match(html, /id="deck-parallel-toggle"/);
    assert.doesNotMatch(html, /id="deck-parallel-toggle"[^>]*checked/);
    assert.match(app, /deckParallelSelectionEnabled \? 'all' : 'representative'/);
    assert.match(app, /cardVariants: editingDeckVariantData/);
    assert.match(app, /leaderVariantId/);
    assert.match(app, /loadCardCanvasImage\(entry\.card, entry\.variantIndex \|\| 0\)/);
    assert.match(css, /\.deck-builder-variant-toggle/);
    assert.match(css, /\.deck-builder-leader-variant-select/);
});
