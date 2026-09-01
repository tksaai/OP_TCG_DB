import { readFile, writeFile } from 'node:fs/promises';

import { applyBlockIconRules } from './block-icon-rules.mjs';

const CARDS_JSON = 'cards.json';
const OVERRIDES_JSON = 'block-icon-overrides.json';
const OFFICIAL_IMAGE_SOURCES_JSON = 'official-image-sources.json';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const cards = JSON.parse(await readFile(CARDS_JSON, 'utf8'));
const overrides = JSON.parse(await readFile(OVERRIDES_JSON, 'utf8'));
let officialImageSources = {};
try {
    officialImageSources = JSON.parse(await readFile(OFFICIAL_IMAGE_SOURCES_JSON, 'utf8'));
} catch {
    // The rule file alone is enough when image metadata is not available yet.
}
const changed = applyBlockIconRules(cards, overrides, { officialImageSources });

if (!dryRun) {
    await writeFile(CARDS_JSON, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    changed,
    totalCards: cards.length,
    dryRun
}, null, 2));
