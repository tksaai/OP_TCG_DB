import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const CARDS_DIR = 'Cards';
const WEBP_DIR = 'CardsWebP';
const OUTPUT_FILE = 'image-manifest.json';
const OFFICIAL_METADATA_FILE = 'official-image-sources.json';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const args = new Set(process.argv.slice(2));
const shouldGenerateWebp = args.has('--webp');
const qualityArg = process.argv.find(arg => arg.startsWith('--quality='));
const webpQuality = qualityArg ? Number(qualityArg.split('=')[1]) : 76;

async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(filePath));
        } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(filePath);
        }
    }

    return files;
}

function toWebPath(filePath) {
    return filePath.split(path.sep).join('/');
}

async function readOfficialMetadata() {
    try {
        return JSON.parse(await readFile(OFFICIAL_METADATA_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function parseCardImage(filePath) {
    const fileName = path.basename(filePath, path.extname(filePath));
    const match = fileName.match(/^([A-Z0-9]+-\d+)(?:(?: \((\d+)\))|(?:_p(\d+))|(?:_r(\d+)))?$/i);
    if (!match) return null;

    const [, cardNumber, localVariantSuffix, officialParallelSuffix, officialRaritySuffix] = match;
    const variantIndex = officialRaritySuffix
        ? 1000 + Number(officialRaritySuffix)
        : Number(localVariantSuffix || officialParallelSuffix || 0);
    const label = officialRaritySuffix
        ? `別レアリティ ${officialRaritySuffix}`
        : variantIndex === 0 ? '通常' : `別イラスト ${variantIndex + 1}`;

    return {
        cardNumber,
        variantIndex,
        label,
        originalPath: toWebPath(filePath)
    };
}

const files = await walk(CARDS_DIR);
const cards = {};
const officialMetadata = await readOfficialMetadata();
let sharp = null;

if (shouldGenerateWebp) {
    try {
        const require = createRequire(import.meta.url);
        sharp = require('sharp');
    } catch (error) {
        console.error('WebP generation requires the "sharp" package. Install it or set NODE_PATH to a node_modules folder that contains sharp, then rerun with --webp.');
        process.exitCode = 1;
        throw error;
    }
}

async function createWebpVariant(originalPath) {
    const relativePath = path.relative(CARDS_DIR, originalPath);
    const outputPath = path.join(WEBP_DIR, relativePath).replace(/\.[^.]+$/, '.webp');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(originalPath)
        .webp({ quality: webpQuality, effort: 4 })
        .toFile(outputPath);
    return toWebPath(outputPath);
}

async function existingWebpPath(originalPath) {
    const relativePath = path.relative(CARDS_DIR, originalPath);
    const outputPath = path.join(WEBP_DIR, relativePath).replace(/\.[^.]+$/, '.webp');
    try {
        await stat(outputPath);
        return toWebPath(outputPath);
    } catch {
        return '';
    }
}

for (const file of files) {
    const parsed = parseCardImage(file);
    if (!parsed) continue;

    const originalPath = parsed.originalPath;
    let webpPath = await existingWebpPath(file);
    if (!webpPath && shouldGenerateWebp && path.extname(file).toLowerCase() !== '.webp') {
        webpPath = await createWebpVariant(file);
    }
    if (!webpPath) {
        webpPath = originalPath;
    }

    if (!cards[parsed.cardNumber]) {
        cards[parsed.cardNumber] = [];
    }

    cards[parsed.cardNumber].push({
        ...officialMetadata[originalPath],
        path: webpPath,
        fallbackPath: originalPath,
        label: parsed.label,
        variantIndex: parsed.variantIndex
    });
}

for (const [cardNumber, variants] of Object.entries(cards)) {
    const byVariant = new Map();
    variants.sort((a, b) => {
        const officialA = a.source === 'official' ? 0 : 1;
        const officialB = b.source === 'official' ? 0 : 1;
        return a.variantIndex - b.variantIndex || officialA - officialB || a.path.localeCompare(b.path);
    });

    for (const variant of variants) {
        if (!byVariant.has(variant.variantIndex)) {
            byVariant.set(variant.variantIndex, variant);
        }
    }

    cards[cardNumber] = [...byVariant.values()].sort((a, b) => a.variantIndex - b.variantIndex);
}

const manifest = {
    generatedAt: new Date().toISOString(),
    totalCards: Object.keys(cards).length,
    totalImages: Object.values(cards).reduce((sum, variants) => sum + variants.length, 0),
    cards
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${OUTPUT_FILE}: ${manifest.totalCards} cards, ${manifest.totalImages} images`);
if (shouldGenerateWebp) {
    console.log(`Generated WebP images in ${WEBP_DIR} at quality ${webpQuality}`);
}
