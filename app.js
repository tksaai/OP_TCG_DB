// app.js (DOMContentLoadedで実行を保証する最終版)

// スクリプトの実行をDOMの準備完了後まで待機させる
document.addEventListener('DOMContentLoaded', () => {

    const db = new Dexie('OnePieceCardDB_v18');
    db.version(1).stores({
      cards: 'uniqueId, cardNumber, cardName, *color, cardType, rarity, seriesCode, *features, effectText',
      meta: 'key, value',
      decks: '++id, name, updatedAt'
    });

    // DOM要素の取得は、リスナーの内側で行う
    const DOM = {
        appContainer: document.getElementById('app-container'),
        modalContainer: document.getElementById('modal-container'),
        navItems: document.querySelectorAll('.nav-item'),
        changeColumnsBtn: document.getElementById('change-columns-btn'),
        columnsText: document.getElementById('columns-text'),
        settingsBtn: document.getElementById('settings-btn'),
        // 動的に生成される要素は、生成時に取得する
    };

    const state = {
      columns: parseInt(localStorage.getItem('columnCount') || '3', 10),
      currentScreen: 'card-list',
      currentDeckId: null,
      allCards: [],
      filters: JSON.parse(localStorage.getItem('filters')) || {}
    };
    
    let newWorker;

    async function initializeApp() {
      setupGlobalEventListeners();
      updateUI();
      try {
        const cardCount = await db.cards.count();
        if (cardCount > 0) {
          state.allCards = await db.cards.toArray();
          await navigateTo(state.currentScreen); // フィルタ設定は画面描画時に行う
          checkAndUpdateData();
        } else {
          await syncData();
        }
      } catch (error) {
        console.error("初期化エラー:", error);
        if(DOM.appContainer) DOM.appContainer.innerHTML = `<div id="status-message">エラー: ${error.message}。</div>`;
      }
    }

    async function checkAndUpdateData() {
      // (この関数は変更なし)
    }

    async function syncData(lastModified) {
        const statusMessage = document.querySelector('#status-message') || document.createElement('div');
        statusMessage.id = 'status-message';
        statusMessage.textContent = 'カードデータを更新中...';
        DOM.appContainer.innerHTML = '';
        DOM.appContainer.appendChild(statusMessage);

        const response = await fetch('./cards.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('cards.jsonの読み込みに失敗');
        const cards = await response.json();
        
        await db.transaction('rw', db.cards, db.meta, async () => {
            await db.cards.clear();
            await db.cards.bulkAdd(cards);
            await db.meta.put({ key: 'lastUpdated', value: lastModified || new Date().toISOString() });
        });
        
        state.allCards = await db.cards.toArray();
        await navigateTo(state.currentScreen);
    }

    async function navigateTo(screen) {
      state.currentScreen = screen;
      DOM.navItems.forEach(item => item.classList.toggle('active', item.dataset.screen === screen));
      window.location.hash = screen;

      if (screen === 'card-list') {
        await renderCardListScreen();
      } else {
        DOM.appContainer.innerHTML = `<main class="app-content"><div id="status-message">${screen} 機能は実装中です。</div></main>`;
      }
    }

    async function renderCardListScreen() {
        DOM.appContainer.innerHTML = `
          <header class="app-header">
            <div class="search-bar"><i class="fa-solid fa-magnifying-glass"></i><input type="text" id="search-box" placeholder="検索"></div>
            <button id="filter-btn"><i class="fa-solid fa-filter"></i><span>フィルタ</span></button>
          </header>
          <main class="app-content">
            <div id="card-list" class="card-grid cols-${state.columns}"></div>
          </main>
        `;
        document.getElementById('search-box').addEventListener('input', displayCards);
        document.getElementById('filter-btn').addEventListener('click', openFilterModal);
        await displayCards();
    }
    
    async function displayCards() {
        const cardList = document.getElementById('card-list');
        if (!cardList || state.allCards.length === 0) return;
        // (フィルタリングと検索ロジックは省略なしのコードから) ...
        const filtered = state.allCards;
        cardList.innerHTML = '';
        filtered.forEach(card => {
          const cardDiv = document.createElement('div');
          cardDiv.className = 'card-item';
          const series = card.cardNumber.split('-')[0];
          const imageUrl = `./Cards/${series}/${card.cardNumber}.jpg`;
          cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="card-placeholder">${card.cardNumber}</div>`;
          cardList.appendChild(cardDiv);
        });
    }

    // (setupFilters, openFilterModal, openSettingsModal などの関数は省略なしのコードから) ...
    
    function setupGlobalEventListeners() {
      DOM.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const screen = e.currentTarget.dataset.screen;
            if(screen && screen !== state.currentScreen) navigateTo(screen);
        });
      });
      DOM.changeColumnsBtn.addEventListener('click', (e) => { /* ... */ });
      DOM.settingsBtn.addEventListener('click', (e) => { /* ... */ });
    }
    
    function setupServiceWorker() {
      // (Service Worker 登録ロジック) ...
    }
    
    setupServiceWorker();
    initializeApp();
});