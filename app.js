// app.js (機能追加・最終完成版)

// GAS側のAPIはもう使用しないため、コメントアウトまたは削除してもOKです
// const CARD_API_URL = '...';

// IndexedDBの準備
const db = new Dexie('OnePieceCardDB_v3'); // DB名をリセット
db.version(1).stores({
  cards: '++id, cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');
const changeColumnsBtn = document.getElementById('change-columns-btn');
const refreshBtn = document.getElementById('refresh-btn');
const cacheImagesBtn = document.getElementById('cache-images-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');

// 表示列数の状態管理
let currentColumns = parseInt(localStorage.getItem('columnCount') || '3', 10);

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  try {
    updateColumnButtonText(); // ボタンのテキストを初期化
    cardListElement.className = `card-grid cols-${currentColumns}`; // 保存した列数を適用

    const cardCount = await db.cards.count();
    
    if (cardCount > 0) {
      statusMessageElement.style.display = 'none';
      await displayCards();
      // バックグラウンドで更新チェック
      syncData().catch(err => console.warn("バックグラウンド更新失敗:", err.message));
    } else {
      await syncData();
    }
  } catch (error) {
    console.error("初期化エラー:", error);
    statusMessageElement.textContent = `エラー: ${error.message}`;
  }
}

/**
 * ローカルのJSONファイルからデータを取得し、DBを更新する
 */
async function syncData() {
  try {
    statusMessageElement.textContent = 'カードデータを読み込み中...';
    statusMessageElement.style.display = 'block';
    
    // ローカルのJSONファイルを読み込む (このファイルは後で作成)
    const response = await fetch('./cards.json'); 
    if (!response.ok) throw new Error('cards.jsonの読み込みに失敗しました。');
    
    const allCards = await response.json();
    console.log(`${allCards.length} 件のカードデータをファイルから取得しました。`);
    
    await db.transaction('rw', db.cards, async () => {
      await db.cards.clear();
      await db.cards.bulkAdd(allCards);
    });
    
    console.log('ローカルデータベースを更新しました。');
    await displayCards();
  } finally {
    statusMessageElement.style.display = 'none';
  }
}

/**
 * DBからカードを読み込み、画面に表示する
 */
async function displayCards() {
  try {
    const cardCount = await db.cards.count();
    if (cardCount === 0) return;

    const searchTerm = searchBox.value.toLowerCase().trim();
    let collection = db.cards;
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
      collection = collection.filter(card => {
        const targetText = [card.cardName, card.effectText, ...(Array.isArray(card.features) ? card.features : [])].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }
    const filteredCards = await collection.toArray();
    
    cardListElement.innerHTML = '';
    const fragment = document.createDocumentFragment();
    filteredCards.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      
      // ★★★ 相対パスで画像URLを生成 ★★★
      const series = card.cardNumber.split('-')[0];
      const imageUrl = `./Cards/${series}/${card.cardNumber}_small.jpg`;

      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.parentElement.style.display='none'">`;
      fragment.appendChild(cardDiv);
    });
    cardListElement.appendChild(fragment);
    console.log(`${filteredCards.length}件のカードを表示しました。`);
  } catch(error) {
    console.error("カード表示処理エラー:", error);
  }
}

/**
 * 表示列数ボタンのテキストを更新する
 */
function updateColumnButtonText() {
  changeColumnsBtn.textContent = `表示列数: ${currentColumns}`;
}

/**
 * 全ての画像をキャッシュする
 */
async function cacheAllImages() {
  if (!('caches' in window)) {
    alert('このブラウザはキャッシュ機能に対応していません。');
    return;
  }
  statusMessageElement.textContent = '全画像のキャッシュを開始します...';
  statusMessageElement.style.display = 'block';

  try {
    const allCards = await db.cards.toArray();
    const imageUrls = allCards.map(card => {
      const series = card.cardNumber.split('-')[0];
      return `./Cards/${series}/${card.cardNumber}_small.jpg`;
    });
    
    const cache = await caches.open('op-card-images');
    let cachedCount = 0;
    
    for (const url of imageUrls) {
      // 既にキャッシュに存在するか確認
      const cachedResponse = await cache.match(url);
      if (!cachedResponse) {
        await cache.add(url);
      }
      cachedCount++;
      statusMessageElement.textContent = `キャッシュ中... (${cachedCount} / ${imageUrls.length})`;
    }

    statusMessageElement.textContent = '全画像のキャッシュが完了しました！';
    setTimeout(() => { statusMessageElement.style.display = 'none'; }, 2000);
  } catch (err) {
    console.error('画像キャッシュエラー:', err);
    statusMessageElement.textContent = '画像のキャッシュ中にエラーが発生しました。';
  }
}

/**
 * 全てのキャッシュを削除する
 */
async function clearAllCaches() {
  if (!('caches' in window)) {
    alert('このブラウザはキャッシュ機能に対応していません。');
    return;
  }
  if (confirm('保存されている全てのカード画像キャッシュを削除します。よろしいですか？')) {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    
    // Service Workerの登録を解除して再読み込みを促す
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.unregister();
    }
    alert('キャッシュを削除しました。ページを再読み込みします。');
    window.location.reload();
  }
}

// --- イベントリスナー設定 ---
searchBox.addEventListener('input', displayCards);
refreshBtn.addEventListener('click', displayCards);
cacheImagesBtn.addEventListener('click', cacheAllImages);
clearCacheBtn.addEventListener('click', clearAllCaches);

changeColumnsBtn.addEventListener('click', () => {
  currentColumns++;
  if (currentColumns > 5) {
    currentColumns = 1;
  }
  localStorage.setItem('columnCount', currentColumns);
  updateColumnButtonText();
  cardListElement.className = `card-grid cols-${currentColumns}`;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
    }).catch(err => {
      console.error('ServiceWorker登録失敗:', err);
    });
  });
}

// アプリケーション開始
initializeApp();
