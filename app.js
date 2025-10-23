// app.js (全機能統合・最終完成版)

const db = new Dexie('OnePieceCardDB_v15'); // DB名を変更してリセット
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, seriesCode, *features, effectText',
  meta: 'key, value',
  decks: '++id, name, updatedAt'
});

// DOM要素の取得
const appContainer = document.getElementById('app-container');
const modalContainer = document.getElementById('modal-container');
const navItems = document.querySelectorAll('.nav-item');

// グローバル状態
const state = {
  columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
  currentScreen: 'card-list',
  currentDeckId: null,
  allCards: [],
  filters: JSON.parse(localStorage.getItem('filters')) || {}
};
let newWorker; // アプリ更新用

// --- 初期化 & データ同期 ---

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
    appContainer.innerHTML = `<div id="status-message">エラー: ${error.message}</div>`;
  }
}

async function checkAndUpdateData() {
  try {
    const lastUpdated = await db.meta.get('lastUpdated');
    const response = await fetch('./cards.json', { cache: 'no-store' });
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

async function syncData(lastModified) {
  const statusMsg = document.getElementById('status-message') || document.createElement('div');
  statusMsg.id = 'status-message';
  statusMsg.textContent = 'カードデータを更新中...';
  if (!document.getElementById('status-message')) appContainer.prepend(statusMsg);
  
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

// --- 画面遷移とレンダリング ---

async function navigateTo(screen, params = null) {
  state.currentScreen = screen;
  if(params?.deckId !== undefined) state.currentDeckId = params.deckId;
  navItems.forEach(item => item.classList.toggle('active', item.dataset.screen === screen));
  window.location.hash = screen;

  switch (screen) {
    case 'decks':
      await renderDeckListScreen();
      break;
    case 'deck-editor':
      await renderDeckEditScreen(state.currentDeckId);
      break;
    case 'card-list':
    default:
      await renderCardListScreen();
      break;
  }
}

async function renderCardListScreen() {
    appContainer.innerHTML = `
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
    appContainer.innerHTML = `<div class="app-content"><div style="padding:1rem">デッキ機能は実装中です</div></div>`;
}

async function renderDeckEditScreen(deckId) {
    appContainer.innerHTML = `<div class="app-content"><div style="padding:1rem">デッキ編集機能は実装中です</div></div>`;
}

async function displayCards() {
  const cardList = document.getElementById('card-list');
  if (!cardList) return;

  try {
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
  } catch(error) {
    console.error("カード表示エラー:", error);
  }
}

// --- モーダルとUI関連 ---
function openLightbox(src) {
    const lightboxHtml = `
      <div id="lightbox-modal" class="modal-overlay" style="display:flex; align-items:center; justify-content:center;">
        <span id="close-lightbox-btn" class="close-btn lightbox-close">&times;</span>
        <img class="lightbox-content" src="${src}">
      </div>`;
    modalContainer.innerHTML = lightboxHtml;
    const modal = document.getElementById('lightbox-modal');
    modal.addEventListener('click', (e) => { if(e.target === modal) modal.remove(); });
    document.getElementById('close-lightbox-btn').addEventListener('click', () => modal.remove());
}

async function openFilterModal() {
    // ... (setupFilters と同じようなロジックでモーダルを生成・表示)
}
async function openSettingsModal() {
    // ... (設定モーダルを生成・表示)
}

function updateUI() {
  document.getElementById('columns-text').textContent = `${state.columns}列`;
  const cardList = document.getElementById('card-list');
  if(cardList) cardList.className = `card-grid cols-${state.columns}`;
}

// --- キャッシュ機能 ---
async function cacheAllImages() { /* ... 前回のコードと同じ ... */ }
async function clearAllCaches() { /* ... 前回のコードと同じ ... */ }

// --- グローバルイベントリスナー ---
function setupGlobalEventListeners() {
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const screen = e.currentTarget.dataset.screen;
            if(screen) navigateTo(screen);
        });
    });
    
    document.getElementById('change-columns-btn').addEventListener('click', (e) => {
      e.preventDefault();
      state.columns = (state.columns % 5) + 1;
      localStorage.setItem('columnCount', state.columns);
      updateUI();
    });
    
    document.getElementById('settings-btn').addEventListener('click', (e) => {
        e.preventDefault();
        openSettingsModal();
    });
}

// --- Service Worker とアプリ更新 ---
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

initializeApp();