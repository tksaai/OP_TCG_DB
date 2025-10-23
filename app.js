// app.js (完全省略なし・最終FIX版)

const db = new Dexie('OnePieceCardDB_v16'); // DB名を変更して完全にリセット
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, seriesCode, *features, effectText',
  meta: 'key, value',
  decks: '++id, name, updatedAt'
});

// DOM要素の参照を保持するオブジェクト
const DOM = {};

// アプリケーションの状態管理オブジェクト
const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  currentScreen: 'card-list',
  currentDeckId: null,
  allCards: [],
  filters: JSON.parse(localStorage.getItem('filters')) || {}
};

let newWorker; // アプリ更新用のService Workerを保持

/**
 * DOMContentLoadedイベント発生時にアプリを初期化する
 */
document.addEventListener('DOMContentLoaded', () => {
    initializeDOMReferences();
    initializeApp();
});

/**
 * 必要なDOM要素への参照を一度に取得する
 */
function initializeDOMReferences() {
    DOM.appContainer = document.getElementById('app-container');
    DOM.modalContainer = document.getElementById('modal-container');
    DOM.navItems = document.querySelectorAll('.nav-item');
    DOM.changeColumnsBtn = document.getElementById('change-columns-btn');
    DOM.columnsText = document.getElementById('columns-text');
    DOM.settingsBtn = document.getElementById('settings-btn');
}

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  setupGlobalEventListeners();
  updateUI();
  try {
    const cardCount = await db.cards.count();
    if (cardCount > 0) {
      state.allCards = await db.cards.toArray();
    }
    const initialScreen = window.location.hash.replace('#', '') || 'card-list';
    await navigateTo(initialScreen);
    checkAndUpdateData();
  } catch (error) {
    console.error("初期化エラー:", error);
    if(DOM.appContainer) DOM.appContainer.innerHTML = `<div id="status-message">エラー: ${error.message}。</div>`;
  }
}

/**
 * サーバー上のcards.jsonが更新されているかチェックし、更新通知を表示する
 */
async function checkAndUpdateData() {
  try {
    const lastUpdated = await db.meta.get('lastUpdated');
    const response = await fetch('./cards.json', { cache: 'no-store', method: 'HEAD' });
    const serverLastModified = response.headers.get('Last-Modified');

    if (!lastUpdated || new Date(lastUpdated.value) < new Date(serverLastModified)) {
      const updateNotif = document.createElement('div');
      updateNotif.id = 'update-notification';
      updateNotif.innerHTML = `<span>新しいカードデータがあります</span><button id="update-data-btn">更新</button>`;
      document.body.insertBefore(updateNotif, document.body.firstChild);
      updateNotif.classList.add('show');
      document.getElementById('update-data-btn').onclick = async () => {
        updateNotif.querySelector('span').textContent = '更新中...';
        await syncData(serverLastModified);
        updateNotif.classList.remove('show');
        setTimeout(() => updateNotif.remove(), 500);
      };
    }
  } catch(e) { console.warn("更新チェック失敗(オフラインの可能性)"); }
}

/**
 * ローカルのJSONファイルからデータを取得し、DBを更新する
 */
async function syncData(lastModified) {
  const statusMsg = document.getElementById('status-message') || document.createElement('div');
  statusMsg.id = 'status-message';
  statusMsg.textContent = 'カードデータを更新中...';
  if(!document.getElementById('status-message')) appContainer.prepend(statusMsg);
  
  const response = await fetch('./cards.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('cards.jsonの読み込みに失敗');
  
  const cards = await response.json();
  
  await db.transaction('rw', db.cards, db.meta, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(cards);
    await db.meta.put({ key: 'lastUpdated', value: lastModified || new Date().toISOString() });
  });
  
  state.allCards = await db.cards.toArray();
  await navigateTo(state.currentScreen, { deckId: state.currentDeckId });
}

/**
 * 指定された画面を描画する
 */
async function navigateTo(screen, params = null) {
  state.currentScreen = screen;
  if(params?.deckId !== undefined) state.currentDeckId = params.deckId;
  DOM.navItems.forEach(item => item.classList.toggle('active', item.dataset.screen === screen));
  window.location.hash = screen;

  switch (screen) {
    case 'decks': await renderDeckListScreen(); break;
    case 'deck-editor': await renderDeckEditScreen(state.currentDeckId); break;
    case 'card-list': default: await renderCardListScreen(); break;
  }
}

