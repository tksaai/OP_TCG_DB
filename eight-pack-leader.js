(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.OPTCGEightPackLeader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CARD_NUMBER = 'P';
    const CARD = Object.freeze({
        uniqueId: 'P_8pack-battle-leader',
        cardNumber: CARD_NUMBER,
        cardName: 'モンキー・D・ルフィ',
        furigana: 'モンキー・ディー・ルフィ',
        rarity: 'L',
        cardType: 'LEADER',
        color: Object.freeze(['赤', '緑', '青', '紫', '黒', '黄']),
        costLifeType: 'ライフ',
        costLifeValue: 5,
        power: 5000,
        counter: '-',
        attribute: '打',
        features: Object.freeze(['麦わらの一味']),
        block: '-',
        effectText: 'ルール上、このリーダーは指定されたイベントでのみ使用できる。 ルール上、このリーダーはすべてのカード名と特徴と属性を持つカードとして扱う。',
        trigger: '',
        getInfo: '8パックバトル 参加記念品',
        seriesTitle: '8パックバトル 参加記念品',
        seriesCode: 'P',
        sourceModalId: 'P'
    });

    function createCard() {
        return {
            ...CARD,
            color: [...CARD.color],
            features: [...CARD.features]
        };
    }

    function ensureCard(cards) {
        if (!Array.isArray(cards)) return cards;
        const specialCard = createCard();
        const index = cards.findIndex(card => (
            String(card?.cardNumber || '').trim().toUpperCase() === CARD_NUMBER
        ));
        if (index >= 0) cards[index] = { ...cards[index], ...specialCard };
        else cards.push(specialCard);
        cards.sort((a, b) => String(a?.cardNumber || '').localeCompare(
            String(b?.cardNumber || ''),
            'en',
            { numeric: true }
        ));
        return cards;
    }

    return Object.freeze({
        CARD_NUMBER,
        createCard,
        ensureCard
    });
});
