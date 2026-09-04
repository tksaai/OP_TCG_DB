import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    applyBlockIconRules,
    parseBlockIconRulesPage
} from './block-icon-rules.mjs';
import {
    preferOfficialCardVariant,
    stripOfficialSyncMetadata
} from './official-card-utils.mjs';

const root = new URL('../', import.meta.url);

test('official rule page separates super parallel X cards from numbered block updates', () => {
    const html = `
        <h1>ブロックアイコン更新対象カード一覧</h1>
        <time>2026.08.21</time>
        <h3>スタンダードレギュレーションで原則使用可能なカード</h3>
        <ul><li>OP01-016 ナミ</li><li>OP17-022 シャンクス</li></ul>
        <h3>ブロックアイコン④として使用可能なカード</h3>
        <ul><li>OP03-044 カヤ</li><li>ST01-011 ブルック</li></ul>
        <h3>ブロックアイコンを更新し、再録されているカード</h3>
        <ul><li>OP01-016 ナミ</li></ul>
        <h6>関連ページ</h6>
    `;
    const rules = parseBlockIconRulesPage(html, 'https://example.test/rules');

    assert.equal(rules.updatedAt, '2026-08-21');
    assert.deepEqual(rules.superParallelXCardNumbers, ['OP01-016', 'OP17-022']);
    assert.deepEqual(rules.blockIconOverrides, {
        'OP03-044': '4',
        'ST01-011': '4'
    });
});

test('super parallel X applies to the whole card number and takes priority', () => {
    const cards = [
        { cardNumber: 'OP01-016', block: 1, standardLegalOverride: true },
        { cardNumber: 'OP03-044', block: 1 },
        { cardNumber: 'OP17-022', block: 5 }
    ];
    applyBlockIconRules(cards, {
        superParallelXCardNumbers: ['OP01-016'],
        blockIconOverrides: { 'OP03-044': '4', 'OP17-022': '4' }
    }, {
        officialImageSources: {
            'Cards/OP17/official/OP17-022_p4.png': { source: 'official', block: 'X' }
        }
    });

    assert.deepEqual(cards[0], {
        cardNumber: 'OP01-016',
        block: 1,
        blockIconOverride: 'X'
    });
    assert.equal(cards[1].blockIconOverride, '4');
    assert.equal(cards[2].blockIconOverride, 'X');
});

test('normal official image is preferred over later parallel images', () => {
    const parallel = { cardNumber: 'OP17-022', block: 'X', _sourceVariantIndex: 4 };
    const normal = { cardNumber: 'OP17-022', block: 5, _sourceVariantIndex: 0 };
    const preferred = preferOfficialCardVariant(parallel, normal);

    assert.equal(preferred, normal);
    assert.deepEqual(stripOfficialSyncMetadata(preferred), {
        cardNumber: 'OP17-022',
        block: 5
    });
});

test('repository rules and applied card data remain consistent', async () => {
    const rules = JSON.parse(await readFile(new URL('block-icon-overrides.json', root), 'utf8'));
    const cards = JSON.parse(await readFile(new URL('cards.json', root), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('image-manifest.json', root), 'utf8'));
    applyBlockIconRules(cards, rules);
    const byNumber = new Map(cards.map(card => [card.cardNumber, card]));

    assert.equal(Object.hasOwn(rules, 'standardEligibleCardNumbers'), false);
    assert.ok(rules.superParallelXCardNumbers.includes('OP17-118'));
    assert.equal(rules.blockIconOverrides['OP03-044'], '4');

    for (const cardNumber of rules.superParallelXCardNumbers) {
        const card = byNumber.get(cardNumber);
        if (!card) continue;
        assert.equal(card.blockIconOverride, 'X', `${cardNumber} was not rewritten to X`);
    }
    for (const [cardNumber, block] of Object.entries(rules.blockIconOverrides)) {
        const card = byNumber.get(cardNumber);
        if (card && !rules.superParallelXCardNumbers.includes(cardNumber)) {
            assert.equal(String(card.blockIconOverride), String(block));
        }
    }

    assert.equal(String(byNumber.get('OP01-016')?.block), '1');
    assert.equal(byNumber.get('OP01-016')?.blockIconOverride, 'X');
    assert.equal(String(manifest.cards['OP01-016']?.find(variant => variant.variantIndex === 0)?.block), '1');
    assert.equal(String(manifest.cards['OP01-016']?.find(variant => variant.variantIndex === 8)?.block), 'X');
    assert.equal(String(byNumber.get('OP03-044')?.blockIconOverride), '4');
    assert.equal(String(manifest.cards['OP03-044']?.find(variant => variant.variantIndex === 4)?.block), '4');
});

test('app gives card-number overrides priority over variant blocks', async () => {
    const source = await readFile(new URL('app.js', root), 'utf8');

    assert.match(source, /variants\[variantIndex\]\?\.block/);
    assert.match(source, /if \(override\) return override/);
    assert.match(source, /applyBlockIconRulesToCards\(cardsData\)/);
    assert.match(source, /superParallelX\.has\(cardNumber\) \|\| hasXVariant/);
    assert.doesNotMatch(source, /standardLegalOverride/);
});

test('corrupt official WebP regression is repaired and future syncs scan for it', async () => {
    const image = await readFile(new URL('CardsWebP/OP11/official/OP11-080_p1.webp', root));
    const syncSource = await readFile(new URL('scripts/sync-official-images.mjs', root), 'utf8');

    assert.ok(image.length > 1024);
    assert.equal(image.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(image.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.match(syncSource, /findInvalidOfficialWebps/);
    assert.match(syncSource, /repairCardNumbers/);
    assert.match(syncSource, /hasKnownImageSignature/);
});
