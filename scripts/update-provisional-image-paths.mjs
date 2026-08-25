// provisional-cards.json の imagePath を、変換済みの WebP に差し替える。
//
// 仮DBの画像は Cards/Provisional/ にダウンロードされるが、リポジトリに残すのは
// CardsWebP/ だけ。WebP が用意できているものだけを安全に差し替える
// (未変換のものは元のパスのまま残すので、変換前でも壊れない)。

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_DIR = 'Cards';
const WEBP_DIR = 'CardsWebP';
const TARGET_FILE = 'provisional-cards.json';
const dryRun = process.argv.includes('--dry-run');

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toWebPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function webpPathFor(imagePath) {
  if (!imagePath.startsWith(`${SOURCE_DIR}/`)) return '';
  const relative = imagePath.slice(SOURCE_DIR.length + 1);
  return toWebPath(path.join(WEBP_DIR, relative)).replace(/\.[^.]+$/, '.webp');
}

const raw = JSON.parse(await readFile(TARGET_FILE, 'utf8'));
const cards = Array.isArray(raw) ? raw : raw.cards;
if (!Array.isArray(cards)) {
  throw new Error(`${TARGET_FILE} からカード配列を取得できませんでした。`);
}

let updated = 0;
let skipped = 0;

for (const card of cards) {
  const imagePath = String(card?.imagePath || '');
  if (!imagePath.startsWith(`${SOURCE_DIR}/`)) continue;

  const webpPath = webpPathFor(imagePath);
  if (!webpPath || !(await exists(webpPath))) {
    skipped += 1;
    console.warn(`[skip] WebP が見つかりません: ${imagePath}`);
    continue;
  }

  card.imagePath = webpPath;
  updated += 1;
}

if (updated && !dryRun) {
  await writeFile(TARGET_FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

console.log(`${dryRun ? '[dry-run] ' : ''}imagePath を WebP に更新: ${updated} 件 (未変換のため据え置き: ${skipped} 件)`);
