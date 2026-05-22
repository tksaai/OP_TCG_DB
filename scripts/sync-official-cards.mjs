import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OFFICIAL_BASE_URL = 'https://www.onepiece-cardgame.com';
const CARDS_JSON = 'cards.json';

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

function parseOfficialCards(html, allowedSeries = new Set(), allowedCards = new Set()) {
    const cards = [];
    const modalRegex = /<dl class="modalCol" id="([^"]+)">([\s\S]*?)<\/dl>/g;
    let match;

    while ((match = modalRegex.exec(html))) {
        const [, modalId, body] = match;
        const infoMatch = body.match(/<div class="infoCol">\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>/s);
        if (!infoMatch) continue;

        const cardNumber = decodeHtml(infoMatch[1]).toUpperCase();
        const seriesId = cardNumber.split('-')[0];
        if (allowedSeries.size > 0 && !allowedSeries.has(seriesId)) continue;
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
            sourceModalId: modalId
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

if (seriesList.length === 0 && onlyCards.size === 0) {
    console.error('Specify --series=OP16 or --card=OP16-001.');
    process.exit(1);
}

const existingCards = JSON.parse(await readFile(CARDS_JSON, 'utf8'));
const byCardNumber = new Map(existingCards.map(card => [String(card.cardNumber || '').toUpperCase(), card]));
const fetchedCards = new Map();

const searches = seriesList.length > 0 ? seriesList : [...onlyCards];
for (const searchValue of searches) {
    const url = `${OFFICIAL_BASE_URL}/cardlist/?freewords=${encodeURIComponent(searchValue)}&search=true`;
    const html = await fetchText(url);
    const parsed = parseOfficialCards(html, new Set(seriesList), onlyCards);
    for (const card of parsed) {
        fetchedCards.set(card.cardNumber, card);
    }
}

let added = 0;
let updated = 0;
let skipped = 0;
for (const card of fetchedCards.values()) {
    if (byCardNumber.has(card.cardNumber)) {
        if (force) {
            byCardNumber.set(card.cardNumber, { ...byCardNumber.get(card.cardNumber), ...card });
            updated++;
        } else {
            skipped++;
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

if (!dryRun) {
    await writeFile(CARDS_JSON, `${JSON.stringify(nextCards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    fetched: fetchedCards.size,
    added,
    updated,
    skipped,
    totalCards: nextCards.length,
    dryRun
}, null, 2));
