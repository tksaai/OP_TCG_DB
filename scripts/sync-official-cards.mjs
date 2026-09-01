import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    applyBlockIconRules,
    normalizeBlockValue,
    normalizeCardNumber
} from './block-icon-rules.mjs';
import { preferOfficialCardVariant, stripOfficialSyncMetadata } from './official-card-utils.mjs';

const OFFICIAL_BASE_URL = 'https://www.onepiece-cardgame.com';
const PROMO_SERIES = 'PROMO';
const PROMO_CATEGORY_ID = '550901';
const OFFICIAL_IMAGE_SOURCES_JSON = 'official-image-sources.json';
const CARDS_JSON = 'cards.json';
const PROVISIONAL_CARDS_JSON = 'provisional-cards.json';
const BLOCK_ICON_OVERRIDES_JSON = 'block-icon-overrides.json';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const onlyCards = new Set(args.filter(arg => arg.startsWith('--card=')).map(arg => arg.split('=')[1].toUpperCase()));
const seriesList = args
    .filter(arg => arg.startsWith('--series='))
    .flatMap(arg => arg.split('=')[1].split(','))
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);

function decodeHtml(value = '') {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractDiv(body, className) {
    const match = body.match(new RegExp(`<div class="${className}">([\\s\\S]*?)<\\/div>`, 'i'));
    return match ? match[1] : '';
}

function extractLabeledValue(body, className) {
    const raw = extractDiv(body, className);
    const label = decodeHtml(raw.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1] || '');
    const value = decodeHtml(raw.replace(/<h3>[\s\S]*?<\/h3>/i, ''));
    return { label, value };
}

function normalizeNumber(value) {
    const text = String(value || '').trim();
    if (!text || text === '-') return text || '-';
    const number = Number(text.replace(/,/g, ''));
    return Number.isFinite(number) ? number : text;
}

function isMissingValue(value) {
    if (value === undefined || value === null) return true;
    const text = String(value).trim();
    return text === '' || text === '-';
}

function mergeMissingOfficialFields(existingCard, officialCard) {
    const merged = { ...existingCard };
    let changed = false;
    const fields = [
        'furigana',
        'costLifeType',
        'costLifeValue',
        'power',
        'counter',
        'attribute',
        'block',
        'effectText',
        'trigger',
        'getInfo',
        'seriesTitle',
        'seriesCode',
        'sourceModalId'
    ];

    for (const field of fields) {
        if (field === 'block') {
            const officialBlock = normalizeBlockValue(officialCard[field]);
            if (officialBlock && normalizeBlockValue(merged[field]) !== officialBlock) {
                merged[field] = officialCard[field];
                changed = true;
            }
            continue;
        }
        if (isMissingValue(merged[field]) && !isMissingValue(officialCard[field])) {
            merged[field] = officialCard[field];
            changed = true;
        }
    }

    if ((!Array.isArray(merged.features) || merged.features.length === 0) && Array.isArray(officialCard.features) && officialCard.features.length > 0) {
        merged.features = officialCard.features;
        changed = true;
    }

    if ((!Array.isArray(merged.color) || merged.color.length === 0) && Array.isArray(officialCard.color) && officialCard.color.length > 0) {
        merged.color = officialCard.color;
        changed = true;
    }

    return { card: merged, changed };
}