async function renderCardListScreen() {
    DOM.appContainer.innerHTML = `
      <header class="app-header">
        <div class="search-bar"><i class="fa-solid fa-magnifying-glass"></i><input type="text" id="search-box" placeholder="検索"></div>
        <div class="header-actions"><button id="filter-btn"><i class="fa-solid fa-filter"></i> フィルタ</button></div>
        <div id="progress-bar-container" style="display: none;"><div id="progress-bar"></div><span id="progress-text"></span></div>
      </header>
      <main class="app-content">
        <div id="status-message" style="display: none;"></div>
        <div id="card-list" class="card-grid cols-${state.columns}"></div>
      </main>
    `;
    document.getElementById('search-box').addEventListener('input', displayCards);
    document.getElementById('filter-btn').addEventListener('click', openFilterModal);
    await displayCards();
}

async function renderDeckListScreen() {
    DOM.appContainer.innerHTML = `<div class="app-content"><div style="padding:1rem"><h2>デッキ一覧</h2><p>デッキ機能は実装中です</p></div></div>`;
}
async function renderDeckEditScreen(deckId) {
    DOM.appContainer.innerHTML = `<div class="app-content"><div style="padding:1rem"><h2>デッキ編集</h2><p>デッキ編集機能は実装中です</p></div></div>`;
}

