// リポジトリに置くデータと画面の前提が崩れていないかを確認する。
// 同期ワークフローで実行し、壊れたデータをコミットしないようにする。

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const readJson = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));

const cards = await readJson('cards.json');
const manifest = await readJson('image-manifest.json');
const cardFeatures = await readJson('card-features.json');
const provisional = await readJson('provisional-cards.json');
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const provisionalWorkflow = await readFile(new URL('../.github/workflows/sync-provisional-cards.yml', import.meta.url), 'utf8');
const newReleaseSync = await readFile(new URL('./sync-new-release.mjs', import.meta.url), 'utf8');

// --- カードデータ ---------------------------------------------------------
assert.ok(Array.isArray(cards) && cards.length > 1000, 'cards.json のカード数が少なすぎます');
assert.ok(cards.every(card => card && card.cardNumber), 'cardNumber の無いカードがあります');
const eightPackLeader = cards.find(card => card?.cardNumber === 'P');
assert.ok(eightPackLeader, '8パックバトル専用リーダー P がありません');
assert.equal(eightPackLeader.cardType, 'LEADER', '8パックバトル専用カード P がリーダーではありません');
assert.equal(eightPackLeader.costLifeValue, 5, '8パックバトル専用リーダー P のライフは5です');
assert.deepEqual(
  eightPackLeader.color,
  ['赤', '緑', '青', '紫', '黒', '黄'],
  '8パックバトル専用リーダー P は6色すべてを持つ必要があります'
);

// --- 画像マニフェスト -----------------------------------------------------
const variants = Object.values(manifest.cards || {}).flat();
assert.ok(variants.length > 1000, 'image-manifest.json の画像が少なすぎます');
assert.ok(
  Array.isArray(manifest.cards?.P) && manifest.cards.P.length >= 2,
  '8パックバトル専用リーダー P の公式画像が2種以上必要です'
);
await Promise.all(manifest.cards.P.map(async variant => {
  try {
    await access(new URL(`../${variant.path}`, import.meta.url));
  } catch {
    assert.fail(`8パックバトル専用リーダー画像が存在しません: ${variant.path}`);
  }
}));
const eightPackFeaturePaths = new Set(
  (cardFeatures.features || [])
    .filter(feature => feature?.n === 'P')
    .map(feature => feature.p)
);
assert.deepEqual(
  eightPackFeaturePaths,
  new Set(manifest.cards.P.map(variant => variant.path)),
  '8パックバトル専用リーダーの画像特徴量が不足しています'
);
assert.equal(
  manifest.totalImages,
  variants.length,
  'image-manifest.json の totalImages が実際の件数と合っていません'
);

// 配信するのは WebP のみ。元画像 (Cards/) はリポジトリに置かない
const nonWebp = variants.filter(variant => !String(variant.path || '').startsWith('CardsWebP/'));
assert.equal(nonWebp.length, 0, `WebP 以外を指している画像が ${nonWebp.length} 件あります: ${nonWebp[0]?.path}`);

const staleFallback = variants.filter(variant => String(variant.fallbackPath || '').startsWith('Cards/'));
assert.equal(
  staleFallback.length,
  0,
  `リポジトリに無い Cards/ を fallbackPath に持つ画像が ${staleFallback.length} 件あります`
);

// --- 仮DB -----------------------------------------------------------------
const provisionalCards = Array.isArray(provisional) ? provisional : provisional.cards;
assert.ok(Array.isArray(provisionalCards), 'provisional-cards.json からカード配列を取得できません');
const provisionalWithoutWebp = provisionalCards.filter(
  card => !String(card?.imagePath || '').startsWith('CardsWebP/Provisional/')
);
assert.equal(
  provisionalWithoutWebp.length,
  0,
  `仮DBの imagePath が配信用WebPではないカードが ${provisionalWithoutWebp.length} 件あります: ${provisionalWithoutWebp[0]?.imagePath}`
);
await Promise.all(provisionalCards.map(async card => {
  const imagePath = String(card?.imagePath || '');
  try {
    await access(new URL(`../${imagePath}`, import.meta.url));
  } catch {
    assert.fail(`仮DB画像が存在しません: ${card?.cardNumber || 'unknown'} ${imagePath}`);
  }
}));

const convertStep = provisionalWorkflow.indexOf('python scripts/convert-images-to-webp.py');
const updatePathsStep = provisionalWorkflow.indexOf('node scripts/update-provisional-image-paths.mjs');
const finalIntegrityStep = provisionalWorkflow.lastIndexOf('node scripts/test-data-integrity.mjs');
const commitStep = provisionalWorkflow.indexOf('git commit -m "Sync provisional cards"');
assert.ok(
  convertStep >= 0 && convertStep < updatePathsStep && updatePathsStep < finalIntegrityStep && finalIntegrityStep < commitStep,
  '仮DB同期は WebP変換、参照更新、整合性検査の順でコミット前に実行してください'
);

// --- 画面 -----------------------------------------------------------------
// ネイティブの confirm/prompt は PWA で割り込むため、アプリ内モーダルに寄せている
const nativeDialogs = appJs.match(/[^a-zA-Z.](?:confirm|prompt)\(/gu) || [];
assert.equal(
  nativeDialogs.length,
  0,
  `app.js にネイティブの confirm/prompt が ${nativeDialogs.length} 箇所残っています`
);
assert.match(appJs, /function confirmDialog\(/u, 'confirmDialog がありません');
assert.match(appJs, /function promptDialog\(/u, 'promptDialog がありません');
assert.match(indexHtml, /id="app-dialog-modal"/u, '確認ダイアログのマークアップがありません');
assert.equal(
  (indexHtml.match(/id="app-dialog-modal"/gu) || []).length,
  1,
  '確認ダイアログのマークアップが重複しています'
);

// 書き込みトークンの入力欄はアプリ本体から分離してある
assert.doesNotMatch(indexHtml, /id="github-token-input"/u, 'index.html に GitHub token の入力欄が残っています');

// 一覧は分割描画 (件数が多いため一度に DOM を作らない)
assert.match(appJs, /INITIAL_RENDER_COUNT/u, '一覧の分割描画が入っていません');
assert.match(appJs, /cardNumber === 'P'/u, 'カード番号 P を共有デッキで扱えません');
assert.match(newReleaseSync, /sync-eight-pack-leader\.mjs/u, '日次同期に8パックバトル専用リーダー同期がありません');

console.log(`Data integrity tests passed. (cards: ${cards.length}, images: ${variants.length})`);
