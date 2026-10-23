import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseOfficialSeries, selectAutomaticSeries } from './official-series-discovery.mjs';

const OFFICIAL_CARDLIST_URL = 'https://www.onepiece-cardgame.com/cardlist/';
const PROMO_SERIES = 'PROMO';
const args = process.argv.slice(2);
const passthroughNames = new Set(['card', 'delay', 'force', 'limit', 'series']);

function argValue(name, fallback = '') {
    const arg = args.find(item => item === `--${name}` || item.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const [, value = 'true'] = arg.split('=');
    return value;
}

function hasArg(name) {
    return args.includes(`--${name}`) || args.some(item => item.startsWith(`--${name}=`));
}

function run(command, commandArgs) {
    console.log(`\n> ${[command, ...commandArgs].join(' ')}`);
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function readOptionalText(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    } catch {
        return '';
    }
}

async function discoverAutomaticOfficialSeries() {
    const response = await fetch(OFFICIAL_CARDLIST_URL, {
        headers: {
            'User-Agent': 'OP_TCG_DB new release sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch official cardlist: ${response.status} ${response.statusText}`);
    const series = parseOfficialSeries(await response.text());
    if (series.length === 0) throw new Error('No product series options found in official cardlist HTML.');

    const cards = JSON.parse(await readFile('cards.json', 'utf8'));
    return selectAutomaticSeries(series, cards.map(card => card.cardNumber));
}

async function findSeriesWithoutOfficialImages() {
    const cards = JSON.parse(await readFile('cards.json', 'utf8'));
    const allSeries = new Set(
        cards
            .map(card => String(card.cardNumber || '').toUpperCase().split('-')[0])
            .filter(Boolean)
    );

    let metadata = {};
    try {
        metadata = JSON.parse(await readFile('official-image-sources.json', 'utf8'));
    } catch {
        // No metadata yet; every series counts as uncovered.
    }
    const coveredSeries = new Set(
        Object.entries(metadata)
            .filter(([, value]) => value?.source === 'official')
            .map(([filePath]) => filePath.split('/')[1])
    );

    return [...allSeries].filter(series => !coveredSeries.has(series)).sort();
}

const dryRun = hasArg('dry-run');
const skipWebp = hasArg('skip-webp');
const skipManifest = hasArg('skip-manifest');
const skipFeatures = hasArg('skip-features');
const pythonCommand = argValue('python', 'python');
let requestedSeries = argValue('series', 'latest').trim();

if (!requestedSeries || /^latest|auto$/i.test(requestedSeries)) {
    const automatic = await discoverAutomaticOfficialSeries();
    console.log(`Detected latest official series by family: ${automatic.latest.map(series => series.code).join(', ')}`);
    if (automatic.missing.length > 0) {
        console.log(`Detected official series missing from cards.json: ${automatic.missing.map(series => series.code).join(', ')}`);
    }

    const uncoveredSeries = await findSeriesWithoutOfficialImages();
    if (uncoveredSeries.length > 0) {
        console.log(`Detected series without any official images: ${uncoveredSeries.join(', ')}`);
    }

    requestedSeries = [...new Set([
        ...automatic.selected.map(series => series.code),
        PROMO_SERIES,
        ...uncoveredSeries
    ])].join(',');
    console.log(`Automatic sync targets: ${requestedSeries}`);
}

const officialSyncArgs = [
    path.join('scripts', 'sync-official-images.mjs'),
    `--series=${requestedSeries}`
];
const cardSyncArgs = [
    path.join('scripts', 'sync-official-cards.mjs'),
    `--series=${requestedSeries}`
];

for (const arg of args) {
    const match = arg.match(/^--([^=]+)(?:=.*)?$/);
    if (!match) continue;
    if (match[1] === 'series') continue;
    if (passthroughNames.has(match[1]) || match[1] === 'dry-run') {
        officialSyncArgs.push(arg);
        cardSyncArgs.push(arg);
    }
}

const blockRulesBefore = await readOptionalText('block-icon-overrides.json');
run(process.execPath, [
    path.join('scripts', 'sync-block-icon-rules.mjs'),
    '--allow-stale',
    ...(dryRun ? ['--dry-run'] : [])
]);
const blockRulesAfter = await readOptionalText('block-icon-overrides.json');
if (!dryRun && blockRulesAfter && blockRulesAfter !== blockRulesBefore) {
    const blockRules = JSON.parse(blockRulesAfter);
    const blockRuleCards = [...new Set([
        ...(blockRules.superParallelXCardNumbers || blockRules.legacySuperParallelX || []),
        ...Object.keys(blockRules.blockIconOverrides || {})
    ])].filter(Boolean);
    const targetedArgs = blockRuleCards.map(cardNumber => `--card=${cardNumber}`);
    if (targetedArgs.length > 0) {
        console.log(`Refreshing ${targetedArgs.length} cards referenced by updated block icon rules.`);
        run(process.execPath, [path.join('scripts', 'sync-official-cards.mjs'), ...targetedArgs]);
        run(process.execPath, [path.join('scripts', 'sync-official-images.mjs'), ...targetedArgs]);
    }
}
run(process.execPath, cardSyncArgs);
run(process.execPath, officialSyncArgs);
run(process.execPath, [
    path.join('scripts', 'sync-eight-pack-leader.mjs'),
    ...(dryRun ? ['--dry-run'] : []),
    ...(hasArg('force') ? ['--force'] : [])
]);
run(process.execPath, [path.join('scripts', 'apply-block-icon-overrides.mjs'), ...(dryRun ? ['--dry-run'] : [])]);
run(process.execPath, [
    path.join('scripts', 'sync-furigana-master.mjs'),
    ...(dryRun ? [] : ['--write'])
]);

if (dryRun) {
    console.log('\nDry run complete. WebP conversion and manifest rebuild were skipped.');
    process.exit(0);
}

if (!skipWebp) {
    run(pythonCommand, [path.join('scripts', 'convert-images-to-webp.py')]);
}

if (!skipManifest) {
    run(process.execPath, [path.join('scripts', 'build-image-manifest.mjs')]);
}

if (!skipFeatures) {
    run(pythonCommand, [path.join('scripts', 'build-card-features.py')]);
}

console.log('\nNew release sync complete.');
