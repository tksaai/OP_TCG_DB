import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import eightPackLeader from '../eight-pack-leader.js';

const OFFICIAL_BASE_URL = 'https://www.onepiece-cardgame.com';
const OFFICIAL_EVENTS_URL = `${OFFICIAL_BASE_URL}/events/`;
const CARDS_JSON = 'cards.json';
const OFFICIAL_IMAGE_SOURCES_JSON = 'official-image-sources.json';
const OUTPUT_ROOT = 'Cards';
const WEBP_ROOT = 'CardsWebP';
const CARD_NUMBER = 'P';
const EVENT_URL_PATTERN = /\/events\/8packs-battle-(\d{4})(\d{2})\.html(?:[?#].*)?$/i;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

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
        .trim();
}

function extractAttribute(tag, name) {
    return decodeHtml(tag.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'))?.[1] || '');
}

function normalizeAssetUrl(value, baseUrl) {
    const url = new URL(value, baseUrl);
    url.search = '';
    url.hash = '';
    return url.href;
}

function discoverEventUrls(html) {
    const urls = new Set();
    const linkRegex = /<a\b[^>]*href="([^"]+)"[^>]*>/gi;
    let match;
    while ((match = linkRegex.exec(html))) {
        const url = new URL(decodeHtml(match[1]), OFFICIAL_EVENTS_URL).href;
        if (EVENT_URL_PATTERN.test(url)) urls.add(url);
    }
    return [...urls].sort();
}

function eventInfoFromUrl(url) {
    const match = url.match(EVENT_URL_PATTERN);
    if (!match) return null;
    const [, year, month] = match;
    return {
        year: Number(year),
        month: Number(month),
        getInfo: `8パックバトル ${Number(year)}年${Number(month)}月 参加記念品`
    };
}

function discoverLeaderImages(html, pageUrl) {
    const images = [];
    const imageRegex = /<img\b[^>]*>/gi;
    let match;
    while ((match = imageRegex.exec(html))) {
        const tag = match[0];
        const alt = decodeHtml(extractAttribute(tag, 'alt')).replace(/\s+/g, ' ').trim();
        if (!/P\s+モンキー・[DＤ]・ルフィ/u.test(alt)) continue;
        const src = extractAttribute(tag, 'data-src') || extractAttribute(tag, 'src');
        if (!src) continue;
        images.push({
            sourceUrl: normalizeAssetUrl(src, pageUrl),
            ...eventInfoFromUrl(pageUrl)
        });
    }
    return images;
}

async function fetchResponse(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OP_TCG_DB 8 pack leader sync (+https://github.com/tksaai/OP_TCG_DB)'
        },
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    return response;
}

async function fetchText(url) {
    return (await fetchResponse(url)).text();
}

async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function fileExists(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function webpPathFor(localPath) {
    const relativePath = path.relative(OUTPUT_ROOT, localPath);
    return path.join(WEBP_ROOT, relativePath).replace(/\.[^.]+$/, '.webp');
}

function hasKnownImageSignature(buffer) {
    if (!buffer || buffer.length < 3) return false;
    const isPng = buffer.length >= 8
        && buffer[0] === 0x89
        && buffer.subarray(1, 4).toString('ascii') === 'PNG';
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isWebp = buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return isPng || isJpeg || isWebp;
}

async function downloadImage(url, outputPath) {
    const buffer = Buffer.from(await (await fetchResponse(url)).arrayBuffer());
    if (!hasKnownImageSignature(buffer.subarray(0, 12))) {
        throw new Error(`Downloaded response is not a supported image (${buffer.length} bytes).`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
}

function variantIndexFromPath(filePath) {
    const stem = path.basename(filePath, path.extname(filePath));
    const match = stem.match(/^P(?:_p(\d+))?$/i);
    return match ? Number(match[1] || 0) : null;
}

function allocateLocalPath(metadata, sourceUrl) {
    const existing = Object.entries(metadata).find(([, entry]) => entry?.sourceUrl === sourceUrl);
    if (existing) return existing[0];

    const usedIndexes = new Set(
        Object.keys(metadata)
            .filter(filePath => /^Cards\/P\/official\//i.test(filePath.replace(/\\/g, '/')))
            .map(variantIndexFromPath)
            .filter(index => index !== null)
    );
    let variantIndex = 0;
    while (usedIndexes.has(variantIndex)) variantIndex += 1;

    const remoteExtension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    const extension = IMAGE_EXTENSIONS.has(remoteExtension) ? remoteExtension : '.png';
    const fileName = variantIndex === 0 ? `P${extension}` : `P_p${variantIndex}${extension}`;
    return path.posix.join(OUTPUT_ROOT, 'P', 'official', fileName);
}

const cards = await readJson(CARDS_JSON, []);
const metadata = await readJson(OFFICIAL_IMAGE_SOURCES_JSON, {});
const eventIndexHtml = await fetchText(OFFICIAL_EVENTS_URL);
const eventUrls = discoverEventUrls(eventIndexHtml);
if (eventUrls.length === 0) {
    const hasStoredLeader = cards.some(card => String(card?.cardNumber || '').toUpperCase() === CARD_NUMBER);
    const hasStoredImage = Object.keys(metadata).some(filePath => (
        /^Cards\/P\/official\/P(?:_p\d+)?\.[^.]+$/i.test(filePath.replace(/\\/g, '/'))
    ));
    if (hasStoredLeader && hasStoredImage) {
        console.warn('No current 8 pack battle event pages were found; keeping the stored leader data.');
        process.exit(0);
    }
    throw new Error('No current 8 pack battle event pages were found.');
}

const discoveredImages = [];
for (const eventUrl of eventUrls) {
    const eventHtml = await fetchText(eventUrl);
    discoveredImages.push(...discoverLeaderImages(eventHtml, eventUrl));
}

const uniqueImages = [...new Map(discoveredImages.map(image => [image.sourceUrl, image])).values()]
    .sort((a, b) => a.year - b.year || a.month - b.month || a.sourceUrl.localeCompare(b.sourceUrl));
if (uniqueImages.length === 0) throw new Error('No official 8 pack battle leader images were found.');

let downloaded = 0;
let skipped = 0;

for (const image of uniqueImages) {
    const localPath = allocateLocalPath(metadata, image.sourceUrl);
    metadata[localPath] = {
        source: 'official',
        sourceUrl: image.sourceUrl,
        cardName: 'モンキー・D・ルフィ',
        rarity: 'L',
        cardType: 'LEADER',
        block: '',
        getInfo: image.getInfo,
        label: image.getInfo
    };

    const hasImage = await fileExists(localPath) || await fileExists(webpPathFor(localPath));
    if (!force && hasImage) {
        skipped += 1;
        continue;
    }
    if (dryRun) {
        console.log(`[dry-run] ${image.sourceUrl} -> ${localPath}`);
        skipped += 1;
        continue;
    }
    await downloadImage(image.sourceUrl, localPath);
    downloaded += 1;
    console.log(`[downloaded] ${localPath}`);
}

if (!dryRun) {
    eightPackLeader.ensureCard(cards);
    await writeFile(CARDS_JSON, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
    await writeFile(OFFICIAL_IMAGE_SOURCES_JSON, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    events: eventUrls.length,
    images: uniqueImages.length,
    downloaded,
    skipped,
    dryRun
}, null, 2));
