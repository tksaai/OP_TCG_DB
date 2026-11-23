import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const [cards, sources] = await Promise.all([readJson('cards.json'), readJson('don-card-sources.json')]);
const active = sources.entries.filter(entry => entry.active);
assert.ok(active.length > 0 && active.length === sources.cardCount, 'Invalid DON card source count');
assert.equal(new Set(active.map(entry => entry.cardNumber)).size, active.length, 'Duplicate DON card IDs');

// The external scraper only returns normal cards. Restore missing DON cards
// from the saved PDF inventory without downloading or reassigning their IDs.
let restored = 0;
for (const entry of active) {
    assert.match(entry.cardNumber, /^DON-\d{3}$/);
    const imagePath = `CardsWebP/DON/official/${entry.cardNumber}.webp`;
    await access(new URL(imagePath, root));
    if (cards.some(card => card.cardNumber === entry.cardNumber)) continue;
    cards.push({
        uniqueId: `${entry.cardNumber}_official-don-list`,
        cardNumber: entry.cardNumber,
        cardName: 'ドン!!カード',
        furigana: 'ドンカード',
        rarity: '-',
        cardType: 'DON!!',
        color: [],
        costLifeType: '',
        costLifeValue: '-',
        power: '-',
        counter: '-',
        attribute: '-',
        features: [],
        block: '-',
        effectText: '自分のターン +1000',
        trigger: '',
        getInfo: '公式ドン!!カードリスト',
        seriesTitle: 'ドン!!カード',
        seriesCode: 'DON',
        imagePath,
        sourcePage: entry.page,
        sourceSlot: entry.slot
    });
    restored++;
}
if (restored) {
    await writeFile(new URL('cards.json', root), `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
}
console.log(`Restored ${restored} DON!! cards from saved sources.`);
