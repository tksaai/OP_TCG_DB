(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.OPTCGCardDataDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CORRECTION_FIELDS = Object.freeze([
        'cardName',
        'rarity',
        'cardType',
        'color',
        'costLifeType',
        'costLifeValue',
        'power',
        'counter',
        'attribute',
        'features',
        'block',
        'blockIconOverride',
        'effectText',
        'trigger',
        'getInfo'
    ]);
    const SET_FIELDS = new Set(['color', 'features']);
    const NUMERIC_FIELDS = new Set(['costLifeValue', 'power']);
    const UPPERCASE_FIELDS = new Set(['cardNumber', 'rarity', 'cardType']);
    const COMPACT_TEXT_FIELDS = new Set(['effectText', 'getInfo', 'trigger']);
    const NONE_FIELDS = new Set([
        'attribute',
        'block',
        'blockIconOverride',
        'counter',
        'costLifeValue',
        'power',
        'trigger'
    ]);

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/[\u00a0\u3000]/gu, ' ')
            .replace(/\s+/gu, ' ')
            .trim();
    }

    function normalizeScalar(field, value) {
        let normalized = normalizeText(value);
        if (NONE_FIELDS.has(field) && /^(?:-|―|－|なし)$/u.test(normalized)) normalized = '';
        if (NUMERIC_FIELDS.has(field)) {
            const number = Number(normalized.replace(/,/g, ''));
            if (normalized && Number.isFinite(number)) return number;
        }
        if (COMPACT_TEXT_FIELDS.has(field)) normalized = normalized.replace(/\s+/gu, '');
        return UPPERCASE_FIELDS.has(field) ? normalized.toUpperCase() : normalized;
    }

    function normalizeValue(field, value) {
        if (Array.isArray(value)) {
            const values = value
                .map(item => normalizeText(item))
                .filter(Boolean);
            if (SET_FIELDS.has(field)) {
                return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ja', {
                    numeric: true,
                    sensitivity: 'base'
                }));
            }
            return values;
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value)
                    .filter(key => !key.startsWith('_'))
                    .sort()
                    .map(key => [key, normalizeValue(key, value[key])])
            );
        }
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return NUMERIC_FIELDS.has(field) ? value : normalizeScalar(field, value);
        }
        return normalizeScalar(field, value);
    }

    function isEmptyValue(value) {
        if (value === '') return true;
        if (Array.isArray(value)) return value.length === 0;
        if (value && typeof value === 'object') return Object.keys(value).length === 0;
        return false;
    }

    function stableStringify(value) {
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => (
                `${JSON.stringify(key)}:${stableStringify(value[key])}`
            )).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function cardFingerprint(card, fields = null) {
        const source = card && typeof card === 'object' ? card : {};
        const keys = (fields || Object.keys(source))
            .filter(key => key !== 'cardNumber' && !key.startsWith('_'))
            .sort();
        const normalized = {};
        for (const key of keys) {
            const value = normalizeValue(key, source[key]);
            if (!isEmptyValue(value)) normalized[key] = value;
        }
        return stableStringify(normalized);
    }

    function cardNumberOf(card) {
        return normalizeScalar('cardNumber', card?.cardNumber);
    }

    function diffCardsData(serverCards, localCards) {
        const localMap = new Map(
            (Array.isArray(localCards) ? localCards : [])
                .map(card => [cardNumberOf(card), card])
                .filter(([cardNumber]) => cardNumber)
        );
        const added = [];
        const changed = [];
        const infoChanged = [];
        const serverNumbers = new Set();

        for (const card of Array.isArray(serverCards) ? serverCards : []) {
            const cardNumber = cardNumberOf(card);
            if (!cardNumber) continue;
            serverNumbers.add(cardNumber);
            const local = localMap.get(cardNumber);
            if (!local) {
                added.push(cardNumber);
                continue;
            }
            if (cardFingerprint(card, CORRECTION_FIELDS) !== cardFingerprint(local, CORRECTION_FIELDS)) {
                changed.push(cardNumber);
            } else if (cardFingerprint(card) !== cardFingerprint(local)) {
                infoChanged.push(cardNumber);
            }
        }

        const removed = [...localMap.keys()].filter(cardNumber => !serverNumbers.has(cardNumber));
        return { added, changed, infoChanged, removed };
    }

    function hasChanges(diff) {
        return ['added', 'changed', 'infoChanged', 'removed']
            .some(key => Array.isArray(diff?.[key]) && diff[key].length > 0);
    }

    return Object.freeze({
        CORRECTION_FIELDS,
        cardFingerprint,
        diffCardsData,
        hasChanges,
        normalizeValue
    });
});
