import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INPUT = 'provisional-cards.json';
const DEFAULT_IMAGE_DIR = path.join('Cards', 'Provisional');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const USER_AGENT = 'OP_TCG_DB provisional image sync (+https://github.com/tksaai/OP_TCG_DB)';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function argValue(name, fallback = '') {
    const arg = args.find(item => item === `--${name}` || item.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const [, value = 'true'] = arg.split('=');
    return value;
}

const inputPath = argValue('input', DEFAULT_INPUT);
const imageRoot = argValue('image-dir', DEFAULT_IMAGE_DIR);
const requestedConcurrency = Number(argValue('concurrency', '6'));
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(requestedConcurrency, 12)
    : 6;

function toWebPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function isRemoteUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

function getRemoteImageUrl(card) {
    if (isRemoteUrl(card?.provisionalImageUrl)) return card.provisionalImageUrl;
    if (isRemoteUrl(card?.imagePath)) return card.imagePath;
    return '';
}

function safePathSegment(value, fallback) {
    const safe = String(value || '')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 120);
    return safe || fallback;
}

function getLocalImagePath(card, remoteUrl) {
    const url = new URL(remoteUrl);
    const remoteExtension = path.extname(url.pathname).toLowerCase();
    const extension = IMAGE_EXTENSIONS.has(remoteExtension) ? remoteExtension : '.jpg';
    const remoteStem = path.basename(url.pathname, remoteExtension) || 'image';
    const uniqueStem = String(card.uniqueId || `${card.cardNumber}_${remoteStem}`)
        .replace(/\.[A-Za-z0-9]{2,5}$/i, '');
    const scope = safePathSegment(card.provisionalScope || card.cardNumber?.split('-')[0], 'OTHER');
    const fileName = `${safePathSegment(uniqueStem, card.cardNumber || 'card')}${extension}`;
    return path.join(imageRoot, scope, fileName);
}

async function readCards() {
    const cards = JSON.parse(await readFile(inputPath, 'utf8'));
    if (!Array.isArray(cards)) throw new Error(`${inputPath} must contain a JSON array.`);
    return cards;
}

async function readExistingFile(filePath) {
    try {
        return await readFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchImage(remoteUrl, referer = '') {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(remoteUrl, {
                headers: {
                    'User-Agent': USER_AGENT,
                    ...(referer ? { Referer: referer } : {})
                },
                signal: AbortSignal.timeout(30000)
            });
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('image/')) {
                throw new Error(`unexpected content type: ${contentType || 'unknown'}`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length < 128) throw new Error('downloaded image is empty');
            return buffer;
        } catch (error) {
            lastError = error;
            if (attempt < 3) await sleep(attempt * 750);
        }
    }
    throw lastError;
}

async function mapWithConcurrency(items, limit, callback) {
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            await callback(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function walkFiles(directory) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walkFiles(filePath));
        else files.push(filePath);
    }
    return files;
}

const cards = await readCards();
const desiredPaths = new Set();
const failures = [];
const stats = {
    cards: cards.length,
    remoteImages: 0,
    downloaded: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    removed: 0
};

await mapWithConcurrency(cards, concurrency, async card => {
    const remoteUrl = getRemoteImageUrl(card);
    if (!remoteUrl) {
        if (String(card.imagePath || '').startsWith(toWebPath(imageRoot))) {
            desiredPaths.add(path.normalize(card.imagePath));
        }
        stats.missing += 1;
        return;
    }

    stats.remoteImages += 1;
    const localPath = getLocalImagePath(card, remoteUrl);
    const localWebPath = toWebPath(localPath);
    desiredPaths.add(path.normalize(localPath));
    card.provisionalImageUrl = remoteUrl;

    const existing = await readExistingFile(localPath);
    if (dryRun) {
        if (existing) {
            card.imagePath = localWebPath;
            stats.unchanged += 1;
        } else {
            stats.missing += 1;
        }
        return;
    }

    try {
        const downloaded = await fetchImage(remoteUrl, card.provisionalSourceUrl);
        card.imagePath = localWebPath;
        if (existing?.equals(downloaded)) {
            stats.unchanged += 1;
            return;
        }
        await mkdir(path.dirname(localPath), { recursive: true });
        await writeFile(localPath, downloaded);
        if (existing) stats.updated += 1;
        else stats.downloaded += 1;
    } catch (error) {
        if (existing) {
            card.imagePath = localWebPath;
        } else {
            card.imagePath = remoteUrl;
            stats.missing += 1;
        }
        failures.push({ card: card.uniqueId || card.cardNumber, url: remoteUrl, error: error.message });
    }
});

if (!dryRun) {
    if (failures.length === 0) {
        const managedFiles = await walkFiles(imageRoot);
        for (const filePath of managedFiles) {
            if (desiredPaths.has(path.normalize(filePath))) continue;
            await unlink(filePath);
            stats.removed += 1;
        }
    }
    await writeFile(inputPath, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    input: inputPath,
    imageRoot: toWebPath(imageRoot),
    dryRun,
    ...stats,
    failures
}, null, 2));
