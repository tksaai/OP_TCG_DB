// app.js (モーダル修正・完全版)

const db = new Dexie('OnePieceCardDB_v5'); // DB名を変更してリセット
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, *features, effectText',
  meta: 'key, value'
});

// DOM要素の取得
const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');
const changeColumnsBtn = document.getElementById('change-columns-btn');
const cacheImagesBtn = document.getElementById('cache-images-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalOverlay = document.getElementById('settings-modal'); // ★★★ エラー修正箇所 ★★★
const filterToolbar = document.querySelector('.filter-toolbar');

// アプリケーションの状態を管理
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
    await displayCards(); // エラーでも表示を試みる
  }
}

async function syncData() {
  statusMessageElement.textContent = 'カードデータを読み込み中...';
  statusMessageElement.style.display = 'block';
  
  const response = await fetch('./cards.json');
  if (!response.ok) throw new Error('cards.jsonの読み込みに失敗');
  
  const allCards = await response.json();
  console.log(`${allCards.length} 件のカードを取得しました。`);
  
  await db.transaction('rw', db.cards, db.meta, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
    await db.meta.put({ key: 'lastUpdated', value: new Date().toISOString() });
  });
  
  console.log('データベースを更新しました。');
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
            <div class="filter-group">
                <label for="color-filter">色:</label>
                <select id="color-filter" data-filter="color">
                    <option value="all">すべて</option>
                    ${[...new Set(colors.flat())].sort().map(c => `<option value="${c}">${c}</option>`).join('')}
                </select>
            </div>
            <div class="filter-group">
                <label for="type-filter">種類:</label>
                <select id="type-filter" data-filter="cardType">
                    <option value="all">すべて</option>
                    ${types.sort().map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="filter-group">
                <label for="rarity-filter">レアリティ:</label>
                <select id="rarity-filter" data-filter="rarity">
                    <option value="all">すべて</option>
                    ${rarities.sort().map(r => `<option value="${r}">${r}</option>`).join('')}
                </select>
            </div>
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
      statusMessageElement.textContent = 'カードデータがありません。オンラインでデータを読み込んでください。';
      statusMessageElement.style.display = 'block';
      return;
    }

    let collection = db.cards;
    // フィルタリング
    if (state.filters.color !== 'all') collection = collection.where('color').equals(state.filters.color);
    if (state.filters.cardType !== 'all') collection = collection.where('cardType').equals(state.filters.cardType);
    if (state.filters.rarity !== 'all') collection = collection.where('rarity').equals(state.filters.rarity);

    // 検索
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
      // ▼▼▼【重要】通常版の画像(.jpg)を読み込むように修正 ▼▼▼
      const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`;
      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'">`;
      fragment.appendChild(cardDiv);
    });
    cardListElement.appendChild(fragment);
    console.log(`${filteredCards.length}件のカードを表示しました。`);
  } catch(error) {
    console.error("カード表示エラー:", error);
  }
}

function updateUI() {
  changeColumnsBtn.textContent = `表示列数: ${state.columns}`;
  cardListElement.className = `card-grid cols-${state.columns}`;
}

async function cacheAllImages() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Service Workerが有効ではありません。');
    return;
  }
  statusMessageElement.textContent = '全画像のキャッシュを開始します...';
  statusMessageElement.style.display = 'block';

  try {
    const allCards = await db.cards.toArray();
    const imageUrls = allCards.map(card => {
      const series = card.cardNumber.split('-')[0];
      return `./Cards/${series}/${card.cardNumber}.jpg`; // 通常版をキャッシュ
    });
    
    navigator.serviceWorker.controller.postMessage({
      type: 'CACHE_IMAGES',
      payload: imageUrls
    });

    navigator.serviceWorker.onmessage = (event) => {
        if (event.data.type === 'CACHE_PROGRESS') {
            const { processed, total } = event.data.payload;
            statusMessageElement.textContent = `キャッシュ中... (${processed} / ${total})`;
        }
        if (event.data.type === 'CACHE_COMPLETE') {
            statusMessageElement.textContent = '全画像のキャッシュが完了しました！';
            setTimeout(() => { statusMessageElement.style.display = 'none'; }, 2000);
        }
    };
  } catch (err) {
    console.error('画像キャッシュエラー:', err);
    statusMessageElement.textContent = '画像のキャッシュ中にエラーが発生しました。';
  }
}

async function clearAllCaches() {
  if (!('caches' in window)) {
    alert('このブラウザはキャッシュ機能に対応していません。');
    return;
  }
  if (confirm('保存されている全てのキャッシュとデータを削除します。よろしいですか？')) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.unregister();
      
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      
      await db.delete();

      alert('キャッシュとデータベースを削除しました。ページを再読み込みします。');
      window.location.reload();
    } catch (error) {
      alert('キャッシュの削除に失敗しました。');
      console.error(error);
    }
  }
}

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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
    }).catch(err => console.error('ServiceWorker登録失敗:', err));
  });
}

initializeApp();