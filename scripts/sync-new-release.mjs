import { spawnSync } from 'node:child_process';
import path from 'node:path';

const OFFICIAL_CARDLIST_URL = 'https://www.onepiece-cardgame.com/cardlist/';
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

function decodeHtml(value = '') {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSeriesCode(value) {
    return String(value || '').replace('-', '').toUpperCase();
}

function parseOfficialSeries(html) {
    const series = [];
    const optionRegex = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(html))) {
        const label = decodeHtml(match[1]);
        const code = label.match(/【(OP-\d+)】/i)?.[1];
        if (!code) continue;
        series.push({
            code: normalizeSeriesCode(code),
            label
        });
    }
    return series;
}

async function discoverLatestOfficialSeries() {
    const response = await fetch(OFFICIAL_CARDLIST_URL, {
        headers: {
            'User-Agent': 'OP_TCG_DB new release sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch official cardlist: ${response.status} ${response.statusText}`);
    const series = parseOfficialSeries(await response.text());
    if (series.length === 0) throw new Error('No OP series options found in official cardlist HTML.');

    series.sort((a, b) => Number(b.code.replace(/^OP/, '')) - Number(a.code.replace(/^OP/, '')));
    return series[0];
}

const dryRun = hasArg('dry-run');
const skipWebp = hasArg('skip-webp');
const skipManifest = hasArg('skip-manifest');
const pythonCommand = argValue('python', 'python');
let requestedSeries = argValue('series', 'latest').trim();

if (!requestedSeries || /^latest|auto$/i.test(requestedSeries)) {
    const latest = await discoverLatestOfficialSeries();
    requestedSeries = latest.code;
    console.log(`Detected latest official OP series: ${latest.code} (${latest.label})`);
}

const officialSyncArgs = [
    path.join('scripts', 'sync-official-images.mjs'),
    '--missing-only',
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

run(process.execPath, cardSyncArgs);
run(process.execPath, officialSyncArgs);

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

console.log('\nNew release sync complete.');
