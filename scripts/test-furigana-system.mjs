import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    FURIGANA_MASTER_VERSION,
    FURIGANA_STATUSES,
    applyFuriganaMaster,
    normalizeFuriganaReading,
    normalizeMasterEntry
} from './furigana-utils.mjs';
import { updateFuriganaMaster } from './sync-furigana-master.mjs';

const root = new URL('../', import.meta.url);

async function readJson(name) {
    return JSON.parse(await readFile(new URL(name, root), 'utf8'));
}

test('furigana master covers every official and provisional card name', async () => {
    const [cards, provisionalCards, master] = await Promise.all([
        readJson('cards.json'),
        readJson('provisional-cards.json'),
        readJson('furigana-master.json')
    ]);

    assert.equal(master.version, FURIGANA_MASTER_VERSION);
    for (const card of [...cards, ...provisionalCards]) {
        const entry = master.entries[card.cardName];
        assert.ok(entry, `missing furigana master entry: ${card.cardName}`);
        assert.ok(FURIGANA_STATUSES.has(entry.status), `invalid status: ${card.cardName}`);
        if (entry.status === 'verified') {
            assert.ok(normalizeFuriganaReading(entry.reading), `verified entry has no reading: ${card.cardName}`);
        }
    }
});

test('verified master readings and card overrides are reflected in card data', async () => {
    const [cards, provisionalCards, master, overrides] = await Promise.all([
        readJson('cards.json'),
        readJson('provisional-cards.json'),
        readJson('furigana-master.json'),
        readJson('furigana-overrides.json')
    ]);

    const copied = structuredClone([...cards, ...provisionalCards]);
    const changed = applyFuriganaMaster(copied, master, overrides);
    assert.equal(changed, 0, 'run node scripts/sync-furigana-master.mjs --write');

    const sample = master.entries['強ェとわかってんだから… 始めから全開だ!!!'];
    assert.deepEqual(sample, {
        reading: 'ツエェトワカッテンダカラハジメカラゼンカイダ',
        status: 'verified',
        source: 'existing-card-data'
    });
});

test('new names are added without auto-verifying uncertain readings', () => {
    const existing = {
        version: 1,
        entries: {
            '既存': { reading: 'キゾン', status: 'verified', source: 'manual' }
        }
    };
    const next = updateFuriganaMaster([
        { cardName: '既存', furigana: '' },
        { cardName: 'ひらがな', furigana: '' },
        { cardName: '強い技', furigana: '' }
    ], [], existing);

    assert.equal(next.entries['既存'].status, 'verified');
    assert.deepEqual(next.entries['ひらがな'], {
        reading: 'ヒラガナ',
        status: 'suggested',
        source: 'kana-rule'
    });
    assert.deepEqual(next.entries['強い技'], {
        reading: '',
        status: 'pending',
        source: 'new-card'
    });
});

test('empty readings cannot remain verified', () => {
    assert.deepEqual(normalizeMasterEntry({ reading: '', status: 'verified', source: 'manual' }), {
        reading: '',
        status: 'pending',
        source: 'manual'
    });
});

test('review UI isolates image OCR and treats it as a suggestion requiring confirmation', async () => {
    const [html, source, frameHtml, worker] = await Promise.all([
        readFile(new URL('furigana-review.html', root), 'utf8'),
        readFile(new URL('furigana-review.js', root), 'utf8'),
        readFile(new URL('furigana-ocr-frame.html', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="review-list"/);
    assert.match(html, /class="ocr-btn"/);
    assert.match(html, /class="verify-btn"/);
    assert.match(html, /sandbox="allow-scripts"/);
    assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/);
    assert.doesNotMatch(source, /tesseract\.min\.js/);
    assert.match(frameHtml, /tesseract\.min\.js/);
    assert.match(worker, /furigana-review\.html/);
    assert.match(worker, /furigana-ocr-frame\.html\?v=1\.0\.0/);
    assert.match(source, /group\.entry\.status = 'suggested'/);
    assert.match(source, /group\.entry\.status = 'verified'/);
    assert.match(source, /image-ocr-confirmed/);
    assert.match(source, /card\.cardType !== 'EVENT'/);
});

test('forced official sync preserves an existing furigana reading', async () => {
    const source = await readFile(new URL('scripts/sync-official-cards.mjs', root), 'utf8');
    assert.match(source, /furigana:\s*card\.furigana \|\| existingCard\.furigana \|\| ''/);
});
