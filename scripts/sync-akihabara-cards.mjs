import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const AKIHABARA_BASE_URL = 'https://akihabara-cardshop.com';
const AKIHABARA_INDEX_URL = `${AKIHABARA_BASE_URL}/card-list-op/`;
const AKIHABARA_PROMO_INDEX_URL = `${AKIHABARA_BASE_URL}/card-list-op-promo/`;
const PROVISIONAL_CARDS_JSON = 'provisional-cards.json';
const PROVISIONAL_SOURCE = 'akihabara-cardshop';
const PROMO_SCOPE = 'PROMO';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function argValue(name, fallback = '') {
    const arg = args.find(item => item === `--${name}` || item.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const [, value = 'true'] = arg.split('=');
    return value;
}

function splitArgList(value = '') {
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function decodeHtml(value = '') {
    return String(value)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSeriesCode(value) {
    return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function hyphenateSeriesCode(value) {
    const normalized = normalizeSeriesCode(value);
    const match = normalized.match(/^([A-Z]+)(\d+)$/);
    return match ? `${match[1]}-${match[2]}` : normalized;
}

function buildSeriesUrl(seriesCode) {
    const normalized = normalizeSeriesCode(seriesCode);
    if (normalized === 'AUTO' || normalized === 'LATEST') return AKIHABARA_INDEX_URL;
    if (normalized === PROMO_SCOPE) return AKIHABARA_PROMO_INDEX_URL;
    const match = normalized.match(/^([A-Z]+)(\d+)$/);
    if (!match) throw new Error(`Cannot build Akihabara URL for series: ${seriesCode}`);
    return `${AKIHABARA_BASE_URL}/${match[1].toLowerCase()}-${Number(match[2])}/`;
}

function absoluteUrl(url, baseUrl = AKIHABARA_BASE_URL) {
    return new URL(decodeHtml(url), baseUrl).href;
}

function normalizeDash(value) {
    const text = decodeHtml(value).replace(/[‐‑‒–—―−]/g, '-').trim();
    return text === '' ? '-' : text;
}

function normalizeNumber(value) {
    const text = normalizeDash(value);
    if (!text || text === '-') return '-';
    const number = Number(text.replace(/,/g, ''));
    return Number.isFinite(number) ? number : text;
}

function splitList(value) {
    return decodeHtml(value)
        .split(/[\/／]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function extractFirst(html, regex) {
    return html.match(regex)?.[1] || '';
}

function extractStatMap(html) {
    const stats = new Map();
    const statRegex = /<div class="stat-item">\s*<span class="stat-label">([\s\S]*?)<\/span>\s*<span class="stat-value">([\s\S]*?)<\/span>\s*<\/div>/g;
    let match;
    while ((match = statRegex.exec(html))) {
        stats.set(decodeHtml(match[1]), decodeHtml(match[2]));
    }
    return stats;
}

function extractBaseCardNumber(value) {
    return String(value || '').match(/((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})/i)?.[1]?.toUpperCase() || '';
}

function parseSourceUpdatedAt(html) {
    return html.match(/\((\d{4}-\d{2}-\d{2}):\s*最終更新\)/)?.[1] || '';
}

function parseSeriesInfo(html, fallbackSeriesCode) {
    const h1 = decodeHtml(extractFirst(html, /<h1 class="series-title">([\s\S]*?)<\/h1>/i));
    const pageTitle = decodeHtml(extractFirst(html, /<title>([\s\S]*?)<\/title>/i));
    const titleSource = h1 || pageTitle;
    const detectedCode = titleSource.match(/【([A-Z]+-?\d+)】/i)?.[1] || fallbackSeriesCode;
    const seriesCode = hyphenateSeriesCode(detectedCode);
    const seriesTitle = titleSource
        .replace(/【[^】]+】/g, '')
        .replace(/\s*収録カードリスト.*$/u, '')
        .trim() || `シリーズ ${seriesCode}`;

    return {
        seriesCode,
        seriesId: normalizeSeriesCode(seriesCode),
        seriesTitle
    };
}

function parseCardItem(html, sourceUrl, sourceUpdatedAt, seriesInfo, scope) {
    const rawNumber = decodeHtml(extractFirst(html, /data-number="([^"]+)"/i));
    const cardNumber = extractBaseCardNumber(rawNumber);
    if (!cardNumber) return null;

    const imageSrc = extractFirst(html, /<img\b[^>]*\bsrc="([^"]+)"/i);
    const imageUrl = imageSrc ? absoluteUrl(imageSrc, sourceUrl) : '';
    const cardName = decodeHtml(extractFirst(html, /<h3 class="card-title">([\s\S]*?)<\/h3>/i));
    const rarity = decodeHtml(extractFirst(html, /<div class="rarity[^"]*">([\s\S]*?)<\/div>/i));
    const cardType = decodeHtml(extractFirst(html, /<div class="group-badge">([\s\S]*?)<\/div>/i)).toUpperCase();
    const attribute = decodeHtml(extractFirst(html, /<div class="attribute-icon[^"]*">([\s\S]*?)<\/div>/i)) || '-';
    const stats = extractStatMap(html);
    const cost = normalizeNumber(stats.get('コスト'));
    const life = normalizeNumber(stats.get('ライフ'));
    const feature = extractFirst(html, /<span class="feature-value">([\s\S]*?)<\/span>/i);
    const effectText = decodeHtml(extractFirst(html, /<div class="text-content">([\s\S]*?)<\/div>/i));
    const trigger = decodeHtml(extractFirst(html, /<div class="trigger-content">([\s\S]*?)<\/div>/i));
    const imageFile = imageUrl ? path.basename(new URL(imageUrl).pathname) : 'akihabara';

    return {
        uniqueId: `${cardNumber}_${imageFile}`,
        cardNumber,
        rawNumber,
        cardName,
        furigana: '',
        rarity,
        cardType,
        color: splitList(stats.get('色')),
        costLifeType: cardType === 'LEADER' ? 'ライフ' : 'コスト',
        costLifeValue: cardType === 'LEADER' ? life : cost,
        power: normalizeNumber(stats.get('パワー')),
        counter: normalizeNumber(stats.get('カウンター')),
        attribute,
        features: splitList(feature),
        block: normalizeNumber(stats.get('ブロックアイコン')),
        effectText,
        trigger,
        getInfo: `${seriesInfo.seriesTitle}【${seriesInfo.seriesCode}】`,
        seriesTitle: seriesInfo.seriesTitle,
        seriesCode: seriesInfo.seriesCode,
        sourceModalId: rawNumber || cardNumber,
        imagePath: imageUrl,
        provisionalSource: PROVISIONAL_SOURCE,
        provisionalScope: scope,
        provisionalSourceUrl: sourceUrl,
        provisionalUpdatedAt: sourceUpdatedAt
    };
}

function parseAkihabaraCards(html, sourceUrl, fallbackSeriesCode, options = {}) {
    const sourceUpdatedAt = parseSourceUpdatedAt(html);
    const seriesInfo = parseSeriesInfo(html, fallbackSeriesCode);
    const scope = options.scope || seriesInfo.seriesId;
    const cards = new Map();

    const parts = html.split(/(?=<!-- Card:)/g);
    for (const part of parts) {
        if (!part.includes('class="card-item"')) continue;
        const itemHtml = part.slice(part.indexOf('<div class="card-item"'));
        const card = parseCardItem(itemHtml, sourceUrl, sourceUpdatedAt, seriesInfo, scope);
        if (!card) continue;
        if (options.scopeFromCardPrefix) {
            card.provisionalScope = card.cardNumber.split('-')[0];
        }

        const isSeriesCard = card.cardNumber.split('-')[0] === seriesInfo.seriesId;
        const isBasePrinting = card.rawNumber.toUpperCase() === card.cardNumber;
        const shouldInclude = options.includePromos ? isBasePrinting : isSeriesCard && isBasePrinting;
        if (!shouldInclude) continue;

        cards.set(options.keyByUniqueId ? card.uniqueId : card.cardNumber, card);
    }

    return {
        cards: [...cards.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber, 'en', { numeric: true })),
        sourceUpdatedAt,
        seriesInfo,
        scopesToReplace: [...new Set([...cards.values()].map(card => getCardScope(card)))]
    };
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OP_TCG_DB provisional Akihabara sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    return response.text();
}

async function readJsonArray(filePath) {
    try {
        const data = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(data)) throw new Error(`${filePath} must contain a JSON array.`);
        return data;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function readOfficialCardNumbers() {
    try {
        const cards = JSON.parse(await readFile('cards.json', 'utf8'));
        return new Set(cards.map(card => String(card.cardNumber || '').toUpperCase()).filter(Boolean));
    } catch (error) {
        console.warn(`Could not read cards.json for auto filtering: ${error.message}`);
        return new Set();
    }
}

function discoverSeriesUrl(indexHtml, seriesCode) {
    const normalized = normalizeSeriesCode(seriesCode);
    const linkRegex = /<a\b[^>]*href="([^"]+)"[^>]*class="card-list-link"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(indexHtml))) {
        const [, href, body] = match;
        if (normalizeSeriesCode(body).includes(normalized) || normalizeSeriesCode(href).includes(normalized)) {
            return absoluteUrl(href);
        }
    }
    return '';
}

function discoverCardListUrls(indexHtml, baseUrl) {
    const urls = [];
    const seen = new Set();
    const linkRegex = /<a\b[^>]*href="([^"]+)"[^>]*class="card-list-link"[^>]*>/gi;
    let match;
    while ((match = linkRegex.exec(indexHtml))) {
        const url = absoluteUrl(match[1], baseUrl);
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
    }
    return urls;
}

function combineParsedPages(parsedPages, scope, seriesTitle) {
    const cards = new Map();
    const sourceUpdatedDates = [];
    const sourceUrls = [];
    const scopesToReplace = new Set();

    for (const parsed of parsedPages) {
        if (parsed.sourceUpdatedAt) sourceUpdatedDates.push(parsed.sourceUpdatedAt);
        if (parsed.sourceUrl) sourceUrls.push(parsed.sourceUrl);
        for (const pageScope of parsed.scopesToReplace || []) {
            scopesToReplace.add(pageScope);
        }
        for (const card of parsed.cards) {
            scopesToReplace.add(getCardScope(card));
            cards.set(card.uniqueId || card.cardNumber, card);
        }
    }

    return {
        cards: [...cards.values()].sort(sortCards),
        sourceUpdatedAt: sourceUpdatedDates.sort().at(-1) || '',
        sourceUrls,
        scopesToReplace: [...scopesToReplace],
        seriesInfo: {
            seriesCode: scope,
            seriesId: scope,
            seriesTitle
        }
    };
}

function normalizeForCompare(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeForCompare);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((normalized, key) => {
                normalized[key] = normalizeForCompare(value[key]);
                return normalized;
            }, {});
    }
    return value;
}

