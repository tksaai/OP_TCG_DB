// OP-TCG DB PWA メインスクリプト

(function() {
    'use strict';

    // === 1. グローバル変数と定数 ===
    const DB_NAME = 'OPCardDB';
    const DB_VERSION = 2;
    const STORE_CARDS = 'cards';
    const STORE_METADATA = 'metadata';
    const CACHE_APP_SHELL = 'app-shell-v1';
    const CACHE_IMAGES = 'card-images-v1';
    const CARDS_JSON_PATH = './cards.json';
    const IMAGE_MANIFEST_PATH = './image-manifest.json';
    const FURIGANA_OVERRIDES_PATH = './furigana-overrides.json';
    const GITHUB_OWNER = 'tksaai';
    const GITHUB_REPO = 'OP_TCG_DB';
    const GITHUB_BRANCH = 'main';
    const GITHUB_TOKEN_STORAGE_KEY = 'githubToken';
    const FURIGANA_EDITOR_VISIBLE_STORAGE_KEY = 'furiganaEditorVisible';
    const LIST_BADGES_VISIBLE_STORAGE_KEY = 'listBadgesVisible';
    const APP_VERSION = '1.2.2'; // バージョン更新
    const SERVICE_WORKER_PATH = './service-worker.js';

    let db;
    let allCards = [];
    let currentFilter = {
        searchMode: 'AND', // デフォルトはAND検索
        colors: [],
        costs: [],
        powers: [],
        counters: [],
        attributes: [],
        types: [],
        rarities: [],
        blocks: [],
        extras: [],
        series: ''
    };
    let swRegistration;

    // --- ライトボックス用 ---
    let currentFilteredCards = [];
    let currentLightboxIndex = -1;
    let currentLightboxVariantIndex = 0;
    let imageManifest = { cards: {} };
    let furiganaOverrides = {};
    let touchStartX = 0;
    let touchEndX = 0;
    let touchStartY = 0;
    let touchEndY = 0;
    let isDebugInfoVisible = false;
    
    // --- カードリスト タップ判定用 ---
    let cardListTapElement = null;
    let cardListTapStartY = 0;
    let cardListTapMoveY = 0;

    // === 2. DOM要素のキャッシュ ===
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);

    let dom = {};

    function toKatakana(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[\u3041-\u3096]/g, function(match) {
            const charCode = match.charCodeAt(0) + 0x60;
            return String.fromCharCode(charCode);
        });
    }

    function toHalfWidth(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[\uFF01-\uFF5E]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) - 0xFEE0);
        });
    }

    // === 3. 初期化処理 ===
    function cacheDomElements() {
        dom = {
            loadingIndicator: $('#loading-indicator'),
            cardListContainer: $('#card-list-container'),
            searchBar: $('#search-bar'),
            clearSearchBtn: $('#clear-search-btn'),
            filterBtn: $('#filter-btn'),
            settingsBtn: $('#settings-btn'),
            mainContent: $('#main-content'),
    
            filterModal: $('#filter-modal'),
            closeFilterModalBtn: $('#close-filter-modal-btn'),
            filterOptionsContainer: $('#filter-options-container'),
            applyFilterBtn: $('#apply-filter-btn'),
            resetFilterBtn: $('#reset-filter-btn'),
    
            settingsModal: $('#settings-modal'),
            closeSettingsModalBtn: $('#close-settings-modal-btn'),
            cacheAllImagesBtn: $('#cache-all-images-btn'),
            clearAllDataBtn: $('#clear-all-data-btn'),
            githubTokenInput: $('#github-token-input'),
            githubTokenSaveBtn: $('#github-token-save-btn'),
            githubTokenClearBtn: $('#github-token-clear-btn'),
            githubTokenStatus: $('#github-token-status'),
            furiganaEditorToggle: $('#furigana-editor-toggle'),
            listBadgesToggle: $('#list-badges-toggle'),
            appVersionInfo: $('#app-version-info'),
            cardDataVersionInfo: $('#card-data-version-info'),
    
            columnToggleBtn: $('#column-toggle-btn'),
            columnCountDisplay: $('#column-count-display'),

            lightboxModal: $('#lightbox-modal'),
            lightboxImage: $('#lightbox-image'),
            lightboxFallback: $('#lightbox-fallback'),
            lightboxCloseBtn: $('#lightbox-close-btn'),
            lightboxInfo: $('#lightbox-info'),
            lightboxTitle: $('#lightbox-title'),
            lightboxSubtitle: $('#lightbox-subtitle'),
            lightboxGetInfo: $('#lightbox-get-info'),
            lightboxFuriganaEditor: $('#lightbox-furigana-editor'),
            lightboxFuriganaInput: $('#lightbox-furigana-input'),
            lightboxFuriganaSaveBtn: $('#lightbox-furigana-save-btn'),
            lightboxFuriganaStatus: $('#lightbox-furigana-status'),
            lightboxVariants: $('#lightbox-variants'),
    
            dbUpdateNotification: $('#db-update-notification'),
            dbUpdateApplyBtn: $('#db-update-apply-btn'),
            dbUpdateDismissBtn: $('#db-update-dismiss-btn'),
            appUpdateNotification: $('#app-update-notification'),
            appUpdateApplyBtn: $('#app-update-apply-btn'),
            messageToast: $('#message-toast'),
            messageToastText: $('#message-toast-text'),
            messageToastDismissBtn: $('#message-toast-dismiss-btn'),
    
            cacheProgressContainer: $('#cache-progress-container'),
            cacheProgressBar: $('#cache-progress-bar'),
            cacheProgressText: $('#cache-progress-text'),
        };
    }

    async function initializeApp() {
        console.log('PWA Initializing...');
        cacheDomElements();
        
        if (dom.appVersionInfo) {
            dom.appVersionInfo.textContent = APP_VERSION;
        } else {
            console.error('DOM cache failed: appVersionInfo is not found.');
            return;
        }

        registerServiceWorker();
        setupEventListeners();
        try {
            await initDB();
            await loadImageManifest();
            await loadFuriganaOverrides();
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

    async function initDB() {
        try {
            db = await idb.openDB(DB_NAME, DB_VERSION, {
                upgrade(db, oldVersion, newVersion, transaction) {
                    if (oldVersion < 2 && db.objectStoreNames.contains(STORE_CARDS)) {
                        try {
                            db.deleteObjectStore(STORE_CARDS);
                        } catch (deleteError) {
                             console.error(`Failed to delete old ${STORE_CARDS} store:`, deleteError);
                             throw deleteError;
                        }
                    }
                    if (!db.objectStoreNames.contains(STORE_CARDS)) {
                         db.createObjectStore(STORE_CARDS, { keyPath: 'cardNumber' });
                    }
                    if (!db.objectStoreNames.contains(STORE_METADATA)) {
                        db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                    }
                },
                blocked() {
                    console.warn('IndexedDB upgrade blocked.');
                },
                blocking() {
                    db.close();
                },
                terminated() {
                     console.error('IndexedDB connection terminated unexpectedly.');
                }
            });
        } catch (error) {
            console.error('Failed to open IndexedDB:', error);
            throw error;
        }
    }

    // === 5. カード一覧表示 ===
    async function loadImageManifest() {
        try {
            const response = await fetch(IMAGE_MANIFEST_PATH, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Failed to fetch image manifest: ${response.status}`);
            const manifest = await response.json();
            imageManifest = manifest && manifest.cards ? manifest : { cards: {} };
        } catch (error) {
            console.warn('Failed to load image manifest. Falling back to generated paths.', error);
            imageManifest = { cards: {} };
        }
    }

    function getOverrideFurigana(cardNumber) {
        const entry = furiganaOverrides?.[cardNumber];
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry.furigana === 'string') return entry.furigana.trim();
        return '';
    }

    function normalizeFuriganaValue(value) {
        return toHalfWidth(toKatakana(value || ''))
            .trim()
            .replace(/\s+/g, '')
            .replace(/[^ァ-ヶーA-Za-z0-9]/g, '');
    }

    function applyFuriganaOverridesToCards() {
        if (!Array.isArray(allCards) || !furiganaOverrides) return;
        allCards.forEach(card => {
            if (!card?.cardNumber) return;
            const override = getOverrideFurigana(card.cardNumber);
            if (override) {
                card.furigana = override;
                card.furiganaSource = 'override';
            }
        });
    }

    async function loadFuriganaOverrides() {
        try {
            const response = await fetch(FURIGANA_OVERRIDES_PATH, { cache: 'no-store' });
            if (response.status === 404) {
                furiganaOverrides = {};
                return;
            }
            if (!response.ok) throw new Error(`Failed to fetch furigana overrides: ${response.status}`);
            const data = await response.json();
            furiganaOverrides = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        } catch (error) {
            console.warn('Failed to load furigana overrides.', error);
            furiganaOverrides = {};
        }
    }

    function getStoredGitHubToken() {
        return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '';
    }

    function setStoredGitHubToken(token) {
        const value = String(token || '').trim();
        if (value) {
            localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, value);
        } else {
            localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
        }
    }

    function isFuriganaEditorVisible() {
        return localStorage.getItem(FURIGANA_EDITOR_VISIBLE_STORAGE_KEY) === 'true';
    }

    function setFuriganaEditorVisible(visible) {
        localStorage.setItem(FURIGANA_EDITOR_VISIBLE_STORAGE_KEY, visible ? 'true' : 'false');
        syncFuriganaEditorVisibility();
    }

    function syncFuriganaEditorVisibility() {
        const visible = isFuriganaEditorVisible();
        if (dom.furiganaEditorToggle) {
            dom.furiganaEditorToggle.checked = visible;
        }
        if (dom.lightboxFuriganaEditor) {
            dom.lightboxFuriganaEditor.style.display = visible ? 'flex' : 'none';
        }
    }

    function areListBadgesVisible() {
        return localStorage.getItem(LIST_BADGES_VISIBLE_STORAGE_KEY) !== 'false';
    }

    function setListBadgesVisible(visible) {
        localStorage.setItem(LIST_BADGES_VISIBLE_STORAGE_KEY, visible ? 'true' : 'false');
        syncListBadgesVisibility();
        if (currentFilteredCards.length > 0) {
            displayCards(currentFilteredCards);
        }
    }

    function syncListBadgesVisibility() {
        if (dom.listBadgesToggle) {
            dom.listBadgesToggle.checked = areListBadgesVisible();
        }
    }

    function syncGitHubTokenSettings() {
        if (!dom.githubTokenInput) return;
        const token = getStoredGitHubToken();
        dom.githubTokenInput.value = token;
        if (dom.githubTokenStatus) {
            dom.githubTokenStatus.textContent = token ? 'GitHub token is saved in this browser.' : 'GitHub token is not saved.';
        }
    }

    function encodeBase64Utf8(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function decodeBase64Utf8(value) {
        const binary = atob(String(value || '').replace(/\s/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    }

    async function fetchGitHubOverrideFile(token) {
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/furigana-overrides.json?ref=${GITHUB_BRANCH}`;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        if (response.status === 404) return { sha: null, data: {} };
        if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);

        const payload = await response.json();
        const text = decodeBase64Utf8(payload.content || '');
        const data = text.trim() ? JSON.parse(text) : {};
        return {
            sha: payload.sha || null,
            data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}
        };
    }

    async function saveFuriganaOverride(card, furigana) {
        const token = getStoredGitHubToken();
        if (!token) throw new Error('GitHub token is not saved.');
        if (!card?.cardNumber) throw new Error('Card number is missing.');

        const normalized = normalizeFuriganaValue(furigana);
        if (!normalized) throw new Error('Furigana is empty.');

        const remote = await fetchGitHubOverrideFile(token);
        const nextData = {
            ...remote.data,
            [card.cardNumber]: {
                cardName: card.cardName || '',
                furigana: normalized,
                source: 'manual',
                updatedAt: new Date().toISOString()
            }
        };
        const body = {
            message: `Update furigana override for ${card.cardNumber}`,
            content: encodeBase64Utf8(`${JSON.stringify(nextData, null, 2)}\n`),
            branch: GITHUB_BRANCH
        };
        if (remote.sha) body.sha = remote.sha;

        const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/furigana-overrides.json`, {
            method: 'PUT',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`GitHub save failed: ${response.status}${errorText ? ` ${errorText}` : ''}`);
        }

        furiganaOverrides = nextData;
        card.furigana = normalized;
        card.furiganaSource = 'override';
        return normalized;
    }

    function toRelativePath(imagePath) {
        if (!imagePath) return '';
        if (/^https?:\/\//i.test(imagePath) || imagePath.startsWith('./')) return imagePath;
        return (imagePath.startsWith('Cards/') || imagePath.startsWith('CardsWebP/')) ? `./${imagePath}` : imagePath;
    }

    function getFallbackImageVariant(cardNumber) {
        if (!cardNumber) return null;
        const parts = cardNumber.split('-');
        if (parts.length < 2) return null;
        return {
            path: `Cards/${parts[0]}/${cardNumber}.jpg`,
            label: '通常',
            variantIndex: 0
        };
    }

    function getCardImageVariants(card) {
        if (!card || !card.cardNumber) return [];
        const manifestVariants = imageManifest.cards?.[card.cardNumber];
        if (Array.isArray(manifestVariants) && manifestVariants.length > 0) {
            return manifestVariants;
        }
        if (card.imagePath) {
            return [{ path: card.imagePath, label: '通常', variantIndex: 0 }];
        }
        const fallback = getFallbackImageVariant(card.cardNumber);
        return fallback ? [fallback] : [];
    }

    function getCardImagePath(card, variantIndex = 0) {
        const variants = getCardImageVariants(card);
        if (variants.length === 0) return '';
        const safeIndex = Math.min(Math.max(variantIndex, 0), variants.length - 1);
        return toRelativePath(variants[safeIndex].path);
    }

    function getCardImageFallbackPath(card, variantIndex = 0) {
        const variants = getCardImageVariants(card);
        if (variants.length === 0) return '';
        const safeIndex = Math.min(Math.max(variantIndex, 0), variants.length - 1);
        const variant = variants[safeIndex];
        return toRelativePath(variant.fallbackPath || variant.path);
    }

    function getRarityLabel(card) {
        return card?.rarity ? String(card.rarity) : '';
    }

    function normalizeCardsData(cardsData) {
        let cardsArray = [];

        if (Array.isArray(cardsData)) {
            cardsArray = cardsData;
        } else if (typeof cardsData === 'object' && cardsData !== null) {
            cardsArray = Object.values(cardsData).flat();
        } else {
            throw new Error("Invalid cards.json format");
        }

        return cardsArray
            .filter(card => card && card.cardNumber)
            .slice()
            .sort((a, b) => String(a.cardNumber).localeCompare(String(b.cardNumber), 'en', { numeric: true }));
    }

    async function hashText(value) {
        if (!window.crypto?.subtle) {
            let hash = 0;
            for (let i = 0; i < value.length; i += 1) {
                hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
            }
            return `fallback-${hash >>> 0}`;
        }

        const bytes = new TextEncoder().encode(value);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    async function hashCardsData(cardsData) {
        return hashText(JSON.stringify(normalizeCardsData(cardsData)));
    }

    function displayCards(cards) {
        const fragment = document.createDocumentFragment();
        
        if (cards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        cards.forEach((card, index) => {
            if (!card || !card.cardNumber) return;

            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';
            cardItem.dataset.index = index;
            
            const img = document.createElement('img');
            img.className = 'card-image';
            
            const variants = getCardImageVariants(card);
            const relativeImagePath = getCardImagePath(card, 0);

            img.src = relativeImagePath; 
            img.alt = card.cardName || card.cardNumber;
            img.loading = 'lazy';
            
            img.onerror = () => {
                const fallback = document.createElement('div');
                fallback.className = 'card-fallback';
                fallback.textContent = card.cardNumber;
                if(cardItem.contains(img)){
                    cardItem.replaceChild(fallback, img);
                } else if (!cardItem.querySelector('.card-fallback')) {
                     cardItem.appendChild(fallback);
                }
            };
            
            if (relativeImagePath) {
                  cardItem.appendChild(img);
            } else {
                 const fallback = document.createElement('div');
                 fallback.className = 'card-fallback';
                 fallback.textContent = card.cardNumber;
                  cardItem.appendChild(fallback);
            }

            if (areListBadgesVisible()) {
                const rarityLabel = getRarityLabel(card);
                if (rarityLabel) {
                    const rarityBadge = document.createElement('span');
                    rarityBadge.className = `card-rarity rarity-${rarityLabel.toLowerCase()}`;
                    rarityBadge.textContent = rarityLabel;
                    cardItem.appendChild(rarityBadge);
                }

                if (variants.length > 1) {
                    const variantBadge = document.createElement('span');
                    variantBadge.className = 'card-variant-count';
                    variantBadge.textContent = `+${variants.length - 1}`;
                    cardItem.appendChild(variantBadge);
                }
            }
             
            fragment.appendChild(cardItem);
        });

        dom.cardListContainer.innerHTML = '';
        dom.cardListContainer.appendChild(fragment);
    }

    function setGridColumns(columns) {
        document.documentElement.style.setProperty('--grid-columns', columns);
        if (dom.columnCountDisplay) {
            dom.columnCountDisplay.textContent = String(columns);
        }
        localStorage.setItem('gridColumns', columns);
    }

    function setDefaultColumnLayout() {
        const savedColumns = localStorage.getItem('gridColumns') || 3;
        setGridColumns(savedColumns);
    }

    function showLightbox(index) {
        if (index < 0 || index >= currentFilteredCards.length) return;
        isDebugInfoVisible = false;
        currentLightboxIndex = -1; 
        currentLightboxVariantIndex = 0;
        dom.lightboxModal.style.display = 'grid';
        updateLightboxImage(index, 0);
    }
    
    function updateLightboxImage(newIndex, variantIndex = 0) {
        if (newIndex < 0 || newIndex >= currentFilteredCards.length) return;
        if (newIndex === currentLightboxIndex && variantIndex === currentLightboxVariantIndex && !isDebugInfoVisible) return;
        
        isDebugInfoVisible = false;
        currentLightboxIndex = newIndex;
        currentLightboxVariantIndex = Math.max(0, variantIndex);
        const card = currentFilteredCards[currentLightboxIndex];

        if (!card || !card.cardNumber) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = 'Error';
             resetFallbackStyles();
             return;
        }

        const variants = getCardImageVariants(card);
        if (currentLightboxVariantIndex >= variants.length) {
            currentLightboxVariantIndex = 0;
        }
        const relativeLargePath = getCardImagePath(card, currentLightboxVariantIndex);
        const fallbackLargePath = getCardImageFallbackPath(card, currentLightboxVariantIndex);

        resetFallbackStyles();
        dom.lightboxFallback.style.display = 'none';
        updateLightboxInfo(card, variants, currentLightboxVariantIndex);

        dom.lightboxImage.style.display = 'block';
        dom.lightboxImage.src = relativeLargePath;

        dom.lightboxImage.onerror = () => {
            if (fallbackLargePath && dom.lightboxImage.src && !dom.lightboxImage.src.endsWith(fallbackLargePath.replace('./', ''))) {
                dom.lightboxImage.src = fallbackLargePath;
                return;
            }
            dom.lightboxImage.style.display = 'none';
            dom.lightboxFallback.style.display = 'flex';
            dom.lightboxFallback.textContent = card.cardNumber || 'Error';
            resetFallbackStyles();
        };

         if (!relativeLargePath) {
             dom.lightboxImage.style.display = 'none';
             dom.lightboxFallback.style.display = 'flex';
             dom.lightboxFallback.textContent = card.cardNumber || 'No Image';
             resetFallbackStyles();
          }

         preloadImage(currentLightboxIndex + 1);
          preloadImage(currentLightboxIndex - 1);
    }

    function updateLightboxInfo(card, variants, activeVariantIndex) {
        if (!dom.lightboxInfo) return;

        dom.lightboxTitle.textContent = `${card.cardNumber} ${card.cardName || ''}`.trim();
        dom.lightboxSubtitle.textContent = [
            getRarityLabel(card),
            card.cardType,
            variants[activeVariantIndex]?.label
        ].filter(Boolean).join(' / ');

        if (dom.lightboxGetInfo) {
            const activeVariant = variants[activeVariantIndex] || {};
            const getInfo = activeVariant.getInfo || card.getInfo || '';
            dom.lightboxGetInfo.textContent = getInfo ? `入手情報: ${getInfo}` : '';
            dom.lightboxGetInfo.style.display = getInfo ? 'block' : 'none';
        }

        if (dom.lightboxFuriganaInput) {
            dom.lightboxFuriganaInput.value = card.furigana || '';
        }
        if (dom.lightboxFuriganaStatus) {
            dom.lightboxFuriganaStatus.textContent = card.furiganaSource === 'override' ? 'Override applied.' : '';
        }
        syncFuriganaEditorVisibility();

        dom.lightboxVariants.innerHTML = '';
        if (variants.length > 1) {
            variants.forEach((variant, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `variant-btn${index === activeVariantIndex ? ' active' : ''}`;
                button.textContent = variant.label || `画像 ${index + 1}`;
                if (variant.getInfo) {
                    button.title = variant.getInfo;
                }
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    updateLightboxImage(currentLightboxIndex, index);
                });
                dom.lightboxVariants.appendChild(button);
            });
        }

        dom.lightboxInfo.style.display = 'flex';
    }
    
    function resetFallbackStyles() {
        dom.lightboxFallback.style.textAlign = 'center';
        dom.lightboxFallback.style.padding = '0';
        dom.lightboxFallback.style.whiteSpace = 'normal';
        dom.lightboxFallback.style.overflowY = 'hidden';
        dom.lightboxFallback.style.fontFamily = 'inherit';
        dom.lightboxFallback.style.fontSize = '1.5rem';
        dom.lightboxFallback.style.color = 'var(--color-text-primary)';
    }
    
    function preloadImage(indexToPreload) {
        if (indexToPreload < 0 || indexToPreload >= currentFilteredCards.length) return;
        const card = currentFilteredCards[indexToPreload];
        if (!card || !card.cardNumber) return;

        const relativeLargePath = getCardImagePath(card, currentLightboxVariantIndex);

        if (relativeLargePath) {
            const img = new Image();
            img.src = relativeLargePath;
        }
    }


    // === 6. 検索・フィルタ (UI) ===

    /**
     * フィルタ条件に基づいてカードを抽出し、表示
     */
    function applyFiltersAndDisplay() {
        if (allCards.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">カードデータが読み込まれていません。</p>';
            return;
        }

        const rawInput = dom.searchBar.value.trim();
        // 全角スペースを半角に変換してから分割
        const rawWords = rawInput.replace(/　/g, ' ').split(' ').filter(w => w.length > 0);
        
        const searchWords = [];
        const excludeWords = [];

        rawWords.forEach(rawWord => {
            let isExclude = false;
            let targetWord = rawWord;

            // マイナス検索判定 (半角ハイフン, 全角ハイフン, 全角マイナスなど)
            if (targetWord.startsWith('-') || targetWord.startsWith('－') || targetWord.startsWith('−')) {
                isExclude = true;
                targetWord = targetWord.substring(1); // 記号を除去
            }

            if (targetWord.length === 0) return;

            // 正規化 (カタカナ, 半角, 大文字)
            targetWord = toKatakana(targetWord);
            targetWord = toHalfWidth(targetWord);
            targetWord = targetWord.toUpperCase();

            if (isExclude) {
                excludeWords.push(targetWord);
            } else {
                searchWords.push(targetWord);
            }
        });
        
        // 検索モード (デフォルトは AND)
        const searchMode = currentFilter.searchMode || 'AND';

        currentFilteredCards = allCards.filter(card => {
            if (!card || !card.cardNumber) return false;

            // テキスト検索
            if (searchWords.length > 0 || excludeWords.length > 0) {
                let searchableText = [
                    card.cardName || '',
                    card.furigana || '',
                    card.effectText || '',
                    (card.features || []).join(' '),
                    card.cardNumber || '',
                    card.trigger || ''
                ].join(' ');
                
                searchableText = toKatakana(searchableText);
                searchableText = toHalfWidth(searchableText);
                searchableText = searchableText.toUpperCase();
                
                // 1. 除外ワードのチェック (いずれか1つでも含まれていたら除外)
                if (excludeWords.length > 0) {
                    if (excludeWords.some(word => searchableText.includes(word))) {
                        return false;
                    }
                }

                // 2. 検索ワードのチェック
                if (searchWords.length > 0) {
                    if (searchMode === 'AND') {
                        // AND検索: すべての単語が含まれているか
                        if (!searchWords.every(word => searchableText.includes(word))) {
                            return false;
                        }
                    } else {
                        // OR検索: いずれかの単語が含まれているか
                        if (!searchWords.some(word => searchableText.includes(word))) {
                            return false;
                        }
                    }
                }
            }

            const f = currentFilter;

            // 色フィルタ (OR)
            if (f.colors?.length > 0) {
                if (!Array.isArray(card.color) || card.color.length === 0) return false;
                if (!f.colors.some(color => card.color.includes(color))) return false;
            }

            // コスト
            if (f.costs?.length > 0) {
                if (card.costLifeType !== 'コスト') return false; 
                
                // コスト値の正規化
                let val = card.costLifeValue;
                if (val === '-' || val === undefined || val === null || val === '') {
                     val = '0';
                } else if (isNaN(Number(val))) {
                     val = '0';
                } else {
                    val = String(val);
                }

                if (!f.costs.includes(val)) {
                     return false;
                }
            }

            // パワー
            if (f.powers?.length > 0) {
                // パワーを持つカードタイプか判定
                const typeStr = String(card.cardType || "");
                const isPowerCard = typeStr.includes("リーダー") || 
                                    typeStr.includes("キャラ") || 
                                    typeStr.toUpperCase().includes("LEADER") || 
                                    typeStr.toUpperCase().includes("CHARACTER");

                if (!isPowerCard) return false;

                let val = card.power;
                if (val === '-' || val === undefined || val === null || val === '') {
                     val = '0';
                } else if (isNaN(Number(val))) {
                     val = '0';
                } else {
                    val = String(val);
                }

                if (!f.powers.includes(val)) {
                    return false;
                }
            }

            // カウンター
            if (f.counters?.length > 0) {
                let cVal = (card.counter === undefined || card.counter === null) ? "-" : String(card.counter);
                if (!f.counters.includes(cVal)) return false;
            }

            // 属性 (Slash対応)
            if (f.attributes?.length > 0) {
                if (!card.attribute) return false;
                const cardAttrs = card.attribute.split('/');
                if (!f.attributes.some(attr => cardAttrs.includes(attr))) return false;
            }

            // 種別
            if (f.types?.length > 0 && !f.types.includes(card.cardType)) return false;
            
            // レアリティ
            if (f.rarities?.length > 0 && !f.rarities.includes(card.rarity)) return false;
            
            // ブロックアイコン
            if (f.blocks?.length > 0) {
                if (card.block === undefined || card.block === null || !f.blocks.includes(String(card.block))) {
                    return false;
                }
            }

            // エクストラフィルタ (AND)
            if (f.extras?.length > 0) {
                for (const extra of f.extras) {
                    if (extra === 'Blocker') {
                        if (!card.effectText || !card.effectText.includes('【ブロッカー】')) return false;
                    } else if (extra === 'Trigger') {
                        if (!card.trigger) return false;
                    } else if (extra === 'Vanilla') {
                        if (card.effectText && card.effectText !== '-') return false;
                    }
                }
            }

            // シリーズ
            if (f.series) {
                 if (!card.cardNumber) return false;
                 if (f.series === 'P') {
                    if (!card.cardNumber.startsWith('P-')) return false;
                 } else {
                    if (!card.cardNumber.startsWith(f.series + '-')) return false;
                 }
            }

            return true;
        });

        displayCards(currentFilteredCards);
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
        const powers = new Set();
        const counters = new Set();
        const attributes = new Set();
        const blocks = new Set();
        
        const seriesSet = new Map();

        allCards.forEach(card => {
            if (!card || !card.cardNumber) return;

            if (Array.isArray(card.color)) card.color.forEach(c => colors.add(c));
            if (card.cardType && card.cardType !== 'ドン!!') types.add(card.cardType); 
            if (card.rarity) rarities.add(card.rarity); 
            
            if (card.costLifeType === 'コスト') {
                let val = card.costLifeValue;
                if (val === '-' || val === undefined || val === null || val === '') {
                    costs.add('0');
                } else if (isNaN(Number(val))) {
                     costs.add('0'); 
                } else {
                    costs.add(String(val));
                }
            }

            const typeStr = String(card.cardType || "");
            const isPowerCard = typeStr.includes("リーダー") || 
                                typeStr.includes("キャラ") || 
                                typeStr.toUpperCase().includes("LEADER") || 
                                typeStr.toUpperCase().includes("CHARACTER");

            if (isPowerCard) {
                let pVal = card.power;
                if (pVal === '-' || pVal === undefined || pVal === null || pVal === '') {
                    powers.add('0');
                } else if (isNaN(Number(pVal))) {
                    powers.add('0');
                } else {
                    powers.add(String(pVal));
                }
            } else if (card.power !== undefined && card.power !== null && card.power !== '-' && !isNaN(Number(card.power))) {
                powers.add(String(card.power));
            }

            if (card.counter !== undefined && card.counter !== null) {
                counters.add(card.counter);
            }

            if (card.attribute && card.attribute !== '-') {
                card.attribute.split('/').forEach(a => attributes.add(a));
            }

            if (card.block !== undefined && card.block !== null) {
                blocks.add(card.block);
            }

            const seriesId = card.cardNumber.split('-')[0];
            if (!seriesId || seriesSet.has(seriesId)) return;
            if (seriesId === 'P') {
                seriesSet.set('P', 'P - プロモカード');
            } else if (card.seriesTitle) {
                seriesSet.set(seriesId, `${seriesId} - ${card.seriesTitle}`);
            } else if (card.series) {
                const seriesParts = card.series.split(' - ');
                const seriesName = seriesParts[1] || card.series;
                seriesSet.set(seriesId, `${seriesId} - ${seriesName}`);
            } else {
                seriesSet.set(seriesId, `${seriesId} - (シリーズ情報なし)`);
            }
        });

        const sortedColors = [...colors].sort();
        const sortedTypes = [...types].sort();
        const rarityOrder = ['L', 'SEC', 'SP', 'SR', 'R', 'UC', 'C', 'P'];
        const sortedRarities = [...rarities].sort((a, b) => {
            const indexA = rarityOrder.indexOf(a);
            const indexB = rarityOrder.indexOf(b);
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        });
        
        const sortedCosts = [...costs].map(v => parseInt(v, 10)).filter(v => !isNaN(v)).sort((a, b) => a - b);
        const sortedPowers = [...powers].map(v => parseInt(v, 10)).filter(v => !isNaN(v)).sort((a, b) => a - b);
        const sortedCounters = [...counters].sort((a, b) => {
            if (a === '-') return -1;
            if (b === '-') return 1;
            return Number(a) - Number(b);
        });
        const sortedAttributes = [...attributes].sort();
        const sortedBlocks = [...blocks].map(Number).sort((a, b) => a - b);

        const seriesEntries = [...seriesSet.entries()];
        const sortedSeries = seriesEntries
            .sort(([idA], [idB]) => {
                if (idA === 'P') return 1;
                if (idB === 'P') return -1;
                return idA.localeCompare(idB, undefined, { numeric: true, sensitivity: 'base' });
            })
            .map(([, name]) => name);

        // HTML生成
        dom.filterOptionsContainer.innerHTML = `
            ${createSearchModeFilter()}
            ${createFilterGroup('colors', '色 (OR)', sortedColors, 'colors')}
            ${createFilterGroup('costs', 'コスト (リーダー除外)', sortedCosts.map(String), 'costs')}
            ${createFilterGroup('powers', 'パワー', sortedPowers.map(String), 'powers')}
            ${createFilterGroup('counters', 'カウンター', sortedCounters.map(String), 'counters')}
            ${createFilterGroup('attributes', '属性', sortedAttributes, 'attributes')}
            ${createFilterGroup('types', '種別', sortedTypes, 'types')}
            ${createFilterGroup('rarities', 'レアリティ', sortedRarities, 'rarities')}
            ${createFilterGroup('blocks', 'ブロック', sortedBlocks.map(String), 'blocks')}
            ${createExtraFilterGroup()}
            ${createSeriesFilter(sortedSeries)}
        `;
    }

    function createSearchModeFilter() {
        return `
            <fieldset class="filter-group">
                <legend>キーワード検索モード</legend>
                <div class="filter-radio-group">
                    <label class="filter-radio-label">
                        <input type="radio" class="filter-radio" name="searchMode" value="AND" checked>
                        <span class="filter-radio-ui">AND (すべて含む)</span>
                    </label>
                    <label class="filter-radio-label">
                        <input type="radio" class="filter-radio" name="searchMode" value="OR">
                        <span class="filter-radio-ui">OR (いずれか)</span>
                    </label>
                </div>
            </fieldset>
        `;
    }

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

    function createExtraFilterGroup() {
        const extras = [
            { value: 'Blocker', label: 'ブロッカー' },
            { value: 'Trigger', label: 'トリガー' },
            { value: 'Vanilla', label: 'バニラ(効果なし)' }
        ];

        const optionsHtml = extras.map(item => `
            <label class="filter-checkbox-label">
                <input type="checkbox" class="filter-checkbox" name="extras" value="${item.value}">
                <span class="filter-checkbox-ui">${item.label}</span>
            </label>
        `).join('');

        return `
            <fieldset class="filter-group">
                <legend>その他</legend>
                <div class="filter-grid types">
                    ${optionsHtml}
                </div>
            </fieldset>
        `;
    }

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

    function readFiltersFromModal() {
        const getCheckedValues = (name) => 
            [...$$(`input[name="${name}"]:checked`)].map(cb => cb.value);

        // ラジオボタンの値取得
        const searchModeInput = $(`input[name="searchMode"]:checked`);
        const searchMode = searchModeInput ? searchModeInput.value : 'AND';

        currentFilter = {
            searchMode: searchMode,
            colors: getCheckedValues('colors'),
            costs: getCheckedValues('costs'),
            powers: getCheckedValues('powers'),
            counters: getCheckedValues('counters'),
            attributes: getCheckedValues('attributes'),
            types: getCheckedValues('types'),
            rarities: getCheckedValues('rarities'),
            blocks: getCheckedValues('blocks'),
            extras: getCheckedValues('extras'),
            series: $('#filter-series')?.value || '',
        };
        console.log('Filters applied:', currentFilter);
    }

    function resetFilters() {
        // チェックボックスのリセット
        $$('.filter-checkbox').forEach(cb => cb.checked = false);
        
        // セレクトボックスのリセット
        const seriesSelect = $('#filter-series');
        if (seriesSelect) seriesSelect.value = '';

        // ラジオボタンをANDに戻す
        const andRadio = $(`input[name="searchMode"][value="AND"]`);
        if (andRadio) andRadio.checked = true;

        currentFilter = { searchMode: 'AND', colors: [], costs: [], powers: [], counters: [], attributes: [], types: [], rarities: [], blocks: [], extras: [], series: '' };
        console.log('Filters reset.');
    }

    // === 新規関数: フィルタモーダルの表示を現在の適用フィルタと同期する ===
    function syncFilterModalWithState() {
        // すべてのチェックボックスを一旦クリア
        $$('.filter-checkbox').forEach(cb => cb.checked = false);

        // currentFilter に基づいてチェックを入れる
        const filterKeys = ['colors', 'costs', 'powers', 'counters', 'attributes', 'types', 'rarities', 'blocks', 'extras'];
        
        filterKeys.forEach(key => {
            if (currentFilter[key] && Array.isArray(currentFilter[key])) {
                currentFilter[key].forEach(val => {
                    const cb = $(`input[name="${key}"][value="${val}"]`);
                    if (cb) cb.checked = true;
                });
            }
        });

        // シリーズ選択
        const seriesSelect = $('#filter-series');
        if (seriesSelect) {
            seriesSelect.value = currentFilter.series || '';
        }

        // 検索モード (ラジオボタン)
        const mode = currentFilter.searchMode || 'AND';
        const radio = $(`input[name="searchMode"][value="${mode}"]`);
        if (radio) radio.checked = true;
    }


    // === 4. データ管理 (DB, JSON) ===
    async function checkCardDataVersion() {
        if (!db) return;

        try {
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });

            if (!response.ok) throw new Error(`Failed to fetch cards.json: ${response.statusText} (${response.status})`);

            const serverLastModified = response.headers.get('Last-Modified');
            const cardsText = await response.text();
            const cardsData = JSON.parse(cardsText);
            const serverHash = await hashCardsData(cardsData);
            const localHashMeta = await db.get(STORE_METADATA, 'cardsContentHash');
            let localHash = localHashMeta ? localHashMeta.value : null;
            const localMetadata = await db.get(STORE_METADATA, 'cardsLastModified');
            const localLastModified = localMetadata ? localMetadata.value : null;

            dom.cardDataVersionInfo.textContent = localLastModified ? new Date(localLastModified).toLocaleString('ja-JP') : '未取得';

            if (!localHash) {
                const localCards = await db.getAll(STORE_CARDS);
                if (localCards.length > 0) {
                    localHash = await hashCardsData(localCards);
                    await db.put(STORE_METADATA, { key: 'cardsContentHash', value: localHash });
                }
            }

            if (serverHash !== localHash) {
                if (!localHash) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
                    await fetchAndUpdateCardData(serverLastModified, cardsData, serverHash);
                } else {
                    showDbUpdateNotification(serverLastModified, cardsData, serverHash);
                    await loadCardsFromDB();
                }
            } else {
                if (serverLastModified && serverLastModified !== localLastModified) {
                    await db.put(STORE_METADATA, { key: 'cardsLastModified', value: serverLastModified });
                    dom.cardDataVersionInfo.textContent = new Date(serverLastModified).toLocaleString('ja-JP');
                }
                await loadCardsFromDB();
                if (allCards.length === 0 && localHash) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'データ整合性を確認中...';
                    await fetchAndUpdateCardData(serverLastModified, cardsData, serverHash);
                }
            }
        } catch (error) {
            console.error('Failed to check card data version:', error);
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = 'オフラインモードで起動中...';
            await loadCardsFromDB();
        }
    }

    async function checkCardDataByFetching() {
        await loadCardsFromDB();
        if (allCards.length === 0) {
            dom.loadingIndicator.style.display = 'flex';
            dom.loadingIndicator.querySelector('p').textContent = '初回カードデータを取得中...';
            await fetchAndUpdateCardData(new Date().toUTCString());
        }
    }

    async function fetchAndUpdateCardData(serverLastModified, prefetchedCardsData = null, prefetchedHash = '') {
        if (!db) return;

        dom.loadingIndicator.style.display = 'flex';
        dom.loadingIndicator.querySelector('p').textContent = '最新カードデータをダウンロード中...';

        let tx;

        try {
            let cardsData = prefetchedCardsData;
            let contentHash = prefetchedHash;
            let responseLastModified = serverLastModified;

            if (!cardsData) {
                const response = await fetch(CARDS_JSON_PATH, { cache: 'no-store' });
                if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText} (${response.status})`);
                responseLastModified = response.headers.get('Last-Modified') || responseLastModified;
                cardsData = await response.json();
            }

            const cardsArray = normalizeCardsData(cardsData);
            if (!contentHash) contentHash = await hashCardsData(cardsData);

            if (cardsArray.length === 0) {
                 throw new Error("Downloaded card data is empty.");
            }

            dom.loadingIndicator.querySelector('p').textContent = 'データベースを更新中...';

            tx = db.transaction([STORE_CARDS, STORE_METADATA], 'readwrite');
            
            const cardStore = tx.objectStore(STORE_CARDS);
            const metaStore = tx.objectStore(STORE_METADATA);
            let count = 0;

            await cardStore.clear();

            for (const card of cardsArray) {
                if (card && card.cardNumber) { 
                    try {
                        await cardStore.put(card);
                        count++;
                    } catch (putError) {
                        console.error(`Failed to put card ${card.cardNumber} into DB:`, putError);
                    }
                }
            }

            await metaStore.put({
                key: 'cardsLastModified',
                value: responseLastModified || new Date().toUTCString()
            });
            await metaStore.put({
                key: 'cardsContentHash',
                value: contentHash
            });
            
            await tx.done;
            
            const savedMeta = await db.get(STORE_METADATA, 'cardsLastModified');
            dom.cardDataVersionInfo.textContent = savedMeta ? new Date(savedMeta.value).toLocaleString('ja-JP') : '更新完了';
            showMessageToast(`カードデータが更新されました (${count}件)。`, 'success');

            await loadCardsFromDB();

        } catch (error) {
            console.error('Failed to update card data:', error);
            dom.loadingIndicator.querySelector('p').textContent = `データ更新に失敗しました: ${error.message}`;
            showMessageToast('データ更新に失敗しました。オフラインデータを表示します。', 'error');
            if (tx && tx.abort && !tx.done) {
                try { tx.abort(); } catch (e) {}
            }
            await loadCardsFromDB();
        } finally {
             setTimeout(() => { 
                if (dom.loadingIndicator) {
                    dom.loadingIndicator.style.display = 'none'; 
                }
             }, 500);
        }
    }

    async function loadCardsFromDB() {
        if (!db) return;
        try {
            allCards = await db.getAll(STORE_CARDS);
            applyFuriganaOverridesToCards();
            
            if (allCards.length === 0) {
                 if (dom.loadingIndicator && (dom.loadingIndicator.style.display === 'none' || dom.loadingIndicator.textContent.includes('オフライン'))) {
                    dom.loadingIndicator.style.display = 'flex';
                    dom.loadingIndicator.querySelector('p').textContent = 'ローカルデータがありません。オンラインでデータを取得してください。';
                 }
                if (dom.filterOptionsContainer) dom.filterOptionsContainer.innerHTML = '<p>データがありません。</p>';
                if (dom.cardListContainer) dom.cardListContainer.innerHTML = '';
            } else {
                if (dom.loadingIndicator) dom.loadingIndicator.style.display = 'none';
                if (dom.mainContent) dom.mainContent.style.display = 'block';
                
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
        }
    }

    // === 7. キャッシュ管理 (UI) ===
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
            allCards
                .flatMap(card => getCardImageVariants(card).flatMap(variant => [
                    toRelativePath(variant.path),
                    toRelativePath(variant.fallbackPath)
                ]))
                .filter(Boolean)
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

    async function clearAllData() {
        let confirmed = false;
        try {
             const input = prompt("すべてのデータを削除しますか？ 'yes'と入力してください。");
             confirmed = input && input.toLowerCase() === 'yes';
        } catch (e) {
            confirmed = false;
        }

        if (!confirmed) return;

        try {
            showMessageToast('全データを削除中...');

            if (db) {
                db.close();
                await idb.deleteDB(DB_NAME);
                db = null;
            } else {
                 await idb.deleteDB(DB_NAME);
            }

            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter(name => name.startsWith('app-shell-') || name.startsWith('card-data-') || name.startsWith('card-images-'))
                    .map(name => caches.delete(name))
            );

            if (swRegistration) {
                await swRegistration.unregister();
                swRegistration = null;
            } else {
                const registration = await navigator.serviceWorker.getRegistration();
                if(registration) {
                    await registration.unregister();
                }
            }
            
            localStorage.clear();

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
    async function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
                swRegistration = registration;

                if (registration.waiting) {
                    showAppUpdateNotification();
                }

                registration.onupdatefound = () => {
                    const installingWorker = registration.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showAppUpdateNotification();
                            }
                        };
                    }
                };

            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
            
            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                 if (refreshing) return;
                 showMessageToast('アプリが更新されました。再読み込みします。', 'success');
                 refreshing = true;
                 setTimeout(() => window.location.reload(), 1500); 
            });
        }
    }

    function showDbUpdateNotification(serverLastModified, cardsData = null, cardsHash = '') {
        dom.dbUpdateNotification.style.display = 'none';
        dom.dbUpdateNotification.style.display = 'flex';
        
        const oldApplyBtn = dom.dbUpdateApplyBtn;
        const newApplyBtn = oldApplyBtn.cloneNode(true);
        oldApplyBtn.parentNode.replaceChild(newApplyBtn, oldApplyBtn);
        dom.dbUpdateApplyBtn = newApplyBtn;
        
        const oldDismissBtn = dom.dbUpdateDismissBtn;
        const newDismissBtn = oldDismissBtn.cloneNode(true);
        oldDismissBtn.parentNode.replaceChild(newDismissBtn, oldDismissBtn);
        dom.dbUpdateDismissBtn = newDismissBtn;

        newApplyBtn.addEventListener('click', () => {
            dom.dbUpdateNotification.style.display = 'none';
            fetchAndUpdateCardData(serverLastModified, cardsData, cardsHash);
        }, { once: true });
        
        newDismissBtn.addEventListener('click', () => {
            dom.dbUpdateNotification.style.display = 'none';
        }, { once: true });
    }
    
    function showAppUpdateNotification() {
        dom.appUpdateNotification.style.display = 'none';
        dom.appUpdateNotification.style.display = 'flex';

         const applyHandler = () => {
            if (swRegistration && swRegistration.waiting) {
                swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
                dom.appUpdateNotification.style.display = 'none';
                showMessageToast('アプリを更新中...');
                
                setTimeout(() => {
                    if (!applyHandler.refreshed) {
                         window.location.reload();
                    }
                }, 3000);
            } else {
                 window.location.reload();
            }
        };
        
        applyHandler.refreshed = false;
        
        navigator.serviceWorker.addEventListener('controllerchange', () => { applyHandler.refreshed = true; }, { once: true });
        
        const oldApplyBtn = dom.appUpdateApplyBtn;
        const newApplyBtn = oldApplyBtn.cloneNode(true);
        oldApplyBtn.parentNode.replaceChild(newApplyBtn, oldApplyBtn);
        dom.appUpdateApplyBtn = newApplyBtn;
        
        newApplyBtn.addEventListener('click', applyHandler, { once: true });
    }

    function showMessageToast(message, type = 'info') {
        if (showMessageToast.timeoutId) {
            clearTimeout(showMessageToast.timeoutId);
        }
        
        const toast = dom.messageToast || $('#message-toast');
        const text = dom.messageToastText || $('#message-toast-text');
        const dismissBtn = dom.messageToastDismissBtn || $('#message-toast-dismiss-btn');
        
        if(!toast || !text || !dismissBtn) return;

        text.textContent = message;
        toast.className = `notification-toast ${type}`;
        toast.style.display = 'flex';
        
        const dismissHandler = () => {
            toast.style.display = 'none';
            dismissBtn.removeEventListener('click', dismissHandler);
            if (showMessageToast.timeoutId) {
                clearTimeout(showMessageToast.timeoutId);
                showMessageToast.timeoutId = null;
            }
        };
        dismissBtn.removeEventListener('click', dismissHandler); 
        dismissBtn.addEventListener('click', dismissHandler, { once: true });

        showMessageToast.timeoutId = setTimeout(dismissHandler, 5000);
    }
    showMessageToast.timeoutId = null;

    // === 9. スワイプ・タップ処理 ===
    
    function handleLightboxTouchStart(e) {
        if (e.target === dom.lightboxImage || e.target === dom.lightboxFallback || isDebugInfoVisible) {
             touchStartX = e.touches[0].clientX;
             touchEndX = touchStartX;
             touchStartY = e.touches[0].clientY;
             touchEndY = touchStartY;
        } else {
             touchStartX = 0;
             touchEndX = 0;
             touchStartY = 0;
             touchEndY = 0;
        }
    }

    function handleLightboxTouchMove(e) {
        if (touchStartX === 0 && touchStartY === 0) return;
        touchEndX = e.touches[0].clientX;
        touchEndY = e.touches[0].clientY;
    }

    function handleLightboxTouchEnd() {
        if (touchStartX === 0 && touchStartY === 0) return;

        if (isDebugInfoVisible) {
            if (Math.abs(touchStartX - touchEndX) < 20 && Math.abs(touchStartY - touchEndY) < 20) {
                hideDebugInfo();
            }
            touchStartX = 0;
            touchEndX = 0;
            touchStartY = 0;
            touchEndY = 0;
            return;
        }

        const swipeThreshold = 50;
        const swipeDistanceX = touchStartX - touchEndX;
        const swipeDistanceY = touchStartY - touchEndY;

        if (Math.abs(swipeDistanceY) > swipeThreshold && Math.abs(swipeDistanceY) > Math.abs(swipeDistanceX)) {
            // 縦スワイプ (現在は機能なし)
        }
        else if (Math.abs(swipeDistanceX) > swipeThreshold) {
            if (swipeDistanceX > swipeThreshold) {
                updateLightboxImage(currentLightboxIndex + 1);
            }
            else if (swipeDistanceX < -swipeThreshold) {
                updateLightboxImage(currentLightboxIndex - 1);
            }
        }
        
        touchStartX = 0;
        touchEndX = 0;
        touchStartY = 0;
        touchEndY = 0;
    }

    function showDebugInfo(card) {
        // デバッグ機能 (必要に応じて実装)
    }
    
    function hideDebugInfo() {
        if (!isDebugInfoVisible) return;
        
        resetFallbackStyles();
        dom.lightboxFallback.style.display = 'none';
        dom.lightboxFallback.textContent = '';
        dom.lightboxImage.style.display = 'block';
        
        if (currentLightboxIndex !== -1 && currentFilteredCards[currentLightboxIndex]) {
              const card = currentFilteredCards[currentLightboxIndex];
             const relativeLargePath = getCardImagePath(card, currentLightboxVariantIndex);
              
             if(relativeLargePath && !dom.lightboxImage.src.endsWith(relativeLargePath)) {
                 dom.lightboxImage.src = relativeLargePath;
             }
             
             if ((!dom.lightboxImage.src || dom.lightboxImage.naturalWidth === 0) && relativeLargePath) {
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
        
        isDebugInfoVisible = false;
    }


    // === 10. イベントリスナー設定 ===
    function setupEventListeners() {
        
        if (!dom.searchBar) return;

        // 検索バー
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

        // フィルタボタン: クリック時に状態同期してから表示
        dom.filterBtn.addEventListener('click', () => {
            syncFilterModalWithState(); // ★ 変更: 現在のフィルタ状態に同期
            dom.filterModal.style.display = 'flex';
        });

        // 設定ボタン
        dom.settingsBtn.addEventListener('click', () => {
            syncGitHubTokenSettings();
            syncFuriganaEditorVisibility();
            syncListBadgesVisibility();
            dom.settingsModal.style.display = 'flex';
        });
        
        // 列数切り替え
        dom.columnToggleBtn.addEventListener('click', () => {
            let currentColumns = parseInt(localStorage.getItem('gridColumns') || 3, 10);
            currentColumns++;
            if (currentColumns > 5) {
                currentColumns = 1;
            }
            setGridColumns(currentColumns);
        });
        
        // フィルタモーダル
        dom.closeFilterModalBtn.addEventListener('click', () => {
            dom.filterModal.style.display = 'none';
        });
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
        });

        // フィルタタップ判定
        let filterTapElement = null;
        let filterTapStartY = 0;
        let filterTapMoveY = 0;
    
        dom.filterOptionsContainer.addEventListener('touchstart', (e) => {
            filterTapElement = e.target;
            filterTapStartY = e.touches[0].clientY;
            filterTapMoveY = 0;
        }, { passive: true });
    
        dom.filterOptionsContainer.addEventListener('touchmove', (e) => {
            if (filterTapStartY === 0) return;
            filterTapMoveY = Math.abs(e.touches[0].clientY - filterTapStartY);
        }, { passive: true });
    
        dom.filterOptionsContainer.addEventListener('touchend', (e) => {
            if (filterTapElement && filterTapMoveY < 20) {
                // ラジオボタンのタップ判定追加
                const radioLabel = filterTapElement.closest('.filter-radio-label');
                if (radioLabel) {
                    const input = radioLabel.querySelector('input[type="radio"]');
                    if (input && !input.checked) {
                        e.preventDefault();
                        input.checked = true;
                        // ラジオボタン変更時は特にアクション不要（適用ボタン待ち）
                    }
                    filterTapElement = null;
                    filterTapStartY = 0;
                    filterTapMoveY = 0;
                    return;
                }

                const label = filterTapElement.closest('.filter-checkbox-label');
                if (label) {
                    e.preventDefault(); 
                    const input = label.querySelector('input[type="checkbox"]');
                    if (input) {
                        input.checked = !input.checked;
                    }
                }
            }
            filterTapElement = null;
            filterTapStartY = 0;
            filterTapMoveY = 0;
        });

        // 設定モーダル
        dom.closeSettingsModalBtn.addEventListener('click', () => {
            dom.settingsModal.style.display = 'none';
        });
        dom.settingsModal.addEventListener('click', (e) => {
             if (e.target === dom.settingsModal) {
                 dom.settingsModal.style.display = 'none';
             }
        });
        
        dom.cacheAllImagesBtn.addEventListener('click', cacheAllImages);
        dom.clearAllDataBtn.addEventListener('click', clearAllData);
        if (dom.githubTokenSaveBtn) {
            dom.githubTokenSaveBtn.addEventListener('click', () => {
                setStoredGitHubToken(dom.githubTokenInput?.value || '');
                syncGitHubTokenSettings();
                showMessageToast('GitHub token saved.', 'success');
            });
        }
        if (dom.githubTokenClearBtn) {
            dom.githubTokenClearBtn.addEventListener('click', () => {
                setStoredGitHubToken('');
                syncGitHubTokenSettings();
                showMessageToast('GitHub token removed.', 'success');
            });
        }
        if (dom.furiganaEditorToggle) {
            dom.furiganaEditorToggle.addEventListener('change', () => {
                setFuriganaEditorVisible(dom.furiganaEditorToggle.checked);
            });
            syncFuriganaEditorVisibility();
        }
        if (dom.listBadgesToggle) {
            dom.listBadgesToggle.addEventListener('change', () => {
                setListBadgesVisible(dom.listBadgesToggle.checked);
            });
            syncListBadgesVisibility();
        }
        if (dom.lightboxFuriganaSaveBtn) {
            dom.lightboxFuriganaSaveBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const card = currentFilteredCards[currentLightboxIndex];
                if (!card) return;
                const button = dom.lightboxFuriganaSaveBtn;
                const originalText = button.textContent;
                button.disabled = true;
                button.textContent = 'Saving...';
                if (dom.lightboxFuriganaStatus) dom.lightboxFuriganaStatus.textContent = '';
                try {
                    const saved = await saveFuriganaOverride(card, dom.lightboxFuriganaInput?.value || '');
                    if (dom.lightboxFuriganaInput) dom.lightboxFuriganaInput.value = saved;
                    if (dom.lightboxFuriganaStatus) dom.lightboxFuriganaStatus.textContent = 'Saved to furigana-overrides.json.';
                    applyFiltersAndDisplay();
                    showMessageToast('Furigana override saved.', 'success');
                } catch (error) {
                    console.error('Failed to save furigana override:', error);
                    if (dom.lightboxFuriganaStatus) dom.lightboxFuriganaStatus.textContent = error.message;
                    showMessageToast('Failed to save furigana override.', 'error');
                } finally {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });
        }

        // カード一覧 (タップ判定)
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
                const cardItem = cardListTapElement.closest('.card-item');
                if (cardItem && cardItem.dataset.index) {
                    e.preventDefault();
                    showLightbox(parseInt(cardItem.dataset.index, 10));
                }
            }
            cardListTapElement = null;
            cardListTapStartY = 0;
            cardListTapMoveY = 0;
        });

        dom.cardListContainer.addEventListener('click', (e) => {
            const cardItem = e.target.closest('.card-item');
            if (!cardItem || !cardItem.dataset.index) return;
            showLightbox(parseInt(cardItem.dataset.index, 10));
        });

        // ライトボックス
        dom.lightboxCloseBtn.addEventListener('click', () => {
            dom.lightboxModal.style.display = 'none';
            dom.lightboxImage.src = '';
            dom.lightboxImage.onerror = null;
            currentLightboxIndex = -1;
            currentLightboxVariantIndex = 0;
            isDebugInfoVisible = false;
            if (dom.lightboxInfo) dom.lightboxInfo.style.display = 'none';
            resetFallbackStyles();
        });
        dom.lightboxModal.addEventListener('click', (e) => {
            if (e.target === dom.lightboxModal) {
                 if (isDebugInfoVisible) {
                     if (touchStartX === 0 && touchEndX === 0) {
                         hideDebugInfo();
                     }
                     return;
                 }
                 
                 if (touchStartX === 0 && touchEndX === 0) { 
                    dom.lightboxModal.style.display = 'none';
                    dom.lightboxImage.src = '';
                    dom.lightboxImage.onerror = null;
                    currentLightboxIndex = -1;
                    currentLightboxVariantIndex = 0;
                    if (dom.lightboxInfo) dom.lightboxInfo.style.display = 'none';
                    resetFallbackStyles();
                  }
            }
        });

        dom.lightboxModal.addEventListener('touchstart', handleLightboxTouchStart, { passive: true });
        dom.lightboxModal.addEventListener('touchmove', handleLightboxTouchMove, { passive: true });
        dom.lightboxModal.addEventListener('touchend', handleLightboxTouchEnd, { passive: true });
    }

    // === 11. アプリ起動 ===
    window.addEventListener('load', initializeApp);

})();
