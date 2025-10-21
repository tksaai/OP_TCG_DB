// app.js (ID修正・最終版)

const db = new Dexie('OnePieceCardDB_v5');
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, *features, effectText',
  meta: 'key, value'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');
const changeColumnsBtn = document.getElementById('change-columns-btn');
const cacheImagesBtn = document.getElementById('cache-images-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal'); // これはモーダルの中身のウィンドウ用
const closeModalBtn = document.getElementById('close-modal-btn');
const modalOverlay = document.getElementById('modal-overlay'); // ★★★ IDを 'modal-overlay' に修正 ★★★
const filterToolbar = document.querySelector('.filter-toolbar');

const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  filters: { color: 'all', cardType: 'all', rarity: 'all' }
};

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
    statusMessageElement.textContent = `エラー: ${error.message}。`;
    await displayCards();
  }
}

async function syncData() {
  statusMessageElement.textContent = 'カードデータを読み込み中...';
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

async function setupFilters() {
    try {
        const colors = await db.cards.orderBy('color').uniqueKeys();
        const types = await db.cards.orderBy('cardType').uniqueKeys();
        const rarities = await db.cards.orderBy('rarity').uniqueKeys();

        filterToolbar.innerHTML = `
            <div class="filter-group"><label for="color-filter">色:</label><select id="color-filter" data-filter="color"><option value="all">すべて</option>${[...new Set(colors.flat())].sort().map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
            <div class="filter-group"><label for="type-filter">種類:</label><select id="type-filter" data-filter="cardType"><option value="all">すべて</option>${types.sort().map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
            <div class="filter-group"><label for="rarity-filter">レアリティ:</label><select id="rarity-filter" data-filter="rarity"><option value="all">すべて</option>${rarities.sort().map(r => `<option value="${r}">${r}</option>`).join('')}</select></div>
        `;
        filterToolbar.querySelectorAll('select').forEach(select => {
            select.addEventListener('change', (e) => {
                state.filters[e.target.dataset.filter] = e.target.value;
                displayCards();
            });
        });
    } catch (error) {
        console.error("フィルタのセットアップに失敗:", error);
    }
}

async function displayCards() {
  try {
    const cardCount = await db.cards.count();
    if (cardCount === 0) {
      statusMessageElement.textContent = 'カードデータがありません。';
      statusMessageElement.style.display = 'block';
      return;
    }

    let collection = db.cards;
    if (state.filters.color !== 'all') collection = collection.where('color').equals(state.filters.color);
    if (state.filters.cardType !== 'all') collection = collection.where('cardType').equals(state.filters.cardType);
    if (state.filters.rarity !== 'all') collection = collection.where('rarity').equals(state.filters.rarity);

    const searchTerm = searchBox.value.toLowerCase().trim();
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(Boolean);
      collection = collection.filter(card => {
        const targetText = [card.cardName, card.effectText, ...(card.features || [])].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }

    const filteredCards = await collection.toArray();
    statusMessageElement.style.display = 'none';
    cardListElement.innerHTML = '';
    const fragment = document.createDocumentFragment();
    filteredCards.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      const series = card.cardNumber.split('-')[0];
      const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`;
      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'">`;
      fragment.appendChild(cardDiv);
    });
    cardListElement.appendChild(fragment);
  } catch(error) {
    console.error("カード表示エラー:", error);
  }
}

function updateUI() {
  changeColumnsBtn.textContent = `表示列数: ${state.columns}`;
  cardListElement.className = `card-grid cols-${state.columns}`;
}

async function cacheAllImages() { /* 省略 */ }
async function clearAllCaches() { /* 省略 */ }

// --- イベントリスナー ---
searchBox.addEventListener('input', displayCards);
document.getElementById('refresh-btn').addEventListener('click', () => {
    searchBox.value = '';
    document.querySelectorAll('.filter-toolbar select').forEach(s => s.value = 'all');
    Object.keys(state.filters).forEach(key => state.filters[key] = 'all');
    displayCards();
});
cacheImagesBtn.addEventListener('click', cacheAllImages);
clearCacheBtn.addEventListener('click', clearAllCaches);
changeColumnsBtn.addEventListener('click', () => {
  state.columns = (state.columns % 5) + 1;
  localStorage.setItem('columnCount', state.columns);
  updateUI();
});

settingsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  modalOverlay.style.display = 'flex';
});
closeModalBtn.addEventListener('click', () => {
  modalOverlay.style.display = 'none';
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.style.display = 'none';
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
    }).catch(err => console.error('ServiceWorker登録失敗:', err));
  });
}

initializeApp();