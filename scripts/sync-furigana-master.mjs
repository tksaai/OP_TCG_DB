import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyFuriganaMaster,
    createEmptyFuriganaMaster,
    createKanaOnlySuggestion,
    normalizeFuriganaReading,
    normalizeMasterEntry,
    sortObjectKeys
} from './furigana-utils.mjs';

const CARDS_PATH = 'cards.json';
const PROVISIONAL_CARDS_PATH = 'provisional-cards.json';
const MASTER_PATH = 'furigana-master.json';
const OVERRIDES_PATH = 'furigana-overrides.json';

async function readJson(path, fallback) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback;
        throw error;
    }
}

function collectReadings(cards) {
    const byName = new Map();
    for (const card of cards) {
        const name = String(card?.cardName || '').trim();
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, new Set());
        const reading = normalizeFuriganaReading(card?.furigana || '');
        if (reading) byName.get(name).add(reading);
    }
    return byName;
}

export function updateFuriganaMaster(cards, provisionalCards, currentMaster) {
    const allCards = [...cards, ...provisionalCards];
    const readingsByName = collectReadings(allCards);
    const names = [...new Set(allCards.map(card => String(card?.cardName || '').trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'ja'));
    const entries = {};

    for (const name of names) {
        const existing = currentMaster?.entries?.[name];
        if (existing) {
            entries[name] = normalizeMasterEntry(existing);
            continue;
        }

        const readings = [...(readingsByName.get(name) || [])];
        if (readings.length === 1) {
            entries[name] = {
                reading: readings[0],
                status: 'verified',
                source: 'existing-card-data'
            };
            continue;
        }

        const suggestion = createKanaOnlySuggestion(name);
        entries[name] = suggestion
            ? { reading: suggestion, status: 'suggested', source: 'kana-rule' }
            : { reading: '', status: 'pending', source: 'new-card' };
    }

    return {
        version: 1,
        entries: sortObjectKeys(entries)
    };
}

export function summarizeFuriganaMaster(master, cards, provisionalCards) {
    const counts = { verified: 0, suggested: 0, pending: 0 };
    for (const entry of Object.values(master.entries || {})) {
        if (counts[entry.status] !== undefined) counts[entry.status] += 1;
    }
    const missingCards = [...cards, ...provisionalCards]
        .filter(card => !normalizeFuriganaReading(card?.furigana || ''));
    return {
        names: Object.keys(master.entries || {}).length,
        ...counts,
        cardsWithoutVerifiedReading: missingCards.length
    };
}

export async function synchronizeFurigana(options = {}) {
    const cards = await readJson(options.cardsPath || CARDS_PATH, []);
    const provisionalCards = await readJson(options.provisionalPath || PROVISIONAL_CARDS_PATH, []);
    const currentMaster = await readJson(options.masterPath || MASTER_PATH, createEmptyFuriganaMaster());
    const overrides = await readJson(options.overridesPath || OVERRIDES_PATH, {});
    const master = updateFuriganaMaster(cards, provisionalCards, currentMaster);
    const changedCards = applyFuriganaMaster(cards, master, overrides);
    const changedProvisionalCards = applyFuriganaMaster(provisionalCards, master, overrides);

    if (options.write) {
        await writeFile(options.masterPath || MASTER_PATH, `${JSON.stringify(master, null, 2)}\n`, 'utf8');
        if (changedCards > 0) {
            await writeFile(options.cardsPath || CARDS_PATH, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
        }
        if (changedProvisionalCards > 0) {
            await writeFile(options.provisionalPath || PROVISIONAL_CARDS_PATH, `${JSON.stringify(provisionalCards, null, 2)}\n`, 'utf8');
        }
    }

    return {
        master,
        cards,
        provisionalCards,
        changedCards,
        changedProvisionalCards,
        summary: summarizeFuriganaMaster(master, cards, provisionalCards)
    };
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const result = await synchronizeFurigana({ write: process.argv.includes('--write') });
    console.log(JSON.stringify({
        ...result.summary,
        changedCards: result.changedCards,
        changedProvisionalCards: result.changedProvisionalCards,
        wroteFiles: process.argv.includes('--write')
    }, null, 2));
}
