/* Deck image import UI and browser-side card region detection. */

(function() {
    'use strict';

    const IMAGE_IMPORT_DEBUG = false;
    const MAX_IMAGE_SIDE = 1600;
    const DETECTION_MAX_SIDE = 1000;
    const FEATURE_WIDTH = 8;
    const FEATURE_HEIGHT = 11;
    const CONFIDENCE_AUTO = 0.9;
    const CONFIDENCE_REVIEW = 0.7;
    const DEFAULT_DECK_NAME = '画像から作成したデッキ';
    const MAX_DETECTED_REGIONS = 80;

    let host = null;
    let dom = {};
    let worker = null;
    let workerRequestId = 0;
    let activeWorkerRequest = null;
    let analysisRunId = 0;
    let pickerSearchTimer = null;

    const state = {
        sourceCanvas: null,
        fileName: '',
        layout: '',
        regions: [],
        leader: null,
        rows: [],
        pickerTarget: null,
        pickerCandidates: [],
        busy: false
    };

    const $ = selector => document.querySelector(selector);

    function cacheDom() {
        dom = {
            openBtn: $('#import-deck-image-btn'),
            modal: $('#deck-image-import-modal'),
            closeBtn: $('#deck-image-import-close-btn'),
            body: $('#deck-image-import-body'),
            input: $('#deck-image-import-input'),
            previewShell: $('#deck-image-import-preview-shell'),
            preview: $('#deck-image-import-preview'),
            debugCanvas: $('#deck-image-import-debug-canvas'),
            progressWrap: $('#deck-image-import-progress-wrap'),
            progress: $('#deck-image-import-progress'),
            progressText: $('#deck-image-import-progress-text'),
            status: $('#deck-image-import-status'),
            results: $('#deck-image-import-results'),
            name: $('#deck-image-import-name'),
            summary: $('#deck-image-import-summary'),
            leader: $('#deck-image-import-leader'),
            cardList: $('#deck-image-import-card-list'),
            addCardBtn: $('#deck-image-import-add-card-btn'),
            picker: $('#deck-image-import-picker'),
            pickerCloseBtn: $('#deck-image-import-picker-close-btn'),
            pickerSearch: $('#deck-image-import-picker-search'),
            pickerList: $('#deck-image-import-picker-list'),
            resetBtn: $('#deck-image-import-reset-btn'),
            copyUrlBtn: $('#deck-image-import-copy-url-btn'),
            analyzeBtn: $('#deck-image-import-analyze-btn'),
            acceptBtn: $('#deck-image-import-accept-btn')
        };
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    function setStatus(message = '', isError = false) {
        if (!dom.status) return;
        dom.status.textContent = message;
        dom.status.classList.toggle('is-error', isError);
    }

    function setProgress(value, label) {
        dom.progressWrap.hidden = false;
        dom.progress.value = clamp(Number(value) || 0, 0, 100);
        dom.progressText.textContent = label || `${Math.round(dom.progress.value)}%`;
    }

    function hideProgress() {
        dom.progressWrap.hidden = true;
        dom.progress.value = 0;
        dom.progressText.textContent = '';
    }

    function setBusy(busy) {
        state.busy = Boolean(busy);
        dom.input.disabled = state.busy;
        dom.resetBtn.disabled = state.busy || !state.sourceCanvas;
        dom.analyzeBtn.disabled = state.busy || !state.sourceCanvas;
        if (state.busy) {
            dom.acceptBtn.disabled = true;
            dom.copyUrlBtn.disabled = true;
        } else if (!dom.results.hidden) {
            renderSummary();
        }
    }

    function cancelActiveMatching() {
        if (!activeWorkerRequest) return;
        const pending = activeWorkerRequest;
        activeWorkerRequest = null;
        worker?.terminate();
        worker = null;
        pending.reject(new Error('画像解析を中止しました。'));
    }

    function clearRecognitionState() {
        state.layout = '';
        state.regions = [];
        state.leader = null;
        state.rows = [];
        state.pickerTarget = null;
        state.pickerCandidates = [];
        dom.results.hidden = true;
        dom.leader.replaceChildren();
        dom.cardList.replaceChildren();
        dom.summary.replaceChildren();
        dom.acceptBtn.hidden = true;
        dom.copyUrlBtn.hidden = true;
        closePicker();
    }

    function resetImport() {
        analysisRunId += 1;
        cancelActiveMatching();
        clearRecognitionState();
        state.sourceCanvas = null;
        state.fileName = '';
        dom.input.value = '';
        dom.preview.removeAttribute('src');
        dom.previewShell.hidden = true;
        dom.debugCanvas.hidden = true;
        dom.name.value = DEFAULT_DECK_NAME;
        dom.analyzeBtn.hidden = false;
        dom.analyzeBtn.disabled = true;
        dom.acceptBtn.disabled = true;
        dom.copyUrlBtn.disabled = true;
        hideProgress();
        setStatus();
        setBusy(false);
    }

    function openImport() {
        resetImport();
        dom.modal.style.display = 'flex';
        dom.modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('deck-image-import-open');
        requestAnimationFrame(() => dom.input?.focus());
    }

    function closeImport() {
        analysisRunId += 1;
        cancelActiveMatching();
        dom.modal.style.display = 'none';
        dom.modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('deck-image-import-open');
        closePicker();
        setBusy(false);
    }

    function loadImageElement(file) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('画像を読み込めませんでした。JPEG、PNG、WebP画像を選択してください。'));
            };
            image.src = objectUrl;
        });
    }

    async function handleFileSelection() {
        const file = dom.input.files?.[0];
        if (!file) return;
        const runId = ++analysisRunId;
        clearRecognitionState();
        setStatus('画像を読み込んでいます...');
        dom.analyzeBtn.disabled = true;
        try {
            const image = await loadImageElement(file);
            if (runId !== analysisRunId) return;
            const naturalWidth = image.naturalWidth || image.width;
            const naturalHeight = image.naturalHeight || image.height;
            if (!naturalWidth || !naturalHeight) throw new Error('画像サイズを確認できませんでした。');
            const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(naturalWidth, naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(naturalHeight * scale));
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('画像処理を開始できませんでした。');
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, 0, 0, canvas.width, canvas.height);

            state.sourceCanvas = canvas;
            state.fileName = file.name || '';
            dom.preview.src = canvas.toDataURL('image/jpeg', 0.88);
            dom.previewShell.hidden = false;
            setBusy(false);
            setStatus(`${naturalWidth} x ${naturalHeight}px`);
        } catch (error) {
            if (runId !== analysisRunId) return;
            state.sourceCanvas = null;
            dom.previewShell.hidden = true;
            setBusy(false);
            setStatus(error?.message || '画像を読み込めませんでした。', true);
        }
    }

    function pixelLuma(data, offset) {
        return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    }

    function regionSignal(imageData, imageWidth, imageHeight, rect) {
        const x0 = clamp(Math.floor(rect.x), 0, imageWidth - 1);
        const y0 = clamp(Math.floor(rect.y), 0, imageHeight - 1);
        const x1 = clamp(Math.ceil(rect.x + rect.width), x0 + 1, imageWidth);
        const y1 = clamp(Math.ceil(rect.y + rect.height), y0 + 1, imageHeight);
        const stepX = Math.max(2, Math.floor((x1 - x0) / 18));
        const stepY = Math.max(2, Math.floor((y1 - y0) / 25));
        let count = 0;
        let sum = 0;
        let sumSquares = 0;
        let gradient = 0;
        for (let y = y0; y < y1; y += stepY) {
            for (let x = x0; x < x1; x += stepX) {
                const offset = (y * imageWidth + x) * 4;
                const value = pixelLuma(imageData, offset);
                sum += value;
                sumSquares += value * value;
                if (x + stepX < x1) {
                    gradient += Math.abs(value - pixelLuma(imageData, offset + stepX * 4));
                }
                count += 1;
            }
        }
        if (!count) return 0;
        const mean = sum / count;
        const variance = Math.max(0, sumSquares / count - mean * mean);
        return Math.sqrt(variance) * 0.75 + (gradient / count) * 0.25;
    }

    function findTealBand(imageData, width, height) {
        const maxY = Math.min(height, Math.round(width * 0.24));
        const stepX = Math.max(1, Math.floor(width / 240));
        const scores = [];
        for (let y = 0; y < maxY; y += 1) {
            let matches = 0;
            let samples = 0;
            for (let x = 0; x < width; x += stepX) {
                const offset = (y * width + x) * 4;
                const red = imageData[offset];
                const green = imageData[offset + 1];
                const blue = imageData[offset + 2];
                if (green > 120 && blue > 100 && green - red > 45 && blue - red > 35) matches += 1;
                samples += 1;
            }
            scores.push(samples ? matches / samples : 0);
        }
        const bestY = scores.reduce((best, value, index) => value > scores[best] ? index : best, 0);
        if ((scores[bestY] || 0) < 0.58) return null;
        let start = bestY;
        let end = bestY;
        while (start > 0 && scores[start - 1] > 0.38) start -= 1;
        while (end + 1 < scores.length && scores[end + 1] > 0.38) end += 1;
        return { start, end: end + 1, score: scores[bestY] };
    }

    function regionBorderSignal(imageData, imageWidth, imageHeight, rect) {
        const inset = Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.015));
        const samples = 16;
        let score = 0;
        let count = 0;
        const lumaAt = (x, y) => {
            const safeX = clamp(Math.round(x), 0, imageWidth - 1);
            const safeY = clamp(Math.round(y), 0, imageHeight - 1);
            return pixelLuma(imageData, (safeY * imageWidth + safeX) * 4);
        };
        for (let index = 1; index < samples; index += 1) {
            const ratio = index / samples;
            const x = rect.x + rect.width * ratio;
            const y = rect.y + rect.height * ratio;
            score += Math.abs(lumaAt(x, rect.y + inset) - lumaAt(x, rect.y - inset));
            score += Math.abs(lumaAt(x, rect.y + rect.height - inset) - lumaAt(x, rect.y + rect.height + inset));
            score += Math.abs(lumaAt(rect.x + inset, y) - lumaAt(rect.x - inset, y));
            score += Math.abs(lumaAt(rect.x + rect.width - inset, y) - lumaAt(rect.x + rect.width + inset, y));
            count += 4;
        }
        return count ? score / count : 0;
    }

    function scanOptcgDeckCells(imageData, width, height, config) {
        const regions = [];
        let signalTotal = 0;
        for (let row = 0; row < 12; row += 1) {
            const y = config.contentY + row * config.rowStride;
            if (y + config.cardHeight > height - config.footerClearance) break;
            let foundInRow = 0;
            for (let column = 0; column < 8; column += 1) {
                const rect = {
                    x: config.gridX + column * (config.cardWidth + config.gap),
                    y,
                    width: config.cardWidth,
                    height: config.cardHeight
                };
                const signal = regionSignal(imageData, width, height, rect);
                if (signal < 11) break;
                foundInRow += 1;
                const borderSignal = regionBorderSignal(imageData, width, height, rect);
                signalTotal += borderSignal;
                regions.push({ ...rect, hintRole: 'deck', countMode: 'bottom', signal, borderSignal });
            }
            if (foundInRow === 0 || foundInRow < 8) break;
        }
        return { regions, signalTotal };
    }

    function detectOptcgDbLayout(imageData, width, height) {
        const teal = findTealBand(imageData, width, height);
        if (!teal) return null;
        const scale = width / 1600;
        const expectedLineY = 168 * scale;
        if (Math.abs(teal.start - expectedLineY) > Math.max(18, width * 0.035)) return null;

        const contentY = teal.end + 48 * scale;
        const baseConfig = {
            contentY,
            gridX: 350 * scale,
            cardWidth: 138 * scale,
            cardHeight: Math.round(138 * 1.4 * scale),
            gap: 14 * scale,
            footerClearance: 70 * scale
        };
        const current = scanOptcgDeckCells(imageData, width, height, {
            ...baseConfig,
            rowStride: (138 * 1.4 + 34 + 14) * scale
        });
        const compact = scanOptcgDeckCells(imageData, width, height, {
            ...baseConfig,
            rowStride: (138 * 1.4 + 14) * scale
        });
        const chosen = current.regions.length > compact.regions.length
            || (current.regions.length === compact.regions.length && current.signalTotal >= compact.signalTotal)
            ? current
            : compact;
        if (chosen.regions.length === 0) return null;

        const leader = {
            x: 48 * scale,
            y: contentY,
            width: 220 * scale,
            height: Math.round(220 * 1.4 * scale),
            hintRole: 'leader',
            count: 1,
            countMode: 'none'
        };
        return {
            layout: 'OP TCG DB',
            regions: [leader, ...chosen.regions]
        };
    }

    function detectOfficialDeckImageLayout(imageData, width, height) {
        const aspectRatio = height / width;
        if (aspectRatio < 1.28 || aspectRatio > 1.38) return null;

        const scale = width / 960;
        const leader = {
            x: 45 * scale,
            y: 42 * scale,
            width: 360 * scale,
            height: 360 * 1.397 * scale,
            hintRole: 'leader',
            count: 1,
            countMode: 'none'
        };
        const cardWidth = 84 * scale;
        const cardHeight = cardWidth * 1.397;
        const xStart = 45 * scale;
        const xStride = 98 * scale;
        const firstRowY = 448 * scale;
        const fullRowsY = 582 * scale;
        const rowStride = 134 * scale;
        const regions = [];

        for (let column = 4; column < 9; column += 1) {
            regions.push({
                x: xStart + column * xStride,
                y: firstRowY,
                width: cardWidth,
                height: cardHeight,
                hintRole: 'deck',
                count: 1,
                countMode: 'none'
            });
        }
        for (let row = 0; row < 5; row += 1) {
            for (let column = 0; column < 9; column += 1) {
                regions.push({
                    x: xStart + column * xStride,
                    y: fullRowsY + row * rowStride,
                    width: cardWidth,
                    height: cardHeight,
                    hintRole: 'deck',
                    count: 1,
                    countMode: 'none'
                });
            }
        }

        const qrSignal = regionSignal(imageData, width, height, {
            x: 745 * scale,
            y: 140 * scale,
            width: 175 * scale,
            height: 175 * scale
        });
        const activeCards = regions.reduce((total, rect) => (
            total + (regionSignal(imageData, width, height, rect) >= 11 ? 1 : 0)
        ), 0);
        if (qrSignal < 24 || regionSignal(imageData, width, height, leader) < 13 || activeCards < 42) {
            return null;
        }

        return {
            layout: '公式デッキ画像',
            regions: [leader, ...regions]
        };
    }

    function findDarkBands(imageData, width, height, minHeightRatio = 0.025) {
        const stepX = Math.max(2, Math.floor(width / 220));
        const rowScores = new Float32Array(height);
        for (let y = 0; y < height; y += 1) {
            let dark = 0;
            let samples = 0;
            for (let x = 0; x < width; x += stepX) {
                const offset = (y * width + x) * 4;
                if (pixelLuma(imageData, offset) < 48) dark += 1;
                samples += 1;
            }
            rowScores[y] = samples ? dark / samples : 0;
        }

        const bands = [];
        let start = -1;
        for (let y = 0; y <= height; y += 1) {
            const active = y < height && rowScores[y] > 0.72;
            if (active && start < 0) start = y;
            if (!active && start >= 0) {
                const bandHeight = y - start;
                if (bandHeight >= Math.max(6, width * minHeightRatio)) {
                    bands.push({ start, end: y, height: bandHeight });
                }
                start = -1;
            }
        }
        return bands;
    }

    function detectFiveColumnDeckListLayout(imageData, width, height) {
        const aspectRatio = height / width;
        if (aspectRatio < 1.12 || aspectRatio > 1.32) return null;

        const bands = findDarkBands(imageData, width, height, 0.016);
        const mainBand = bands.find(band => band.start < height * 0.035 && band.end < height * 0.09);
        const leaderBand = bands.find(band => (
            band.start > height * 0.62
            && band.start < height * 0.86
            && (!mainBand || band.start > mainBand.end)
        ));
        if (!mainBand || !leaderBand) return null;

        const cardWidth = width * (202 / 1065);
        const cardHeight = cardWidth * 1.397;
        const xStart = width * (7 / 1065);
        const xStride = width * (212 / 1065);
        const yStart = mainBand.end + width * (15 / 1065);
        const rowStride = width * (299 / 1065);
        const mainRegions = [];

        for (let row = 0; row < 8; row += 1) {
            const y = yStart + row * rowStride;
            if (y + cardHeight > leaderBand.start - width * 0.012) break;
            for (let column = 0; column < 5; column += 1) {
                mainRegions.push({
                    x: xStart + column * xStride,
                    y,
                    width: cardWidth,
                    height: cardHeight,
                    hintRole: 'deck',
                    countMode: 'corner'
                });
            }
        }
        if (mainRegions.length < 10) return null;
        const activeCards = mainRegions.reduce((total, rect) => (
            total + (regionSignal(imageData, width, height, rect) >= 13 ? 1 : 0)
        ), 0);
        if (activeCards < mainRegions.length * 0.8) return null;

        const leaderRect = {
            x: xStart,
            y: leaderBand.end + width * (17 / 1065),
            width: cardWidth,
            height: cardHeight,
            hintRole: 'leader',
            count: 1,
            countMode: 'none'
        };
        if (leaderRect.y + leaderRect.height > height + width * 0.02) return null;
        return {
            layout: 'カード番号付き5列',
            regions: [...mainRegions, leaderRect]
        };
    }

    function detectBccgLayout(imageData, width, height) {
        const bands = findDarkBands(imageData, width, height)
            .filter(band => band.start > height * 0.08 && band.start < height * 0.88);
        if (bands.length < 2) return null;

        for (let bandIndex = 0; bandIndex < bands.length - 1; bandIndex += 1) {
            const mainBand = bands[bandIndex];
            const leaderBand = bands[bandIndex + 1];
            if (leaderBand.start - mainBand.end < width * 0.55) continue;
            const cardWidth = width * 0.154;
            const cardHeight = cardWidth * 1.4;
            const xStart = width * 0.038;
            const xStride = width * 0.185;
            const yStart = mainBand.end + width * 0.037;
            const rowStride = width * 0.293;
            const mainRegions = [];

            for (let row = 0; row < 12; row += 1) {
                const y = yStart + row * rowStride;
                if (y + cardHeight > leaderBand.start - width * 0.02) break;
                let found = 0;
                for (let column = 0; column < 5; column += 1) {
                    const rect = {
                        x: xStart + column * xStride,
                        y,
                        width: cardWidth,
                        height: cardHeight
                    };
                    const signal = regionSignal(imageData, width, height, rect);
                    if (signal < 13) break;
                    found += 1;
                    mainRegions.push({ ...rect, hintRole: 'deck', countMode: 'top', signal });
                }
                if (found === 0 || found < 5) break;
            }

            if (mainRegions.length < 5) continue;
            const leaderRect = {
                x: xStart,
                y: leaderBand.end + width * 0.035,
                width: cardWidth,
                height: cardHeight,
                hintRole: 'leader',
                count: 1,
                countMode: 'none'
            };
            if (leaderRect.y + leaderRect.height > height) continue;
            return {
                layout: 'デッキメーカー',
                regions: [...mainRegions, leaderRect]
            };
        }
        return null;
    }

    function buildDetectionCanvas(sourceCanvas) {
        const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
        canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
        return { canvas, context, scale };
    }

    function makeIntegral(values, width, height) {
        const stride = width + 1;
        const integral = new Float32Array(stride * (height + 1));
        for (let y = 0; y < height; y += 1) {
            let rowSum = 0;
            for (let x = 0; x < width; x += 1) {
                rowSum += values[y * width + x];
                integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
            }
        }
        return { integral, stride };
    }

    function integralRectSum(integral, stride, x, y, width, height) {
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.max(x0, Math.floor(x + width));
        const y1 = Math.max(y0, Math.floor(y + height));
        return integral[y1 * stride + x1]
            - integral[y0 * stride + x1]
            - integral[y1 * stride + x0]
            + integral[y0 * stride + x0];
    }

    function rectangleIou(a, b) {
        const left = Math.max(a.x, b.x);
        const top = Math.max(a.y, b.y);
        const right = Math.min(a.x + a.width, b.x + b.width);
        const bottom = Math.min(a.y + a.height, b.y + b.height);
        const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
        if (!intersection) return 0;
        return intersection / (a.width * a.height + b.width * b.height - intersection);
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function groupRectangleRows(rectangles) {
        const rows = [];
        const typicalHeight = median(rectangles.map(rect => rect.height)) || 1;
        rectangles.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach(rect => {
            let row = rows.find(candidate => Math.abs(candidate.y - rect.y) < typicalHeight * 0.28);
            if (!row) {
                row = { y: rect.y, items: [] };
                rows.push(row);
            }
            row.items.push(rect);
            row.y = row.items.reduce((sum, item) => sum + item.y, 0) / row.items.length;
        });
        rows.forEach(row => row.items.sort((a, b) => a.x - b.x));
        return rows.sort((a, b) => a.y - b.y);
    }

    function detectGenericGrid(sourceCanvas) {
        const detection = buildDetectionCanvas(sourceCanvas);
        const width = detection.canvas.width;
        const height = detection.canvas.height;
        const pixels = detection.context.getImageData(0, 0, width, height).data;
        const gray = new Uint8Array(width * height);
        for (let index = 0; index < gray.length; index += 1) {
            gray[index] = Math.round(pixelLuma(pixels, index * 4));
        }

        const edge = new Uint8Array(width * height);
        let edgeTotal = 0;
        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                const index = y * width + x;
                const value = Math.min(255,
                    Math.abs(gray[index + 1] - gray[index - 1])
                    + Math.abs(gray[index + width] - gray[index - width])
                );
                edge[index] = value;
                edgeTotal += value;
            }
        }
        const globalEdge = edgeTotal / Math.max(1, (width - 2) * (height - 2));
        const { integral, stride } = makeIntegral(edge, width, height);
        const candidates = [];
        const minWidth = Math.max(34, width * 0.065);
        const maxWidth = Math.min(width * 0.24, height / 2.2);

        for (let cardWidth = minWidth; cardWidth <= maxWidth; cardWidth *= 1.13) {
            const cardHeight = cardWidth * 1.397;
            const scanStep = Math.max(3, Math.floor(cardWidth * 0.075));
            const strip = Math.max(2, Math.round(cardWidth * 0.045));
            const inset = Math.max(strip * 2, Math.round(cardWidth * 0.1));
            for (let y = 0; y + cardHeight < height; y += scanStep) {
                for (let x = 0; x + cardWidth < width; x += scanStep) {
                    const top = integralRectSum(integral, stride, x, y, cardWidth, strip);
                    const bottom = integralRectSum(integral, stride, x, y + cardHeight - strip, cardWidth, strip);
                    const left = integralRectSum(integral, stride, x, y, strip, cardHeight);
                    const right = integralRectSum(integral, stride, x + cardWidth - strip, y, strip, cardHeight);
                    const borderArea = 2 * cardWidth * strip + 2 * Math.max(0, cardHeight - strip * 2) * strip;
                    const borderScore = (top + bottom + left + right) / Math.max(1, borderArea);
                    const innerWidth = cardWidth - inset * 2;
                    const innerHeight = cardHeight - inset * 2;
                    const innerScore = integralRectSum(integral, stride, x + inset, y + inset, innerWidth, innerHeight)
                        / Math.max(1, innerWidth * innerHeight);
                    const score = borderScore * 0.66 + innerScore * 0.34;
                    if (borderScore > globalEdge * 1.1 && innerScore > globalEdge * 0.75 && score > globalEdge * 1.02) {
                        candidates.push({ x, y, width: cardWidth, height: cardHeight, score });
                    }
                }
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        const selected = [];
        for (const candidate of candidates.slice(0, 1200)) {
            const duplicate = selected.some(existing => {
                if (rectangleIou(candidate, existing) > 0.48) return true;
                const centerDistance = Math.hypot(
                    candidate.x + candidate.width / 2 - existing.x - existing.width / 2,
                    candidate.y + candidate.height / 2 - existing.y - existing.height / 2
                );
                return centerDistance < Math.min(candidate.width, existing.width) * 0.22;
            });
            if (!duplicate) selected.push(candidate);
            if (selected.length >= MAX_DETECTED_REGIONS) break;
        }

        if (selected.length < 2) return { layout: '自動グリッド', regions: [] };
        const typicalWidth = median(selected.slice(0, 30).map(rect => rect.width));
        const sizeFiltered = selected.filter(rect => rect.width > typicalWidth * 0.7 && rect.width < typicalWidth * 1.45);
        const rows = groupRectangleRows(sizeFiltered);
        const gridRows = rows.filter(row => row.items.length >= 2);
        const mainRects = gridRows.flatMap(row => row.items);
        const singleRows = rows.filter(row => row.items.length === 1);
        let leaderRect = null;
        if (singleRows.length && mainRects.length >= 4) {
            leaderRect = singleRows
                .map(row => row.items[0])
                .sort((a, b) => b.score - a.score)[0];
        }
        const kept = [...mainRects, ...(leaderRect ? [leaderRect] : [])]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .slice(0, MAX_DETECTED_REGIONS);
        const inverseScale = 1 / detection.scale;
        return {
            layout: '自動グリッド',
            regions: kept.map(rect => ({
                x: rect.x * inverseScale,
                y: rect.y * inverseScale,
                width: rect.width * inverseScale,
                height: rect.height * inverseScale,
                hintRole: rect === leaderRect ? 'leader' : 'deck',
                countMode: 'auto',
                signal: rect.score
            }))
        };
    }

    function normalizeDigitMask(mask, width, height) {
        let left = width;
        let right = -1;
        let top = height;
        let bottom = -1;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (!mask[y * width + x]) continue;
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < left || bottom < top) return null;
        const targetWidth = 16;
        const targetHeight = 24;
        const output = new Uint8Array(targetWidth * targetHeight);
        const sourceWidth = right - left + 1;
        const sourceHeight = bottom - top + 1;
        const scale = Math.min((targetWidth - 2) / sourceWidth, (targetHeight - 2) / sourceHeight);
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        const offsetX = (targetWidth - drawWidth) / 2;
        const offsetY = (targetHeight - drawHeight) / 2;
        for (let y = 0; y < targetHeight; y += 1) {
            for (let x = 0; x < targetWidth; x += 1) {
                const sourceX = Math.floor((x - offsetX) / scale + left);
                const sourceY = Math.floor((y - offsetY) / scale + top);
                if (sourceX >= left && sourceX <= right && sourceY >= top && sourceY <= bottom) {
                    output[y * targetWidth + x] = mask[sourceY * width + sourceX];
                }
            }
        }
        return output;
    }

    let digitTemplates = null;

    function getDigitTemplates() {
        if (digitTemplates) return digitTemplates;
        digitTemplates = new Map();
        for (let digit = 1; digit <= 4; digit += 1) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 80;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.fillStyle = '#000';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#fff';
            context.font = '900 58px Arial, sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(String(digit), canvas.width / 2, canvas.height / 2 + 3);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const mask = new Uint8Array(canvas.width * canvas.height);
            for (let index = 0; index < mask.length; index += 1) {
                mask[index] = pixels[index * 4] > 120 ? 1 : 0;
            }
            digitTemplates.set(digit, normalizeDigitMask(mask, canvas.width, canvas.height));
        }
        return digitTemplates;
    }

    function compareMasks(first, second) {
        if (!first || !second || first.length !== second.length) return 0;
        let intersection = 0;
        let union = 0;
        let mismatch = 0;
        for (let index = 0; index < first.length; index += 1) {
            if (first[index] && second[index]) intersection += 1;
            if (first[index] || second[index]) union += 1;
            if (first[index] !== second[index]) mismatch += 1;
        }
        const iou = union ? intersection / union : 0;
        return iou * 0.72 + (1 - mismatch / first.length) * 0.28;
    }

    function selectDigitMaskComponent(mask, width, height) {
        const remaining = new Uint8Array(mask);
        let best = null;
        const queue = new Int32Array(mask.length);
        for (let start = 0; start < remaining.length; start += 1) {
            if (!remaining[start]) continue;
            let head = 0;
            let tail = 0;
            queue[tail++] = start;
            remaining[start] = 0;
            const indexes = [];
            let minX = width;
            let maxX = -1;
            let minY = height;
            let maxY = -1;
            let sumX = 0;
            let sumY = 0;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = Math.floor(index / width);
                indexes.push(index);
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                sumX += x;
                sumY += y;
                for (let dy = -1; dy <= 1; dy += 1) {
                    for (let dx = -1; dx <= 1; dx += 1) {
                        const nextX = x + dx;
                        const nextY = y + dy;
                        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
                        const nextIndex = nextY * width + nextX;
                        if (!remaining[nextIndex]) continue;
                        remaining[nextIndex] = 0;
                        queue[tail++] = nextIndex;
                    }
                }
            }
            if (indexes.length < 3) continue;
            const componentWidth = maxX - minX + 1;
            const componentHeight = maxY - minY + 1;
            if (componentWidth > componentHeight * 1.15) continue;
            const centerX = sumX / indexes.length;
            const centerY = sumY / indexes.length;
            const centerDistance = Math.hypot(centerX - width / 2, centerY - height / 2);
            const score = indexes.length - centerDistance * 1.5;
            if (!best || score > best.score) best = { indexes, score };
        }
        if (!best) return mask;
        const selected = new Uint8Array(mask.length);
        best.indexes.forEach(index => { selected[index] = 1; });
        return selected;
    }

    function getMaskBounds(mask, width, height) {
        let left = width;
        let right = -1;
        let top = height;
        let bottom = -1;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (!mask[y * width + x]) continue;
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
        return right < left ? null : {
            width: right - left + 1,
            height: bottom - top + 1
        };
    }

    function countEnclosedMaskPixels(mask, width, height) {
        const outside = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        let head = 0;
        let tail = 0;
        const enqueue = index => {
            if (mask[index] || outside[index]) return;
            outside[index] = 1;
            queue[tail++] = index;
        };
        for (let x = 0; x < width; x += 1) {
            enqueue(x);
            enqueue((height - 1) * width + x);
        }
        for (let y = 0; y < height; y += 1) {
            enqueue(y * width);
            enqueue(y * width + width - 1);
        }
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const y = Math.floor(index / width);
            if (x > 0) enqueue(index - 1);
            if (x + 1 < width) enqueue(index + 1);
            if (y > 0) enqueue(index - width);
            if (y + 1 < height) enqueue(index + width);
        }
        let enclosed = 0;
        for (let index = 0; index < mask.length; index += 1) {
            if (!mask[index] && !outside[index]) enclosed += 1;
        }
        return enclosed;
    }

    function classifyDigit(mask, mode = 'legacy') {
        const selected = selectDigitMaskComponent(mask.data, mask.width, mask.height);
        const normalized = normalizeDigitMask(selected, mask.width, mask.height);
        if (!normalized) return null;
        const bounds = getMaskBounds(selected, mask.width, mask.height);
        if (bounds && bounds.width / Math.max(1, bounds.height) < 0.48) {
            return { digit: 1, score: 1 };
        }
        if (mode === 'corner') {
            let bottomStroke = 0;
            for (let y = 19; y < 24; y += 1) {
                for (let x = 0; x < 16; x += 1) bottomStroke += normalized[y * 16 + x];
            }
            let middleStroke = 0;
            for (let y = 13; y < 18; y += 1) {
                for (let x = 0; x < 16; x += 1) middleStroke += normalized[y * 16 + x];
            }
            if (bottomStroke <= 8 || (bottomStroke < 18 && middleStroke >= 28)) {
                return { digit: 4, score: 0.95 };
            }

            let lowerLeftStroke = 0;
            for (let y = 15; y < 21; y += 1) {
                for (let x = 0; x < 8; x += 1) lowerLeftStroke += normalized[y * 16 + x];
            }
            if (lowerLeftStroke >= 5) return { digit: 2, score: 0.95 };
        } else {
            if (countEnclosedMaskPixels(normalized, 16, 24) >= 3) {
                return { digit: 4, score: 1 };
            }
            let bottomLeft = 0;
            for (let y = 12; y < 24; y += 1) {
                for (let x = 0; x < 8; x += 1) bottomLeft += normalized[y * 16 + x];
            }
            let middleStroke = 0;
            for (let y = 10; y < 16; y += 1) {
                for (let x = 0; x < 16; x += 1) middleStroke += normalized[y * 16 + x];
            }
            if (bottomLeft >= 30 || (bottomLeft >= 20 && middleStroke <= 28)) {
                return { digit: 2, score: 0.95 };
            }
        }

        let best = null;
        getDigitTemplates().forEach((template, digit) => {
            if (digit < 3) return;
            const score = compareMasks(normalized, template);
            if (!best || score > best.score) best = { digit, score };
        });
        return best && best.score >= 0.26 ? best : { digit: 3, score: 0.5 };
    }

    function readBadgeDigit(sourceCanvas, rect, mode) {
        if (mode === 'none') return 1;
        const attempts = mode === 'auto' ? ['top', 'bottom'] : [mode];
        for (const attempt of attempts) {
            const badge = attempt === 'corner'
                ? {
                    x: rect.x + rect.width * 0.84,
                    y: rect.y - rect.width * 0.055,
                    width: rect.width * 0.23,
                    height: rect.width * 0.23
                }
                : attempt === 'top'
                ? {
                    x: rect.x + rect.width * 0.75,
                    y: rect.y - rect.width * 0.25,
                    width: rect.width * 0.5,
                    height: rect.width * 0.5
                }
                : {
                    x: rect.x + rect.width * 0.56,
                    y: rect.y + rect.height - rect.width * 0.44,
                    width: rect.width * 0.42,
                    height: rect.width * 0.42
                };
            const sampleCanvas = document.createElement('canvas');
            sampleCanvas.width = 48;
            sampleCanvas.height = 48;
            const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(
                sourceCanvas,
                badge.x,
                badge.y,
                badge.width,
                badge.height,
                0,
                0,
                sampleCanvas.width,
                sampleCanvas.height
            );
            const pixels = context.getImageData(0, 0, 48, 48).data;
            const mask = new Uint8Array(48 * 48);
            let badgePixels = 0;
            for (let y = 0; y < 48; y += 1) {
                for (let x = 0; x < 48; x += 1) {
                    const index = y * 48 + x;
                    const offset = index * 4;
                    const red = pixels[offset];
                    const green = pixels[offset + 1];
                    const blue = pixels[offset + 2];
                    const luma = pixelLuma(pixels, offset);
                    if (attempt === 'top' || attempt === 'corner') {
                        const dx = x - 24;
                        const dy = y - 24;
                        if (dx * dx + dy * dy > 14 * 14) continue;
                        if (luma < 70) badgePixels += 1;
                        const whiteThreshold = attempt === 'corner' ? 125 : 155;
                        if (luma > whiteThreshold && Math.max(red, green, blue) - Math.min(red, green, blue) < 95) {
                            mask[index] = 1;
                        }
                    } else {
                        if (red > 165 && green > 105 && blue < 135) badgePixels += 1;
                        if (x >= 8 && x <= 40 && y >= 8 && y <= 40 && luma < 105) mask[index] = 1;
                    }
                }
            }
            if (badgePixels < 80) continue;
            const result = classifyDigit({ data: mask, width: 48, height: 48 }, attempt);
            if (result) return result.digit;
        }
        return 1;
    }

    function detectCardRegions(sourceCanvas) {
        const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
        const known = detectOptcgDbLayout(imageData, sourceCanvas.width, sourceCanvas.height)
            || detectOfficialDeckImageLayout(imageData, sourceCanvas.width, sourceCanvas.height)
            || detectFiveColumnDeckListLayout(imageData, sourceCanvas.width, sourceCanvas.height)
            || detectBccgLayout(imageData, sourceCanvas.width, sourceCanvas.height);
        const detected = known || detectGenericGrid(sourceCanvas);
        detected.regions = detected.regions.map((rect, index) => ({
            ...rect,
            id: `region-${index + 1}`,
            count: rect.count || readBadgeDigit(sourceCanvas, rect, rect.countMode || 'auto')
        }));
        return detected;
    }

    function createImageFeature(sourceCanvas, rect) {
        const canvas = document.createElement('canvas');
        canvas.width = FEATURE_WIDTH;
        canvas.height = FEATURE_HEIGHT;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(
            sourceCanvas,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            0,
            0,
            FEATURE_WIDTH,
            FEATURE_HEIGHT
        );
        const pixels = context.getImageData(0, 0, FEATURE_WIDTH, FEATURE_HEIGHT).data;
        const lumas = new Float32Array(FEATURE_WIDTH * FEATURE_HEIGHT);
        let mean = 0;
        for (let index = 0; index < lumas.length; index += 1) {
            lumas[index] = pixelLuma(pixels, index * 4);
            mean += lumas[index];
        }
        mean /= lumas.length;
        let variance = 0;
        for (let index = 0; index < lumas.length; index += 1) {
            variance += (lumas[index] - mean) ** 2;
        }
        const scale = 48 / Math.max(Math.sqrt(variance / lumas.length), 12);
        const output = new Uint8Array(lumas.length * 3);
        for (let index = 0; index < lumas.length; index += 1) {
            const offset = index * 4;
            const red = pixels[offset];
            const green = pixels[offset + 1];
            const blue = pixels[offset + 2];
            output[index * 3] = clamp(Math.round(128 + (lumas[index] - mean) * scale), 0, 255);
            output[index * 3 + 1] = clamp(Math.round(128 - 0.168736 * red - 0.331264 * green + 0.5 * blue), 0, 255);
            output[index * 3 + 2] = clamp(Math.round(128 + 0.5 * red - 0.418688 * green - 0.081312 * blue), 0, 255);
        }
        return output;
    }

    function drawDebugRectangles(sourceCanvas, regions) {
        if (!IMAGE_IMPORT_DEBUG || !dom.debugCanvas) return;
        dom.debugCanvas.hidden = false;
        dom.debugCanvas.width = sourceCanvas.width;
        dom.debugCanvas.height = sourceCanvas.height;
        const context = dom.debugCanvas.getContext('2d');
        context.clearRect(0, 0, dom.debugCanvas.width, dom.debugCanvas.height);
        context.lineWidth = Math.max(2, sourceCanvas.width / 500);
        context.font = `${Math.max(14, sourceCanvas.width / 70)}px sans-serif`;
        regions.forEach((rect, index) => {
            context.strokeStyle = rect.hintRole === 'leader' ? '#b56cff' : '#27c7b8';
            context.fillStyle = context.strokeStyle;
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
            context.fillText(`${index + 1}:${rect.count}`, rect.x + 3, Math.max(16, rect.y - 4));
        });
    }

    function ensureWorker() {
        if (worker) return worker;
        if (typeof Worker !== 'function') throw new Error('このブラウザは画像照合処理に対応していません。');
        worker = new Worker(new URL('image-import-worker.js', document.baseURI));
        worker.addEventListener('message', event => {
            const message = event.data || {};
            if (message.type === 'progress' && activeWorkerRequest?.onProgress) {
                activeWorkerRequest.onProgress(message.completed, message.total);
                return;
            }
            if (!activeWorkerRequest || message.requestId !== activeWorkerRequest.requestId) return;
            if (message.type === 'result') {
                const resolve = activeWorkerRequest.resolve;
                activeWorkerRequest = null;
                resolve(message.results || []);
            } else if (message.type === 'error') {
                const reject = activeWorkerRequest.reject;
                activeWorkerRequest = null;
                reject(new Error(message.message || 'カード画像の照合に失敗しました。'));
            }
        });
        worker.addEventListener('error', event => {
            if (!activeWorkerRequest) return;
            const reject = activeWorkerRequest.reject;
            activeWorkerRequest = null;
            reject(new Error(event.message || 'カード画像の照合処理を開始できませんでした。'));
        });
        return worker;
    }

    function matchFeatures(regions, featureBuffer, onProgress) {
        if (activeWorkerRequest) throw new Error('別の画像を解析中です。');
        const matcher = ensureWorker();
        const requestId = ++workerRequestId;
        return new Promise((resolve, reject) => {
            activeWorkerRequest = { requestId, resolve, reject, onProgress };
            matcher.postMessage({
                type: 'match',
                requestId,
                regions: regions.map(region => ({ id: region.id })),
                buffer: featureBuffer.buffer
            }, [featureBuffer.buffer]);
        });
    }

    function chooseLeaderResult(regions, matches) {
        const combined = regions.map(region => ({
            region,
            match: matches.find(item => item.id === region.id)
        })).filter(item => item.match);
        const hinted = combined.filter(item => item.region.hintRole === 'leader');
        const candidates = hinted.length ? hinted : combined;
        return candidates.sort((a, b) => {
            const scoreA = (a.match.leader?.similarity || 0) - (a.match.deck?.similarity || 0) * 0.25;
            const scoreB = (b.match.leader?.similarity || 0) - (b.match.deck?.similarity || 0) * 0.25;
            return scoreB - scoreA;
        })[0] || null;
    }

    function getVariantVoteKey(candidate) {
        const path = String(candidate?.variantPath || '').trim();
        if (path) return `path:${path.toLowerCase()}`;
        const variantIndex = Number(candidate?.variantIndex);
        return `index:${Number.isInteger(variantIndex) && variantIndex >= 0 ? variantIndex : 0}`;
    }

    function selectVariantVote(row) {
        const winner = (row.variantVotes || []).slice().sort((a, b) => (
            b.count - a.count
            || b.similarity - a.similarity
            || String(a.key).localeCompare(String(b.key))
        ))[0];
        row.variantPath = winner?.variantPath || '';
        row.variantIndex = Number.isInteger(winner?.variantIndex) ? winner.variantIndex : 0;
    }

    function addVariantVote(row, candidate, count = 1) {
        if (!row || !candidate) return;
        if (!Array.isArray(row.variantVotes)) row.variantVotes = [];
        const key = getVariantVoteKey(candidate);
        let vote = row.variantVotes.find(item => item.key === key);
        if (!vote) {
            const variantIndex = Number(candidate.variantIndex);
            vote = {
                key,
                variantPath: String(candidate.variantPath || ''),
                variantIndex: Number.isInteger(variantIndex) && variantIndex >= 0 ? variantIndex : 0,
                count: 0,
                similarity: 0
            };
            row.variantVotes.push(vote);
        }
        vote.count += Math.max(1, Number(count) || 1);
        vote.similarity = Math.max(vote.similarity, Number(candidate.similarity || candidate.score) || 0);
        selectVariantVote(row);
    }

    function setRowVariant(row, candidate = null) {
        row.variantVotes = [];
        row.variantPath = '';
        row.variantIndex = 0;
        if (candidate) addVariantVote(row, candidate, Math.max(1, Number(row.count) || 1));
    }

    function aggregateDeckRows(regions, matches, leaderRegionId) {
        const grouped = new Map();
        regions.forEach(region => {
            if (region.id === leaderRegionId) return;
            const match = matches.find(item => item.id === region.id)?.deck;
            const best = match?.candidates?.[0];
            if (!best?.cardNumber) return;
            const existing = grouped.get(best.cardNumber);
            const regionCount = Math.max(1, Number(region.count) || 1);
            if (existing) {
                existing.count += regionCount;
                existing.confidence = Math.min(existing.confidence, match.confidence || 0);
                existing.reviewed = existing.reviewed && (match.confidence || 0) >= CONFIDENCE_REVIEW;
                existing.regionIds.push(region.id);
                addVariantVote(existing, best, regionCount);
                best.cardNumber && match.candidates.forEach(candidate => {
                    if (!existing.candidates.some(item => item.cardNumber === candidate.cardNumber)) {
                        existing.candidates.push(candidate);
                    }
                });
                return;
            }
            grouped.set(best.cardNumber, {
                id: `row-${region.id}`,
                cardNumber: best.cardNumber,
                count: regionCount,
                confidence: match.confidence || 0,
                reviewed: (match.confidence || 0) >= CONFIDENCE_REVIEW,
                candidates: (match.candidates || []).slice(0, 3),
                regionIds: [region.id],
                variantVotes: [],
                variantPath: '',
                variantIndex: 0
            });
            addVariantVote(grouped.get(best.cardNumber), best, regionCount);
        });
        return [...grouped.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber, 'en', { numeric: true }));
    }

    async function analyzeImage() {
        if (!state.sourceCanvas || state.busy) return;
        const runId = ++analysisRunId;
        clearRecognitionState();
        setBusy(true);
        dom.analyzeBtn.textContent = '解析中...';
        setStatus();
        setProgress(4, '画像を準備中');
        const timings = { startedAt: performance.now() };
        try {
            await nextFrame();
            const detectionStarted = performance.now();
            const detected = detectCardRegions(state.sourceCanvas);
            timings.detection = performance.now() - detectionStarted;
            if (runId !== analysisRunId) return;
            if (detected.regions.length < 2) {
                throw new Error('カードを十分に検出できませんでした。正面から表示されたグリッド形式のデッキ画像を選択してください。');
            }
            if (detected.regions.length > MAX_DETECTED_REGIONS) {
                throw new Error('検出したカード領域が多すぎます。装飾の少ないデッキ画像を選択してください。');
            }
            state.layout = detected.layout;
            state.regions = detected.regions;
            drawDebugRectangles(state.sourceCanvas, state.regions);
            setProgress(24, `カード領域 ${state.regions.length}件`);
            await nextFrame();

            const featureLength = FEATURE_WIDTH * FEATURE_HEIGHT * 3;
            const featureBuffer = new Uint8Array(featureLength * state.regions.length);
            state.regions.forEach((region, index) => {
                featureBuffer.set(createImageFeature(state.sourceCanvas, region), index * featureLength);
            });
            setProgress(34, '認識データを準備中');

            const matchingStarted = performance.now();
            const matches = await matchFeatures(state.regions, featureBuffer, (completed, total) => {
                if (runId !== analysisRunId) return;
                const progress = 36 + (completed / Math.max(1, total)) * 58;
                setProgress(progress, `カード照合 ${completed} / ${total}`);
            });
            timings.matching = performance.now() - matchingStarted;
            if (runId !== analysisRunId) return;

            const leaderResult = chooseLeaderResult(state.regions, matches);
            const leaderCandidate = leaderResult?.match?.leader?.candidates?.[0];
            state.leader = leaderCandidate ? {
                cardNumber: leaderCandidate.cardNumber,
                confidence: leaderResult.match.leader.confidence || 0,
                reviewed: (leaderResult.match.leader.confidence || 0) >= CONFIDENCE_REVIEW,
                candidates: leaderResult.match.leader.candidates || [],
                regionId: leaderResult.region.id,
                variantPath: leaderCandidate.variantPath || '',
                variantIndex: Number(leaderCandidate.variantIndex) || 0
            } : null;
            state.rows = aggregateDeckRows(state.regions, matches, leaderResult?.region?.id || '');
            renderResults();
            setProgress(100, '解析完了');
            setTimeout(() => {
                if (runId === analysisRunId) hideProgress();
            }, 700);
            timings.total = performance.now() - timings.startedAt;
            console.info('[ImageImport]', {
                imageLoad: 'browser-decoded',
                cardDetection: `${Math.round(timings.detection)}ms`,
                cardMatching: `${Math.round(timings.matching)}ms`,
                total: `${Math.round(timings.total)}ms`,
                detectedCards: state.regions.length,
                recognizedTypes: state.rows.length,
                layout: state.layout
            });
        } catch (error) {
            if (runId !== analysisRunId) return;
            console.error('Deck image import failed:', error);
            hideProgress();
            setStatus(error?.message || '画像解析に失敗しました。', true);
        } finally {
            if (runId === analysisRunId) {
                setBusy(false);
                dom.analyzeBtn.textContent = '再解析';
            }
        }
    }

    function getVariantVisual(cardNumber, variantMatch = null) {
        const card = host.findCard(cardNumber);
        if (!card) return { card: null, sources: [], label: '', type: 'normal' };
        if (typeof host.getCardVariant === 'function') {
            const resolved = host.getCardVariant(card, variantMatch) || {};
            const sources = Array.isArray(resolved.sources)
                ? resolved.sources.filter(Boolean)
                : [resolved.source].filter(Boolean);
            return {
                card,
                sources: [...new Set(sources)],
                label: resolved.label || '',
                type: resolved.type || 'normal'
            };
        }
        const source = host.getCardImage(card, variantMatch);
        return {
            card,
            sources: source ? [source] : [],
            label: Number(variantMatch?.variantIndex) > 0 ? '別イラスト' : '',
            type: Number(variantMatch?.variantIndex) > 0 ? 'alternate-art' : 'normal'
        };
    }

    function getCardVisual(cardNumber, variantMatch = null, className = 'deck-image-import-card-thumb') {
        const visual = getVariantVisual(cardNumber, variantMatch);
        if (!visual.sources.length) {
            const fallback = document.createElement('div');
            fallback.className = `${className}-fallback deck-image-import-card-thumb-fallback`;
            fallback.textContent = cardNumber || '?';
            return fallback;
        }
        const image = document.createElement('img');
        image.className = className;
        image.alt = visual.card?.cardName || cardNumber;
        image.loading = 'lazy';
        let sourceIndex = 0;
        image.onerror = () => {
            sourceIndex += 1;
            if (sourceIndex < visual.sources.length) {
                image.src = visual.sources[sourceIndex];
            } else {
                image.replaceWith(getCardVisual('', null, className));
            }
        };
        image.src = visual.sources[sourceIndex];
        return image;
    }

    function confidenceInfo(confidence, reviewed) {
        const percent = Math.round(clamp(confidence || 0, 0, 1) * 100);
        if (!reviewed && confidence < CONFIDENCE_REVIEW) {
            return { label: `要確認 ${percent}%`, className: 'is-low' };
        }
        if (confidence < CONFIDENCE_AUTO) {
            return { label: `注意 ${percent}%`, className: 'is-warning' };
        }
        return { label: `信頼度 ${percent}%`, className: '' };
    }

    function createCardCopy(cardNumber, confidence, reviewed, variantMatch = null) {
        const card = host.findCard(cardNumber);
        const copy = document.createElement('div');
        copy.className = 'deck-image-import-card-copy';
        const number = document.createElement('strong');
        number.className = 'deck-image-import-card-number';
        number.textContent = cardNumber || '未設定';
        const name = document.createElement('span');
        name.className = 'deck-image-import-card-name';
        name.textContent = card?.cardName || '未登録カード';
        const variant = getVariantVisual(cardNumber, variantMatch);
        if (variant.type !== 'normal' && variant.label) {
            const variantLabel = document.createElement('span');
            variantLabel.className = 'deck-image-import-variant';
            variantLabel.textContent = variant.label;
            copy.append(number, name, variantLabel);
        } else {
            copy.append(number, name);
        }
        const confidenceElement = document.createElement('span');
        const info = confidenceInfo(confidence, reviewed);
        confidenceElement.className = `deck-image-import-confidence${info.className ? ` ${info.className}` : ''}`;
        confidenceElement.textContent = info.label;
        copy.appendChild(confidenceElement);
        return copy;
    }

    function createActionButton(label, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'deck-image-import-row-btn';
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    function renderLeader() {
        dom.leader.replaceChildren();
        if (!state.leader?.cardNumber) {
            const empty = document.createElement('div');
            empty.className = 'deck-image-import-empty';
            empty.append('リーダーを確認できませんでした。 ');
            empty.appendChild(createActionButton('リーダーを選択', () => openPicker({ type: 'leader' })));
            dom.leader.appendChild(empty);
            return;
        }

        const row = document.createElement('article');
        row.className = `deck-image-import-card-row${state.leader.reviewed ? '' : ' needs-review'}`;
        row.appendChild(getCardVisual(state.leader.cardNumber, state.leader));
        row.appendChild(createCardCopy(
            state.leader.cardNumber,
            state.leader.confidence,
            state.leader.reviewed,
            state.leader
        ));
        const tools = document.createElement('div');
        tools.className = 'deck-image-import-card-tools';
        const actions = document.createElement('div');
        actions.className = 'deck-image-import-row-actions';
        if (!state.leader.reviewed) {
            actions.appendChild(createActionButton('確認', () => {
                state.leader.reviewed = true;
                renderResults();
            }));
        }
        actions.appendChild(createActionButton('候補', () => openPicker({ type: 'leader' }, state.leader.candidates)));
        actions.appendChild(createActionButton('変更', () => openPicker({ type: 'leader' })));
        tools.appendChild(actions);
        row.appendChild(tools);
        dom.leader.appendChild(row);
    }

    function removeOrDecreaseRow(row) {
        if (row.count <= 1) {
            state.rows = state.rows.filter(item => item.id !== row.id);
        } else {
            row.count -= 1;
        }
        renderResults();
    }

    function renderDeckRows() {
        dom.cardList.replaceChildren();
        if (state.rows.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'deck-image-import-empty';
            empty.textContent = 'メインデッキのカードがありません。';
            dom.cardList.appendChild(empty);
            return;
        }

        state.rows.forEach(rowData => {
            const row = document.createElement('article');
            row.className = `deck-image-import-card-row${rowData.reviewed ? '' : ' needs-review'}`;
            row.appendChild(getCardVisual(rowData.cardNumber, rowData));
            row.appendChild(createCardCopy(
                rowData.cardNumber,
                rowData.confidence,
                rowData.reviewed,
                rowData
            ));

            const tools = document.createElement('div');
            tools.className = 'deck-image-import-card-tools';
            const actions = document.createElement('div');
            actions.className = 'deck-image-import-row-actions';
            if (!rowData.reviewed) {
                actions.appendChild(createActionButton('確認', () => {
                    rowData.reviewed = true;
                    renderResults();
                }));
            }
            actions.appendChild(createActionButton('候補', () => openPicker({ type: 'row', id: rowData.id }, rowData.candidates)));
            actions.appendChild(createActionButton('変更', () => openPicker({ type: 'row', id: rowData.id })));

            const stepper = document.createElement('div');
            stepper.className = 'deck-image-import-stepper';
            const minus = document.createElement('button');
            minus.type = 'button';
            minus.setAttribute('aria-label', `${rowData.cardNumber}を1枚減らす`);
            minus.textContent = '−';
            minus.addEventListener('click', () => removeOrDecreaseRow(rowData));
            const count = document.createElement('output');
            count.value = String(rowData.count);
            count.textContent = String(rowData.count);
            count.setAttribute('aria-label', `${rowData.count}枚`);
            const plus = document.createElement('button');
            plus.type = 'button';
            plus.setAttribute('aria-label', `${rowData.cardNumber}を1枚増やす`);
            plus.textContent = '+';
            plus.disabled = rowData.count >= host.maxCopies;
            plus.addEventListener('click', () => {
                rowData.count += 1;
                renderResults();
            });
            stepper.append(minus, count, plus);
            tools.append(actions, stepper);
            row.appendChild(tools);
            dom.cardList.appendChild(row);
        });
    }

    function getDeckDraft() {
        const cards = {};
        state.rows.forEach(row => {
            if (row.cardNumber && row.count > 0) cards[row.cardNumber] = Number(row.count);
        });
        return {
            name: String(dom.name.value || DEFAULT_DECK_NAME).trim() || DEFAULT_DECK_NAME,
            leader: state.leader?.cardNumber || '',
            cards
        };
    }

    function renderSummary() {
        const total = state.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
        const reviewCount = state.rows.filter(row => !row.reviewed).length + (state.leader && !state.leader.reviewed ? 1 : 0);
        const hasCountWarning = total !== host.maxCards;
        dom.summary.classList.toggle('is-warning', hasCountWarning || reviewCount > 0 || !state.leader);
        const totalElement = document.createElement('strong');
        totalElement.textContent = `メインデッキ ${total} / ${host.maxCards}枚`;
        const note = document.createElement('span');
        note.className = 'deck-image-import-summary-note';
        const notes = [`${state.rows.length}種類`, `${state.regions.length}領域`, state.layout];
        if (reviewCount > 0) notes.unshift(`要確認 ${reviewCount}件`);
        if (hasCountWarning) notes.unshift(`${host.maxCards}枚ではありません`);
        note.textContent = notes.filter(Boolean).join(' · ');
        dom.summary.replaceChildren(totalElement, note);
        const canExport = Boolean(state.leader?.cardNumber) && reviewCount === 0 && state.rows.length > 0;
        dom.acceptBtn.disabled = state.busy || !canExport;
        dom.copyUrlBtn.disabled = state.busy || !canExport;
    }

    function renderResults() {
        dom.results.hidden = false;
        dom.analyzeBtn.hidden = true;
        dom.acceptBtn.hidden = false;
        dom.copyUrlBtn.hidden = false;
        renderLeader();
        renderDeckRows();
        renderSummary();
        dom.body.scrollTop = Math.max(0, dom.results.offsetTop - 12);
    }

    function mergeDuplicateRows() {
        const grouped = new Map();
        state.rows.forEach(row => {
            const existing = grouped.get(row.cardNumber);
            if (!existing) {
                grouped.set(row.cardNumber, row);
                return;
            }
            existing.count += row.count;
            existing.confidence = Math.min(existing.confidence, row.confidence);
            existing.reviewed = existing.reviewed && row.reviewed;
            existing.candidates = [...existing.candidates, ...row.candidates]
                .filter((candidate, index, all) => all.findIndex(item => item.cardNumber === candidate.cardNumber) === index)
                .slice(0, 3);
            (row.variantVotes || []).forEach(vote => addVariantVote(existing, vote, vote.count));
        });
        state.rows = [...grouped.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber, 'en', { numeric: true }));
    }

    function closePicker() {
        if (!dom.picker) return;
        dom.picker.hidden = true;
        state.pickerTarget = null;
        state.pickerCandidates = [];
        clearTimeout(pickerSearchTimer);
    }

    function openPicker(target, candidates = []) {
        state.pickerTarget = target;
        state.pickerCandidates = Array.isArray(candidates) ? candidates : [];
        dom.pickerSearch.value = '';
        dom.picker.hidden = false;
        renderPickerList();
        requestAnimationFrame(() => dom.pickerSearch.focus());
    }

    function getPickerRole() {
        return state.pickerTarget?.type === 'leader' ? 'leader' : 'deck';
    }

    function renderPickerList() {
        const query = dom.pickerSearch.value.trim();
        let options = [];
        if (query) {
            options = host.searchCards(query, getPickerRole()).slice(0, 40)
                .map(card => ({ card, candidate: null }));
        } else if (state.pickerCandidates.length) {
            options = state.pickerCandidates
                .map(candidate => ({
                    card: host.findCard(candidate.cardNumber),
                    candidate
                }))
                .filter(option => Boolean(option.card));
        } else {
            options = host.searchCards('', getPickerRole()).slice(0, 30)
                .map(card => ({ card, candidate: null }));
        }
        dom.pickerList.replaceChildren();
        if (!options.length) {
            const empty = document.createElement('p');
            empty.className = 'deck-image-import-empty';
            empty.textContent = '該当するカードがありません。';
            dom.pickerList.appendChild(empty);
            return;
        }

        options.forEach(({ card, candidate }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'deck-image-import-picker-card';
            button.appendChild(getCardVisual(card.cardNumber, candidate));
            const copy = document.createElement('div');
            const number = document.createElement('strong');
            number.textContent = card.cardNumber;
            const name = document.createElement('span');
            name.textContent = card.cardName || '';
            copy.append(number, name);
            const variant = getVariantVisual(card.cardNumber, candidate);
            if (variant.type !== 'normal' && variant.label) {
                const variantLabel = document.createElement('span');
                variantLabel.className = 'deck-image-import-picker-variant';
                variantLabel.textContent = variant.label;
                copy.appendChild(variantLabel);
            }
            button.appendChild(copy);
            button.addEventListener('click', () => selectPickerCard(card, candidate));
            dom.pickerList.appendChild(button);
        });
    }

    function selectPickerCard(card, candidate = null) {
        const target = state.pickerTarget;
        if (!target || !card?.cardNumber) return;
        if (target.type === 'leader') {
            state.leader = {
                cardNumber: card.cardNumber,
                confidence: 1,
                reviewed: true,
                candidates: [{ cardNumber: card.cardNumber, score: 1 }],
                regionId: state.leader?.regionId || '',
                variantPath: candidate?.variantPath || '',
                variantIndex: Number(candidate?.variantIndex) || 0
            };
        } else if (target.type === 'row') {
            const row = state.rows.find(item => item.id === target.id);
            if (row) {
                row.cardNumber = card.cardNumber;
                row.confidence = 1;
                row.reviewed = true;
                row.candidates = [{ cardNumber: card.cardNumber, score: 1 }];
                setRowVariant(row, candidate);
                mergeDuplicateRows();
            }
        } else if (target.type === 'add') {
            const existing = state.rows.find(item => item.cardNumber === card.cardNumber);
            if (existing) {
                existing.count = Math.min(host.maxCopies, existing.count + 1);
                existing.reviewed = true;
            } else {
                state.rows.push({
                    id: `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    cardNumber: card.cardNumber,
                    count: 1,
                    confidence: 1,
                    reviewed: true,
                    candidates: [{ cardNumber: card.cardNumber, score: 1 }],
                    regionIds: [],
                    variantVotes: [],
                    variantPath: '',
                    variantIndex: 0
                });
                mergeDuplicateRows();
            }
        }
        closePicker();
        renderResults();
    }

    async function validateDraft() {
        const reviewCount = state.rows.filter(row => !row.reviewed).length + (state.leader && !state.leader.reviewed ? 1 : 0);
        if (!state.leader?.cardNumber) throw new Error('リーダーカードを選択してください。');
        if (reviewCount > 0) throw new Error(`要確認の認識結果が${reviewCount}件あります。`);
        const draft = getDeckDraft();
        draft.cards = host.validateCards(Object.entries(draft.cards), draft.leader);
        return draft;
    }

    async function saveAndEditDeck() {
        if (state.busy) return;
        try {
            const draft = await validateDraft();
            setBusy(true);
            await host.saveAndEdit(draft);
            closeImport();
        } catch (error) {
            host.showToast(error?.message || 'デッキを作成できませんでした。', 'error');
        } finally {
            setBusy(false);
            renderSummary();
        }
    }

    async function copyShareUrl() {
        if (state.busy) return;
        try {
            const draft = await validateDraft();
            await host.copyShareUrl(draft);
        } catch (error) {
            host.showToast(error?.message || '共有URLをコピーできませんでした。', 'error');
        }
    }

    function bindEvents() {
        dom.openBtn?.addEventListener('click', openImport);
        dom.closeBtn?.addEventListener('click', closeImport);
        dom.modal?.addEventListener('click', event => {
            if (event.target === dom.modal && !state.busy) closeImport();
        });
        dom.input?.addEventListener('change', handleFileSelection);
        dom.analyzeBtn?.addEventListener('click', analyzeImage);
        dom.resetBtn?.addEventListener('click', resetImport);
        dom.acceptBtn?.addEventListener('click', saveAndEditDeck);
        dom.copyUrlBtn?.addEventListener('click', copyShareUrl);
        dom.addCardBtn?.addEventListener('click', () => openPicker({ type: 'add' }));
        dom.pickerCloseBtn?.addEventListener('click', closePicker);
        dom.pickerSearch?.addEventListener('input', () => {
            clearTimeout(pickerSearchTimer);
            pickerSearchTimer = setTimeout(renderPickerList, 120);
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || dom.modal?.style.display === 'none') return;
            if (!dom.picker.hidden) closePicker();
            else if (!state.busy) closeImport();
        });
    }

    function init(imageImportHost) {
        host = imageImportHost;
        cacheDom();
        if (!host || !dom.openBtn || !dom.modal) return;
        bindEvents();
    }

    const api = { init };
    if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
        api.__test = {
            detectCardRegions,
            createImageFeature,
            matchFeatures,
            chooseLeaderResult,
            aggregateDeckRows,
            featureWidth: FEATURE_WIDTH,
            featureHeight: FEATURE_HEIGHT
        };
    }
    window.OPTCGImageImport = api;
})();
