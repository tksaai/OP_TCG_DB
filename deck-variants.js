(function(global) {
    'use strict';

    const DEFAULT_MAX_COPIES = 4;
    const KEY_SEPARATOR = '::';

    function clampCount(value, maxCopies = DEFAULT_MAX_COPIES) {
        const count = Number(value);
        if (!Number.isFinite(count)) return 0;
        return Math.min(Math.max(Math.trunc(count), 0), maxCopies);
    }

    function parseVariantKey(key) {
        const value = String(key || '');
        const separatorIndex = value.indexOf(KEY_SEPARATOR);
        if (separatorIndex <= 0 || separatorIndex >= value.length - KEY_SEPARATOR.length) return null;
        const cardNumber = value.slice(0, separatorIndex).trim().toUpperCase();
        const variantId = value.slice(separatorIndex + KEY_SEPARATOR.length).trim();
        if (!cardNumber || !variantId) return null;
        return { cardNumber, variantId };
    }

    function normalVariantKey(cardNumber) {
        const normalized = String(cardNumber || '').trim().toUpperCase();
        return normalized ? `${normalized}${KEY_SEPARATOR}${normalized}` : '';
    }

    function normalizeCardCounts(value = {}, maxCopies = DEFAULT_MAX_COPIES) {
        const normalized = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
        Object.entries(value).forEach(([rawCardNumber, rawCount]) => {
            const cardNumber = String(rawCardNumber || '').trim().toUpperCase();
            const count = clampCount(rawCount, maxCopies);
            if (cardNumber && count > 0) normalized[cardNumber] = count;
        });
        return normalized;
    }

    function normalizeVariantCounts(cardCounts = {}, variantCounts = {}, maxCopies = DEFAULT_MAX_COPIES) {
        const cards = normalizeCardCounts(cardCounts, maxCopies);
        const normalized = {};
        const allocated = {};

        if (variantCounts && typeof variantCounts === 'object' && !Array.isArray(variantCounts)) {
            Object.entries(variantCounts).forEach(([key, rawCount]) => {
                const parsed = parseVariantKey(key);
                if (!parsed || !cards[parsed.cardNumber]) return;
                const remaining = cards[parsed.cardNumber] - (allocated[parsed.cardNumber] || 0);
                const count = Math.min(clampCount(rawCount, maxCopies), remaining);
                if (count <= 0) return;
                const normalizedKey = `${parsed.cardNumber}${KEY_SEPARATOR}${parsed.variantId}`;
                normalized[normalizedKey] = (normalized[normalizedKey] || 0) + count;
                allocated[parsed.cardNumber] = (allocated[parsed.cardNumber] || 0) + count;
            });
        }

        Object.entries(cards).forEach(([cardNumber, total]) => {
            const remaining = total - (allocated[cardNumber] || 0);
            if (remaining <= 0) return;
            const key = normalVariantKey(cardNumber);
            normalized[key] = (normalized[key] || 0) + remaining;
        });
        return normalized;
    }

    function aggregateVariantCounts(variantCounts = {}, maxCopies = DEFAULT_MAX_COPIES) {
        const cards = {};
        if (!variantCounts || typeof variantCounts !== 'object' || Array.isArray(variantCounts)) return cards;
        Object.entries(variantCounts).forEach(([key, rawCount]) => {
            const parsed = parseVariantKey(key);
            if (!parsed) return;
            const count = clampCount(rawCount, maxCopies);
            if (count <= 0) return;
            cards[parsed.cardNumber] = Math.min((cards[parsed.cardNumber] || 0) + count, maxCopies);
        });
        return cards;
    }

    function setVariantCount(cardCounts, variantCounts, key, requestedCount, maxCopies = DEFAULT_MAX_COPIES) {
        const parsed = parseVariantKey(key);
        if (!parsed) {
            return {
                cards: normalizeCardCounts(cardCounts, maxCopies),
                cardVariants: normalizeVariantCounts(cardCounts, variantCounts, maxCopies)
            };
        }

        const normalized = normalizeVariantCounts(cardCounts, variantCounts, maxCopies);
        const normalizedKey = `${parsed.cardNumber}${KEY_SEPARATOR}${parsed.variantId}`;
        const otherCount = Object.entries(normalized).reduce((sum, [entryKey, rawCount]) => {
            const entry = parseVariantKey(entryKey);
            return entry?.cardNumber === parsed.cardNumber && entryKey !== normalizedKey
                ? sum + clampCount(rawCount, maxCopies)
                : sum;
        }, 0);
        const nextCount = Math.min(clampCount(requestedCount, maxCopies), Math.max(0, maxCopies - otherCount));
        if (nextCount > 0) normalized[normalizedKey] = nextCount;
        else delete normalized[normalizedKey];

        return {
            cards: aggregateVariantCounts(normalized, maxCopies),
            cardVariants: normalized
        };
    }

    function setCardCount(cardCounts, variantCounts, rawCardNumber, requestedCount, maxCopies = DEFAULT_MAX_COPIES) {
        const cardNumber = String(rawCardNumber || '').trim().toUpperCase();
        const normalized = normalizeVariantCounts(cardCounts, variantCounts, maxCopies);
        if (!cardNumber) {
            return {
                cards: aggregateVariantCounts(normalized, maxCopies),
                cardVariants: normalized
            };
        }

        const targetCount = clampCount(requestedCount, maxCopies);
        const matchingKeys = Object.keys(normalized).filter(key => parseVariantKey(key)?.cardNumber === cardNumber);
        if (targetCount === 0) {
            matchingKeys.forEach(key => delete normalized[key]);
        } else {
            const currentCount = matchingKeys.reduce((sum, key) => sum + normalized[key], 0);
            const normalKey = normalVariantKey(cardNumber);
            if (targetCount > currentCount) {
                normalized[normalKey] = (normalized[normalKey] || 0) + targetCount - currentCount;
            } else if (targetCount < currentCount) {
                let removeCount = currentCount - targetCount;
                const removalOrder = [normalKey, ...matchingKeys.filter(key => key !== normalKey).reverse()];
                removalOrder.forEach(key => {
                    if (removeCount <= 0 || !normalized[key]) return;
                    const removed = Math.min(normalized[key], removeCount);
                    normalized[key] -= removed;
                    removeCount -= removed;
                    if (normalized[key] <= 0) delete normalized[key];
                });
            }
        }

        return {
            cards: aggregateVariantCounts(normalized, maxCopies),
            cardVariants: normalized
        };
    }

    function compactVariantCounts(cardCounts = {}, variantCounts = {}, maxCopies = DEFAULT_MAX_COPIES) {
        const normalized = normalizeVariantCounts(cardCounts, variantCounts, maxCopies);
        return Object.fromEntries(Object.entries(normalized).filter(([key]) => {
            const parsed = parseVariantKey(key);
            return parsed && parsed.variantId !== parsed.cardNumber;
        }));
    }

    global.OPTCGDeckVariants = Object.freeze({
        aggregateVariantCounts,
        compactVariantCounts,
        normalVariantKey,
        normalizeCardCounts,
        normalizeVariantCounts,
        parseVariantKey,
        setCardCount,
        setVariantCount
    });
})(window);
