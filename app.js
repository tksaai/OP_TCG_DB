// app.js (画像キャッシュ改善・表示改善版)

const db = new Dexie('OnePieceCardDB_v6');
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
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalOverlay = document.getElementById('modal-overlay');
const filterToolbar = document.querySelector('.filter-toolbar');
const refreshBtn = document.getElementById('refresh-btn');

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
      
      // ▼▼▼ 表示するHTMLの構造を変更 ▼▼▼
      cardDiv.innerHTML = `
        <img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
        <div class="card-placeholder">${card.cardNumber}</div>
      `;
      
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

/**
 * 全ての画像をキャッシュする（修正版）
 */
async function cacheAllImages() {
  // Service Workerが準備完了しているか確認
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Service Workerが有効ではありません。ページを再読み込みしてから再度お試しください。');
    return;
  }
  statusMessageElement.textContent = '全画像のキャッシュを開始します...';
  statusMessageElement.style.display = 'block';

  try {
    const allCards = await db.cards.toArray();
    const imageUrls = allCards.map(card => {
      const series = card.cardNumber.split('-')[0];
      return `./Cards/${series}/${card.cardNumber}.jpg`;
    }).filter(url => url); // 空のURLを除外

    // Service Workerにキャッシュを依頼するメッセージを送信
    navigator.serviceWorker.controller.postMessage({
      type: 'CACHE_IMAGES',
      payload: imageUrls
    });

    // Service Workerからの進捗報告を受け取るリスナー
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
refreshBtn.addEventListener('click', () => {
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
  navigator.serviceWorker.register('./service-worker.js').then(reg => {
    console.log('ServiceWorker登録成功');
    // Service Workerが完全にアクティブになるのを待つ
    return navigator.serviceWorker.ready;
  }).then(() => {
    console.log('ServiceWorker準備完了');
  }).catch(err => console.error('ServiceWorker登録失敗:', err));
}

initializeApp();