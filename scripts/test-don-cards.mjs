import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));

const [cards, manifest, seriesMaster, sources, appSource, indexSource] = await Promise.all([
    readJson('cards.json'),
    readJson('image-manifest.json'),
    readJson('series-master.json'),
    readJson('don-card-sources.json'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8')
]);

const donCards = cards.filter(card => card?.cardType === 'DON!!');
assert.ok(donCards.length >= 250, 'ドン!!カード件数が想定より少なすぎます');
assert.equal(new Set(donCards.map(card => card.cardNumber)).size, donCards.length, 'ドン!!カードIDが重複しています');
assert.equal(sources.cardCount, donCards.length, 'ドン!!カードの同期元情報が一致しません');
assert.equal(seriesMaster.entries?.DON?.title, 'ドン!!カード', 'ドン!!カードのシリーズ情報がありません');

for (const card of donCards) {
    assert.match(card.cardNumber, /^DON-\d{3}$/, `ドン!!カードIDが不正です: ${card.cardNumber}`);
    assert.equal(card.cardName, 'ドン!!カード');
    assert.equal(card.furigana, 'ドンカード');
    assert.equal(card.seriesCode, 'DON');
    assert.ok(manifest.cards?.[card.cardNumber]?.length > 0, `画像マニフェストにありません: ${card.cardNumber}`);
    await access(new URL(card.imagePath, root));
}

assert.match(appSource, /localStorage\.getItem\(DON_CARDS_VISIBLE_STORAGE_KEY\) === 'true'/);
assert.match(appSource, /cardNumber\.startsWith\('DON-'\)/);
assert.match(appSource, /ドン!!カードは通常デッキ50枚には含められません/);
assert.match(indexSource, /ドン!!カードをカード一覧に表示/);
assert.match(indexSource, /所持カード管理用です。デッキ作成・50枚判定には含まれません/);

console.log(`DON!! card tests passed: ${donCards.length} cards`);
