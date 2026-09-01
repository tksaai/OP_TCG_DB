import { readFile, writeFile } from 'node:fs/promises';

import { parseBlockIconRulesPage } from './block-icon-rules.mjs';

const RULES_URL = 'https://www.onepiece-cardgame.com/news/blockicon-card.html';
const OUTPUT_FILE = 'block-icon-overrides.json';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowStale = args.includes('--allow-stale');

async function fetchRules() {
    const response = await fetch(RULES_URL, {
        headers: {
            'User-Agent': 'OP_TCG_DB block icon sync (+https://github.com/tksaai/OP_TCG_DB)'
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return parseBlockIconRulesPage(await response.text(), response.url || RULES_URL);
}

try {
    const rules = await fetchRules();
    const serialized = `${JSON.stringify(rules, null, 2)}\n`;
    let previous = '';
    try {
        previous = await readFile(OUTPUT_FILE, 'utf8');
    } catch {
        // A missing file is treated as an update.
    }

    if (!dryRun && previous !== serialized) {
        await writeFile(OUTPUT_FILE, serialized, 'utf8');
    }

    console.log(JSON.stringify({
        sourceUrl: rules.sourceUrl,
        updatedAt: rules.updatedAt,
        superParallelXCards: rules.superParallelXCardNumbers.length,
        blockIconOverrides: Object.keys(rules.blockIconOverrides).length,
        changed: previous !== serialized,
        dryRun
    }, null, 2));
} catch (error) {
    if (!allowStale) throw error;
    console.warn(`Block icon rule sync failed; existing rules will be used: ${error.message}`);
}
