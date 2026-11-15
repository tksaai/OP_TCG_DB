import { readFile, writeFile } from 'node:fs/promises';

import { normalizeCardsWithSeriesMaster } from './series-master-utils.mjs';

const CARDS_URL = new URL('../cards.json', import.meta.url);
const MASTER_URL = new URL('../series-master.json', import.meta.url);
const dryRun = process.argv.includes('--dry-run');

const cards = JSON.parse(await readFile(CARDS_URL, 'utf8'));
const master = JSON.parse(await readFile(MASTER_URL, 'utf8'));
const result = normalizeCardsWithSeriesMaster(cards, master);

if (result.missingSeries.length > 0) {
    throw new Error(`Series master is missing: ${result.missingSeries.join(', ')}`);
}

console.log(`Canonical series metadata: ${result.changedCards} of ${cards.length} cards need updates.`);
if (dryRun) {
    console.log('Dry run: cards.json was not written.');
} else if (result.changedCards > 0) {
    await writeFile(CARDS_URL, `${JSON.stringify(result.cards, null, 2)}\n`, 'utf8');
    console.log('Updated cards.json seriesCode and seriesTitle.');
}
