import { readFile, writeFile } from 'node:fs/promises';

const CARDS_JSON = 'cards.json';
const OVERRIDES_JSON = 'block-icon-overrides.json';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function normalizeCardNumber(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeBlockValue(value) {
    if (value === undefined || value === null) return '';
    const normalized = String(value).trim().toUpperCase();
    if (!normalized || normalized === 'NAN') return '';
    return normalized;
}

function applyBlockIconOverrides(cards, overrides) {
    const legacySuperParallelX = new Set(
        Array.isArray(overrides.legacySuperParallelX)
            ? overrides.legacySuperParallelX.map(normalizeCardNumber).filter(Boolean)
            : []
    );
    const blockIconOverrides = overrides.blockIconOverrides && typeof overrides.blockIconOverrides === 'object'
        ? overrides.blockIconOverrides
        : {};

    let changed = 0;
    for (const card of cards) {
        const cardNumber = normalizeCardNumber(card.cardNumber);
        const override = legacySuperParallelX.has(cardNumber)
            ? 'X'
            : normalizeBlockValue(blockIconOverrides[cardNumber]);

        if (override) {
            if (card.blockIconOverride !== override) changed++;
            card.blockIconOverride = override;
        } else if (Object.prototype.hasOwnProperty.call(card, 'blockIconOverride')) {
            delete card.blockIconOverride;
            changed++;
        }
    }

    return changed;
}

const cards = JSON.parse(await readFile(CARDS_JSON, 'utf8'));
const overrides = JSON.parse(await readFile(OVERRIDES_JSON, 'utf8'));
const changed = applyBlockIconOverrides(cards, overrides);

if (!dryRun) {
    await writeFile(CARDS_JSON, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
    changed,
    totalCards: cards.length,
    dryRun
}, null, 2));
