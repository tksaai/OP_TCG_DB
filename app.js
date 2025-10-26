// OP-TCG DB PWA メインスクリプト

(function() {
    'use strict';

    // === 1. グローバル変数と定数 ===
    const DB_NAME = 'OPCardDB';
    const DB_VERSION = 2;
    const STORE_CARDS = 'cards';
    const STORE_METADATA = 'metadata';
    const CACHE_APP_SHELL = 'app-shell-v1'; // service-worker.jsと合わせる
    const CACHE_IMAGES = 'card-images-v1'; // service-worker.jsと合わせる
    const CARDS_JSON_PATH = './cards.json';
    const APP_VERSION = '1.0.9'; // アプリバージョン更新 (シリーズフィルタ実装)
    const SERVICE_WORKER_PATH = './service-worker.js';

    let db; // IndexedDBインスタンス
    let allCards = []; // 全カードデータ
    let currentFilter = {}; // 現在のフィルタ条件
    let swRegistration; // Service Worker登録情報

    // --- ライトボックス用 ---
    let currentFilteredCards = []; // 現在表示中のフィルタ結果
    let currentLightboxIndex = -1; // 現在ライトボックスで表示中のインデックス
    let touchStartX = 0; // スワイプ開始X座標
    let touchEndX = 0; // スワイプ終了X座標
    let touchStartY = 0; // スワイプ開始Y座標
    let touchEndY = 0; // スワイプ終了Y座標
    // ---

    // === 2. DOM要素のキャッシュ ===
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);

    const dom = {
        loadingIndicator: $('#loading-indicator'),
        cardListContainer: $('#card-list-container'),
        searchBar: $('#search-bar'),
        clearSearchBtn: $('#clear-search-btn'),
        filterBtn: $('#filter-btn'),
        settingsBtn: $('#settings-btn'),
        mainContent: $('#main-content'),

        // モーダル: フィルタ
        filterModal: $('#filter-modal'),
        closeFilterModalBtn: $('#close-filter-modal-btn'),
        filterOptionsContainer: $('#filter-options-container'),
        applyFilterBtn: $('#apply-filter-btn'),
        resetFilterBtn: $('#reset-filter-btn'),

        // モーダル: 設定
        settingsModal: $('#settings-modal'),
        closeSettingsModalBtn: $('#close-settings-modal-btn'),
        columnSelector: $('#column-selector'),
        cacheAllImagesBtn: $('#cache-all-images-btn'),
        clearAllDataBtn: $('#clear-all-data-btn'),
        appVersionInfo: $('#app-version-info'),
        cardDataVersionInfo: $('#card-data-version-info'),

        // モーダル: ライトボックス
        lightboxModal: $('#lightbox-modal'),
        lightboxImage: $('#lightbox-image'),
        lightboxFallback: $('#lightbox-fallback'),
        lightboxCloseBtn: $('#lightbox-close-btn'),

        // 通知
        dbUpdateNotification: $('#db-update-notification'),
        dbUpdateApplyBtn: $('#db-update-apply-btn'),
        dbUpdateDismissBtn: $('#db-update-dismiss-btn'),
        appUpdateNotification: $('#app-update-notification'),
        appUpdateApplyBtn: $('#app-update-apply-btn'),
        messageToast: $('#message-toast'),
        messageToastText: $('#message-toast-text'),
        messageToastDismissBtn: $('#message-toast-dismiss-btn'),

        // キャッシュ進捗
        cacheProgressContainer: $('#cache-progress-container'),
        cacheProgressBar: $('#cache-progress-bar'),
        cacheProgressText: $('#cache-progress-text'),
    };

    // === 3. 初期化処理 ===

    /**
     * アプリケーションの初期化
     */
    async function initializeApp() {
        console.log('PWA Initializing...');
        dom.appVersionInfo.textContent = APP_VERSION;
        registerServiceWorker();
        setupEventListeners();
        try {
            await initDB();
        } catch (dbError) {
            console.error("Critical error during DB initialization:", dbError);
            dom.loadingIndicator.textContent = 'データベースの初期化に致命的なエラーが発生しました。';
            return;
        }
        if (db) {
            await checkCardDataVersion();
        }
        setDefaultColumnLayout();
    }

    /**
     * IndexedDBの初期化
     */
    async function initDB() {
        try {
            db = await idb.openDB(DB_NAME, DB_VERSION, {
                upgrade(db, oldVersion, newVersion, transaction) {
                    console.log(`Upgrading DB from ${oldVersion} to ${newVersion}`);

                    if (oldVersion < 2 && db.objectStoreNames.contains(STORE_CARDS)) {
                        console.log(`Recreating ${STORE_CARDS} store for version 2 with keyPath 'cardNumber'.`);
                        try {
                            db.deleteObjectStore(STORE_CARDS);
                            console.log(`Old object store ${STORE_CARDS} deleted.`);
                        } catch (deleteError) {
                             console.error(`Failed to delete old ${STORE_CARDS} store:`, deleteError);
                             throw deleteError;
                        }
                    }
                    if (!db.objectStoreNames.contains(STORE_CARDS)) {
                         db.createObjectStore(STORE_CARDS, { keyPath: 'cardNumber' });
                         console.log(`Object store ${STORE_CARDS} created with keyPath 'cardNumber'.`);
                    }

                    if (!db.objectStoreNames.contains(STORE_METADATA)) {
                        db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                        console.log(`Object store ${STORE_METADATA} created.`);
                    }
                },
                blocked() {
                    console.warn('IndexedDB upgrade blocked. Please close other tabs/windows using this app.');
                    showMessageToast('データベースの更新がブロックされました。他のタブを閉じて再読み込みしてください。', 'error');
                },
                blocking() {
                    console.warn('IndexedDB connection is blocking an upgrade. Closing connection.');
                    db.close();
                },
                terminated() {
                     console.error('IndexedDB connection terminated unexpectedly.');
                     showMessageToast('データベース接続が予期せず切断されました。', 'error');
                }
            });
            console.log('IndexedDB opened successfully.');
        } catch (error) {
            console.error('Failed to open IndexedDB:', error);
            dom.loadingIndicator.textContent = 'データベースの初期化に失敗しました。';
             throw error;
        }
    }

    // === 4. データ管理 (DB, JSON) ===

    /**
     * cards.jsonのバージョンを確認し、必要に応じて更新
     */
    async function checkCardDataVersion() {
        if (!db) {
             console.error("DB not available, skipping card data version check.");
             dom.loadingIndicator.textContent = 'データベース接続エラー。';
             return;
        }

        try {
            const response = await fetch(CARDS_JSON_PATH, { method: 'HEAD', cache: 'no-store' });
            if (!response.ok) throw new Error(`Failed to fetch HEAD: ${response.statusText} (${response.status})`);

            const serverLastModified = response.headers.get('Last-Modified');
            if (!serverLastModified) {
                console.warn('Server did not provide Last-Modified header. Falling back to full fetch check.');
                await checkCardDataByFetching();
                return;
            }

            const localMetadata = await db.get(STORE_METADATA, 'cardsLastModified');
            const localLastModified = localMetadata ? localMetadata.value : null;

            dom.cardDataVersionInfo.textContent = localLastModified ? new Date(localLastModified).toLocaleString('ja-JP') : '未取得';
            console.log('Server Last-Modified:', serverLastModified);
            console.log('Local Last-Modified:', localLastModified);

            if (serverLastModified !== localLastModified) {
                console.log('Card data update detected.');
                if (!localLastModified) {
                    console.log('First time load. Fetching card data...');
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
                    await fetchAndUpdateCardData(serverLastModified);
                } else {
                    showDbUpdateNotification(serverLastModified);
                    await loadCardsFromDB();
                }
            } else {
                console.log('Card data is assumed up to date.');
                await loadCardsFromDB();
                if (allCards.length === 0 && localLastModified) {
                    console.warn('DB is empty even though metadata indicates it is up to date. Forcing data fetch...');
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'データ整合性を確認中...';
                    await fetchAndUpdateCardData(serverLastModified);
                }
            }
        } catch (error) {
            console.error('Failed to check card data version:', error);
            console.log('Attempting to load from local DB as fallback...');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = 'オフラインモードで起動中...';
            await loadCardsFromDB();
        }
    }

    /**
     * Last-Modifiedが使えない場合のフォールバック
     */
    async function checkCardDataByFetching() {
        console.log('Checking card data by full fetch (fallback)...');
        await loadCardsFromDB();
        if (allCards.length === 0) {
            console.warn('DB is empty on fallback check. Attempting initial fetch...');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
            await fetchAndUpdateCardData(new Date().toUTCString());
        }
    }


    /**
     * サーバーから最新のcards.jsonを取得し、DBを更新
     */
    async function fetchAndUpdateCardData(serverLastModified) {
        if (!db) {
            console.error('DB not available for updating card data.');
            showMessageToast('データベースエラーが発生しました。', 'error');
            return;
        }

        dom.loadingIndicator.style.display = 'flex';
        dom.loadingIndicator.querySelector('p').textContent = '最新カードデータをダウンロード中...';

        let tx;

        try {
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });
             if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText} (${response.status})`);

            const cardsData = await response.json();
            let cardsArray = [];

            if (Array.isArray(cardsData)) {
                cardsArray = cardsData;
            } else if (typeof cardsData === 'object' && cardsData !== null) {
                console.warn("JSON format is not a simple array. Extracting values.");
                cardsArray = Object.values(cardsData).flat();
            } else {
                throw new Error("Invalid cards.json format");
            }

            if (cardsArray.length === 0) {
                 throw new Error("Downloaded card data is empty.");
            }

            dom.loadingIndicator.querySelector('p').textContent = 'データベースを更新中...';

            tx = db.transaction([STORE_CARDS, STORE_METADATA], 'readwrite');
            tx.onerror = (event) => console.error("Transaction error:", event.target.error);

            const cardStore = tx.objectStore(STORE_CARDS);
            const metaStore = tx.objectStore(STORE_METADATA);
            let count = 0;
            let putErrors = 0;

            await cardStore.clear();
            console.log(`${STORE_CARDS} store cleared.`);

            for (const card of cardsArray) {
                if (card && card.cardNumber) {
                    try {
                        await cardStore.put(card);
                        count++;
                    } catch (putError) {
                        console.error(`Failed to put card ${card.cardNumber} into DB:`, putError);
                        putErrors++;
                    }
                } else {
                    console.warn('Skipping invalid card object (missing cardNumber):', card);
                }
            }

            console.log(`${count} cards attempted to add to DB.`);
            if (putErrors > 0) {
                console.error(`${putErrors} errors occurred during card put operations.`);
            }

            await metaStore.put({ key: 'cardsLastModified', value: serverLastModified });
            console.log('Metadata updated.');

            await tx.done;
            console.log('DB update transaction completed.');

            console.log('Card database update process finished successfully.');
            const savedMeta = await db.get(STORE_METADATA, 'cardsLastModified');
            dom.cardDataVersionInfo.textContent = savedMeta ? new Date(savedMeta.value).toLocaleString('ja-JP') : '更新完了';
            showMessageToast(`カードデータが更新されました (${count}件)。`, 'success');

            await loadCardsFromDB();

        } catch (error) {
            console.error('Failed to update card data:', error);
            dom.loadingIndicator.querySelector('p').textContent = `データ更新に失敗しました: ${error.message}`;
            showMessageToast('データ更新に失敗しました。オフラインデータを表示します。', 'error');
            if (tx && tx.abort && !tx.done) {
                try { tx.abort(); console.log('DB update transaction aborted due to error.'); }
                catch (abortError) { console.error('Error aborting transaction:', abortError); }
            }
            await loadCardsFromDB();
        } finally {
             setTimeout(() => { dom.loadingIndicator.style.display = 'none'; }, 500);
        }
    }

    /**
     * IndexedDBから全カードデータをロードして表示
     */
    async function loadCardsFromDB() {
        if (!db) {
            console.error('DB not initialized. Cannot load cards.');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.textContent = 'データベースを開けません。';
            return;
        }
        try {
            allCards = await db.getAll(STORE_CARDS);
            if (allCards.length === 0) {
                console.log('No cards found in DB.');
                 if (dom.loadingIndicator.style.display === 'none' || dom.loadingIndicator.textContent.includes('オフライン')) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                 }
                dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                dom.cardListContainer.innerHTML = '';
            } else {
                console.log(`Loaded ${allCards.length} cards from DB.`);
                dom.loadingIndicator.style.display = 'none';
                dom.mainContent.style.display = 'block';
                populateFilters();
                applyFiltersAndDisplay();
            }
        } catch (error) {
            console.error('Failed to load cards from DB:', error);
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.textContent = 'データの読み込みに失敗しました。';
            allCards = [];
            dom.filterOptionsContainer.innerHTML = '<p>データ読み込みエラー</p>';
            dom.cardListContainer.innerHTML = '<p>データの読み込みに失敗しました。</p>';
        }
    }

    // === 5. カード一覧表示 ===

    /**
     * フィルタ条件に基づいてカードを抽出し、表示
     */
    function applyFiltersAndDisplay() {
        if (allCards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">カードデータが読み込まれていません。</p>';
            return;
        }

        const searchTerm = dom.searchBar.value.trim().toLowerCase();
        // --- 修正: 全角スペースを半角スペースに置換 ---
        const searchWords = searchTerm.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);
        // --- 修正ここまで ---

        // フィルタリング結果をグローバル変数に保存
        currentFilteredCards = allCards.filter(card => {
            if (!card || !card.cardNumber) return false;

            // --- 修正: 検索ロジック ---
            if (searchWords.length > 0) {
                const searchableText = [
                    card.name || '',
                    card.effect || '',
                    (card.traits || []).join(' '),
                    card.cardNumber || ''
                ].join(' ').toLowerCase();
                // 検索ワードの *すべて* が含まれているかチェック
                if (!searchWords.every(word => searchableText.includes(word))) {
                    return false;
                }
            }
            // --- 修正ここまで ---

            const f = currentFilter;

            // --- 修正: 色フィルタのロジック変更 (OR/AND) ---
            if (f.colors?.length > 0) {
                if (!Array.isArray(card.color) || card.color.length === 0) {
                    return false; // カードに色情報がなければ除外
                }

                // 条件1: レアリティが 'L' のみかチェック
                const isLOnly = f.rarities?.length === 1 && f.rarities[0] === 'L';
                // 条件2: 複数の色が選択されているかチェック
                const isMultiColor = f.colors.length > 1;

                if (isLOnly && isMultiColor) {
                    // AND検索: Lのみ選択 *かつ* 複数色選択時は、選択した色すべてを含む
                    if (!f.colors.every(color => card.color.includes(color))) {
                        return false;
                    }
                } else {
                    // OR検索: それ以外 (L以外, L単色, 複数レアリティ, 色単色) は、選択した色のいずれか一つでも含めばOK
                    if (!f.colors.some(color => card.color.includes(color))) {
                        return false;
                    }
                }
            }
            // --- 修正ここまで ---
            
            if (f.types?.length > 0 && !f.types.includes(card.type)) return false;
            if (f.rarities?.length > 0 && !f.rarities.includes(card.rarity)) return false;
            if (f.costs?.length > 0) {
                if (card.cost === undefined || card.cost === null || !f.costs.includes(String(card.cost))) {
                     return false;
                }
            }
             if (f.attributes?.length > 0) {
                 if (!Array.isArray(card.attribute) || !f.attributes.every(attr => card.attribute.includes(attr))) {
                    return false;
                }
            }

            // --- 修正: シリーズフィルタロジック ---
            if (f.series) { // f.series には 'OP01' や 'P' が入る
                 if (!card.cardNumber) return false;
                 
                 if (f.series === 'P') {
                    // プロモが選択された場合
                    if (!card.cardNumber.startsWith('P-')) return false;
                 } else {
                    // その他のシリーズ (OP01, ST01など) が選択された場合
                    if (!card.cardNumber.startsWith(f.series + '-')) return false;
                 }
            }
            // --- 修正ここまで ---

            return true;
        });

        displayCards(currentFilteredCards); // 保存したリストで表示
    }

    /**
     * card.imagePath が存在しない場合に、cardNumber からパスを推測して生成する
     * @param {string} cardNumber - カード番号 (例: "OP01-001", "P-001")
     * @returns {string} 推測された大画像パス (例: "Cards/OP01/OP01-001.jpg")
     */
    function getGeneratedImagePath(cardNumber) {
        if (!cardNumber) return '';
        const parts = cardNumber.split('-');
        if (parts.length < 2) {
             console.warn(`Invalid cardNumber format for path generation: ${cardNumber}`);
             return '';
        }
        
        const seriesId = parts[0]; // "OP01" や "P"
        const cardId = cardNumber; // "OP01-001" や "P-001"
        
        return `Cards/${seriesId}/${cardId}.jpg`;
    }

    /**
     * カード一覧をDOMに描画
     * @param {Array} cards - 表示するカードの配列 (currentFilteredCards)
     */
    function displayCards(cards) {
        const fragment = document.createDocumentFragment();

        if (cards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach((card, index) => { // インデックスを取得
            if (!card || !card.cardNumber) {
                console.warn('Skipping invalid card data during display (missing cardNumber):', card);
                return;
            }

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';

            const img = document.createElement('img');
            img.className = 'card-image';

            let largeImagePath = card.imagePath;
            if (!largeImagePath) {
                largeImagePath = getGeneratedImagePath(card.cardNumber);
            }

            const relativeImagePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

            img.src = relativeImagePath;
            img.alt = card.name || card.cardNumber;
            img.loading = 'lazy';

            cardItem.addEventListener('click', () => showLightbox(index));

            img.onerror = () => {
                console.warn(`Failed to load image for card ${card.cardNumber}: ${relativeImagePath}`);
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.cardNumber;
                if(cardItem.contains(img)){
                    cardItem.replaceChild(fallback, img);
                } else if (!cardItem.querySelector('.card-fallback')) {
                     cardItem.appendChild(fallback);
                }
                cardItem.onclick = () => showLightbox(index);
            };

            if (relativeImagePath) {
                 cardItem.appendChild(img);
            } else {
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.cardNumber;
                 cardItem.onclick = () => showLightbox(index);
                 cardItem.appendChild(fallback);
            }

            fragment.appendChild(cardItem);
        });

        dom.cardListContainer.innerHTML = '';
        dom.cardListContainer.appendChild(fragment);
    }

    /**
     * グリッドの列数を変更
     */
    function setGridColumns(columns) {
        document.documentElement.style.setProperty('--grid-columns', columns);
        $$('.column-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.columns === String(columns));
        });
        localStorage.setItem('gridColumns', columns);
    }

    /**
     * 保存された列設定を読み込む
     */
    function setDefaultColumnLayout() {
        const savedColumns = localStorage.getItem('gridColumns') || 3;
        setGridColumns(savedColumns);
    }

    // --- 修正: ライトボックス表示ロジック ---

    /**
     * ライトボックスを表示
     * @param {number} index - currentFilteredCards 配列内のインデックス
     */
    function showLightbox(index) {
        if (index < 0 || index >= currentFilteredCards.length) {
            console.error(`Lightbox index ${index} out of bounds.`);
            return;
        }
        
        // インデックスを-1にリセットすることで、updateLightboxImageが
        // (newIndex === currentLightboxIndex) のチェックに引っかからず
        // 確実に初回表示を実行するようにする
        currentLightboxIndex = -1; 
        
        dom.lightboxModal.style.display = 'flex';
        updateLightboxImage(index); // 表示したいインデックスを渡して更新
    }
    
    /**
     * ライトボックス内の画像を更新し、左右の画像をプリロードする
     * @param {number} newIndex - currentFilteredCards 配列内の表示したいインデックス
     */
    function updateLightboxImage(newIndex) {
        
        // インデックスの範囲チェック
        if (newIndex < 0 || newIndex >= currentFilteredCards.length) {
            console.log("Swipe/update out of bounds");
            return; // 範囲外
        }
        
        // インデックスが変わらないなら何もしない
        if (newIndex === currentLightboxIndex) {
             console.log("Index is the same, not updating.");
             return;
        }
        
        currentLightboxIndex = newIndex;
        const card = currentFilteredCards[currentLightboxIndex];

        if (!card || !card.cardNumber) {
             console.error(`Invalid card data at index ${currentLightboxIndex}`);
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = 'Error';
             return;
        }

        let largeImagePath = card.imagePath;
        if (!largeImagePath) {
            largeImagePath = getGeneratedImagePath(card.cardNumber);
        }

        const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

        // 先にフォールバックを非表示にし、画像を準備
        dom.lightboxFallback.style.display = 'none';
        dom.lightboxFallback.textContent = '';
        dom.lightboxImage.style.display = 'block'; // 表示状態にする
        dom.lightboxImage.src = relativeLargePath; // 最後にsrcを設定

        dom.lightboxImage.onerror = () => {
            console.warn(`Failed to load lightbox image for card ${card.cardNumber}: ${relativeLargePath}`);
            dom.lightboxImage.style.display = 'none';
            dom.lightboxFallback.style.display = 'flex';
            dom.lightboxFallback.textContent = card.cardNumber || 'Error';
        };

         if (!relativeLargePath) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = card.cardNumber || 'No Image';
         }

         // 高速化のためのプリロード
         preloadImage(currentLightboxIndex + 1); // 次の画像
         preloadImage(currentLightboxIndex - 1); // 前の画像
    }
    // --- 修正ここまで ---
    
    /**
     * 指定されたインデックスの画像をプリロードする
     * @param {number} indexToPreload - currentFilteredCards 配列内のプリロードしたいインデックス
     */
    function preloadImage(indexToPreload) {
        if (indexToPreload < 0 || indexToPreload >= currentFilteredCards.length) {
            return; // 範囲外なら何もしない
        }
        
        const card = currentFilteredCards[indexToPreload];
        if (!card || !card.cardNumber) return;

        let largeImagePath = card.imagePath;
        if (!largeImagePath) {
            largeImagePath = getGeneratedImagePath(card.cardNumber);
        }
        
        const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

        if (relativeLargePath) {
            const img = new Image();
            img.src = relativeLargePath;
        }
    }


    // === 6. 検索・フィルタ (UI) ===

    /**
     * DBデータからフィルタオプションを動的に生成
     */
    function populateFilters() {
        if (allCards.length === 0) {
             dom.filterOptionsContainer.innerHTML = '<p>カードデータがありません。</p>';
             return;
        }

        const colors = new Set();
        const types = new Set();
        const rarities = new Set();
        const costs = new Set();
        const attributes = new Set();
        const seriesSet = new Map();

        allCards.forEach(card => {
            if (!card || !card.cardNumber) return;

            if (Array.isArray(card.color)) card.color.forEach(c => colors.add(c));
            if(card.type) types.add(card.type);
            if(card.rarity && card.rarity !== 'SP') rarities.add(card.rarity);
            if(card.cost !== undefined && card.cost !== null) costs.add(card.cost);
            if (Array.isArray(card.attribute)) card.attribute.forEach(a => attributes.add(a));

            // --- 修正: シリーズフィルタのロジック ---
            const seriesId = card.cardNumber.split('-')[0]; // 例: "OP01", "P", "ST11"
            if (!seriesId || seriesSet.has(seriesId)) {
                return; // IDが無いか、既に処理済みならスキップ
            }

            if (seriesId === 'P') {
                seriesSet.set('P', 'P - プロモカード');
            } else if (card.series) {
                // "OP01 - ROMANCE DAWN" のような形式から "ROMANCE DAWN" を抽出
                const seriesParts = card.series.split(' - ');
                const seriesName = seriesParts[1] || card.series;
                seriesSet.set(seriesId, `${seriesId} - ${seriesName}`);
            } else {
                // ST11などで card.series が空の場合のフォールバック
                seriesSet.set(seriesId, `${seriesId} - (不明なシリーズ)`);
            }
            // --- 修正ここまで ---
        });

        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        const rarityOrder = ['L', 'SEC', 'SR', 'R', 'UC', 'C'];
        const sortedRarities = [...rarities].sort((a, b) => rarityOrder.indexOf(a) - rarityOrder.indexOf(b));
        const sortedCosts = [...costs].map(Number).sort((a, b) => a - b);
        const sortedAttributes = [...attributes].sort();

        // --- 修正: シリーズのソート ('P'を最後にする) ---
        const seriesEntries = [...seriesSet.entries()];
        const sortedSeries = seriesEntries
            .sort(([idA], [idB]) => {
                if (idA === 'P') return 1; // 'P' は常に最後
                if (idB === 'P') return -1; // 'P' は常に最後
                // その他は ID (OP01, ST01) でソート
                return idA.localeCompare(idB, undefined, { numeric: true, sensitivity: 'base' });
            })
            .map(([, name]) => name); // (例: "OP01 - ROMANCE DAWN", "P - プロモカード")
        // --- 修正ここまで ---

        dom.filterOptionsContainer.innerHTML = `
            ${createFilterGroup('colors', '色 (通常OR / Lのみ複数色AND)', sortedColors, 'colors')}
            ${createFilterGroup('types', '種別', sortedTypes, 'types')}
            ${createFilterGroup('rarities', 'レアリティ', sortedRarities, 'rarities')}
            ${createFilterGroup('costs', 'コスト', sortedCosts.map(String), 'costs')}
            ${createFilterGroup('attributes', '属性 (AND)', sortedAttributes, 'attributes')}
            ${createSeriesFilter(sortedSeries)}
        `;
    }

    /**
     * フィルタ用のチェックボックスグループHTMLを生成
     */
    function createFilterGroup(name, legend, options, gridClass = '') {
        if (options.length === 0) return '';
        const optionsHtml = options.map(option => `
            <label class="filter-checkbox-label" data-color="${name === 'colors' ? option : ''}">
                <input type="checkbox" class="filter-checkbox" name="${name}" value="${option}">
                <span class="filter-checkbox-ui" data-color="${name === 'colors' ? option : ''}">${option}</span>
            </label>
        `).join('');
        return `
            <fieldset class="filter-group">
                <legend>${legend}</legend>
                <div class="filter-grid ${gridClass}">
                    ${optionsHtml}
                </div>
            </fieldset>
        `;
    }

    /**
     * フィルタ用のシリーズ選択(select)HTMLを生成
     */
    function createSeriesFilter(seriesList) {
        if (seriesList.length === 0) return '';
        const optionsHtml = seriesList.map(seriesName => {
            // seriesName は "OP01 - ROMANCE DAWN" または "P - プロモカード"
            const seriesId = seriesName.split(' - ')[0]; // "OP01" または "P"
            return `<option value="${seriesId}">${seriesName}</option>`;
        }).join('');
        return `
            <fieldset class="filter-group">
                <legend>シリーズ</legend>
                <select id="filter-series" class="filter-select">
                    <option value="">すべて</option>
                    ${optionsHtml}
                </select>
            </fieldset>
        `;
    }

    /**
     * フィルタモーダルから現在のフィルタ設定を読み込む
     */
    function readFiltersFromModal() {
        const getCheckedValues = (name) =>
            [...$$(`input[name="${name}"]:checked`)].map(cb => cb.value);
        currentFilter = {
            colors: getCheckedValues('colors'),
            types: getCheckedValues('types'),
            rarities: getCheckedValues('rarities'),
            costs: getCheckedValues('costs'),
            attributes: getCheckedValues('attributes'),
            series: $('#filter-series')?.value || '',
        };
        console.log('Filters applied:', currentFilter);
    }

    /**
     * フィルタモーダルのチェックと選択をリセット
     */
    function resetFilters() {
        $$('.filter-checkbox').forEach(cb => cb.checked = false);
        const seriesSelect = $('#filter-series');
        if (seriesSelect) seriesSelect.value = '';
        currentFilter = {};
        console.log('Filters reset.');
    }

    // === 7. キャッシュ管理 (UI) ===

    /**
     * 全カード画像（大画像）をキャッシュ
     */
    async function cacheAllImages() {
        if (allCards.length === 0) {
            showMessageToast('カードデータがありません。', 'error');
            return;
        }
        if (dom.cacheAllImagesBtn.disabled) return;

        dom.cacheAllImagesBtn.disabled = true;
        dom.cacheAllImagesBtn.textContent = 'キャッシュ実行中...';
        dom.cacheProgressContainer.style.display = 'flex';
        dom.cacheProgressBar.style.width = '0%';

        const imageUrls = [...new Set(
            allCards.map(card => {
                if (!card || !card.cardNumber) return null; 
                
                let largeImagePath = card.imagePath;
                if (!largeImagePath) {
                    largeImagePath = getGeneratedImagePath(card.cardNumber);
                }
                
                return (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;
            }).filter(path => path) 
        )];

        const totalCount = imageUrls.length;
        dom.cacheProgressText.textContent = `0 / ${totalCount}`;

        if (totalCount === 0) {
             showMessageToast('キャッシュ対象の画像がありません。');
             dom.cacheAllImagesBtn.disabled = false;
             dom.cacheAllImagesBtn.textContent = '全画像キャッシュ実行';
             dom.cacheProgressContainer.style.display = 'none';
             return;
        }

        let cachedCount = 0;
        let errors = 0;

        try {
            const cache = await caches.open(CACHE_IMAGES);
            const parallelLimit = 5; 
            const queue = [...imageUrls];

            const processQueue = async () => {
                while(queue.length > 0) {
                    const url = queue.shift();
                    if (!url) continue;

                    try {
                        const existing = await cache.match(url);
                        if (!existing) {
                            await cache.add(url);
                        }
                    } catch (e) {
                        console.warn(`Failed to cache image: ${url}`, e);
                        errors++;
                    }

                    cachedCount++;
                    requestAnimationFrame(() => {
                        const progress = Math.round((cachedCount / totalCount) * 100);
                        dom.cacheProgressBar.style.width = `${progress}%`;
                        dom.cacheProgressText.textContent = `${cachedCount} / ${totalCount}`;
                    });
                }
            };

            const workers = Array(parallelLimit).fill(null).map(processQueue);
            await Promise.all(workers);

            if (errors > 0) {
                showMessageToast(`画像キャッシュ完了 (${totalCount - errors}/${totalCount} 成功、${errors}件エラー)`, 'info');
            } else {
                showMessageToast(`全${totalCount}件の画像キャッシュが完了しました。`, 'success');
            }

        } catch (error) {
            console.error('Failed to cache all images:', error);
            showMessageToast('画像キャッシュ中にエラーが発生しました。', 'error');
        } finally {
            dom.cacheAllImagesBtn.disabled = false;
            dom.cacheAllImagesBtn.textContent = '全画像キャッシュ実行';
            setTimeout(() => {
                dom.cacheProgressContainer.style.display = 'none';
            }, 1500);
        }
    }

    /**
     * 全てのローカルデータを削除
     */
    async function clearAllData() {
        let confirmed = false;
        try {
             confirmed = window.confirm('本当にすべてのデータを削除しますか？\nデータベースと画像キャッシュが消去され、アプリがリロードされます。');
        } catch (e) {
            console.warn("window.confirm maybe blocked. Using prompt as fallback.", e);
            const input = prompt("すべてのデータを削除しますか？ 'yes'と入力してください。");
            confirmed = input && input.toLowerCase() === 'yes';
        }
        if (!confirmed) return;

        try {
            showMessageToast('全データを削除中...');
            if (db) {
                db.close();
                await idb.deleteDB(DB_NAME);
                db = null;
                console.log('IndexedDB deleted.');
            } else {
                 await idb.deleteDB(DB_NAME);
                 console.log('Attempted IndexedDB deletion.');
            }

            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter(name => name.startsWith('app-shell-') || name.startsWith('card-data-') || name.startsWith('card-images-'))
                    .map(name => {
                        console.log(`Deleting cache: ${name}`);
                        return caches.delete(name);
                    })
            );
            console.log('App related caches deleted.');

            if (swRegistration) {
                await swRegistration.unregister();
                console.log('Service Worker unregistered.');
                swRegistration = null;
            } else {
                const registration = await navigator.serviceWorker.getRegistration();
                if(registration) {
                    await registration.unregister();
                    console.log('Service Worker unregistered (fallback).');
                }
            }

            localStorage.clear();
            console.log('LocalStorage cleared.');

            showMessageToast('全データを削除しました。アプリを再起動します。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 1500);

        } catch (error) {
            console.error('Failed to clear all data:', error);
            showMessageToast('データの削除に失敗しました。', 'error');
        }
    }


    // === 8. PWA機能 (Service Worker, 通知) ===

    /**
     * Service Workerの登録と更新チェック
     */
    async function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
                swRegistration = registration;
                console.log('Service Worker registered:', registration.scope);

                if (registration.waiting) {
                    console.log('New Service Worker is waiting.');
                    showAppUpdateNotification();
                }

                registration.onupdatefound = () => {
                    console.log('Service Worker update found.');
                    const installingWorker = registration.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                console.log('New Service Worker is installed and waiting.');
                                showAppUpdateNotification();
                            } else {
                                console.log(`[SW State Change] New worker state: ${installingWorker.state}`);
                            }
                        };
                    }
                };

            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }

            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                console.log('Service Worker controller changed.');
                 if (refreshing) return;
                 showMessageToast('アプリが更新されました。再読み込みします。', 'success');
                 refreshing = true;
                 setTimeout(() => window.location.reload(), 1500);
            });
        }
    }

    /**
     * データベース更新通知を表示
     */
    function showDbUpdateNotification(serverLastModified) {
        dom.dbUpdateNotification.style.display = 'none';
        dom.dbUpdateNotification.style.display = 'flex';
        const applyHandler = () => {
            dom.dbUpdateNotification.style.display = 'none';
            fetchAndUpdateCardData(serverLastModified);
        };
        const dismissHandler = () => {
            dom.dbUpdateNotification.style.display = 'none';
        };
        dom.dbUpdateApplyBtn.removeEventListener('click', applyHandler);
        dom.dbUpdateDismissBtn.removeEventListener('click', dismissHandler);
        dom.dbUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
        dom.dbUpdateDismissBtn.addEventListener('click', dismissHandler, { once: true });
    }

    /**
     * アプリ本体の更新通知を表示
     */
    function showAppUpdateNotification() {
        dom.appUpdateNotification.style.display = 'none';
        dom.appUpdateNotification.style.display = 'flex';
        const applyHandler = () => {
            if (swRegistration && swRegistration.waiting) {
                console.log('Sending SKIP_WAITING message to Service Worker.');
                swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
                dom.appUpdateNotification.style.display = 'none';
                showMessageToast('アプリを更新中...');
                setTimeout(() => {
                    if (!applyHandler.refreshed) {
                         console.warn('Controller change event did not fire. Reloading manually.');
                         window.location.reload();
                    }
                }, 3000);
            } else {
                 console.warn('Could not find waiting Service Worker to send SKIP_WAITING. Reloading directly...');
                 window.location.reload();
            }
        };
        applyHandler.refreshed = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => { applyHandler.refreshed = true; }, { once: true });
        dom.appUpdateApplyBtn.removeEventListener('click', applyHandler);
        dom.appUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
    }

    /**
     * 汎用メッセージトーストを表示
     */
    function showMessageToast(message, type = 'info') {
        if (showMessageToast.timeoutId) clearTimeout(showMessageToast.timeoutId);
        dom.messageToastText.textContent = message;
        dom.messageToast.className = `message-toast ${type}`;
        dom.messageToast.style.display = 'flex';
        const dismissHandler = () => {
            dom.messageToast.style.display = 'none';
            dom.messageToastDismissBtn.removeEventListener('click', dismissHandler);
            if (showMessageToast.timeoutId) {
                clearTimeout(showMessageToast.timeoutId);
                showMessageToast.timeoutId = null;
            }
        };
        dom.messageToastDismissBtn.removeEventListener('click', dismissHandler);
        dom.messageToastDismissBtn.addEventListener('click', dismissHandler, { once: true });
        showMessageToast.timeoutId = setTimeout(dismissHandler, 5000);
    }
    showMessageToast.timeoutId = null;

    // === 9. スワイプ処理 ===
    
    /**
     * ライトボックスでのタッチ開始イベント
     */
    function handleTouchStart(e) {
        // スワイプが画像上またはフォールバック上から開始されたか確認
        if (e.target === dom.lightboxImage || e.target === dom.lightboxFallback) {
             touchStartX = e.touches[0].clientX;
             touchEndX = touchStartX;
             touchStartY = e.touches[0].clientY; // Y座標を保存
             touchEndY = touchStartY;
        } else {
             // 画像の外（例：閉じるボタンのエリア）ならスワイプ開始しない
             touchStartX = 0;
             touchEndX = 0;
             touchStartY = 0; // Y座標もリセット
             touchEndY = 0;
        }
    }

    /**
     * ライトボックスでのタッチ移動イベント
     */
    function handleTouchMove(e) {
        if (touchStartX === 0 && touchStartY === 0) return; // スワイプが開始されていない
        touchEndX = e.touches[0].clientX;
        touchEndY = e.touches[0].clientY; // Y座標を更新
    }

    /**
     * ライトボックスでのタッチ終了イベント（スワイプ判定）
     */
    function handleTouchEnd() {
        if (touchStartX === 0 && touchStartY === 0) return; // スワイプが開始されていなかった

        const swipeThreshold = 50; // スワイプと判定する最小移動距離（ピクセル）
        const swipeDistanceX = touchStartX - touchEndX;
        const swipeDistanceY = touchStartY - touchEndY;

        // Y軸のスワイプ（縦スワイプ）がX軸（横スワイプ）より大きいかチェック
        if (Math.abs(swipeDistanceY) > swipeThreshold && Math.abs(swipeDistanceY) > Math.abs(swipeDistanceX)) {
            
            // --- デバッグ機能: 上から下へのスワイプ ---
            if (swipeDistanceY < -swipeThreshold) { // 上から下
                if (currentLightboxIndex !== -1 && currentFilteredCards[currentLightboxIndex]) {
                    console.log('--- DEBUG CARD JSON ---');
                    console.log(currentFilteredCards[currentLightboxIndex]);
                    console.log('-------------------------');
                    showMessageToast(`カード情報 ( ${currentFilteredCards[currentLightboxIndex].cardNumber} ) をコンソールに出力しました。`, 'info');
                }
            }
            // --- デバッグ機能ここまで ---
            
            // TODO: 下から上へのスワイプ（現在は何もしない）
            
        }
        // X軸のスワイプ（横スワイプ）がY軸より大きいかチェック
        else if (Math.abs(swipeDistanceX) > swipeThreshold) {
            // 右から左へのスワイプ（次へ）
            if (swipeDistanceX > swipeThreshold) {
                console.log('Swipe left (next)');
                updateLightboxImage(currentLightboxIndex + 1); // 次のインデックスを渡す
            }
            // 左から右へのスワイプ（前へ）
            else if (swipeDistanceX < -swipeThreshold) {
                console.log('Swipe right (previous)');
                updateLightboxImage(currentLightboxIndex - 1); // 前のインデックスを渡す
            }
        }
        
        // 座標をリセット
        touchStartX = 0;
        touchEndX = 0;
        touchStartY = 0;
        touchEndY = 0;
    }


    // === 10. イベントリスナー設定 ===
    function setupEventListeners() {
        let searchTimeout;
        dom.searchBar.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const hasValue = dom.searchBar.value.length > 0;
            dom.clearSearchBtn.style.display = hasValue ? 'block' : 'none';
            searchTimeout = setTimeout(applyFiltersAndDisplay, 300);
        });
        dom.clearSearchBtn.addEventListener('click', () => {
            dom.searchBar.value = '';
            dom.clearSearchBtn.style.display = 'none';
            applyFiltersAndDisplay();
            dom.searchBar.focus();
        });
        dom.filterBtn.addEventListener('click', () => { dom.filterModal.style.display = 'flex'; });
        dom.settingsBtn.addEventListener('click', () => { dom.settingsModal.style.display = 'flex'; });
        dom.closeFilterModalBtn.addEventListener('click', () => { dom.filterModal.style.display = 'none'; });
        dom.filterModal.addEventListener('click', (e) => { if (e.target === dom.filterModal) dom.filterModal.style.display = 'none'; });
        dom.applyFilterBtn.addEventListener('click', () => {
            readFiltersFromModal();
            applyFiltersAndDisplay();
            dom.filterModal.style.display = 'none';
        });
        dom.resetFilterBtn.addEventListener('click', resetFilters);
        dom.closeSettingsModalBtn.addEventListener('click', () => { dom.settingsModal.style.display = 'none'; });
        dom.settingsModal.addEventListener('click', (e) => { if (e.target === dom.settingsModal) dom.settingsModal.style.display = 'none'; });
        dom.columnSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.column-btn');
            if (btn && !btn.classList.contains('active')) setGridColumns(btn.dataset.columns);
        });
        dom.cacheAllImagesBtn.addEventListener('click', cacheAllImages);
        dom.clearAllDataBtn.addEventListener('click', clearAllData);
        
        // ライトボックスのイベント
        dom.lightboxCloseBtn.addEventListener('click', () => {
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = ''; // メモリ解放
            dom.lightboxImage.onerror = null;
            currentLightboxIndex = -1; // インデックスをリセット
        });
        dom.lightboxModal.addEventListener('click', (e) => {
            // スワイプイベントと競合しないよう、閉じるボタン以外はスワイプハンドラに任せる
            if (e.target === dom.lightboxModal) {
                 if (touchStartX === 0 && touchEndX === 0) { // スワイプ中でない（＝タップ）
                    dom.lightboxModal.style.display = 'none';
                    dom.lightboxImage.src = ''; // メモリ解放
                    dom.lightboxImage.onerror = null;
                    currentLightboxIndex = -1; // インデックスをリセット
                 }
            }
        });

        // ライトボックスのスワイプイベント
        dom.lightboxModal.addEventListener('touchstart', handleTouchStart, { passive: true });
        dom.lightboxModal.addEventListener('touchmove', handleTouchMove, { passive: true });
        dom.lightboxModal.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    // === 11. アプリ起動 ===
    window.addEventListener('load', initializeApp);

})();

