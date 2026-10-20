(function(global) {
    'use strict';

    const MAX_FILE_BYTES = 64 * 1024;
    const MAX_LINES = 100;
    const MAX_COPIES = 4;
    const MAX_MAIN_DECK_SIZE = 50;
    const CARD_NUMBER_PATTERN = /^[A-Z0-9]{1,12}-[A-Z0-9]{1,12}$/;
    const DECK_LINE_PATTERN = /^([1-4])\s*[xX×]\s*([A-Za-z0-9]{1,12}-[A-Za-z0-9]{1,12})$/;

    function normalizeCardNumber(value) {
        const cardNumber = String(value || '').trim().toUpperCase();
        return CARD_NUMBER_PATTERN.test(cardNumber) ? cardNumber : '';
    }

    function normalizeDeckName(value, fallback = 'OPTCGSimから追加') {
        const name = String(value || '')
            .replace(/\.deck$/i, '')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        return name || fallback;
    }

    function normalizeEntries(entries) {
        const counts = new Map();
        for (const [rawCardNumber, rawCount] of entries) {
            const cardNumber = normalizeCardNumber(rawCardNumber);
            const count = Number(rawCount);
            if (!cardNumber || !Number.isInteger(count) || count < 1 || count > MAX_COPIES) {
                throw new Error('カード番号または枚数が正しくありません。');
            }
            const nextCount = (counts.get(cardNumber) || 0) + count;
            if (nextCount > MAX_COPIES) {
                throw new Error(`${cardNumber} の枚数が4枚を超えています。`);
            }
            counts.set(cardNumber, nextCount);
        }
        return counts;
    }

    function parseDeck(text, options = {}) {
        const source = String(text || '').replace(/^\uFEFF/, '');
        if (!source.trim()) throw new Error('OPTCGSimのデッキデータが空です。');
        if (new TextEncoder().encode(source).byteLength > MAX_FILE_BYTES) {
            throw new Error('OPTCGSimのデッキファイルが大きすぎます。');
        }

        const lines = source.split(/\r?\n/)
            .map((line, index) => ({ text: line.trim(), number: index + 1 }))
            .filter(line => line.text);
        if (lines.length === 0 || lines.length > MAX_LINES) {
            throw new Error('OPTCGSimのデッキ行数が正しくありません。');
        }

        const parsedEntries = lines.map(line => {
            const match = line.text.match(DECK_LINE_PATTERN);
            if (!match) {
                throw new Error(`${line.number}行目を読み取れません: ${line.text.slice(0, 40)}`);
            }
            return [normalizeCardNumber(match[2]), Number(match[1])];
        });
        const counts = normalizeEntries(parsedEntries);
        const resolveCard = typeof options.resolveCard === 'function'
            ? options.resolveCard
            : () => null;
        const knownLeaders = [...counts.entries()].filter(([cardNumber]) => (
            resolveCard(cardNumber)?.cardType === 'LEADER'
        ));

        if (knownLeaders.length > 1) {
            throw new Error('リーダーカードが複数含まれています。');
        }

        let leader = '';
        if (knownLeaders.length === 1) {
            const [cardNumber, count] = knownLeaders[0];
            if (count !== 1) throw new Error('リーダーカードは1枚にしてください。');
            leader = cardNumber;
        } else {
            const [firstCardNumber, firstCount] = parsedEntries[0];
            if (firstCount === 1 && !resolveCard(firstCardNumber)) {
                leader = firstCardNumber;
            }
        }
        if (!leader) {
            throw new Error('リーダーカードを判定できませんでした。リーダーを先頭に1枚で記載してください。');
        }

        counts.delete(leader);
        const cards = Object.fromEntries(counts);
        const total = Object.values(cards).reduce((sum, count) => sum + count, 0);
        if (total > MAX_MAIN_DECK_SIZE) {
            throw new Error(`メインデッキは50枚以下にしてください。現在は${total}枚です。`);
        }

        const unknownCardNumbers = [leader, ...Object.keys(cards)]
            .filter((cardNumber, index, values) => values.indexOf(cardNumber) === index)
            .filter(cardNumber => !resolveCard(cardNumber));

        return {
            name: normalizeDeckName(options.fileName),
            leader,
            cards,
            unknownCardNumbers
        };
    }

    function serializeDeck(deck) {
        const leader = normalizeCardNumber(deck?.leader);
        if (!leader) throw new Error('リーダーカードが設定されていません。');

        const rawCards = Array.isArray(deck?.cards)
            ? deck.cards
            : Object.entries(deck?.cards || {});
        const counts = normalizeEntries(rawCards);
        counts.delete(leader);
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        if (total > MAX_MAIN_DECK_SIZE) {
            throw new Error(`メインデッキは50枚以下にしてください。現在は${total}枚です。`);
        }

        const lines = [`1x${leader}`];
        [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
            .forEach(([cardNumber, count]) => lines.push(`${count}x${cardNumber}`));
        return `${lines.join('\r\n')}\r\n`;
    }

    global.OPTCGSimDeck = Object.freeze({
        parseDeck,
        serializeDeck,
        normalizeCardNumber,
        normalizeDeckName
    });
})(typeof window !== 'undefined' ? window : globalThis);
