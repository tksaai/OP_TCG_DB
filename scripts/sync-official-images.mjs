import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OFFICIAL_BASE_URL = 'https://www.onepiece-cardgame.com';
const CARDS_JSON = 'cards.json';
const OUTPUT_ROOT = 'Cards';
const METADATA_FILE = 'official-image-sources.json';

const args = process.argv.slice(2);
const argValue = (name, fallback = '') => {
    const arg = args.find(item => item === `--${name}` || item.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const [, value = 'true'] = arg.split('=');
    return value;
};

const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const missingOnly = args.includes('--missing-only');
const limit = Number(argValue('limit', '0'));
const delayMs = Number(argValue('delay', '350'));
const onlyCards = new Set(args.filter(arg => arg.startsWith('--card=')).map(arg => arg.split('=')[1].toUpperCase()));
const onlySeries = new Set(args.filter(arg => arg.startsWith('--series=')).flatMap(arg => arg.split('=')[1].split(',')).map(value => value.trim().toUpperCase()).filter(Boolean));

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
        .trim();
}

function normalizeImageUrl(src) {
    const decoded = decodeHtml(src);
    return new URL(decoded, `${OFFICIAL_BASE_URL}/cardlist/`).href;
}

function localImagePath(cardNumber, imageUrl) {
    const series = cardNumber.split('-')[0];
    const fileName = path.basename(new URL(imageUrl).pathname);
    return path.join(OUTPUT_ROOT, series, 'official', fileName);
}

function parseOfficialCards(html, expectedCardNumber) {
    const cards = [];
    const modalRegex = /<dl class="modalCol" id="([^"]+)">([\s\S]*?)<\/dl>/g;
    let match;

    while ((match = modalRegex.exec(html))) {
        const [, modalId, body] = match;
        const infoMatch = body.match(/<div class="infoCol">\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>\s*\|\s*<span>(.*?)<\/span>/s);
        if (!infoMatch) continue;

        const cardNumber = decodeHtml(infoMatch[1]).toUpperCase();
        if (cardNumber !== expectedCardNumber) continue;

        const imageMatch = body.match(/<div class="frontCol">[\s\S]*?<img[^>]+data-src="([^"]+)"/s);
        if (!imageMatch) continue;

        const cardName = decodeHtml(body.match(/<div class="cardName">([\s\S]*?)<\/div>/)?.[1] || '');
        const getInfo = decodeHtml(body.match(/<div class="getInfo"><h3>入手情報<\/h3>([\s\S]*?)<\/div>/)?.[1] || '');
        const imageUrl = normalizeImageUrl(imageMatch[1]);
        const imageBaseName = path.basename(new URL(imageUrl).pathname, path.extname(new URL(imageUrl).pathname));
        const parallelMatch = imageBaseName.match(/_p(\d+)$/);
        const rarityMatch = imageBaseName.match(/_r(\d+)$/);
        const variantIndex = rarityMatch ? 1000 + Number(rarityMatch[1]) : parallelMatch ? Number(parallelMatch[1]) : 0;
        const label = rarityMatch
            ? `別レアリティ ${rarityMatch[1]}`
            : variantIndex === 0 ? '通常' : `公式差分 ${variantIndex + 1}`;

        cards.push({
            modalId,
            cardNumber,
            cardName,
            rarity: decodeHtml(infoMatch[2]),
            cardType: decodeHtml(infoMatch[3]),
            getInfo,
            imageUrl,
            localPath: localImagePath(cardNumber, imageUrl),
            source: 'official',
            label,
            variantIndex
        });
    }

    return cards.sort((a, b) => a.variantIndex - b.variantIndex || a.imageUrl.localeCompare(b.imageUrl));
}

async function exists(filePath) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OP_TCG_DB image sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
}

async function downloadFile(url, outputPath) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OP_TCG_DB image sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    await mkdir(path.dirname(outputPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, buffer);
}

async function readMetadata() {
    try {
        return JSON.parse(await readFile(METADATA_FILE, 'utf8'));
    } catch {
        return {};
    }
}

const cardsData = JSON.parse(await readFile(CARDS_JSON, 'utf8'));
let cardNumbers = [...new Set(cardsData.map(card => String(card.cardNumber || '').toUpperCase()).filter(Boolean))];

if (onlyCards.size > 0) {
    cardNumbers = cardNumbers.filter(cardNumber => onlyCards.has(cardNumber));
}

const metadata = await readMetadata();
const officialImageCardNumbers = new Set();
for (const filePath of Object.keys(metadata)) {
    if (metadata[filePath]?.source !== 'official') continue;
    if (!await exists(filePath)) continue;

    const cardNumber = path.basename(filePath, path.extname(filePath)).match(/^([A-Z0-9]+-\d+)/i)?.[1]?.toUpperCase();
    if (cardNumber) officialImageCardNumbers.add(cardNumber);
}

if (onlySeries.size > 0) {
    cardNumbers = cardNumbers.filter(cardNumber => onlySeries.has(cardNumber.split('-')[0]));
}

if (missingOnly) {
    cardNumbers = cardNumbers.filter(cardNumber => !officialImageCardNumbers.has(cardNumber));
}

if (limit > 0) {
    cardNumbers = cardNumbers.slice(0, limit);
}

const summary = { checked: 0, found: 0, downloaded: 0, skipped: 0, failed: 0 };

for (const cardNumber of cardNumbers) {
    summary.checked++;
    const url = `${OFFICIAL_BASE_URL}/cardlist/?freewords=${encodeURIComponent(cardNumber)}&search=true`;

    try {
        const html = await fetchText(url);
        const officialCards = parseOfficialCards(html, cardNumber);
        summary.found += officialCards.length;

        for (const officialCard of officialCards) {
            const webPath = officialCard.localPath.split(path.sep).join('/');
            metadata[webPath] = {
                source: 'official',
                sourceUrl: officialCard.imageUrl,
                cardName: officialCard.cardName,
                rarity: officialCard.rarity,
                cardType: officialCard.cardType,
                getInfo: officialCard.getInfo,
                label: officialCard.label
            };

            if (!force && await exists(officialCard.localPath)) {
                summary.skipped++;
                continue;
            }

            if (dryRun) {
                console.log(`[dry-run] ${cardNumber}: ${officialCard.imageUrl} -> ${officialCard.localPath}`);
                summary.skipped++;
                continue;
            }

            await downloadFile(officialCard.imageUrl, officialCard.localPath);
            summary.downloaded++;
            console.log(`[downloaded] ${officialCard.localPath}`);
        }
    } catch (error) {
        summary.failed++;
        console.error(`[failed] ${cardNumber}: ${error.message}`);
    }

    if (delayMs > 0) {
        await sleep(delayMs);
    }
}

if (!dryRun) {
    await writeFile(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify(summary, null, 2));
