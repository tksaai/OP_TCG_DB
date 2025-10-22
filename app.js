// app.js (全機能実装・省略なし最終版)

// Dexie.js (IndexedDB) の設定
const db = new Dexie('OnePieceCardDB_v8'); // DB名を変更して完全にリセット
db.version(1).stores({
  // uniqueIdを主キーに、検索対象のプロパティをインデックスとして設定
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, *features, getInfo',
  meta: 'key, value' // 最終更新日などを保存
});

// DOM要素の取得
const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');
const changeColumnsBtn = document.getElementById('change-columns-btn');
const columnsText = document.getElementById('columns-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-settings-btn');
const filterBtn = document.getElementById('filter-btn');
const filterModal = document.getElementById('filter-modal');
const closeFilterBtn = document.getElementById('close-filter-btn');
const clearFilterBtn = document.getElementById('clear-filter-btn');
const applyFilterBtn = document.getElementById('apply-filter-btn');
const cacheImagesBtn = document.getElementById('cache-images-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const lightboxModal = document.getElementById('lightbox-modal');
const lightboxImg = document.getElementById('lightbox-img');
const closeLightboxBtn = document.getElementById('close-lightbox-btn');
const filterToolbar = document.querySelector('.filter-toolbar');

// アプリケーションの状態管理オブジェクト
const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  filters: JSON.parse(localStorage.getItem('filters')) || {}
};

let allCards = []; // 全カードデータをメモリにキャッシュして高速化

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  updateUI();
  try {
    const cardCount = await db.cards.count();
    if (cardCount > 0) {
      allCards = await db.cards.toArray();
      await setupFilters();
      await displayCards();
      // バックグラウンドで更新チェック
      syncData().catch(err => console.warn("バックグラウンド更新失敗:", err.message));
    } else {
      await syncData();
    }
  } catch (error) {
    console.error("初期化エラー:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。`;
  }
}

/**
 * ローカルのJSONファイルからデータを取得し、DBを更新する
 */
async function syncData() {
  statusMessageElement.textContent = 'カードデータを更新中...';
  statusMessageElement.style.display = 'block';
  
  const response = await fetch('./cards.json');
  if (!response.ok) throw new Error('cards.jsonの読み込みに失敗');
  
  const cards = await response.json();
  
  await db.transaction('rw', db.cards, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(cards);
  });
  
  allCards = await db.cards.toArray();
  
  await setupFilters();
  await displayCards();
  statusMessageElement.style.display = 'none';
}

/**
 * DBからユニークな値を取得し、フィルタ選択肢を生成する
 */
async function setupFilters() {
    const filterOptions = document.getElementById('filter-options');
    if (!filterOptions) return;
    
    const uniqueValues = {
        color: new Set(), cardType: new Set(), attribute: new Set(),
        rarity: new Set(), getInfo: new Set()
    };

    allCards.forEach(card => {
        card.color.forEach(c => uniqueValues.color.add(c));
        if(card.cardType) uniqueValues.cardType.add(card.cardType);
        if(card.attribute && card.attribute !== '-') uniqueValues.attribute.add(card.attribute);
        if(card.rarity) uniqueValues.rarity.add(card.rarity);
        if(card.getInfo) uniqueValues.getInfo.add(card.getInfo.split('【')[0].trim());
    });

    const createButtons = (values, key) => Array.from(values).sort().map(val => 
        `<button class="filter-option-btn ${state.filters[key]?.includes(val) ? 'active' : ''}" data-filter="${key}" data-value="${val}">${val}</button>`
    ).join('');
    
    filterOptions.innerHTML = `
        <div class="filter-section"><h3>TYPE</h3><div class="filter-buttons">${createButtons(uniqueValues.cardType, 'cardType')}</div></div>
        <div class="filter-section"><h3>COLOR</h3><div class="filter-buttons color-filter">${createButtons(uniqueValues.color, 'color')}</div></div>
        <div class="filter-section"><h3>COST</h3><div class="filter-buttons">${[...Array(11).keys()].map(i => `<button class="filter-option-btn ${state.filters.costLifeValue?.includes(String(i)) ? 'active' : ''}" data-filter="costLifeValue" data-value="${i}">${i}</button>`).join('')}</div></div>
        <div class="filter-section"><h3>ATTRIBUTES</h3><div class="filter-buttons">${createButtons(uniqueValues.attribute, 'attribute')}</div></div>
        <div class="filter-section"><h3>RARITY</h3><div class="filter-buttons">${createButtons(uniqueValues.rarity, 'rarity')}</div></div>
        <div class="filter-section"><h3>SERIESフィルタ</h3><select class="series-select" id="filter-getInfo"><option value="all">SERIESを選択</option>${Array.from(uniqueValues.getInfo).sort().map(s => `<option value="${s}" ${state.filters.getInfo?.includes(s) ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    `;

    filterOptions.querySelectorAll('.filter-option-btn').forEach(btn => {
        btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
}

/**
 * DBからカードを読み込み、画面に表示する
 */
async function displayCards() {
  try {
    if (allCards.length === 0) {
      statusMessageElement.textContent = 'カードデータがありません。';
      statusMessageElement.style.display = 'block';
      return;
    }

    let filtered = [...allCards];

    // フィルタリング処理
    Object.keys(state.filters).forEach(key => {
        const values = state.filters[key];
        if (values && values.length > 0) {
            filtered = filtered.filter(card => {
                if (key === 'getInfo') {
                    return values.some(v => card.getInfo.startsWith(v));
                }
                if(Array.isArray(card[key])) {
                    return values.some(v => card[key].includes(v));
                }
                return values.includes(String(card[key]));
            });
        }
    });

    // 検索処理
    const searchTerm = searchBox.value.toLowerCase().trim();
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(Boolean);
      filtered = filtered.filter(card => {
        const targetText = [card.cardName, card.effectText, ...(card.features || [])].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }

    statusMessageElement.style.display = 'none';
    cardListElement.innerHTML = '';
    const fragment = document.createDocumentFragment();

    filtered.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      const series = card.cardNumber.split('-')[0];
      const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`; // 通常版画像
      
      cardDiv.innerHTML = `
        <img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="card-placeholder">${card.cardNumber}</div>
      `;
      cardDiv.addEventListener('click', () => openLightbox(imageUrl));
      fragment.appendChild(cardDiv);
    });

    cardListElement.appendChild(fragment);
  } catch(error) {
    console.error("カード表示エラー:", error);
  }
}

