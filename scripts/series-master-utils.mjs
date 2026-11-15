import { normalizeSeriesCode } from './official-series-discovery.mjs';

export const SERIES_MASTER_VERSION = 1;
export const SERIES_MASTER_SOURCE = 'https://www.onepiece-cardgame.com/cardlist/';

function seriesSortKey(value) {
    const normalized = normalizeSeriesCode(value);
    const match = normalized.match(/^([A-Z][A-Z0-9]*?)(\d+)$/);
    return match
        ? { family: match[1], number: Number(match[2]), code: normalized }
        : { family: normalized, number: -1, code: normalized };
}

export function compareSeriesCodes(left, right) {
    if (left === 'P') return 1;
    if (right === 'P') return -1;
    const a = seriesSortKey(left);
    const b = seriesSortKey(right);
    return a.family.localeCompare(b.family)
        || a.number - b.number
        || a.code.localeCompare(b.code);
}

export function getSeriesIdFromCardNumber(cardNumber) {
    return normalizeSeriesCode(String(cardNumber || '').split('-')[0]);
}

export function parseOfficialSeriesEntry(series) {
    const label = String(series?.label || '').replace(/\s+/g, ' ').trim();
    const bracketMatch = label.match(/【([A-Z][A-Z0-9]*-\d+)】$/i);
    const id = normalizeSeriesCode(series?.code || bracketMatch?.[1]);
    if (!id || !bracketMatch) return null;

    const code = bracketMatch[1].toUpperCase();
    const title = label.slice(0, bracketMatch.index).trim();
    if (!title) return null;

    return {
        id,
        entry: {
            code,
            title,
            label: `${title}【${code}】`
        }
    };
}

export function buildSeriesMaster(officialSeries, existingMaster = {}) {
    const entries = {};
    const existingEntries = existingMaster?.entries && typeof existingMaster.entries === 'object'
        ? existingMaster.entries
        : {};

    Object.entries(existingEntries).forEach(([rawId, entry]) => {
        const id = normalizeSeriesCode(rawId);
        if (!id || !entry || typeof entry !== 'object') return;
        entries[id] = {
            code: String(entry.code || '').trim(),
            title: String(entry.title || '').trim(),
            label: String(entry.label || '').trim()
        };
    });

    for (const series of officialSeries || []) {
        const parsed = parseOfficialSeriesEntry(series);
        if (parsed) entries[parsed.id] = parsed.entry;
    }

    entries.P = {
        code: 'P',
        title: 'プロモーションカード',
        label: 'プロモーションカード'
    };

    return {
        version: SERIES_MASTER_VERSION,
        source: SERIES_MASTER_SOURCE,
        entries: Object.fromEntries(
            Object.entries(entries).sort(([left], [right]) => compareSeriesCodes(left, right))
        )
    };
}

export function normalizeCardsWithSeriesMaster(cards, master) {
    const entries = master?.entries && typeof master.entries === 'object' ? master.entries : {};
    const missingSeries = new Set();
    let changedCards = 0;

    const normalizedCards = (Array.isArray(cards) ? cards : []).map(card => {
        if (!card || typeof card !== 'object') return card;
        const seriesId = getSeriesIdFromCardNumber(card.cardNumber);
        const entry = entries[seriesId];
        if (!entry) {
            if (seriesId) missingSeries.add(seriesId);
            return card;
        }

        const seriesCode = String(entry.code || '').trim();
        const seriesTitle = String(entry.title || '').trim();
        if (card.seriesCode === seriesCode && card.seriesTitle === seriesTitle) return card;

        changedCards += 1;
        return {
            ...card,
            seriesCode,
            seriesTitle
        };
    });

    return {
        cards: normalizedCards,
        changedCards,
        missingSeries: [...missingSeries].sort(compareSeriesCodes)
    };
}
