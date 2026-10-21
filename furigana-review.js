(function() {
    'use strict';

    const MASTER_PATH = './furigana-master.json';
    const CARDS_PATH = './cards.json';
    const PROVISIONAL_PATH = './provisional-cards.json';
    const IMAGE_MANIFEST_PATH = './image-manifest.json';
    const OCR_CHANNEL = 'op-tcg-furigana-ocr';
    const OCR_TIMEOUT_MS = 120000;
    const PAGE_SIZE = 30;
    const GITHUB_OWNER = 'tksaai';
    const GITHUB_REPO = 'OP_TCG_DB';
    const GITHUB_BRANCH = 'main';
    const GITHUB_TOKEN_STORAGE_KEY = 'githubToken';

    let cards = [];
    let master = { version: 1, entries: {} };
    let imageManifest = { cards: {} };
    let groupedEntries = [];
    let visibleLimit = PAGE_SIZE;
    let changedNames = new Set();
    let ocrReady = false;
    let resolveOcrReady;
    const ocrReadyPromise = new Promise(resolve => {
        resolveOcrReady = resolve;
    });
    let ocrRequestSequence = 0;
    const ocrRequests = new Map();

    const dom = {
        statusFilter: document.getElementById('status-filter'),
        typeFilter: document.getElementById('type-filter'),
        seriesFilter: document.getElementById('series-filter'),
        searchInput: document.getElementById('search-input'),
        resultCount: document.getElementById('result-count'),
        ocrGlobalStatus: document.getElementById('ocr-global-status'),
        reviewList: document.getElementById('review-list'),
        loadMoreBtn: document.getElementById('load-more-btn'),
        template: document.getElementById('review-item-template'),
        verifiedCount: document.getElementById('verified-count'),
        suggestedCount: document.getElementById('suggested-count'),
        pendingCount: document.getElementById('pending-count'),
        changeCount: document.getElementById('change-count'),
        copyJsonBtn: document.getElementById('copy-json-btn'),
        downloadJsonBtn: document.getElementById('download-json-btn'),
        githubSaveBtn: document.getElementById('github-save-btn')
    };
    dom.ocrFrame = document.getElementById('furigana-ocr-frame');

    function toKatakana(value = '') {
        return String(value).replace(/[\u3041-\u3096]/g, character => (
            String.fromCharCode(character.charCodeAt(0) + 0x60)
        ));
    }

    function normalizeReading(value = '') {
        return toKatakana(String(value).normalize('NFKC'))
            .replace(/\s+/g, '')
            .replace(/[^ァ-ヺー・]/g, '');
    }

    function entryForName(cardName) {
        if (!master.entries[cardName]) {
            master.entries[cardName] = { reading: '', status: 'pending', source: 'new-card' };
        }
        return master.entries[cardName];
    }

    function preferredImage(card) {
        const variants = imageManifest?.cards?.[card.cardNumber] || [];
        const official = variants.find(variant => variant.source === 'official' && Number(variant.variantIndex || 0) === 0)
            || variants.find(variant => variant.source === 'official')
            || variants[0];
        return official?.path || card.imagePath || card.provisionalImageUrl || '';
    }

    function buildGroups() {
        const groups = new Map();
        for (const card of cards) {
            const name = String(card?.cardName || '').trim();
            if (!name) continue;
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(card);
        }
        groupedEntries = [...groups.entries()].map(([cardName, variants]) => {
            const representative = variants.find(card => preferredImage(card)) || variants[0];
            return { cardName, cards: variants, representative, entry: entryForName(cardName) };
        });
    }

    function refreshCounts() {
        const counts = { verified: 0, suggested: 0, pending: 0 };
        for (const entry of Object.values(master.entries || {})) {
            if (counts[entry.status] !== undefined) counts[entry.status] += 1;
        }
        dom.verifiedCount.textContent = counts.verified;
        dom.suggestedCount.textContent = counts.suggested;
        dom.pendingCount.textContent = counts.pending;
        dom.changeCount.textContent = changedNames.size > 0 ? `${changedNames.size}件変更` : '変更なし';
    }

    function populateSeries() {
        const series = [...new Set(cards.map(card => String(card.seriesCode || '').trim()).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right, 'ja', { numeric: true }));
        for (const value of series) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            dom.seriesFilter.append(option);
        }
    }

    function filteredGroups() {
        const status = dom.statusFilter.value;
        const type = dom.typeFilter.value;
        const series = dom.seriesFilter.value;
        const query = String(dom.searchInput.value || '').trim().toUpperCase();
        return groupedEntries.filter(group => {
            const entryStatus = group.entry.status || 'pending';
            if (status === 'review' && entryStatus === 'verified') return false;
            if (!['all', 'review'].includes(status) && entryStatus !== status) return false;
            if (type !== 'all' && !group.cards.some(card => card.cardType === type)) return false;
            if (series !== 'all' && !group.cards.some(card => card.seriesCode === series)) return false;
            if (query) {
                const haystack = [group.cardName, ...group.cards.map(card => card.cardNumber)].join(' ').toUpperCase();
                if (!haystack.includes(query)) return false;
            }
            return true;
        }).sort((left, right) => {
            const order = { pending: 0, suggested: 1, verified: 2 };
            const statusCompare = (order[left.entry.status] ?? 3) - (order[right.entry.status] ?? 3);
            return statusCompare || left.representative.cardNumber.localeCompare(right.representative.cardNumber, 'en', { numeric: true });
        });
    }

    function cropSettings(cardType) {
        if (cardType === 'EVENT') return { visualTop: 0.84, visualHeight: 0.105, rubyTop: 0.86, rubyHeight: 0.017 };
        return { visualTop: 0.755, visualHeight: 0.13, rubyTop: 0.77, rubyHeight: 0.022 };
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('カード画像を読み込めませんでした。'));
            image.src = url;
        });
    }

    function drawTitleCrop(canvas, image, cardType) {
        const settings = cropSettings(cardType);
        const sourceY = Math.round(image.naturalHeight * settings.visualTop);
        const sourceHeight = Math.round(image.naturalHeight * settings.visualHeight);
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, sourceY, image.naturalWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    }

    async function createRubyCanvas(image, cardType) {
        const settings = cropSettings(cardType);
        const scale = 20;
        const padding = 80;
        const sourceX = Math.round(image.naturalWidth * 0.045);
        const sourceY = Math.round(image.naturalHeight * settings.rubyTop);
        const sourceWidth = Math.round(image.naturalWidth * 0.91);
        const sourceHeight = Math.max(10, Math.round(image.naturalHeight * settings.rubyHeight));
        const canvas = document.createElement('canvas');
        canvas.width = sourceWidth * scale + padding * 2;
        canvas.height = sourceHeight * scale + padding * 2;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
        const sample = context.getImageData(0, 0, 1, 1).data;
        context.fillStyle = `rgb(${sample[0]}, ${sample[1]}, ${sample[2]})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(
            image,
            sourceX, sourceY, sourceWidth, sourceHeight,
            padding, padding, sourceWidth * scale, sourceHeight * scale
        );
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('OCR用画像を準備できませんでした。'));
            }, 'image/png');
        });
    }

    async function ensureOcrReady() {
        if (ocrReady) return;
        dom.ocrFrame?.contentWindow?.postMessage({ channel: OCR_CHANNEL, type: 'ping' }, '*');
        let timeout;
        try {
            await Promise.race([
                ocrReadyPromise,
                new Promise((resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error('OCRライブラリを準備できませんでした。')), 20000);
                })
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }

    function recognizeRubyImage(image) {
        if (!dom.ocrFrame?.contentWindow) {
            return Promise.reject(new Error('OCRの隔離領域を準備できませんでした。'));
        }
        const requestId = `ocr-${Date.now()}-${ocrRequestSequence += 1}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                ocrRequests.delete(requestId);
                reject(new Error('画像解析がタイムアウトしました。'));
            }, OCR_TIMEOUT_MS);
            ocrRequests.set(requestId, { resolve, reject, timeout });
            dom.ocrFrame.contentWindow.postMessage({
                channel: OCR_CHANNEL,
                type: 'recognize',
                requestId,
                image
            }, '*');
        });
    }

    function buildReadingCandidate(cardName, rawOcr) {
        const tokens = String(rawOcr || '').trim().split(/\s+/).map(token => token.replace(/[^ぁ-んー]/g, '')).filter(Boolean);
        const kanjiRuns = cardName.match(/[一-龯々〆ヶ]+/gu) || [];
        if (kanjiRuns.length === 0) return normalizeReading(cardName);
        if (tokens.length !== kanjiRuns.length) return '';
        let index = 0;
        const replaced = cardName.replace(/[一-龯々〆ヶ]+/gu, () => tokens[index++] || '');
        return normalizeReading(replaced);
    }

    function markChanged(group, source) {
        group.entry.reading = normalizeReading(group.entry.reading || '');
        group.entry.source = source || group.entry.source || 'manual';
        changedNames.add(group.cardName);
        refreshCounts();
    }

    function renderGroup(group) {
        const fragment = dom.template.content.cloneNode(true);
        const item = fragment.querySelector('.review-item');
        const card = group.representative;
        const imageUrl = preferredImage(card);
        const thumbnail = fragment.querySelector('.card-thumbnail');
        const canvas = fragment.querySelector('.title-crop');
        const readingInput = fragment.querySelector('.reading-input');
        const statusSelect = fragment.querySelector('.entry-status');
        const source = fragment.querySelector('.entry-source');
        const ocrBtn = fragment.querySelector('.ocr-btn');
        const verifyBtn = fragment.querySelector('.verify-btn');
        const ocrResult = fragment.querySelector('.ocr-result');
        const ocrRaw = fragment.querySelector('.ocr-raw');
        const ocrConfidence = fragment.querySelector('.ocr-confidence');

        item.dataset.status = group.entry.status;
        fragment.querySelector('.card-number').textContent = group.cards.map(value => value.cardNumber).join(' / ');
        fragment.querySelector('.card-type').textContent = card.cardType || '-';
        fragment.querySelector('.series-code').textContent = card.seriesCode || '-';
        fragment.querySelector('.card-name').textContent = group.cardName;
        readingInput.value = group.entry.reading || '';
        statusSelect.value = group.entry.status || 'pending';
        source.textContent = `source: ${group.entry.source || '-'}`;
        thumbnail.src = imageUrl;
        thumbnail.alt = `${card.cardNumber} ${group.cardName}`;
        ocrBtn.hidden = card.cardType !== 'EVENT' || !imageUrl;

        let loadedImage = null;
        if (imageUrl) {
            loadImage(imageUrl).then(image => {
                loadedImage = image;
                drawTitleCrop(canvas, image, card.cardType);
            }).catch(error => {
                source.textContent = error.message;
            });
        }

        readingInput.addEventListener('input', () => {
            group.entry.reading = normalizeReading(readingInput.value);
            if (group.entry.status === 'verified') {
                group.entry.status = 'suggested';
                statusSelect.value = 'suggested';
                item.dataset.status = 'suggested';
            }
            markChanged(group, 'manual');
            source.textContent = 'source: manual';
        });
        statusSelect.addEventListener('change', () => {
            if (statusSelect.value === 'verified' && !normalizeReading(readingInput.value)) {
                statusSelect.value = group.entry.status || 'pending';
                readingInput.focus();
                dom.ocrGlobalStatus.textContent = 'フリガナを入力してから確認済みにしてください。';
                return;
            }
            group.entry.status = statusSelect.value;
            item.dataset.status = group.entry.status;
            markChanged(group, group.entry.source);
            refreshCounts();
        });
        verifyBtn.addEventListener('click', () => {
            const reading = normalizeReading(readingInput.value);
            if (!reading) {
                readingInput.focus();
                return;
            }
            group.entry.reading = reading;
            group.entry.status = 'verified';
            group.entry.source = group.entry.source === 'image-ocr' ? 'image-ocr-confirmed' : 'manual';
            readingInput.value = reading;
            statusSelect.value = 'verified';
            source.textContent = `source: ${group.entry.source}`;
            item.dataset.status = 'verified';
            markChanged(group, group.entry.source);
        });
        ocrBtn.addEventListener('click', async () => {
            if (!loadedImage) return;
            ocrBtn.disabled = true;
            ocrBtn.textContent = '解析中...';
            try {
                if (!ocrReady) dom.ocrGlobalStatus.textContent = '日本語OCRを準備しています...';
                await ensureOcrReady();
                const rubyCanvas = await createRubyCanvas(loadedImage, card.cardType);
                const result = await recognizeRubyImage(await canvasToBlob(rubyCanvas));
                const raw = String(result.text || '').trim();
                const candidate = buildReadingCandidate(group.cardName, raw);
                ocrRaw.textContent = raw ? `ルビ: ${raw}` : 'ルビを認識できませんでした。';
                ocrConfidence.textContent = `信頼度 ${Math.round(result.confidence || 0)}%`;
                ocrResult.hidden = false;
                if (candidate) {
                    readingInput.value = candidate;
                    group.entry.reading = candidate;
                    group.entry.status = 'suggested';
                    group.entry.source = 'image-ocr';
                    statusSelect.value = 'suggested';
                    source.textContent = 'source: image-ocr';
                    item.dataset.status = 'suggested';
                    markChanged(group, 'image-ocr');
                }
            } catch (error) {
                ocrRaw.textContent = error.message;
                ocrResult.hidden = false;
            } finally {
                ocrBtn.disabled = false;
                ocrBtn.textContent = '画像から候補';
                dom.ocrGlobalStatus.textContent = '';
            }
        });

        return fragment;
    }

    function render() {
        const matches = filteredGroups();
        const shown = matches.slice(0, visibleLimit);
        dom.reviewList.replaceChildren(...shown.map(renderGroup));
        dom.resultCount.textContent = `${matches.length}件中 ${shown.length}件を表示`;
        dom.loadMoreBtn.hidden = shown.length >= matches.length;
        refreshCounts();
    }

    function serializedMaster() {
        const sortedEntries = Object.fromEntries(
            Object.entries(master.entries).sort(([left], [right]) => left.localeCompare(right, 'ja'))
        );
        return `${JSON.stringify({ version: 1, entries: sortedEntries }, null, 2)}\n`;
    }

    function encodeBase64Utf8(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
    }

    async function saveToGitHub() {
        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '';
        if (!token) throw new Error('admin.htmlでGitHub tokenを登録してください。');
        const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/furigana-master.json`;
        const current = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        if (!current.ok) throw new Error(`GitHubから現在の辞書を取得できませんでした (${current.status})。`);
        const payload = await current.json();
        const response = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28'
            },
            body: JSON.stringify({
                message: `Update ${changedNames.size} furigana entries`,
                content: encodeBase64Utf8(serializedMaster()),
                branch: GITHUB_BRANCH,
                sha: payload.sha
            })
        });
        if (!response.ok) throw new Error(`GitHubへの保存に失敗しました (${response.status})。`);
        changedNames = new Set();
        refreshCounts();
    }

    async function initialize() {
        try {
            const [cardResponse, provisionalResponse, masterResponse, manifestResponse] = await Promise.all([
                fetch(CARDS_PATH, { cache: 'no-store' }),
                fetch(PROVISIONAL_PATH, { cache: 'no-store' }),
                fetch(MASTER_PATH, { cache: 'no-store' }),
                fetch(IMAGE_MANIFEST_PATH, { cache: 'no-store' })
            ]);
            if (![cardResponse, provisionalResponse, masterResponse, manifestResponse].every(response => response.ok)) {
                throw new Error('フリガナ整備データを読み込めませんでした。');
            }
            const [officialCards, provisionalCards, masterData, manifestData] = await Promise.all([
                cardResponse.json(), provisionalResponse.json(), masterResponse.json(), manifestResponse.json()
            ]);
            cards = [...officialCards, ...provisionalCards];
            master = masterData;
            imageManifest = manifestData;
            buildGroups();
            populateSeries();
            render();
        } catch (error) {
            dom.resultCount.textContent = error.message;
        }
    }

    [dom.statusFilter, dom.typeFilter, dom.seriesFilter].forEach(element => {
        element.addEventListener('change', () => {
            visibleLimit = PAGE_SIZE;
            render();
        });
    });
    dom.searchInput.addEventListener('input', () => {
        visibleLimit = PAGE_SIZE;
        render();
    });
    dom.loadMoreBtn.addEventListener('click', () => {
        visibleLimit += PAGE_SIZE;
        render();
    });
    dom.copyJsonBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(serializedMaster());
        dom.ocrGlobalStatus.textContent = 'JSONをコピーしました。';
    });
    dom.downloadJsonBtn.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([serializedMaster()], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'furigana-master.json';
        link.click();
        URL.revokeObjectURL(url);
    });
    dom.githubSaveBtn.addEventListener('click', async () => {
        if (changedNames.size === 0) return;
        dom.githubSaveBtn.disabled = true;
        try {
            await saveToGitHub();
            dom.ocrGlobalStatus.textContent = 'GitHubへ保存しました。日次処理でカードデータへ反映されます。';
        } catch (error) {
            dom.ocrGlobalStatus.textContent = error.message;
        } finally {
            dom.githubSaveBtn.disabled = false;
        }
    });

    window.addEventListener('message', event => {
        if (event.source !== dom.ocrFrame?.contentWindow || event.data?.channel !== OCR_CHANNEL) return;
        const message = event.data;
        if (message.type === 'ready') {
            ocrReady = true;
            resolveOcrReady();
            return;
        }
        const request = ocrRequests.get(message.requestId);
        if (!request) return;
        if (message.type === 'progress') {
            dom.ocrGlobalStatus.textContent = `画像解析 ${Math.round(Number(message.progress || 0) * 100)}%`;
            return;
        }
        clearTimeout(request.timeout);
        ocrRequests.delete(message.requestId);
        if (message.type === 'result') {
            request.resolve({
                text: String(message.text || ''),
                confidence: Number(message.confidence || 0)
            });
        } else {
            request.reject(new Error(String(message.message || '画像を解析できませんでした。')));
        }
    });
    dom.ocrFrame?.addEventListener('load', () => {
        dom.ocrFrame.contentWindow?.postMessage({ channel: OCR_CHANNEL, type: 'ping' }, '*');
    });

    initialize();
})();
