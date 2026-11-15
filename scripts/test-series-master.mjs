import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    buildSeriesMaster,
    getSeriesIdFromCardNumber,
    normalizeCardsWithSeriesMaster
} from './series-master-utils.mjs';

const fixtureMaster = buildSeriesMaster([
    { code: 'OP18', label: 'ブースターパック 神の支配【OP-18】' },
    { code: 'EB05', label: 'エクストラブースター ONE PIECE Heroines Edition vol.2【EB-05】' }
]);
assert.deepEqual(fixtureMaster.entries.OP18, {
    code: 'OP-18',
    title: 'ブースターパック 神の支配',
    label: 'ブースターパック 神の支配【OP-18】'
});
assert.equal(fixtureMaster.entries.P.title, 'プロモーションカード');

const fixtureCards = [{
    cardNumber: 'OP18-001',
    seriesCode: '',
    seriesTitle: '',
    getInfo: '再録商品【PRB-02】'
}];
const normalized = normalizeCardsWithSeriesMaster(fixtureCards, fixtureMaster);
assert.equal(normalized.changedCards, 1);
assert.equal(normalized.cards[0].seriesCode, 'OP-18');
assert.equal(normalized.cards[0].seriesTitle, 'ブースターパック 神の支配');
assert.equal(normalized.cards[0].getInfo, '再録商品【PRB-02】', '画像の入手情報を変更しています');

const master = JSON.parse(await readFile(new URL('../series-master.json', import.meta.url), 'utf8'));
const cards = JSON.parse(await readFile(new URL('../cards.json', import.meta.url), 'utf8'));
assert.equal(master.version, 1);
assert.equal(master.entries.OP18?.title, 'ブースターパック 神の支配');
assert.equal(
    master.entries.EB05?.title,
    'エクストラブースター ONE PIECE Heroines Edition vol.2'
);

const missingSeries = [...new Set(cards.map(card => getSeriesIdFromCardNumber(card.cardNumber)))]
    .filter(Boolean)
    .filter(seriesId => !master.entries[seriesId]);
assert.deepEqual(missingSeries, [], `収録弾マスターに未登録のコードがあります: ${missingSeries.join(', ')}`);

const syncSource = await readFile(new URL('./sync-new-release.mjs', import.meta.url), 'utf8');
assert.match(syncSource, /sync-series-master\.mjs/u);
assert.match(syncSource, /normalize-card-series\.mjs/u);

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
assert.match(appSource, /SERIES_MASTER_PATH/u);
assert.match(appSource, /getCanonicalSeriesTitle/u);

console.log('Series master tests passed.');
