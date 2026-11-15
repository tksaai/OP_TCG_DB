import { readFile, writeFile } from 'node:fs/promises';

import { parseOfficialSeries } from './official-series-discovery.mjs';
import { buildSeriesMaster, SERIES_MASTER_SOURCE } from './series-master-utils.mjs';

const MASTER_URL = new URL('../series-master.json', import.meta.url);
const dryRun = process.argv.includes('--dry-run');

async function readExistingMaster() {
    try {
        return JSON.parse(await readFile(MASTER_URL, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw error;
    }
}

const response = await fetch(SERIES_MASTER_SOURCE, {
    headers: {
        'User-Agent': 'OP_TCG_DB series master sync (+https://github.com/tksaai/OP_TCG_DB)'
    }
});
if (!response.ok) {
    throw new Error(`Failed to fetch official cardlist: ${response.status} ${response.statusText}`);
}

const officialSeries = parseOfficialSeries(await response.text());
if (officialSeries.length === 0) {
    throw new Error('No product series options found in official cardlist HTML.');
}

const existingMaster = await readExistingMaster();
const nextMaster = buildSeriesMaster(officialSeries, existingMaster);
const currentText = Object.keys(existingMaster).length > 0
    ? `${JSON.stringify(existingMaster, null, 2)}\n`
    : '';
const nextText = `${JSON.stringify(nextMaster, null, 2)}\n`;
const changed = currentText !== nextText;

console.log(`Official series master: ${Object.keys(nextMaster.entries).length} entries (${changed ? 'changed' : 'unchanged'}).`);
if (dryRun) {
    console.log('Dry run: series-master.json was not written.');
} else if (changed) {
    await writeFile(MASTER_URL, nextText, 'utf8');
    console.log('Updated series-master.json.');
}
