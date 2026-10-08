// OP-TCG DB PWA メインスクリプト

(function() {
    'use strict';

    // === 1. グローバル変数と定数 ===
    const DB_NAME = 'OPCardDB';
    const DB_VERSION = 4;
    const STORE_CARDS = 'cards';
    const STORE_METADATA = 'metadata';
    const STORE_DECKS = 'decks';
    const STORE_COLLECTION = 'collection';
    const STORE_OPENING_SESSIONS = 'openingSessions';
    const DECK_MAX_CARDS = 50;
    const DECK_MAX_COPIES = 4;
    const DECK_SHARE_VERSION = 1;
    const DECK_SHARE_HASH_KEY = 'deck';
    const DETAILED_ANALYZER_APP_URL = 'https://tksaai.github.io/OP_TCG_DECK_IMAGE_ANALYZER/';
    // GitHub Pages版は #deck= で連携する。将来Python APIを公開した場合だけ設定する。
    const DETAILED_ANALYZER_API_BASE_URL = '';
    const ANALYSIS_HASH_KEY = 'analysis';
    const ANALYSIS_TOKEN_HASH_KEY = 'token';
    const ANALYSIS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ANALYSIS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
    const ANALYSIS_FETCH_TIMEOUT_MS = 15000;
    const ANALYSIS_RESPONSE_MAX_BYTES = 64 * 1024;
    const DETAILED_ANALYSIS_IMPORT_SOURCE = 'detailed-analysis';
    const DECK_EXPORT_FORMAT = 'op-tcg-db-deck';
    const WANTED_CARDS_METADATA_KEY = 'wantedCards';
    const VARIANT_DISPLAY_MODE_STORAGE_KEY = 'variantDisplayMode';
    const COLLECTION_EXPORT_FORMAT = 'op-tcg-db-collection';
    const COLLECTION_EXPORT_VERSION = 1;
    const CARD_LIST_IMAGE_MAX_TYPES = 120;
    const EXPORT_IMAGE_MAX_SCALE = 3;
    const EXPORT_IMAGE_MAX_PIXELS = 14_000_000;
    const EXPORT_IMAGE_MAX_DIMENSION = 8192;
    const CACHE_APP_SHELL = 'app-shell-v1';
    const CACHE_IMAGES = 'card-images-v2';
    const CARDS_JSON_PATH = './cards.json';
    const PROVISIONAL_CARDS_JSON_PATH = './provisional-cards.json';
    const IMAGE_MANIFEST_PATH = './image-manifest.json';
    const BLOCK_ICON_RULES_PATH = './block-icon-overrides.json';
    const FURIGANA_OVERRIDES_PATH = './furigana-overrides.json';
    const GITHUB_OWNER = 'tksaai';
    const GITHUB_REPO = 'OP_TCG_DB';
    const GITHUB_BRANCH = 'main';
    const GITHUB_TOKEN_STORAGE_KEY = 'githubToken';
    const FURIGANA_EDITOR_VISIBLE_STORAGE_KEY = 'furiganaEditorVisible';
    const LIST_BADGES_VISIBLE_STORAGE_KEY = 'listBadgesVisible';
    const STANDARD_REGULATION_BASE_YEAR = 2026;
    const STANDARD_REGULATION_BASE_BLOCK = 2;
    const STANDARD_REGULATION_BLOCK_COUNT = 4;
    const STANDARD_REGULATION_EXTRA_BLOCKS = ['X'];
    const APP_VERSION = '1.13.1'; // バージョン更新
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
    let blockIconRules = { loaded: false, superParallelXCardNumbers: new Set(), blockIconOverrides: {} };
    let cardSeriesIdCache = new Map(); // cardNumber -> Set<正規化済みシリーズID>
    let lastAddedCardSet = new Set(); // 前回のデータ更新で追加されたカード番号
    let provisionalCards = [];
    let provisionalVariantsByNumber = new Map();
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
    let cardListLongPressTimer = null;
    let cardListLongPressed = false;

    // --- デッキ構築 状態管理 ---
    // currentMode: 'view' | 'leader_select' | 'deck_edit' | 'deck_view' | 'collection_edit' | 'opening_edit'
    let currentMode = 'view';
    let viewingDeck = null;    // deck_view で表示中のデッキ
    let editingDeckId = null;
    let editingDeckData = {};   // { cardNumber: count }
    let editingDeckVariantData = {}; // { "cardNumber::variantId": count }
    let editingDeckLeaderVariantId = '';
    let deckParallelSelectionEnabled = false;
    let leaderSelectionPurpose = 'create'; // create | replace
    let editingDeckMeta = {};   // { name, leader, colors: string[], createdAt }
    let cardElementMap = {};    // { cardNumber: HTMLElement } DOM高速アクセス用
    let activeCardView = 'cards'; // 'cards' | 'new'
    let openDeckActionMenu = null;
    let isImportingSharedDeck = false;
    let deckImagePreviewBlob = null;
    let deckImagePreviewUrl = '';
    let deckImagePreviewFilename = '';
    let deckImagePreviewKind = '画像';
    let sharedDeckConfirmationResolve = null;
    let missingCardsDeck = null;
    let missingCardsOwned = {};
    let missingCardsSaveTimer = null;
    let wantedCards = {};
    let wantedSelectionMode = false;
    let wantedShowOnlySelected = false;
    let wantedCardsSaveTimer = null;
    let variantDisplayMode = getStoredVariantDisplayMode();
    let collectionItems = new Map();
    let openingSessions = [];
    let activeOpeningSession = null;
    let openingDraftItems = {};
    let openingDraftDirty = false;
    let openingSessionSaveTimer = null;
    let openingFormSessionId = null;
    let collectionAdjustDirection = 1;
    let collectionShowOnlyOwned = true;
    let collectionWriteQueue = Promise.resolve();
    let openingWriteQueue = Promise.resolve();
    let deckCompositionDeck = null;
    let deckCompositionEditable = false;
    let tournamentRecordsDeck = null;
    let editingTournamentId = null;
    let editingTournamentMatch = null;

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

    function normalizeBlockValue(value) {
        if (value === undefined || value === null) return '';
        const normalized = String(value).trim().toUpperCase();
        if (!normalized || normalized === 'NAN') return '';
        return normalized;
    }

    function compareBlockValues(a, b) {
        const numA = Number(a);
        const numB = Number(b);
        const aIsNumber = Number.isFinite(numA);
        const bIsNumber = Number.isFinite(numB);

        if (aIsNumber && bIsNumber) return numA - numB;
        if (aIsNumber) return -1;
        if (bIsNumber) return 1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }

    function getEffectiveBlockValue(card) {
        if (!card) return '';
        const override = normalizeBlockValue(card.blockIconOverride);
        if (override) return override;

        const variants = getCardImageVariants(card);
        const variantIndex = Number.isInteger(card._displayVariantIndex)
            ? card._displayVariantIndex
            : getVariantIndexForSeries(card, currentFilter.series);
        return normalizeBlockValue(variants[variantIndex]?.block) || normalizeBlockValue(card.block);
    }

    function getCardBlockValues(card) {
        const override = normalizeBlockValue(card?.blockIconOverride);
        if (override) return [override];

        const values = new Set();
        const cardBlock = normalizeBlockValue(card?.block);
        if (cardBlock) values.add(cardBlock);
        getCardImageVariants(card).forEach(variant => {
            const variantBlock = normalizeBlockValue(variant?.block);
            if (variantBlock) values.add(variantBlock);
        });
        return [...values];
    }

    function applyBlockIconRulesToCards(cards) {
        if (!Array.isArray(cards)) return cards;
        const superParallelX = blockIconRules.superParallelXCardNumbers;
        const overrides = blockIconRules.blockIconOverrides;

        cards.forEach(card => {
            const cardNumber = String(card?.cardNumber || '').trim().toUpperCase();
            if (!cardNumber) return;
            const hasXVariant = (imageManifest.cards?.[cardNumber] || [])
                .some(variant => normalizeBlockValue(variant?.block) === 'X');
            const override = superParallelX.has(cardNumber) || hasXVariant
                ? 'X'
                : normalizeBlockValue(overrides[cardNumber]);
            if (override) card.blockIconOverride = override;
            else if (blockIconRules.loaded) delete card.blockIconOverride;
        });
        return cards;
    }

    function getStandardRegulationYear(date = new Date()) {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        return month >= 4 ? year : year - 1;
    }

    function getStandardBlockValues(date = new Date()) {
        const regulationYear = getStandardRegulationYear(date);
        const firstBlock = Math.max(
            1,
            STANDARD_REGULATION_BASE_BLOCK + (regulationYear - STANDARD_REGULATION_BASE_YEAR)
        );
        const numberedBlocks = Array.from(
            { length: STANDARD_REGULATION_BLOCK_COUNT },
            (_, index) => String(firstBlock + index)
        );
        return [...numberedBlocks, ...STANDARD_REGULATION_EXTRA_BLOCKS];
    }

    function getStandardBlockLabel(date = new Date()) {
        const regulationYear = getStandardRegulationYear(date);
        const blocks = getStandardBlockValues(date);
        return `${regulationYear}年度スタンダード: ${blocks.join(', ')}`;
    }

    // === 3. 初期化処理 ===
    function cacheDomElements() {
        dom = {
            loadingIndicator: $('#loading-indicator'),
            cardListContainer: $('#card-list-container'),
            searchBar: $('#search-bar'),
            clearSearchBtn: $('#clear-search-btn'),
            filterBtn: $('#filter-btn'),
            collectionBtn: $('#collection-btn'),
            wantedListBtn: $('#wanted-list-btn'),
            wantedListCount: $('#wanted-list-count'),
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
            refreshAppCacheBtn: $('#refresh-app-cache-btn'),
            clearAllDataBtn: $('#clear-all-data-btn'),
            appDialogModal: $('#app-dialog-modal'),
            appDialogTitle: $('#app-dialog-title'),
            appDialogMessage: $('#app-dialog-message'),
            appDialogInput: $('#app-dialog-input'),
            appDialogConfirmBtn: $('#app-dialog-confirm-btn'),
            appDialogCancelBtn: $('#app-dialog-cancel-btn'),
            githubTokenInput: $('#github-token-input'),
            githubTokenSaveBtn: $('#github-token-save-btn'),
            githubTokenClearBtn: $('#github-token-clear-btn'),
            githubTokenStatus: $('#github-token-status'),
            furiganaEditorToggle: $('#furigana-editor-toggle'),
            listBadgesToggle: $('#list-badges-toggle'),
            appVersionInfo: $('#app-version-info'),
            cardDataVersionInfo: $('#card-data-version-info'),

            sharedDeckConfirmModal: $('#shared-deck-confirm-modal'),
            sharedDeckConfirmCloseBtn: $('#shared-deck-confirm-close-btn'),
            sharedDeckConfirmBody: $('#shared-deck-confirm-body'),
            sharedDeckConfirmName: $('#shared-deck-confirm-name'),
            sharedDeckConfirmLeader: $('#shared-deck-confirm-leader'),
            sharedDeckConfirmCardCount: $('#shared-deck-confirm-card-count'),
            sharedDeckConfirmTypeCount: $('#shared-deck-confirm-type-count'),
            sharedDeckConfirmWarning: $('#shared-deck-confirm-warning'),
            sharedDeckConfirmPreview: $('#shared-deck-confirm-preview'),
            sharedDeckConfirmCancelBtn: $('#shared-deck-confirm-cancel-btn'),
            sharedDeckConfirmAcceptBtn: $('#shared-deck-confirm-accept-btn'),

            sharedDeckUrlModal: $('#shared-deck-url-modal'),
            sharedDeckUrlCloseBtn: $('#shared-deck-url-close-btn'),
            sharedDeckUrlInput: $('#shared-deck-url-input'),
            sharedDeckUrlPasteBtn: $('#shared-deck-url-paste-btn'),
            sharedDeckUrlStatus: $('#shared-deck-url-status'),
            sharedDeckUrlCancelBtn: $('#shared-deck-url-cancel-btn'),
            sharedDeckUrlSubmitBtn: $('#shared-deck-url-submit-btn'),
    
            columnToggleBtn: $('#column-toggle-btn'),
            columnCountDisplay: $('#column-count-display'),

            navCards: $('#nav-cards'),
            navDecks: $('#nav-decks'),
            navNew: $('#nav-new'),
            modeMessageBar: $('#mode-message-bar'),
            deckListView: $('#deck-list-view'),
            deckListContainer: $('#deck-list-container'),
            createNewDeckBtn: $('#create-new-deck-btn'),
            importSharedDeckBtn: $('#import-shared-deck-btn'),
            detailedAnalyzerLink: $('#detailed-analyzer-link'),
            deckStatusBar: $('#deck-status-bar'),
            deckStatusInfo: $('#deck-status-info'),
            deckSaveBtn: $('#deck-save-btn'),
            deckListPreviewBtn: $('#deck-list-preview-btn'),
            deckParallelToggle: $('#deck-parallel-toggle'),
            deckBuilderPanel: $('#deck-builder-panel'),
            deckBuilderMainCount: $('#deck-builder-main-count'),
            deckBuilderMainGrid: $('#deck-builder-main-grid'),
            deckBuilderLeaderGrid: $('#deck-builder-leader-grid'),
            deckChangeLeaderBtn: $('#deck-change-leader-btn'),
            wantedStatusBar: $('#wanted-status-bar'),
            wantedStatusInfo: $('#wanted-status-info'),
            wantedShowToggleBtn: $('#wanted-show-toggle-btn'),
            wantedImageBtn: $('#wanted-image-btn'),
            wantedDoneBtn: $('#wanted-done-btn'),
            collectionStatusBar: $('#collection-status-bar'),
            collectionStatusInfo: $('#collection-status-info'),
            collectionMinusBtn: $('#collection-minus-btn'),
            collectionPlusBtn: $('#collection-plus-btn'),
            collectionOwnedToggleBtn: $('#collection-owned-toggle-btn'),
            collectionImageBtn: $('#collection-image-btn'),
            collectionDoneBtn: $('#collection-done-btn'),

            collectionModal: $('#collection-modal'),
            collectionCloseBtn: $('#collection-close-btn'),
            collectionSummary: $('#collection-summary'),
            collectionViewBtn: $('#collection-view-btn'),
            openingNewBtn: $('#opening-new-btn'),
            collectionExportBtn: $('#collection-export-btn'),
            collectionImportBtn: $('#collection-import-btn'),
            collectionImportInput: $('#collection-import-input'),
            collectionSessionsList: $('#collection-sessions-list'),

            openingFormModal: $('#opening-form-modal'),
            openingFormCloseBtn: $('#opening-form-close-btn'),
            openingFormTitle: $('#opening-form-title'),
            openingNameInput: $('#opening-name-input'),
            openingSeriesSelect: $('#opening-series-select'),
            openingDateInput: $('#opening-date-input'),
            openingBoxCountInput: $('#opening-box-count-input'),
            openingPackCountInput: $('#opening-pack-count-input'),
            openingFormCancelBtn: $('#opening-form-cancel-btn'),
            openingFormSubmitBtn: $('#opening-form-submit-btn'),

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

            deckImagePreviewModal: $('#deck-image-preview-modal'),
            deckImagePreviewTitle: $('#deck-image-preview-title'),
            deckImagePreviewCloseBtn: $('#deck-image-preview-close-btn'),
            deckImagePreviewImage: $('#deck-image-preview-image'),
            deckImagePreviewFilename: $('#deck-image-preview-filename'),
            deckImagePreviewDetails: $('#deck-image-preview-details'),
            deckImagePreviewDownloadBtn: $('#deck-image-preview-download-btn'),
            deckImagePreviewShareBtn: $('#deck-image-preview-share-btn'),

            missingCardsModal: $('#missing-cards-modal'),
            missingCardsCloseBtn: $('#missing-cards-close-btn'),
            missingCardsDeckName: $('#missing-cards-deck-name'),
            missingCardsSummary: $('#missing-cards-summary'),
            missingCardsList: $('#missing-cards-list'),
            missingCardsClearBtn: $('#missing-cards-clear-btn'),
            missingCardsFillBtn: $('#missing-cards-fill-btn'),
            missingCardsCopyBtn: $('#missing-cards-copy-btn'),
            missingCardsImageBtn: $('#missing-cards-image-btn'),
            missingCardsShareBtn: $('#missing-cards-share-btn'),

            deckCompositionModal: $('#deck-composition-modal'),
            deckCompositionCloseBtn: $('#deck-composition-close-btn'),
            deckCompositionDoneBtn: $('#deck-composition-done-btn'),
            deckCompositionName: $('#deck-composition-name'),
            deckCompositionSummary: $('#deck-composition-summary'),
            deckCompositionMainCount: $('#deck-composition-main-count'),
            deckCompositionMainGrid: $('#deck-composition-main-grid'),
            deckCompositionLeaderGrid: $('#deck-composition-leader-grid'),

            tournamentRecordsModal: $('#tournament-records-modal'),
            tournamentRecordsCloseBtn: $('#tournament-records-close-btn'),
            tournamentRecordsDoneBtn: $('#tournament-records-done-btn'),
            tournamentRecordsDeckName: $('#tournament-records-deck-name'),
            tournamentRecordsSummary: $('#tournament-records-summary'),
            tournamentForm: $('#tournament-form'),
            tournamentFormTitle: $('#tournament-form-title'),
            tournamentFormCancelBtn: $('#tournament-form-cancel-btn'),
            tournamentFormSubmitBtn: $('#tournament-form-submit-btn'),
            tournamentNameInput: $('#tournament-name-input'),
            tournamentDateInput: $('#tournament-date-input'),
            tournamentRecordsList: $('#tournament-records-list'),
    
            dbUpdateNotification: $('#db-update-notification'),
            dbUpdateText: $('#db-update-text'),
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

        if (dom.detailedAnalyzerLink) {
            dom.detailedAnalyzerLink.href = DETAILED_ANALYZER_APP_URL;
        }
        
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
            await loadWantedCards();
            await loadImageManifest();
            await loadBlockIconRules();
            await loadFuriganaOverrides();
            await loadProvisionalCards();
            await loadCollectionItems();
        } catch (dbError) {
            console.error("Critical error during DB initialization:", dbError);
            dom.loadingIndicator.textContent = 'データベースの初期化に致命的なエラーが発生しました。';
            return;
        }
        if (db) {
            await checkCardDataVersion();
            await importDeckFromCurrentHash();
        }
        initializeDeckImageImport();
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
                    if (!db.objectStoreNames.contains(STORE_DECKS)) {
                        const deckStore = db.createObjectStore(STORE_DECKS, { keyPath: 'id' });
                        deckStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(STORE_COLLECTION)) {
                        db.createObjectStore(STORE_COLLECTION, { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains(STORE_OPENING_SESSIONS)) {
                        const sessionStore = db.createObjectStore(STORE_OPENING_SESSIONS, { keyPath: 'id' });
                        sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
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
            const response = await fetch(IMAGE_MANIFEST_PATH, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`Failed to fetch image manifest: ${response.status}`);
            const manifest = await response.json();
            imageManifest = manifest && manifest.cards ? manifest : { cards: {} };
        } catch (error) {
            console.warn('Failed to load image manifest. Falling back to generated paths.', error);
            imageManifest = { cards: {} };
        }
        cardSeriesIdCache.clear();
    }

    async function loadBlockIconRules() {
        try {
            const response = await fetch(BLOCK_ICON_RULES_PATH, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`Failed to fetch block icon rules: ${response.status}`);
            const rules = await response.json();
            const configuredX = Array.isArray(rules?.superParallelXCardNumbers)
                ? rules.superParallelXCardNumbers
                : Array.isArray(rules?.legacySuperParallelX) ? rules.legacySuperParallelX : [];
            blockIconRules = {
                loaded: true,
                superParallelXCardNumbers: new Set(
                    configuredX.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
                ),
                blockIconOverrides: rules?.blockIconOverrides && typeof rules.blockIconOverrides === 'object'
                    ? rules.blockIconOverrides
                    : {}
            };
        } catch (error) {
            console.warn('Failed to load block icon rules.', error);
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

    function applyFuriganaOverridesToCards(cards = allCards) {
        if (!Array.isArray(cards) || !furiganaOverrides) return;
        cards.forEach(card => {
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

    function getImageIdentity(value) {
        if (!value) return '';
        try {
            const pathname = new URL(String(value), document.baseURI).pathname;
            return decodeURIComponent(pathname.split('/').pop() || '')
                .replace(/\.(?:webp|png|jpe?g|gif)$/i, '')
                .toLowerCase();
        } catch {
            return String(value)
                .split(/[?#]/)[0]
                .split('/')
                .pop()
                .replace(/\.(?:webp|png|jpe?g|gif)$/i, '')
                .toLowerCase();
        }
    }

    function getVariantImageIdentities(variant) {
        return [variant?.path, variant?.fallbackPath, variant?.sourceUrl]
            .map(getImageIdentity)
            .filter(Boolean);
    }

    function rebuildProvisionalVariants() {
        provisionalVariantsByNumber = new Map();
        const groupedCards = new Map();
        provisionalCards.forEach(card => {
            const cardNumber = String(card?.cardNumber || '').trim();
            const imagePath = card?.imagePath || card?.provisionalImageUrl;
            if (!cardNumber || !imagePath) return;
            const cards = groupedCards.get(cardNumber) || [];
            cards.push(card);
            groupedCards.set(cardNumber, cards);
        });

        groupedCards.forEach((cards, cardNumber) => {
            const officialVariants = Array.isArray(imageManifest.cards?.[cardNumber])
                ? imageManifest.cards[cardNumber]
                : [];
            const usedIdentities = new Set(officialVariants.flatMap(getVariantImageIdentities));
            const usedIndexes = new Set(officialVariants.map((variant, index) => getVariantStableIndex(variant, index)));
            const variants = [];
            let hasPrimaryVariant = officialVariants.length > 0;
            let nextIndex = 1;

            cards.forEach(card => {
                const imagePath = card.imagePath || card.provisionalImageUrl;
                const baseVariant = {
                    source: 'provisional',
                    sourceUrl: card.provisionalImageUrl || '',
                    path: imagePath,
                    fallbackPath: imagePath,
                    label: card.seriesTitle ? `仮DB: ${card.seriesTitle}` : '仮DB画像',
                    getInfo: card.getInfo || '',
                    cardName: card.cardName || '',
                    rarity: card.rarity || '',
                    provisionalUniqueId: card.uniqueId || imagePath
                };
                const identities = getVariantImageIdentities(baseVariant);
                const officialMatchIndex = officialVariants.findIndex(variant => {
                    const officialIdentities = getVariantImageIdentities(variant);
                    return identities.some(identity => officialIdentities.includes(identity));
                });

                if (officialMatchIndex >= 0) {
                    variants.push({
                        ...baseVariant,
                        variantIndex: getVariantStableIndex(officialVariants[officialMatchIndex], officialMatchIndex),
                        isOfficialDuplicate: true
                    });
                    return;
                }

                const isProvisionalDuplicate = identities.some(identity => usedIdentities.has(identity));
                if (isProvisionalDuplicate) {
                    variants.push({
                        ...baseVariant,
                        variantIndex: 0,
                        isOfficialDuplicate: false,
                        isProvisionalDuplicate: true
                    });
                    return;
                }

                let variantIndex = 0;
                if (hasPrimaryVariant) {
                    while (usedIndexes.has(nextIndex)) nextIndex++;
                    variantIndex = nextIndex;
                    usedIndexes.add(nextIndex);
                    nextIndex++;
                } else {
                    hasPrimaryVariant = true;
                    usedIndexes.add(0);
                }
                identities.forEach(identity => usedIdentities.add(identity));
                variants.push({
                    ...baseVariant,
                    variantIndex,
                    isOfficialDuplicate: false,
                    isProvisionalDuplicate: false
                });
            });
            provisionalVariantsByNumber.set(cardNumber, variants);
        });
    }

    function getProvisionalImageVariant(card) {
        if (!card?.cardNumber) return null;
        const variants = provisionalVariantsByNumber.get(card.cardNumber) || [];
        const uniqueId = card.uniqueId || card.imagePath || card.provisionalImageUrl;
        return variants.find(variant => variant.provisionalUniqueId === uniqueId) || null;
    }

    function getCardImageVariants(card) {
        if (!card || !card.cardNumber) return [];
        if (isProvisionalCard(card)) {
            const provisionalVariant = getProvisionalImageVariant(card);
            if (provisionalVariant) return [{ ...provisionalVariant }];
            const imagePath = card.imagePath || card.provisionalImageUrl;
            if (!imagePath) return [];
            return [{
                path: imagePath,
                fallbackPath: imagePath,
                sourceUrl: card.provisionalImageUrl || '',
                label: card.seriesTitle ? `仮DB: ${card.seriesTitle}` : '仮DB画像',
                getInfo: card.getInfo || '',
                variantIndex: 0
            }];
        }
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

    function getStoredVariantDisplayMode() {
        const value = localStorage.getItem(VARIANT_DISPLAY_MODE_STORAGE_KEY);
        return ['representative', 'all', 'alternate'].includes(value) ? value : 'representative';
    }

    function setVariantDisplayMode(value) {
        variantDisplayMode = ['representative', 'all', 'alternate'].includes(value)
            ? value
            : 'representative';
        localStorage.setItem(VARIANT_DISPLAY_MODE_STORAGE_KEY, variantDisplayMode);
    }

    function getVariantStableIndex(variant, arrayIndex = 0) {
        const value = Number(variant?.variantIndex);
        return Number.isInteger(value) && value >= 0 ? value : Math.max(0, Number(arrayIndex) || 0);
    }

    function getCardVariantId(card, variant, arrayIndex = 0) {
        const cardNumber = card?.cardNumber || '';
        const stableIndex = getVariantStableIndex(variant, arrayIndex);
        if (stableIndex >= 1000) return `${cardNumber}_r${stableIndex - 1000}`;
        if (stableIndex > 0) return `${cardNumber}_p${stableIndex}`;
        return cardNumber;
    }

    function getCardVariantType(variant, arrayIndex = 0) {
        const stableIndex = getVariantStableIndex(variant, arrayIndex);
        if (stableIndex >= 1000) return 'alternate-rarity';
        if (stableIndex > 0) return 'alternate-art';
        return 'normal';
    }

    function getVariantTypeLabel(type) {
        if (type === 'alternate-art') return '別イラスト';
        if (type === 'alternate-rarity') return '別レアリティ';
        if (type === 'provisional') return '仮DB画像';
        return '通常';
    }

    function normalizeVariantImagePath(value) {
        const path = String(value || '').trim().replace(/^\.\//, '');
        return /^(?:Cards|CardsWebP)\//.test(path) ? path : '';
    }

    function resolveCardVariantSelection(card, selection = {}) {
        if (!card?.cardNumber) return null;
        const variants = getCardImageVariants(card);
        const requestedPath = normalizeVariantImagePath(selection?.path || selection?.variantPath);
        const requestedIdentity = getImageIdentity(requestedPath);
        const requestedStableIndex = Number(selection?.variantIndex);
        let arrayIndex = -1;

        if (requestedIdentity) {
            arrayIndex = variants.findIndex(variant => (
                getVariantImageIdentities(variant).includes(requestedIdentity)
            ));
        }
        if (arrayIndex < 0 && Number.isInteger(requestedStableIndex) && requestedStableIndex >= 0) {
            arrayIndex = variants.findIndex((variant, index) => (
                getVariantStableIndex(variant, index) === requestedStableIndex
            ));
        }

        if (arrayIndex >= 0) {
            const variant = variants[arrayIndex] || {};
            const type = getCardVariantType(variant, arrayIndex);
            return {
                arrayIndex,
                stableIndex: getVariantStableIndex(variant, arrayIndex),
                path: normalizeVariantImagePath(variant.path || requestedPath),
                sources: [...new Set([
                    getCardImagePath(card, arrayIndex),
                    getCardImageFallbackPath(card, arrayIndex)
                ].filter(Boolean))],
                type,
                label: variant.label || getVariantTypeLabel(type)
            };
        }

        const fallbackStableIndex = Number.isInteger(requestedStableIndex) && requestedStableIndex >= 0
            ? requestedStableIndex
            : 0;
        const isProvisional = requestedPath.includes('/Provisional/');
        const type = isProvisional
            ? 'provisional'
            : fallbackStableIndex >= 1000
                ? 'alternate-rarity'
                : fallbackStableIndex > 0 ? 'alternate-art' : 'normal';
        return {
            arrayIndex: 0,
            stableIndex: fallbackStableIndex,
            path: requestedPath,
            sources: [...new Set([
                toRelativePath(requestedPath),
                getCardImagePath(card, 0),
                getCardImageFallbackPath(card, 0)
            ].filter(Boolean))],
            type,
            label: getVariantTypeLabel(type)
        };
    }

    function getVariantKey(cardNumber, variantId) {
        return `${cardNumber}::${variantId || cardNumber}`;
    }

    function getCardDisplayVariantIndex(card) {
        if (Number.isInteger(card?._displayVariantIndex)) return card._displayVariantIndex;
        return getVariantIndexForSeries(card, currentFilter.series);
    }

    function getCardDisplayVariantKey(card) {
        const variants = getCardImageVariants(card);
        const variantIndex = getCardDisplayVariantIndex(card);
        const variant = variants[variantIndex] || variants[0] || {};
        const variantId = card?._displayVariantId || getCardVariantId(card, variant, variantIndex);
        return getVariantKey(card?.cardNumber || '', variantId);
    }

    function getEffectiveVariantDisplayMode() {
        if (currentMode === 'collection_edit' || currentMode === 'opening_edit') return 'all';
        if (currentMode === 'leader_select') return 'all';
        if (currentMode === 'deck_edit') return deckParallelSelectionEnabled ? 'all' : 'representative';
        if (currentMode !== 'view' || wantedSelectionMode) return 'representative';
        return variantDisplayMode;
    }

    function variantMatchesSeries(card, variant, arrayIndex, seriesId) {
        if (!seriesId) return true;
        const prefix = normalizeSeriesId(card?.cardNumber?.split('-')[0]);
        if (seriesId === 'P') return prefix === 'P';
        const variantSeries = new Set();
        extractSeriesIdsFromText(variant?.getInfo, variantSeries);
        if (variantSeries.size > 0) return variantSeries.has(seriesId);
        return prefix === seriesId;
    }

    function expandCardsForVariantDisplay(cards) {
        const mode = getEffectiveVariantDisplayMode();
        if (mode === 'representative') return cards;

        const expanded = [];
        cards.forEach(card => {
            const variants = getCardImageVariants(card);
            variants.forEach((variant, variantIndex) => {
                const variantType = getCardVariantType(variant, variantIndex);
                if (mode === 'alternate' && variantType !== 'alternate-art') return;
                if (!variantMatchesSeries(card, variant, variantIndex, currentFilter.series)) return;
                expanded.push({
                    ...card,
                    _displayVariantIndex: variantIndex,
                    _displayVariantId: getCardVariantId(card, variant, variantIndex),
                    _displayVariantType: variantType,
                    _displayVariantLabel: variant.label || getVariantTypeLabel(variantType)
                });
            });
        });
        return expanded;
    }

    function normalizeSeriesId(value) {
        return String(value || '').replace(/-/g, '').toUpperCase();
    }

    function extractSeriesIdsFromText(text, target) {
        // 入手情報の「【OP-14】」のような弾コードを抽出する
        for (const match of String(text || '').matchAll(/【([A-Z]+-?\d+)】/g)) {
            target.add(normalizeSeriesId(match[1]));
        }
    }

    // カードが「登場した」シリーズID一覧 (型番の弾 + パラレル等の収録弾)
    function getCardSeriesIds(card) {
        if (!card || !card.cardNumber) return new Set();
        const cached = cardSeriesIdCache.get(card.cardNumber);
        if (cached) return cached;

        const ids = new Set();
        const prefix = card.cardNumber.split('-')[0];
        if (prefix) ids.add(normalizeSeriesId(prefix));
        extractSeriesIdsFromText(card.getInfo, ids);

        const manifestVariants = imageManifest.cards?.[card.cardNumber];
        if (Array.isArray(manifestVariants)) {
            manifestVariants.forEach(variant => extractSeriesIdsFromText(variant.getInfo, ids));
        }

        cardSeriesIdCache.set(card.cardNumber, ids);
        return ids;
    }

    // シリーズフィルタ選択中、そのシリーズで収録されたバリアント画像を優先表示する
    function getVariantIndexForSeries(card, seriesId) {
        if (!card || !card.cardNumber || !seriesId || seriesId === 'P') return 0;
        const prefix = normalizeSeriesId(card.cardNumber.split('-')[0]);
        if (prefix === seriesId) return 0;

        const variants = getCardImageVariants(card);
        for (let i = 0; i < variants.length; i += 1) {
            const codes = new Set();
            extractSeriesIdsFromText(variants[i]?.getInfo, codes);
            if (codes.has(seriesId)) return i;
        }
        return 0;
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

    async function loadProvisionalCards() {
        try {
            const response = await fetch(PROVISIONAL_CARDS_JSON_PATH, { cache: 'no-cache' });
            if (response.status === 404) {
                provisionalCards = [];
                rebuildProvisionalVariants();
                return;
            }
            if (!response.ok) throw new Error(`Failed to fetch provisional cards: ${response.status}`);
            const data = await response.json();
            provisionalCards = normalizeCardsData(Array.isArray(data) ? data : []);
            rebuildProvisionalVariants();
            applyFuriganaOverridesToCards(provisionalCards);
        } catch (error) {
            console.warn('Failed to load provisional cards.', error);
            provisionalCards = [];
            rebuildProvisionalVariants();
        }
    }

    function isProvisionalCard(card) {
        return card?.provisionalSource === 'akihabara-cardshop';
    }

    function getProvisionalCardsForDisplay() {
        const officialCardNumbers = new Set(
            allCards.map(card => String(card?.cardNumber || '').toUpperCase()).filter(Boolean)
        );
        return provisionalCards.filter(card => {
            const cardNumber = String(card?.cardNumber || '').toUpperCase();
            if (!cardNumber || officialCardNumbers.has(cardNumber)) return false;
            const variant = getProvisionalImageVariant(card);
            if (variant) return !variant.isOfficialDuplicate && !variant.isProvisionalDuplicate;
            return true;
        });
    }

    function getDeckCardPool() {
        return normalizeCardsData([...allCards, ...getProvisionalCardsForDisplay()]);
    }

    function getActiveCardSource() {
        if (currentMode === 'view' && activeCardView === 'new') {
            return getProvisionalCardsForDisplay();
        }
        if (['leader_select', 'deck_edit', 'deck_view', 'collection_edit', 'opening_edit'].includes(currentMode)) {
            return getDeckCardPool();
        }
        return allCards;
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

    function ensureEightPackLeader(cardsData) {
        if (!window.OPTCGEightPackLeader?.ensureCard || !Array.isArray(cardsData)) return cardsData;
        return window.OPTCGEightPackLeader.ensureCard(cardsData);
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

    // キーの並び順に依存しない安定した文字列化 (書式変化による更新誤検知を防ぐ)
    function stableStringify(value) {
        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    async function hashCardsData(cardsData) {
        return hashText(stableStringify(normalizeCardsData(cardsData)));
    }

    // サーバーのカードデータとローカルDBを比較し、実質的な差分を求める
    function diffCardsData(serverCards, localCards) {
        const localMap = new Map(
            localCards.filter(c => c && c.cardNumber).map(c => [c.cardNumber, c])
        );
        const added = [];
        const changed = [];
        const serverNumbers = new Set();

        serverCards.forEach(card => {
            serverNumbers.add(card.cardNumber);
            const local = localMap.get(card.cardNumber);
            if (!local) {
                added.push(card.cardNumber);
            } else if (stableStringify(card) !== stableStringify(local)) {
                changed.push(card.cardNumber);
            }
        });

        const removed = [...localMap.keys()].filter(num => !serverNumbers.has(num));
        return { added, changed, removed };
    }

    function formatCardsDiffSummary(diff) {
        if (!diff) return '';
        const parts = [];
        if (diff.added.length > 0) parts.push(`新規${diff.added.length}枚`);
        if (diff.changed.length > 0) parts.push(`修正${diff.changed.length}枚`);
        if (diff.removed.length > 0) parts.push(`削除${diff.removed.length}枚`);
        return parts.join(' / ');
    }

    // 一覧は件数が多い (絵違い展開で 7,000 件超) ため、まとめて DOM を作らず
    // 画面の下端が近づいたぶんだけ描き足す
    const INITIAL_RENDER_COUNT = 120;
    const RENDER_CHUNK_SIZE = 120;
    let renderQueue = [];
    let renderCursor = 0;
    let renderObserver = null;

    function createCardElement(card, index) {
        if (!card || !card.cardNumber) return null;

        const cardItem = document.createElement('div');
        cardItem.className = 'card-item';
        cardItem.dataset.index = index;
        const displayKey = getEffectiveVariantDisplayMode() === 'representative'
            ? card.cardNumber
            : getCardDisplayVariantKey(card);
        cardItem.dataset.id = displayKey;
        cardElementMap[displayKey] = cardItem;
        
        const img = document.createElement('img');
        img.className = 'card-image';
        
        const variants = getCardImageVariants(card);
        const displayVariantIndex = getCardDisplayVariantIndex(card);
        const relativeImagePath = getCardImagePath(card, displayVariantIndex);

        img.src = relativeImagePath;
        img.alt = card.cardName || card.cardNumber;
        img.loading = 'lazy';
        img.decoding = 'async';
        
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

            if (getEffectiveVariantDisplayMode() === 'representative' && variants.length > 1) {
                const variantBadge = document.createElement('span');
                variantBadge.className = 'card-variant-count';
                variantBadge.textContent = `+${variants.length - 1}`;
                cardItem.appendChild(variantBadge);
            }

            if (lastAddedCardSet.has(card.cardNumber) || isProvisionalCard(card)) {
                const newBadge = document.createElement('span');
                newBadge.className = 'card-new-badge';
                newBadge.textContent = 'NEW';
                cardItem.appendChild(newBadge);
            }
        }

        // デッキ編集・表示モード時: 採用枚数バッジ
        const deckDisplayCount = currentMode === 'deck_edit' && deckParallelSelectionEnabled
            ? editingDeckVariantData[displayKey]
            : editingDeckData[card.cardNumber];
        if ((currentMode === 'deck_edit' || currentMode === 'deck_view') && deckDisplayCount) {
            const count = deckDisplayCount;
            const badge = document.createElement('div');
            badge.className = 'card-deck-badge';
            badge.textContent = count;
            badge.dataset.count = count;
            cardItem.appendChild(badge);
        }

        if (wantedSelectionMode && wantedCards[card.cardNumber]) {
            const count = wantedCards[card.cardNumber];
            const badge = document.createElement('div');
            badge.className = 'card-wanted-badge';
            badge.textContent = count;
            badge.dataset.count = count;
            cardItem.appendChild(badge);
        }

        if (currentMode === 'collection_edit' || currentMode === 'opening_edit') {
            const key = getCardDisplayVariantKey(card);
            const count = currentMode === 'opening_edit'
                ? getOpeningDraftCount(key)
                : getCollectionCount(key);
            if (count > 0) {
                const badge = document.createElement('div');
                badge.className = 'card-collection-badge';
                badge.textContent = String(count);
                badge.dataset.count = String(count);
                cardItem.appendChild(badge);
            }
        }

        if (getEffectiveVariantDisplayMode() !== 'representative') {
            const variantBadge = document.createElement('span');
            variantBadge.className = `card-variant-label variant-${card._displayVariantType || 'normal'}`;
            variantBadge.textContent = card._displayVariantLabel || getVariantTypeLabel(card._displayVariantType);
            cardItem.appendChild(variantBadge);
        }

        return cardItem;
    }

    function renderNextChunk(size = RENDER_CHUNK_SIZE) {
        if (renderCursor >= renderQueue.length) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(renderCursor + size, renderQueue.length);
        for (; renderCursor < end; renderCursor++) {
            const element = createCardElement(renderQueue[renderCursor], renderCursor);
            if (element) fragment.appendChild(element);
        }
        const sentinel = document.getElementById('card-render-sentinel');
        if (sentinel) sentinel.remove();
        dom.cardListContainer.appendChild(fragment);
        updateRenderSentinel();
    }

    function updateRenderSentinel() {
        if (renderObserver) renderObserver.disconnect();
        if (renderCursor >= renderQueue.length) return;

        const sentinel = document.createElement('div');
        sentinel.id = 'card-render-sentinel';
        sentinel.className = 'card-render-sentinel';
        dom.cardListContainer.appendChild(sentinel);

        if (!renderObserver) {
            renderObserver = new IntersectionObserver((entries) => {
                if (entries.some(entry => entry.isIntersecting)) renderNextChunk();
            }, { root: dom.mainContent || null, rootMargin: '800px' });
        }
        renderObserver.observe(sentinel);
    }

    function displayCards(cards) {
        cardElementMap = {};
        renderQueue = Array.isArray(cards) ? cards : [];
        renderCursor = 0;
        if (renderObserver) renderObserver.disconnect();

        if (renderQueue.length === 0) {
            dom.cardListContainer.innerHTML = '<p class="no-results">該当するカードがありません。</p>';
            return;
        }

        dom.cardListContainer.innerHTML = '';
        renderNextChunk(INITIAL_RENDER_COUNT);
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
        const initialVariantIndex = getCardDisplayVariantIndex(currentFilteredCards[index]);
        updateLightboxImage(index, initialVariantIndex);
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

        const relativeLargePath = getCardImagePath(card, getCardDisplayVariantIndex(card));

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
        const activeSourceCards = getActiveCardSource();
        if (activeSourceCards.length === 0) {
            dom.cardListContainer.innerHTML = activeCardView === 'new'
                ? '<p class="no-results">仮DBのカードはありません。</p>'
                : '<p class="no-results">カードデータが読み込まれていません。</p>';
            return;
        }
        const sourceCards = expandCardsForVariantDisplay(activeSourceCards);

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

        let filteredCards = sourceCards.filter(card => {
            if (!card || !card.cardNumber) return false;

            if (wantedSelectionMode && wantedShowOnlySelected && !wantedCards[card.cardNumber]) {
                return false;
            }

            // ★ デッキ構築モード別フィルタ
            if (currentMode === 'leader_select') {
                // リーダー選択モード: リーダーのみ表示
                if (card.cardType !== 'LEADER') return false;
            } else if (currentMode === 'deck_edit') {
                // デッキ編集モード: リーダー自体は除外
                if (card.cardType === 'LEADER') return false;
                // 色制限: リーダーの色を1色でも含むカードのみ
                if (Array.isArray(editingDeckMeta.colors) && editingDeckMeta.colors.length > 0) {
                    const cardColors = Array.isArray(card.color) ? card.color : [];
                    if (!cardColors.some(c => editingDeckMeta.colors.includes(c))) return false;
                }
            } else if (currentMode === 'deck_view') {
                // デッキ表示モード: リーダーと採用カードのみ
                const deckCards = viewingDeck?.cards || {};
                if (card.cardNumber !== viewingDeck?.leader && !deckCards[card.cardNumber]) return false;
            }

            // テキスト検索
            if (searchWords.length > 0 || excludeWords.length > 0) {
                let searchableText = [
                    card.cardName || '',
                    card.furigana || '',
                    card.effectText || '',
                    (card.features || []).join(' '),
                    card.cardNumber || '',
                    card.trigger || '',
                    card.seriesTitle || '',
                    card.seriesCode || '',
                    card.getInfo || '',
                    Array.isArray(card.color) ? card.color.join(' ') : (card.color || ''),
                    Array.isArray(card.color) && new Set(card.color).size >= 6 ? '全色' : ''
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
                const cardBlock = getEffectiveBlockValue(card);
                if (!cardBlock || !f.blocks.includes(cardBlock)) {
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
                    } else if (extra === 'Parallel') {
                        if (getCardImageVariants(card).length < 2) return false;
                    } else if (extra === 'NewCards') {
                        if (!lastAddedCardSet.has(card.cardNumber)) return false;
                    }
                }
            }

            // シリーズ (型番の弾に加え、パラレル/SP等でその弾に収録されたカードもヒットさせる)
            if (f.series) {
                 if (!card.cardNumber) return false;
                 if (f.series === 'P') {
                    if (card.cardNumber !== 'P' && !card.cardNumber.startsWith('P-')) return false;
                 } else {
                    if (!getCardSeriesIds(card).has(f.series)) return false;
                 }
            }

            return true;
        });

        // デッキ表示モード: リーダー先頭 → 種別 → コスト → カード番号順に整列
        if (currentMode === 'deck_view' && viewingDeck) {
            const leaderNumber = viewingDeck.leader;
            filteredCards.sort((a, b) => {
                if (a.cardNumber === leaderNumber) return -1;
                if (b.cardNumber === leaderNumber) return 1;
                return compareDeckCards(a, b);
            });
        }

        currentFilteredCards = filteredCards;
        if (currentMode === 'collection_edit' && collectionShowOnlyOwned) {
            currentFilteredCards = currentFilteredCards.filter(card => getCollectionCount(getCardDisplayVariantKey(card)) > 0);
        }

        displayCards(currentFilteredCards);
    }

    /**
     * DBデータからフィルタオプションを動的に生成
     */
    function populateFilters(sourceCards = allCards) {
        if (sourceCards.length === 0) {
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

        sourceCards.forEach(card => {
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

            getCardBlockValues(card).forEach(block => blocks.add(block));

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
        const sortedBlocks = [...blocks].sort(compareBlockValues);

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
            ${createVariantDisplayFilter()}
            ${createFilterGroup('colors', '色 (OR)', sortedColors, 'colors')}
            ${createFilterGroup('costs', 'コスト (リーダー除外)', sortedCosts.map(String), 'costs')}
            ${createFilterGroup('powers', 'パワー', sortedPowers.map(String), 'powers')}
            ${createFilterGroup('counters', 'カウンター', sortedCounters.map(String), 'counters')}
            ${createFilterGroup('attributes', '属性', sortedAttributes, 'attributes')}
            ${createFilterGroup('types', '種別', sortedTypes, 'types')}
            ${createFilterGroup('rarities', 'レアリティ', sortedRarities, 'rarities')}
            ${createBlockFilterGroup(sortedBlocks)}
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

    function createVariantDisplayFilter() {
        return `
            <fieldset class="filter-group">
                <legend>カード画像の表示</legend>
                <div class="filter-radio-group variant-display-options">
                    <label class="filter-radio-label">
                        <input type="radio" class="filter-radio" name="variantDisplayMode" value="representative">
                        <span class="filter-radio-ui">代表画像</span>
                    </label>
                    <label class="filter-radio-label">
                        <input type="radio" class="filter-radio" name="variantDisplayMode" value="all">
                        <span class="filter-radio-ui">通常 + 絵違い</span>
                    </label>
                    <label class="filter-radio-label">
                        <input type="radio" class="filter-radio" name="variantDisplayMode" value="alternate">
                        <span class="filter-radio-ui">絵違いのみ</span>
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

    function createBlockFilterGroup(options) {
        if (options.length === 0) return '';

        const standardBlocks = getStandardBlockValues();
        const standardLabel = getStandardBlockLabel();
        const availableStandardBlocks = standardBlocks.filter(block => options.includes(block));
        const disabled = availableStandardBlocks.length === 0 ? ' disabled' : '';
        const optionsHtml = options.map(option => `
            <label class="filter-checkbox-label">
                <input type="checkbox" class="filter-checkbox" name="blocks" value="${option}">
                <span class="filter-checkbox-ui">${option}</span>
            </label>
        `).join('');

        return `
            <fieldset class="filter-group">
                <legend>ブロック</legend>
                <div class="filter-preset-row">
                    <button type="button" class="filter-preset-btn" data-filter-preset="standard-blocks" data-blocks="${availableStandardBlocks.join(',')}" title="${standardLabel}"${disabled}>スタンダード</button>
                    <button type="button" class="filter-preset-btn" data-filter-preset="clear-blocks">解除</button>
                </div>
                <div class="filter-grid blocks">
                    ${optionsHtml}
                </div>
            </fieldset>
        `;
    }

    function createExtraFilterGroup() {
        const extras = [
            { value: 'Blocker', label: 'ブロッカー' },
            { value: 'Trigger', label: 'トリガー' },
            { value: 'Vanilla', label: 'バニラ(効果なし)' },
            { value: 'Parallel', label: 'パラレル・別イラストあり' }
        ];
        if (lastAddedCardSet.size > 0) {
            extras.push({ value: 'NewCards', label: `新着カード(前回更新の${lastAddedCardSet.size}枚)` });
        }

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
        const variantModeInput = $(`input[name="variantDisplayMode"]:checked`);
        if (variantModeInput && !variantModeInput.disabled) {
            setVariantDisplayMode(variantModeInput.value);
        }

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

        const variantRadio = $(`input[name="variantDisplayMode"][value="${variantDisplayMode}"]`);
        if (variantRadio) variantRadio.checked = true;

        const lockedSeries = currentMode === 'opening_edit' ? (activeOpeningSession?.seriesId || '') : '';
        if (seriesSelect) seriesSelect.value = lockedSeries;
        currentFilter = { searchMode: 'AND', colors: [], costs: [], powers: [], counters: [], attributes: [], types: [], rarities: [], blocks: [], extras: [], series: lockedSeries };
        console.log('Filters reset.');
    }

    function handleFilterPresetClick(event) {
        const button = event.target.closest('[data-filter-preset]');
        if (!button || !dom.filterOptionsContainer?.contains(button)) return;

        const blockCheckboxes = [...$$('input[name="blocks"]')];
        if (button.dataset.filterPreset === 'standard-blocks') {
            const standardBlocks = (button.dataset.blocks || '').split(',').filter(Boolean);
            blockCheckboxes.forEach(cb => {
                cb.checked = standardBlocks.includes(cb.value);
            });
        } else if (button.dataset.filterPreset === 'clear-blocks') {
            blockCheckboxes.forEach(cb => {
                cb.checked = false;
            });
        }
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

        const effectiveVariantMode = getEffectiveVariantDisplayMode();
        const variantModeRadio = $(`input[name="variantDisplayMode"][value="${effectiveVariantMode}"]`);
        if (variantModeRadio) variantModeRadio.checked = true;
        const variantModeLocked = currentMode !== 'view' || wantedSelectionMode;
        $$('input[name="variantDisplayMode"]').forEach(input => {
            input.disabled = variantModeLocked;
        });
    }


    // === 4. データ管理 (DB, JSON) ===
    async function checkCardDataVersion() {
        if (!db) return;

        try {
            const response = await fetch(CARDS_JSON_PATH, { cache: 'no-cache' });

            if (!response.ok) throw new Error(`Failed to fetch cards.json: ${response.statusText} (${response.status})`);

            const serverLastModified = response.headers.get('Last-Modified');
            const cardsText = await response.text();
            const cardsData = JSON.parse(cardsText);
            ensureEightPackLeader(cardsData);
            applyBlockIconRulesToCards(cardsData);
            const serverHash = await hashCardsData(cardsData);
            const localHashMeta = await db.get(STORE_METADATA, 'cardsContentHash');
            let localHash = localHashMeta ? localHashMeta.value : null;
            const localMetadata = await db.get(STORE_METADATA, 'cardsLastModified');
            const localLastModified = localMetadata ? localMetadata.value : null;

            dom.cardDataVersionInfo.textContent = localLastModified ? new Date(localLastModified).toLocaleString('ja-JP') : '未取得';

            if (!localHash) {
                const localCards = await db.getAll(STORE_CARDS);
                if (localCards.length > 0) {
                    ensureEightPackLeader(localCards);
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
                    // カード単位の実差分を確認し、書式・並び順だけの変化なら通知しない
                    const localCards = await db.getAll(STORE_CARDS);
                    ensureEightPackLeader(localCards);
                    const diff = diffCardsData(normalizeCardsData(cardsData), localCards);
                    if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) {
                        await db.put(STORE_METADATA, { key: 'cardsContentHash', value: serverHash });
                        if (serverLastModified) {
                            await db.put(STORE_METADATA, { key: 'cardsLastModified', value: serverLastModified });
                            dom.cardDataVersionInfo.textContent = new Date(serverLastModified).toLocaleString('ja-JP');
                        }
                        await loadCardsFromDB();
                    } else {
                        // 公式カードマスターはユーザーデータと別ストアなので、安全に自動更新する。
                        await fetchAndUpdateCardData(serverLastModified, cardsData, serverHash, diff);
                    }
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

    async function fetchAndUpdateCardData(serverLastModified, prefetchedCardsData = null, prefetchedHash = '', diff = null) {
        if (!db) return;

        dom.loadingIndicator.style.display = 'flex';
        dom.loadingIndicator.querySelector('p').textContent = '最新カードデータをダウンロード中...';

        let tx;

        try {
            let cardsData = prefetchedCardsData;
            let contentHash = prefetchedHash;
            let responseLastModified = serverLastModified;

            if (!cardsData) {
                const response = await fetch(CARDS_JSON_PATH, { cache: 'no-cache' });
                if (!response.ok) throw new Error(`Failed to download cards.json: ${response.statusText} (${response.status})`);
                responseLastModified = response.headers.get('Last-Modified') || responseLastModified;
                cardsData = await response.json();
            }

            ensureEightPackLeader(cardsData);
            applyBlockIconRulesToCards(cardsData);
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
            if (diff && Array.isArray(diff.added)) {
                await metaStore.put({
                    key: 'lastAddedCards',
                    value: { numbers: diff.added, updatedAt: new Date().toISOString() }
                });
            }

            await tx.done;

            const savedMeta = await db.get(STORE_METADATA, 'cardsLastModified');
            dom.cardDataVersionInfo.textContent = savedMeta ? new Date(savedMeta.value).toLocaleString('ja-JP') : '更新完了';
            const diffSummary = formatCardsDiffSummary(diff);
            showMessageToast(`カードデータが更新されました (${diffSummary || `${count}件`})。`, 'success');

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
            ensureEightPackLeader(allCards);
            applyBlockIconRulesToCards(allCards);
            cardSeriesIdCache.clear();
            try {
                const lastAddedMeta = await db.get(STORE_METADATA, 'lastAddedCards');
                const numbers = lastAddedMeta?.value?.numbers;
                lastAddedCardSet = new Set(Array.isArray(numbers) ? numbers : []);
            } catch (metaError) {
                lastAddedCardSet = new Set();
            }
            applyFuriganaOverridesToCards(allCards);
            applyFuriganaOverridesToCards(provisionalCards);
            
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

    // === 6.5. デッキ構築 ===

    function findCardByNumber(cardNumber) {
        if (!cardNumber) return null;
        return allCards.find(card => card?.cardNumber === cardNumber)
            || provisionalCards.find(card => card?.cardNumber === cardNumber)
            || null;
    }

    function createDeckId() {
        return crypto.randomUUID
            ? crypto.randomUUID()
            : `deck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function normalizeDeckName(value, fallback = '共有デッキ') {
        const name = String(value || '')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        return name || fallback;
    }

    function normalizeSharedCardNumber(value) {
        const cardNumber = String(value || '').trim().toUpperCase();
        return cardNumber === 'P' || /^[A-Z0-9]{1,12}-[A-Z0-9]{1,12}$/.test(cardNumber)
            ? cardNumber
            : '';
    }

    function normalizeDeckTransferEntries(entries, leader) {
        if (!Array.isArray(entries)) throw new Error('カード情報の形式が正しくありません。');
        if (entries.length > DECK_MAX_CARDS * 2) throw new Error('カード種類が多すぎます。');

        const cards = {};
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2) {
                throw new Error('カード情報の形式が正しくありません。');
            }
            const cardNumber = normalizeSharedCardNumber(entry[0]);
            const count = Number(entry[1]);
            if (!cardNumber || !Number.isInteger(count) || count < 1 || count > DECK_MAX_COPIES) {
                throw new Error('カード番号または枚数が正しくありません。');
            }
            if (cardNumber === leader) continue;
            cards[cardNumber] = (cards[cardNumber] || 0) + count;
            if (cards[cardNumber] > DECK_MAX_COPIES) {
                throw new Error(`${cardNumber} の枚数が上限を超えています。`);
            }
        }

        const total = Object.values(cards).reduce((sum, count) => sum + count, 0);
        if (total > DECK_MAX_CARDS * DECK_MAX_COPIES) {
            throw new Error('デッキ枚数が多すぎます。');
        }
        return cards;
    }

    function createDeckSharePayload(deck) {
        const leader = normalizeSharedCardNumber(deck?.leader);
        if (!leader) throw new Error('リーダーカードが設定されていません。');
        const cards = normalizeDeckTransferEntries(Object.entries(deck.cards || {}), leader);
        return {
            v: DECK_SHARE_VERSION,
            n: normalizeDeckName(deck.name, 'デッキ'),
            l: leader,
            c: Object.entries(cards).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        };
    }

    function encodeBase64Url(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function decodeBase64Url(value) {
        if (!value || value.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
            throw new Error('共有データの形式が正しくありません。');
        }
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    function createDeckShareUrl(deck) {
        const payload = createDeckSharePayload(deck);
        const url = new URL(window.location.href);
        const hashParams = new URLSearchParams(url.hash.slice(1));
        hashParams.set(DECK_SHARE_HASH_KEY, encodeBase64Url(JSON.stringify(payload)));
        url.hash = hashParams.toString();
        return url.toString();
    }

    function getSharedDeckHashValue() {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        return hashParams.get(DECK_SHARE_HASH_KEY) || '';
    }

    function clearSharedDeckHash() {
        const url = new URL(window.location.href);
        const hashParams = new URLSearchParams(url.hash.slice(1));
        hashParams.delete(DECK_SHARE_HASH_KEY);
        url.hash = hashParams.toString();
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }

    function getDetailedAnalysisHashParams() {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        const hasAnalysisId = hashParams.has(ANALYSIS_HASH_KEY);
        const hasToken = hashParams.has(ANALYSIS_TOKEN_HASH_KEY);
        if (!hasAnalysisId && !hasToken) return null;

        const analysisIds = hashParams.getAll(ANALYSIS_HASH_KEY);
        const tokens = hashParams.getAll(ANALYSIS_TOKEN_HASH_KEY);
        if (!hasAnalysisId || !hasToken || analysisIds.length !== 1 || tokens.length !== 1) {
            throw new Error('詳細解析リンクの形式が正しくありません。');
        }

        const analysisId = String(analysisIds[0] || '').trim().toLowerCase();
        const token = String(tokens[0] || '').trim();
        if (!ANALYSIS_ID_PATTERN.test(analysisId) || !ANALYSIS_TOKEN_PATTERN.test(token)) {
            throw new Error('詳細解析リンクの形式が正しくありません。');
        }
        return { analysisId, token };
    }

    function clearDetailedAnalysisHash() {
        const url = new URL(window.location.href);
        const hashParams = new URLSearchParams(url.hash.slice(1));
        if (!hashParams.has(ANALYSIS_HASH_KEY) && !hashParams.has(ANALYSIS_TOKEN_HASH_KEY)) return;
        hashParams.delete(ANALYSIS_HASH_KEY);
        hashParams.delete(ANALYSIS_TOKEN_HASH_KEY);
        url.hash = hashParams.toString();
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }

    function decodeSharedDeck(value) {
        let payload;
        try {
            payload = JSON.parse(decodeBase64Url(value));
        } catch (error) {
            throw new Error('共有URLのデッキ情報を読み取れませんでした。');
        }
        if (!payload || payload.v !== DECK_SHARE_VERSION) {
            throw new Error('この共有URLの形式には対応していません。');
        }
        const leader = normalizeSharedCardNumber(payload.l);
        if (!leader) throw new Error('共有デッキのリーダー情報が正しくありません。');
        return {
            name: normalizeDeckName(payload.n),
            leader,
            cards: normalizeDeckTransferEntries(payload.c, leader)
        };
    }

    function createDetailedAnalysisError(code, retryAfterSeconds = 0) {
        const error = new Error('Detailed analysis import failed.');
        error.name = 'DetailedAnalysisImportError';
        error.code = code;
        if (retryAfterSeconds > 0) error.retryAfterSeconds = retryAfterSeconds;
        return error;
    }

    function createDetailedAnalysisImportError(status, retryAfter = '') {
        if (status === 404) return createDetailedAnalysisError('link-unavailable');
        if (status === 409) return createDetailedAnalysisError('deck-incomplete');
        if (status === 429) {
            const retryAfterSeconds = /^\d+$/.test(retryAfter)
                ? Math.min(Number(retryAfter), 86400)
                : 0;
            return createDetailedAnalysisError('rate-limited', retryAfterSeconds);
        }
        if (status >= 500) return createDetailedAnalysisError('server-error');
        return createDetailedAnalysisError('request-rejected');
    }

    function getDetailedAnalysisImportMessage(error) {
        if (error?.name === 'AbortError') {
            return '詳細解析結果の取得がタイムアウトしました。解析画面から再発行してください。';
        }
        switch (error?.code) {
            case 'api-not-configured':
                return '詳細画像解析APIはまだ設定されていません。既存の画像解析と共有URLは引き続き利用できます。';
            case 'link-unavailable':
                return 'リンクが無効または期限切れです。解析画面から再発行してください。';
            case 'deck-incomplete':
                return '解析画面でリーダー・枚数を修正してください。';
            case 'rate-limited':
                return error.retryAfterSeconds
                    ? `アクセスが集中しています。${error.retryAfterSeconds}秒後に解析画面から再発行してください。`
                    : 'アクセスが集中しています。時間をおいて解析画面から再発行してください。';
            case 'server-error':
                return '解析APIで問題が発生しました。時間をおいて再度お試しください。';
            case 'response-too-large':
            case 'invalid-response':
            case 'unsupported-version':
            case 'invalid-deck':
                return '詳細解析結果の形式が正しくありません。解析画面から再発行してください。';
            case 'request-rejected':
                return '詳細解析リンクを使用できません。解析画面から再発行してください。';
            default:
                return '解析APIへ接続できませんでした。解析画面から再発行してください。';
        }
    }

    async function readDetailedAnalysisJson(response) {
        const contentLength = response.headers.get('Content-Length');
        if (/^\d+$/.test(contentLength || '') && Number(contentLength) > ANALYSIS_RESPONSE_MAX_BYTES) {
            throw createDetailedAnalysisError('response-too-large');
        }

        let bytes;
        if (response.body?.getReader) {
            const reader = response.body.getReader();
            const chunks = [];
            let totalBytes = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value.byteLength;
                    if (totalBytes > ANALYSIS_RESPONSE_MAX_BYTES) {
                        await reader.cancel();
                        throw createDetailedAnalysisError('response-too-large');
                    }
                    chunks.push(value);
                }
            } finally {
                reader.releaseLock();
            }
            bytes = new Uint8Array(totalBytes);
            let offset = 0;
            chunks.forEach(chunk => {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            });
        } else {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > ANALYSIS_RESPONSE_MAX_BYTES) {
                throw createDetailedAnalysisError('response-too-large');
            }
            bytes = new Uint8Array(buffer);
        }

        try {
            const payload = JSON.parse(new TextDecoder().decode(bytes));
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                throw new Error('Not an object');
            }
            return payload;
        } catch (error) {
            throw createDetailedAnalysisError('invalid-response');
        }
    }

    function normalizeDetailedAnalysisDeck(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw createDetailedAnalysisError('invalid-response');
        }
        if (Object.keys(payload).some(key => !['v', 'n', 'l', 'c'].includes(key))) {
            throw createDetailedAnalysisError('invalid-response');
        }
        if (payload.v !== DECK_SHARE_VERSION) {
            throw createDetailedAnalysisError('unsupported-version');
        }

        const name = typeof payload.n === 'string' ? normalizeDeckName(payload.n, '') : '';
        const leader = normalizeSharedCardNumber(payload.l);
        if (!name || !leader || !Array.isArray(payload.c) || payload.c.length > DECK_MAX_CARDS * 2) {
            throw createDetailedAnalysisError('invalid-deck');
        }
        if (payload.c.some(entry => (
            !Array.isArray(entry)
            || entry.length !== 2
            || typeof entry[0] !== 'string'
            || !Number.isInteger(entry[1])
        ))) {
            throw createDetailedAnalysisError('invalid-deck');
        }

        let cards;
        try {
            cards = normalizeDeckTransferEntries(payload.c, leader);
        } catch (error) {
            throw createDetailedAnalysisError('invalid-deck');
        }
        const total = Object.values(cards).reduce((sum, count) => sum + count, 0);
        if (total !== DECK_MAX_CARDS) throw createDetailedAnalysisError('invalid-deck');

        const leaderCard = findCardByNumber(leader);
        if (leaderCard && leaderCard.cardType !== 'LEADER') {
            throw createDetailedAnalysisError('invalid-deck');
        }
        const unknownCardNumbers = [leader, ...Object.keys(cards)]
            .filter((cardNumber, index, values) => values.indexOf(cardNumber) === index)
            .filter(cardNumber => !findCardByNumber(cardNumber));

        return {
            name,
            leader,
            cards,
            importSource: DETAILED_ANALYSIS_IMPORT_SOURCE,
            unknownCardNumbers
        };
    }

    function revalidateDetailedAnalysisDeck(imported) {
        return normalizeDetailedAnalysisDeck({
            v: DECK_SHARE_VERSION,
            n: imported?.name,
            l: imported?.leader,
            c: Object.entries(imported?.cards || {})
        });
    }

    function resolveSharedDeckImportConfirmation(confirmed) {
        if (dom.sharedDeckConfirmModal) {
            dom.sharedDeckConfirmModal.style.display = 'none';
            dom.sharedDeckConfirmModal.setAttribute('aria-hidden', 'true');
        }
        if (dom.sharedDeckConfirmWarning) {
            dom.sharedDeckConfirmWarning.textContent = '';
            dom.sharedDeckConfirmWarning.hidden = true;
        }
        dom.sharedDeckConfirmPreview?.replaceChildren();
        document.body.classList.remove('shared-deck-confirm-open');
        const resolve = sharedDeckConfirmationResolve;
        sharedDeckConfirmationResolve = null;
        if (resolve) resolve(Boolean(confirmed));
    }

    function createSharedDeckPreviewCard(card, count, isLeader = false) {
        const cardNumber = card?.cardNumber || '?';
        const cardName = card?.cardName || '未登録カード';
        const item = document.createElement('article');
        item.className = `shared-deck-preview-card${isLeader ? ' is-leader' : ''}`;
        item.setAttribute('aria-label', `${cardNumber} ${cardName} ${isLeader ? 'リーダー' : `${count}枚`}`);

        const imageShell = document.createElement('div');
        imageShell.className = 'shared-deck-preview-image-shell';
        const visual = document.createElement('div');
        visual.className = 'shared-deck-preview-visual';
        imageShell.appendChild(visual);

        const sources = card?.cardNumber
            ? [...new Set([
                getCardImagePath(card, 0),
                getCardImageFallbackPath(card, 0)
            ].filter(Boolean))]
            : [];
        const showFallback = () => {
            const fallback = document.createElement('div');
            fallback.className = 'shared-deck-preview-fallback';
            fallback.textContent = cardNumber;
            visual.replaceChildren(fallback);
        };

        if (sources.length > 0) {
            const image = document.createElement('img');
            let sourceIndex = 0;
            image.className = 'shared-deck-preview-image';
            image.alt = cardName === '未登録カード' ? cardNumber : `${cardName} ${cardNumber}`;
            image.loading = 'eager';
            image.decoding = 'async';
            image.onerror = () => {
                sourceIndex += 1;
                if (sourceIndex < sources.length) {
                    image.src = sources[sourceIndex];
                } else {
                    showFallback();
                }
            };
            image.src = sources[sourceIndex];
            visual.appendChild(image);
        } else {
            showFallback();
        }

        const badge = document.createElement('span');
        badge.className = 'shared-deck-preview-count';
        badge.textContent = isLeader ? 'L' : `x${count}`;
        imageShell.appendChild(badge);

        const number = document.createElement('span');
        number.className = 'shared-deck-preview-number';
        number.textContent = cardNumber;
        const name = document.createElement('span');
        name.className = 'shared-deck-preview-card-name';
        name.textContent = cardName;
        name.title = cardName;

        item.appendChild(imageShell);
        item.appendChild(number);
        item.appendChild(name);
        return item;
    }

    function createSharedDeckPreviewGroup(title, entries, isLeader = false) {
        const group = document.createElement('section');
        group.className = `shared-deck-preview-group${isLeader ? ' is-leader' : ''}`;
        const heading = document.createElement('h3');
        heading.className = 'shared-deck-preview-heading';
        heading.textContent = title;
        const grid = document.createElement('div');
        grid.className = 'shared-deck-preview-grid';

        entries.forEach(entry => {
            grid.appendChild(createSharedDeckPreviewCard(entry.card, entry.count, isLeader));
        });
        if (entries.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'shared-deck-preview-empty';
            empty.textContent = 'カードがありません';
            grid.appendChild(empty);
        }

        group.appendChild(heading);
        group.appendChild(grid);
        return group;
    }

    function renderSharedDeckPreview(imported) {
        if (!dom.sharedDeckConfirmPreview) return;
        const leaderCard = findCardByNumber(imported.leader) || {
            cardNumber: imported.leader,
            cardName: '未登録カード'
        };
        const leaderGroup = createSharedDeckPreviewGroup('リーダー', [{ card: leaderCard, count: 1 }], true);
        const deckGroup = createSharedDeckPreviewGroup('デッキ', getDeckImageEntries(imported));
        dom.sharedDeckConfirmPreview.replaceChildren(leaderGroup, deckGroup);
    }

    function getSharedDeckConfirmationWarning(imported) {
        if (imported?.importSource !== DETAILED_ANALYSIS_IMPORT_SOURCE) return '';
        const messages = [
            '詳細画像解析から取り込んだ結果です。内容を確認してから追加してください。'
        ];
        if (Array.isArray(imported.unknownCardNumbers) && imported.unknownCardNumbers.length > 0) {
            messages.push(
                `現在のカードDBに未登録のカードが含まれています: ${imported.unknownCardNumbers.join('、')}`
            );
        }
        return messages.join('\n');
    }

    function confirmSharedDeckImport(imported) {
        const totalCards = Object.values(imported.cards || {})
            .reduce((sum, count) => sum + Number(count || 0), 0);
        const typeCount = Object.keys(imported.cards || {}).length;
        const warning = getSharedDeckConfirmationWarning(imported);

        if (!dom.sharedDeckConfirmModal) {
            return Promise.resolve(window.confirm([
                '共有デッキを追加しますか？',
                '',
                imported.name,
                `リーダー: ${imported.leader}`,
                `カード: ${totalCards}枚 / ${typeCount}種`,
                ...(warning ? ['', warning] : [])
            ].join('\n')));
        }

        if (sharedDeckConfirmationResolve) {
            resolveSharedDeckImportConfirmation(false);
        }
        dom.sharedDeckConfirmName.textContent = imported.name;
        dom.sharedDeckConfirmLeader.textContent = imported.leader;
        dom.sharedDeckConfirmCardCount.textContent = `${totalCards}枚`;
        dom.sharedDeckConfirmTypeCount.textContent = `${typeCount}種`;
        if (dom.sharedDeckConfirmWarning) {
            dom.sharedDeckConfirmWarning.textContent = warning;
            dom.sharedDeckConfirmWarning.hidden = !warning;
        }
        renderSharedDeckPreview(imported);
        dom.sharedDeckConfirmModal.style.display = 'flex';
        dom.sharedDeckConfirmModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('shared-deck-confirm-open');

        return new Promise(resolve => {
            sharedDeckConfirmationResolve = resolve;
            requestAnimationFrame(() => {
                if (dom.sharedDeckConfirmBody) dom.sharedDeckConfirmBody.scrollTop = 0;
                dom.sharedDeckConfirmAcceptBtn?.focus({ preventScroll: true });
            });
        });
    }

    function setSharedDeckUrlStatus(message = '') {
        if (dom.sharedDeckUrlStatus) dom.sharedDeckUrlStatus.textContent = message;
    }

    function openSharedDeckUrlImport() {
        if (!dom.sharedDeckUrlModal || isImportingSharedDeck) return;
        dom.sharedDeckUrlInput.value = '';
        setSharedDeckUrlStatus();
        dom.sharedDeckUrlModal.style.display = 'flex';
        dom.sharedDeckUrlModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('shared-deck-url-open');
        requestAnimationFrame(() => dom.sharedDeckUrlInput?.focus());
    }

    function closeSharedDeckUrlImport() {
        if (!dom.sharedDeckUrlModal) return;
        dom.sharedDeckUrlModal.style.display = 'none';
        dom.sharedDeckUrlModal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('shared-deck-url-open');
        setSharedDeckUrlStatus();
    }

    async function pasteSharedDeckUrl() {
        if (!dom.sharedDeckUrlInput) return;
        try {
            if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
                throw new Error('クリップボードを読み取れません。入力欄を長押しして貼り付けてください。');
            }
            const clipboardText = await navigator.clipboard.readText();
            if (!clipboardText.trim()) throw new Error('クリップボードにテキストがありません。');
            dom.sharedDeckUrlInput.value = clipboardText.trim();
            setSharedDeckUrlStatus();
            dom.sharedDeckUrlInput.focus();
        } catch (error) {
            setSharedDeckUrlStatus(error.message || '共有URLを貼り付けられませんでした。');
            dom.sharedDeckUrlInput.focus();
        }
    }

    function extractSharedDeckHashValue(text) {
        const input = String(text || '').trim();
        if (!input || input.length > 20000) {
            throw new Error('共有URLを入力してください。');
        }

        const candidates = [input, ...(input.match(/https?:\/\/[^\s<>"']+/gi) || [])];
        for (const candidate of [...new Set(candidates)]) {
            try {
                const cleanCandidate = candidate.replace(/[\])}>,.!?、。）」』】]+$/g, '');
                const url = new URL(cleanCandidate, window.location.href);
                const encodedDeck = new URLSearchParams(url.hash.slice(1)).get(DECK_SHARE_HASH_KEY);
                if (encodedDeck) return encodedDeck;
            } catch (error) {
                // Continue searching when shared text contains a label before the URL.
            }
        }
        throw new Error('共有デッキURLを確認できませんでした。');
    }

    async function getUniqueDeckName(baseName) {
        const normalizedBase = normalizeDeckName(baseName);
        const decks = await db.getAll(STORE_DECKS);
        const existingNames = new Set(decks.map(deck => deck.name));
        if (!existingNames.has(normalizedBase)) return normalizedBase;

        const sharedBase = `${normalizedBase} (共有)`;
        if (!existingNames.has(sharedBase)) return sharedBase;
        let suffix = 2;
        while (existingNames.has(`${sharedBase} ${suffix}`)) suffix += 1;
        return `${sharedBase} ${suffix}`;
    }

    async function saveImportedSharedDeck(imported) {
        const deck = await createImportedDeck(imported);
        setActiveNav('decks');
        startDeckView(deck);
        showMessageToast(`共有デッキ「${deck.name}」を追加しました。`, 'success');
        return true;
    }

    async function createImportedDeck(imported) {
        const now = new Date().toISOString();
        const deck = {
            id: createDeckId(),
            name: await getUniqueDeckName(imported.name),
            leader: imported.leader,
            cards: normalizeDeckTransferEntries(Object.entries(imported.cards || {}), imported.leader),
            ownedCards: {},
            ownedCardsLinked: true,
            tournaments: [],
            createdAt: now,
            updatedAt: now
        };
        await saveDeck(deck);
        return deck;
    }

    function normalizeImageImportSearchText(value) {
        return toHalfWidth(toKatakana(String(value || ''))).toUpperCase();
    }

    function searchCardsForImageImport(query = '', role = 'deck') {
        const words = String(query || '')
            .replace(/　/g, ' ')
            .split(/\s+/)
            .map(normalizeImageImportSearchText)
            .filter(Boolean);
        const uniqueCards = new Map();
        getDeckCardPool().forEach(card => {
            if (!card?.cardNumber || uniqueCards.has(card.cardNumber)) return;
            const isLeader = card.cardType === 'LEADER';
            if ((role === 'leader' && !isLeader) || (role !== 'leader' && isLeader)) return;
            const searchable = normalizeImageImportSearchText([
                card.cardNumber,
                card.cardName,
                card.furigana,
                ...(Array.isArray(card.features) ? card.features : [])
            ].filter(Boolean).join(' '));
            if (words.every(word => searchable.includes(word))) {
                uniqueCards.set(card.cardNumber, card);
            }
        });
        return [...uniqueCards.values()].sort((a, b) => (
            String(a.cardNumber).localeCompare(String(b.cardNumber), 'en', { numeric: true })
        ));
    }

    async function saveImageImportedDeck(imported) {
        const leader = findCardByNumber(imported?.leader);
        if (!leader || leader.cardType !== 'LEADER') {
            throw new Error('リーダーカードを確認してください。');
        }
        const deck = await createImportedDeck({
            ...imported,
            name: normalizeDeckName(imported.name, '画像から作成したデッキ')
        });
        setActiveNav('decks');
        startDeckEdit(deck);
        showMessageToast(`「${deck.name}」を作成しました。`, 'success');
        return deck;
    }

    let deckImageImportInitialized = false;

    function initializeDeckImageImport() {
        if (deckImageImportInitialized || !window.OPTCGImageImport?.init) return;
        window.OPTCGImageImport.init({
            maxCards: DECK_MAX_CARDS,
            maxCopies: DECK_MAX_COPIES,
            findCard: findCardByNumber,
            getCardImage: card => getCardImagePath(card, 0) || getCardImageFallbackPath(card, 0),
            getCardVariant: (card, selection) => resolveCardVariantSelection(card, selection),
            searchCards: searchCardsForImageImport,
            validateCards: normalizeDeckTransferEntries,
            saveAndEdit: saveImageImportedDeck,
            copyShareUrl: copyDeckShareUrl,
            showToast: showMessageToast
        });
        deckImageImportInitialized = true;
    }

    async function confirmAndSaveSharedDeck(imported, revalidateBeforeSave = null) {
        const confirmed = await confirmSharedDeckImport(imported);
        if (!confirmed) return false;
        const validated = typeof revalidateBeforeSave === 'function'
            ? revalidateBeforeSave(imported)
            : imported;
        return saveImportedSharedDeck(validated);
    }

    async function importSharedDeckFromUrl() {
        const encodedDeck = getSharedDeckHashValue();
        if (!encodedDeck || !db || isImportingSharedDeck) return false;

        isImportingSharedDeck = true;
        try {
            const imported = decodeSharedDeck(encodedDeck);
            return await confirmAndSaveSharedDeck(imported);
        } catch (error) {
            console.error('Failed to import shared deck:', error);
            showMessageToast(error.message || '共有デッキの追加に失敗しました。', 'error');
            return false;
        } finally {
            clearSharedDeckHash();
            isImportingSharedDeck = false;
        }
    }

    async function importDetailedAnalysisFromUrl() {
        let transfer;
        try {
            transfer = getDetailedAnalysisHashParams();
        } catch (error) {
            clearDetailedAnalysisHash();
            showMessageToast(error.message, 'error');
            return false;
        }
        if (!transfer || !db) return false;

        clearDetailedAnalysisHash();
        if (isImportingSharedDeck) {
            showMessageToast('別のデッキを確認中です。解析画面から新しいリンクを発行してください。', 'error');
            return false;
        }
        if (!DETAILED_ANALYZER_API_BASE_URL) {
            showMessageToast(
                getDetailedAnalysisImportMessage(createDetailedAnalysisError('api-not-configured')),
                'error'
            );
            return false;
        }

        isImportingSharedDeck = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ANALYSIS_FETCH_TIMEOUT_MS);
        try {
            showMessageToast('詳細解析結果を取得しています。', 'info');
            const response = await fetch(
                `${DETAILED_ANALYZER_API_BASE_URL}/api/v1/analyses/${transfer.analysisId}/deck`,
                {
                    method: 'GET',
                    mode: 'cors',
                    credentials: 'omit',
                    cache: 'no-store',
                    redirect: 'error',
                    referrerPolicy: 'no-referrer',
                    headers: {
                        Accept: 'application/json',
                        'X-Transfer-Token': transfer.token
                    },
                    signal: controller.signal
                }
            );
            if (!response.ok) {
                throw createDetailedAnalysisImportError(
                    response.status,
                    response.headers.get('Retry-After') || ''
                );
            }
            const imported = normalizeDetailedAnalysisDeck(await readDetailedAnalysisJson(response));
            clearTimeout(timeout);
            dom.messageToastDismissBtn?.click();
            return await confirmAndSaveSharedDeck(imported, revalidateDetailedAnalysisDeck);
        } catch (error) {
            console.error('Detailed analysis import failed.');
            showMessageToast(getDetailedAnalysisImportMessage(error), 'error');
            return false;
        } finally {
            clearTimeout(timeout);
            isImportingSharedDeck = false;
        }
    }

    async function importDeckFromCurrentHash() {
        if (!db) return false;
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        if (hashParams.has(ANALYSIS_HASH_KEY) || hashParams.has(ANALYSIS_TOKEN_HASH_KEY)) {
            return importDetailedAnalysisFromUrl();
        }
        return importSharedDeckFromUrl();
    }

    async function importSharedDeckFromText() {
        if (!db || isImportingSharedDeck || !dom.sharedDeckUrlInput) return false;

        isImportingSharedDeck = true;
        try {
            const encodedDeck = extractSharedDeckHashValue(dom.sharedDeckUrlInput.value);
            const imported = decodeSharedDeck(encodedDeck);
            closeSharedDeckUrlImport();
            return await confirmAndSaveSharedDeck(imported);
        } catch (error) {
            if (dom.sharedDeckUrlModal?.style.display !== 'none') {
                setSharedDeckUrlStatus(error.message || '共有URLを読み取れませんでした。');
                dom.sharedDeckUrlInput.focus();
            } else {
                console.error('Failed to import shared deck text:', error);
                showMessageToast(error.message || '共有デッキの追加に失敗しました。', 'error');
            }
            return false;
        } finally {
            isImportingSharedDeck = false;
        }
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (error) {
                // Fall back for standalone PWAs where clipboard permission is unavailable.
            }
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('テキストをコピーできませんでした。');
    }

    async function copyDeckShareUrl(deck) {
        try {
            const shareUrl = createDeckShareUrl(deck);
            await copyTextToClipboard(shareUrl);
            showMessageToast('共有URLをコピーしました。', 'success');
        } catch (error) {
            console.error('Failed to copy deck share URL:', error);
            showMessageToast('共有URLをコピーできませんでした。', 'error');
        }
    }

    function sanitizeDownloadName(value, fallback = 'deck') {
        const sanitized = String(value || '')
            .normalize('NFKC')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
        return sanitized || fallback;
    }

    function formatLocalDateStamp(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function downloadBlob(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    function formatFileSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function closeDeckImagePreview() {
        if (!dom.deckImagePreviewModal) return;
        dom.deckImagePreviewModal.style.display = 'none';
        dom.deckImagePreviewModal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('deck-image-preview-open');
        if (dom.deckImagePreviewImage) dom.deckImagePreviewImage.removeAttribute('src');
        if (deckImagePreviewUrl) URL.revokeObjectURL(deckImagePreviewUrl);
        deckImagePreviewBlob = null;
        deckImagePreviewUrl = '';
        deckImagePreviewFilename = '';
        deckImagePreviewKind = '画像';
    }

    function showDeckImagePreview(blob, filename, missingImages = 0, options = {}) {
        const previewTitle = options.title || 'デッキ画像';
        const previewKind = options.kind || previewTitle;
        if (!dom.deckImagePreviewModal || !dom.deckImagePreviewImage) {
            downloadBlob(blob, filename);
            showMessageToast(`${previewKind}をダウンロードしました。`, 'success');
            return;
        }

        closeDeckImagePreview();
        deckImagePreviewBlob = blob;
        deckImagePreviewFilename = filename;
        deckImagePreviewKind = previewKind;
        deckImagePreviewUrl = URL.createObjectURL(blob);
        if (dom.deckImagePreviewTitle) dom.deckImagePreviewTitle.textContent = previewTitle;
        dom.deckImagePreviewImage.src = deckImagePreviewUrl;
        dom.deckImagePreviewImage.alt = `${filename}のプレビュー`;
        dom.deckImagePreviewFilename.textContent = filename;
        dom.deckImagePreviewDetails.textContent = [
            `PNG画像 · ${formatFileSize(blob.size)}`,
            Number(options.width) > 0 && Number(options.height) > 0
                ? `${Math.round(options.width)} × ${Math.round(options.height)} px`
                : '',
            missingImages > 0 ? `${missingImages}枚は番号表示` : ''
        ].filter(Boolean).join(' · ');
        dom.deckImagePreviewModal.style.display = 'flex';
        dom.deckImagePreviewModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('deck-image-preview-open');
        requestAnimationFrame(() => dom.deckImagePreviewCloseBtn?.focus());
    }

    function downloadDeckImagePreview() {
        if (!deckImagePreviewBlob || !deckImagePreviewFilename) return;
        downloadBlob(deckImagePreviewBlob, deckImagePreviewFilename);
        showMessageToast(`${deckImagePreviewKind}をダウンロードしました。`, 'success');
    }

    async function shareOrSaveDeckImage() {
        if (!deckImagePreviewBlob || !deckImagePreviewFilename) return;

        const canCreateFile = typeof File === 'function';
        const file = canCreateFile
            ? new File([deckImagePreviewBlob], deckImagePreviewFilename, { type: 'image/png' })
            : null;
        let canShareFile = false;
        if (file && typeof navigator.share === 'function') {
            try {
                canShareFile = typeof navigator.canShare !== 'function'
                    || navigator.canShare({ files: [file] });
            } catch (error) {
                console.warn('Unable to check image sharing support:', error);
            }
        }

        if (!canShareFile) {
            downloadDeckImagePreview();
            return;
        }

        try {
            const sharedKind = deckImagePreviewKind;
            await navigator.share({
                title: deckImagePreviewFilename.replace(/\.png$/i, ''),
                files: [file]
            });
            closeDeckImagePreview();
            showMessageToast(`${sharedKind}を共有しました。`, 'success');
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.error('Failed to share deck image:', error);
            showMessageToast('共有を開始できませんでした。ダウンロードをお試しください。', 'error');
        }
    }

    function exportDeckJson(deck) {
        try {
            const payload = createDeckSharePayload(deck);
            const cardVariants = getCompactDeckVariantCounts(deck);
            const exported = {
                format: DECK_EXPORT_FORMAT,
                version: DECK_SHARE_VERSION,
                appVersion: APP_VERSION,
                exportedAt: new Date().toISOString(),
                deck: {
                    name: payload.n,
                    leader: payload.l,
                    cards: Object.fromEntries(payload.c),
                    ...(Object.keys(cardVariants).length > 0 ? { cardVariants } : {}),
                    ...(deck.leaderVariantId && deck.leaderVariantId !== deck.leader
                        ? { leaderVariantId: deck.leaderVariantId }
                        : {}),
                    tournaments: getDeckTournamentRecords(deck),
                    createdAt: deck.createdAt || null,
                    updatedAt: deck.updatedAt || null
                }
            };
            const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' });
            downloadBlob(blob, `${sanitizeDownloadName(deck.name)}.json`);
            showMessageToast('デッキJSONを出力しました。', 'success');
        } catch (error) {
            console.error('Failed to export deck JSON:', error);
            showMessageToast(error.message || 'デッキJSONの出力に失敗しました。', 'error');
        }
    }

    function compareDeckCards(a, b) {
        const typeOrder = { CHARACTER: 0, EVENT: 1, STAGE: 2 };
        const typeA = typeOrder[a?.cardType] !== undefined ? typeOrder[a.cardType] : 3;
        const typeB = typeOrder[b?.cardType] !== undefined ? typeOrder[b.cardType] : 3;
        if (typeA !== typeB) return typeA - typeB;
        const costA = Number(a?.costLifeValue) || 0;
        const costB = Number(b?.costLifeValue) || 0;
        if (costA !== costB) return costA - costB;
        return String(a?.cardNumber || '').localeCompare(String(b?.cardNumber || ''), 'en', { numeric: true });
    }

    function getDeckVariantsApi() {
        if (!window.OPTCGDeckVariants) {
            throw new Error('デッキのパラレル選択機能を読み込めませんでした。アプリを更新してください。');
        }
        return window.OPTCGDeckVariants;
    }

    function getDeckVariantCounts(deck) {
        try {
            return getDeckVariantsApi().normalizeVariantCounts(
                deck?.cards || {},
                deck?.cardVariants || {},
                DECK_MAX_COPIES
            );
        } catch (error) {
            console.error('Failed to normalize deck variants:', error);
            return Object.fromEntries(Object.entries(deck?.cards || {})
                .filter(([, count]) => Number(count) > 0)
                .map(([cardNumber, count]) => [getVariantKey(cardNumber, cardNumber), Number(count)]));
        }
    }

    function getCompactDeckVariantCounts(deck) {
        try {
            return getDeckVariantsApi().compactVariantCounts(
                deck?.cards || {},
                deck?.cardVariants || {},
                DECK_MAX_COPIES
            );
        } catch (error) {
            console.error('Failed to compact deck variants:', error);
            return {};
        }
    }

    function getDeckLeaderVariantEntry(deck) {
        const cardNumber = String(deck?.leader || '');
        const variantId = String(deck?.leaderVariantId || cardNumber);
        return resolveVariantEntry(getVariantKey(cardNumber, variantId));
    }

    function getDeckImageEntries(deck) {
        return Object.entries(getDeckVariantCounts(deck))
            .map(([key, count]) => ({ ...resolveVariantEntry(key), count: Number(count) }))
            .filter(entry => Number.isInteger(entry.count) && entry.count > 0)
            .sort((a, b) => compareDeckCards(a.card, b.card) || a.variantIndex - b.variantIndex);
    }

    function getProxyPrintItems(deck) {
        const entries = [];
        if (deck?.leader) {
            const leaderEntry = getDeckLeaderVariantEntry(deck);
            entries.push({ ...leaderEntry, count: 1, isLeader: true });
        }
        getDeckImageEntries(deck).forEach(entry => {
            entries.push({ ...entry, isLeader: false });
        });

        const remainingOwned = { ...getCollectionOwnedCardsForDeck(deck) };
        return entries.map((entry, index) => {
            const cardNumber = String(entry.cardNumber || entry.card?.cardNumber || '');
            const count = Math.max(0, Number(entry.count) || 0);
            const available = Math.max(0, Number(remainingOwned[cardNumber]) || 0);
            const coveredCount = Math.min(count, available);
            remainingOwned[cardNumber] = available - coveredCount;
            return {
                key: `${entry.isLeader ? 'leader' : 'main'}:${entry.key || cardNumber}:${index}`,
                cardNumber,
                cardName: entry.card?.cardName || cardNumber,
                variantId: entry.variantId || cardNumber,
                variantLabel: entry.variantLabel || '',
                sources: [...new Set([
                    getCardImagePath(entry.card, entry.variantIndex || 0),
                    getCardImageFallbackPath(entry.card, entry.variantIndex || 0)
                ].filter(Boolean))],
                count,
                missingCount: Math.max(0, count - coveredCount),
                isLeader: entry.isLeader
            };
        });
    }

    function openProxyPrintForDeck(deck) {
        try {
            if (!window.OPTCGProxyPrint?.open) {
                throw new Error('プロキシ印刷機能を読み込めませんでした。アプリを更新してください。');
            }
            const items = getProxyPrintItems(deck);
            if (!items.some(item => item.count > 0)) {
                throw new Error('印刷できるカードがありません。');
            }
            window.OPTCGProxyPrint.open({
                name: normalizeDeckName(deck?.name, 'デッキ'),
                items,
                defaultScope: deck?.ownedCardsLinked === true ? 'missing' : 'all'
            });
        } catch (error) {
            showMessageToast(error?.message || 'プロキシ印刷を開始できませんでした。', 'error');
        }
    }

    function getDeckRecordsApi() {
        if (!window.OPTCGDeckRecords) {
            throw new Error('大会記録機能を読み込めませんでした。アプリを更新してください。');
        }
        return window.OPTCGDeckRecords;
    }

    function getDeckTournamentRecords(deck) {
        try {
            return getDeckRecordsApi().normalizeTournamentRecords(deck?.tournaments);
        } catch (error) {
            console.error('Failed to normalize tournament records:', error);
            return [];
        }
    }

    function getDeckTournamentSummary(deck) {
        try {
            return getDeckRecordsApi().summarizeTournamentRecords(deck?.tournaments);
        } catch (error) {
            return {
                tournamentCount: 0,
                matchCount: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                rpsWins: 0,
                rpsLosses: 0
            };
        }
    }

    function getEditingDeckSnapshot() {
        if (!editingDeckId || currentMode !== 'deck_edit') return null;
        const cardVariants = getCompactDeckVariantCounts({
            cards: editingDeckData,
            cardVariants: editingDeckVariantData
        });
        return {
            id: editingDeckId,
            name: editingDeckMeta.name,
            leader: editingDeckMeta.leader,
            cards: { ...editingDeckData },
            ...(Object.keys(cardVariants).length > 0 ? { cardVariants } : {}),
            ...(editingDeckLeaderVariantId && editingDeckLeaderVariantId !== editingDeckMeta.leader
                ? { leaderVariantId: editingDeckLeaderVariantId }
                : {}),
            tournaments: getDeckTournamentRecords(editingDeckMeta)
        };
    }

    function getDeckCompositionSource() {
        if (deckCompositionEditable) return getEditingDeckSnapshot();
        return deckCompositionDeck;
    }

    function createDeckCompositionCard(entry, options = {}) {
        const { isLeader = false, editable = false } = options;
        const card = entry.card;
        const cardNumber = card.cardNumber || '';
        const item = document.createElement('article');
        item.className = `deck-composition-card${isLeader ? ' is-leader' : ''}`;

        const imageShell = document.createElement('div');
        imageShell.className = 'deck-composition-image-shell';
        const fallback = document.createElement('div');
        fallback.className = 'deck-composition-fallback';
        fallback.textContent = cardNumber || '画像なし';
        fallback.hidden = true;
        const imagePath = getCardImagePath(card, entry.variantIndex || 0);
        if (imagePath) {
            const image = document.createElement('img');
            image.className = 'deck-composition-image';
            image.src = imagePath;
            image.alt = card.cardName || cardNumber;
            image.loading = 'lazy';
            image.decoding = 'async';
            image.onerror = () => {
                image.remove();
                fallback.hidden = false;
            };
            imageShell.appendChild(image);
        } else {
            fallback.hidden = false;
        }
        imageShell.appendChild(fallback);

        const count = document.createElement('span');
        count.className = 'deck-composition-count';
        count.textContent = String(entry.count || 1);
        count.setAttribute('aria-label', `${entry.count || 1}枚`);
        imageShell.appendChild(count);
        item.appendChild(imageShell);

        const number = document.createElement('div');
        number.className = 'deck-composition-number';
        number.textContent = cardNumber || '未登録';
        number.title = [card.cardName || cardNumber, entry.variantLabel].filter(Boolean).join(' · ');
        item.appendChild(number);

        if (entry.variantType && entry.variantType !== 'normal') {
            const variantLabel = document.createElement('span');
            variantLabel.className = 'deck-composition-variant';
            variantLabel.textContent = entry.variantLabel || getVariantTypeLabel(entry.variantType);
            item.appendChild(variantLabel);
        }

        if (editable && !isLeader) {
            const stepper = document.createElement('div');
            stepper.className = 'deck-composition-stepper';
            stepper.setAttribute('role', 'group');
            stepper.setAttribute('aria-label', `${cardNumber}の枚数`);

            const minus = document.createElement('button');
            minus.type = 'button';
            minus.textContent = '−';
            minus.title = '1枚減らす';
            minus.setAttribute('aria-label', `${cardNumber}を1枚減らす`);
            minus.addEventListener('click', () => {
                setEditingDeckVariantCount(entry.key, Number(entry.count) - 1);
                renderDeckComposition();
            });

            const plus = document.createElement('button');
            plus.type = 'button';
            plus.textContent = '+';
            plus.title = '1枚増やす';
            plus.setAttribute('aria-label', `${cardNumber}を1枚増やす`);
            plus.disabled = Number(editingDeckData[cardNumber] || 0) >= DECK_MAX_COPIES;
            plus.addEventListener('click', () => {
                setEditingDeckVariantCount(entry.key, Number(entry.count) + 1);
                renderDeckComposition();
            });

            stepper.append(minus, plus);
            item.appendChild(stepper);
        }
        return item;
    }

    function renderDeckComposition() {
        const deck = getDeckCompositionSource();
        if (!deck || !dom.deckCompositionMainGrid || !dom.deckCompositionLeaderGrid) return;
        const entries = getDeckImageEntries(deck);
        const total = entries.reduce((sum, entry) => sum + entry.count, 0);
        dom.deckCompositionName.textContent = deck.name || '(名称未設定)';
        dom.deckCompositionSummary.textContent = `${entries.length}種類`;
        dom.deckCompositionMainCount.textContent = String(total);
        dom.deckCompositionMainGrid.innerHTML = '';
        dom.deckCompositionLeaderGrid.innerHTML = '';

        if (entries.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'deck-composition-empty';
            empty.textContent = 'カードがありません';
            dom.deckCompositionMainGrid.appendChild(empty);
        } else {
            const fragment = document.createDocumentFragment();
            entries.forEach(entry => {
                fragment.appendChild(createDeckCompositionCard(entry, {
                    editable: deckCompositionEditable
                }));
            });
            dom.deckCompositionMainGrid.appendChild(fragment);
        }

        const leaderEntry = getDeckLeaderVariantEntry(deck);
        const leaderCard = leaderEntry.card;
        dom.deckCompositionLeaderGrid.appendChild(createDeckCompositionCard({
            card: leaderCard,
            count: 1,
            variantIndex: leaderEntry.variantIndex,
            variantType: leaderEntry.variantType,
            variantLabel: leaderEntry.variantLabel
        }, { isLeader: true }));
    }

    function openDeckComposition(deck, options = {}) {
        if (!deck || !dom.deckCompositionModal) return;
        deckCompositionDeck = {
            ...deck,
            cards: { ...(deck.cards || {}) },
            cardVariants: { ...(deck.cardVariants || {}) }
        };
        deckCompositionEditable = options.editable === true && currentMode === 'deck_edit';
        renderDeckComposition();
        dom.deckCompositionModal.style.display = 'flex';
        dom.deckCompositionModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('deck-composition-open');
        setTimeout(() => dom.deckCompositionCloseBtn?.focus(), 30);
    }

    function openCurrentDeckComposition() {
        if (currentMode === 'deck_edit') {
            const deck = getEditingDeckSnapshot();
            if (deck) openDeckComposition(deck, { editable: true });
        } else if (currentMode === 'deck_view' && viewingDeck) {
            openDeckComposition(viewingDeck);
        }
    }

    function closeDeckComposition() {
        if (!dom.deckCompositionModal) return;
        dom.deckCompositionModal.style.display = 'none';
        dom.deckCompositionModal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('deck-composition-open');
        deckCompositionDeck = null;
        deckCompositionEditable = false;
    }

    function formatTournamentDate(dateValue) {
        if (!dateValue) return '日付未設定';
        const date = new Date(`${dateValue}T00:00:00`);
        return Number.isNaN(date.getTime()) ? dateValue : date.toLocaleDateString('ja-JP');
    }

    function formatMatchRecord(summary) {
        const drawText = summary.draws > 0 ? `${summary.draws}分` : '';
        return `${summary.wins}勝${summary.losses}敗${drawText}`;
    }

    function getSingleTournamentSummary(tournament) {
        return getDeckRecordsApi().summarizeTournamentRecords([tournament]);
    }

    function createTournamentIconButton(action, label, iconName, tournamentId, matchId = '', destructive = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tournament-icon-btn${destructive ? ' destructive' : ''}`;
        button.dataset.action = action;
        button.dataset.tournamentId = tournamentId;
        if (matchId) button.dataset.matchId = matchId;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.appendChild(createDeckActionIcon(iconName));
        return button;
    }

    function createTournamentSelectField(labelText, name, options, selectedValue) {
        const label = document.createElement('label');
        label.className = 'tournament-match-field';
        const caption = document.createElement('span');
        caption.textContent = labelText;
        const select = document.createElement('select');
        select.name = name;
        options.forEach(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            element.selected = option.value === selectedValue;
            select.appendChild(element);
        });
        label.append(caption, select);
        return label;
    }

    function createTournamentMatchForm(tournament) {
        const isEditing = editingTournamentMatch?.tournamentId === tournament.id;
        const editingMatch = isEditing
            ? tournament.matches.find(match => match.id === editingTournamentMatch.matchId)
            : null;
        const form = document.createElement('form');
        form.className = 'tournament-match-form';
        form.dataset.tournamentId = tournament.id;

        const opponentLabel = document.createElement('label');
        opponentLabel.className = 'tournament-match-field opponent';
        const opponentCaption = document.createElement('span');
        opponentCaption.textContent = '相手のデッキ';
        const opponentInput = document.createElement('input');
        opponentInput.type = 'text';
        opponentInput.name = 'opponentDeck';
        opponentInput.maxLength = 80;
        opponentInput.autocomplete = 'off';
        opponentInput.placeholder = '例: 赤ゾロ';
        opponentInput.required = true;
        opponentInput.value = editingMatch?.opponentDeck || '';
        opponentLabel.append(opponentCaption, opponentInput);

        form.appendChild(opponentLabel);
        form.appendChild(createTournamentSelectField('ジャンケン', 'rpsResult', [
            { value: 'win', label: '勝ち' },
            { value: 'loss', label: '負け' }
        ], editingMatch?.rpsResult || 'win'));
        form.appendChild(createTournamentSelectField('先攻・後攻', 'playOrder', [
            { value: 'first', label: '先攻' },
            { value: 'second', label: '後攻' }
        ], editingMatch?.playOrder || 'first'));
        form.appendChild(createTournamentSelectField('試合結果', 'result', [
            { value: 'win', label: '勝ち' },
            { value: 'loss', label: '負け' },
            { value: 'draw', label: '引き分け' }
        ], editingMatch?.result || 'win'));

        const actions = document.createElement('div');
        actions.className = 'tournament-match-form-actions';
        if (editingMatch) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'tournament-match-cancel';
            cancel.dataset.action = 'cancel-match-edit';
            cancel.dataset.tournamentId = tournament.id;
            cancel.textContent = '取消';
            actions.appendChild(cancel);
        }
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'tournament-match-submit';
        submit.textContent = editingMatch ? '更新' : '対戦追加';
        actions.appendChild(submit);
        form.appendChild(actions);
        return form;
    }

    function createTournamentMatchRow(tournament, match, index) {
        const row = document.createElement('li');
        row.className = 'tournament-match-row';
        const round = document.createElement('span');
        round.className = 'tournament-match-round';
        round.textContent = `R${index + 1}`;
        const opponent = document.createElement('strong');
        opponent.className = 'tournament-match-opponent';
        opponent.textContent = match.opponentDeck;
        opponent.title = match.opponentDeck;

        const tags = document.createElement('div');
        tags.className = 'tournament-match-tags';
        const tagValues = [
            { text: `ジャンケン ${match.rpsResult === 'win' ? '勝ち' : '負け'}`, className: '' },
            { text: match.playOrder === 'first' ? '先攻' : '後攻', className: '' },
            {
                text: match.result === 'win' ? '勝ち' : match.result === 'loss' ? '負け' : '引き分け',
                className: ` result-${match.result}`
            }
        ];
        tagValues.forEach(value => {
            const tag = document.createElement('span');
            tag.className = `tournament-match-tag${value.className}`;
            tag.textContent = value.text;
            tags.appendChild(tag);
        });

        const actions = document.createElement('div');
        actions.className = 'tournament-match-actions';
        actions.appendChild(createTournamentIconButton(
            'edit-match',
            `${index + 1}回戦を編集`,
            'edit',
            tournament.id,
            match.id
        ));
        actions.appendChild(createTournamentIconButton(
            'delete-match',
            `${index + 1}回戦を削除`,
            'delete',
            tournament.id,
            match.id,
            true
        ));
        row.append(round, opponent, tags, actions);
        return row;
    }

    function createTournamentCard(tournament) {
        const summary = getSingleTournamentSummary(tournament);
        const card = document.createElement('article');
        card.className = 'tournament-card';
        card.dataset.tournamentId = tournament.id;

        const header = document.createElement('header');
        header.className = 'tournament-card-header';
        const titleRow = document.createElement('div');
        titleRow.className = 'tournament-card-title-row';
        const titleCopy = document.createElement('div');
        titleCopy.className = 'tournament-card-title-copy';
        const title = document.createElement('h3');
        title.textContent = tournament.name;
        title.title = tournament.name;
        const meta = document.createElement('div');
        meta.className = 'tournament-card-meta';
        meta.textContent = `${formatTournamentDate(tournament.date)} · ${formatMatchRecord(summary)} · ${summary.matchCount}試合`;
        titleCopy.append(title, meta);
        titleRow.appendChild(titleCopy);

        const actions = document.createElement('div');
        actions.className = 'tournament-card-actions';
        actions.appendChild(createTournamentIconButton('edit-tournament', '大会情報を編集', 'edit', tournament.id));
        actions.appendChild(createTournamentIconButton('delete-tournament', '大会を削除', 'delete', tournament.id, '', true));
        header.append(titleRow, actions);
        card.appendChild(header);
        card.appendChild(createTournamentMatchForm(tournament));

        if (tournament.matches.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'tournament-match-empty';
            empty.textContent = '対戦記録はありません';
            card.appendChild(empty);
        } else {
            const list = document.createElement('ol');
            list.className = 'tournament-match-list';
            tournament.matches.forEach((match, index) => {
                list.appendChild(createTournamentMatchRow(tournament, match, index));
            });
            card.appendChild(list);
        }
        return card;
    }

    function renderTournamentRecords() {
        if (!tournamentRecordsDeck || !dom.tournamentRecordsList) return;
        const tournaments = getDeckTournamentRecords(tournamentRecordsDeck)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
        const summary = getDeckRecordsApi().summarizeTournamentRecords(tournaments);
        dom.tournamentRecordsDeckName.textContent = tournamentRecordsDeck.name || '(名称未設定)';
        dom.tournamentRecordsSummary.textContent = summary.matchCount > 0
            ? `大会 ${summary.tournamentCount}件 · ${formatMatchRecord(summary)} · ${summary.matchCount}試合`
            : `大会 ${summary.tournamentCount}件 · 対戦 0件`;
        dom.tournamentRecordsList.innerHTML = '';
        if (tournaments.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'tournament-empty';
            empty.textContent = '大会記録はありません';
            dom.tournamentRecordsList.appendChild(empty);
            return;
        }
        const fragment = document.createDocumentFragment();
        tournaments.forEach(tournament => fragment.appendChild(createTournamentCard(tournament)));
        dom.tournamentRecordsList.appendChild(fragment);
    }

    function resetTournamentForm() {
        editingTournamentId = null;
        if (!dom.tournamentForm) return;
        dom.tournamentForm.reset();
        dom.tournamentDateInput.value = getDeckRecordsApi().toLocalDateValue();
        dom.tournamentFormTitle.textContent = '大会を追加';
        dom.tournamentFormSubmitBtn.textContent = '大会を追加';
        dom.tournamentFormCancelBtn.hidden = true;
    }

    function beginTournamentEdit(tournamentId) {
        const tournament = getDeckTournamentRecords(tournamentRecordsDeck)
            .find(item => item.id === tournamentId);
        if (!tournament) return;
        editingTournamentId = tournament.id;
        dom.tournamentNameInput.value = tournament.name;
        dom.tournamentDateInput.value = tournament.date;
        dom.tournamentFormTitle.textContent = '大会情報を編集';
        dom.tournamentFormSubmitBtn.textContent = '大会情報を更新';
        dom.tournamentFormCancelBtn.hidden = false;
        dom.tournamentForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        dom.tournamentNameInput.focus();
    }

    async function persistTournamentRecords(records, successMessage) {
        if (!tournamentRecordsDeck) return false;
        const nextDeck = {
            ...tournamentRecordsDeck,
            tournaments: getDeckRecordsApi().normalizeTournamentRecords(records),
            updatedAt: new Date().toISOString()
        };
        try {
            await saveDeck(nextDeck);
            tournamentRecordsDeck = nextDeck;
            if (viewingDeck?.id === nextDeck.id) viewingDeck = nextDeck;
            if (editingDeckId === nextDeck.id) {
                editingDeckMeta.tournaments = getDeckTournamentRecords(nextDeck);
            }
            if (deckCompositionDeck?.id === nextDeck.id) {
                deckCompositionDeck.tournaments = getDeckTournamentRecords(nextDeck);
            }
            await loadDeckList();
            renderTournamentRecords();
            if (successMessage) showMessageToast(successMessage, 'success');
            return true;
        } catch (error) {
            console.error('Failed to save tournament records:', error);
            showMessageToast('大会記録を保存できませんでした。', 'error');
            return false;
        }
    }

    async function submitTournamentForm(event) {
        event.preventDefault();
        if (!tournamentRecordsDeck) return;
        let draft;
        try {
            draft = getDeckRecordsApi().createTournament({
                name: dom.tournamentNameInput.value,
                date: dom.tournamentDateInput.value
            });
        } catch (error) {
            showMessageToast(error.message, 'error');
            dom.tournamentNameInput.focus();
            return;
        }

        const records = getDeckTournamentRecords(tournamentRecordsDeck);
        let nextRecords;
        let message;
        if (editingTournamentId) {
            nextRecords = records.map(tournament => tournament.id === editingTournamentId ? {
                ...tournament,
                name: draft.name,
                date: draft.date,
                updatedAt: new Date().toISOString()
            } : tournament);
            message = '大会情報を更新しました。';
        } else {
            if (records.length >= getDeckRecordsApi().MAX_TOURNAMENTS) {
                showMessageToast('保存できる大会数の上限に達しています。', 'error');
                return;
            }
            nextRecords = [draft, ...records];
            message = '大会を追加しました。';
        }
        if (await persistTournamentRecords(nextRecords, message)) resetTournamentForm();
    }

    async function submitTournamentMatchForm(event) {
        event.preventDefault();
        const form = event.target.closest('.tournament-match-form');
        const tournamentId = form?.dataset.tournamentId;
        if (!form || !tournamentId || !tournamentRecordsDeck) return;
        let draft;
        try {
            draft = getDeckRecordsApi().createMatch({
                opponentDeck: form.elements.opponentDeck.value,
                rpsResult: form.elements.rpsResult.value,
                playOrder: form.elements.playOrder.value,
                result: form.elements.result.value
            });
        } catch (error) {
            showMessageToast(error.message, 'error');
            form.elements.opponentDeck.focus();
            return;
        }

        const records = getDeckTournamentRecords(tournamentRecordsDeck);
        const tournament = records.find(item => item.id === tournamentId);
        if (!tournament) return;
        let message = '対戦記録を追加しました。';
        const matches = [...tournament.matches];
        const editingMatchId = editingTournamentMatch?.tournamentId === tournamentId
            ? editingTournamentMatch.matchId
            : '';
        if (editingMatchId) {
            const matchIndex = matches.findIndex(match => match.id === editingMatchId);
            if (matchIndex >= 0) {
                matches[matchIndex] = {
                    ...draft,
                    id: matches[matchIndex].id,
                    createdAt: matches[matchIndex].createdAt,
                    updatedAt: new Date().toISOString()
                };
                message = '対戦記録を更新しました。';
            }
        } else if (matches.length >= getDeckRecordsApi().MAX_MATCHES_PER_TOURNAMENT) {
            showMessageToast('1大会に保存できる対戦数の上限に達しています。', 'error');
            return;
        } else {
            matches.push(draft);
        }

        const nextRecords = records.map(item => item.id === tournamentId ? {
            ...item,
            matches,
            updatedAt: new Date().toISOString()
        } : item);
        const previousEditing = editingTournamentMatch;
        editingTournamentMatch = null;
        if (!await persistTournamentRecords(nextRecords, message)) {
            editingTournamentMatch = previousEditing;
            renderTournamentRecords();
        }
    }

    async function handleTournamentRecordsAction(event) {
        const button = event.target.closest('[data-action]');
        if (!button || !tournamentRecordsDeck) return;
        const { action, tournamentId, matchId } = button.dataset;
        const records = getDeckTournamentRecords(tournamentRecordsDeck);
        const tournament = records.find(item => item.id === tournamentId);
        if (!tournament) return;

        if (action === 'edit-tournament') {
            beginTournamentEdit(tournamentId);
        } else if (action === 'delete-tournament') {
            if (!await confirmDialog(`大会「${tournament.name}」と対戦記録を削除します。`, {
                title: '大会記録を削除',
                confirmLabel: '削除',
                danger: true
            })) return;
            if (editingTournamentId === tournamentId) resetTournamentForm();
            if (editingTournamentMatch?.tournamentId === tournamentId) editingTournamentMatch = null;
            await persistTournamentRecords(
                records.filter(item => item.id !== tournamentId),
                '大会記録を削除しました。'
            );
        } else if (action === 'edit-match') {
            editingTournamentMatch = { tournamentId, matchId };
            renderTournamentRecords();
            requestAnimationFrame(() => {
                const form = dom.tournamentRecordsList.querySelector(`.tournament-match-form[data-tournament-id="${tournamentId}"]`);
                form?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                form?.elements?.opponentDeck?.focus();
            });
        } else if (action === 'cancel-match-edit') {
            editingTournamentMatch = null;
            renderTournamentRecords();
        } else if (action === 'delete-match') {
            const matchIndex = tournament.matches.findIndex(match => match.id === matchId);
            if (matchIndex < 0) return;
            if (!await confirmDialog(`${matchIndex + 1}回戦「${tournament.matches[matchIndex].opponentDeck}」を削除します。`, {
                title: '対戦記録を削除',
                confirmLabel: '削除',
                danger: true
            })) return;
            if (editingTournamentMatch?.matchId === matchId) editingTournamentMatch = null;
            const nextRecords = records.map(item => item.id === tournamentId ? {
                ...item,
                matches: item.matches.filter(match => match.id !== matchId),
                updatedAt: new Date().toISOString()
            } : item);
            await persistTournamentRecords(nextRecords, '対戦記録を削除しました。');
        }
    }

    function openTournamentRecords(deck) {
        if (!deck || !dom.tournamentRecordsModal) return;
        try {
            getDeckRecordsApi();
        } catch (error) {
            showMessageToast(error.message, 'error');
            return;
        }
        tournamentRecordsDeck = {
            ...deck,
            cards: { ...(deck.cards || {}) },
            tournaments: getDeckTournamentRecords(deck)
        };
        editingTournamentMatch = null;
        resetTournamentForm();
        renderTournamentRecords();
        dom.tournamentRecordsModal.style.display = 'flex';
        dom.tournamentRecordsModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('tournament-records-open');
        setTimeout(() => dom.tournamentNameInput?.focus(), 30);
    }

    function closeTournamentRecords() {
        if (!dom.tournamentRecordsModal) return;
        dom.tournamentRecordsModal.style.display = 'none';
        dom.tournamentRecordsModal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('tournament-records-open');
        tournamentRecordsDeck = null;
        editingTournamentId = null;
        editingTournamentMatch = null;
    }

    function getDeckRequirementEntries(deck) {
        const entries = [];
        if (deck?.leader) {
            entries.push({
                card: findCardByNumber(deck.leader) || {
                    cardNumber: deck.leader,
                    cardName: '未登録リーダー',
                    color: []
                },
                requiredCount: 1,
                isLeader: true
            });
        }
        getDeckImageEntries(deck).forEach(entry => {
            entries.push({
                card: entry.card,
                requiredCount: entry.count,
                isLeader: false
            });
        });
        return entries;
    }

    function clampOwnedCardCount(value, requiredCount) {
        const count = Number(value);
        if (!Number.isInteger(count)) return 0;
        return Math.min(Math.max(count, 0), requiredCount);
    }

    function normalizeOwnedCardsForDeck(deck, ownedCards = {}) {
        const normalized = {};
        getDeckRequirementEntries(deck).forEach(entry => {
            const cardNumber = entry.card.cardNumber;
            const count = clampOwnedCardCount(ownedCards[cardNumber], entry.requiredCount);
            if (count > 0) normalized[cardNumber] = count;
        });
        return normalized;
    }

    function getCollectionRecordsForCardNumber(cardNumber) {
        const normalizedNumber = String(cardNumber || '').trim();
        if (!normalizedNumber) return [];
        return [...collectionItems.entries()]
            .filter(([key, record]) => (
                String(record?.cardNumber || key.split('::')[0] || '').trim() === normalizedNumber
            ))
            .map(([key, record]) => ({ key, record }));
    }

    function getCollectionOwnedCountForCardNumber(cardNumber) {
        return getCollectionRecordsForCardNumber(cardNumber)
            .reduce((sum, { record }) => sum + clampCollectionCount(record?.count), 0);
    }

    function getCollectionOwnedCardsForDeck(deck) {
        const ownedCards = {};
        getDeckRequirementEntries(deck).forEach(entry => {
            const cardNumber = entry.card.cardNumber;
            const count = getCollectionOwnedCountForCardNumber(cardNumber);
            if (count > 0) ownedCards[cardNumber] = count;
        });
        return ownedCards;
    }

    function getMissingCardEntries(deck, ownedCards = {}) {
        return getDeckRequirementEntries(deck).map(entry => {
            const cardNumber = entry.card.cardNumber;
            const ownedCount = clampCollectionCount(ownedCards[cardNumber]);
            return {
                ...entry,
                ownedCount,
                missingCount: Math.max(0, entry.requiredCount - ownedCount)
            };
        });
    }

    function normalizeWantedCards(value = {}) {
        const normalized = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
        Object.entries(value).forEach(([cardNumber, rawCount]) => {
            const count = Number(rawCount);
            if (!cardNumber || !Number.isInteger(count) || count <= 0) return;
            normalized[cardNumber] = Math.min(count, DECK_MAX_COPIES);
        });
        return normalized;
    }

    async function loadWantedCards() {
        if (!db) return;
        try {
            const record = await db.get(STORE_METADATA, WANTED_CARDS_METADATA_KEY);
            wantedCards = normalizeWantedCards(record?.value);
        } catch (error) {
            console.warn('Failed to load wanted cards:', error);
            wantedCards = {};
        }
        syncWantedListControls();
    }

    async function persistWantedCards() {
        if (!db) return false;
        wantedCards = normalizeWantedCards(wantedCards);
        try {
            await db.put(STORE_METADATA, {
                key: WANTED_CARDS_METADATA_KEY,
                value: wantedCards,
                updatedAt: new Date().toISOString()
            });
            return true;
        } catch (error) {
            console.error('Failed to save wanted cards:', error);
            showMessageToast('欲しいカードリストを保存できませんでした。', 'error');
            return false;
        }
    }

    function scheduleWantedCardsSave() {
        clearTimeout(wantedCardsSaveTimer);
        wantedCardsSaveTimer = setTimeout(() => {
            wantedCardsSaveTimer = null;
            persistWantedCards();
        }, 250);
    }

    function getWantedCardEntries() {
        return Object.entries(wantedCards)
            .filter(([, count]) => Number(count) > 0)
            .map(([cardNumber, count]) => ({
                card: findCardByNumber(cardNumber) || {
                    cardNumber,
                    cardName: '未登録カード',
                    cardType: '',
                    color: []
                },
                count: Number(count)
            }))
            .sort((a, b) => String(a.card.cardNumber).localeCompare(
                String(b.card.cardNumber),
                'en',
                { numeric: true }
            ));
    }

    function setWantedStatusBarVisible(visible) {
        if (dom.wantedStatusBar) dom.wantedStatusBar.classList.toggle('active', visible);
        document.body.classList.toggle('wanted-bar-visible', visible);
    }

    function syncWantedListControls() {
        const entries = getWantedCardEntries();
        const total = entries.reduce((sum, entry) => sum + entry.count, 0);
        if (dom.wantedListBtn) {
            dom.wantedListBtn.classList.toggle('active', wantedSelectionMode);
            dom.wantedListBtn.setAttribute('aria-pressed', wantedSelectionMode ? 'true' : 'false');
        }
        if (dom.wantedListCount) {
            dom.wantedListCount.textContent = String(entries.length);
            dom.wantedListCount.hidden = entries.length === 0;
        }
        if (dom.wantedStatusInfo) {
            dom.wantedStatusInfo.textContent = `欲しいカード: ${total}枚 / ${entries.length}種類`;
        }
        if (dom.wantedShowToggleBtn) {
            dom.wantedShowToggleBtn.textContent = wantedShowOnlySelected ? '全カード' : '選択のみ';
            dom.wantedShowToggleBtn.classList.toggle('active', wantedShowOnlySelected);
            dom.wantedShowToggleBtn.disabled = entries.length === 0;
        }
        if (dom.wantedImageBtn) dom.wantedImageBtn.disabled = entries.length === 0;
        setWantedStatusBarVisible(wantedSelectionMode);
    }

    function startWantedCardsSelection() {
        if (currentMode !== 'view') {
            showMessageToast('デッキ編集を終了してから欲しいカードを選択してください。', 'info');
            return;
        }
        wantedSelectionMode = true;
        showCardListView();
        setActiveNav(activeCardView === 'new' ? 'new' : 'cards');
        setModeMessage('欲しいカードをタップして枚数を選択してください');
        populateFilters(getActiveCardSource());
        syncWantedListControls();
        applyFiltersAndDisplay();
    }

    function finishWantedCardsSelection() {
        if (!wantedSelectionMode) return;
        wantedSelectionMode = false;
        wantedShowOnlySelected = false;
        clearTimeout(wantedCardsSaveTimer);
        wantedCardsSaveTimer = null;
        persistWantedCards();
        setModeMessage(null);
        syncWantedListControls();
        applyFiltersAndDisplay();
    }

    function toggleWantedCardCount(cardNumber) {
        const current = Number(wantedCards[cardNumber]) || 0;
        const next = current >= DECK_MAX_COPIES ? 0 : current + 1;
        if (next > 0) wantedCards[cardNumber] = next;
        else delete wantedCards[cardNumber];

        if (wantedShowOnlySelected && next === 0) {
            applyFiltersAndDisplay();
        } else {
            const cardItem = cardElementMap[cardNumber];
            if (cardItem) {
                let badge = cardItem.querySelector('.card-wanted-badge');
                if (next > 0) {
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.className = 'card-wanted-badge';
                        cardItem.appendChild(badge);
                    }
                    badge.textContent = String(next);
                    badge.dataset.count = String(next);
                } else if (badge) {
                    badge.remove();
                }
            }
        }
        syncWantedListControls();
        scheduleWantedCardsSave();
    }

    // === 所持カード・開封記録 ===
    function clampCollectionCount(value) {
        const count = Number(value);
        if (!Number.isFinite(count)) return 0;
        return Math.min(Math.max(Math.trunc(count), 0), 9999);
    }

    function normalizeVariantCounts(value = {}) {
        const normalized = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
        Object.entries(value).forEach(([key, rawCount]) => {
            const count = clampCollectionCount(rawCount);
            if (key.includes('::') && count > 0) normalized[key] = count;
        });
        return normalized;
    }

    function getVariantCountDeltas(previousValue = {}, nextValue = {}) {
        const previous = normalizeVariantCounts(previousValue);
        const next = normalizeVariantCounts(nextValue);
        const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
        return [...keys]
            .map(key => ({ key, delta: (next[key] || 0) - (previous[key] || 0) }))
            .filter(change => change.delta !== 0);
    }

    function getCollectionCount(key) {
        return clampCollectionCount(collectionItems.get(key)?.count);
    }

    function getOpeningDraftCount(key) {
        return clampCollectionCount(openingDraftItems[key]);
    }

    function resolveVariantEntry(key, fallbackRecord = null) {
        const [cardNumber, variantId = cardNumber] = String(key || '').split('::');
        let card = findCardByNumber(cardNumber) || {
            cardNumber,
            cardName: fallbackRecord?.cardName || '未登録カード',
            cardType: '',
            color: []
        };
        let variants = getCardImageVariants(card);
        let variantIndex = variants.findIndex((variant, index) => (
            getCardVariantId(card, variant, index) === variantId
        ));
        if (variantIndex < 0) {
            const provisionalCard = provisionalCards.find(candidate => {
                if (candidate?.cardNumber !== cardNumber) return false;
                return getCardImageVariants(candidate).some((variant, index) => (
                    getCardVariantId(candidate, variant, index) === variantId
                ));
            });
            if (provisionalCard) {
                card = provisionalCard;
                variants = getCardImageVariants(card);
                variantIndex = variants.findIndex((variant, index) => (
                    getCardVariantId(card, variant, index) === variantId
                ));
            }
        }
        if (variantIndex < 0 && Number.isInteger(fallbackRecord?.variantIndex)) {
            const stableIndex = Number(fallbackRecord.variantIndex);
            variantIndex = variants.findIndex((variant, index) => getVariantStableIndex(variant, index) === stableIndex);
        }
        if (variantIndex < 0) variantIndex = 0;
        const variant = variants[variantIndex] || {};
        const variantType = fallbackRecord?.variantType || getCardVariantType(variant, variantIndex);
        return {
            key: getVariantKey(cardNumber, variantId),
            card,
            cardNumber,
            variant,
            variantId,
            variantIndex,
            variantType,
            variantLabel: variant.label || getVariantTypeLabel(variantType)
        };
    }

    function createCollectionRecord(card, key, count, fallbackRecord = null) {
        const resolved = resolveVariantEntry(key, fallbackRecord);
        return {
            id: key,
            cardNumber: card?.cardNumber || resolved.cardNumber,
            cardName: card?.cardName || resolved.card.cardName || '',
            variantId: resolved.variantId,
            variantType: resolved.variantType,
            variantIndex: getVariantStableIndex(resolved.variant, resolved.variantIndex),
            count: clampCollectionCount(count),
            updatedAt: new Date().toISOString()
        };
    }

    function buildCollectionOwnedCountChanges(cardNumber, requestedCount) {
        const targetCount = clampCollectionCount(requestedCount);
        const entries = getCollectionRecordsForCardNumber(cardNumber);
        const currentCount = entries.reduce(
            (sum, { record }) => sum + clampCollectionCount(record?.count),
            0
        );
        if (targetCount === currentCount) return [];

        const changes = [];
        if (targetCount > currentCount) {
            const defaultKey = getVariantKey(cardNumber, cardNumber);
            const existing = collectionItems.get(defaultKey);
            const card = findCardByNumber(cardNumber) || {
                cardNumber,
                cardName: existing?.cardName || '未登録カード',
                cardType: '',
                color: []
            };
            const record = createCollectionRecord(
                card,
                defaultKey,
                clampCollectionCount(existing?.count) + (targetCount - currentCount),
                existing
            );
            collectionItems.set(defaultKey, record);
            changes.push({ type: 'put', record });
            return changes;
        }

        let removeCount = currentCount - targetCount;
        entries
            .sort((a, b) => {
                const aNormal = a.record?.variantId === cardNumber || a.record?.variantType === 'normal';
                const bNormal = b.record?.variantId === cardNumber || b.record?.variantType === 'normal';
                return Number(bNormal) - Number(aNormal);
            })
            .forEach(({ key, record }) => {
                if (removeCount <= 0) return;
                const current = clampCollectionCount(record?.count);
                const next = Math.max(0, current - removeCount);
                removeCount -= current - next;
                if (next > 0) {
                    const nextRecord = { ...record, count: next, updatedAt: new Date().toISOString() };
                    collectionItems.set(key, nextRecord);
                    changes.push({ type: 'put', record: nextRecord });
                } else {
                    collectionItems.delete(key);
                    changes.push({ type: 'delete', key });
                }
            });
        return changes;
    }

    function queueCollectionOwnedCountChanges(changes) {
        if (!db || changes.length === 0) return;
        collectionWriteQueue = collectionWriteQueue
            .then(async () => {
                const tx = db.transaction(STORE_COLLECTION, 'readwrite');
                for (const change of changes) {
                    if (change.type === 'put') await tx.store.put(change.record);
                    else await tx.store.delete(change.key);
                }
                await tx.done;
            })
            .catch(error => {
                console.error('Failed to link collection ownership:', error);
                showMessageToast('所持枚数を保存できませんでした。', 'error');
            });
    }

    function setCollectionOwnedCountForCardNumber(cardNumber, count) {
        const changes = buildCollectionOwnedCountChanges(cardNumber, count);
        queueCollectionOwnedCountChanges(changes);
        return getCollectionOwnedCountForCardNumber(cardNumber);
    }

    async function linkLegacyDeckOwnership(deck) {
        if (!deck || deck.ownedCardsLinked === true) return false;
        const legacyOwnedCards = normalizeOwnedCardsForDeck(deck, deck.ownedCards || {});
        Object.entries(legacyOwnedCards).forEach(([cardNumber, count]) => {
            const current = getCollectionOwnedCountForCardNumber(cardNumber);
            if (count > current) setCollectionOwnedCountForCardNumber(cardNumber, count);
        });
        await collectionWriteQueue;
        deck.ownedCardsLinked = true;
        return true;
    }

    async function loadCollectionItems() {
        if (!db) return;
        try {
            const records = await db.getAll(STORE_COLLECTION);
            collectionItems = new Map(
                records
                    .filter(record => record?.id && clampCollectionCount(record.count) > 0)
                    .map(record => [record.id, { ...record, count: clampCollectionCount(record.count) }])
            );
        } catch (error) {
            console.warn('Failed to load collection items:', error);
            collectionItems = new Map();
        }
    }

    async function loadOpeningSessions() {
        if (!db) return [];
        try {
            openingSessions = await db.getAll(STORE_OPENING_SESSIONS);
            openingSessions = openingSessions
                .filter(session => session?.id)
                .map(session => ({
                    ...session,
                    items: normalizeVariantCounts(session.items),
                    draftItems: session.draftItems === null || session.draftItems === undefined
                        ? null
                        : normalizeVariantCounts(session.draftItems)
                }))
                .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        } catch (error) {
            console.warn('Failed to load opening sessions:', error);
            openingSessions = [];
        }
        return openingSessions;
    }

    function upsertOpeningSessionInMemory(session) {
        const index = openingSessions.findIndex(item => item.id === session.id);
        if (index >= 0) openingSessions[index] = session;
        else openingSessions.unshift(session);
        openingSessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    }

    function getOpeningSessionCounts(session) {
        return session?.draftItems === null || session?.draftItems === undefined
            ? normalizeVariantCounts(session?.items)
            : normalizeVariantCounts(session.draftItems);
    }

    function scheduleOpeningDraftSave() {
        if (!activeOpeningSession) return;
        clearTimeout(openingSessionSaveTimer);
        openingSessionSaveTimer = setTimeout(() => {
            openingSessionSaveTimer = null;
            persistActiveOpeningDraft();
        }, 250);
    }

    function persistActiveOpeningDraft() {
        if (!db || !activeOpeningSession) return Promise.resolve(false);
        if (!openingDraftDirty) return Promise.resolve(true);
        const session = {
            ...activeOpeningSession,
            draftItems: normalizeVariantCounts(openingDraftItems),
            status: 'draft',
            updatedAt: new Date().toISOString()
        };
        activeOpeningSession = session;
        upsertOpeningSessionInMemory(session);
        openingWriteQueue = openingWriteQueue
            .then(() => db.put(STORE_OPENING_SESSIONS, session))
            .then(() => true)
            .catch(error => {
                console.error('Failed to save opening session draft:', error);
                showMessageToast('開封記録の下書きを保存できませんでした。', 'error');
                return false;
            });
        return openingWriteQueue;
    }

    async function flushOpeningDraft() {
        clearTimeout(openingSessionSaveTimer);
        openingSessionSaveTimer = null;
        if (activeOpeningSession) await persistActiveOpeningDraft();
        await openingWriteQueue;
    }

    function getCollectionSummary() {
        const entries = [...collectionItems.values()].filter(item => clampCollectionCount(item.count) > 0);
        return {
            types: entries.length,
            total: entries.reduce((sum, item) => sum + clampCollectionCount(item.count), 0)
        };
    }

    function getOpeningSummary(counts = openingDraftItems) {
        const values = Object.values(normalizeVariantCounts(counts));
        return {
            types: values.length,
            total: values.reduce((sum, count) => sum + count, 0)
        };
    }

    function formatOpeningQuantity(session) {
        const boxCount = Math.min(999, Math.max(0, Math.trunc(Number(session?.boxCount) || 0)));
        const packCount = Math.min(9999, Math.max(0, Math.trunc(Number(session?.packCount) || 0)));
        return [
            boxCount > 0 ? `${boxCount} BOX` : '',
            packCount > 0 ? `バラ ${packCount}パック` : ''
        ].filter(Boolean).join(' + ');
    }

    function updateCollectionCardBadge(card, count) {
        const key = getCardDisplayVariantKey(card);
        const cardItem = cardElementMap[key];
        if (!cardItem) return;
        let badge = cardItem.querySelector('.card-collection-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'card-collection-badge';
                cardItem.appendChild(badge);
            }
            badge.textContent = String(count);
            badge.dataset.count = String(count);
        } else if (badge) {
            badge.remove();
        }
    }

    function adjustCollectionCard(card) {
        const key = getCardDisplayVariantKey(card);
        const existingRecord = collectionItems.get(key);
        const current = clampCollectionCount(existingRecord?.count);
        const next = clampCollectionCount(current + collectionAdjustDirection);
        if (next === current) return;

        const record = createCollectionRecord(card, key, next, existingRecord);
        if (next > 0) collectionItems.set(key, record);
        else collectionItems.delete(key);
        updateCollectionCardBadge(card, next);
        syncCollectionStatusBar();

        collectionWriteQueue = collectionWriteQueue
            .then(() => next > 0
                ? db.put(STORE_COLLECTION, record)
                : db.delete(STORE_COLLECTION, key))
            .catch(error => {
                console.error('Failed to save collection count:', error);
                showMessageToast('所持枚数を保存できませんでした。', 'error');
            });

        if (collectionShowOnlyOwned && next === 0) applyFiltersAndDisplay();
    }

    function adjustOpeningCard(card) {
        if (!activeOpeningSession) return;
        const key = getCardDisplayVariantKey(card);
        const current = getOpeningDraftCount(key);
        const next = clampCollectionCount(current + collectionAdjustDirection);
        if (next === current) return;
        if (next > 0) openingDraftItems[key] = next;
        else delete openingDraftItems[key];
        activeOpeningSession = {
            ...activeOpeningSession,
            draftItems: { ...openingDraftItems },
            status: 'draft'
        };
        openingDraftDirty = true;
        updateCollectionCardBadge(card, next);
        syncCollectionStatusBar();
        scheduleOpeningDraftSave();
    }

    async function finalizeOpeningSession() {
        if (!db || !activeOpeningSession) return;
        clearTimeout(openingSessionSaveTimer);
        openingSessionSaveTimer = null;
        await openingWriteQueue;

        const previousItems = normalizeVariantCounts(activeOpeningSession.items);
        const nextItems = normalizeVariantCounts(openingDraftItems);
        const now = new Date().toISOString();
        const nextCollection = new Map(collectionItems);
        const collectionChanges = [];

        getVariantCountDeltas(previousItems, nextItems).forEach(({ key, delta }) => {
            const currentRecord = nextCollection.get(key);
            const nextCount = clampCollectionCount((currentRecord?.count || 0) + delta);
            if (nextCount > 0) {
                const resolved = resolveVariantEntry(key, currentRecord);
                const record = createCollectionRecord(resolved.card, key, nextCount, currentRecord);
                nextCollection.set(key, record);
                collectionChanges.push({ type: 'put', record });
            } else {
                nextCollection.delete(key);
                collectionChanges.push({ type: 'delete', key });
            }
        });

        const savedSession = {
            ...activeOpeningSession,
            items: nextItems,
            draftItems: null,
            status: 'saved',
            updatedAt: now
        };

        try {
            const tx = db.transaction([STORE_COLLECTION, STORE_OPENING_SESSIONS], 'readwrite');
            const collectionStore = tx.objectStore(STORE_COLLECTION);
            const sessionStore = tx.objectStore(STORE_OPENING_SESSIONS);
            for (const change of collectionChanges) {
                if (change.type === 'put') await collectionStore.put(change.record);
                else await collectionStore.delete(change.key);
            }
            await sessionStore.put(savedSession);
            await tx.done;
            collectionItems = nextCollection;
            upsertOpeningSessionInMemory(savedSession);
            activeOpeningSession = null;
            openingDraftItems = {};
            openingDraftDirty = false;
            await leaveCollectionTrackingMode();
            await showCollectionManager();
            showMessageToast('開封記録を所持カードへ反映しました。', 'success');
        } catch (error) {
            console.error('Failed to finalize opening session:', error);
            showMessageToast('開封記録を確定できませんでした。', 'error');
        }
    }

    function setCollectionStatusBarVisible(visible) {
        if (dom.collectionStatusBar) dom.collectionStatusBar.classList.toggle('active', visible);
        document.body.classList.toggle('collection-bar-visible', visible);
    }

    function syncCollectionStatusBar() {
        const openingMode = currentMode === 'opening_edit';
        const summary = openingMode ? getOpeningSummary() : getCollectionSummary();
        if (dom.collectionStatusInfo) {
            const label = openingMode
                ? (activeOpeningSession?.name || '開封記録')
                : '所持カード';
            dom.collectionStatusInfo.textContent = `${label}: ${summary.total}枚 / ${summary.types}種類`;
        }
        if (dom.collectionMinusBtn) dom.collectionMinusBtn.classList.toggle('active', collectionAdjustDirection < 0);
        if (dom.collectionPlusBtn) dom.collectionPlusBtn.classList.toggle('active', collectionAdjustDirection > 0);
        if (dom.collectionOwnedToggleBtn) {
            dom.collectionOwnedToggleBtn.hidden = openingMode;
            dom.collectionOwnedToggleBtn.textContent = collectionShowOnlyOwned ? '全カード' : '所持のみ';
            dom.collectionOwnedToggleBtn.classList.toggle('active', collectionShowOnlyOwned);
        }
        if (dom.collectionDoneBtn) dom.collectionDoneBtn.textContent = openingMode ? '確定' : '完了';
        if (dom.collectionImageBtn) dom.collectionImageBtn.disabled = summary.types === 0;
    }

    function startCollectionEdit() {
        closeCollectionManager();
        currentMode = 'collection_edit';
        activeCardView = 'cards';
        activeOpeningSession = null;
        openingDraftItems = {};
        openingDraftDirty = false;
        collectionAdjustDirection = 1;
        collectionShowOnlyOwned = true;
        showCardListView();
        setActiveNav('cards');
        populateFilters(getDeckCardPool());
        resetFilters();
        setModeMessage('通常版・絵違い別に所持枚数を編集');
        setCollectionStatusBarVisible(true);
        syncCollectionStatusBar();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    async function startOpeningEdit(session) {
        if (!session) return;
        closeCollectionManager();
        currentMode = 'opening_edit';
        activeCardView = 'cards';
        activeOpeningSession = {
            ...session,
            items: normalizeVariantCounts(session.items),
            draftItems: session.draftItems === null || session.draftItems === undefined
                ? normalizeVariantCounts(session.items)
                : normalizeVariantCounts(session.draftItems),
            status: 'draft'
        };
        openingDraftItems = { ...activeOpeningSession.draftItems };
        openingDraftDirty = session.draftItems !== null && session.draftItems !== undefined;
        collectionAdjustDirection = 1;
        showCardListView();
        setActiveNav('cards');
        populateFilters(getDeckCardPool());
        resetFilters();
        setModeMessage(`${activeOpeningSession.name || '開封記録'}にカードを追加`);
        setCollectionStatusBarVisible(true);
        syncCollectionStatusBar();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    async function leaveCollectionTrackingMode() {
        if (currentMode === 'opening_edit' && activeOpeningSession) await flushOpeningDraft();
        await collectionWriteQueue;
        currentMode = 'view';
        activeCardView = 'cards';
        activeOpeningSession = null;
        openingDraftItems = {};
        openingDraftDirty = false;
        collectionAdjustDirection = 1;
        setCollectionStatusBarVisible(false);
        setModeMessage(null);
        showCardListView();
        setActiveNav('cards');
        populateFilters(allCards);
        resetFilters();
        applyFiltersAndDisplay();
    }

    function getOpeningSeriesOptions() {
        const labels = new Map();
        getDeckCardPool().forEach(card => {
            const prefix = normalizeSeriesId(card?.cardNumber?.split('-')[0]);
            if (prefix) {
                const title = card.seriesTitle || String(card.series || '').split(' - ').slice(1).join(' - ');
                labels.set(prefix, prefix === 'P' ? 'P - プロモカード' : `${prefix}${title ? ` - ${title}` : ''}`);
            }
            getCardSeriesIds(card).forEach(seriesId => {
                if (!labels.has(seriesId)) labels.set(seriesId, seriesId);
            });
        });
        return [...labels.entries()].sort(([a], [b]) => {
            if (a === 'P') return 1;
            if (b === 'P') return -1;
            return a.localeCompare(b, 'en', { numeric: true });
        });
    }

    function openOpeningForm(session = null) {
        if (!dom.openingFormModal) return;
        openingFormSessionId = session?.id || null;
        if (dom.openingFormTitle) dom.openingFormTitle.textContent = session ? '開封記録の情報を編集' : '新しい開封記録';
        if (dom.openingNameInput) dom.openingNameInput.value = session?.name || '';
        if (dom.openingDateInput) dom.openingDateInput.value = session?.openedAt || formatLocalDateStamp();
        if (dom.openingBoxCountInput) dom.openingBoxCountInput.value = session?.boxCount || '';
        if (dom.openingPackCountInput) dom.openingPackCountInput.value = session?.packCount || '';
        if (dom.openingSeriesSelect) {
            dom.openingSeriesSelect.innerHTML = '<option value="">すべてのシリーズ（カード整理）</option>';
            getOpeningSeriesOptions().forEach(([id, label]) => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = label;
                dom.openingSeriesSelect.appendChild(option);
            });
            dom.openingSeriesSelect.value = session?.seriesId || '';
        }
        if (dom.openingFormSubmitBtn) dom.openingFormSubmitBtn.textContent = session ? '保存' : '記録を開始';
        if (dom.collectionModal?.style.display !== 'none') {
            dom.collectionModal.setAttribute('aria-hidden', 'true');
        }
        dom.openingFormModal.style.display = 'flex';
        dom.openingFormModal.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => dom.openingNameInput?.focus());
    }

    function closeOpeningForm() {
        if (!dom.openingFormModal) return;
        dom.openingFormModal.style.display = 'none';
        dom.openingFormModal.setAttribute('aria-hidden', 'true');
        if (dom.collectionModal?.style.display !== 'none') {
            dom.collectionModal.setAttribute('aria-hidden', 'false');
        }
        openingFormSessionId = null;
    }

    function createOpeningSessionId() {
        return crypto.randomUUID
            ? `opening-${crypto.randomUUID()}`
            : `opening-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    async function submitOpeningForm() {
        const name = normalizeDeckName(dom.openingNameInput?.value, '開封記録');
        const seriesId = normalizeSeriesId(dom.openingSeriesSelect?.value);
        const openedAt = dom.openingDateInput?.value || formatLocalDateStamp();
        const boxCount = Math.min(999, Math.max(0, Math.trunc(Number(dom.openingBoxCountInput?.value) || 0)));
        const packCount = Math.min(9999, Math.max(0, Math.trunc(Number(dom.openingPackCountInput?.value) || 0)));

        const existing = openingFormSessionId
            ? openingSessions.find(session => session.id === openingFormSessionId)
            : null;
        const now = new Date().toISOString();
        const session = existing
            ? { ...existing, name, seriesId, openedAt, boxCount, packCount, updatedAt: now }
            : {
                id: createOpeningSessionId(),
                name,
                seriesId,
                openedAt,
                boxCount,
                packCount,
                items: {},
                draftItems: {},
                status: 'draft',
                createdAt: now,
                updatedAt: now
            };

        try {
            await db.put(STORE_OPENING_SESSIONS, session);
            upsertOpeningSessionInMemory(session);
            closeOpeningForm();
            if (existing) {
                renderCollectionManager();
                showMessageToast('開封記録の情報を更新しました。', 'success');
            } else {
                await startOpeningEdit(session);
            }
        } catch (error) {
            console.error('Failed to save opening session:', error);
            showMessageToast('開封記録を保存できませんでした。', 'error');
        }
    }

    function closeCollectionManager() {
        if (!dom.collectionModal) return;
        dom.collectionModal.style.display = 'none';
        dom.collectionModal.setAttribute('aria-hidden', 'true');
    }

    async function showCollectionManager() {
        if (!dom.collectionModal) return;
        if (!db) {
            showMessageToast('データベースの準備が完了していません。', 'info');
            return;
        }
        if (currentMode !== 'view' || wantedSelectionMode) {
            showMessageToast('編集中の操作を完了してから所持カードを開いてください。', 'info');
            return;
        }
        await loadCollectionItems();
        await loadOpeningSessions();
        renderCollectionManager();
        dom.collectionModal.style.display = 'flex';
        dom.collectionModal.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => dom.collectionCloseBtn?.focus());
    }

    function createCollectionSessionThumbnail(session) {
        const shell = document.createElement('div');
        shell.className = 'collection-session-thumbnail';
        const firstKey = Object.keys(getOpeningSessionCounts(session))[0];
        if (!firstKey) {
            shell.textContent = session.seriesId || 'ALL';
            return shell;
        }
        const entry = resolveVariantEntry(firstKey);
        const sources = [...new Set([
            getCardImagePath(entry.card, entry.variantIndex),
            getCardImageFallbackPath(entry.card, entry.variantIndex)
        ].filter(Boolean))];
        if (sources.length === 0) {
            shell.textContent = entry.cardNumber;
            return shell;
        }
        const image = document.createElement('img');
        let sourceIndex = 0;
        image.src = sources[sourceIndex];
        image.alt = '';
        image.loading = 'lazy';
        image.onerror = () => {
            sourceIndex += 1;
            if (sourceIndex < sources.length) image.src = sources[sourceIndex];
            else shell.textContent = entry.cardNumber;
        };
        shell.appendChild(image);
        return shell;
    }

    function createCollectionActionButton(label, iconName, action, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `collection-session-action ${className}`.trim();
        button.title = label;
        button.setAttribute('aria-label', label);
        button.appendChild(createDeckActionIcon(iconName));
        const text = document.createElement('span');
        text.textContent = label;
        button.appendChild(text);
        button.addEventListener('click', action);
        return button;
    }

    function renderCollectionManager() {
        const summary = getCollectionSummary();
        if (dom.collectionSummary) {
            dom.collectionSummary.textContent = `所持 ${summary.total}枚 / ${summary.types}種類（通常版・絵違い別）`;
        }
        if (!dom.collectionSessionsList) return;
        dom.collectionSessionsList.innerHTML = '';
        if (openingSessions.length === 0) {
            dom.collectionSessionsList.innerHTML = '<p class="collection-empty">開封記録はまだありません。</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        openingSessions.forEach(session => {
            const counts = getOpeningSessionCounts(session);
            const summary = getOpeningSummary(counts);
            const row = document.createElement('article');
            row.className = 'collection-session-item';
            row.appendChild(createCollectionSessionThumbnail(session));

            const info = document.createElement('div');
            info.className = 'collection-session-info';
            const name = document.createElement('strong');
            name.textContent = session.name || '開封記録';
            const meta = document.createElement('span');
            meta.textContent = [
                session.openedAt,
                session.seriesId || '全シリーズ',
                formatOpeningQuantity(session),
                `${summary.total}枚 / ${summary.types}種類`,
                session.draftItems !== null && session.draftItems !== undefined ? '下書きあり' : ''
            ].filter(Boolean).join(' · ');
            info.append(name, meta);
            row.appendChild(info);

            const actions = document.createElement('div');
            actions.className = 'collection-session-actions';
            actions.appendChild(createCollectionActionButton('追記', 'edit', () => startOpeningEdit(session), 'primary'));
            actions.appendChild(createCollectionActionButton('画像', 'image', () => exportOpeningSessionImage(session)));
            actions.appendChild(createCollectionActionButton('情報', 'more', () => openOpeningForm(session)));
            actions.appendChild(createCollectionActionButton('削除', 'delete', () => deleteOpeningSession(session), 'destructive'));
            row.appendChild(actions);
            fragment.appendChild(row);
        });
        dom.collectionSessionsList.appendChild(fragment);
    }

    async function deleteOpeningSession(session) {
        const committed = normalizeVariantCounts(session?.items);
        const hasCommittedItems = Object.keys(committed).length > 0;
        const message = hasCommittedItems
            ? `「${session.name}」を削除しますか？\nこの記録で追加した枚数を所持カードから差し引きます。`
            : `「${session.name}」を削除しますか？`;
        if (!await confirmDialog(message, { title: '開封記録を削除', confirmLabel: '削除', danger: true })) return;

        const nextCollection = new Map(collectionItems);
        try {
            const tx = db.transaction([STORE_COLLECTION, STORE_OPENING_SESSIONS], 'readwrite');
            const collectionStore = tx.objectStore(STORE_COLLECTION);
            const sessionStore = tx.objectStore(STORE_OPENING_SESSIONS);
            for (const [key, count] of Object.entries(committed)) {
                const record = nextCollection.get(key);
                const nextCount = clampCollectionCount((record?.count || 0) - count);
                if (nextCount > 0 && record) {
                    const nextRecord = { ...record, count: nextCount, updatedAt: new Date().toISOString() };
                    nextCollection.set(key, nextRecord);
                    await collectionStore.put(nextRecord);
                } else {
                    nextCollection.delete(key);
                    await collectionStore.delete(key);
                }
            }
            await sessionStore.delete(session.id);
            await tx.done;
            collectionItems = nextCollection;
            openingSessions = openingSessions.filter(item => item.id !== session.id);
            renderCollectionManager();
            showMessageToast('開封記録を削除しました。', 'success');
        } catch (error) {
            console.error('Failed to delete opening session:', error);
            showMessageToast('開封記録を削除できませんでした。', 'error');
        }
    }

    async function exportCollectionJson() {
        await collectionWriteQueue;
        await loadOpeningSessions();
        const payload = {
            format: COLLECTION_EXPORT_FORMAT,
            version: COLLECTION_EXPORT_VERSION,
            appVersion: APP_VERSION,
            exportedAt: new Date().toISOString(),
            items: [...collectionItems.values()],
            openingSessions
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        downloadBlob(blob, `所持カード-${formatLocalDateStamp()}.json`);
        showMessageToast('所持カードと開封記録をJSON保存しました。', 'success');
    }

    async function importCollectionJson(file) {
        if (!file) return;
        try {
            const payload = JSON.parse(await file.text());
            if (payload?.format !== COLLECTION_EXPORT_FORMAT || !Array.isArray(payload.items)) {
                throw new Error('所持カードJSONの形式ではありません。');
            }
            if (!await confirmDialog('現在の所持カードと開封記録を、このJSONの内容で置き換えます。', { title: 'JSONから復元', confirmLabel: '置き換える', danger: true })) return;

            const records = payload.items
                .filter(item => item?.id && clampCollectionCount(item.count) > 0)
                .map(item => ({ ...item, count: clampCollectionCount(item.count) }));
            const sessions = Array.isArray(payload.openingSessions)
                ? payload.openingSessions.filter(session => session?.id).map(session => ({
                    ...session,
                    items: normalizeVariantCounts(session.items),
                    draftItems: session.draftItems === null || session.draftItems === undefined
                        ? null
                        : normalizeVariantCounts(session.draftItems)
                }))
                : [];

            const tx = db.transaction([STORE_COLLECTION, STORE_OPENING_SESSIONS], 'readwrite');
            const collectionStore = tx.objectStore(STORE_COLLECTION);
            const sessionStore = tx.objectStore(STORE_OPENING_SESSIONS);
            await collectionStore.clear();
            await sessionStore.clear();
            for (const record of records) await collectionStore.put(record);
            for (const session of sessions) await sessionStore.put(session);
            await tx.done;
            collectionItems = new Map(records.map(record => [record.id, record]));
            openingSessions = sessions;
            renderCollectionManager();
            showMessageToast('所持カードと開封記録を復元しました。', 'success');
        } catch (error) {
            console.error('Failed to import collection JSON:', error);
            showMessageToast(error.message || 'JSONを読み込めませんでした。', 'error');
        } finally {
            if (dom.collectionImportInput) dom.collectionImportInput.value = '';
        }
    }

    function createMissingCardThumbnail(card) {
        const shell = document.createElement('div');
        shell.className = 'missing-card-thumbnail';
        const cardNumber = card?.cardNumber || '?';
        const sources = card?.cardNumber
            ? [...new Set([
                getCardImagePath(card, 0),
                getCardImageFallbackPath(card, 0)
            ].filter(Boolean))]
            : [];
        const showFallback = () => {
            const fallback = document.createElement('span');
            fallback.className = 'missing-card-thumbnail-fallback';
            fallback.textContent = cardNumber;
            shell.replaceChildren(fallback);
        };

        if (sources.length === 0) {
            showFallback();
            return shell;
        }

        const image = document.createElement('img');
        let sourceIndex = 0;
        image.alt = card?.cardName || cardNumber;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.onerror = () => {
            sourceIndex += 1;
            if (sourceIndex < sources.length) image.src = sources[sourceIndex];
            else showFallback();
        };
        image.src = sources[sourceIndex];
        shell.appendChild(image);
        return shell;
    }

    function createMissingCardStepperButton(symbol, label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'missing-card-stepper-btn';
        button.textContent = symbol;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.addEventListener('click', action);
        return button;
    }

    function renderMissingCardsList() {
        if (!dom.missingCardsList || !missingCardsDeck) return;
        const fragment = document.createDocumentFragment();

        getMissingCardEntries(missingCardsDeck, missingCardsOwned).forEach(entry => {
            const cardNumber = entry.card.cardNumber;
            const row = document.createElement('article');
            row.className = 'missing-card-row';
            row.dataset.cardNumber = cardNumber;
            row.appendChild(createMissingCardThumbnail(entry.card));

            const info = document.createElement('div');
            info.className = 'missing-card-info';
            const number = document.createElement('strong');
            number.className = 'missing-card-number';
            number.textContent = [cardNumber, getRarityLabel(entry.card)].filter(Boolean).join(' · ');
            const name = document.createElement('span');
            name.className = 'missing-card-name';
            name.textContent = entry.card.cardName || '未登録カード';
            const required = document.createElement('span');
            required.className = 'missing-card-required';
            required.textContent = entry.isLeader ? 'リーダー · 必要1枚' : `必要${entry.requiredCount}枚`;
            info.append(number, name, required);
            row.appendChild(info);

            const controls = document.createElement('div');
            controls.className = 'missing-card-controls';
            const decrement = createMissingCardStepperButton('−', `${cardNumber}の所持枚数を減らす`, () => {
                adjustMissingOwnedCount(cardNumber, -1);
            });
            decrement.dataset.role = 'decrement';
            const owned = document.createElement('output');
            owned.className = 'missing-card-owned';
            owned.dataset.role = 'owned';
            const increment = createMissingCardStepperButton('+', `${cardNumber}の所持枚数を増やす`, () => {
                adjustMissingOwnedCount(cardNumber, 1);
            });
            increment.dataset.role = 'increment';
            const shortage = document.createElement('span');
            shortage.className = 'missing-card-shortage';
            shortage.dataset.role = 'shortage';
            controls.append(decrement, owned, increment, shortage);
            row.appendChild(controls);
            fragment.appendChild(row);
        });

        dom.missingCardsList.replaceChildren(fragment);
        syncMissingCardsModal();
    }

    function syncMissingCardsModal() {
        if (!missingCardsDeck) return;
        const entries = getMissingCardEntries(missingCardsDeck, missingCardsOwned);
        const entryMap = new Map(entries.map(entry => [entry.card.cardNumber, entry]));
        dom.missingCardsList?.querySelectorAll('.missing-card-row').forEach(row => {
            const entry = entryMap.get(row.dataset.cardNumber);
            if (!entry) return;
            const decrement = row.querySelector('[data-role="decrement"]');
            const increment = row.querySelector('[data-role="increment"]');
            const owned = row.querySelector('[data-role="owned"]');
            const shortage = row.querySelector('[data-role="shortage"]');
            if (decrement) decrement.disabled = entry.ownedCount <= 0;
            if (increment) increment.disabled = entry.ownedCount >= 9999;
            if (owned) owned.textContent = `所持 ${entry.ownedCount}/${entry.requiredCount}`;
            if (shortage) shortage.textContent = entry.missingCount > 0 ? `不足 ${entry.missingCount}` : '所持済み';
            row.classList.toggle('is-complete', entry.missingCount === 0);
        });

        const missingEntries = entries.filter(entry => entry.missingCount > 0);
        const missingTotal = missingEntries.reduce((sum, entry) => sum + entry.missingCount, 0);
        if (dom.missingCardsSummary) {
            dom.missingCardsSummary.textContent = missingTotal > 0
                ? `不足 ${missingTotal}枚 / ${missingEntries.length}種類`
                : '不足カードはありません';
        }
        if (dom.missingCardsCopyBtn) dom.missingCardsCopyBtn.disabled = missingTotal === 0;
        if (dom.missingCardsImageBtn) dom.missingCardsImageBtn.disabled = missingTotal === 0;
        if (dom.missingCardsShareBtn) dom.missingCardsShareBtn.disabled = missingTotal === 0;
        if (dom.missingCardsClearBtn) {
            dom.missingCardsClearBtn.disabled = entries.every(entry => entry.ownedCount === 0);
        }
        if (dom.missingCardsFillBtn) {
            dom.missingCardsFillBtn.disabled = entries.every(entry => entry.missingCount === 0);
        }
    }

    function adjustMissingOwnedCount(cardNumber, delta) {
        if (!missingCardsDeck) return;
        const current = getCollectionOwnedCountForCardNumber(cardNumber);
        const next = setCollectionOwnedCountForCardNumber(cardNumber, current + delta);
        if (next > 0) missingCardsOwned[cardNumber] = next;
        else delete missingCardsOwned[cardNumber];
        syncMissingCardsModal();
        scheduleMissingCardsOwnershipSave();
    }

    async function setAllMissingOwnedCards(owned) {
        if (!missingCardsDeck) return;
        if (!owned && !await confirmDialog('このデッキに含まれるカードの所持枚数を、所持カードリストでも0枚にします。', { title: '所持枚数をリセット', confirmLabel: '0枚にする', danger: true })) {
            return;
        }
        getDeckRequirementEntries(missingCardsDeck).forEach(entry => {
            const cardNumber = entry.card.cardNumber;
            const current = getCollectionOwnedCountForCardNumber(cardNumber);
            const target = owned ? Math.max(current, entry.requiredCount) : 0;
            const next = setCollectionOwnedCountForCardNumber(cardNumber, target);
            if (next > 0) missingCardsOwned[cardNumber] = next;
            else delete missingCardsOwned[cardNumber];
        });
        syncMissingCardsModal();
        scheduleMissingCardsOwnershipSave();
    }

    async function persistMissingCardsOwnership() {
        if (!missingCardsDeck) return true;
        const deck = missingCardsDeck;
        const ownedSnapshot = { ...missingCardsOwned };
        await collectionWriteQueue;
        const ownedCards = normalizeOwnedCardsForDeck(deck, ownedSnapshot);
        deck.ownedCards = ownedCards;
        deck.ownedCardsLinked = true;
        try {
            await saveDeck(deck);
            return true;
        } catch (error) {
            console.error('Failed to save owned card counts:', error);
            showMessageToast('所持枚数を保存できませんでした。', 'error');
            return false;
        }
    }

    function scheduleMissingCardsOwnershipSave() {
        clearTimeout(missingCardsSaveTimer);
        missingCardsSaveTimer = setTimeout(() => {
            missingCardsSaveTimer = null;
            persistMissingCardsOwnership();
        }, 250);
    }

    function flushMissingCardsOwnership() {
        clearTimeout(missingCardsSaveTimer);
        missingCardsSaveTimer = null;
        return persistMissingCardsOwnership();
    }

    function hideMissingCardsModal() {
        if (dom.missingCardsModal) {
            dom.missingCardsModal.style.display = 'none';
            dom.missingCardsModal.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('missing-cards-open');
        dom.missingCardsList?.replaceChildren();
        missingCardsDeck = null;
        missingCardsOwned = {};
    }

    async function closeMissingCardsModal() {
        const savePromise = flushMissingCardsOwnership();
        hideMissingCardsModal();
        await savePromise;
    }

    async function openMissingCardsModal(deck) {
        if (!dom.missingCardsModal || !deck) return;
        missingCardsDeck = deck;
        await collectionWriteQueue;
        await loadCollectionItems();

        await linkLegacyDeckOwnership(deck);

        missingCardsOwned = getCollectionOwnedCardsForDeck(deck);
        deck.ownedCardsLinked = true;
        await persistMissingCardsOwnership();
        if (dom.missingCardsDeckName) {
            dom.missingCardsDeckName.textContent = normalizeDeckName(deck.name, 'デッキ');
        }
        renderMissingCardsList();
        dom.missingCardsModal.style.display = 'flex';
        dom.missingCardsModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('missing-cards-open');
        requestAnimationFrame(() => dom.missingCardsCloseBtn?.focus());
    }

    function buildMissingCardsShareText(deck, ownedCards) {
        const entries = getMissingCardEntries(deck, ownedCards)
            .filter(entry => entry.missingCount > 0);
        if (entries.length === 0) return '';

        const lines = [`【${normalizeDeckName(deck.name, 'デッキ')}】不足カード`, ''];
        entries.forEach(entry => {
            const rarity = getRarityLabel(entry.card);
            const details = [
                entry.card.cardNumber,
                rarity ? `[${rarity}]` : '',
                entry.card.cardName || '未登録カード'
            ].filter(Boolean).join(' ');
            lines.push(`${details} ×${entry.missingCount}${entry.isLeader ? '（リーダー）' : ''}`);
        });
        const total = entries.reduce((sum, entry) => sum + entry.missingCount, 0);
        lines.push('', `合計 ${total}枚 / ${entries.length}種類`);
        return lines.join('\n');
    }

    async function copyMissingCardsList() {
        if (!missingCardsDeck) return;
        const text = buildMissingCardsShareText(missingCardsDeck, missingCardsOwned);
        if (!text) {
            showMessageToast('不足カードはありません。', 'info');
            return;
        }
        const savePromise = flushMissingCardsOwnership();
        try {
            await copyTextToClipboard(text);
            await savePromise;
            showMessageToast('不足カードリストをコピーしました。', 'success');
        } catch (error) {
            console.error('Failed to copy missing card list:', error);
            showMessageToast('不足カードリストをコピーできませんでした。', 'error');
        }
    }

    async function shareMissingCardsList() {
        if (!missingCardsDeck) return;
        const deck = missingCardsDeck;
        const text = buildMissingCardsShareText(deck, missingCardsOwned);
        if (!text) {
            showMessageToast('不足カードはありません。', 'info');
            return;
        }

        const title = `${normalizeDeckName(deck.name, 'デッキ')} 不足カード`;
        const savePromise = flushMissingCardsOwnership();
        if (typeof navigator.share === 'function') {
            try {
                await navigator.share({ title, text });
                await savePromise;
                hideMissingCardsModal();
                showMessageToast('不足カードリストを共有しました。', 'success');
                return;
            } catch (error) {
                if (error?.name === 'AbortError') {
                    await savePromise;
                    return;
                }
                console.warn('Unable to share missing card list:', error);
            }
        }

        try {
            await copyTextToClipboard(text);
            await savePromise;
            showMessageToast('共有に対応していないため、リストをコピーしました。', 'success');
        } catch (error) {
            console.error('Failed to share missing card list:', error);
            showMessageToast('不足カードリストを共有できませんでした。', 'error');
        }
    }

    function getDeckImageCardMeta(card, fallbackNumber = '') {
        const cardNumber = card?.cardNumber || fallbackNumber;
        const rarity = getRarityLabel(card);
        return [cardNumber, rarity].filter(Boolean).join(' · ');
    }

    function createRoundedRectPath(ctx, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function setFittedCanvasFont(ctx, text, maxWidth, preferredSize, minSize = 18, weight = 700) {
        let size = preferredSize;
        do {
            ctx.font = `${weight} ${size}px sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) break;
            size -= 2;
        } while (size > minSize);
        return size;
    }

    function truncateCanvasText(ctx, text, maxWidth) {
        const value = String(text || '');
        if (ctx.measureText(value).width <= maxWidth) return value;
        let result = value;
        while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
            result = result.slice(0, -1);
        }
        return `${result}…`;
    }

    function getCanvasCardColor(card) {
        const colorMap = {
            '赤': '#df5353',
            '緑': '#39ad67',
            '青': '#4b86d1',
            '紫': '#9566cc',
            '黒': '#62656c',
            '黄': '#e5bd3d'
        };
        const cardColor = Array.isArray(card?.color) ? card.color[0] : '';
        return colorMap[cardColor] || '#777b82';
    }

    function loadCanvasImage(source) {
        if (!source) return Promise.resolve(null);
        return new Promise(resolve => {
            const image = new Image();
            const resolvedUrl = new URL(source, document.baseURI);
            let finished = false;
            const finish = value => {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutId);
                resolve(value);
            };
            const timeoutId = setTimeout(() => finish(null), 12000);
            if (resolvedUrl.origin !== window.location.origin) image.crossOrigin = 'anonymous';
            image.decoding = 'async';
            image.onload = () => finish(image);
            image.onerror = () => finish(null);
            image.src = resolvedUrl.href;
        });
    }

    function getExportCanvasScale(logicalWidth, logicalHeight) {
        const width = Math.max(1, Number(logicalWidth) || 1);
        const height = Math.max(1, Number(logicalHeight) || 1);
        return Math.max(1, Math.min(
            EXPORT_IMAGE_MAX_SCALE,
            Math.sqrt(EXPORT_IMAGE_MAX_PIXELS / (width * height)),
            EXPORT_IMAGE_MAX_DIMENSION / width,
            EXPORT_IMAGE_MAX_DIMENSION / height
        ));
    }

    function createExportCanvas(logicalWidth, logicalHeight) {
        const scale = getExportCanvasScale(logicalWidth, logicalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(logicalWidth * scale));
        canvas.height = Math.max(1, Math.floor(logicalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('画像描画を開始できませんでした。');
        ctx.setTransform(
            canvas.width / logicalWidth,
            0,
            0,
            canvas.height / logicalHeight,
            0,
            0
        );
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        return { canvas, ctx };
    }

    async function loadCardCanvasImage(card, variantIndex = 0) {
        if (!card?.cardNumber) return null;
        const sources = [...new Set([
            getCardImagePath(card, variantIndex),
            getCardImageFallbackPath(card, variantIndex)
        ].filter(Boolean))];
        for (const source of sources) {
            const image = await loadCanvasImage(source);
            if (image) return image;
        }
        return null;
    }

    function drawCanvasCard(ctx, card, image, x, y, width, height, count = 0) {
        const borderColor = getCanvasCardColor(card);
        ctx.save();
        createRoundedRectPath(ctx, x, y, width, height, 8);
        ctx.clip();
        ctx.fillStyle = '#262a2f';
        ctx.fillRect(x, y, width, height);

        if (image) {
            const sourceRatio = image.naturalWidth / image.naturalHeight;
            const targetRatio = width / height;
            let sourceX = 0;
            let sourceY = 0;
            let sourceWidth = image.naturalWidth;
            let sourceHeight = image.naturalHeight;
            if (sourceRatio > targetRatio) {
                sourceWidth = image.naturalHeight * targetRatio;
                sourceX = (image.naturalWidth - sourceWidth) / 2;
            } else if (sourceRatio < targetRatio) {
                sourceHeight = image.naturalWidth / targetRatio;
                sourceY = (image.naturalHeight - sourceHeight) / 2;
            }
            ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
        } else {
            ctx.fillStyle = borderColor;
            ctx.fillRect(x, y, width, 10);
            ctx.fillStyle = '#f4f5f6';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            setFittedCanvasFont(ctx, card.cardNumber || '?', width - 20, 24, 16, 800);
            ctx.fillText(card.cardNumber || '?', x + width / 2, y + height / 2 - 18);
            ctx.fillStyle = '#b8bdc4';
            ctx.font = '600 16px sans-serif';
            ctx.fillText(truncateCanvasText(ctx, card.cardName || '画像なし', width - 20), x + width / 2, y + height / 2 + 18);
        }
        ctx.restore();

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 4;
        createRoundedRectPath(ctx, x, y, width, height, 8);
        ctx.stroke();

        if (count > 0) {
            const badgeSize = 48;
            const badgeX = x + width - badgeSize - 8;
            const badgeY = y + height - badgeSize - 8;
            ctx.fillStyle = '#ffca28';
            createRoundedRectPath(ctx, badgeX, badgeY, badgeSize, badgeSize, 8);
            ctx.fill();
            ctx.fillStyle = '#111315';
            ctx.font = '900 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(count), badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 1);
        }
    }

    function canvasToPngBlob(canvas) {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('PNGデータを作成できませんでした。'));
                }, 'image/png');
            } catch (error) {
                reject(error);
            }
        });
    }

    async function exportCardCollectionImage({
        title,
        subtitle,
        entries,
        filename,
        previewTitle,
        kind
    }) {
        const imageEntries = (entries || []).filter(entry => entry?.card && Number(entry.count) > 0);
        if (imageEntries.length === 0) {
            showMessageToast(`${kind || 'カードリスト'}は空です。`, 'info');
            return;
        }
        if (imageEntries.length > CARD_LIST_IMAGE_MAX_TYPES) {
            showMessageToast(`画像出力は${CARD_LIST_IMAGE_MAX_TYPES}種類までです。`, 'error');
            return;
        }

        const imageKind = kind || 'カードリスト画像';
        showMessageToast(`${imageKind}を作成しています...`, 'info');
        try {
            const cardImages = await Promise.all(
                imageEntries.map(entry => loadCardCanvasImage(entry.card, entry.variantIndex || 0))
            );
            const canvasWidth = 1600;
            const headerHeight = 174;
            const footerHeight = 76;
            const outerPadding = 48;
            const columns = 8;
            const cardGap = 14;
            const rowGap = 20;
            const labelHeight = 62;
            const cardWidth = Math.floor(
                (canvasWidth - outerPadding * 2 - cardGap * (columns - 1)) / columns
            );
            const cardHeight = Math.round(cardWidth * 1.4);
            const rowHeight = cardHeight + labelHeight;
            const rowCount = Math.ceil(imageEntries.length / columns);
            const gridHeight = rowCount * rowHeight + Math.max(0, rowCount - 1) * rowGap;
            const canvasHeight = headerHeight + outerPadding + gridHeight + outerPadding + footerHeight;
            const { canvas, ctx } = createExportCanvas(canvasWidth, canvasHeight);

            ctx.fillStyle = '#101214';
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            ctx.fillStyle = '#1b1e22';
            ctx.fillRect(0, 0, canvasWidth, headerHeight);
            ctx.fillStyle = '#27c7b8';
            ctx.fillRect(0, headerHeight - 8, canvasWidth, 8);

            const total = imageEntries.reduce((sum, entry) => sum + Number(entry.count), 0);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f4f5f6';
            setFittedCanvasFont(ctx, title, canvasWidth - outerPadding * 2 - 350, 52, 30, 800);
            ctx.fillText(title, outerPadding, 76);
            ctx.fillStyle = '#aeb4bc';
            ctx.font = '700 22px sans-serif';
            ctx.fillText(subtitle, outerPadding, 118);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#f4f5f6';
            ctx.font = '800 30px sans-serif';
            ctx.fillText(`${total} CARDS`, canvasWidth - outerPadding, 68);
            ctx.fillStyle = '#aeb4bc';
            ctx.font = '700 20px sans-serif';
            ctx.fillText(`${imageEntries.length} TYPES`, canvasWidth - outerPadding, 108);

            const gridTop = headerHeight + outerPadding;
            imageEntries.forEach((entry, index) => {
                const column = index % columns;
                const row = Math.floor(index / columns);
                const x = outerPadding + column * (cardWidth + cardGap);
                const y = gridTop + row * (rowHeight + rowGap);
                drawCanvasCard(ctx, entry.card, cardImages[index], x, y, cardWidth, cardHeight, entry.count);

                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = '#f4f5f6';
                ctx.font = '700 18px sans-serif';
                ctx.fillText(
                    truncateCanvasText(ctx, [
                        getDeckImageCardMeta(entry.card),
                        entry.variantLabel
                    ].filter(Boolean).join(' · '), cardWidth),
                    x,
                    y + cardHeight + 24
                );
                ctx.fillStyle = '#aeb4bc';
                ctx.font = '600 16px sans-serif';
                ctx.fillText(
                    truncateCanvasText(ctx, entry.card.cardName || '未登録カード', cardWidth),
                    x,
                    y + cardHeight + 49
                );
            });

            const footerY = canvasHeight - footerHeight;
            ctx.fillStyle = '#1b1e22';
            ctx.fillRect(0, footerY, canvasWidth, footerHeight);
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'left';
            ctx.fillStyle = '#8f969f';
            ctx.font = '600 19px sans-serif';
            ctx.fillText('OP TCG DB · CARD LIST', outerPadding, footerY + 47);
            ctx.textAlign = 'right';
            ctx.fillText(new Date().toLocaleDateString('ja-JP'), canvasWidth - outerPadding, footerY + 47);

            const blob = await canvasToPngBlob(canvas);
            const missingImages = cardImages.filter(image => !image).length;
            showDeckImagePreview(blob, filename, missingImages, {
                title: previewTitle || imageKind,
                kind: imageKind,
                width: canvas.width,
                height: canvas.height
            });
        } catch (error) {
            console.error('Failed to export card collection image:', error);
            showMessageToast(`${imageKind}の出力に失敗しました。`, 'error');
        }
    }

    async function exportMissingCardsImage() {
        if (!missingCardsDeck) return;
        const deck = missingCardsDeck;
        const entries = getMissingCardEntries(deck, missingCardsOwned)
            .filter(entry => entry.missingCount > 0)
            .map(entry => ({ card: entry.card, count: entry.missingCount }));
        if (entries.length === 0) {
            showMessageToast('不足カードはありません。', 'info');
            return;
        }
        await flushMissingCardsOwnership();
        const deckName = normalizeDeckName(deck.name, 'デッキ');
        await exportCardCollectionImage({
            title: `${deckName} 不足カード`,
            subtitle: 'OP TCG DB · MISSING CARD LIST',
            entries,
            filename: `${sanitizeDownloadName(deckName)}-不足カード.png`,
            previewTitle: '不足カード画像',
            kind: '不足カード画像'
        });
    }

    async function exportWantedCardsImage() {
        const entries = getWantedCardEntries();
        if (entries.length === 0) {
            showMessageToast('欲しいカードリストは空です。', 'info');
            return;
        }
        clearTimeout(wantedCardsSaveTimer);
        wantedCardsSaveTimer = null;
        await persistWantedCards();
        await exportCardCollectionImage({
            title: '欲しいカードリスト',
            subtitle: 'OP TCG DB · WANTED CARD LIST',
            entries,
            filename: `欲しいカードリスト-${formatLocalDateStamp()}.png`,
            previewTitle: '欲しいカード画像',
            kind: '欲しいカード画像'
        });
    }

    function getVariantImageEntriesFromCounts(counts) {
        return Object.entries(normalizeVariantCounts(counts))
            .map(([key, count]) => {
                const record = collectionItems.get(key);
                const resolved = resolveVariantEntry(key, record);
                return {
                    card: resolved.card,
                    count,
                    variantIndex: resolved.variantIndex,
                    variantLabel: resolved.variantLabel,
                    variantId: resolved.variantId,
                    key
                };
            })
            .sort((a, b) => {
                const cardOrder = String(a.card.cardNumber).localeCompare(
                    String(b.card.cardNumber),
                    'en',
                    { numeric: true }
                );
                return cardOrder || a.variantIndex - b.variantIndex;
            });
    }

    async function exportCurrentCollectionImage() {
        const visibleKeys = new Set(currentFilteredCards.map(getCardDisplayVariantKey));
        const counts = {};
        collectionItems.forEach((record, key) => {
            if (visibleKeys.has(key) && clampCollectionCount(record.count) > 0) {
                counts[key] = clampCollectionCount(record.count);
            }
        });
        const entries = getVariantImageEntriesFromCounts(counts);
        if (entries.length === 0) {
            showMessageToast('現在の表示条件に所持カードがありません。', 'info');
            return;
        }
        const seriesLabel = currentFilter.series ? ` · ${currentFilter.series}` : '';
        await exportCardCollectionImage({
            title: `所持カードリスト${seriesLabel}`,
            subtitle: 'OP TCG DB · COLLECTION',
            entries,
            filename: `所持カード${currentFilter.series ? `-${currentFilter.series}` : ''}-${formatLocalDateStamp()}.png`,
            previewTitle: '所持カード画像',
            kind: '所持カード画像'
        });
    }

    async function exportOpeningSessionImage(session = activeOpeningSession) {
        if (!session) return;
        const isActiveSession = session.id === activeOpeningSession?.id;
        if (isActiveSession) await flushOpeningDraft();
        const counts = isActiveSession
            ? normalizeVariantCounts(openingDraftItems)
            : getOpeningSessionCounts(session);
        const entries = getVariantImageEntriesFromCounts(counts);
        if (entries.length === 0) {
            showMessageToast('開封記録にカードがありません。', 'info');
            return;
        }
        const name = normalizeDeckName(session.name, '開封記録');
        const details = [
            session.seriesId || '全シリーズ',
            session.openedAt,
            formatOpeningQuantity(session)
        ].filter(Boolean).join(' · ');
        await exportCardCollectionImage({
            title: name,
            subtitle: `OP TCG DB · OPENING RECORD${details ? ` · ${details}` : ''}`,
            entries,
            filename: `${sanitizeDownloadName(name)}-${session.openedAt || formatLocalDateStamp()}.png`,
            previewTitle: '開封記録画像',
            kind: '開封記録画像'
        });
    }

    async function exportDeckImage(deck) {
        const entries = getDeckImageEntries(deck);
        if (entries.length > DECK_MAX_CARDS * 2) {
            showMessageToast('画像に出力できるカード種類数を超えています。', 'error');
            return;
        }

        showMessageToast('デッキ画像を作成しています...', 'info');
        try {
            const leaderEntry = getDeckLeaderVariantEntry(deck);
            const leaderCard = leaderEntry.card;
            const [leaderImage, ...cardImages] = await Promise.all([
                loadCardCanvasImage(leaderCard, leaderEntry.variantIndex),
                ...entries.map(entry => loadCardCanvasImage(entry.card, entry.variantIndex || 0))
            ]);

            const canvasWidth = 1600;
            const headerHeight = 176;
            const footerHeight = 76;
            const outerPadding = 48;
            const leaderColumnWidth = 260;
            const sectionGap = 42;
            const cardGap = 14;
            const columns = 8;
            const cardWidth = 138;
            const cardHeight = Math.round(cardWidth * 1.4);
            const cardNumberLabelHeight = 34;
            const gridRowHeight = cardHeight + cardNumberLabelHeight;
            const rowCount = Math.max(1, Math.ceil(entries.length / columns));
            const gridHeight = rowCount * gridRowHeight + (rowCount - 1) * cardGap;
            const contentHeight = Math.max(430, gridHeight);
            const canvasHeight = headerHeight + outerPadding + contentHeight + outerPadding + footerHeight;
            const { canvas, ctx } = createExportCanvas(canvasWidth, canvasHeight);

            ctx.fillStyle = '#101214';
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            ctx.fillStyle = '#1b1e22';
            ctx.fillRect(0, 0, canvasWidth, headerHeight);
            ctx.fillStyle = '#27c7b8';
            ctx.fillRect(0, headerHeight - 8, canvasWidth, 8);

            const deckName = normalizeDeckName(deck.name, 'デッキ');
            ctx.fillStyle = '#f7f8f9';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            setFittedCanvasFont(ctx, deckName, 1120, 64, 34, 800);
            ctx.fillText(deckName, outerPadding, 88);
            ctx.fillStyle = '#aeb4bb';
            ctx.font = '700 25px sans-serif';
            ctx.fillText('OP TCG DB · DECK LIST', outerPadding, 132);

            const total = entries.reduce((sum, entry) => sum + entry.count, 0);
            ctx.textAlign = 'right';
            ctx.fillStyle = '#f7f8f9';
            ctx.font = '800 35px sans-serif';
            ctx.fillText(`${total}/${DECK_MAX_CARDS} CARDS`, canvasWidth - outerPadding, 82);
            ctx.fillStyle = '#aeb4bb';
            ctx.font = '600 22px sans-serif';
            ctx.fillText(`${entries.length} TYPES`, canvasWidth - outerPadding, 122);

            const contentY = headerHeight + outerPadding;
            ctx.fillStyle = '#aeb4bb';
            ctx.textAlign = 'left';
            ctx.font = '800 20px sans-serif';
            ctx.fillText('LEADER', outerPadding, contentY - 14);
            const leaderWidth = 220;
            const leaderHeight = Math.round(leaderWidth * 1.4);
            drawCanvasCard(ctx, leaderCard, leaderImage, outerPadding, contentY, leaderWidth, leaderHeight);
            ctx.fillStyle = '#f7f8f9';
            ctx.font = '800 24px sans-serif';
            ctx.fillText(truncateCanvasText(ctx, leaderCard.cardName || deck.leader, leaderColumnWidth), outerPadding, contentY + leaderHeight + 38);
            ctx.fillStyle = '#aeb4bb';
            ctx.font = '600 20px sans-serif';
            ctx.fillText(getDeckImageCardMeta(leaderCard, deck.leader), outerPadding, contentY + leaderHeight + 70);

            const gridX = outerPadding + leaderColumnWidth + sectionGap;
            ctx.fillStyle = '#aeb4bb';
            ctx.font = '800 20px sans-serif';
            ctx.fillText('DECK', gridX, contentY - 14);
            if (entries.length === 0) {
                ctx.fillStyle = '#5b6169';
                ctx.font = '700 32px sans-serif';
                ctx.fillText('カード未登録', gridX, contentY + 54);
            }
            entries.forEach((entry, index) => {
                const column = index % columns;
                const row = Math.floor(index / columns);
                const x = gridX + column * (cardWidth + cardGap);
                const y = contentY + row * (gridRowHeight + cardGap);
                drawCanvasCard(ctx, entry.card, cardImages[index], x, y, cardWidth, cardHeight, entry.count);
                ctx.fillStyle = '#c9ced4';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const cardMeta = getDeckImageCardMeta(entry.card);
                setFittedCanvasFont(ctx, cardMeta, cardWidth, 18, 12, 700);
                ctx.fillText(cardMeta, x + cardWidth / 2, y + cardHeight + cardNumberLabelHeight / 2 + 1);
            });

            const footerY = canvasHeight - footerHeight;
            ctx.fillStyle = '#1b1e22';
            ctx.fillRect(0, footerY, canvasWidth, footerHeight);
            ctx.fillStyle = '#8c939b';
            ctx.font = '600 19px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`Leader: ${leaderCard.cardNumber || deck.leader || '-'}`, outerPadding, footerY + 46);
            ctx.textAlign = 'right';
            ctx.fillText(new Date().toLocaleDateString('ja-JP'), canvasWidth - outerPadding, footerY + 46);

            const blob = await canvasToPngBlob(canvas);
            const filename = `${sanitizeDownloadName(deck.name)}.png`;
            const missingImages = [leaderImage, ...cardImages].filter(image => !image).length;
            showDeckImagePreview(blob, filename, missingImages, {
                width: canvas.width,
                height: canvas.height
            });
        } catch (error) {
            console.error('Failed to export deck image:', error);
            showMessageToast('デッキ画像の出力に失敗しました。', 'error');
        }
    }

    function setModeMessage(text) {
        if (!dom.modeMessageBar) return;
        if (text) {
            dom.modeMessageBar.textContent = text;
            dom.modeMessageBar.style.display = 'block';
            document.body.classList.add('mode-bar-visible');
        } else {
            dom.modeMessageBar.style.display = 'none';
            document.body.classList.remove('mode-bar-visible');
        }
    }

    function setDeckStatusBarVisible(visible) {
        if (!dom.deckStatusBar) return;
        dom.deckStatusBar.classList.toggle('active', visible);
        document.body.classList.toggle('deck-bar-visible', visible);
    }

    function showCardListView() {
        dom.deckListView.style.display = 'none';
        dom.cardListContainer.style.display = '';
        setDeckBuilderPanelVisible(currentMode === 'deck_edit');
    }

    function showDeckListView() {
        dom.cardListContainer.style.display = 'none';
        setDeckBuilderPanelVisible(false);
        dom.deckListView.style.display = 'block';
    }

    function setActiveNav(tab) {
        if (dom.navCards) dom.navCards.classList.toggle('active', tab === 'cards');
        if (dom.navDecks) dom.navDecks.classList.toggle('active', tab === 'decks');
        if (dom.navNew) dom.navNew.classList.toggle('active', tab === 'new');
    }

    function getDeckTotalCount() {
        return Object.values(editingDeckData).reduce((sum, n) => sum + n, 0);
    }

    function setDeckBuilderPanelVisible(visible) {
        if (!dom.deckBuilderPanel) return;
        const wasHidden = dom.deckBuilderPanel.hidden;
        dom.deckBuilderPanel.hidden = !visible;
        document.body.classList.toggle('deck-builder-active', visible);
        if (dom.mainContent) dom.mainContent.style.display = visible ? 'flex' : 'block';
        if (visible) {
            renderDeckBuilderPanel();
            if (wasHidden) {
                dom.deckBuilderPanel.scrollTop = 0;
                requestAnimationFrame(() => {
                    if (!dom.deckBuilderPanel.hidden) dom.deckBuilderPanel.scrollTop = 0;
                });
            }
        }
    }

    function createDeckBuilderCard(entry, options = {}) {
        const { isLeader = false } = options;
        const card = entry.card;
        const cardNumber = String(card?.cardNumber || '');
        const item = document.createElement('article');
        item.className = `deck-builder-card${isLeader ? ' is-leader' : ''}`;

        const imageShell = document.createElement('span');
        imageShell.className = 'deck-builder-card-image-shell';
        const imagePath = getCardImagePath(card, entry.variantIndex || 0);
        const fallback = document.createElement('span');
        fallback.className = 'deck-builder-card-fallback';
        fallback.textContent = cardNumber || '画像なし';
        fallback.hidden = Boolean(imagePath);

        if (imagePath) {
            const image = document.createElement('img');
            image.className = 'deck-builder-card-image';
            image.src = imagePath;
            image.alt = card?.cardName || cardNumber;
            image.loading = 'lazy';
            image.decoding = 'async';
            image.onerror = () => {
                image.remove();
                fallback.hidden = false;
            };
            imageShell.appendChild(image);
        }
        imageShell.appendChild(fallback);

        const count = document.createElement('span');
        count.className = 'deck-builder-card-count';
        count.textContent = String(entry.count || 1);
        imageShell.appendChild(count);
        item.appendChild(imageShell);

        const number = document.createElement('span');
        number.className = 'deck-builder-card-number';
        number.textContent = cardNumber || '未登録';
        number.title = [card?.cardName || cardNumber, entry.variantLabel].filter(Boolean).join(' · ');
        item.appendChild(number);

        if (entry.variantType && entry.variantType !== 'normal') {
            const variantLabel = document.createElement('span');
            variantLabel.className = 'deck-builder-card-variant';
            variantLabel.textContent = entry.variantLabel || getVariantTypeLabel(entry.variantType);
            item.appendChild(variantLabel);
        }

        if (!isLeader) {
            const stepper = document.createElement('div');
            stepper.className = 'deck-builder-card-stepper';
            stepper.setAttribute('role', 'group');
            stepper.setAttribute('aria-label', `${cardNumber}の枚数`);

            const minus = document.createElement('button');
            minus.type = 'button';
            minus.className = 'deck-builder-card-stepper-btn';
            minus.textContent = '−';
            minus.title = '1枚減らす';
            minus.setAttribute('aria-label', `${cardNumber}を1枚減らす`);
            minus.addEventListener('click', () => {
                setEditingDeckVariantCount(entry.key, Number(entry.count) - 1);
            });

            const plus = document.createElement('button');
            plus.type = 'button';
            plus.className = 'deck-builder-card-stepper-btn';
            plus.textContent = '+';
            plus.title = '1枚増やす';
            plus.setAttribute('aria-label', `${cardNumber}を1枚増やす`);
            plus.disabled = Number(editingDeckData[cardNumber] || 0) >= DECK_MAX_COPIES;
            plus.addEventListener('click', () => {
                setEditingDeckVariantCount(entry.key, Number(entry.count) + 1);
            });

            stepper.append(minus, plus);
            item.appendChild(stepper);
        } else {
            const variants = getCardImageVariants(card);
            if (variants.length > 1) {
                const select = document.createElement('select');
                select.className = 'deck-builder-leader-variant-select';
                select.setAttribute('aria-label', 'リーダー画像を選択');
                variants.forEach((variant, variantIndex) => {
                    const option = document.createElement('option');
                    option.value = getCardVariantId(card, variant, variantIndex);
                    option.textContent = variant.label || getVariantTypeLabel(getCardVariantType(variant, variantIndex));
                    select.appendChild(option);
                });
                select.value = editingDeckLeaderVariantId || cardNumber;
                select.addEventListener('change', () => {
                    editingDeckLeaderVariantId = select.value || cardNumber;
                    renderDeckBuilderPanel();
                });
                item.appendChild(select);
            }
        }
        return item;
    }

    function renderDeckBuilderPanel() {
        if (currentMode !== 'deck_edit' || !dom.deckBuilderPanel) return;
        const total = getDeckTotalCount();
        if (dom.deckBuilderMainCount) {
            dom.deckBuilderMainCount.textContent = `${total} / ${DECK_MAX_CARDS}`;
            dom.deckBuilderMainCount.classList.toggle('is-complete', total === DECK_MAX_CARDS);
            dom.deckBuilderMainCount.classList.toggle('is-over', total > DECK_MAX_CARDS);
        }

        if (dom.deckBuilderMainGrid) {
            const entries = getDeckImageEntries({
                cards: editingDeckData,
                cardVariants: editingDeckVariantData
            });
            dom.deckBuilderMainGrid.innerHTML = '';
            if (entries.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'deck-builder-empty';
                empty.textContent = 'カードはまだありません';
                dom.deckBuilderMainGrid.appendChild(empty);
            } else {
                const fragment = document.createDocumentFragment();
                entries.forEach(entry => fragment.appendChild(createDeckBuilderCard(entry)));
                dom.deckBuilderMainGrid.appendChild(fragment);
            }
        }

        if (dom.deckBuilderLeaderGrid) {
            const leaderEntry = getDeckLeaderVariantEntry({
                leader: editingDeckMeta.leader,
                leaderVariantId: editingDeckLeaderVariantId
            });
            dom.deckBuilderLeaderGrid.replaceChildren(createDeckBuilderCard({
                card: leaderEntry.card,
                count: 1,
                variantIndex: leaderEntry.variantIndex,
                variantType: leaderEntry.variantType,
                variantLabel: leaderEntry.variantLabel
            }, { isLeader: true }));
        }

        if (dom.deckParallelToggle) {
            dom.deckParallelToggle.checked = deckParallelSelectionEnabled;
        }
    }

    function updateDeckStatusBar() {
        if (!dom.deckStatusInfo) return;
        const total = getDeckTotalCount();
        const label = currentMode === 'deck_view' ? 'デッキ内容' : 'デッキ編集中';
        dom.deckStatusInfo.textContent = `${label}: ${total}/${DECK_MAX_CARDS}枚`;
        if (total === DECK_MAX_CARDS) {
            dom.deckStatusInfo.style.color = 'var(--color-secondary)';
        } else if (total > DECK_MAX_CARDS) {
            dom.deckStatusInfo.style.color = 'var(--color-error)';
        } else {
            dom.deckStatusInfo.style.color = '#fff';
        }
    }

    // ステータスバーのボタンをモードに合わせて切り替え
    function syncDeckStatusButtons() {
        if (dom.deckSaveBtn) {
            dom.deckSaveBtn.textContent = currentMode === 'deck_view'
                ? '編集'
                : currentMode === 'leader_select' && leaderSelectionPurpose === 'replace'
                    ? '戻る'
                    : '完了';
        }
    }

    // デッキ表示モード (読み取り専用)
    function startDeckView(deck) {
        const deckCardPool = getDeckCardPool();
        if (deckCardPool.length === 0) return;
        currentMode = 'deck_view';
        activeCardView = 'cards';
        viewingDeck = deck;
        editingDeckData = { ...(deck.cards || {}) }; // バッジ表示用 (読み取り専用)
        editingDeckVariantData = getDeckVariantCounts(deck);
        editingDeckLeaderVariantId = deck.leaderVariantId || deck.leader || '';
        deckParallelSelectionEnabled = false;

        showCardListView();
        populateFilters(deckCardPool);
        setDeckStatusBarVisible(true);
        syncDeckStatusButtons();
        setModeMessage(deck.name || 'デッキ表示');

        dom.searchBar.value = '';
        dom.clearSearchBtn.style.display = 'none';
        resetFilters();
        updateDeckStatusBar();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    // カードタップ時のモード別ふるまい
    function handleCardTap(index) {
        if (index < 0 || index >= currentFilteredCards.length) return;
        const card = currentFilteredCards[index];

        if (wantedSelectionMode && currentMode === 'view') {
            toggleWantedCardCount(card.cardNumber);
        } else if (currentMode === 'collection_edit') {
            adjustCollectionCard(card);
        } else if (currentMode === 'opening_edit') {
            adjustOpeningCard(card);
        } else if (currentMode === 'leader_select') {
            confirmLeaderSelection(card);
        } else if (currentMode === 'deck_edit') {
            toggleDeckCardCount(card);
        } else {
            // 'view' / 'deck_view' は拡大表示
            showLightbox(index);
        }
    }

    async function confirmLeaderSelection(card) {
        const colors = Array.isArray(card.color) ? card.color.join('/') : '';
        const selectedVariantId = card._displayVariantId || card.cardNumber;
        const selectedVariantLabel = card._displayVariantLabel && card._displayVariantType !== 'normal'
            ? `\nイラスト: ${card._displayVariantLabel}`
            : '';

        if (leaderSelectionPurpose === 'replace' && editingDeckId) {
            const isSameLeader = editingDeckMeta.leader === card.cardNumber;
            const message = isSameLeader
                ? `「${card.cardName}」のリーダー画像を変更します。${selectedVariantLabel}`
                : `リーダーを「${card.cardName}」(${colors}) に変更します。${selectedVariantLabel}\n現在のメインデッキは残ります。色条件に合わないカードは手動で調整してください。`;
            if (!await confirmDialog(message, {
                title: isSameLeader ? 'リーダー画像を変更' : 'リーダーを変更',
                confirmLabel: '変更する'
            })) return;

            editingDeckMeta.leader = card.cardNumber;
            editingDeckMeta.colors = Array.isArray(card.color) ? [...card.color] : [];
            editingDeckLeaderVariantId = selectedVariantId;
            returnToDeckEditAfterLeaderSelection();
            showMessageToast('リーダーを変更しました。完了を押すと保存されます。', 'success');
            return;
        }

        if (!await confirmDialog(`「${card.cardName}」(${colors}) をリーダーにします。${selectedVariantLabel}`, { title: 'リーダーを選択', confirmLabel: 'このリーダーで作成' })) return;

        const now = new Date().toISOString();
        const newDeck = {
            id: createDeckId(),
            name: `${card.cardName}デッキ`,
            leader: card.cardNumber,
            ...(selectedVariantId && selectedVariantId !== card.cardNumber
                ? { leaderVariantId: selectedVariantId }
                : {}),
            cards: {},
            ownedCards: {},
            ownedCardsLinked: true,
            tournaments: [],
            createdAt: now,
            updatedAt: now
        };
        await saveDeck(newDeck);
        startDeckEdit(newDeck);
    }

    function syncDeckCardBadges(cardNumber) {
        Object.entries(cardElementMap).forEach(([displayKey, cardItem]) => {
            if (displayKey !== cardNumber && !displayKey.startsWith(`${cardNumber}::`)) return;
            const count = displayKey.includes('::')
                ? Number(editingDeckVariantData[displayKey] || 0)
                : Number(editingDeckData[cardNumber] || 0);
            let badge = cardItem.querySelector('.card-deck-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'card-deck-badge';
                    cardItem.appendChild(badge);
                }
                badge.textContent = String(count);
                badge.dataset.count = String(count);
            } else if (badge) {
                badge.remove();
            }
        });
    }

    function applyEditingDeckVariantState(state, cardNumber) {
        editingDeckData = { ...(state?.cards || {}) };
        editingDeckVariantData = { ...(state?.cardVariants || {}) };
        syncDeckCardBadges(cardNumber);
        updateDeckStatusBar();
        renderDeckBuilderPanel();
    }

    function setEditingDeckCardCount(cardNumber, requestedCount) {
        const state = getDeckVariantsApi().setCardCount(
            editingDeckData,
            editingDeckVariantData,
            cardNumber,
            requestedCount,
            DECK_MAX_COPIES
        );
        applyEditingDeckVariantState(state, cardNumber);
    }

    function setEditingDeckVariantCount(key, requestedCount) {
        const parsed = getDeckVariantsApi().parseVariantKey(key);
        if (!parsed) return;
        const state = getDeckVariantsApi().setVariantCount(
            editingDeckData,
            editingDeckVariantData,
            key,
            requestedCount,
            DECK_MAX_COPIES
        );
        applyEditingDeckVariantState(state, parsed.cardNumber);
    }

    function toggleDeckCardCount(card) {
        const cardNumber = card?.cardNumber;
        if (!cardNumber) return;
        if (deckParallelSelectionEnabled) {
            const key = getCardDisplayVariantKey(card);
            const current = Number(editingDeckVariantData[key] || 0);
            const total = Number(editingDeckData[cardNumber] || 0);
            const maxForVariant = DECK_MAX_COPIES - (total - current);
            if (current === 0 && maxForVariant === 0) {
                showMessageToast(`${cardNumber}は合計${DECK_MAX_COPIES}枚までです。`, 'info');
                return;
            }
            const next = current + 1 > maxForVariant ? 0 : current + 1;
            setEditingDeckVariantCount(key, next);
            return;
        }
        let count = (editingDeckData[cardNumber] || 0) + 1;
        if (count > DECK_MAX_COPIES) count = 0;
        setEditingDeckCardCount(cardNumber, count);
    }

    function createDeckActionIcon(name) {
        const iconMarkup = {
            edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
            more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
            export: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
            share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
            image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><path d="M12 3v6"/><path d="m9 6 3 3 3-3"/>',
            print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
            list: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="8" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>',
            record: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v4a5 5 0 0 1-10 0Z"/><path d="M7 6H4v1a4 4 0 0 0 4 4"/><path d="M17 6h3v1a4 4 0 0 1-4 4"/>',
            copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
            delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>'
        };
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = iconMarkup[name] || iconMarkup.more;
        return svg;
    }

    function closeDeckActionMenu(restoreFocus = false) {
        if (!openDeckActionMenu) return;
        const { menu, button } = openDeckActionMenu;
        menu.hidden = true;
        menu.classList.remove('open-up');
        menu.removeAttribute('style');
        button.setAttribute('aria-expanded', 'false');
        openDeckActionMenu = null;
        if (restoreFocus) button.focus();
    }

    function positionDeckActionMenu(menu, button) {
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft || 0;
        const viewportTop = viewport?.offsetTop || 0;
        const viewportRight = viewportLeft + (viewport?.width || window.innerWidth);
        const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
        const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || viewportTop;
        const footerTop = document.querySelector('.app-footer')?.getBoundingClientRect().top || viewportBottom;
        const margin = 8;
        const gap = 6;
        const minTop = Math.max(viewportTop + margin, headerBottom + margin);
        const maxBottom = Math.min(viewportBottom - margin, footerTop - margin);
        const availableHeight = Math.max(120, maxBottom - minTop);

        menu.style.position = 'fixed';
        menu.style.left = '0px';
        menu.style.top = `${minTop}px`;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.style.maxHeight = `${availableHeight}px`;
        menu.style.visibility = 'hidden';

        const buttonRect = button.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const menuWidth = Math.min(menuRect.width, Math.max(0, viewportRight - viewportLeft - margin * 2));
        const menuHeight = Math.min(menuRect.height, availableHeight);
        const spaceBelow = maxBottom - buttonRect.bottom - gap;
        const spaceAbove = buttonRect.top - minTop - gap;
        const openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;
        const unclampedTop = openUp
            ? buttonRect.top - gap - menuHeight
            : buttonRect.bottom + gap;
        const top = Math.min(Math.max(unclampedTop, minTop), maxBottom - menuHeight);
        const left = Math.min(
            Math.max(buttonRect.right - menuWidth, viewportLeft + margin),
            viewportRight - margin - menuWidth
        );

        menu.classList.toggle('open-up', openUp);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menu.style.visibility = '';
    }

    function toggleDeckActionMenu(menu, button) {
        if (openDeckActionMenu?.menu === menu) {
            closeDeckActionMenu(true);
            return;
        }
        closeDeckActionMenu();
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        openDeckActionMenu = { menu, button };
        positionDeckActionMenu(menu, button);
    }

    function createDeckMenuItem(label, iconName, action, destructive = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `deck-menu-item${destructive ? ' destructive' : ''}`;
        button.setAttribute('role', 'menuitem');
        button.appendChild(createDeckActionIcon(iconName));
        const labelElement = document.createElement('span');
        labelElement.textContent = label;
        button.appendChild(labelElement);
        button.addEventListener('click', async event => {
            event.stopPropagation();
            closeDeckActionMenu();
            await action();
        });
        return button;
    }

    // === デッキ一覧 ===
    async function loadDeckList() {
        if (!db || !dom.deckListContainer) return;
        closeDeckActionMenu();
        let decks = [];
        try {
            decks = await db.getAll(STORE_DECKS);
        } catch (error) {
            console.error('Failed to load decks:', error);
        }
        decks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        dom.deckListContainer.innerHTML = '';
        if (decks.length === 0) {
            dom.deckListContainer.innerHTML = '<p class="no-decks">デッキがありません。<br>「新規デッキ」からリーダーを選んで作成できます。</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const deck of decks) {
            fragment.appendChild(createDeckListItem(deck));
        }
        dom.deckListContainer.appendChild(fragment);
    }

    function createDeckListItem(deck) {
        const leaderEntry = getDeckLeaderVariantEntry(deck);
        const leaderCard = leaderEntry.card;
        const total = Object.values(deck.cards || {}).reduce((sum, n) => sum + n, 0);
        const colors = leaderCard && Array.isArray(leaderCard.color) ? leaderCard.color.join('/') : '';
        const tournamentSummary = getDeckTournamentSummary(deck);

        const el = document.createElement('div');
        el.className = 'deck-item';
        el.addEventListener('click', () => startDeckView(deck));

        // リーダーサムネイル
        const thumb = document.createElement('div');
        thumb.className = 'deck-leader-thumb';
        const leaderImagePath = leaderCard ? getCardImagePath(leaderCard, leaderEntry.variantIndex) : '';
        if (leaderImagePath) {
            const img = document.createElement('img');
            img.src = leaderImagePath;
            img.alt = leaderCard.cardName || deck.leader;
            img.loading = 'lazy';
            img.onerror = () => { thumb.textContent = deck.leader || '?'; };
            thumb.appendChild(img);
        } else {
            thumb.textContent = deck.leader || '?';
        }
        el.appendChild(thumb);

        // デッキ情報
        const info = document.createElement('div');
        info.className = 'deck-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'deck-name';
        nameEl.textContent = deck.name || '(名称未設定)';
        nameEl.title = 'タップで名前を変更';
        nameEl.addEventListener('click', (e) => {
            e.stopPropagation();
            renameDeck(deck);
        });
        const metaEl = document.createElement('div');
        metaEl.className = 'deck-meta';
        metaEl.textContent = [
            colors,
            `${total}/${DECK_MAX_CARDS}枚`,
            tournamentSummary.matchCount > 0
                ? `大会${tournamentSummary.tournamentCount}件 ${formatMatchRecord(tournamentSummary)}`
                : '',
            `更新: ${new Date(deck.updatedAt).toLocaleDateString('ja-JP')}`
        ].filter(Boolean).join(' | ');
        info.appendChild(nameEl);
        info.appendChild(metaEl);
        el.appendChild(info);

        // 操作ボタン
        const actions = document.createElement('div');
        actions.className = 'deck-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'deck-btn btn-edit';
        editBtn.type = 'button';
        editBtn.title = 'デッキを編集';
        editBtn.setAttribute('aria-label', 'デッキを編集');
        editBtn.appendChild(createDeckActionIcon('edit'));
        const editLabel = document.createElement('span');
        editLabel.className = 'deck-edit-label';
        editLabel.textContent = '編集';
        editBtn.appendChild(editLabel);
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeDeckActionMenu();
            startDeckEdit(deck);
        });

        const moreBtn = document.createElement('button');
        moreBtn.className = 'deck-icon-btn';
        moreBtn.type = 'button';
        moreBtn.title = 'デッキ操作';
        moreBtn.setAttribute('aria-label', 'デッキ操作');
        moreBtn.setAttribute('aria-haspopup', 'menu');
        moreBtn.setAttribute('aria-expanded', 'false');
        moreBtn.appendChild(createDeckActionIcon('more'));

        const menu = document.createElement('div');
        menu.className = 'deck-action-menu';
        menu.id = `deck-menu-${deck.id}`;
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        moreBtn.setAttribute('aria-controls', menu.id);
        menu.appendChild(createDeckMenuItem('大会記録', 'record', () => openTournamentRecords(deck)));
        menu.appendChild(createDeckMenuItem('リスト表示', 'list', () => openDeckComposition(deck)));
        menu.appendChild(createDeckMenuItem('複製', 'copy', () => duplicateDeck(deck)));
        menu.appendChild(createDeckMenuItem('JSON出力', 'export', () => exportDeckJson(deck)));
        menu.appendChild(createDeckMenuItem('URLをコピー', 'share', () => copyDeckShareUrl(deck)));
        menu.appendChild(createDeckMenuItem('画像出力', 'image', () => exportDeckImage(deck)));
        menu.appendChild(createDeckMenuItem('プロキシ印刷', 'print', () => openProxyPrintForDeck(deck)));
        menu.appendChild(createDeckMenuItem('不足カードを共有', 'share', () => openMissingCardsModal(deck)));
        menu.appendChild(createDeckMenuItem('削除', 'delete', () => deleteDeck(deck), true));
        menu.addEventListener('click', event => event.stopPropagation());
        moreBtn.addEventListener('click', e => {
            e.stopPropagation();
            toggleDeckActionMenu(menu, moreBtn);
        });

        actions.appendChild(editBtn);
        actions.appendChild(moreBtn);
        actions.appendChild(menu);
        el.appendChild(actions);

        return el;
    }

    // === デッキ作成・編集フロー ===
    function startLeaderSelection(options = {}) {
        const deckCardPool = getDeckCardPool();
        if (deckCardPool.length === 0) {
            showMessageToast('カードデータが読み込まれていません。', 'error');
            return;
        }
        const purpose = options.purpose === 'replace' ? 'replace' : 'create';
        if (purpose === 'replace' && (!editingDeckId || !editingDeckMeta.leader)) return;
        leaderSelectionPurpose = purpose;
        currentMode = 'leader_select';
        activeCardView = 'cards';
        if (purpose === 'create') {
            deckParallelSelectionEnabled = false;
            setDeckStatusBarVisible(false);
        }
        showCardListView();
        populateFilters(deckCardPool);
        setModeMessage(purpose === 'replace'
            ? '変更するリーダーとイラストを選択してください'
            : 'リーダーカードとイラストを選択してください');
        syncDeckStatusButtons();

        dom.searchBar.value = '';
        dom.clearSearchBtn.style.display = 'none';
        resetFilters();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    function startLeaderChangeSelection() {
        startLeaderSelection({ purpose: 'replace' });
    }

    function returnToDeckEditAfterLeaderSelection() {
        const deckCardPool = getDeckCardPool();
        const leaderCard = findCardByNumber(editingDeckMeta.leader);
        const colors = Array.isArray(editingDeckMeta.colors) ? editingDeckMeta.colors : [];
        leaderSelectionPurpose = 'create';
        currentMode = 'deck_edit';
        showCardListView();
        populateFilters(deckCardPool);
        setDeckStatusBarVisible(true);
        syncDeckStatusButtons();
        const leaderLabel = leaderCard ? `${leaderCard.cardName} (${colors.join('/')})` : editingDeckMeta.leader;
        setModeMessage(`デッキ編集中: ${leaderLabel}`);
        dom.searchBar.value = '';
        dom.clearSearchBtn.style.display = 'none';
        resetFilters();
        updateDeckStatusBar();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    function startDeckEdit(deck) {
        const deckCardPool = getDeckCardPool();
        const leaderCard = findCardByNumber(deck.leader);
        const colors = leaderCard && Array.isArray(leaderCard.color) ? leaderCard.color : [];

        currentMode = 'deck_edit';
        activeCardView = 'cards';
        editingDeckId = deck.id;
        editingDeckData = { ...(deck.cards || {}) };
        editingDeckVariantData = getDeckVariantCounts(deck);
        editingDeckLeaderVariantId = deck.leaderVariantId || deck.leader || '';
        deckParallelSelectionEnabled = false;
        leaderSelectionPurpose = 'create';
        editingDeckMeta = {
            name: deck.name,
            leader: deck.leader,
            colors: colors,
            ownedCards: { ...(deck.ownedCards || {}) },
            ownedCardsLinked: deck.ownedCardsLinked === true,
            tournaments: getDeckTournamentRecords(deck),
            createdAt: deck.createdAt || new Date().toISOString()
        };
        showCardListView();
        populateFilters(deckCardPool);
        setDeckStatusBarVisible(true);
        syncDeckStatusButtons();
        const leaderLabel = leaderCard ? `${leaderCard.cardName} (${colors.join('/')})` : (deck.leader || '');
        setModeMessage(`デッキ編集中: ${leaderLabel}`);

        dom.searchBar.value = '';
        dom.clearSearchBtn.style.display = 'none';
        resetFilters();
        updateDeckStatusBar();
        applyFiltersAndDisplay();
        dom.mainContent.scrollTop = 0;
    }

    function exitDeckBuildingMode() {
        currentMode = 'view';
        activeCardView = 'cards';
        viewingDeck = null;
        editingDeckId = null;
        editingDeckData = {};
        editingDeckVariantData = {};
        editingDeckLeaderVariantId = '';
        deckParallelSelectionEnabled = false;
        leaderSelectionPurpose = 'create';
        editingDeckMeta = {};
        setDeckBuilderPanelVisible(false);
        setDeckStatusBarVisible(false);
        setModeMessage(null);
    }

    async function saveDeck(deck) {
        if (!db) return;
        const tx = db.transaction(STORE_DECKS, 'readwrite');
        await tx.store.put(deck);
        await tx.done;
    }

    async function saveCurrentDeck() {
        if (!editingDeckId) return;
        const cardVariants = getCompactDeckVariantCounts({
            cards: editingDeckData,
            cardVariants: editingDeckVariantData
        });
        const deckRequirements = {
            leader: editingDeckMeta.leader,
            cards: editingDeckData
        };
        await linkLegacyDeckOwnership({
            ...deckRequirements,
            ownedCards: editingDeckMeta.ownedCards || {},
            ownedCardsLinked: editingDeckMeta.ownedCardsLinked === true
        });
        const deck = {
            id: editingDeckId,
            name: editingDeckMeta.name,
            leader: editingDeckMeta.leader,
            cards: editingDeckData,
            ...(Object.keys(cardVariants).length > 0 ? { cardVariants } : {}),
            ...(editingDeckLeaderVariantId && editingDeckLeaderVariantId !== editingDeckMeta.leader
                ? { leaderVariantId: editingDeckLeaderVariantId }
                : {}),
            ownedCards: normalizeOwnedCardsForDeck(
                deckRequirements,
                getCollectionOwnedCardsForDeck(deckRequirements)
            ),
            ownedCardsLinked: true,
            tournaments: getDeckTournamentRecords(editingDeckMeta),
            createdAt: editingDeckMeta.createdAt,
            updatedAt: new Date().toISOString()
        };
        try {
            await saveDeck(deck);
            const total = getDeckTotalCount();
            if (total !== DECK_MAX_CARDS) {
                showMessageToast(`デッキを保存しました (${total}/${DECK_MAX_CARDS}枚)`, 'info');
            } else {
                showMessageToast('デッキを保存しました', 'success');
            }
        } catch (error) {
            console.error('Failed to save deck:', error);
            showMessageToast('デッキの保存に失敗しました。', 'error');
            return;
        }

        exitDeckBuildingMode();
        setActiveNav('decks');
        showDeckListView();
        applyFiltersAndDisplay();
        loadDeckList();
    }

    async function deleteDeck(deck) {
        if (!await confirmDialog(`デッキ「${deck.name}」を削除します。`, { title: 'デッキを削除', confirmLabel: '削除', danger: true })) return;
        try {
            await db.delete(STORE_DECKS, deck.id);
            showMessageToast('デッキを削除しました。', 'success');
        } catch (error) {
            console.error('Failed to delete deck:', error);
            showMessageToast('デッキの削除に失敗しました。', 'error');
        }
        loadDeckList();
    }

    async function getUniqueDuplicatedDeckName(baseName) {
        const normalizedBase = normalizeDeckName(baseName, 'デッキ');
        const decks = await db.getAll(STORE_DECKS);
        const existingNames = new Set(decks.map(item => item.name));
        const copyBase = `${normalizedBase} (複製)`;
        if (!existingNames.has(copyBase)) return copyBase;
        let suffix = 2;
        while (existingNames.has(`${copyBase} ${suffix}`)) suffix += 1;
        return `${copyBase} ${suffix}`;
    }

    async function duplicateDeck(deck) {
        if (!db || !deck) return;
        const now = new Date().toISOString();
        const cardVariants = getCompactDeckVariantCounts(deck);
        const duplicated = {
            id: createDeckId(),
            name: await getUniqueDuplicatedDeckName(deck.name),
            leader: deck.leader,
            cards: { ...(deck.cards || {}) },
            ...(Object.keys(cardVariants).length > 0 ? { cardVariants } : {}),
            ...(deck.leaderVariantId && deck.leaderVariantId !== deck.leader
                ? { leaderVariantId: deck.leaderVariantId }
                : {}),
            ownedCards: { ...(deck.ownedCards || {}) },
            ownedCardsLinked: deck.ownedCardsLinked === true,
            tournaments: [],
            createdAt: now,
            updatedAt: now
        };
        try {
            await saveDeck(duplicated);
            await loadDeckList();
            showMessageToast(`「${duplicated.name}」を複製しました。`, 'success');
        } catch (error) {
            console.error('Failed to duplicate deck:', error);
            showMessageToast('デッキの複製に失敗しました。', 'error');
        }
    }

    async function renameDeck(deck) {
        let newName = null;
        try {
            newName = await promptDialog('デッキ名を入力してください', deck.name || '', { title: 'デッキ名の変更', confirmLabel: '変更' });
        } catch (e) {
            return;
        }
        if (newName === null) return;
        newName = newName.trim();
        if (!newName) return;

        deck.name = newName;
        deck.updatedAt = new Date().toISOString();
        try {
            await saveDeck(deck);
        } catch (error) {
            console.error('Failed to rename deck:', error);
            showMessageToast('デッキ名の変更に失敗しました。', 'error');
        }
        loadDeckList();
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
             const input = await promptDialog("すべてのデータを削除します。よろしければ yes と入力してください。", "", { title: '全データ削除', confirmLabel: '削除する', danger: true, placeholder: 'yes' });
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

    async function refreshAppCache() {
        if (!await confirmDialog(
            '保存デッキ・所持カード・設定は残したまま、アプリと画像解析のキャッシュを更新します。',
            { title: 'キャッシュを更新', confirmLabel: '更新する' }
        )) return;

        const button = dom.refreshAppCacheBtn;
        if (button) {
            button.disabled = true;
            button.textContent = '更新中...';
        }
        try {
            const cachePrefixes = [
                'app-shell-',
                'card-data-',
                'card-images-',
                'op-tcg-browser-analyzer-'
            ];
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter(name => cachePrefixes.some(prefix => name.startsWith(prefix)))
                    .map(name => caches.delete(name))
            );

            if ('serviceWorker' in navigator) {
                const registrations = typeof navigator.serviceWorker.getRegistrations === 'function'
                    ? await navigator.serviceWorker.getRegistrations()
                    : [await navigator.serviceWorker.getRegistration()].filter(Boolean);
                await Promise.all(registrations.map(registration => registration.update().catch(() => null)));
                registrations.forEach(registration => {
                    registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
                });
            }

            showMessageToast('ユーザーデータを保持したままキャッシュを更新しました。再読み込みします。', 'success');
            setTimeout(() => window.location.reload(), 900);
        } catch (error) {
            console.error('Failed to refresh app cache:', error);
            showMessageToast('キャッシュを更新できませんでした。', 'error');
            if (button) {
                button.disabled = false;
                button.textContent = 'キャッシュを更新';
            }
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

    function showDbUpdateNotification(serverLastModified, cardsData = null, cardsHash = '', diff = null) {
        dom.dbUpdateNotification.style.display = 'none';
        dom.dbUpdateNotification.style.display = 'flex';

        if (dom.dbUpdateText) {
            const summary = formatCardsDiffSummary(diff);
            dom.dbUpdateText.textContent = summary
                ? `カードデータが更新されました (${summary})。`
                : 'カードデータが更新されました。';
        }

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
            fetchAndUpdateCardData(serverLastModified, cardsData, cardsHash, diff);
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

    // === 確認・入力ダイアログ =============================================
    // ネイティブの confirm/prompt は PWA だと OS 標準の見た目で割り込むうえ、
    // 環境によっては抑制される。アプリ内のモーダルに統一する。
    let activeDialogResolve = null;

    function closeAppDialog(result) {
        if (!dom.appDialogModal) return;
        dom.appDialogModal.style.display = 'none';
        dom.appDialogInput.hidden = true;
        dom.appDialogInput.value = '';
        const resolve = activeDialogResolve;
        activeDialogResolve = null;
        if (resolve) resolve(result);
    }

    function openAppDialog({ title = '確認', message = '', confirmLabel = 'OK', cancelLabel = 'キャンセル', danger = false, input = null }) {
        // ダイアログが無い環境ではネイティブにフォールバック
        if (!dom.appDialogModal) {
            if (input) return Promise.resolve(window.prompt(message, input.value || ''));
            return Promise.resolve(window.confirm(message) ? true : null);
        }
        if (activeDialogResolve) closeAppDialog(null);

        dom.appDialogTitle.textContent = title;
        dom.appDialogMessage.textContent = message;
        dom.appDialogConfirmBtn.textContent = confirmLabel;
        dom.appDialogCancelBtn.textContent = cancelLabel;
        dom.appDialogConfirmBtn.classList.toggle('modal-btn-danger', Boolean(danger));
        dom.appDialogConfirmBtn.classList.toggle('modal-btn-primary', !danger);

        if (input) {
            dom.appDialogInput.hidden = false;
            dom.appDialogInput.value = input.value || '';
            dom.appDialogInput.placeholder = input.placeholder || '';
        } else {
            dom.appDialogInput.hidden = true;
        }

        dom.appDialogModal.style.display = 'flex';
        setTimeout(() => {
            if (input) dom.appDialogInput.focus();
            else dom.appDialogConfirmBtn.focus();
        }, 50);

        return new Promise((resolve) => {
            activeDialogResolve = resolve;
        });
    }

    // 押されたら true、キャンセルなら false
    async function confirmDialog(message, options = {}) {
        const result = await openAppDialog({ message, ...options });
        return result !== null && result !== false;
    }

    // 入力された文字列。キャンセルなら null
    function promptDialog(message, defaultValue = '', options = {}) {
        return openAppDialog({
            message,
            confirmLabel: options.confirmLabel || '決定',
            ...options,
            input: { value: defaultValue, placeholder: options.placeholder || '' }
        });
    }

    function setupAppDialogEvents() {
        if (!dom.appDialogModal) return;
        dom.appDialogConfirmBtn.addEventListener('click', () => {
            closeAppDialog(dom.appDialogInput.hidden ? true : dom.appDialogInput.value);
        });
        dom.appDialogCancelBtn.addEventListener('click', () => closeAppDialog(null));
        dom.appDialogModal.addEventListener('click', (event) => {
            if (event.target === dom.appDialogModal) closeAppDialog(null);
        });
        dom.appDialogInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                closeAppDialog(dom.appDialogInput.value);
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && activeDialogResolve) closeAppDialog(null);
        });
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
        setupAppDialogEvents();

        if (!dom.searchBar) return;

        document.addEventListener('click', () => closeDeckActionMenu());
        window.addEventListener('resize', () => {
            if (openDeckActionMenu) {
                positionDeckActionMenu(openDeckActionMenu.menu, openDeckActionMenu.button);
            }
        });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                if (openDeckActionMenu) {
                    positionDeckActionMenu(openDeckActionMenu.menu, openDeckActionMenu.button);
                }
            });
        }
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                if (dom.tournamentRecordsModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeTournamentRecords();
                } else if (dom.deckCompositionModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeDeckComposition();
                } else if (dom.deckImagePreviewModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeDeckImagePreview();
                } else if (dom.openingFormModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeOpeningForm();
                } else if (dom.collectionModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeCollectionManager();
                } else if (dom.missingCardsModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeMissingCardsModal();
                } else if (dom.sharedDeckConfirmModal?.style.display !== 'none') {
                    event.preventDefault();
                    resolveSharedDeckImportConfirmation(false);
                } else if (dom.sharedDeckUrlModal?.style.display !== 'none') {
                    event.preventDefault();
                    closeSharedDeckUrlImport();
                } else if (openDeckActionMenu) {
                    event.preventDefault();
                    closeDeckActionMenu(true);
                }
            }
        });
        window.addEventListener('hashchange', () => {
            importDeckFromCurrentHash();
        });

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

        if (dom.wantedListBtn) {
            dom.wantedListBtn.addEventListener('click', () => {
                if (wantedSelectionMode) finishWantedCardsSelection();
                else startWantedCardsSelection();
            });
        }

        if (dom.collectionBtn) {
            dom.collectionBtn.addEventListener('click', showCollectionManager);
        }

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
        dom.filterOptionsContainer.addEventListener('click', handleFilterPresetClick);

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
                    if (input && !input.disabled && !input.checked) {
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
        dom.refreshAppCacheBtn?.addEventListener('click', refreshAppCache);
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
        if (dom.deckImagePreviewCloseBtn) {
            dom.deckImagePreviewCloseBtn.addEventListener('click', closeDeckImagePreview);
        }
        if (dom.deckImagePreviewModal) {
            dom.deckImagePreviewModal.addEventListener('click', event => {
                if (event.target === dom.deckImagePreviewModal) closeDeckImagePreview();
            });
        }
        if (dom.deckImagePreviewDownloadBtn) {
            dom.deckImagePreviewDownloadBtn.addEventListener('click', downloadDeckImagePreview);
        }
        if (dom.deckImagePreviewShareBtn) {
            dom.deckImagePreviewShareBtn.addEventListener('click', shareOrSaveDeckImage);
        }
        if (dom.missingCardsCloseBtn) {
            dom.missingCardsCloseBtn.addEventListener('click', closeMissingCardsModal);
        }
        if (dom.missingCardsModal) {
            dom.missingCardsModal.addEventListener('click', event => {
                if (event.target === dom.missingCardsModal) closeMissingCardsModal();
            });
        }
        if (dom.missingCardsClearBtn) {
            dom.missingCardsClearBtn.addEventListener('click', () => setAllMissingOwnedCards(false));
        }
        if (dom.missingCardsFillBtn) {
            dom.missingCardsFillBtn.addEventListener('click', () => setAllMissingOwnedCards(true));
        }
        if (dom.missingCardsCopyBtn) {
            dom.missingCardsCopyBtn.addEventListener('click', copyMissingCardsList);
        }
        if (dom.missingCardsImageBtn) {
            dom.missingCardsImageBtn.addEventListener('click', exportMissingCardsImage);
        }
        if (dom.missingCardsShareBtn) {
            dom.missingCardsShareBtn.addEventListener('click', shareMissingCardsList);
        }
        if (dom.deckCompositionCloseBtn) {
            dom.deckCompositionCloseBtn.addEventListener('click', closeDeckComposition);
        }
        if (dom.deckCompositionDoneBtn) {
            dom.deckCompositionDoneBtn.addEventListener('click', closeDeckComposition);
        }
        if (dom.deckCompositionModal) {
            dom.deckCompositionModal.addEventListener('click', event => {
                if (event.target === dom.deckCompositionModal) closeDeckComposition();
            });
        }
        if (dom.tournamentRecordsCloseBtn) {
            dom.tournamentRecordsCloseBtn.addEventListener('click', closeTournamentRecords);
        }
        if (dom.tournamentRecordsDoneBtn) {
            dom.tournamentRecordsDoneBtn.addEventListener('click', closeTournamentRecords);
        }
        if (dom.tournamentRecordsModal) {
            dom.tournamentRecordsModal.addEventListener('click', event => {
                if (event.target === dom.tournamentRecordsModal) closeTournamentRecords();
            });
        }
        if (dom.tournamentForm) {
            dom.tournamentForm.addEventListener('submit', submitTournamentForm);
        }
        if (dom.tournamentFormCancelBtn) {
            dom.tournamentFormCancelBtn.addEventListener('click', resetTournamentForm);
        }
        if (dom.tournamentRecordsList) {
            dom.tournamentRecordsList.addEventListener('click', handleTournamentRecordsAction);
            dom.tournamentRecordsList.addEventListener('submit', submitTournamentMatchForm);
        }
        if (dom.collectionCloseBtn) {
            dom.collectionCloseBtn.addEventListener('click', closeCollectionManager);
        }
        if (dom.collectionModal) {
            dom.collectionModal.addEventListener('click', event => {
                if (event.target === dom.collectionModal) closeCollectionManager();
            });
        }
        if (dom.collectionViewBtn) {
            dom.collectionViewBtn.addEventListener('click', startCollectionEdit);
        }
        if (dom.openingNewBtn) {
            dom.openingNewBtn.addEventListener('click', () => openOpeningForm());
        }
        if (dom.collectionExportBtn) {
            dom.collectionExportBtn.addEventListener('click', exportCollectionJson);
        }
        if (dom.collectionImportBtn) {
            dom.collectionImportBtn.addEventListener('click', () => dom.collectionImportInput?.click());
        }
        if (dom.collectionImportInput) {
            dom.collectionImportInput.addEventListener('change', event => {
                importCollectionJson(event.target.files?.[0]);
            });
        }
        if (dom.openingFormCloseBtn) {
            dom.openingFormCloseBtn.addEventListener('click', closeOpeningForm);
        }
        if (dom.openingFormCancelBtn) {
            dom.openingFormCancelBtn.addEventListener('click', closeOpeningForm);
        }
        if (dom.openingFormModal) {
            dom.openingFormModal.addEventListener('click', event => {
                if (event.target === dom.openingFormModal) closeOpeningForm();
            });
        }
        if (dom.openingFormSubmitBtn) {
            dom.openingFormSubmitBtn.addEventListener('click', submitOpeningForm);
        }
        if (dom.collectionMinusBtn) {
            dom.collectionMinusBtn.addEventListener('click', () => {
                collectionAdjustDirection = -1;
                syncCollectionStatusBar();
            });
        }
        if (dom.collectionPlusBtn) {
            dom.collectionPlusBtn.addEventListener('click', () => {
                collectionAdjustDirection = 1;
                syncCollectionStatusBar();
            });
        }
        if (dom.collectionOwnedToggleBtn) {
            dom.collectionOwnedToggleBtn.addEventListener('click', () => {
                collectionShowOnlyOwned = !collectionShowOnlyOwned;
                syncCollectionStatusBar();
                applyFiltersAndDisplay();
            });
        }
        if (dom.collectionImageBtn) {
            dom.collectionImageBtn.addEventListener('click', () => {
                if (currentMode === 'opening_edit') exportOpeningSessionImage(activeOpeningSession);
                else exportCurrentCollectionImage();
            });
        }
        if (dom.collectionDoneBtn) {
            dom.collectionDoneBtn.addEventListener('click', async () => {
                if (currentMode === 'opening_edit') {
                    await finalizeOpeningSession();
                } else {
                    await leaveCollectionTrackingMode();
                    await showCollectionManager();
                }
            });
        }
        if (dom.sharedDeckConfirmCloseBtn) {
            dom.sharedDeckConfirmCloseBtn.addEventListener('click', () => {
                resolveSharedDeckImportConfirmation(false);
            });
        }
        if (dom.sharedDeckConfirmCancelBtn) {
            dom.sharedDeckConfirmCancelBtn.addEventListener('click', () => {
                resolveSharedDeckImportConfirmation(false);
            });
        }
        if (dom.sharedDeckConfirmAcceptBtn) {
            dom.sharedDeckConfirmAcceptBtn.addEventListener('click', () => {
                resolveSharedDeckImportConfirmation(true);
            });
        }
        if (dom.sharedDeckConfirmModal) {
            dom.sharedDeckConfirmModal.addEventListener('click', event => {
                if (event.target === dom.sharedDeckConfirmModal) {
                    resolveSharedDeckImportConfirmation(false);
                }
            });
        }
        if (dom.sharedDeckUrlCloseBtn) {
            dom.sharedDeckUrlCloseBtn.addEventListener('click', closeSharedDeckUrlImport);
        }
        if (dom.sharedDeckUrlCancelBtn) {
            dom.sharedDeckUrlCancelBtn.addEventListener('click', closeSharedDeckUrlImport);
        }
        if (dom.sharedDeckUrlModal) {
            dom.sharedDeckUrlModal.addEventListener('click', event => {
                if (event.target === dom.sharedDeckUrlModal) closeSharedDeckUrlImport();
            });
        }
        if (dom.sharedDeckUrlPasteBtn) {
            dom.sharedDeckUrlPasteBtn.addEventListener('click', pasteSharedDeckUrl);
        }
        if (dom.sharedDeckUrlSubmitBtn) {
            dom.sharedDeckUrlSubmitBtn.addEventListener('click', importSharedDeckFromText);
        }
        if (dom.sharedDeckUrlInput) {
            dom.sharedDeckUrlInput.addEventListener('input', () => setSharedDeckUrlStatus());
            dom.sharedDeckUrlInput.addEventListener('keydown', event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    importSharedDeckFromText();
                }
            });
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
            cardListLongPressed = false;

            // 選択モード中はロングプレスで拡大表示
            if (currentMode !== 'view' || wantedSelectionMode) {
                const cardItem = cardListTapElement.closest('.card-item');
                if (cardItem && cardItem.dataset.index) {
                    const index = parseInt(cardItem.dataset.index, 10);
                    clearTimeout(cardListLongPressTimer);
                    cardListLongPressTimer = setTimeout(() => {
                        if (cardListTapMoveY < 20) {
                            cardListLongPressed = true;
                            if (navigator.vibrate) navigator.vibrate(50);
                            showLightbox(index);
                        }
                    }, 500);
                }
            }
        }, { passive: true });

        dom.cardListContainer.addEventListener('touchmove', (e) => {
            if (cardListTapStartY === 0) return;
            cardListTapMoveY = Math.abs(e.touches[0].clientY - cardListTapStartY);
            if (cardListTapMoveY >= 20) {
                clearTimeout(cardListLongPressTimer);
            }
        }, { passive: true });

        dom.cardListContainer.addEventListener('touchend', (e) => {
            clearTimeout(cardListLongPressTimer);
            if (cardListTapElement && cardListTapMoveY < 20) {
                const cardItem = cardListTapElement.closest('.card-item');
                if (cardItem && cardItem.dataset.index) {
                    if (e.cancelable) e.preventDefault();
                    if (!cardListLongPressed) {
                        handleCardTap(parseInt(cardItem.dataset.index, 10));
                    }
                }
            }
            cardListTapElement = null;
            cardListTapStartY = 0;
            cardListTapMoveY = 0;
            cardListLongPressed = false;
        });

        dom.cardListContainer.addEventListener('click', (e) => {
            const cardItem = e.target.closest('.card-item');
            if (!cardItem || !cardItem.dataset.index) return;
            handleCardTap(parseInt(cardItem.dataset.index, 10));
        });

        // === デッキ構築 (フッターナビ・デッキ操作) ===
        if (dom.navCards) {
            dom.navCards.addEventListener('click', async () => {
                if (currentMode === 'leader_select' || currentMode === 'deck_edit') {
                    if (!await confirmDialog('デッキの作成・編集を中断します。未保存の変更は破棄されます。', { title: '編集を中断', confirmLabel: '破棄して移動', danger: true })) return;
                }
                if (currentMode === 'collection_edit' || currentMode === 'opening_edit') {
                    await leaveCollectionTrackingMode();
                } else if (currentMode !== 'view') {
                    exitDeckBuildingMode();
                }
                activeCardView = 'cards';
                setActiveNav('cards');
                showCardListView();
                populateFilters(allCards);
                if (wantedSelectionMode) {
                    setModeMessage('欲しいカードをタップして枚数を選択してください');
                }
                applyFiltersAndDisplay();
            });
        }

        if (dom.navDecks) {
            dom.navDecks.addEventListener('click', async () => {
                if (currentMode === 'leader_select' || currentMode === 'deck_edit') {
                    if (!await confirmDialog('デッキの作成・編集を中断します。未保存の変更は破棄されます。', { title: '編集を中断', confirmLabel: '破棄して移動', danger: true })) return;
                }
                if (wantedSelectionMode) finishWantedCardsSelection();
                if (currentMode === 'collection_edit' || currentMode === 'opening_edit') {
                    await leaveCollectionTrackingMode();
                } else {
                    exitDeckBuildingMode();
                }
                setActiveNav('decks');
                showDeckListView();
                loadDeckList();
            });
        }

        if (dom.navNew) {
            dom.navNew.addEventListener('click', async () => {
                if (currentMode === 'leader_select' || currentMode === 'deck_edit') {
                    if (!await confirmDialog('デッキの作成・編集を中断します。未保存の変更は破棄されます。', { title: '編集を中断', confirmLabel: '破棄して移動', danger: true })) return;
                }
                if (currentMode === 'collection_edit' || currentMode === 'opening_edit') {
                    await leaveCollectionTrackingMode();
                } else if (currentMode !== 'view') {
                    exitDeckBuildingMode();
                }
                activeCardView = 'new';
                setActiveNav('new');
                showCardListView();
                populateFilters(getProvisionalCardsForDisplay());
                dom.searchBar.value = '';
                dom.clearSearchBtn.style.display = 'none';
                resetFilters();
                if (wantedSelectionMode) {
                    setModeMessage('欲しいカードをタップして枚数を選択してください');
                }
                applyFiltersAndDisplay();
                dom.mainContent.scrollTop = 0;
            });
        }

        if (dom.createNewDeckBtn) {
            dom.createNewDeckBtn.addEventListener('click', startLeaderSelection);
        }
        if (dom.importSharedDeckBtn) {
            dom.importSharedDeckBtn.addEventListener('click', openSharedDeckUrlImport);
        }
        if (dom.deckSaveBtn) {
            dom.deckSaveBtn.addEventListener('click', () => {
                if (currentMode === 'deck_view' && viewingDeck) {
                    startDeckEdit(viewingDeck); // 表示 → 編集へ移行
                } else if (currentMode === 'leader_select' && leaderSelectionPurpose === 'replace') {
                    returnToDeckEditAfterLeaderSelection();
                } else {
                    saveCurrentDeck();
                }
            });
        }
        if (dom.deckListPreviewBtn) {
            dom.deckListPreviewBtn.addEventListener('click', openCurrentDeckComposition);
        }
        if (dom.deckParallelToggle) {
            dom.deckParallelToggle.addEventListener('change', () => {
                if (currentMode !== 'deck_edit') return;
                deckParallelSelectionEnabled = dom.deckParallelToggle.checked;
                applyFiltersAndDisplay();
                renderDeckBuilderPanel();
            });
        }
        if (dom.deckChangeLeaderBtn) {
            dom.deckChangeLeaderBtn.addEventListener('click', startLeaderChangeSelection);
        }
        if (dom.wantedShowToggleBtn) {
            dom.wantedShowToggleBtn.addEventListener('click', () => {
                wantedShowOnlySelected = !wantedShowOnlySelected;
                syncWantedListControls();
                applyFiltersAndDisplay();
            });
        }
        if (dom.wantedImageBtn) {
            dom.wantedImageBtn.addEventListener('click', exportWantedCardsImage);
        }
        if (dom.wantedDoneBtn) {
            dom.wantedDoneBtn.addEventListener('click', finishWantedCardsSelection);
        }

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
