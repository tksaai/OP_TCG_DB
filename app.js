// app.js (全機能実装・全修正反映・省略なし最終版)

const db = new Dexie('OnePieceCardDB_v12'); // DB名を変更して完全にリセット
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, seriesCode, *features, effectText',
  meta: 'key, value'
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
const modalOverlay = document.getElementById('modal-overlay');
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
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBar = document.getElementById('progress-bar');

// アプリケーションの状態管理オブジェクト
const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  filters: JSON.parse(localStorage.getItem('filters')) || {}
};

let allCards = []; // 全カードデータをメモリにキャッシュして高速化

async function initializeApp() {
  updateUI();
  try {
    const cardCount = await db.cards.count();
    if (cardCount > 0) {
      allCards = await db.cards.toArray();
      await setupFilters();
      await displayCards();
      syncData().catch(err => console.warn("バックグラウンド更新失敗:", err.message));
    } else {
      await syncData();
    }
  } catch (error) {
    console.error("初期化エラー:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。`;
  }
}

async function syncData() {
  statusMessageElement.textContent = 'カードデータを更新中...';
  statusMessageElement.style.display = 'block';
  
  try {
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
  } finally {
    statusMessageElement.style.display = 'none';
  }
}

async function setupFilters() {
    try {
        const filterOptions = document.getElementById('filter-options');
        if (!filterOptions) return;
        
        const uniqueValues = {
            color: new Set(), cardType: new Set(), attribute: new Set(),
            rarity: new Set(), series: new Map()
        };

        allCards.forEach(card => {
            card.color.forEach(c => uniqueValues.color.add(c));
            if(card.cardType) uniqueValues.cardType.add(card.cardType);
            if(card.attribute && card.attribute !== '-') uniqueValues.attribute.add(card.attribute);
            if(card.rarity) uniqueValues.rarity.add(card.rarity);
            if(card.seriesCode && !card.cardNumber.startsWith('P-')) {
                uniqueValues.series.set(card.seriesCode, card.seriesTitle);
            }
        });
        
        // ★★★ レアリティのリストから 'SP' を除外 ★★★
        const raritiesWithoutSP = Array.from(uniqueValues.rarity).filter(r => r !== 'SP');

        const createButtons = (values, key) => values.sort((a,b) => a.localeCompare(b, undefined, {numeric: true})).map(val => 
            `<button class="filter-option-btn ${state.filters[key]?.includes(val) ? 'active' : ''}" data-filter="${key}" data-value="${val}">${val}</button>`
        ).join('');
        
        const seriesOptions = Array.from(uniqueValues.series.entries())
            .sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true}))
            .map(([code, title]) => `<option value="${code}" ${state.filters.seriesCode?.includes(code) ? 'selected' : ''}>${code} ${title}</option>`)
            .join('');
        
        filterOptions.innerHTML = `
            <div class="filter-section"><h3>TYPE</h3><div class="filter-buttons">${createButtons(Array.from(uniqueValues.cardType), 'cardType')}</div></div>
            <div class="filter-section"><h3>COLOR</h3><div class="filter-buttons color-filter">${createButtons(Array.from(uniqueValues.color), 'color')}</div></div>
            <div class="filter-section"><h3>RARITY</h3><div class="filter-buttons">${createButtons(raritiesWithoutSP, 'rarity')}</div></div>
            <div class="filter-section"><h3>SERIESフィルタ</h3><select class="series-select" id="filter-series"><option value="all">SERIESを選択</option>${seriesOptions}</select></div>
            <div class="filter-section"><h3>ATTRIBUTES</h3><div class="filter-buttons">${createButtons(Array.from(uniqueValues.attribute), 'attribute')}</div></div>
            <div class="filter-section"><h3>COST</h3><div class="filter-buttons">${[...Array(11).keys()].map(i => `<button class="filter-option-btn ${state.filters.costLifeValue?.includes(String(i)) ? 'active' : ''}" data-filter="costLifeValue" data-value="${i}">${i}</button>`).join('')}</div></div>
        `;

        filterOptions.querySelectorAll('.filter-option-btn').forEach(btn => {
            btn.addEventListener('click', () => btn.classList.toggle('active'));
        });
    } catch (error) {
        console.error("フィルタのセットアップに失敗:", error);
    }
}

