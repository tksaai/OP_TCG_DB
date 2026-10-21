export const FURIGANA_MASTER_VERSION = 1;
export const FURIGANA_STATUSES = new Set(['pending', 'suggested', 'verified']);

export function toKatakana(value = '') {
    return String(value).replace(/[\u3041-\u3096]/g, character => (
        String.fromCharCode(character.charCodeAt(0) + 0x60)
    ));
}

export function normalizeFuriganaReading(value = '') {
    return toKatakana(String(value).normalize('NFKC'))
        .replace(/\s+/g, '')
        .replace(/[^ァ-ヺー・]/g, '');
}

export function createKanaOnlySuggestion(cardName = '') {
    const normalizedName = String(cardName).normalize('NFKC').trim();
    if (!normalizedName || /[一-龯々〆ヶA-Za-z0-9&＆]/u.test(normalizedName)) return '';
    if (!/^[ぁ-んァ-ヺー・･!！?？…。、「」『』（）()【】\[\]〜～\s]+$/u.test(normalizedName)) return '';
    return normalizeFuriganaReading(normalizedName);
}

export function createEmptyFuriganaMaster() {
    return {
        version: FURIGANA_MASTER_VERSION,
        entries: {}
    };
}

export function normalizeMasterEntry(entry = {}) {
    const reading = normalizeFuriganaReading(entry?.reading || '');
    const requestedStatus = FURIGANA_STATUSES.has(entry?.status) ? entry.status : 'pending';
    const status = reading ? requestedStatus : 'pending';
    const normalized = {
        reading,
        status,
        source: String(entry?.source || '').trim() || 'manual'
    };
    if (Array.isArray(entry?.aliases)) {
        const aliases = [...new Set(entry.aliases.map(normalizeFuriganaReading).filter(Boolean))];
        if (aliases.length > 0) normalized.aliases = aliases;
    }
    if (entry?.note) normalized.note = String(entry.note).trim();
    return normalized;
}

export function getVerifiedReading(master, cardName) {
    const entry = master?.entries?.[cardName];
    if (!entry || entry.status !== 'verified') return '';
    return normalizeFuriganaReading(entry.reading);
}

export function applyFuriganaMaster(cards, master, cardOverrides = {}) {
    let changed = 0;
    for (const card of cards) {
        const overrideEntry = cardOverrides?.[card?.cardNumber];
        const override = normalizeFuriganaReading(
            typeof overrideEntry === 'string' ? overrideEntry : overrideEntry?.furigana || ''
        );
        const reading = override || getVerifiedReading(master, card?.cardName);
        if (reading && normalizeFuriganaReading(card?.furigana || '') !== reading) {
            card.furigana = reading;
            changed += 1;
        }
    }
    return changed;
}

export function sortObjectKeys(object) {
    return Object.fromEntries(
        Object.entries(object).sort(([left], [right]) => left.localeCompare(right, 'ja'))
    );
}
