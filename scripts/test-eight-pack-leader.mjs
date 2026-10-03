import assert from 'node:assert/strict';
import test from 'node:test';
import eightPackLeader from '../eight-pack-leader.js';

test('8 pack battle leader is restored when the scraper omits it', () => {
    const cards = [{ cardNumber: 'P-001', cardName: '別カード' }];
    const result = eightPackLeader.ensureCard(cards);
    const leader = result.find(card => card.cardNumber === 'P');

    assert.ok(leader);
    assert.equal(leader.cardType, 'LEADER');
    assert.equal(leader.cardName, 'モンキー・D・ルフィ');
    assert.deepEqual(leader.color, ['赤', '緑', '青', '紫', '黒', '黄']);
    assert.equal(leader.costLifeValue, 5);
});

test('8 pack battle leader is normalized without creating duplicates', () => {
    const cards = [
        { cardNumber: 'P', cardName: 'broken', cardType: 'CHARACTER', color: ['赤'] },
        { cardNumber: 'P-001', cardName: '別カード' }
    ];

    eightPackLeader.ensureCard(cards);
    eightPackLeader.ensureCard(cards);

    const leaders = cards.filter(card => card.cardNumber === 'P');
    assert.equal(leaders.length, 1);
    assert.equal(leaders[0].cardType, 'LEADER');
    assert.equal(leaders[0].seriesCode, 'P');
});
