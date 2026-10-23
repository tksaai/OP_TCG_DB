function decodeHtml(value = '') {
    return String(value)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeSeriesCode(value) {
    return String(value || '').replace(/-/g, '').trim().toUpperCase();
}

function seriesParts(code) {
    const match = normalizeSeriesCode(code).match(/^([A-Z][A-Z0-9]*?)(\d+)$/);
    return match
        ? { family: match[1], number: Number(match[2]) }
        : { family: normalizeSeriesCode(code), number: -1 };
}

function compareSeries(a, b) {
    const left = seriesParts(a.code);
    const right = seriesParts(b.code);
    return left.family.localeCompare(right.family)
        || left.number - right.number
        || a.code.localeCompare(b.code);
}

export function parseOfficialSeries(html) {
    const seriesByCode = new Map();
    const optionRegex = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(String(html || '')))) {
        const label = decodeHtml(match[1]);
        const rawCode = label.match(/【([A-Z][A-Z0-9]*-\d+)】/i)?.[1];
        if (!rawCode) continue;
        const code = normalizeSeriesCode(rawCode);
        if (!seriesByCode.has(code)) {
            seriesByCode.set(code, { code, label });
        }
    }
    return [...seriesByCode.values()].sort(compareSeries);
}

export function selectAutomaticSeries(officialSeries, cardNumbers) {
    const existingSeries = new Set(
        [...cardNumbers]
            .map(cardNumber => String(cardNumber || '').trim().toUpperCase().split('-')[0])
            .filter(Boolean)
    );
    const latestByFamily = new Map();
    const missing = [];

    for (const series of officialSeries) {
        const parts = seriesParts(series.code);
        const current = latestByFamily.get(parts.family);
        if (!current || parts.number > seriesParts(current.code).number) {
            latestByFamily.set(parts.family, series);
        }
        if (!existingSeries.has(series.code)) missing.push(series);
    }

    const selected = new Map();
    for (const series of latestByFamily.values()) selected.set(series.code, series);
    for (const series of missing) selected.set(series.code, series);

    return {
        latest: [...latestByFamily.values()].sort(compareSeries),
        missing: missing.sort(compareSeries),
        selected: [...selected.values()].sort(compareSeries)
    };
}
