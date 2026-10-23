import assert from 'node:assert/strict';

import {
    normalizeSeriesCode,
    parseOfficialSeries,
    selectAutomaticSeries
} from './official-series-discovery.mjs';

const html = `
    <select>
        <option value="550117">ブースターパック 世界最強の戦士【OP-17】</option>
        <option value="550116">ブースターパック 決戦の刻【OP-16】</option>
        <option value="550205">エクストラブースター<br>Heroines【EB-05】</option>
        <option value="550204">エクストラブースター EGGHEAD【EB-04】</option>
        <option value="550336">スタートデッキ【ST-36】</option>
        <option value="550302">プレミアムブースター【PRB-02】</option>
        <option value="559901">将来の新系列【EX-01】</option>
        <option value="duplicate">重複【EB-05】</option>
        <option value="promo">プロモーションカード</option>
    </select>
`;

assert.equal(normalizeSeriesCode('prb-02'), 'PRB02');

const officialSeries = parseOfficialSeries(html);
assert.deepEqual(
    officialSeries.map(series => series.code),
    ['EB04', 'EB05', 'EX01', 'OP16', 'OP17', 'PRB02', 'ST36'],
    'OP/EB以外を含む公式収録弾コードを重複なく解析できません'
);

const selection = selectAutomaticSeries(officialSeries, [
    'OP16-001',
    'EB04-001',
    'ST36-001',
    'PRB02-001'
]);
assert.deepEqual(
    selection.latest.map(series => series.code),
    ['EB05', 'EX01', 'OP17', 'PRB02', 'ST36'],
    '各系列の最新弾を選択できません'
);
assert.deepEqual(
    selection.missing.map(series => series.code),
    ['EB05', 'EX01', 'OP17'],
    'DBに未収録の公式シリーズを検出できません'
);
assert.deepEqual(
    selection.selected.map(series => series.code),
    ['EB05', 'EX01', 'OP17', 'PRB02', 'ST36'],
    '最新弾と未収録弾をまとめて同期対象にできません'
);

console.log('Official series discovery tests passed.');