function isSameCard(left, right) {
    return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
}

function getCardScope(card) {
    return card?.provisionalScope || String(card?.cardNumber || '').toUpperCase().split('-')[0];
}

function isCardInScope(card, scope) {
    return getCardScope(card) === scope;
}

function getCardSyncKey(card) {
    return String(card?.uniqueId || card?.cardNumber || '').toUpperCase();
}

function cardSummaryId(card) {
    return card?.uniqueId || card?.cardNumber || '';
}

function sortCards(a, b) {
    const prefixCompare = String(a.cardNumber || '').split('-')[0].localeCompare(String(b.cardNumber || '').split('-')[0]);
    return prefixCompare
        || String(a.cardNumber || '').localeCompare(String(b.cardNumber || ''), 'en', { numeric: true })
        || String(a.uniqueId || '').localeCompare(String(b.uniqueId || ''), 'en', { numeric: true });
}

const inputPath = argValue('input');
const inputListPaths = splitArgList(argValue('input-list'));
const inputListUrls = splitArgList(argValue('url-list'));
const outputPath = argValue('output', PROVISIONAL_CARDS_JSON);
const requestedSeries = normalizeSeriesCode(argValue('series', 'OP17'));
const isPromoSync = requestedSeries === PROMO_SCOPE;
const isAutoSync = requestedSeries === 'AUTO' || requestedSeries === 'LATEST';
let sourceUrl = argValue('url');