async function displayCards() {
  try {
    const cardCount = allCards.length;
    if (cardCount === 0) {
      statusMessageElement.textContent = 'カードデータがありません。';
      statusMessageElement.style.display = 'block';
      return;
    }

    let filtered = [...allCards];

    // フィルタリング処理
    if (Object.keys(state.filters).length > 0) {
        filtered = allCards.filter(card => {
            return Object.keys(state.filters).every(key => {
                const values = state.filters[key];
                if (!values || values.length === 0) return true;
                
                if (key === 'seriesCode') {
                    return values.some(v => card.seriesCode === v);
                }
                if(Array.isArray(card[key])) {
                    return values.some(v => card[key].includes(v));
                }
                return values.includes(String(card[key]));
            });
        });
    }

    // 検索処理
    const searchTerm = searchBox.value.toLowerCase().trim();
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(Boolean);
      filtered = filtered.filter(card => {
        const targetText = [card.cardName, card.effectText, card.cardNumber, ...(card.features || [])].join(' ').toLowerCase();
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
      const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`;
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
    alert('Service Workerが有効ではありません。ページを再読み込み後、再度お試しください。');
    return;
  }
  cacheImagesBtn.disabled = true;
  cacheImagesBtn.textContent = 'キャッシュ中...';
  progressBarContainer.style.display = 'block';
  progressBar.style.width = '0%';
  statusMessageElement.textContent = '全画像のキャッシュを開始します...';
  statusMessageElement.style.display = 'block';

  try {
    const imageUrls = allCards.map(card => {
      const series = card.cardNumber.split('-')[0];
      return `./Cards/${series}/${card.cardNumber}.jpg`;
    }).filter(Boolean);

    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_IMAGES', payload: imageUrls });

    navigator.serviceWorker.onmessage = (event) => {
        if (event.data.type === 'CACHE_PROGRESS') {
            const { processed, total } = event.data.payload;
            const percentage = total > 0 ? (processed / total) * 100 : 0;
            progressBar.style.width = `${percentage}%`;
            statusMessageElement.textContent = `キャッシュ中... (${processed} / ${total})`;
        }
        if (event.data.type === 'CACHE_COMPLETE') {
            progressBar.style.width = '100%';
            statusMessageElement.textContent = '全画像のキャッシュが完了しました！';
            setTimeout(() => {
              statusMessageElement.style.display = 'none';
              progressBarContainer.style.display = 'none';
            }, 2000);
            cacheImagesBtn.disabled = false;
            cacheImagesBtn.textContent = '全画像キャッシュ';
        }
    };
  } catch (err) {
    console.error('画像キャッシュエラー:', err);
    statusMessageElement.textContent = '画像のキャッシュ中にエラーが発生しました。';
    progressBarContainer.style.display = 'none';
    cacheImagesBtn.disabled = false;
    cacheImagesBtn.textContent = '全画像キャッシュ';
  }
}

async function clearAllCaches() {
  if (!('caches' in window)) return;
  if (confirm('保存されている全てのキャッシュとデータを削除しますか？')) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.unregister();
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      await db.delete();
      alert('キャッシュとデータを削除しました。ページを再読み込みします。');
      window.location.reload();
    } catch (error) {
      alert('削除に失敗しました。');
    }
  }
}

// --- イベントリスナー ---
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
    const seriesSelect = document.getElementById('filter-series');
    if (seriesSelect.value !== 'all') {
        state.filters.seriesCode = [seriesSelect.value];
    }
    localStorage.setItem('filters', JSON.stringify(state.filters));
    displayCards();
    filterModal.style.display = 'none';
});

clearFilterBtn.addEventListener('click', () => {
    filterModal.querySelectorAll('.filter-buttons button.active').forEach(btn => btn.classList.remove('active'));
    document.getElementById('filter-series').value = 'all';
    state.filters = {};
    localStorage.removeItem('filters');
    displayCards();
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

[settingsModal, lightboxModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
        if(e.target === modal) modal.style.display = 'none';
    });
});
closeLightboxBtn.addEventListener('click', () => lightboxModal.style.display = 'none');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
      return navigator.serviceWorker.ready;
    }).then(() => {
      console.log('ServiceWorker準備完了');
    }).catch(err => console.error('ServiceWorker登録失敗:', err));
  });
}

initializeApp();