function splitList(value) {
    return String(value || '')
        .split(/[／/]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseSeries(getInfo) {
    const seriesCode = getInfo.match(/【([^】]+)】/)?.[1] || '';
    const seriesTitle = getInfo
        .replace(/【[^】]+】/g, '')
        .replace(/^ブースターパック\s*/u, '')
        .replace(/^スタートデッキ\s*/u, '')
        .trim();
    return { seriesCode, seriesTitle };
}

function parseOfficialCards(html, allowedPrefixes = new Set(), allowedCards = new Set()) {
    const cards = [];
    const modalRegex = /<dl class="modalCol" id="([^"]+)">([\s\S]*?)<\/dl>/g;
    let match;

    while ((match = modalRegex.exec(html))) {
        const [, modalId, body] = match;
        const infoMatch = body.match(/<div class="infoCol">\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>/s);
        if (!infoMatch) continue;

        const cardNumber = decodeHtml(infoMatch[1]).toUpperCase();
        const cardPrefix = cardNumber.split('-')[0];
        if (allowedPrefixes.size > 0 && !allowedPrefixes.has(cardPrefix)) continue;
        if (allowedCards.size > 0 && !allowedCards.has(cardNumber)) continue;

        const cardName = decodeHtml(body.match(/<div class="cardName">([\s\S]*?)<\/div>/)?.[1] || '');
        const costLife = extractLabeledValue(body, 'cost');
        const power = extractLabeledValue(body, 'power').value || '-';
        const counter = extractLabeledValue(body, 'counter').value || '-';
        const color = splitList(extractLabeledValue(body, 'color').value);
        const block = normalizeNumber(extractLabeledValue(body, 'block').value);
        const feature = extractLabeledValue(body, 'feature').value;
        const effectText = extractLabeledValue(body, 'text').value;
        const trigger = extractLabeledValue(body, 'trigger').value;
        const getInfo = extractLabeledValue(body, 'getInfo').value;
        const attribute = decodeHtml(extractDiv(body, 'attribute').match(/<img[^>]+alt="([^"]*)"/i)?.[1] || '-');
        const imageUrl = body.match(/<div class="frontCol">[\s\S]*?<img[^>]+data-src="([^"]+)"/s)?.[1] || '';
        const imageFile = imageUrl ? path.basename(new URL(decodeHtml(imageUrl), `${OFFICIAL_BASE_URL}/cardlist/`).pathname) : 'official';
        const imageStem = path.basename(imageFile, path.extname(imageFile));
        const parallelMatch = imageStem.match(/_p(\d+)$/i);
        const rarityMatch = imageStem.match(/_r(\d+)$/i);
        const sourceVariantIndex = rarityMatch
            ? 1000 + Number(rarityMatch[1])
            : parallelMatch ? Number(parallelMatch[1]) : 0;
        const series = parseSeries(getInfo);

        cards.push({
            uniqueId: `${cardNumber}_${imageFile}`,
            cardNumber,
            cardName,
            furigana: '',
            rarity: decodeHtml(infoMatch[2]),
            cardType: decodeHtml(infoMatch[3]),
            color,
            costLifeType: costLife.label || '',
            costLifeValue: normalizeNumber(costLife.value),
            power: normalizeNumber(power),
            counter,
            attribute,
            features: splitList(feature),
            block,
            effectText,
            trigger,
            getInfo,
            seriesTitle: series.seriesTitle,
            seriesCode: series.seriesCode,
            sourceModalId: modalId,
            _sourceVariantIndex: sourceVariantIndex
        });
    }

    return cards.sort((a, b) => a.cardNumber.localeCompare(b.cardNumber, 'en', { numeric: true }));
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OP_TCG_DB card sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
}