async function displayCards() {
  const cardList = document.getElementById('card-list');
  if (!cardList) return;

  try {
    if (state.allCards.length === 0) {
      if(document.getElementById('status-message')) document.getElementById('status-message').textContent = 'カードデータがありません。';
      return;
    }
    let filtered = [...state.allCards];
    if (Object.keys(state.filters).length > 0) {
        filtered = state.allCards.filter(card => {
            return Object.keys(state.filters).every(key => {
                const values = state.filters[key];
                if (!values || values.length === 0) return true;
                if (key === 'seriesCode') return values.some(v => card.seriesCode === v);
                if(Array.isArray(card[key])) return values.some(v => card[key].includes(v));
                return values.includes(String(card[key]));
            });
        });
    }
    const searchTerm = document.getElementById('search-box')?.value.toLowerCase().trim();
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(Boolean);
      filtered = filtered.filter(card => {
        const targetText = [card.cardName, card.effectText, card.cardNumber, ...(card.features || [])].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }
    cardList.innerHTML = '';
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
    cardList.appendChild(fragment);
  } catch(error) { console.error("カード表示エラー:", error); }
}

function openLightbox(src) {
    const lightboxHtml = `<div id="lightbox-modal" class="modal-overlay" style="display:flex; align-items:center; justify-content:center;"><span id="close-lightbox-btn" class="close-btn lightbox-close">&times;</span><img class="lightbox-content" src="${src}"></div>`;
    modalContainer.innerHTML = lightboxHtml;
    const modal = document.getElementById('lightbox-modal');
    modal.addEventListener('click', (e) => { if(e.target === modal) modal.remove(); });
    document.getElementById('close-lightbox-btn').addEventListener('click', () => modal.remove());
}

async function openFilterModal() {
    const filterModalHtml = `
        <div id="filter-modal" class="modal-overlay" style="display:flex;">
            <div class="modal-content">
                <div class="modal-header"><h2>フィルタ</h2><button id="close-filter-btn" class="close-btn"><i class="fa-solid fa-xmark"></i></button></div>
                <div id="filter-options" class="modal-body"></div>
                <div class="modal-footer"><button id="clear-filter-btn">クリア</button><button id="apply-filter-btn">適用</button></div>
            </div>
        </div>`;
    modalContainer.innerHTML = filterModalHtml;
    await setupFilters();
    document.getElementById('close-filter-btn').addEventListener('click', () => modalContainer.innerHTML = '');
    document.getElementById('clear-filter-btn').addEventListener('click', () => {
        document.querySelectorAll('#filter-options .filter-option-btn.active').forEach(b => b.classList.remove('active'));
        document.getElementById('filter-series').value = 'all';
    });
    document.getElementById('apply-filter-btn').addEventListener('click', applyFilters);
    document.getElementById('filter-modal').addEventListener('click', (e) => { if (e.target.id === 'filter-modal') modalContainer.innerHTML = ''; });
}

function applyFilters() {
    state.filters = {};
    document.querySelectorAll('#filter-options .filter-option-btn.active').forEach(btn => {
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
    modalContainer.innerHTML = '';
}

async function setupFilters() {
    const filterOptions = document.getElementById('filter-options');
    if (!filterOptions) return;
    
    const uniqueValues = {
        color: new Set(), cardType: new Set(), attribute: new Set(),
        rarity: new Set(), series: new Map()
    };
    state.allCards.forEach(card => {
        card.color.forEach(c => uniqueValues.color.add(c));
        if(card.cardType) uniqueValues.cardType.add(card.cardType);
        if(card.attribute && card.attribute !== '-') uniqueValues.attribute.add(card.attribute);
        if(card.rarity) uniqueValues.rarity.add(card.rarity);
        if(card.seriesCode && !card.cardNumber.startsWith('P-')) {
            uniqueValues.series.set(card.seriesCode, card.seriesTitle);
        }
    });
    
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
    filterOptions.querySelectorAll('.filter-option-btn').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
}

function openSettingsModal() {
    const settingsHtml = `
      <div id="settings-modal" class="modal-overlay" style="display:flex;">
          <div class="modal-content">
              <h2>設定</h2>
              <div class="settings-options">
                  <button id="cache-images-btn">全画像キャッシュ</button>
                  <button id="clear-cache-btn">全キャッシュ削除</button>
              </div>
              <button id="close-settings-btn" class="close-btn">閉じる</button>
          </div>
      </div>`;
    modalContainer.innerHTML = settingsHtml;
    document.getElementById('cache-images-btn').addEventListener('click', cacheAllImages);
    document.getElementById('clear-cache-btn').addEventListener('click', clearAllCaches);
    document.getElementById('close-settings-btn').addEventListener('click', () => modalContainer.innerHTML = '');
    document.getElementById('settings-modal').addEventListener('click', (e) => { if(e.target.id === 'settings-modal') modalContainer.innerHTML = ''; });
}

function updateUI() {
  DOM.columnsText.textContent = `${state.columns}列`;
  const cardList = document.getElementById('card-list');
  if(cardList) cardList.className = `card-grid cols-${state.columns}`;
}

async function cacheAllImages() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Service Workerが有効ではありません。'); return;
  }
  const btn = document.getElementById('cache-images-btn');
  btn.disabled = true;
  btn.textContent = 'キャッシュ中...';
  const progressBarContainer = document.querySelector('.app-header #progress-bar-container');
  const progressBar = document.querySelector('.app-header #progress-bar');
  const progressText = document.querySelector('.app-header #progress-text');
  
  progressBarContainer.style.display = 'flex';
  progressBar.style.width = '0%';
  progressText.textContent = '0%';

  try {
    const imageUrls = state.allCards.map(card => `./Cards/${card.cardNumber.split('-')[0]}/${card.cardNumber}.jpg`).filter(Boolean);
    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_IMAGES', payload: imageUrls });
    navigator.serviceWorker.onmessage = (event) => {
      if (event.data.type === 'CACHE_PROGRESS') {
        const { processed, total } = event.data.payload;
        const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = `${percentage}% (${processed}/${total})`;
      }
      if (event.data.type === 'CACHE_COMPLETE') {
        progressBar.style.width = '100%';
        progressText.textContent = `キャッシュ完了！`;
        setTimeout(() => { progressBarContainer.style.display = 'none'; }, 2000);
        btn.disabled = false;
        btn.textContent = '全画像キャッシュ';
      }
    };
  } catch (err) {
    console.error('画像キャッシュエラー:', err);
    progressBarContainer.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '全画像キャッシュ';
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
    } catch (error) { alert('削除に失敗しました。'); }
  }
}

function setupGlobalEventListeners() {
    DOM.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const screen = e.currentTarget.dataset.screen;
            if(screen && screen !== state.currentScreen) navigateTo(screen);
        });
    });
    DOM.changeColumnsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      state.columns = (state.columns % 5) + 1;
      localStorage.setItem('columnCount', state.columns);
      updateUI();
    });
    DOM.settingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openSettingsModal();
    });
}

function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdateBar();
                    }
                });
            });
        }).catch(err => console.error('SW登録失敗:', err));
    }
    navigator.serviceWorker.ready.then(reg => {
        if (reg.waiting) {
            newWorker = reg.waiting;
            showUpdateBar();
        }
    });
}

function showUpdateBar() {
  const notification = document.getElementById('update-notification');
  notification.classList.add('show');
  document.getElementById('update-button').onclick = () => {
    newWorker.postMessage({ type: 'SKIP_WAITING' });
  };
}

let refreshing;
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (refreshing) return;
  window.location.reload();
  refreshing = true;
});

setupServiceWorker();
document.addEventListener('DOMContentLoaded', initializeApp);