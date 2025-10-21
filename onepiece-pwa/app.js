// app.js

// 1. GASで取得したウェブアプリURLを貼り付け
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbz52k9T2aUVI5IBoNB2waO9mhtcH7YAsMgRg4R2-3ZxfOtkp1mLl6hTemIA9LNZvZWe/exec';

// 2. IndexedDBの準備
const db = new Dexie('OnePieceCardDB');
db.version(1).stores({
  cards: 'cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');

// 3. アプリの初期化処理
async function initializeApp() {
  const initialSyncDone = await db.meta.get('initialSyncDone');
  
  if (!initialSyncDone) {
    // 初回起動
    statusMessageElement.textContent = '初回データ取得中...（数分かかる場合があります）';
    try {
      const response = await fetch(CARD_API_URL);
      const allCards = await response.json();
      await db.cards.bulkAdd(allCards);
      await db.meta.put({ key: 'initialSyncDone', value: true });
    } catch (e) {
      statusMessageElement.textContent = 'データ取得に失敗しました。リロードしてください。';
      return;
    }
  } else {
    // 2回目以降はバックグラウンドで差分更新
    syncDifferentialData();
  }
  
  statusMessageElement.style.display = 'none';
  displayCards(); // ローカルデータで表示
}

// 差分更新処理
async function syncDifferentialData() {
    console.log('Checking for new P-cards...');
    const knownPCards = await db.cards.where('cardNumber').startsWith('P-').primaryKeys();
    const response = await fetch(`${CARD_API_URL}?knownPCards=${knownPCards.join(',')}`);
    const newCards = await response.json();

    if (newCards.length > 0) {
      console.log(`Found ${newCards.length} new cards.`);
      await db.cards.bulkAdd(newCards);
      displayCards(); // 新データを反映して再表示
    } else {
      console.log('No new cards found.');
    }
}


// 4. カード表示処理
async function displayCards() {
  const searchTerm = searchBox.value.toLowerCase();
  let collection = db.cards;

  if (searchTerm) {
    collection = collection.filter(card => 
        card.cardName.toLowerCase().includes(searchTerm) ||
        card.effectText.toLowerCase().includes(searchTerm) ||
        card.features.join(' ').toLowerCase().includes(searchTerm)
    );
  }

  const filteredCards = await collection.toArray();
  
  cardListElement.innerHTML = '';
  filteredCards.forEach(card => {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'card-item';
    // Google Driveの画像URLはGAS側で設定されたものをそのまま利用
    cardDiv.innerHTML = `<img src="${card.imageUrlSmall}" alt="${card.cardName}" loading="lazy">`;
    cardListElement.appendChild(cardDiv);
  });
}

// 5. イベントリスナーとService Worker登録
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

// 6. アプリケーション開始
initializeApp().catch(err => {
  console.error(err);
  statusMessageElement.textContent = 'エラーが発生しました。オフラインで起動します。';
  displayCards();
});
```**※注意**: `CARD_API_URL` には、ご自身が作成したGASのウェブアプリURLを必ず貼り付けてください。

#### 6. `service-worker.js`
```javascript
const CACHE_NAME = 'op-card-db-v1';
// パスを修正
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  'https://unpkg.com/dexie@3/dist/dexie.js',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});