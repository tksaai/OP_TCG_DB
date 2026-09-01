const CARD_NUMBER_PATTERN = /\b(?:[A-Z]{1,3}\d{0,2})-\d{3}\b/g;
const BLOCK_SECTION_PATTERN = /ブロックアイコン\s*([X0-9①-⑳]+)\s*として使用可能なカード/g;

function decodeHtml(value = '') {
    return String(value)
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeCardNumber(value) {
    return String(value || '').trim().toUpperCase();
}

export function normalizeBlockValue(value) {
    if (value === undefined || value === null) return '';
    const normalized = String(value).trim().toUpperCase();
    if (!normalized || normalized === 'NAN') return '';
    return normalized;
}

function normalizeCircledNumber(value) {
    const normalized = normalizeBlockValue(value);
    if (normalized === 'X' || /^\d+$/.test(normalized)) return normalized;

    const codePoint = normalized.codePointAt(0);
    if (codePoint >= 0x2460 && codePoint <= 0x2473) {
        return String(codePoint - 0x245f);
    }
    return '';
}

function uniqueCardNumbers(value) {
    return [...new Set((String(value).match(CARD_NUMBER_PATTERN) || []).map(normalizeCardNumber))].sort((a, b) => (
        a.localeCompare(b, 'en', { numeric: true })
    ));
}

function cardNumberFromImagePath(filePath) {
    return normalizeCardNumber(
        String(filePath || '').match(/(?:^|[\\/])([A-Z]{1,3}\d{0,2}-\d{3})(?=[_.])/i)?.[1]
    );
}

export function getSuperParallelXCardNumbers(rules = {}, officialImageSources = {}) {
    const configured = Array.isArray(rules.superParallelXCardNumbers)
        ? rules.superParallelXCardNumbers
        : Array.isArray(rules.legacySuperParallelX)
            ? rules.legacySuperParallelX
            : Array.isArray(rules.standardEligibleCardNumbers)
                ? rules.standardEligibleCardNumbers
                : [];
    const cardNumbers = new Set(configured.map(normalizeCardNumber).filter(Boolean));

    for (const [filePath, metadata] of Object.entries(officialImageSources || {})) {
        if (metadata?.source !== 'official' || normalizeBlockValue(metadata.block) !== 'X') continue;
        const cardNumber = cardNumberFromImagePath(filePath);
        if (cardNumber) cardNumbers.add(cardNumber);
    }

    return [...cardNumbers].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function parseBlockIconRulesPage(html, sourceUrl) {
    const text = decodeHtml(html);
    const standardHeading = 'スタンダードレギュレーションで原則使用可能なカード';
    const standardStart = text.indexOf(standardHeading);
    if (standardStart < 0) {
        throw new Error('Standard regulation section was not found.');
    }

    BLOCK_SECTION_PATTERN.lastIndex = standardStart + standardHeading.length;
    const firstBlockSection = BLOCK_SECTION_PATTERN.exec(text);
    if (!firstBlockSection) {
        throw new Error('Block icon override section was not found.');
    }

    const standardSection = text.slice(standardStart + standardHeading.length, firstBlockSection.index);
    const superParallelXCardNumbers = uniqueCardNumbers(standardSection);
    const blockIconOverrides = {};

    BLOCK_SECTION_PATTERN.lastIndex = firstBlockSection.index;
    let match;
    while ((match = BLOCK_SECTION_PATTERN.exec(text))) {
        const block = normalizeCircledNumber(match[1]);
        if (!block) continue;
        const sectionStart = BLOCK_SECTION_PATTERN.lastIndex;
        const nextSection = text.slice(sectionStart).search(/ブロックアイコン\s*(?:[X0-9①-⑳]+\s*として使用可能なカード|を更新)|関連ページ/);
        const sectionEnd = nextSection < 0 ? text.length : sectionStart + nextSection;
        for (const cardNumber of uniqueCardNumbers(text.slice(sectionStart, sectionEnd))) {
            blockIconOverrides[cardNumber] = block;
        }
        BLOCK_SECTION_PATTERN.lastIndex = sectionEnd;
    }

    if (superParallelXCardNumbers.length === 0 || Object.keys(blockIconOverrides).length === 0) {
        throw new Error('Parsed block icon rules were unexpectedly empty.');
    }

    const dateMatch = text.match(/ブロックアイコン更新対象カード一覧\s*(\d{4})[./年]\s*(\d{1,2})[./月]\s*(\d{1,2})/);
    const updatedAt = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
        : '';

    return {
        sourceUrl: sourceUrl || '',
        updatedAt,
        superParallelXCardNumbers,
        blockIconOverrides: Object.fromEntries(
            Object.entries(blockIconOverrides).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        )
    };
}

export function applyBlockIconRules(cards, rules, { officialImageSources = {} } = {}) {
    const superParallelX = new Set(getSuperParallelXCardNumbers(rules, officialImageSources));
    const blockIconOverrides = rules?.blockIconOverrides && typeof rules.blockIconOverrides === 'object'
        ? rules.blockIconOverrides
        : {};

    let changed = 0;
    for (const card of cards) {
        const cardNumber = normalizeCardNumber(card?.cardNumber);
        const override = superParallelX.has(cardNumber)
            ? 'X'
            : normalizeBlockValue(blockIconOverrides[cardNumber]);

        if (override) {
            if (card.blockIconOverride !== override) changed++;
            card.blockIconOverride = override;
        } else if (Object.prototype.hasOwnProperty.call(card, 'blockIconOverride')) {
            delete card.blockIconOverride;
            changed++;
        }

        if (Object.prototype.hasOwnProperty.call(card, 'standardLegalOverride')) {
            delete card.standardLegalOverride;
            changed++;
        }
    }

    return changed;
}
