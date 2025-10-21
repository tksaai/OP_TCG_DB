// app.js (UI刷新・機能追加版)

const db = new Dexie('OnePieceCardDB_v5'); // DB名を変更してリセット
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, *features, effectText',
  meta: 'key, value'
});

// DOM要素の取得
const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');

// --- 新しく追加したUI要素 ---
const changeColumnsBtn = document.getElementById('change-columns-btn');
const cacheImagesBtn = document.getElementById('cache-images-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const refreshBtn = document.getElementById('refresh-btn'); // 削除してOK

// アプリケーションの状態を管理
const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  filters: { color: 'all', cardType: 'all', rarity: 'all' }
};

// --- 関数定義 (initializeApp, syncData, displayCards などは前回から変更なし) ---
async function initializeApp() {
  updateUI();
  
  try {
    const cardCount = await db.cards.count();
    if (cardCount > 0) {
      await setupFilters();
      await displayCards();
      syncData().catch(err => console.warn("バックグラウンド更新失敗:", err.message));
    } else {
      await syncData();
    }
  } catch (error) {
    console.error("初期化エラー:", error);
    statusMessageElement.textContent = `エラー: ${error.message}`;
  }
}

async function syncData() {
  statusMessageElement.textContent = 'カードデータを更新中...';
  statusMessageElement.style.display = 'block';
  
  const response = await fetch('./cards.json');
  if (!response.ok) throw new Error('cards.jsonの読み込みに失敗');
  
  const allCards = await response.json();
  
  await db.transaction('rw', db.cards, db.meta, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
    await db.meta.put({ key: 'lastUpdated', value: new Date().toISOString() });
  });
  
  await setupFilters();
  await displayCards();
  statusMessageElement.style.display = 'none';
}

async function displayCards() {
    // ... (前回から変更なし)
    // ただし、画像URLの生成部分を通常版に変更
    // imageUrlSmall -> imageUrl
    const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`; 
    cardDiv.innerHTML = `<img src="${imageUrl}" ...>`;
    // ...
}

function updateUI() { /* ... */ }
async function cacheAllImages() { /* ... */ }
async function clearAllCaches() { /* ... */ }

// --- イベントリスナー設定 ---
searchBox.addEventListener('input', displayCards);
changeColumnsBtn.addEventListener('click', () => { /* ... */ });
cacheImagesBtn.addEventListener('click', cacheAllImages);
clearCacheBtn.addEventListener('click', clearAllCaches);

// 設定モーダルの表示・非表示
settingsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  settingsModal.style.display = 'flex';
});
closeModalBtn.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    settingsModal.style.display = 'none';
  }
});


if ('serviceWorker' in navigator) { /* ... */ }

initializeApp();