function openLightbox(src) {
    lightboxImg.src = src;
    lightboxModal.style.display = 'flex';
}

function updateUI() {
  columnsText.textContent = `${state.columns}列`;
  cardListElement.className = `card-grid cols-${state.columns}`;
}

async function cacheAllImages() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Service Workerが有効ではありません。ページを再読み込みしてから再度お試しください。');
    return;
  }
  statusMessageElement.textContent = '全画像のキャッシュを開始します...';
  statusMessageElement.style.display = 'block';

  try {
    const imageUrls = allCards.map(card => {
      const series = card.cardNumber.split('-')[0];
      return `./Cards/${series}/${card.cardNumber}.jpg`;
    }).filter(url => url);

    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_IMAGES', payload: imageUrls });

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

// --- イベントリスナー設定 ---
searchBox.addEventListener('input', displayCards);

filterBtn.addEventListener('click', () => filterModal.style.display = 'flex');
closeFilterBtn.addEventListener('click', () => filterModal.style.display = 'none');
filterModal.addEventListener('click', (e) => {
    if(e.target === filterModal) filterModal.style.display = 'none';
});

applyFilterBtn.addEventListener('click', () => {
    state.filters = {};
    filterModal.querySelectorAll('.filter-buttons button.active').forEach(btn => {
        const key = btn.dataset.filter;
        if (!state.filters[key]) state.filters[key] = [];
        state.filters[key].push(btn.dataset.value);
    });
    const seriesSelect = document.getElementById('filter-getInfo');
    if (seriesSelect.value !== 'all') {
        state.filters.getInfo = [seriesSelect.value];
    }
    localStorage.setItem('filters', JSON.stringify(state.filters));
    displayCards();
    filterModal.style.display = 'none';
});

clearFilterBtn.addEventListener('click', () => {
    filterModal.querySelectorAll('.filter-buttons button.active').forEach(btn => btn.classList.remove('active'));
    document.getElementById('filter-getInfo').value = 'all';
    state.filters = {};
    localStorage.removeItem('filters');
});

changeColumnsBtn.addEventListener('click', (e) => {
  e.preventDefault();
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
settingsModal.addEventListener('click', (e) => {
    if(e.target === settingsModal) settingsModal.style.display = 'none';
});

closeLightboxBtn.addEventListener('click', () => lightboxModal.style.display = 'none');
lightboxModal.addEventListener('click', (e) => {
    if (e.target === lightboxModal) lightboxModal.style.display = 'none';
});

// Service Worker登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
    }).catch(err => console.error('ServiceWorker登録失敗:', err));
  });
}

// アプリケーション開始
initializeApp();