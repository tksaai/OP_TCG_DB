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

                if (!localLastModified) {
                    // 初回起動時（ローカルデータなし）は通知なしで即時更新
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
                // 更新がないと判断した場合
                console.log('Card data is assumed up to date.');
                await loadCardsFromDB();

                // --- 追加のチェック ---
                // データが最新のはずなのに、DBが空だったら強制的に再取得
                if (allCards.length === 0 && localLastModified) {
                    console.warn('DB is empty even though metadata indicates it is up to date. Forcing data fetch...');
                    dom.loadingIndicator.style.display = 'flex'; // ローディング表示を再開
                    dom.loadingIndicator.querySelector('p').textContent = 'データ整合性を確認中...';
                    await fetchAndUpdateCardData(serverLastModified);
                }
                // --- 追加のチェックここまで ---
            }
        } catch (error) {
            console.error('Failed to check card data version:', error);
            console.log('Attempting to load from local DB as fallback...');
            dom.loadingIndicator.querySelector('p').textContent = 'オフラインモードで起動中...';
            await loadCardsFromDB(); // オフラインでもDBにあれば起動
        }
    }

    /**
     * Last-Modifiedが使えない場合のフォールバック
     */
    async function checkCardDataByFetching() {
        console.log('Checking card data by full fetch (fallback)...');
        // 常にローカルDBをロード試行
        await loadCardsFromDB();
        // フォールバックの場合もDBが空だったら再取得を試みる (初回起動を想定)
        if (allCards.length === 0) {
            console.warn('DB is empty on fallback check. Attempting initial fetch...');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
            // Last-Modifiedがないので、現在時刻を仮の識別子として渡す
            await fetchAndUpdateCardData(new Date().toUTCString());
        }
    }


    /**
     * サーバーから最新のcards.jsonを取得し、DBを更新
     * @param {string} serverLastModified - サーバーから取得したLast-Modifiedヘッダー (または代替のタイムスタンプ)
     */
    async function fetchAndUpdateCardData(serverLastModified) {
        if (!db) {
            console.error('DB not available for updating card data.');
            showMessageToast('データベースエラーが発生しました。', 'error');
            return;
        }

        dom.loadingIndicator.style.display = 'flex';
        dom.loadingIndicator.querySelector('p').textContent = '最新カードデータをダウンロード中...';

        let tx; // トランザクションを早期に宣言

        try {
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText}`);

            const cardsData = await response.json();
            let cardsArray = [];

            // データ形式の確認と配列への変換
            if (Array.isArray(cardsData)) {
                cardsArray = cardsData;
            } else if (typeof cardsData === 'object' && cardsData !== null) {
                console.warn("JSON format is not a simple array. Extracting values.");
                cardsArray = Object.values(cardsData).flat(); // オブジェクトの値をフラットな配列に
            } else {
                throw new Error("Invalid cards.json format");
            }

            if (cardsArray.length === 0) {
                 throw new Error("Downloaded card data is empty.");
            }

            dom.loadingIndicator.querySelector('p').textContent = 'データベースを更新中...';

            // --- DB更新処理 ---
            tx = db.transaction([STORE_CARDS, STORE_METADATA], 'readwrite');
            const cardStore = tx.objectStore(STORE_CARDS);
            const metaStore = tx.objectStore(STORE_METADATA);
            let count = 0;
            let putErrors = 0;

            // 既存データをクリア
            await cardStore.clear();
            console.log(`${STORE_CARDS} store cleared.`);

            // 新データを一件ずつ追加
            for (const card of cardsArray) {
                if (card && card.id) {
                    try {
                        await cardStore.put(card);
                        count++;
                    } catch (putError) {
                        console.error(`Failed to put card ${card.id} into DB:`, putError);
                        putErrors++;
                        // エラーが発生しても処理を続行する（部分的な成功を目指す）
                    }
                } else {
                    console.warn('Skipping invalid card object during update:', card);
                }
            }
            console.log(`${count} cards attempted to add to DB.`);
            if (putErrors > 0) {
                console.error(`${putErrors} errors occurred during card put operations.`);
                // 致命的なエラーとして扱う場合はここでエラーを投げる
                // throw new Error(`${putErrors} errors occurred during DB update.`);
            }

            // メタデータを更新 (カードのputが一部失敗しても、成功した分は反映するためメタデータは更新する)
            await metaStore.put({
                key: 'cardsLastModified',
                value: serverLastModified
            });
            console.log('Metadata updated.');

            // トランザクション完了を待つ
            await tx.done;
            console.log('DB update transaction completed.');
            // --- DB更新処理ここまで ---

            console.log('Card database update process finished successfully.');
            const savedMeta = await db.get(STORE_METADATA, 'cardsLastModified');
            dom.cardDataVersionInfo.textContent = savedMeta ? new Date(savedMeta.value).toLocaleString('ja-JP') : '更新完了';
            showMessageToast(`カードデータが更新されました (${count}件)。`, 'success');

            // 更新したデータで再表示
            await loadCardsFromDB();

        } catch (error) {
            console.error('Failed to update card data:', error);
            dom.loadingIndicator.querySelector('p').textContent = `データ更新に失敗しました: ${error.message}`;
            showMessageToast('データ更新に失敗しました。オフラインデータを表示します。', 'error');

            // トランザクションが開始されていた場合、中断を試みる (エラー発生場所による)
            if (tx && tx.abort) {
                try {
                    tx.abort();
                    console.log('DB update transaction aborted due to error.');
                } catch (abortError) {
                    console.error('Error aborting transaction:', abortError);
                }
            }

            // 失敗したら古いデータで表示試行
            await loadCardsFromDB();
        } finally {
             // 成功・失敗に関わらずローディング表示を消す
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
                // ローディング表示がまだ出ていて、かつ「取得中」とかでなければメッセージ更新
                if (dom.loadingIndicator.style.display !== 'none' && !dom.loadingIndicator.textContent.includes('取得中') && !dom.loadingIndicator.textContent.includes('確認中')) {
                     dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                }
                dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                dom.cardListContainer.innerHTML = '';
            } else {
                console.log(`Loaded ${allCards.length} cards from DB.`);
                dom.loadingIndicator.style.display = 'none'; // データがあればローディング非表示
                dom.mainContent.style.display = 'block'; // メインコンテンツ表示
                populateFilters(); // フィルタ生成
                applyFiltersAndDisplay(); // カード表示
            }
        } catch (error) {
            console.error('Failed to load cards from DB:', error);
            dom.loadingIndicator.textContent = 'データの読み込みに失敗しました。';
            allCards = []; // エラー時は空にする
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
            // DBが空の場合のメッセージは loadCardsFromDB で設定されるので、ここでは何もしないか、
            // より具体的な「フィルタ結果なし」メッセージを表示するか選択
            // dom.cardListContainer.innerHTML = '<p class="no-results">カードデータが読み込まれていません。</p>';
            return;
        }

        const searchTerm = dom.searchBar.value.trim().toLowerCase();
        const searchWords = searchTerm.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);

        const filteredCards = allCards.filter(card => {
            // 不正なデータは除外
            if (!card || !card.id) return false;

            // 1. フリーワード検索 (AND)
            if (searchWords.length > 0) {
                const searchableText = [
                    card.name || '',
                    card.effect || '',
                    (card.traits || []).join(' '), // 配列をスペース区切り文字列に
                    card.id || ''
                ].join(' ').toLowerCase();
                // すべての検索語が含まれているか？
                if (!searchWords.every(word => searchableText.includes(word))) {
                    return false;
                }
            }

            // 2. 詳細フィルタ
            const f = currentFilter;

            // 色 (AND): 選択された色がすべてカードに含まれているか？
            if (f.colors?.length > 0) {
                 if (!Array.isArray(card.color) || !f.colors.every(color => card.color.includes(color))) {
                    return false;
                }
            }
            // 種別 (OR): 選択された種別のいずれかにカードが一致するか？
            if (f.types?.length > 0 && !f.types.includes(card.type)) return false;
            // レアリティ (OR)
            if (f.rarities?.length > 0 && !f.rarities.includes(card.rarity)) return false;
            // コスト (OR) - 文字列で比較
            if (f.costs?.length > 0) {
                // card.costがnullやundefinedの場合も考慮
                if (card.cost === undefined || card.cost === null || !f.costs.includes(String(card.cost))) {
                     return false;
                }
            }
            // 属性 (AND)
             if (f.attributes?.length > 0) {
                 if (!Array.isArray(card.attribute) || !f.attributes.every(attr => card.attribute.includes(attr))) {
                    return false;
                }
            }
            // シリーズ (完全一致)
            if (f.series) {
                if (!card.id) return false; // IDがないと比較不可
                const cardSeriesId = card.id.split('-')[0]; // 例: "OP01-001" -> "OP01"
                if (cardSeriesId !== f.series) return false;
            }

            // すべての条件を通過
            return true;
        });

        displayCards(filteredCards);
    }

    /**
     * カード一覧をDOMに描画
     * @param {Array} cards - 表示するカードの配列
     */
    function displayCards(cards) {
        const fragment = document.createDocumentFragment();

        if (cards.length === 0) {
            // フィルタ結果が0件の場合のメッセージ
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach(card => {
            if (!card || !card.id) {
                console.warn('Skipping invalid card data during display:', card);
                return;
            }

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';

            const img = document.createElement('img');
            img.className = 'card-image';
            // 小画像パス取得、なければ空文字
            const smallImagePath = card.imagePath ? card.imagePath.replace('.jpg', '_small.jpg') : '';
            // 相対パス './' を確実にする
            const relativeImagePath = smallImagePath && smallImagePath.startsWith('Cards/') ? `./${smallImagePath}` : smallImagePath;

            img.src = relativeImagePath;
            img.alt = card.name || card.id;
            img.loading = 'lazy'; // 画像遅延読み込み

            // クリックでライトボックス表示
            cardItem.addEventListener('click', () => showLightbox(card));

            // 画像読み込みエラー時の処理
            img.onerror = () => {
                console.warn(`Failed to load image: ${relativeImagePath}`);
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.id; // カードIDを表示
                cardItem.innerHTML = ''; // img要素を削除
                cardItem.appendChild(fallback);
                // フォールバック表示でもクリックイベントを設定
                cardItem.onclick = () => showLightbox(card);
            };

            // 画像パスがない、またはエラーハンドラでimgが削除された場合以外はimgを追加
            if (relativeImagePath) {
                 cardItem.appendChild(img);
            } else {
                 // 画像パス自体がない場合のフォールバック
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.id;
                 cardItem.appendChild(fallback);
                 cardItem.onclick = () => showLightbox(card); // クリックイベント
            }

            fragment.appendChild(cardItem);
        });

        // DOM操作は最後にまとめて行う
        dom.cardListContainer.innerHTML = ''; // コンテナをクリア
        dom.cardListContainer.appendChild(fragment);
    }

    /**
     * グリッドの列数を変更
     */
    function setGridColumns(columns) {
        // CSS変数を更新
        document.documentElement.style.setProperty('--grid-columns', columns);
        // ボタンのアクティブ状態を更新
        $$('.column-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.columns === String(columns));
        });
        // 設定をローカルストレージに保存
        localStorage.setItem('gridColumns', columns);
    }

    /**
     * 保存された列設定を読み込む（なければデフォルト3列）
     */
    function setDefaultColumnLayout() {
        const savedColumns = localStorage.getItem('gridColumns') || 3;
        setGridColumns(savedColumns);
    }

    /**
     * ライトボックスを表示
     */
    function showLightbox(card) {
        if (!card) return;

        const largeImagePath = card.imagePath || '';
        // 相対パス './' を確実にする
        const relativeLargePath = largeImagePath && largeImagePath.startsWith('Cards/') ? `./${largeImagePath}` : largeImagePath;

        dom.lightboxImage.src = relativeLargePath; // 大画像パス設定
        dom.lightboxImage.style.display = 'block'; // 画像表示
        dom.lightboxFallback.style.display = 'none'; // フォールバック非表示
        dom.lightboxFallback.textContent = '';

        // 大画像読み込みエラー時の処理
        dom.lightboxImage.onerror = () => {
            console.warn(`Failed to load lightbox image: ${relativeLargePath}`);
            dom.lightboxImage.style.display = 'none'; // 画像非表示
            dom.lightboxFallback.style.display = 'flex'; // フォールバック表示
            dom.lightboxFallback.textContent = card.id || 'Error'; // カードID表示
        };

        // 画像パス自体がない場合
         if (!relativeLargePath) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = card.id || 'No Image';
         }

        // モーダル表示
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

        // 各フィルタ項目のユニークな値を収集
        const colors = new Set();
        const types = new Set();
        const rarities = new Set();
        const costs = new Set();
        const attributes = new Set();
        const seriesSet = new Map(); // { id => name } 形式で重複除去

        allCards.forEach(card => {
            if (!card) return; // 不正データスキップ
            // 色 (配列であることを確認)
            if (Array.isArray(card.color)) card.color.forEach(c => colors.add(c));
            // 種別
            if(card.type) types.add(card.type);
            // レアリティ (SPは除外)
            if(card.rarity && card.rarity !== 'SP') rarities.add(card.rarity);
            // コスト (数値であることを確認)
            if(card.cost !== undefined && card.cost !== null) costs.add(card.cost);
            // 属性 (配列であることを確認)
            if (Array.isArray(card.attribute)) card.attribute.forEach(a => attributes.add(a));
            // シリーズ (プロモを除外し、IDと名前を取得)
            if(card.series && card.id && !card.id.startsWith('P-')) {
                const seriesParts = card.series.split(' - '); // "OP01 - ROMANCE DAWN"
                const seriesName = seriesParts[1] || card.series; // 名前部分 or 全体
                const seriesId = card.id.split('-')[0]; // "OP01"
                if (seriesId && !seriesSet.has(seriesId)) {
                    seriesSet.set(seriesId, `${seriesId} - ${seriesName}`); // マップに追加
                }
            }
        });

        // 収集した値をソート
        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        // レアリティ順序定義
        const rarityOrder = ['L', 'SEC', 'SR', 'R', 'UC', 'C'];
        const sortedRarities = [...rarities].sort((a, b) => rarityOrder.indexOf(a) - rarityOrder.indexOf(b));
        // コストは数値としてソート
        const sortedCosts = [...costs].map(Number).sort((a, b) => a - b);
        const sortedAttributes = [...attributes].sort();
        // シリーズはID (OP01, OP02, EB01...) でソート
        const sortedSeries = [...seriesSet.entries()]
            .sort(([idA], [idB]) => idA.localeCompare(idB, undefined, { numeric: true }))
            .map(([, name]) => name); // 名前 ("ID - Name") の配列に戻す

        // フィルタオプションのHTMLを生成して挿入
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
        if (options.length === 0) return ''; // オプションがなければ何も返さない
        // 各オプションのチェックボックスHTMLを生成
        const optionsHtml = options.map(option => `
            <label class="filter-checkbox-label" data-color="${name === 'colors' ? option : ''}">
                <input type="checkbox" class="filter-checkbox" name="${name}" value="${option}">
                <span class="filter-checkbox-ui" data-color="${name === 'colors' ? option : ''}">${option}</span>
            </label>
        `).join('');
        // fieldsetでグループ化
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
        // 各シリーズのoptionタグHTMLを生成
        const optionsHtml = seriesList.map(seriesName => {
            const seriesId = seriesName.split(' - ')[0]; // valueにはID ("OP01") を設定
            return `<option value="${seriesId}">${seriesName}</option>`;
        }).join('');
        // select要素を含むfieldsetを生成
        return `
            <fieldset class="filter-group">
                <legend>シリーズ</legend>
                <select id="filter-series" class="filter-select">
                    <option value="">すべて</option> <!-- デフォルト選択肢 -->
                    ${optionsHtml}
                </select>
            </fieldset>
        `;
    }

    /**
     * フィルタモーダルから現在のフィルタ設定を読み込む
     */
    function readFiltersFromModal() {
        // チェックされたチェックボックスの値を取得するヘルパー関数
        const getCheckedValues = (name) =>
            [...$$(`input[name="${name}"]:checked`)].map(cb => cb.value);
        // 現在のフィルタ条件オブジェクトを更新
        currentFilter = {
            colors: getCheckedValues('colors'),
            types: getCheckedValues('types'),
            rarities: getCheckedValues('rarities'),
            costs: getCheckedValues('costs'),
            attributes: getCheckedValues('attributes'),
            series: $('#filter-series')?.value || '', // select要素の値を取得 (なければ空文字)
        };
        console.log('Filters applied:', currentFilter);
    }

    /**
     * フィルタモーダルのチェックと選択をリセット
     */
    function resetFilters() {
        // 全チェックボックスのチェックを外す
        $$('.filter-checkbox').forEach(cb => cb.checked = false);
        // シリーズ選択を「すべて」に戻す
        const seriesSelect = $('#filter-series');
        if (seriesSelect) seriesSelect.value = '';
        // フィルタ条件オブジェクトを空にする
        currentFilter = {};
        console.log('Filters reset.');
    }

    // === 7. キャッシュ管理 (UI) ===

    /**
     * 全カード画像（小画像）をキャッシュ
     */
    async function cacheAllImages() {
        // カードデータがなければ中断
        if (allCards.length === 0) {
            showMessageToast('カードデータがありません。', 'error');
            return;
        }
        // 既に実行中なら中断
        if (dom.cacheAllImagesBtn.disabled) return;

        // UIを更新 (実行中表示)
        dom.cacheAllImagesBtn.disabled = true;
        dom.cacheAllImagesBtn.textContent = 'キャッシュ実行中...';
        dom.cacheProgressContainer.style.display = 'flex';
        dom.cacheProgressBar.style.width = '0%';

        // キャッシュ対象のURLリストを作成 (小画像パス、重複除去、相対パス化)
        const validCards = allCards.filter(card => card && card.imagePath);
        const smallImageUrls = [...new Set(
            validCards.map(card => {
                const path = card.imagePath.replace('.jpg', '_small.jpg');
                return path.startsWith('Cards/') ? `./${path}` : path; // Ensure relative path
            })
        )];

        const totalCount = smallImageUrls.length;
        dom.cacheProgressText.textContent = `0 / ${totalCount}`;

        // キャッシュ対象がなければ終了
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
            // 画像用キャッシュを開く
            const cache = await caches.open(CACHE_IMAGES);
            const parallelLimit = 5; // 同時ダウンロード数
            const queue = [...smallImageUrls]; // URLキュー

            // キューを処理するワーカー関数
            const processQueue = async () => {
                while(queue.length > 0) {
                    const url = queue.shift(); // キューからURLを取得
                    if (!url) continue;

                    try {
                        // 既にキャッシュに存在するか確認
                        const existing = await cache.match(url);
                        if (!existing) {
                            // なければキャッシュに追加 (fetch + put)
                            await cache.add(url);
                        }
                    } catch (e) {
                        // キャッシュ失敗
                        console.warn(`Failed to cache image: ${url}`, e);
                        errors++;
                    }

                    cachedCount++;
                    // UI更新 (requestAnimationFrameで描画タイミングに合わせる)
                    requestAnimationFrame(() => {
                        const progress = Math.round((cachedCount / totalCount) * 100);
                        dom.cacheProgressBar.style.width = `${progress}%`;
                        dom.cacheProgressText.textContent = `${cachedCount} / ${totalCount}`;
                    });
                     // await new Promise(resolve => setTimeout(resolve, 5)); // 必要ならスロットリング
                }
            };

            // 指定数だけワーカーを起動し、完了を待つ
            const workers = Array(parallelLimit).fill(null).map(processQueue);
            await Promise.all(workers);

            // 結果をトースト表示
            if (errors > 0) {
                showMessageToast(`画像キャッシュ完了 (${totalCount - errors}/${totalCount} 成功、${errors}件エラー)`, 'info');
            } else {
                showMessageToast(`全${totalCount}件の画像キャッシュが完了しました。`, 'success');
            }

        } catch (error) {
            console.error('Failed to cache all images:', error);
            showMessageToast('画像キャッシュ中にエラーが発生しました。', 'error');
        } finally {
            // UIを元に戻す
            dom.cacheAllImagesBtn.disabled = false;
            dom.cacheAllImagesBtn.textContent = '全画像キャッシュ実行';
            // 進捗バーを少し遅れて消す
            setTimeout(() => {
                dom.cacheProgressContainer.style.display = 'none';
            }, 1500);
        }
    }

    /**
     * 全てのローカルデータを削除 (IndexedDB, Cache Storage, Service Worker, LocalStorage)
     */
    async function clearAllData() {
        // ユーザー確認 (iframe等でconfirmが使えない場合を考慮)
        let confirmed = false;
        try {
             confirmed = window.confirm('本当にすべてのデータを削除しますか？\nデータベースと画像キャッシュが消去され、アプリがリロードされます。');
        } catch (e) {
            console.warn("window.confirm maybe blocked. Using prompt as fallback.", e);
            const input = prompt("すべてのデータを削除しますか？ 'yes'と入力してください。");
            confirmed = input && input.toLowerCase() === 'yes';
        }
        if (!confirmed) return; // キャンセルされたら何もしない

        try {
            showMessageToast('全データを削除中...'); // 処理中メッセージ

            // 1. IndexedDB 削除
            if (db) {
                db.close(); // 開いていれば閉じる
                await idb.deleteDB(DB_NAME);
                db = null; // インスタンス参照をクリア
                console.log('IndexedDB deleted.');
            } else {
                 await idb.deleteDB(DB_NAME); // 開いてなくても削除試行
                 console.log('Attempted IndexedDB deletion.');
            }

            // 2. Cache Storage 削除 (関連キャッシュのみ)
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

            // 3. Service Worker 登録解除
            if (swRegistration) {
                await swRegistration.unregister();
                console.log('Service Worker unregistered.');
                swRegistration = null;
            } else {
                // 登録情報がなくても現在の登録を取得して解除試行
                const registration = await navigator.serviceWorker.getRegistration();
                if(registration) {
                    await registration.unregister();
                    console.log('Service Worker unregistered (fallback).');
                }
            }

            // 4. LocalStorage クリア (列設定など)
            localStorage.clear();
            console.log('LocalStorage cleared.');

            // 完了メッセージ表示後、リロード
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
        // Service Workerが利用可能か確認
        if ('serviceWorker' in navigator) {
            try {
                // Service Workerを登録
                const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
                swRegistration = registration; // 登録情報を保持
                console.log('Service Worker registered:', registration.scope);

                // --- 更新チェックロジック ---
                // 1. 既に待機中の新しいWorkerがいるか？ (ページロード時)
                if (registration.waiting) {
                    console.log('New Service Worker is waiting.');
                    showAppUpdateNotification(); // 更新通知を表示
                }

                // 2. 新しいWorkerのインストールが始まったら検知
                registration.onupdatefound = () => {
                    console.log('Service Worker update found.');
                    const installingWorker = registration.installing;
                    if (installingWorker) {
                        // 新しいWorkerの状態変化を監視
                        installingWorker.onstatechange = () => {
                            // インストール完了 -> 待機状態になった かつ 現在ページがSWによって制御されている
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                console.log('New Service Worker is installed and waiting.');
                                showAppUpdateNotification(); // 更新通知を表示
                            } else {
                                // その他の状態変化 (installing, activating, activated, redundant)
                                console.log(`[SW State Change] New worker state: ${installingWorker.state}`);
                            }
                        };
                    }
                };

            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }

            // 3. Service Workerがアクティブ化され、ページ制御が変わった時 (更新適用後)
            let refreshing = false; // 無限リロード防止フラグ
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                console.log('Service Worker controller changed.');
                 if (refreshing) return;
                 // 更新完了メッセージを表示し、ページリロード
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
        dom.dbUpdateNotification.style.display = 'none'; // 念のため一旦隠す
        dom.dbUpdateNotification.style.display = 'flex'; // 表示

        // 更新ボタンの処理 (一度だけ実行)
        const applyHandler = () => {
            dom.dbUpdateNotification.style.display = 'none'; // 通知を隠す
            fetchAndUpdateCardData(serverLastModified); // データ更新実行
        };
        // 閉じるボタンの処理 (一度だけ実行)
        const dismissHandler = () => {
            dom.dbUpdateNotification.style.display = 'none'; // 通知を隠す
        };

        // 古いリスナーを削除 (重要: 重複登録を防ぐ)
        dom.dbUpdateApplyBtn.removeEventListener('click', applyHandler);
        dom.dbUpdateDismissBtn.removeEventListener('click', dismissHandler);

        // 新しいリスナーを登録 ({ once: true } で自動的に削除される)
        dom.dbUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
        dom.dbUpdateDismissBtn.addEventListener('click', dismissHandler, { once: true });
    }

    /**
     * アプリ本体の更新通知を表示
     */
    function showAppUpdateNotification() {
        dom.appUpdateNotification.style.display = 'none'; // 念のため一旦隠す
        dom.appUpdateNotification.style.display = 'flex'; // 表示

        // 更新ボタンの処理
        const applyHandler = () => {
            // 待機中のService Workerが存在するか確認
            if (swRegistration && swRegistration.waiting) {
                console.log('Sending SKIP_WAITING message to Service Worker.');
                // 待機中のWorkerにアクティブ化を指示するメッセージを送信
                swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
                dom.appUpdateNotification.style.display = 'none'; // 通知を隠す
                showMessageToast('アプリを更新中...'); // 更新中メッセージ
                // controllerchange イベントが発火してリロードされるのを期待するが、
                // 念のためタイムアウトリロードも設定
                setTimeout(() => {
                    if (!applyHandler.refreshed) { // controllerchangeが発火しなかった場合
                         console.warn('Controller change event did not fire. Reloading manually.');
                         window.location.reload();
                    }
                }, 3000);
            } else {
                 // 待機中のWorkerが見つからない場合 (通常は起こらないはず)
                 console.warn('Could not find waiting Service Worker to send SKIP_WAITING. Reloading directly...');
                 window.location.reload(); // 直接リロード
            }
        };

        // controllerchangeが発火したらリロード済みフラグを立てる
        applyHandler.refreshed = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => { applyHandler.refreshed = true; }, { once: true });

        // 古いリスナーを削除
        dom.appUpdateApplyBtn.removeEventListener('click', applyHandler);
        // 新しいリスナーを登録 ({ once: true } が望ましいが、リロード前に解除される可能性考慮)
        // applyHandler内でリロードするので once: true でも問題ない
        dom.appUpdateApplyBtn.addEventListener('click', applyHandler, { once: true });
    }

    /**
     * 汎用メッセージトーストを表示
     * @param {string} message 表示メッセージ
     * @param {'info'|'success'|'error'} type トースト種別
     */
    function showMessageToast(message, type = 'info') {
        // 既存のタイマーがあればクリア
        if (showMessageToast.timeoutId) clearTimeout(showMessageToast.timeoutId);

        // メッセージ設定
        dom.messageToastText.textContent = message;

        // タイプに応じて背景色・文字色を設定
        dom.messageToast.className = `message-toast ${type}`; // CSSクラスで制御

        // 表示
        dom.messageToast.style.display = 'flex';

        // 閉じるボタンの処理
        const dismissHandler = () => {
            dom.messageToast.style.display = 'none';
            dom.messageToastDismissBtn.removeEventListener('click', dismissHandler);
            if (showMessageToast.timeoutId) {
                clearTimeout(showMessageToast.timeoutId);
                showMessageToast.timeoutId = null;
            }
        };
        // 古いリスナー削除 -> 新しいリスナー登録
        dom.messageToastDismissBtn.removeEventListener('click', dismissHandler);
        dom.messageToastDismissBtn.addEventListener('click', dismissHandler, { once: true });

        // 自動で消すタイマー (5秒)
        showMessageToast.timeoutId = setTimeout(dismissHandler, 5000);
    }
    showMessageToast.timeoutId = null; // タイマーID保持用


    // === 9. イベントリスナー設定 ===
    function setupEventListeners() {
        // --- 検索バー ---
        let searchTimeout;
        dom.searchBar.addEventListener('input', () => {
            clearTimeout(searchTimeout); // 入力中はタイマーリセット
            const hasValue = dom.searchBar.value.length > 0;
            dom.clearSearchBtn.style.display = hasValue ? 'block' : 'none'; // クリアボタン表示制御
            // 300ms後に検索実行 (デバウンス)
            searchTimeout = setTimeout(applyFiltersAndDisplay, 300);
        });
        dom.clearSearchBtn.addEventListener('click', () => {
            dom.searchBar.value = ''; // 入力クリア
            dom.clearSearchBtn.style.display = 'none'; // ボタン非表示
            applyFiltersAndDisplay(); // 再表示
            dom.searchBar.focus(); // フォーカス戻す
        });

        // --- ヘッダーボタン ---
        dom.filterBtn.addEventListener('click', () => { dom.filterModal.style.display = 'flex'; });
        dom.settingsBtn.addEventListener('click', () => { dom.settingsModal.style.display = 'flex'; });

        // --- フィルタモーダル ---
        dom.closeFilterModalBtn.addEventListener('click', () => { dom.filterModal.style.display = 'none'; });
        // 背景クリックで閉じる
        dom.filterModal.addEventListener('click', (e) => { if (e.target === dom.filterModal) dom.filterModal.style.display = 'none'; });
        // 適用ボタン
        dom.applyFilterBtn.addEventListener('click', () => {
            readFiltersFromModal(); // フィルタ条件読み込み
            applyFiltersAndDisplay(); // カード再表示
            dom.filterModal.style.display = 'none'; // モーダル閉じる
        });
        // リセットボタン
        dom.resetFilterBtn.addEventListener('click', resetFilters); // フィルタUIリセット

        // --- 設定モーダル ---
        dom.closeSettingsModalBtn.addEventListener('click', () => { dom.settingsModal.style.display = 'none'; });
        // 背景クリックで閉じる
        dom.settingsModal.addEventListener('click', (e) => { if (e.target === dom.settingsModal) dom.settingsModal.style.display = 'none'; });
        // 列数変更ボタン
        dom.columnSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.column-btn'); // ボタン要素取得
            // ボタンが存在し、かつアクティブでない場合のみ処理
            if (btn && !btn.classList.contains('active')) {
                 setGridColumns(btn.dataset.columns); // 列数変更実行
            }
        });
        // 画像キャッシュボタン
        dom.cacheAllImagesBtn.addEventListener('click', cacheAllImages);
        // 全データ削除ボタン
        dom.clearAllDataBtn.addEventListener('click', clearAllData);

        // --- ライトボックス ---
        dom.lightboxCloseBtn.addEventListener('click', () => { // 閉じるボタン
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = ''; // 画像ソースクリア (メモリ解放)
            dom.lightboxImage.onerror = null; // エラーハンドラ解除
        });
        dom.lightboxModal.addEventListener('click', (e) => { // 背景クリック
            if (e.target === dom.lightboxModal) {
                dom.lightboxModal.style.display = 'none';
                dom.lightboxImage.src = '';
                dom.lightboxImage.onerror = null;
            }
        });
    }

    // === 10. アプリ起動 ===
    // DOMだけでなく、画像などのリソース読み込みも待ってから初期化開始
    window.addEventListener('load', initializeApp);

})();