async function readOptionalCards(filePath) {
    try {
        const data = JSON.parse(await readFile(filePath, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn(`Skipped optional card data ${filePath}: ${error.message}`);
        }
        return [];
    }
}

function getProvisionalPromoNumbers(cards) {
    return new Set(cards
        .filter(card => String(card?.provisionalScope || '').toUpperCase() === PROMO_SERIES)
        .map(card => normalizeCardNumber(card?.cardNumber))
        .filter(Boolean));
}

function officialSearchUrl(searchValue) {
    if (searchValue === PROMO_SERIES) {
        return `${OFFICIAL_BASE_URL}/cardlist/?series=${PROMO_CATEGORY_ID}`;
    }
    return `${OFFICIAL_BASE_URL}/cardlist/?freewords=${encodeURIComponent(searchValue)}&search=true`;
}

if (seriesList.length === 0 && onlyCards.size === 0) {
    console.error('Specify --series=OP16,PROMO or --card=OP16-001.');
    process.exit(1);
}

const existingCards = JSON.parse(await readFile(CARDS_JSON, 'utf8'));
const byCardNumber = new Map(existingCards.map(card => [String(card.cardNumber || '').toUpperCase(), card]));
const fetchedCards = new Map();
const provisionalPromoNumbers = seriesList.includes(PROMO_SERIES)
    ? getProvisionalPromoNumbers(await readOptionalCards(PROVISIONAL_CARDS_JSON))
    : new Set();

const searches = seriesList.length > 0 ? seriesList : [...onlyCards];
for (const searchValue of searches) {
    const url = officialSearchUrl(searchValue);
    const html = await fetchText(url);
    const allowedPrefixes = searchValue === PROMO_SERIES || seriesList.length === 0
        ? new Set()
        : new Set([searchValue]);
    const parsed = parseOfficialCards(html, allowedPrefixes, onlyCards);
    for (const card of parsed) {
        fetchedCards.set(
            card.cardNumber,
            preferOfficialCardVariant(fetchedCards.get(card.cardNumber), card)
        );
    }
}

const directCardSearches = new Set(onlyCards);
if (seriesList.includes(PROMO_SERIES) && onlyCards.size === 0) {
    for (const cardNumber of provisionalPromoNumbers) {
        if (force || (!byCardNumber.has(cardNumber) && !fetchedCards.has(cardNumber))) {
            directCardSearches.add(cardNumber);
        }
    }
}

for (const cardNumber of directCardSearches) {
    if (fetchedCards.has(cardNumber)) continue;
    const html = await fetchText(officialSearchUrl(cardNumber));
    const parsed = parseOfficialCards(html, new Set(), new Set([cardNumber]));
    for (const card of parsed) {
        fetchedCards.set(
            card.cardNumber,
            preferOfficialCardVariant(fetchedCards.get(card.cardNumber), card)
        );
    }
}

let added = 0;
let updated = 0;
let patchedMissing = 0;
let skipped = 0;
for (const fetchedCard of fetchedCards.values()) {
    const card = stripOfficialSyncMetadata(fetchedCard);
    if (byCardNumber.has(card.cardNumber)) {
        if (force) {
            byCardNumber.set(card.cardNumber, { ...byCardNumber.get(card.cardNumber), ...card });
            updated++;
        } else {
            const { card: patchedCard, changed } = mergeMissingOfficialFields(byCardNumber.get(card.cardNumber), card);
            if (changed) {
                byCardNumber.set(card.cardNumber, patchedCard);
                patchedMissing++;
            } else {
                skipped++;
            }
        }
        continue;
    }
    byCardNumber.set(card.cardNumber, card);
    added++;
}

const nextCards = [...byCardNumber.values()].sort((a, b) => {
    const prefixCompare = String(a.cardNumber || '').split('-')[0].localeCompare(String(b.cardNumber || '').split('-')[0]);
    return prefixCompare || String(a.cardNumber || '').localeCompare(String(b.cardNumber || ''), 'en', { numeric: true });
});
let blockIconOverrideChanged = 0;
try {
    const overrides = JSON.parse(await readFile(BLOCK_ICON_OVERRIDES_JSON, 'utf8'));
    let officialImageSources = {};
    try {
        officialImageSources = JSON.parse(await readFile(OFFICIAL_IMAGE_SOURCES_JSON, 'utf8'));
    } catch {
        // Existing rule data remains usable before the image metadata is generated.
    }
    blockIconOverrideChanged = applyBlockIconRules(nextCards, overrides, { officialImageSources });
} catch (error) {
    console.warn(`Skipped block icon overrides: ${error.message}`);
}

if (!dryRun) {
    await writeFile(CARDS_JSON, `${JSON.stringify(nextCards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    fetched: fetchedCards.size,
    added,
    updated,
    patchedMissing,
    skipped,
    blockIconOverrideChanged,
    totalCards: nextCards.length,
    dryRun
}, null, 2));
