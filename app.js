// OP-TCG DB PWA メインスクリプト

(function() {
    'use strict';

    // === 1. グローバル変数と定数 ===
    const DB_NAME = 'OPCardDB';
    const DB_VERSION = 2; // ★ DBバージョンを2に更新 (keyPath 変更のため)
    const STORE_CARDS = 'cards';
    const STORE_METADATA = 'metadata';
    const CACHE_APP_SHELL = 'app-shell-v1'; // service-worker.jsと合わせる
    const CACHE_IMAGES = 'card-images-v1'; // service-worker.jsと合わせる
    const CARDS_JSON_PATH = './cards.json';
    const APP_VERSION = '1.0.23'; // ★ アプリバージョン更新 (特徴フィルタ削除, タップ修正)
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
    let isDebugInfoVisible = false; // デバッグ情報表示中フラグ
    // ---
    
    // --- カードリスト タップ判定用 ---
    let cardListTapElement = null;
    let cardListTapStartY = 0;
    let cardListTapMoveY = 0;
    // ---

    // === 2. DOM要素のキャッシュ ===
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);

    // ★修正: 宣言だけ先に
    let dom = {};

    /**
     * ★ひらがなをカタカナに変換するヘルパー関数
     * @param {string} str - 変換する文字列
     * @returns {string} カタカナに変換された文字列
     */
    function toKatakana(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[\u3041-\u3096]/g, function(match) {
            const charCode = match.charCodeAt(0) + 0x60; // 0x30A1 (ア) - 0x3041 (ぁ) = 0x60
            return String.fromCharCode(charCode);
        });
    }

    /**
     * ★全角英数を半角英数に変換
     */
    function toHalfWidth(str) {
        if (typeof str !== 'string') return '';
        // 全角英数（A-Z, a-z, 0-9）と記号（！～）を半角に
        return str.replace(/[\uFF01-\uFF5E]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) - 0xFEE0);
        });
    }


    // === 3. 初期化処理 ===
    
    /**
     * ★修正: DOM要素をキャッシュする関数
     * (initializeApp から呼び出される)
     */
    function cacheDomElements() {
        dom = {
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
            cacheAllImagesBtn: $('#cache-all-images-btn'),
            clearAllDataBtn: $('#clear-all-data-btn'),
            appVersionInfo: $('#app-version-info'),
            cardDataVersionInfo: $('#card-data-version-info'),
    
            // ★ 修正: 列セレクタをフッターから取得
            columnToggleBtn: $('#column-toggle-btn'),
            columnCountDisplay: $('#column-count-display'),

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
    }

    /**
     * アプリケーションの初期化
     */
    async function initializeApp() {
        console.log('PWA Initializing...');
        
        // ★修正: DOMキャッシュをここで実行
        cacheDomElements();
        
        // DOMキャッシュが完了してからバージョン情報を設定
        if (dom.appVersionInfo) {
            dom.appVersionInfo.textContent = APP_VERSION;
        } else {
            console.error('DOM cache failed: appVersionInfo is not found.');
            // ローディングインジケータが見つからない可能性が高い
            const loadingIndicator = $('#loading-indicator');
            if(loadingIndicator) {
                loadingIndicator.textContent = '初期化エラー: DOM要素が見つかりません。';
            }
            return; // 致命的エラー
        }

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

                    // バージョン2へのアップグレード: keyPath を 'id' から 'cardNumber' に変更
                    if (oldVersion < 2 && db.objectStoreNames.contains(STORE_CARDS)) {
                        console.log(`Recreating ${STORE_CARDS} store for version 2 with keyPath 'cardNumber'.`);
                        try {
                            db.deleteObjectStore(STORE_CARDS);
                            console.log(`Old object store ${STORE_CARDS} deleted.`);
                        } catch (deleteError) {
                             console.error(`Failed to delete old ${STORE_CARDS} store:`, deleteError);
                             throw deleteError; // アップグレード失敗
                        }
                    }
                    if (!db.objectStoreNames.contains(STORE_CARDS)) {
                         // ★ 修正: PUNKDB の 'id' ではなく 'cardNumber' をキーにする
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
             throw error; // 初期化失敗は致命的エラーとしてスロー
        }
    }


    // === 5. カード一覧表示 ===
    // ★注意: 依存される関数群 (5, 6) を、依存する関数 (4) よりも先に定義する

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
        
        // ★修正: _small.jpg を使わない
        return `Cards/${seriesId}/${cardId}.jpg`;
    }

    /**
     * カード一覧をDOMに描画
     * @param {Array} cards - 表示するカードの配列 (currentFilteredCards)
     */
    function displayCards(cards) {
        // 高速化のため、一度 DocumentFragment にまとめてからDOMに追加
        const fragment = document.createDocumentFragment();
        
        if (cards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach((card, index) => { // ★修正: ループ内でインデックスを取得
            if (!card || !card.cardNumber) { // ★修正: cardNumber をチェック
                console.warn('Skipping invalid card data during display (missing cardNumber):', card);
                return;
            }

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';
            // ★ 修正: タップ判定のため、インデックスをdata属性に保存
            cardItem.dataset.index = index;
            
            const img = document.createElement('img');
            img.className = 'card-image';
            
            // ★修正: _small.jpg を使わないロジック
            let largeImagePath = card.imagePath;
            if (!largeImagePath) {
                // imagePath がない場合、cardNumber からパスを生成
                largeImagePath = getGeneratedImagePath(card.cardNumber);
            }
            // --- 修正ここまで ---

            // ★修正: GitHub Pages (サブディレクトリ) とローカル動作を両立するため、パスが 'Cards/' で始まる場合のみ './' を付与
            const relativeImagePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

            img.src = relativeImagePath; 
            img.alt = card.cardName || card.cardNumber; // ★修正: card.name -> card.cardName
            img.loading = 'lazy'; // 遅延読み込み
            
            // ★ 修正: クリックイベントリスナーを削除 (setupEventListeners で touchend を使用)
            // cardItem.addEventListener('click', () => showLightbox(index));
            
            // ★修正: 画像読み込みエラー時のフォールバック
            img.onerror = () => {
                console.warn(`Failed to load image for card ${card.cardNumber}: ${relativeImagePath}`);
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.cardNumber;
                // img が存在する場合のみ replaceChild を試みる
                if(cardItem.contains(img)){
                    cardItem.replaceChild(fallback, img);
                } else if (!cardItem.querySelector('.card-fallback')) {
                     // 既にフォールバックがない場合のみ追加 (二重追加防止)
                     cardItem.appendChild(fallback);
                }
                // ★ 修正: onclick も削除 (親要素のリスナーに任せる)
                // cardItem.onclick = () => showLightbox(index);
            };
            
            if (relativeImagePath) {
                 cardItem.appendChild(img);
            } else {
                 // 画像パスが存在しない場合
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.cardNumber;
                 // ★ 修正: onclick も削除
                 // cardItem.onclick = () => showLightbox(index);
                 cardItem.appendChild(fallback);
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
        // ★ 修正: フッターのアイコン内の数字を更新
        if (dom.columnCountDisplay) {
            dom.columnCountDisplay.textContent = String(columns);
        }
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

    // --- 修正: ライトボックス表示ロジック ---

    /**
     * ライトボックスを表示
     * @param {number} index - currentFilteredCards 配列内のインデックス
     */
    function showLightbox(index) {
        // ★修正: インデックスの範囲チェック
        if (index < 0 || index >= currentFilteredCards.length) {
            console.error(`Lightbox index ${index} out of bounds.`);
            return;
        }
        
        isDebugInfoVisible = false; // デバッグフラグをリセット

        // ★修正: 現在のインデックスを-1にリセットし、updateLightboxImageが必ず実行されるようにする
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
        
        // ★修正: インデックスが変わらないなら（かつデバッグ中でないなら）何もしない
        if (newIndex === currentLightboxIndex && !isDebugInfoVisible) {
             console.log("Index is the same, not updating.");
             return;
        }
        
        isDebugInfoVisible = false; // デバッグフラグをリセット
        currentLightboxIndex = newIndex;
        const card = currentFilteredCards[currentLightboxIndex];

        if (!card || !card.cardNumber) {
             console.error(`Invalid card data at index ${currentLightboxIndex}`);
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex'; // flex に
             dom.lightboxFallback.textContent = 'Error';
             resetFallbackStyles(); // デバッグスタイルリセット
             return;
        }

        // ★修正: _small.jpg を使わない
        let largeImagePath = card.imagePath;
        if (!largeImagePath) {
            largeImagePath = getGeneratedImagePath(card.cardNumber);
        }
        // --- 修正ここまで ---

        const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

        // ★修正: デバッグ表示用のスタイルをリセットし、フォールバックを隠す
        resetFallbackStyles();
        dom.lightboxFallback.style.display = 'none'; // none に
        // --- 修正ここまで ---

        dom.lightboxImage.style.display = 'block';
        dom.lightboxImage.src = relativeLargePath;

        dom.lightboxImage.onerror = () => {
            console.warn(`Failed to load lightbox image for card ${card.cardNumber}: ${relativeLargePath}`);
            dom.lightboxImage.style.display = 'none';
            dom.lightboxFallback.style.display = 'flex'; // flex に
            dom.lightboxFallback.textContent = card.cardNumber || 'Error';
            resetFallbackStyles(); // エラー時もスタイルリセット
        };

         if (!relativeLargePath) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex'; // flex に
             dom.lightboxFallback.textContent = card.cardNumber || 'No Image';
             resetFallbackStyles(); // 画像なし時もスタイルリセット
         }

         // 高速化のためのプリロード
         preloadImage(currentLightboxIndex + 1); // 次の画像
         preloadImage(currentLightboxIndex - 1); // 前の画像
    }
    
    /**
     * ★デバッグ表示用のスタイルをリセットする関数
     */
    function resetFallbackStyles() {
        // スタイルをデフォルトのフォールバック表示（中央揃え、大文字など）に戻す
        dom.lightboxFallback.style.textAlign = 'center';
        dom.lightboxFallback.style.padding = '0';
        dom.lightboxFallback.style.whiteSpace = 'normal';
        dom.lightboxFallback.style.overflowY = 'hidden';
        dom.lightboxFallback.style.fontFamily = 'inherit';
        dom.lightboxFallback.style.fontSize = '1.5rem';
        dom.lightboxFallback.style.color = 'var(--color-text-primary)';
    }
    
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

        // ★修正: _small.jpg を使わない
        let largeImagePath = card.imagePath;
        if (!largeImagePath) {
            largeImagePath = getGeneratedImagePath(card.cardNumber);
        }
        // --- 修正ここまで ---
        
        const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;

        if (relativeLargePath) {
            const img = new Image();
            img.src = relativeLargePath;
        }
    }


    // === 6. 検索・フィルタ (UI) ===
    // ★注意: 依存される関数群 (5, 6) を、依存する関数 (4) よりも先に定義する

    /**
     * フィルタ条件に基づいてカードを抽出し、表示
     */
    function applyFiltersAndDisplay() {
        if (allCards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">カードデータが読み込まれていません。</p>';
            return;
        }

        // ★修正: 検索語を正規化（ひらがな→カタカナ、全角→半角、大文字化）
        let searchTerm = dom.searchBar.value.trim();
        searchTerm = toKatakana(searchTerm);
        searchTerm = toHalfWidth(searchTerm);
        searchTerm = searchTerm.toUpperCase(); // toLowerCase() から toUpperCase() に変更

        // --- 修正: 全角スペースを半角スペースに置換 ---
        const searchWords = searchTerm.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);
        // --- 修正ここまで ---

        // フィルタリング結果をグローバル変数に保存
        currentFilteredCards = allCards.filter(card => {
            if (!card || !card.cardNumber) return false;

            // --- 修正: 検索ロジック (JSONキー修正) ---
            if (searchWords.length > 0) {
                
                // ★修正: 検索対象のテキストも同様に正規化
                // ★修正: card.features を検索対象に含める (要望)
                let searchableText = [
                    card.cardName || '', // card.name から card.cardName に修正
                    card.effectText || '', // ★ card.effect から card.effectText に修正
                    (card.features || []).join(' '), // ★ 特徴(features)を検索対象に含める
                    card.cardNumber || ''
                ].join(' ');
                
                searchableText = toKatakana(searchableText);
                searchableText = toHalfWidth(searchableText);
                searchableText = searchableText.toUpperCase(); // toLowerCase() から toUpperCase() に変更
                
                // 検索ワードの *すべて* が含まれているかチェック
                if (!searchWords.every(word => searchableText.includes(word))) {
                    return false;
                }
            }
            // --- 修正ここまで ---

            const f = currentFilter;

            // --- 修正: 色フィルタのロジック (常にOR検索に統一) ---
            if (f.colors?.length > 0) {
                if (!Array.isArray(card.color) || card.color.length === 0) {
                    return false; // カードに色情報がなければ除外
                }

                // OR検索: 選択した色のいずれか一つでも含めばOK
                if (!f.colors.some(color => card.color.includes(color))) {
                    return false;
                }
            }
            // --- 修正ここまで ---
            
            // ★修正: JSONキー修正
            if (f.types?.length > 0 && !f.types.includes(card.cardType)) return false; // card.type から card.cardType に修正
            if (f.rarities?.length > 0 && !f.rarities.includes(card.rarity)) return false;
            if (f.costs?.length > 0) {
                // card.cost が文字列でも数値でも比較できるように String() で統一
                if (card.cost === undefined || card.cost === null || !f.costs.includes(String(card.cost))) {
                     return false;
                }
            }
            
            // ★ 修正: 特徴(f.features)でのフィルタリングロジックを削除
            /*
             if (f.features?.length > 0) {
                 if (!Array.isArray(card.features) || !f.features.every(attr => card.features.includes(attr))) {
                    return false;
                }
            }
            */

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

            return true; // すべてのフィルタを通過
        });

        displayCards(currentFilteredCards); // 保存したリストで表示
    }

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
        // ★ 修正: features Set を削除
        // const features = new Set();
        const seriesSet = new Map(); // seriesId をキー, 表示名を値 にする

        allCards.forEach(card => {
            if (!card || !card.cardNumber) return;

            if (Array.isArray(card.color)) card.color.forEach(c => colors.add(c));
            
            // ★修正: JSONキー修正 & ドン!!除外
            if(card.cardType && card.cardType !== 'ドン!!') types.add(card.cardType); 
            
            // ★修正: SP除外
            if(card.rarity && card.rarity !== 'SP') rarities.add(card.rarity); 
            
            if(card.cost !== undefined && card.cost !== null) costs.add(card.cost);
            
            // ★ 修正: features の収集ロジックを削除
            // if (Array.isArray(card.features)) card.features.forEach(a => features.add(a));

            // --- 修正: シリーズフィルタのロジック (seriesTitle を使用) ---
            const seriesId = card.cardNumber.split('-')[0]; // 例: "OP01", "P", "ST11"
            if (!seriesId || seriesSet.has(seriesId)) {
                return; // IDが無いか、既に処理済みならスキップ
            }

            if (seriesId === 'P') {
                seriesSet.set('P', 'P - プロモカード');
            } else if (card.seriesTitle) {
                // seriesTitle が存在する場合 (例: "ROMANCE DAWN")
                seriesSet.set(seriesId, `${seriesId} - ${card.seriesTitle}`);
            } else if (card.series) {
                 // seriesTitle がない場合のフォールバックとして card.series を試す
                // (例: "OP01 - ROMANCE DAWN")
                const seriesParts = card.series.split(' - ');
                const seriesName = seriesParts[1] || card.series; // "ROMANCE DAWN" または "OP01 - ROMANCE DAWN"
                seriesSet.set(seriesId, `${seriesId} - ${seriesName}`);
            } else {
                // それも無い場合の最終フォールバック
                seriesSet.set(seriesId, `${seriesId} - (シリーズ情報なし)`);
            }
            // --- 修正ここまで ---
        });

        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        // ★修正: Lの順序を変更 (SECの上)
        const rarityOrder = ['L', 'SEC', 'SR', 'R', 'UC', 'C'];
        const sortedRarities = [...rarities].sort((a, b) => {
            const indexA = rarityOrder.indexOf(a);
            const indexB = rarityOrder.indexOf(b);
            if (indexA === -1) return 1; // 不明なレアリティは後ろへ
            if (indexB === -1) return -1;
            return indexA - indexB;
        });
        // コストは数値としてソート
        const sortedCosts = [...costs].map(Number).sort((a, b) => a - b); 
        
        // ★ 修正: sortedFeatures を削除
        // const sortedFeatures = [...features].sort();

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

        // ★ 修正: フィルタの順序とクラスを変更 (画像参考)
        // ★ 修正: features の createFilterGroup 呼び出しを削除
        dom.filterOptionsContainer.innerHTML = `
            ${createFilterGroup('colors', '色 (OR)', sortedColors, 'colors')}
            ${createFilterGroup('costs', 'コスト', sortedCosts.map(String), 'costs')}
            ${createFilterGroup('types', '種別', sortedTypes, 'types')}
            ${createFilterGroup('rarities', 'レアリティ', sortedRarities, 'rarities')}
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
                <!-- ★ 修正: data-color を span にも適用 -->
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

        // ★ 修正: features を削除
        currentFilter = {
            colors: getCheckedValues('colors'),
            types: getCheckedValues('types'),
            rarities: getCheckedValues('rarities'),
            costs: getCheckedValues('costs'),
            series: $('#filter-series')?.value || '', // select要素の値を取得
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


    // === 4. データ管理 (DB, JSON) ===
    // ★セクション4 (データ管理) を、依存先 (5, 6) の *後* に配置

    /**
     * cards.jsonのバージョンを確認し、必要に応じて更新
     */
    async function checkCardDataVersion() {
        if (!db) {
             console.error("DB not available, skipping card data version check.");
             if (dom.loadingIndicator) {
                // DOMが初期化されていればテキストを設定
                dom.loadingIndicator.querySelector('p').textContent = 'データベース接続エラー。';
             }
             return;
        }

        try {
            // 1. サーバーからcards.jsonのヘッダー情報(Last-Modified)を取得
            const response = await fetch(CARDS_JSON_PATH, { 
                method: 'HEAD',
                cache: 'no-store' // 必ずサーバーに確認
            });
            
            if (!response.ok) throw new Error(`Failed to fetch HEAD: ${response.statusText} (${response.status})`);
            
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
                
                // 初回起動時（ローカルデータなし）は通知なしで即時更新
                if (!localLastModified) {
                    console.log('First time load. Fetching card data...');
                    dom.loadingIndicator.style.display = 'flex';
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
                console.log('Card data is assumed up to date.');
                await loadCardsFromDB();
                
                // ★修正: データが最新のはずなのにDBが空だったら強制的に再取得
                if (allCards.length === 0 && localLastModified) {
                    console.warn('DB is empty even though metadata indicates it is up to date. Forcing data fetch...');
                    dom.loadingIndicator.style.display = 'flex'; // ローディング表示を再開
                    dom.loadingIndicator.querySelector('p').textContent = 'データ整合性を確認中...';
                    await fetchAndUpdateCardData(serverLastModified);
                }
            }
        } catch (error) {
            console.error('Failed to check card data version:', error);
            console.log('Attempting to load from local DB as fallback...');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = 'オフラインモードで起動中...';
            await loadCardsFromDB(); // オフラインでもDBにあれば起動
        }
    }

    /**
     * Last-Modifiedが使えない場合のフォールバック (実装は簡略化のため省略)
     */
    async function checkCardDataByFetching() {
        console.log('Checking card data by full fetch (fallback)...');
        // ここでは簡略化し、常にローカルDBをロードする
        await loadCardsFromDB();
        // ★修正: フォールバックでもDBが空なら初回取得を試みる
        if (allCards.length === 0) {
            console.warn('DB is empty on fallback check. Attempting initial fetch...');
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
            // Last-Modifiedがないので、現在時刻を仮の識別子として渡す（DB保存時に使われる）
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

        let tx; // トランザクションをスコープの外で宣言

        try {
            // 1. JSONデータをダウンロード
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });
             if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText} (${response.status})`);
            
            const cardsData = await response.json();
            let cardsArray = [];
            
            // PUNKDBのデータ形式 (オブジェクトの配列) を想定
            if (Array.isArray(cardsData)) {
                cardsArray = cardsData;
            } else if (typeof cardsData === 'object' && cardsData !== null) {
                // もし { "OP01": [...], "OP02": [...] } のような形式なら展開
                console.warn("JSON format is not a simple array. Extracting values.");
                cardsArray = Object.values(cardsData).flat();
            } else {
                throw new Error("Invalid cards.json format");
            }

            if (cardsArray.length === 0) {
                 throw new Error("Downloaded card data is empty.");
            }

            dom.loadingIndicator.querySelector('p').textContent = 'データベースを更新中...';

            // 2. DBを更新 (トランザクション開始)
            tx = db.transaction([STORE_CARDS, STORE_METADATA], 'readwrite');
            tx.onerror = (event) => {
                // トランザクション全体のエラー
                console.error("Transaction error:", event.target.error);
            };

            const cardStore = tx.objectStore(STORE_CARDS);
            const metaStore = tx.objectStore(STORE_METADATA);
            let count = 0;
            let putErrors = 0;

            // 2a. 古いデータをクリア
            await cardStore.clear();
            console.log(`${STORE_CARDS} store cleared.`);

            // 2b. 新しいデータを一括追加
            // ★修正: 'cardNumber' をキーとしてDBに保存
            for (const card of cardsArray) {
                // 'cardNumber' が存在し、null や undefined でないことを確認
                if (card && card.cardNumber) { 
                    try {
                        await cardStore.put(card);
                        count++;
                    } catch (putError) {
                        // 主キー制約違反 (DuplicateKeyError) など
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

            // 2c. メタデータを更新
            await metaStore.put({
                key: 'cardsLastModified',
                value: serverLastModified // 取得成功時のタイムスタンプを保存
            });
            console.log('Metadata updated.');

            // 2d. トランザクション完了
            await tx.done;
            console.log('DB update transaction completed.');
            
            console.log('Card database update process finished successfully.');
            // DBからメタデータを再取得して表示
            const savedMeta = await db.get(STORE_METADATA, 'cardsLastModified');
            dom.cardDataVersionInfo.textContent = savedMeta ? new Date(savedMeta.value).toLocaleString('ja-JP') : '更新完了';
            showMessageToast(`カードデータが更新されました (${count}件)。`, 'success');

            // 3. 更新したデータをロード
            await loadCardsFromDB();

        } catch (error) {
            console.error('Failed to update card data:', error);
            dom.loadingIndicator.querySelector('p').textContent = `データ更新に失敗しました: ${error.message}`;
            showMessageToast('データ更新に失敗しました。オフラインデータを表示します。', 'error');
            // エラーが発生したらトランザクションを中断
            if (tx && tx.abort && !tx.done) {
                try { tx.abort(); console.log('DB update transaction aborted due to error.'); }
                catch (abortError) { console.error('Error aborting transaction:', abortError); }
            }
            // 失敗しても、DBに残っている古いデータ（もしあれば）のロードを試みる
            await loadCardsFromDB();
        } finally {
             // 成功失敗に関わらず、ローディングインジケータを非表示にする
             setTimeout(() => { 
                if (dom.loadingIndicator) {
                    dom.loadingIndicator.style.display = 'none'; 
                }
             }, 500); // 0.5秒待ってから消す
        }
    }

    /**
     * IndexedDBから全カードデータをロードして表示
     */
    async function loadCardsFromDB() {
        if (!db) {
            console.error('DB not initialized. Cannot load cards.');
            if (dom.loadingIndicator) {
                dom.loadingIndicator.textContent = 'データベースを開けません。';
            }
            return;
        }
        try {
            allCards = await db.getAll(STORE_CARDS);
            
            if (allCards.length === 0) {
                console.log('No cards found in DB.');
                 // ローディング表示が「オフライン」モードでない場合のみ、テキストを変更
                 if (dom.loadingIndicator && (dom.loadingIndicator.style.display === 'none' || dom.loadingIndicator.textContent.includes('オフライン'))) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                 }
                if (dom.filterOptionsContainer) dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                if (dom.cardListContainer) dom.cardListContainer.innerHTML = '';
            } else {
                console.log(`Loaded ${allCards.length} cards from DB.`);
                if (dom.loadingIndicator) dom.loadingIndicator.style.display = 'none';
                if (dom.mainContent) dom.mainContent.style.display = 'block'; // コンテンツ表示
                
                // ★修正: 依存関係を解決
                populateFilters();
                applyFiltersAndDisplay();
            }
        } catch (error) {
            console.error('Failed to load cards from DB:', error);
            if (dom.loadingIndicator) {
                dom.loadingIndicator.style.display = 'flex';
                dom.loadingIndicator.textContent = 'データの読み込みに失敗しました。';
            }
            allCards = [];
            if (dom.filterOptionsContainer) dom.filterOptionsContainer.innerHTML = '<p>データ読み込みエラー</p>';
            if (dom.cardListContainer) dom.cardListContainer.innerHTML = '<p>データの読み込みに失敗しました。</p>';
        }
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

        // 既に実行中か確認
        if (dom.cacheAllImagesBtn.disabled) return;

        dom.cacheAllImagesBtn.disabled = true;
        dom.cacheAllImagesBtn.textContent = 'キャッシュ実行中...';
        dom.cacheProgressContainer.style.display = 'flex';
        dom.cacheProgressBar.style.width = '0%';
        
        // ★修正: _small.jpg を使わない
        const imageUrls = [...new Set(
            allCards.map(card => {
                if (!card || !card.cardNumber) return null; // cardNumber をチェック
                
                let largeImagePath = card.imagePath;
                if (!largeImagePath) {
                    // imagePath がない場合、cardNumber からパスを生成
                    largeImagePath = getGeneratedImagePath(card.cardNumber);
                }
                
                // パスが 'Cards/' で始まることを確認し、相対パス './' を付与
                return (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;
            }).filter(path => path) // null や undefined を除去
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
            
            // 5並列でダウンロード
            const parallelLimit = 5;
            // キューをコピーして、元の配列を変更しないようにする
            const queue = [...imageUrls]; 
            
            const processQueue = async () => {
                while(queue.length > 0) {
                    const url = queue.shift();
                    if (!url) continue; // URLが空の場合はスキップ

                    try {
                        // 既にキャッシュに存在するか確認
                        const existing = await cache.match(url);
                        if (!existing) {
                            // cache.add() はリクエストとレスポンスの保存を一度に行う
                            // 失敗する可能性があるのでtry...catchで囲む
                            await cache.add(url);
                        }
                    } catch (e) {
                        console.warn(`Failed to cache image: ${url}`, e);
                        errors++;
                        // 1つ失敗しても続行
                    }
                    
                    cachedCount++;
                    // UI更新はメインスレッドで行う方が安全
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
            // 進捗バーを隠す前に少し待つ (完了表示を見せるため)
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
             // window.confirm は使わない
             // confirmed = window.confirm('本当にすべてのデータを削除しますか？\nデータベースと画像キャッシュが消去され、アプリがリロードされます。');
             // 代わりに prompt を使用
             const input = prompt("すべてのデータを削除しますか？ 'yes'と入力してください。");
             confirmed = input && input.toLowerCase() === 'yes';
        } catch (e) {
            console.warn("Prompt failed. Defaulting to 'no'.", e);
            confirmed = false;
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


            // 2. キャッシュストレージ削除 (アプリに関連するものだけ)
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
                        // インストール状態が変わるたびに監視
                        installingWorker.onstatechange = () => {
                            // インストール完了 -> 待機状態(waiting)になった
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // 新しいワーカーがインストール完了し、古いワーカーがまだ制御中の場合
                                // = 新バージョンが待機状態 (waiting) になった
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
            
            // 制御するSWが変わった時 (新しいSWが有効化された時)
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
        dom.dbUpdateNotification.style.display = 'none'; // 再表示のために一度隠す
        
        dom.dbUpdateNotification.style.display = 'flex';
        
        // ★ 修正: イベントリスナーの多重登録を防ぐため、クローンして付け直す
        const oldApplyBtn = dom.dbUpdateApplyBtn;
        const newApplyBtn = oldApplyBtn.cloneNode(true);
        oldApplyBtn.parentNode.replaceChild(newApplyBtn, oldApplyBtn);
        dom.dbUpdateApplyBtn = newApplyBtn;
        
        const oldDismissBtn = dom.dbUpdateDismissBtn;
        const newDismissBtn = oldDismissBtn.cloneNode(true);
        oldDismissBtn.parentNode.replaceChild(newDismissBtn, oldDismissBtn);
        dom.dbUpdateDismissBtn = newDismissBtn;

        // 新しいボタンにイベントリスナーを設定
        newApplyBtn.addEventListener('click', () => {
            dom.dbUpdateNotification.style.display = 'none';
            fetchAndUpdateCardData(serverLastModified);
        }, { once: true });
        
        newDismissBtn.addEventListener('click', () => {
            dom.dbUpdateNotification.style.display = 'none';
        }, { once: true });
    }
    
    /**
     * アプリ本体の更新通知を表示
     */
    function showAppUpdateNotification() {
         // 既存の通知があれば閉じる
        dom.appUpdateNotification.style.display = 'none'; // 再表示のために一度隠す

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
                
                // ★ 修正: controllerchange が発火しなかった場合のフォールバック
                setTimeout(() => {
                    if (!applyHandler.refreshed) { // controllerchange でフラグが立たなかったら
                         console.warn('Controller change event did not fire. Reloading manually.');
                         window.location.reload();
                    }
                }, 3000); // 3秒待つ
            } else {
                 console.warn('Could not find waiting Service Worker to send SKIP_WAITING. Reloading directly...');
                 // SWが見つからない場合は単純にリロード
                 window.location.reload();
            }
        };
        
        applyHandler.refreshed = false; // ★ リフレッシュ検知フラグ
        
        // ★ controllerchange を一度だけ監視し、リロードが実行されたことを記録
        navigator.serviceWorker.addEventListener('controllerchange', () => { applyHandler.refreshed = true; }, { once: true });
        
        // ★ 修正: ボタンの多重登録防止 (クローン)
        const oldApplyBtn = dom.appUpdateApplyBtn;
        const newApplyBtn = oldApplyBtn.cloneNode(true);
        oldApplyBtn.parentNode.replaceChild(newApplyBtn, oldApplyBtn);
        dom.appUpdateApplyBtn = newApplyBtn;
        
        newApplyBtn.addEventListener('click', applyHandler, { once: true });
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
        
        // ★ DOMがキャッシュされる前に呼ばれる可能性に対処
        const toast = dom.messageToast || $('#message-toast');
        const text = dom.messageToastText || $('#message-toast-text');
        const dismissBtn = dom.messageToastDismissBtn || $('#message-toast-dismiss-btn');
        
        if(!toast || !text || !dismissBtn) {
            console.warn(`MessageToast DOM not ready. Message: ${message}`);
            return;
        }

        text.textContent = message;
        
        // ★ 修正: クラスで色分け
        toast.className = `notification-toast ${type}`; // クラスを付け替える
        
        toast.style.display = 'flex';
        
        // 閉じるボタンのハンドラー
        const dismissHandler = () => {
            toast.style.display = 'none';
            dismissBtn.removeEventListener('click', dismissHandler);
            if (showMessageToast.timeoutId) {
                clearTimeout(showMessageToast.timeoutId);
                showMessageToast.timeoutId = null;
            }
        };
        // 古いリスナーを削除してから追加
        dismissBtn.removeEventListener('click', dismissHandler); 
        dismissBtn.addEventListener('click', dismissHandler, { once: true });

        // 5秒後に自動で消すタイマー
        showMessageToast.timeoutId = setTimeout(dismissHandler, 5000);
    }
    // トーストタイマーIDを保持するための静的プロパティ
    showMessageToast.timeoutId = null;


    // === 9. スワイプ・タップ処理 ===
    
    /**
     * ライトボックスでのタッチ開始イベント
     */
    function handleLightboxTouchStart(e) {
        // スワイプが画像上またはフォールバック上から開始されたか確認
        // またはデバッグ情報表示中
        if (e.target === dom.lightboxImage || e.target === dom.lightboxFallback || isDebugInfoVisible) {
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
    function handleLightboxTouchMove(e) {
        if (touchStartX === 0 && touchStartY === 0) return; // スワイプが開始されていない
        touchEndX = e.touches[0].clientX;
        touchEndY = e.touches[0].clientY; // Y座標を更新
    }

    /**
     * ライトボックスでのタッチ終了イベント（スワイプ判定）
     */
    function handleLightboxTouchEnd() {
        if (touchStartX === 0 && touchStartY === 0) return; // スワイプが開始されていなかった

        // デバッグ情報が表示されている場合は、タップで非表示にする
        if (isDebugInfoVisible) {
            // スワイプ（ドラッグ）ではなく、ほぼタップだった場合
            if (Math.abs(touchStartX - touchEndX) < 20 && Math.abs(touchStartY - touchEndY) < 20) {
                // console.log('Hiding debug info via tap.');
                hideDebugInfo();
            }
             // 座標をリセットして終了
            touchStartX = 0;
            touchEndX = 0;
            touchStartY = 0;
            touchEndY = 0;
            return;
        }

        const swipeThreshold = 50; // スワイプと判定する最小移動距離（ピクセル）
        const swipeDistanceX = touchStartX - touchEndX;
        const swipeDistanceY = touchStartY - touchEndY;

        // Y軸のスワイプ（縦スワイプ）がX軸（横スワイプ）より大きいかチェック
        if (Math.abs(swipeDistanceY) > swipeThreshold && Math.abs(swipeDistanceY) > Math.abs(swipeDistanceX)) {
            
            /* --- ★デバッグ機能 (上から下スワイプ) 無効化 ---
            // ユーザーのリクエストにより無効化
            if (swipeDistanceY < -swipeThreshold) { // 上から下
                if (currentLightboxIndex !== -1 && currentFilteredCards[currentLightboxIndex]) {
                    showDebugInfo(currentFilteredCards[currentLightboxIndex]);
                }
            }
            */
            
        }
        // X軸のスワイプ（横スワイプ）がY軸より大きいかチェック
        else if (Math.abs(swipeDistanceX) > swipeThreshold) {
            // 右から左へのスワイプ（次へ）
            if (swipeDistanceX > swipeThreshold) {
                // console.log('Swipe left (next)');
                updateLightboxImage(currentLightboxIndex + 1); // 次のインデックスを渡す
            }
            // 左から右へのスワイプ（前へ）
            else if (swipeDistanceX < -swipeThreshold) {
                // console.log('Swipe right (previous)');
                updateLightboxImage(currentLightboxIndex - 1); // 前のインデックスを渡す
            }
        }
        
        // 座標をリセット
        touchStartX = 0;
        touchEndX = 0;
        touchStartY = 0;
        touchEndY = 0;
    }

    /**
     * ★デバッグ情報をライトボックスのフォールバック要素に表示する
     * (現在は handleTouchEnd で呼び出されないように無効化されています)
     */
    function showDebugInfo(card) {
        /*
        console.log('--- DEBUG CARD JSON ---');
        console.log(card);
        console.log('-------------------------');
        
        // JSONを整形して文字列にする
        const cardJsonString = JSON.stringify(card, null, 2); 
        
        // 既存のライトボックスのフォールバック要素を使って表示する
        dom.lightboxImage.style.display = 'none'; // 画像を隠す
        dom.lightboxFallback.style.display = 'flex'; // テキストエリアを表示
        dom.lightboxFallback.style.textAlign = 'left'; // 左揃えにする
        dom.lightboxFallback.style.padding = '16px';
        dom.lightboxFallback.style.whiteSpace = 'pre-wrap'; // 改行とスペースを保持
        dom.lightboxFallback.style.overflowY = 'auto'; // スクロール可能に
        dom.lightboxFallback.style.fontFamily = 'monospace'; // 等幅フォント
        dom.lightboxFallback.style.fontSize = '12px'; // 小さめ
        dom.lightboxFallback.style.color = '#FFFFFF'; // 見やすいように白文字に
        dom.lightboxFallback.textContent = cardJsonString; // JSON文字列を設定
        
        isDebugInfoVisible = true; // デバッグ表示中フラグを立てる
        
        // トーストで通知
        showMessageToast(`デバッグ情報表示中。タップで戻ります。`, 'info');
        */
    }
    
    /**
     * ★デバッグ情報を非表示にし、画像を再表示する
     */
    function hideDebugInfo() {
        if (!isDebugInfoVisible) return;
        
        resetFallbackStyles(); // スタイルをリセット
        dom.lightboxFallback.style.display = 'none';
        dom.lightboxFallback.textContent = '';
        dom.lightboxImage.style.display = 'block'; // 画像を再表示
        
        // 画像がエラーだった場合に備えて、onerror/onloadを再チェック
        // updateLightboxImageを呼ぶとインデックスチェックで弾かれるので、
        // 単純に現在のカードのsrcを再設定し、エラー状態を再評価する
        if (currentLightboxIndex !== -1 && currentFilteredCards[currentLightboxIndex]) {
             const card = currentFilteredCards[currentLightboxIndex];
             let largeImagePath = card.imagePath;
             if (!largeImagePath) {
                 largeImagePath = getGeneratedImagePath(card.cardNumber);
             }
             const relativeLargePath = (largeImagePath && largeImagePath.startsWith('Cards/')) ? `./${largeImagePath}` : largeImagePath;
             
             if(relativeLargePath && !dom.lightboxImage.src.endsWith(relativeLargePath)) {
                 dom.lightboxImage.src = relativeLargePath;
             }
             
             // srcを設定した後、画像の読み込み状態をチェック
             if ((!dom.lightboxImage.src || dom.lightboxImage.naturalWidth === 0) && relativeLargePath) {
                 // まだ読み込まれていないか、エラーの可能性がある
                 // onerrorハンドラが再トリガーされることを期待するが、
                 // 既にエラーになっている場合は手動でフォールバックに戻す
                 if(dom.lightboxImage.complete && dom.lightboxImage.naturalWidth === 0) {
                     dom.lightboxImage.style.display = 'none';
                     dom.lightboxFallback.style.display = 'flex';
                     dom.lightboxFallback.textContent = card.cardNumber || 'Error';
                 }
             } else if (!relativeLargePath) {
                 dom.lightboxImage.style.display = 'none';
                 dom.lightboxFallback.style.display = 'flex';
                 dom.lightboxFallback.textContent = card.cardNumber || 'No Image';
             }
        }
        
        isDebugInfoVisible = false; // フラグを戻す
    }


    // === 10. イベントリスナー設定 ===
    function setupEventListeners() {
        
        // DOM要素がキャッシュされた後でないと、リスナーを設定できない
        if (!dom.searchBar) {
            console.error('DOM elements not cached. Cannot set event listeners.');
            return;
        }

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
        
        // ★ 修正: 列数切り替えボタンのリスナー
        dom.columnToggleBtn.addEventListener('click', () => {
            let currentColumns = parseInt(localStorage.getItem('gridColumns') || 3, 10);
            currentColumns++;
            if (currentColumns > 5) {
                currentColumns = 1;
            }
            setGridColumns(currentColumns);
        });
        
        // --- フィルタモーダル ---
        dom.closeFilterModalBtn.addEventListener('click', () => {
            dom.filterModal.style.display = 'none';
        });
        // モーダル背景クリックで閉じる
        dom.filterModal.addEventListener('click', (e) => {
             // e.targetがモーダルの背景(.modal-overlay)自身か確認
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
            // リセットは即時反映せず、適用ボタンが押されるまで待つ
        });

        // ★ 修正: フィルタモーダルのタップ判定 (誤タップ防止)
        let filterTapElement = null;
        let filterTapStartY = 0;
        let filterTapMoveY = 0;
    
        dom.filterOptionsContainer.addEventListener('touchstart', (e) => {
            // タップされた要素（<span class="filter-checkbox-ui">など）を記録
            filterTapElement = e.target;
            filterTapStartY = e.touches[0].clientY;
            filterTapMoveY = 0;
        }, { passive: true });
    
        dom.filterOptionsContainer.addEventListener('touchmove', (e) => {
            if (filterTapStartY === 0) return;
            // Y軸の移動距離を計算
            filterTapMoveY = Math.abs(e.touches[0].clientY - filterTapStartY);
        }, { passive: true });
    
        dom.filterOptionsContainer.addEventListener('touchend', (e) => {
            if (filterTapElement && filterTapMoveY < 20) {
                // 20px未満のスクロールは「タップ」とみなす
                const label = filterTapElement.closest('.filter-checkbox-label');
                if (label) {
                    // デフォルトのクリックイベント（ラベルによるチェック）を防ぐ
                    e.preventDefault(); 
                    
                    const input = label.querySelector('input[type="checkbox"]');
                    if (input) {
                        // 手動でチェック状態を反転させる
                        input.checked = !input.checked;
                    }
                }
            }
            // リセット
            filterTapElement = null;
            filterTapStartY = 0;
            filterTapMoveY = 0;
        });
        // --- フィルタタップ修正ここまで ---


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
        
        // ★ 修正: 設定モーダル内の列セレクタリスナーを削除
        
        dom.cacheAllImagesBtn.addEventListener('click', cacheAllImages);
        dom.clearAllDataBtn.addEventListener('click', clearAllData);

        // --- カード一覧 (タップ判定) ---
        dom.cardListContainer.addEventListener('touchstart', (e) => {
            cardListTapElement = e.target;
            cardListTapStartY = e.touches[0].clientY;
            cardListTapMoveY = 0;
        }, { passive: true });

        dom.cardListContainer.addEventListener('touchmove', (e) => {
            if (cardListTapStartY === 0) return;
            cardListTapMoveY = Math.abs(e.touches[0].clientY - cardListTapStartY);
        }, { passive: true });

        dom.cardListContainer.addEventListener('touchend', (e) => {
            if (cardListTapElement && cardListTapMoveY < 20) {
                // タップと判定
                const cardItem = cardListTapElement.closest('.card-item');
                if (cardItem && cardItem.dataset.index) {
                    e.preventDefault(); // デフォルトのクリック動作をキャンセル
                    showLightbox(parseInt(cardItem.dataset.index, 10));
                }
            }
            // リセット
            cardListTapElement = null;
            cardListTapStartY = 0;
            cardListTapMoveY = 0;
        });


        // --- ライトボックス ---
        dom.lightboxCloseBtn.addEventListener('click', () => {
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = ''; // メモリ解放
            dom.lightboxImage.onerror = null;
            currentLightboxIndex = -1; // インデックスをリセット
            isDebugInfoVisible = false; // ★デバッグフラグ
            resetFallbackStyles(); // ★スタイルリセット
        });
        dom.lightboxModal.addEventListener('click', (e) => {
            // スワイプイベントと競合しないよう、閉じるボタン以外はスワイプハンドラに任せる
            if (e.target === dom.lightboxModal) {
                 // ★デバッグ表示中はタップで非表示にする
                 if (isDebugInfoVisible) {
                     // スワイプ中でない（＝タップ）場合のみ
                     if (touchStartX === 0 && touchEndX === 0) {
                         hideDebugInfo();
                     }
                     return; // モーダルは閉じない
                 }
                 
                 // ★修正: スワイプ中でない（＝タップ）場合のみ閉じる
                 if (touchStartX === 0 && touchEndX === 0) { 
                    dom.lightboxModal.style.display = 'none';
                    dom.lightboxImage.src = ''; // メモリ解放
                    dom.lightboxImage.onerror = null;
                    currentLightboxIndex = -1; // インデックスをリセット
                    resetFallbackStyles(); // ★スタイルリセット
                 }
            }
        });

        // ライトボックスのスワイプイベント
        dom.lightboxModal.addEventListener('touchstart', handleLightboxTouchStart, { passive: true });
        dom.lightboxModal.addEventListener('touchmove', handleLightboxTouchMove, { passive: true });
        dom.lightboxModal.addEventListener('touchend', handleLightboxTouchEnd, { passive: true });
    }

    // === 11. アプリ起動 ===
    // 'load' イベントで DOM の準備が完了してから initializeApp を実行
    window.addEventListener('load', initializeApp);

})();

