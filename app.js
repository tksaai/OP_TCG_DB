// app.js

// 1. GASで取得したウェブアプリURLを貼り付け
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbz52k9T2aUVI5IBoNB2waO9mhtcH7YAsMgRg4R2-3ZxfOtkp1mLl6hTemIA9LNZvZWe/exec';

// IndexedDBの準備
const db = new Dexie('OnePieceCardDB');
db.version(1).stores({
  cards: 'cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  const initialSyncDone = await db.meta.get('initialSyncDone');
  
  try {
    if (!initialSyncDone) {
      // --- 初回起動 ---
      await syncFullData();
    } else {
      // --- 2回目以降 ---
      // まずローカルデータで即時表示
      displayCards(); 
      // バックグラウンドで差分更新
      await syncDifferentialData();
    }
  } catch (error) {
    console.error("Initialization/Sync failed:", error);
    statusMessageElement.textContent = 'データ更新に失敗。オフラインで起動します。';
  } finally {
    statusMessageElement.style.display = 'none';
    displayCards(); // 最終的に必ずローカルデータで表示を試みる
  }
}

/**
 * 全データを取得してDBを初期化する
 */
async function syncFullData() {
  statusMessageElement.textContent = '初回データ取得中...（数分かかる場合があります）';
  const response = await fetch(CARD_API_URL);
  if (!response.ok) throw new Error(`API returned status ${response.status}`);
  const allCards = await response.json();

  await db.cards.clear(); // 念のためクリア
  await db.cards.bulkAdd(allCards);
  await db.meta.put({ key: 'initialSyncDone', value: true });
  console.log('Initial sync complete.');
}

/**
 * 差分データ（新しいPカード）を取得してDBを更新する
 */
async function syncDifferentialData() {
    console.log('Checking for new P-cards...');
    const knownPCards = await db.cards.where('cardNumber').startsWith('P-').primaryKeys();
    
    // バッククォート(`)を使ったテンプレートリテラルでURLを構築
    const requestUrl = CARD_API_URL + '?knownPCards=' + knownPCards.join(',');
    
    const response = await fetch(requestUrl);
    if (!response.ok) throw new Error(`API returned status ${response.status} for diff sync`);
    const newCards = await response.json();

    if (newCards.length > 0) {
      console.log(`Found ${newCards.length} new cards. Updating local database...`);
      await db.cards.bulkAdd(newCards);
      await displayCards(); // 新データを反映して再表示
    } else {
      console.log('No new cards found.');
    }
}

/**
 * IndexedDBからカードデータを読み込み、画面に表示する
 */
async function displayCards() {
  const searchTerm = searchBox.value.toLowerCase().trim();
  
  let collection = db.cards;

  if (searchTerm) {
    const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
    collection = collection.filter(card => {
      const targetText = [
        card.cardName,
        card.effectText,
        ...card.features
      ].join(' ').toLowerCase();
      return searchWords.every(word => targetText.includes(word));
    });
  }

  const filteredCards = await collection.toArray();
  
  cardListElement.innerHTML = '';
  filteredCards.forEach(card => {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'card-item';
    cardDiv.innerHTML = `<img src="${card.imageUrlSmall}" alt="${card.cardName}" loading="lazy">`;
    cardListElement.appendChild(cardDiv);
  });
}

// イベントリスナーとService Worker登録
searchBox.addEventListener('input', displayCards);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker Registered.');
    }).catch(err => {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}

// アプリケーション開始
initializeApp();

