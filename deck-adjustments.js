(function(global) {
    'use strict';

    const MAX_ADJUSTMENTS = 100;
    const MAX_LABEL_LENGTH = 80;
    const MAX_NOTE_LENGTH = 160;

    function normalizeText(value, maxLength) {
        return String(value || '').trim().slice(0, maxLength);
    }

    function createAdjustmentId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return `adjustment-${global.crypto.randomUUID()}`;
        }
        return `adjustment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function normalizeTimestamp(value, fallback = '') {
        const text = String(value || '').trim();
        return text && !Number.isNaN(Date.parse(text)) ? text : fallback;
    }

    function normalizeCounts(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        return Object.fromEntries(Object.entries(value)
            .map(([key, count]) => [normalizeText(key, 160), Number(count)])
            .filter(([key, count]) => key && Number.isInteger(count) && count > 0 && count <= 4)
            .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
    }

    function normalizeSnapshot(value) {
        if (!value || typeof value !== 'object') return null;
        const leader = normalizeText(value.leader, 40);
        if (!leader) return null;
        const cards = normalizeCounts(value.cards);
        const cardVariants = normalizeCounts(value.cardVariants);
        const leaderVariantId = normalizeText(value.leaderVariantId, 160);
        return {
            leader,
            cards,
            ...(Object.keys(cardVariants).length > 0 ? { cardVariants } : {}),
            ...(leaderVariantId && leaderVariantId !== leader ? { leaderVariantId } : {})
        };
    }

    function getDefaultLabel(index) {
        return index === 0 ? '記録開始時' : `調整 ${index}`;
    }

    function normalizeAdjustment(value, index = 0) {
        const snapshot = normalizeSnapshot(value);
        if (!snapshot) return null;
        const now = new Date().toISOString();
        return {
            id: normalizeText(value.id, 120) || createAdjustmentId(),
            label: normalizeText(value.label, MAX_LABEL_LENGTH) || getDefaultLabel(index),
            note: normalizeText(value.note, MAX_NOTE_LENGTH),
            ...snapshot,
            createdAt: normalizeTimestamp(value.createdAt, now)
        };
    }

    function normalizeAdjustmentHistory(records) {
        if (!Array.isArray(records)) return [];
        const normalized = records
            .map((record, index) => normalizeAdjustment(record, index))
            .filter(Boolean);
        return normalized.slice(Math.max(0, normalized.length - MAX_ADJUSTMENTS));
    }

    function createCompositionSignature(value) {
        const snapshot = normalizeSnapshot(value);
        return snapshot ? JSON.stringify(snapshot) : '';
    }

    function isSameComposition(left, right) {
        const leftSignature = createCompositionSignature(left);
        return Boolean(leftSignature) && leftSignature === createCompositionSignature(right);
    }

    function findAdjustment(records, adjustmentId) {
        const id = normalizeText(adjustmentId, 120);
        return normalizeAdjustmentHistory(records).find(record => record.id === id) || null;
    }

    function resolveActiveAdjustmentId(records, snapshot, adjustmentId = '') {
        const history = normalizeAdjustmentHistory(records);
        const active = history.find(record => record.id === adjustmentId);
        if (active && isSameComposition(active, snapshot)) return active.id;
        const latest = history[history.length - 1];
        return latest && isSameComposition(latest, snapshot) ? latest.id : '';
    }

    function recordAdjustment(records, snapshotValue, options = {}) {
        const history = normalizeAdjustmentHistory(records);
        const snapshot = normalizeSnapshot(snapshotValue);
        if (!snapshot) throw new Error('調整履歴へ保存するデッキ構成を確認できません。');

        const activeAdjustmentId = resolveActiveAdjustmentId(
            history,
            snapshot,
            options.activeAdjustmentId
        );
        if (activeAdjustmentId) {
            return { adjustments: history, activeAdjustmentId, created: null };
        }
        const note = normalizeText(options.note, MAX_NOTE_LENGTH);
        const retainedHistory = history.length >= MAX_ADJUSTMENTS
            ? history.slice(history.length - MAX_ADJUSTMENTS + 1)
            : history;
        const created = {
            id: createAdjustmentId(),
            label: normalizeText(note, MAX_LABEL_LENGTH) || getDefaultLabel(history.length),
            note,
            ...snapshot,
            createdAt: new Date().toISOString()
        };
        return {
            adjustments: [...retainedHistory, created],
            activeAdjustmentId: created.id,
            created
        };
    }

    function summarizeAdjustmentChange(previousValue, currentValue) {
        const previous = normalizeSnapshot(previousValue);
        const current = normalizeSnapshot(currentValue);
        if (!current) return { added: 0, removed: 0, changedTypes: 0, leaderChanged: false };
        if (!previous) {
            return {
                added: Object.values(current.cards).reduce((sum, count) => sum + count, 0),
                removed: 0,
                changedTypes: Object.keys(current.cards).length,
                leaderChanged: true
            };
        }
        const cardNumbers = new Set([...Object.keys(previous.cards), ...Object.keys(current.cards)]);
        let added = 0;
        let removed = 0;
        let changedTypes = 0;
        cardNumbers.forEach(cardNumber => {
            const before = Number(previous.cards[cardNumber] || 0);
            const after = Number(current.cards[cardNumber] || 0);
            if (before === after) return;
            changedTypes += 1;
            if (after > before) added += after - before;
            else removed += before - after;
        });
        return {
            added,
            removed,
            changedTypes,
            leaderChanged: previous.leader !== current.leader
                || (previous.leaderVariantId || previous.leader) !== (current.leaderVariantId || current.leader)
        };
    }

    global.OPTCGDeckAdjustments = Object.freeze({
        MAX_ADJUSTMENTS,
        MAX_LABEL_LENGTH,
        MAX_NOTE_LENGTH,
        normalizeSnapshot,
        normalizeAdjustmentHistory,
        createCompositionSignature,
        isSameComposition,
        findAdjustment,
        resolveActiveAdjustmentId,
        recordAdjustment,
        summarizeAdjustmentChange
    });
})(typeof window !== 'undefined' ? window : globalThis);
