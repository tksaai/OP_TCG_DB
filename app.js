// OP-TCG DB PWA メインスクリプト

(function() {
    'use strict';

    // === 1. グローバル変数と定数 ===
    const DB_NAME = 'OPCardDB';
    const DB_VERSION = 1;
    const STORE_CARDS = 'cards';
    const STORE_METADATA = 'metadata';
    const CACHE_APP_SHELL = 'app-shell-v1'; // service-worker.jsと合わせる
    const CACHE_IMAGES = 'card-images-v1'; // service-worker.jsと合わせる
    // cards.json のパスを相対パスに
    const CARDS_JSON_PATH = './cards.json';
    const APP_VERSION = '1.0.1'; // アプリのバージョン
    // Service Worker のパスを修正
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
        await initDB();
        await checkCardDataVersion();
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
                    if (!db.objectStoreNames.contains(STORE_CARDS)) {
                        db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
                        console.log(`Object store ${STORE_CARDS} created.`);
                    }
                    if (!db.objectStoreNames.contains(STORE_METADATA)) {
                        db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                        console.log(`Object store ${STORE_METADATA} created.`);
                    }
                    // TODO: 将来のバージョンアップでインデックスを追加する場合はここに記述
                    // const cardStore = transaction.objectStore(STORE_CARDS);
                    // if (!cardStore.indexNames.contains('name')) {
                    //     cardStore.createIndex('name', 'name', { unique: false });
                    // }
                },
            });
            console.log('IndexedDB opened successfully.');
        } catch (error) {
            console.error('Failed to open IndexedDB:', error);
            dom.loadingIndicator.textContent = 'データベースの初期化に失敗しました。';
        }
    }

    // === 4. データ管理 (DB, JSON) ===

    /**
     * cards.jsonのバージョンを確認し、必要に応じて更新
     */
    async function checkCardDataVersion() {
        if (!db) return;

        try {
            // 1. サーバーからcards.jsonのヘッダー情報(Last-Modified)を取得
            const response = await fetch(CARDS_JSON_PATH, { 
                method: 'HEAD',
                cache: 'no-store' // 必ずサーバーに確認
            });
            
            if (!response.ok) throw new Error(`Failed to fetch HEAD: ${response.statusText}`);
            
            const serverLastModified = response.headers.get('Last-Modified');
            if (!serverLastModified) {
                console.warn('Server did not provide Last-Modified header. Falling back to full fetch check.');
                // HEADが使えない/Last-Modifiedがないサーバーの場合、フルフェッチで比較
                await checkCardDataByFetching();
                return;
            }

            // 2. IndexedDBからローカルの最終更新日を取得
            const localMetadata = await db.get(STORE_METADATA, 'cardsLastModified');
            const localLastModified = localMetadata ? localMetadata.value : null;

            dom.cardDataVersionInfo.textContent = localLastModified ? new Date(localLastModified).toLocaleString('ja-JP') : '未取得';
            
            console.log('Server Last-Modified:', serverLastModified);
            console.log('Local Last-Modified:', localLastModified);

            // 3. 比較
            if (serverLastModified !== localLastModified) {
                // 更新がある場合
                console.log('Card data update detected.');
                
                // 初回起動時（ローカルデータなし）は通知なしで即時更新
                if (!localLastModified) {
                    console.log('First time load. Fetching card data...');
                    dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
                    await fetchAndUpdateCardData(serverLastModified);
                } else {
                    // 既にデータがある場合は、更新通知を表示
                    showDbUpdateNotification(serverLastModified);
                    // 裏では古いデータをとりあえず表示しておく
                    await loadCardsFromDB();
                }
            } else {
                // 更新がない場合
                console.log('Card data is up to date.');
                await loadCardsFromDB();
            }
        } catch (error) {
            console.error('Failed to check card data version:', error);
            console.log('Attempting to load from local DB as fallback...');
            dom.loadingIndicator.querySelector('p').textContent = 'オフラインモードで起動中...';
            await loadCardsFromDB(); // オフラインでもDBにあれば起動
        }
    }

    /**
     * Last-Modifiedが使えない場合のフォールバック (実装は簡略化のため省略)
     * 本来は ETag や JSON のハッシュ比較を行う
     */
    async function checkCardDataByFetching() {
        console.log('Checking card data by full fetch (fallback)...');
        // ここでは簡略化し、常にローカルDBをロードする
        await loadCardsFromDB();
    }


    /**
     * サーバーから最新のcards.jsonを取得し、DBを更新
     * @param {string} serverLastModified - サーバーから取得したLast-Modifiedヘッダー
     */
    async function fetchAndUpdateCardData(serverLastModified) {
        if (!db) {
            console.error('DB not available for updating card data.');
            showMessageToast('データベースエラーが発生しました。', 'error');
            return;
        }

        dom.loadingIndicator.style.display = 'flex';
        dom.loadingIndicator.querySelector('p').textContent = '最新カードデータをダウンロード中...';

        try {
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText}`);
            
            const cardsData = await response.json();
            let cardsArray = [];

            // PUNKDBのデータ形式 (オブジェクトの配列) かどうかを確認
            if (Array.isArray(cardsData)) {
                cardsArray = cardsData;
            } else if (typeof cardsData === 'object' && cardsData !== null) {
                // オブジェクト形式 { "OP01": [...], "OP02": [...] } の場合、配列に展開
                console.warn("JSON format is not a simple array. Extracting values.");
                cardsArray = Object.values(cardsData).flat();
            } else {
                throw new Error("Invalid cards.json format");
            }

            // カードデータが空でないことを確認
            if (cardsArray.length === 0) {
                 throw new Error("Downloaded card data is empty.");
            }

            dom.loadingIndicator.querySelector('p').textContent = 'データベースを更新中...';
            
            // --- DB更新処理 (修正箇所) ---
            // 'bulkPut' は idb の標準機能ではないため、
            // トランザクション内でループ処理 'put' を行う確実な方法に変更
            
            // 1. カードとメタデータの両方を更新するトランザクションを開始
            const tx = db.transaction([STORE_CARDS, STORE_METADATA], 'readwrite');
            const cardStore = tx.objectStore(STORE_CARDS);
            const metaStore = tx.objectStore(STORE_METADATA);

            // 2. カードストアをクリア
            await cardStore.clear();
            console.log(`${STORE_CARDS} store cleared.`);

            // 3. 新しいデータを一件ずつ 'put' (add or update)
            // (for...of ループは await との相性が良い)
            let count = 0;
            for (const card of cardsArray) {
                // 'id' がない不正なデータはスキップ
                if (card && card.id) { 
                    await cardStore.put(card);
                    count++;
                } else {
                    console.warn('Skipping invalid card object during update:', card);
                }
            }
            console.log(`${count} cards added to DB.`);

            // 4. メタデータを更新 (同じトランザクション内)
            await metaStore.put({
                key: 'cardsLastModified',
                value: serverLastModified
            });
            console.log('Metadata updated.');

            // 5. トランザクションを完了
            await tx.done;
            // --- DB更新処理ここまで ---
            
            console.log('Card database updated successfully.');
            dom.cardDataVersionInfo.textContent = new Date(serverLastModified).toLocaleString('ja-JP');
            showMessageToast('カードデータが更新されました。', 'success');

            // 6. 更新したデータをロードして表示
            await loadCardsFromDB();

        } catch (error) {
            console.error('Failed to update card data:', error);
            dom.loadingIndicator.querySelector('p').textContent = `データ更新に失敗しました: ${error.message}`;
            showMessageToast('データ更新に失敗しました。オフラインデータを表示します。', 'error');
            await loadCardsFromDB(); // 失敗したら古いデータでもいいからロード試行
        } finally {
            // エラー時でもローディング表示は最終的に消す
             setTimeout(() => { dom.loadingIndicator.style.display = 'none'; }, 1000);
        }
    }

    /**
     * IndexedDBから全カードデータをロードして表示
     */
    async function loadCardsFromDB() {
        if (!db) {
            console.error('DB not initialized. Cannot load cards.');
            dom.loadingIndicator.textContent = 'データベースを開けません。';
            return;
        }

        try {
            allCards = await db.getAll(STORE_CARDS);
            
            if (allCards.length === 0) {
                console.log('No cards found in DB.');
                // 初回起動時などでDBが空だが、バージョンチェックで
                // 「更新なし」と判断された場合（オフライン起動など）
                if (dom.loadingIndicator.style.display !== 'none') {
                     dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                }
                 // フィルタオプションとカードリストをクリア
                dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                dom.cardListContainer.innerHTML = '';
            } else {
                console.log(`Loaded ${allCards.length} cards from DB.`);
                dom.loadingIndicator.style.display = 'none';
                dom.mainContent.style.display = 'block'; // コンテンツ表示
                
                // フィルタオプションを生成
                populateFilters();
                
                // カード一覧を表示
                applyFiltersAndDisplay();
            }
        } catch (error) {
            console.error('Failed to load cards from DB:', error);
            dom.loadingIndicator.textContent = 'データの読み込みに失敗しました。';
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
        
        // フリーワード検索用の単語分割 (全角スペースを半角に)
        const searchWords = searchTerm.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);

        const filteredCards = allCards.filter(card => {
            // カードオブジェクトが存在しない、またはidがない場合はスキップ
            if (!card || !card.id) return false;

            // 1. フリーワード検索
            if (searchWords.length > 0) {
                // 検索対象テキストを結合 (null/undefined を空文字に)
                const searchableText = [
                    card.name || '',
                    card.effect || '',
                    (card.traits || []).join(' '),
                    card.id || ''
                ].join(' ').toLowerCase();
                
                // すべての検索語を含むか (AND検索)
                if (!searchWords.every(word => searchableText.includes(word))) {
                    return false;
                }
            }
            
            // 2. 詳細フィルタ
            const f = currentFilter;
            
            // 色 (AND検索)
            if (f.colors?.length > 0) {
                // カードの色情報が配列でない場合はスキップ
                if (!Array.isArray(card.color)) return false;
                if (!f.colors.every(color => card.color.includes(color))) {
                    return false;
                }
            }
            // 種別 (OR検索)
            if (f.types?.length > 0 && !f.types.includes(card.type)) {
                return false;
            }
            // レアリティ (OR検索)
            if (f.rarities?.length > 0 && !f.rarities.includes(card.rarity)) {
                return false;
            }
            // コスト (OR検索) - card.cost が null や undefined でないことを確認
            if (f.costs?.length > 0) {
                if (card.cost === undefined || card.cost === null || !f.costs.includes(String(card.cost))) {
                     return false;
                }
            }
            // 属性 (AND検索)
            if (f.attributes?.length > 0) {
                // カードの属性情報が配列でない場合はスキップ
                if (!Array.isArray(card.attribute)) return false;
                if (!f.attributes.every(attr => card.attribute.includes(attr))) {
                    return false;
                }
            }
            // シリーズ (シリーズIDで比較)
            if (f.series) {
                // カードIDがない場合は比較できないので除外
                if (!card.id) return false;
                const cardSeriesId = card.id.split('-')[0];
                if (cardSeriesId !== f.series) {
                    return false;
                }
            }

            return true; // すべてのフィルタを通過
        });

        displayCards(filteredCards);
    }

    /**
     * カード一覧をDOMに描画
     * @param {Array} cards - 表示するカードの配列
     */
    function displayCards(cards) {
        // 高速化のため、一度 DocumentFragment にまとめてからDOMに追加
        const fragment = document.createDocumentFragment();
        
        if (cards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach(card => {
            // カードデータがおかしい場合はスキップ
            if (!card || !card.id) {
                console.warn('Skipping invalid card data:', card);
                return;
            }

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';
            
            const img = document.createElement('img');
            img.className = 'card-image';
            // imagePath が存在するか確認
            const smallImagePath = card.imagePath ? card.imagePath.replace('.jpg', '_small.jpg') : '';
            img.src = smallImagePath; 
            img.alt = card.name || card.id;
            img.loading = 'lazy'; // 遅延読み込み

            // 1. 画像クリックでライトボックス表示
            cardItem.addEventListener('click', () => showLightbox(card));
            
            // 2. 画像読み込みエラー時のフォールバック
            img.onerror = () => {
                console.warn(`Failed to load image: ${smallImagePath}`);
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.id;
                cardItem.innerHTML = ''; // imgを削除
                cardItem.appendChild(fallback);
                // エラー時もクリックイベントは維持（フォールバック表示をクリックできるように）
                cardItem.onclick = () => showLightbox(card);
            };

            // imagePath がない場合のフォールバック表示
            if (!smallImagePath) {
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.id;
                 cardItem.appendChild(fallback);
            } else {
                 cardItem.appendChild(img);
            }
            
            fragment.appendChild(cardItem);
        });

        // DOMの書き換えを1回に抑える
        dom.cardListContainer.innerHTML = '';
        dom.cardListContainer.appendChild(fragment);
    }

    /**
     * グリッドの列数を変更
     * @param {number | string} columns - 列数
     */
    function setGridColumns(columns) {
        document.documentElement.style.setProperty('--grid-columns', columns);
        // アクティブなボタンを更新
        $$('.column-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.columns === String(columns));
        });
        // 設定をローカルストレージに保存
        localStorage.setItem('gridColumns', columns);
    }

    /**
     * 保存された列設定を読み込む
     */
    function setDefaultColumnLayout() {
        const savedColumns = localStorage.getItem('gridColumns') || 3; // デフォルト3列
        setGridColumns(savedColumns);
    }

    /**
     * ライトボックスを表示
     * @param {object} card - カードオブジェクト
     */
    function showLightbox(card) {
        // カードデータがない場合は何もしない
        if (!card) return;

        const largeImagePath = card.imagePath || '';
        dom.lightboxImage.src = largeImagePath; // 大画像
        dom.lightboxImage.style.display = 'block';
        dom.lightboxFallback.style.display = 'none';
        dom.lightboxFallback.textContent = '';
        
        dom.lightboxImage.onerror = () => {
            console.warn(`Failed to load lightbox image: ${largeImagePath}`);
            dom.lightboxImage.style.display = 'none';
            dom.lightboxFallback.style.display = 'flex';
            dom.lightboxFallback.textContent = card.id || 'Error';
        };
        
        // imagePathがない場合もフォールバック表示
         if (!largeImagePath) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = card.id || 'No Image';
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

        // 重複を除去しながら各項目を収集
        const colors = new Set();
        const types = new Set();
        const rarities = new Set();
        const costs = new Set();
        const attributes = new Set();
        const seriesSet = new Map(); // {id: 'name'}

        allCards.forEach(card => {
            // 不正なカードデータはスキップ
            if (!card) return;

            // card.color が存在し、かつ配列であることを確認
            if (Array.isArray(card.color)) {
                card.color.forEach(c => colors.add(c));
            }
            if(card.type) types.add(card.type);
            // SPを除外
            if(card.rarity && card.rarity !== 'SP') rarities.add(card.rarity);
            if(card.cost !== undefined && card.cost !== null) costs.add(card.cost); // nullチェック追加
            // card.attribute が存在し、かつ配列であることを確認
            if (Array.isArray(card.attribute)) {
                card.attribute.forEach(a => attributes.add(a));
            }
            
            // プロモ(P)を除外し、シリーズを収集 (card.id が存在することを確認)
            if(card.series && card.id && !card.id.startsWith('P-')) {
                // PUNKDBのシリーズ名は "OP01 - ROMANCE DAWN" 形式
                const seriesParts = card.series.split(' - ');
                const seriesName = seriesParts[1] || card.series; // " - " がなければ全体
                const seriesId = card.id.split('-')[0]; // OP01, EB01など
                if (seriesId && !seriesSet.has(seriesId)) {
                    seriesSet.set(seriesId, `${seriesId} - ${seriesName}`);
                }
            }
        });

        // ソート
        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        // レアリティ順 (L, SEC, SR, R, UC, C)
        const rarityOrder = ['L', 'SEC', 'SR', 'R', 'UC', 'C'];
        const sortedRarities = [...rarities].sort((a, b) => rarityOrder.indexOf(a) - rarityOrder.indexOf(b));
        // コストは数値としてソート
        const sortedCosts = [...costs].map(Number).sort((a, b) => a - b); 
        const sortedAttributes = [...attributes].sort();
        // シリーズIDでソート (OP01, OP02, ..., EB01)
        const sortedSeries = [...seriesSet.entries()]
            .sort(([idA], [idB]) => idA.localeCompare(idB, undefined, { numeric: true }))
            .map(([, name]) => name);

        // DOMを構築
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
     * @param {string} name - inputのname属性
     * @param {string} legend - fieldsetのlegend
     * @param {Array<string>} options - オプションの配列
     * @param {string} gridClass - スタイル用のクラス (e.g., 'colors', 'costs')
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
     * @param {Array<string>} seriesList - シリーズ名の配列 ("ID - Name"形式)
     */
    function createSeriesFilter(seriesList) {
        if (seriesList.length === 0) return '';

        const optionsHtml = seriesList.map(seriesName => {
            // "OP01 - ROMANCE DAWN" -> value="OP01"
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
            series: $('#filter-series')?.value || '', // select要素の値を取得
        };
        console.log('Filters applied:', currentFilter);
    }

    /**
     * フィルタモーダルのチェックをリセット
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

        // 既に実行中か確認
        if (dom.cacheAllImagesBtn.disabled) return;

        dom.cacheAllImagesBtn.disabled = true;
        dom.cacheAllImagesBtn.textContent = 'キャッシュ実行中...';
        dom.cacheProgressContainer.style.display = 'flex';
        dom.cacheProgressBar.style.width = '0%';
        
        // imagePathが存在し、有効なカードのみ対象にする
        const validCards = allCards.filter(card => card && card.imagePath);
        // 小画像パスを生成し、重複を除去
        const smallImageUrls = [...new Set(validCards.map(card => card.imagePath.replace('.jpg', '_small.jpg')))];
        
        const totalCount = smallImageUrls.length; // 実際のキャッシュ対象数
        dom.cacheProgressText.textContent = `0 / ${totalCount}`; // 表示を更新

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
            
            // 5並列でダウンロード
            const parallelLimit = 5;
            const queue = [...smallImageUrls]; 
            
            const processQueue = async () => {
                while(queue.length > 0) {
                    const url = queue.shift();
                    if (!url) continue; // URLが空の場合はスキップ

                    try {
                        // 既にキャッシュにあるか確認 (キャッシュがあればfetchしない)
                        const existing = await cache.match(url);
                        if (!existing) {
                            // cache.add() はリクエストとレスポンスの保存を一度に行う
                            await cache.add(url);
                        }
                    } catch (e) {
                        console.warn(`Failed to cache image: ${url}`, e);
                        errors++; // エラーカウント
                    }
                    
                    cachedCount++;
                    // UI更新をメインスレッドに少し遅延させる (描画のブロックを防ぐ)
                    requestAnimationFrame(() => {
                        const progress = Math.round((cachedCount / totalCount) * 100);
                        dom.cacheProgressBar.style.width = `${progress}%`;
                        dom.cacheProgressText.textContent = `${cachedCount} / ${totalCount}`;
                    });
                     // 短い待機を入れてCPU負荷を下げる (任意)
                    // await new Promise(resolve => setTimeout(resolve, 10)); 
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
            // 進捗バーを隠す前に少し待つ
            setTimeout(() => {
                dom.cacheProgressContainer.style.display = 'none';
            }, 1500);
        }
    }

    /**
     * 全てのローカルデータを削除
     */
    async function clearAllData() {
        // カスタム確認モーダルを使うのが望ましいが、ここではconfirmを使用
        let confirmed = false;
        try {
             confirmed = window.confirm('本当にすべてのデータを削除しますか？\nデータベースと画像キャッシュが消去され、アプリがリロードされます。');
        } catch (e) {
            console.warn("window.confirm maybe blocked. Using prompt as fallback.", e);
            // confirmがブロックされる環境(iframeなど)のためのフォールバック
            const input = prompt("すべてのデータを削除しますか？ 'yes'と入力してください。");
            confirmed = input && input.toLowerCase() === 'yes';
        }

        if (!confirmed) return;

        try {
            // 0. 処理中表示
            showMessageToast('全データを削除中...');

            // 1. IndexedDB削除
            if (db) {
                db.close(); // DB接続を閉じてから削除
                await idb.deleteDB(DB_NAME);
                db = null; // DBインスタンスをクリア
                console.log('IndexedDB deleted.');
            } else {
                 await idb.deleteDB(DB_NAME); // dbインスタンスがなくても削除試行
                 console.log('Attempted IndexedDB deletion.');
            }


            // 2. キャッシュストレージ削除
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(cacheName => {
                    // アプリケーションに関連するキャッシュのみ削除 (念のため)
                     if (cacheName.startsWith('app-shell-') || cacheName.startsWith('card-data-') || cacheName.startsWith('card-images-')) {
                        console.log(`Deleting cache: ${cacheName}`);
                        return caches.delete(cacheName);
                    }
                    return Promise.resolve(); // 関係ないキャッシュは削除しない
                })
            );
            console.log('App related caches deleted.');

            // 3. Service Worker 登録解除
            if (swRegistration) {
                await swRegistration.unregister();
                console.log('Service Worker unregistered.');
                swRegistration = null;
            } else {
                // 登録情報がなくても解除を試みる
                const registration = await navigator.serviceWorker.getRegistration();
                if(registration) {
                    await registration.unregister();
                    console.log('Service Worker unregistered (fallback).');
                }
            }
            
             // 4. ローカルストレージもクリア (列設定など)
            localStorage.clear();
            console.log('LocalStorage cleared.');

            showMessageToast('全データを削除しました。アプリを再起動します。', 'success');
            
            // 5. リロード
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
                // Service Worker のパスを定数から参照
                const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
                swRegistration = registration;
                console.log('Service Worker registered:', registration.scope);

                // アプリ更新通知のロジック
                // 既に新しいSWが待機中(waiting)の場合
                if (registration.waiting) {
                    console.log('New Service Worker is waiting.');
                    showAppUpdateNotification();
                }

                // 新しいSWがインストールされたのを見張る
                registration.onupdatefound = () => {
                    console.log('Service Worker update found.');
                    const installingWorker = registration.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            // インストール完了 -> 待機状態(waiting)になった
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
            
            // ページがリロードされた際に、もし新しいSWがアクティブになっていたら通知
            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                console.log('Service Worker controller changed.');
                 if (refreshing) return;
                 // 更新完了メッセージを表示し、リロード（無限ループを防ぐフラグ付き）
                 showMessageToast('アプリが更新されました。再読み込みします。', 'success');
                 refreshing = true;
                 setTimeout(() => window.location.reload(), 1500); 
            });
        }
    }

    /**
     * データベース更新通知を表示
     * @param {string} serverLastModified - 更新ボタン押下時にfetchAndUpdateCardDataに渡す
     */
    function showDbUpdateNotification(serverLastModified) {
        // 既存の通知があれば閉じる
        dom.dbUpdateNotification.style.display = 'none';
        
        dom.dbUpdateNotification.style.display = 'flex';
        
        // イベントリスナーを一度削除してから再設定（重複防止）
        const applyHandler = () => {
            dom.dbUpdateNotification.style.display = 'none';
            fetchAndUpdateCardData(serverLastModified);
            // リスナー削除はハンドラー内で行う (once: true と併用)
        };
        const dismissHandler = () => {
            dom.dbUpdateNotification.style.display = 'none';
             // リスナー削除はハンドラー内で行う (once: true と併用)
        };
        // 古いリスナーを念のため削除
        dom.dbUpdateApplyBtn.removeEventListener('click', applyHandler);
        dom.dbUpdateDismissBtn.removeEventListener('click', dismissHandler);

        dom.dbUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
        dom.dbUpdateDismissBtn.addEventListener('click', dismissHandler, { once: true });
    }
    
    /**
     * アプリ本体の更新通知を表示
     */
    function showAppUpdateNotification() {
         // 既存の通知があれば閉じる
        dom.appUpdateNotification.style.display = 'none';

        dom.appUpdateNotification.style.display = 'flex';

        // イベントリスナーを一度削除してから再設定（重複防止）
         const applyHandler = () => {
            // 待機中のService Workerに "skipWaiting" を指示
            if (swRegistration && swRegistration.waiting) {
                console.log('Sending SKIP_WAITING message to Service Worker.');
                swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
                // SKIP_WAITING後、controllerchangeイベントが発火してリロードされるはず
                dom.appUpdateNotification.style.display = 'none';
                showMessageToast('アプリを更新中...');
                // 念のためタイムアウトも設定
                setTimeout(() => {
                    if (!applyHandler.refreshed) window.location.reload(); 
                }, 3000); 
            } else {
                 console.warn('Could not find waiting Service Worker to send SKIP_WAITING. Reloading directly...');
                 // SWが見つからない場合は単純にリロード
                 window.location.reload();
            }
        };
        // リロード済みフラグ
        applyHandler.refreshed = false; 
        navigator.serviceWorker.addEventListener('controllerchange', () => { applyHandler.refreshed = true; }, { once: true });

        // 古いリスナーを削除
        dom.appUpdateApplyBtn.removeEventListener('click', applyHandler);
        dom.appUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
    }

    /**
     * 汎用メッセージトーストを表示
     * @param {string} message - 表示するメッセージ
     * @param {'info' | 'success' | 'error'} type - トーストのタイプ
     */
    function showMessageToast(message, type = 'info') {
        // 既存のトーストタイマーがあればクリア
        if (showMessageToast.timeoutId) {
            clearTimeout(showMessageToast.timeoutId);
        }
        
        dom.messageToastText.textContent = message;
        
        // 色分け
        dom.messageToast.style.backgroundColor = 'var(--color-on-surface)'; // default (info)
        dom.messageToast.style.color = 'var(--color-background)';
        if (type === 'success') {
            dom.messageToast.style.backgroundColor = 'var(--color-success)';
            dom.messageToast.style.color = 'var(--color-on-primary)';
        } else if (type === 'error') {
            dom.messageToast.style.backgroundColor = 'var(--color-error)';
            dom.messageToast.style.color = 'var(--color-on-primary)';
        }
        
        dom.messageToast.style.display = 'flex';
        
        // 閉じるボタンのハンドラー
        const dismissHandler = () => {
            dom.messageToast.style.display = 'none';
            dom.messageToastDismissBtn.removeEventListener('click', dismissHandler);
            if (showMessageToast.timeoutId) {
                clearTimeout(showMessageToast.timeoutId);
                showMessageToast.timeoutId = null;
            }
        };
        // 古いリスナーを削除してから追加
        dom.messageToastDismissBtn.removeEventListener('click', dismissHandler); 
        dom.messageToastDismissBtn.addEventListener('click', dismissHandler, { once: true });

        // 5秒後に自動で消すタイマー
        showMessageToast.timeoutId = setTimeout(dismissHandler, 5000);
    }
    // トーストタイマーIDを保持するための静的プロパティ
    showMessageToast.timeoutId = null;


    // === 9. イベントリスナー設定 ===
    function setupEventListeners() {
        
        // --- ヘッダー ---
        
        // 検索バー (入力中に即時反映、デバウンス処理)
        let searchTimeout;
        dom.searchBar.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const hasValue = dom.searchBar.value.length > 0;
            dom.clearSearchBtn.style.display = hasValue ? 'block' : 'none';
            // 300ms待ってから検索実行
            searchTimeout = setTimeout(applyFiltersAndDisplay, 300);
        });

        // 検索クリアボタン
        dom.clearSearchBtn.addEventListener('click', () => {
            dom.searchBar.value = '';
            dom.clearSearchBtn.style.display = 'none';
            applyFiltersAndDisplay();
            dom.searchBar.focus(); // クリア後に入力しやすいようにフォーカス
        });

        // フィルタボタン
        dom.filterBtn.addEventListener('click', () => {
            dom.filterModal.style.display = 'flex';
        });

        // --- フッター ---
        dom.settingsBtn.addEventListener('click', () => {
            dom.settingsModal.style.display = 'flex';
        });
        
        // --- フィルタモーダル ---
        dom.closeFilterModalBtn.addEventListener('click', () => {
            dom.filterModal.style.display = 'none';
        });
        // モーダル背景クリックで閉じる
        dom.filterModal.addEventListener('click', (e) => {
             if (e.target === dom.filterModal) {
                 dom.filterModal.style.display = 'none';
             }
        });
        dom.applyFilterBtn.addEventListener('click', () => {
            readFiltersFromModal();
            applyFiltersAndDisplay();
            dom.filterModal.style.display = 'none';
        });
        dom.resetFilterBtn.addEventListener('click', () => {
            resetFilters();
            // リセット後、適用ボタンを押さなくても即時反映させる場合
            // applyFiltersAndDisplay();
            // dom.filterModal.style.display = 'none'; 
        });

        // --- 設定モーダル ---
        dom.closeSettingsModalBtn.addEventListener('click', () => {
            dom.settingsModal.style.display = 'none';
        });
         // モーダル背景クリックで閉じる
        dom.settingsModal.addEventListener('click', (e) => {
             if (e.target === dom.settingsModal) {
                 dom.settingsModal.style.display = 'none';
             }
        });
        dom.columnSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.column-btn');
            if (btn && !btn.classList.contains('active')) { // アクティブでなければ処理
                setGridColumns(btn.dataset.columns);
            }
        });
        dom.cacheAllImagesBtn.addEventListener('click', cacheAllImages);
        dom.clearAllDataBtn.addEventListener('click', clearAllData);

        // --- ライトボックス ---
        dom.lightboxCloseBtn.addEventListener('click', () => {
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = ''; // メモリ解放
            dom.lightboxImage.onerror = null; // エラーハンドラ解除
        });
        dom.lightboxModal.addEventListener('click', (e) => {
            // 画像以外の背景クリックでも閉じる
            if (e.target === dom.lightboxModal) {
                dom.lightboxModal.style.display = 'none';
                dom.lightboxImage.src = ''; // メモリ解放
                dom.lightboxImage.onerror = null; // エラーハンドラ解除
            }
        });
    }

    // === 10. アプリ起動 ===
    // DOMContentLoadedではなく、window load を待つことで、
    // Service Worker の準備などを含む完全な初期化を保証する（特に初回アクセス時）
    window.addEventListener('load', initializeApp);

})();

