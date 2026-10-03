import { readFile, writeFile } from 'node:fs/promises';
import eightPackLeader from '../eight-pack-leader.js';

const cardsPath = new URL('../cards.json', import.meta.url);
const cards = JSON.parse(await readFile(cardsPath, 'utf8'));
const hadLeader = cards.some(card => String(card?.cardNumber || '').toUpperCase() === eightPackLeader.CARD_NUMBER);

eightPackLeader.ensureCard(cards);
await writeFile(cardsPath, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');

console.log(hadLeader
    ? '8 pack battle leader P is present and normalized.'
    : 'Restored 8 pack battle leader P.');