if (!sourceUrl) {
    if (inputPath || inputListPaths.length > 0) {
        sourceUrl = buildSeriesUrl(requestedSeries);
    } else {
        const indexUrl = argValue('index-url', isPromoSync ? AKIHABARA_PROMO_INDEX_URL : AKIHABARA_INDEX_URL);
        try {
            sourceUrl = (isPromoSync || isAutoSync) ? indexUrl : discoverSeriesUrl(await fetchText(indexUrl), requestedSeries);
        } catch (error) {
            console.warn(`Could not discover Akihabara URL from index: ${error.message}`);
        }
        if (!sourceUrl) {
            sourceUrl = buildSeriesUrl(requestedSeries);
        }
    }
}

let parsed;
if (inputListPaths.length > 0) {
    const officialCardNumbers = isAutoSync ? await readOfficialCardNumbers() : new Set();
    const parsedPages = [];
    for (let index = 0; index < inputListPaths.length; index += 1) {
        const pageSourceUrl = inputListUrls[index] || sourceUrl;
        const html = await readFile(inputListPaths[index], 'utf8');
        const pageParsed = parseAkihabaraCards(html, pageSourceUrl, requestedSeries, {
            includePromos: isPromoSync || isAutoSync,
            keyByUniqueId: isPromoSync,
            scope: isPromoSync ? PROMO_SCOPE : requestedSeries,
            scopeFromCardPrefix: isAutoSync
        });
        parsedPages.push({
            ...pageParsed,
            cards: isAutoSync
                ? pageParsed.cards.filter(card => !officialCardNumbers.has(String(card.cardNumber || '').toUpperCase()))
                : pageParsed.cards,
            sourceUrl: pageSourceUrl
        });
    }
    parsed = combineParsedPages(
        parsedPages,
        isPromoSync ? PROMO_SCOPE : isAutoSync ? 'AUTO' : requestedSeries,
        isPromoSync ? 'プロモカード' : isAutoSync ? '自動検出' : requestedSeries
    );
} else if (isAutoSync) {
    const indexHtml = await fetchText(sourceUrl);
    const pageUrls = discoverCardListUrls(indexHtml, sourceUrl);
    if (pageUrls.length === 0) throw new Error(`No card list links found at ${sourceUrl}`);

    const officialCardNumbers = await readOfficialCardNumbers();
    const parsedPages = [];
    for (const pageUrl of pageUrls) {
        const html = await fetchText(pageUrl);
        const pageParsed = parseAkihabaraCards(html, pageUrl, 'AUTO', {
            includePromos: true,
            scope: 'AUTO',
            scopeFromCardPrefix: true
        });
        parsedPages.push({
            ...pageParsed,
            cards: pageParsed.cards.filter(card => !officialCardNumbers.has(String(card.cardNumber || '').toUpperCase())),
            sourceUrl: pageUrl
        });
    }
    parsed = combineParsedPages(parsedPages, 'AUTO', '自動検出');
} else if (isPromoSync && !inputPath) {
    const indexHtml = await fetchText(sourceUrl);
    const pageUrls = discoverCardListUrls(indexHtml, sourceUrl);
    if (pageUrls.length === 0) throw new Error(`No promo card list links found at ${sourceUrl}`);

    const parsedPages = [];
    for (const pageUrl of pageUrls) {
        const html = await fetchText(pageUrl);
        parsedPages.push({
            ...parseAkihabaraCards(html, pageUrl, PROMO_SCOPE, {
                includePromos: true,
                keyByUniqueId: true,
                scope: PROMO_SCOPE
            }),
            sourceUrl: pageUrl
        });
    }
    parsed = combineParsedPages(parsedPages, PROMO_SCOPE, 'プロモカード');
} else {
    const html = inputPath ? await readFile(inputPath, 'utf8') : await fetchText(sourceUrl);
    parsed = parseAkihabaraCards(html, sourceUrl, requestedSeries, {
        includePromos: isPromoSync,
        keyByUniqueId: isPromoSync,
        scope: requestedSeries
    });
}

