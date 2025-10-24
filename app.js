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
    const APP_VERSION = '1.0.3'; // アプリバージョン更新 (バグ修正)
    const SERVICE_WORKER_PATH = './service-worker.js';

    let db; // IndexedDBインスタンス
    let allCards = []; // 全カードデータ
    let currentFilter = {}; // 現在のフィルタ条件
    let swRegistration; // Service Worker登録情報

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
                    dom.loadingIndicator.style.display = 'flex'; // ローディング表示
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
            dom.loadingIndicator.style.display = 'flex'; // フォールバック時もローディング表示
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
            if (tx && tx.abort && !tx.done) { // Check if abort exists and transaction isn't already done
                try { tx.abort(); console.log('DB update transaction aborted due to error.'); }
                catch (abortError) { console.error('Error aborting transaction:', abortError); }
            }
            await loadCardsFromDB();
        } finally {
             // ローディング表示を確実に消す
             setTimeout(() => { dom.loadingIndicator.style.display = 'none'; }, 500);
        }
    }

    /**
     * IndexedDBから全カードデータをロードして表示
     */
    async function loadCardsFromDB() {
        if (!db) {
            console.error('DB not initialized. Cannot load cards.');
             // DBがない場合はローディング表示のままメッセージ表示
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.textContent = 'データベースを開けません。';
            return;
        }
        try {
            allCards = await db.getAll(STORE_CARDS);
            if (allCards.length === 0) {
                console.log('No cards found in DB.');
                // データがない場合もローディング表示のままメッセージ表示
                 if (dom.loadingIndicator.style.display === 'none' || dom.loadingIndicator.textContent.includes('オフライン')) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                 }
                dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                dom.cardListContainer.innerHTML = '';
            } else {
                console.log(`Loaded ${allCards.length} cards from DB.`);
                dom.loadingIndicator.style.display = 'none'; // データがあればローディング非表示
                dom.mainContent.style.display = 'block';
                populateFilters();
                applyFiltersAndDisplay();
            }
        } catch (error) {
            console.error('Failed to load cards from DB:', error);
            dom.loadingIndicator.style.display = 'flex'; // エラー時も表示
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
        const searchWords = searchTerm.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);

        const filteredCards = allCards.filter(card => {
            if (!card || !card.cardNumber) return false;

            if (searchWords.length > 0) {
                const searchableText = [
                    card.name || '',
                    card.effect || '',
                    (card.traits || []).join(' '),
                    card.cardNumber || ''
                ].join(' ').toLowerCase();
                if (!searchWords.every(word => searchableText.includes(word))) {
                    return false;
                }
            }

            const f = currentFilter;
            if (f.colors?.length > 0) {
                 if (!Array.isArray(card.color) || !f.colors.every(color => card.color.includes(color))) {
                    return false;
                }
            }
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
            if (f.series) {
                 if (!card.cardNumber) return false;
                 const cardSeriesId = card.cardNumber.split('-')[0];
                if (cardSeriesId !== f.series) return false;
            }

            return true;
        });

        displayCards(filteredCards);
    }

    /**
     * カード一覧をDOMに描画
     */
    function displayCards(cards) {
        const fragment = document.createDocumentFragment();

        if (cards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach(card => {
            if (!card || !card.cardNumber) {
                console.warn('Skipping invalid card data during display (missing cardNumber):', card);
                return;
            }

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';

            const img = document.createElement('img');
            img.className = 'card-image';
            const smallImagePath = card.imagePath ? card.imagePath.replace('.jpg', '_small.jpg') : '';
            // --- 修正: パス生成ロジック ---
            // smallImagePathが存在し、'Cards/'で始まる場合のみ './' を付与
            const relativeImagePath = (smallImagePath && smallImagePath.startsWith('Cards/')) ? `./${smallImagePath}` : smallImagePath;

            img.src = relativeImagePath; // srcが空文字になる場合がある
            img.alt = card.name || card.cardNumber;
            img.loading = 'lazy';

            cardItem.addEventListener('click', () => showLightbox(card));

            img.onerror = () => {
                 // --- 修正: エラーログにカード番号を追加 ---
                console.warn(`Failed to load image for card ${card.cardNumber}: ${relativeImagePath}`);
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.cardNumber;
                // img要素が既に存在する場合のみ置き換える
                if(cardItem.contains(img)){
                    cardItem.replaceChild(fallback, img);
                } else if (!cardItem.querySelector('.card-fallback')) { // Fallbackがまだなければ追加
                     cardItem.appendChild(fallback);
                }
                // エラー後もクリックイベントを再設定
                cardItem.onclick = () => showLightbox(card);
            };

            // 画像パスが有効な場合のみimgを追加、そうでない場合は最初からフォールバック表示
            if (relativeImagePath) {
                 cardItem.appendChild(img);
            } else {
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.cardNumber;
                 cardItem.appendChild(fallback);
                 cardItem.onclick = () => showLightbox(card);
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

    /**
     * ライトボックスを表示
     */
    function showLightbox(card) {
        if (!card || !card.cardNumber) return;

        const largeImagePath = card.imagePath || '';
         // --- 修正: パス生成ロジック ---
        const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

        dom.lightboxImage.src = relativeLargePath; // srcが空文字になる場合がある
        dom.lightboxImage.style.display = 'block';
        dom.lightboxFallback.style.display = 'none';
        dom.lightboxFallback.textContent = '';

        dom.lightboxImage.onerror = () => {
             // --- 修正: エラーログにカード番号を追加 ---
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

        dom.lightboxModal.style.display = 'flex';
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

            if(card.series && !card.cardNumber.startsWith('P-')) {
                 const seriesParts = card.series.split(' - ');
                 const seriesName = seriesParts[1] || card.series;
                 const seriesId = card.cardNumber.split('-')[0];
                if (seriesId && !seriesSet.has(seriesId)) {
                    seriesSet.set(seriesId, `${seriesId} - ${seriesName}`);
                }
            }
        });

        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        const rarityOrder = ['L', 'SEC', 'SR', 'R', 'UC', 'C'];
        const sortedRarities = [...rarities].sort((a, b) => rarityOrder.indexOf(a) - rarityOrder.indexOf(b));
        const sortedCosts = [...costs].map(Number).sort((a, b) => a - b);
        const sortedAttributes = [...attributes].sort();
        const sortedSeries = [...seriesSet.entries()]
            .sort(([idA], [idB]) => idA.localeCompare(idB, undefined, { numeric: true }))
            .map(([, name]) => name);

        dom.filterOptionsContainer.innerHTML = `
            ${createFilterGroup('colors', '色 (AND)', sortedColors, 'colors')}
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
            const seriesId = seriesName.split(' - ')[0];
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
     * 全カード画像（小画像）をキャッシュ
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

        const validCards = allCards.filter(card => card && card.imagePath);
        const smallImageUrls = [...new Set(
            validCards.map(card => {
                const path = card.imagePath.replace('.jpg', '_small.jpg');
                // --- 修正: パス生成ロジック ---
                return (path && path.startsWith('Cards/')) ? `./${path}` : path;
            }).filter(path => path) // フィルターして空文字を除外
        )];

        const totalCount = smallImageUrls.length;
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
            const queue = [...smallImageUrls];

            const processQueue = async () => {
                while(queue.length > 0) {
                    const url = queue.shift();
                    if (!url) continue; // キューが空になった場合

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


    // === 9. イベントリスナー設定 ===
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
        dom.lightboxCloseBtn.addEventListener('click', () => {
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = '';
            dom.lightboxImage.onerror = null;
        });
        dom.lightboxModal.addEventListener('click', (e) => {
            if (e.target === dom.lightboxModal) {
                dom.lightboxModal.style.display = 'none';
                dom.lightboxImage.src = '';
                dom.lightboxImage.onerror = null;
            }
        });
    }

    // === 10. アプリ起動 ===
    window.addEventListener('load', initializeApp);

})();

