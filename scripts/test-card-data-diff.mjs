import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cardDataDiff = require('../card-data-diff.js');

function createCard(overrides = {}) {
    return {
        uniqueId: 'OP01-001_OP01-001.png',
        cardNumber: 'OP01-001',
        cardName: 'モンキー・D・ルフィ',
        furigana: '',
        rarity: 'L',
        cardType: 'LEADER',
        color: ['赤', '緑'],
        costLifeType: 'ライフ',
        costLifeValue: 5,
        power: 5000,
        counter: '-',
        attribute: '打',
        features: ['超新星', '麦わらの一味'],
        block: 1,
        effectText: '【起動メイン】カードを1枚引く。',
        trigger: '',
        getInfo: 'ブースターパック【OP-01】',
        seriesTitle: 'ROMANCE DAWN',
        seriesCode: 'OP-01',
        sourceModalId: 'OP01-001',
        ...overrides
    };
}

test('formatting, numeric types and set ordering do not create card corrections', () => {
    const server = createCard({
        color: ['緑', '赤'],
        features: ['麦わらの一味', '超新星'],
        costLifeValue: '5',
        power: '5,000',
        counter: 'なし',
        effectText: '【起動メイン】  カードを1枚引く。'
    });
    const diff = cardDataDiff.diffCardsData([server], [createCard()]);

    assert.deepEqual(diff, { added: [], changed: [], infoChanged: [], removed: [] });
    assert.equal(cardDataDiff.hasChanges(diff), false);
});

test('furigana and source metadata updates are not reported as card corrections', () => {
    const server = createCard({
        furigana: 'モンキー・ディー・ルフィ',
        uniqueId: 'OP01-001_OP01-001-new.png',
        sourceModalId: 'card-modal-1'
    });
    const diff = cardDataDiff.diffCardsData([server], [createCard()]);

    assert.deepEqual(diff.changed, []);
    assert.deepEqual(diff.infoChanged, ['OP01-001']);
    assert.equal(cardDataDiff.hasChanges(diff), true);
});

test('game text and block changes remain real card corrections', () => {
    const server = createCard({
        block: 'X',
        effectText: '【起動メイン】カードを2枚引く。'
    });
    const diff = cardDataDiff.diffCardsData([server], [createCard()]);

    assert.deepEqual(diff.changed, ['OP01-001']);
    assert.deepEqual(diff.infoChanged, []);
});

test('added and removed cards are reported independently', () => {
    const added = createCard({ cardNumber: 'OP02-001', uniqueId: 'OP02-001.png' });
    const removed = createCard({ cardNumber: 'ST01-001', uniqueId: 'ST01-001.png' });
    const diff = cardDataDiff.diffCardsData([createCard(), added], [createCard(), removed]);

    assert.deepEqual(diff.added, ['OP02-001']);
    assert.deepEqual(diff.removed, ['ST01-001']);
    assert.deepEqual(diff.changed, []);
    assert.deepEqual(diff.infoChanged, []);
});