if (parsed.cards.length === 0 && !(parsed.scopesToReplace || []).length) {
    throw new Error(`No base cards found for ${parsed.seriesInfo.seriesId} at ${sourceUrl}`);
}

const existingCards = await readJsonArray(outputPath);
const replacementScopes = new Set((parsed.scopesToReplace || [parsed.seriesInfo.seriesId]).filter(Boolean));
const existingSeriesCards = existingCards.filter(card => replacementScopes.has(getCardScope(card)));
const existingSeriesBySyncKey = new Map(existingSeriesCards.map(card => [getCardSyncKey(card), card]));
const parsedBySyncKey = new Map(parsed.cards.map(card => [getCardSyncKey(card), card]));
const addedCards = parsed.cards.filter(card => !existingSeriesBySyncKey.has(getCardSyncKey(card)));
const changedCards = parsed.cards.filter(card => {
    const existingCard = existingSeriesBySyncKey.get(getCardSyncKey(card));
    return existingCard && !isSameCard(existingCard, card);
});
const unchangedCards = parsed.cards.filter(card => {
    const existingCard = existingSeriesBySyncKey.get(getCardSyncKey(card));
    return existingCard && isSameCard(existingCard, card);
});
const removedCards = existingSeriesCards.filter(card => !parsedBySyncKey.has(getCardSyncKey(card)));
const replaced = existingSeriesCards.length;
const skipped = force ? 0 : existingCards.length - replaced;
const hasChanges = addedCards.length > 0 || changedCards.length > 0 || removedCards.length > 0;

const nextCards = [
    ...existingCards.filter(card => !replacementScopes.has(getCardScope(card))),
    ...parsed.cards
].sort(sortCards);

if (!dryRun) {
    await writeFile(outputPath, `${JSON.stringify(nextCards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    source: PROVISIONAL_SOURCE,
    output: outputPath,
    sourceUrl,
    sourceUrls: parsed.sourceUrls || [sourceUrl],
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    series: parsed.seriesInfo.seriesId,
    seriesTitle: parsed.seriesInfo.seriesTitle,
    scopes: [...replacementScopes],
    parsed: parsed.cards.length,
    added: addedCards.length,
    changed: changedCards.length,
    unchanged: unchangedCards.length,
    removed: removedCards.length,
    replaced,
    skipped,
    hasChanges,
    addedCards: addedCards.map(cardSummaryId),
    changedCards: changedCards.map(cardSummaryId),
    removedCards: removedCards.map(cardSummaryId),
    totalCards: nextCards.length,
    dryRun
}, null, 2));
