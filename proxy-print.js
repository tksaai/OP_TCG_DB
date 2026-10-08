(function (global) {
    'use strict';

    const STORAGE_KEY = 'opTcgProxyPrintSettingsV1';
    const MAX_ITEM_COUNT = 99;
    const MAX_TOTAL_COPIES = 500;
    const MM_TO_PT = 72 / 25.4;
    const PAPER_SIZES = Object.freeze({
        A4: [210, 297],
        B5: [182, 257],
        B4: [257, 364],
        A3: [297, 420],
        LETTER: [215.9, 279.4]
    });
    const CARD_SIZES = Object.freeze({
        standard: [63, 88],
        small: [59, 86]
    });
    const DEFAULT_SETTINGS = Object.freeze({
        paperSize: 'A4',
        orientation: 'auto',
        customPaperWidth: 210,
        customPaperHeight: 297,
        cardSize: 'standard',
        customCardWidth: 63,
        customCardHeight: 88,
        edgeInset: 0
    });

    let initialized = false;
    let currentJob = null;
    let currentSettings = { ...DEFAULT_SETTINGS };
    let currentScope = 'all';
    let includeLeader = true;
    let activeMobileView = 'settings';
    let countsByScope = { all: {}, missing: {} };
    let cachedPdf = null;
    let cachedSignature = '';
    let returnFocusElement = null;
    const dom = {};

    const $ = selector => document.querySelector(selector);

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(Math.max(number, min), max);
    }

    function clampCount(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return Math.min(Math.max(Math.trunc(number), 0), MAX_ITEM_COUNT);
    }

    function uniqueStrings(values) {
        return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
    }

    function normalizeSettings(value = {}) {
        const paperSize = [...Object.keys(PAPER_SIZES), 'custom'].includes(value.paperSize)
            ? value.paperSize
            : DEFAULT_SETTINGS.paperSize;
        const orientation = ['auto', 'portrait', 'landscape'].includes(value.orientation)
            ? value.orientation
            : DEFAULT_SETTINGS.orientation;
        const cardSize = [...Object.keys(CARD_SIZES), 'custom'].includes(value.cardSize)
            ? value.cardSize
            : DEFAULT_SETTINGS.cardSize;
        return {
            paperSize,
            orientation,
            customPaperWidth: clampNumber(value.customPaperWidth, 80, 1000, DEFAULT_SETTINGS.customPaperWidth),
            customPaperHeight: clampNumber(value.customPaperHeight, 80, 1000, DEFAULT_SETTINGS.customPaperHeight),
            cardSize,
            customCardWidth: clampNumber(value.customCardWidth, 20, 200, DEFAULT_SETTINGS.customCardWidth),
            customCardHeight: clampNumber(value.customCardHeight, 20, 300, DEFAULT_SETTINGS.customCardHeight),
            edgeInset: clampNumber(value.edgeInset, 0, 30, DEFAULT_SETTINGS.edgeInset)
        };
    }

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return normalizeSettings(saved);
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings));
        } catch {
            // Printing still works when storage is unavailable.
        }
    }

    function normalizeItem(item, index) {
        const cardNumber = String(item?.cardNumber || '').trim().toUpperCase();
        const variantId = String(item?.variantId || cardNumber).trim();
        const role = item?.isLeader ? 'leader' : 'main';
        return {
            key: String(item?.key || `${role}:${cardNumber}:${variantId}:${index}`),
            cardNumber: cardNumber || 'UNKNOWN',
            cardName: String(item?.cardName || cardNumber || '未登録カード'),
            variantId,
            variantLabel: String(item?.variantLabel || ''),
            sources: uniqueStrings(item?.sources || [item?.imagePath, item?.fallbackPath]),
            count: clampCount(item?.count),
            missingCount: clampCount(item?.missingCount),
            isLeader: item?.isLeader === true
        };
    }

    function normalizeJob(job) {
        const seen = new Set();
        const items = (Array.isArray(job?.items) ? job.items : [])
            .map(normalizeItem)
            .filter(item => {
                if (!item.cardNumber || seen.has(item.key)) return false;
                seen.add(item.key);
                return item.count > 0 || item.missingCount > 0;
            });
        return {
            name: String(job?.name || 'デッキ').trim().slice(0, 80) || 'デッキ',
            items,
            defaultScope: job?.defaultScope === 'missing' ? 'missing' : 'all'
        };
    }

    function getPaperDimensions(settings) {
        return settings.paperSize === 'custom'
            ? [settings.customPaperWidth, settings.customPaperHeight]
            : PAPER_SIZES[settings.paperSize] || PAPER_SIZES.A4;
    }

    function getCardDimensions(settings) {
        return settings.cardSize === 'custom'
            ? [settings.customCardWidth, settings.customCardHeight]
            : CARD_SIZES[settings.cardSize] || CARD_SIZES.standard;
    }

    function calculateCapacity(pageWidth, pageHeight, cardWidth, cardHeight, inset) {
        const availableWidth = Math.max(0, pageWidth - inset * 2);
        const availableHeight = Math.max(0, pageHeight - inset * 2);
        const columns = Math.floor((availableWidth + 1e-7) / cardWidth);
        const rows = Math.floor((availableHeight + 1e-7) / cardHeight);
        return {
            pageWidth,
            pageHeight,
            columns,
            rows,
            capacity: Math.max(0, columns * rows)
        };
    }

    function resolveLayout(settingsValue, totalCopies = 0) {
        const settings = normalizeSettings(settingsValue);
        const [rawPaperWidth, rawPaperHeight] = getPaperDimensions(settings);
        const [cardWidth, cardHeight] = getCardDimensions(settings);
        const portrait = calculateCapacity(
            Math.min(rawPaperWidth, rawPaperHeight),
            Math.max(rawPaperWidth, rawPaperHeight),
            cardWidth,
            cardHeight,
            settings.edgeInset
        );
        const landscape = calculateCapacity(
            Math.max(rawPaperWidth, rawPaperHeight),
            Math.min(rawPaperWidth, rawPaperHeight),
            cardWidth,
            cardHeight,
            settings.edgeInset
        );
        let selected = portrait;
        if (settings.orientation === 'landscape') selected = landscape;
        if (settings.orientation === 'auto' && landscape.capacity > portrait.capacity) selected = landscape;
        return {
            ...selected,
            cardWidth,
            cardHeight,
            inset: settings.edgeInset,
            totalCopies,
            pageCount: selected.capacity > 0 ? Math.ceil(totalCopies / selected.capacity) : 0
        };
    }

    function getActiveCounts() {
        return countsByScope[currentScope] || countsByScope.all;
    }

    function getItemCount(item) {
        if (item.isLeader && !includeLeader) return 0;
        return clampCount(getActiveCounts()[item.key]);
    }

    function getSelectedItems() {
        if (!currentJob) return [];
        return currentJob.items
            .map(item => ({ ...item, printCount: getItemCount(item) }))
            .filter(item => item.printCount > 0);
    }

    function getTotalCopies() {
        return getSelectedItems().reduce((sum, item) => sum + item.printCount, 0);
    }

    function setHidden(element, hidden) {
        if (!element) return;
        element.hidden = hidden;
    }

    function syncSettingsInputs() {
        dom.paperSize.value = currentSettings.paperSize;
        dom.orientation.value = currentSettings.orientation;
        dom.paperWidth.value = String(currentSettings.customPaperWidth);
        dom.paperHeight.value = String(currentSettings.customPaperHeight);
        dom.cardSize.value = currentSettings.cardSize;
        dom.cardWidth.value = String(currentSettings.customCardWidth);
        dom.cardHeight.value = String(currentSettings.customCardHeight);
        dom.edgeInset.value = String(currentSettings.edgeInset);
        setHidden(dom.customPaperFields, currentSettings.paperSize !== 'custom');
        setHidden(dom.customCardFields, currentSettings.cardSize !== 'custom');
    }

    function readSettingsInputs() {
        currentSettings = normalizeSettings({
            paperSize: dom.paperSize.value,
            orientation: dom.orientation.value,
            customPaperWidth: dom.paperWidth.value,
            customPaperHeight: dom.paperHeight.value,
            cardSize: dom.cardSize.value,
            customCardWidth: dom.cardWidth.value,
            customCardHeight: dom.cardHeight.value,
            edgeInset: dom.edgeInset.value
        });
        syncSettingsInputs();
        saveSettings();
    }

    function invalidatePdf() {
        cachedPdf = null;
        cachedSignature = '';
    }

    function setStatus(message, type = '') {
        if (!dom.status) return;
        dom.status.textContent = message || '';
        dom.status.dataset.type = type;
    }

    function setBusy(busy) {
        [dom.downloadButton, dom.shareButton, dom.printButton].forEach(button => {
            if (button) button.disabled = busy;
        });
        dom.modal?.classList.toggle('is-busy', busy);
    }

    function createImage(item, className) {
        const image = document.createElement('img');
        image.className = className;
        image.alt = item.cardName;
        image.loading = 'lazy';
        const sources = [...item.sources];
        let sourceIndex = 0;
        const applyNextSource = () => {
            if (sourceIndex >= sources.length) {
                image.removeAttribute('src');
                image.classList.add('is-missing');
                return;
            }
            image.src = sources[sourceIndex++];
        };
        image.addEventListener('error', applyNextSource);
        applyNextSource();
        return image;
    }

    function createStepper(item) {
        const stepper = document.createElement('div');
        stepper.className = 'proxy-print-stepper';
        stepper.setAttribute('role', 'group');
        stepper.setAttribute('aria-label', `${item.cardNumber}の印刷枚数`);

        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '−';
        minus.setAttribute('aria-label', `${item.cardNumber}を1枚減らす`);

        const count = document.createElement('input');
        count.type = 'number';
        count.min = '0';
        count.max = String(MAX_ITEM_COUNT);
        count.inputMode = 'numeric';
        count.value = String(getItemCount(item));
        count.setAttribute('aria-label', `${item.cardNumber}の印刷枚数`);

        const plus = document.createElement('button');
        plus.type = 'button';
        plus.textContent = '+';
        plus.setAttribute('aria-label', `${item.cardNumber}を1枚増やす`);

        const update = value => {
            getActiveCounts()[item.key] = clampCount(value);
            invalidatePdf();
            render();
        };
        minus.addEventListener('click', () => update(getItemCount(item) - 1));
        plus.addEventListener('click', () => update(getItemCount(item) + 1));
        count.addEventListener('change', () => update(count.value));
        stepper.append(minus, count, plus);
        return stepper;
    }

    function renderItems() {
        if (!dom.itemList || !currentJob) return;
        const fragment = document.createDocumentFragment();
        currentJob.items.forEach(item => {
            const row = document.createElement('article');
            row.className = 'proxy-print-item';
            if (item.isLeader) row.classList.add('is-leader');
            if (getItemCount(item) === 0) row.classList.add('is-zero');

            const visual = document.createElement('div');
            visual.className = 'proxy-print-item-visual';
            visual.appendChild(createImage(item, 'proxy-print-item-image'));
            row.appendChild(visual);

            const details = document.createElement('div');
            details.className = 'proxy-print-item-details';
            const number = document.createElement('strong');
            number.textContent = item.cardNumber;
            const name = document.createElement('span');
            name.textContent = item.cardName;
            details.append(number, name);
            if (item.variantLabel && item.variantLabel !== '通常') {
                const variant = document.createElement('small');
                variant.textContent = item.variantLabel;
                details.appendChild(variant);
            }
            if (item.isLeader) {
                const leader = document.createElement('small');
                leader.className = 'proxy-print-item-role';
                leader.textContent = 'リーダー';
                details.appendChild(leader);
            }
            row.appendChild(details);
            row.appendChild(createStepper(item));
            fragment.appendChild(row);
        });
        dom.itemList.replaceChildren(fragment);
    }

    function renderPreviewCard(item, layout, position) {
        const card = document.createElement('div');
        card.className = 'proxy-print-preview-card';
        const column = position % layout.columns;
        const row = Math.floor(position / layout.columns);
        card.style.left = `${((layout.inset + column * layout.cardWidth) / layout.pageWidth) * 100}%`;
        card.style.top = `${((layout.inset + row * layout.cardHeight) / layout.pageHeight) * 100}%`;
        card.style.width = `${(layout.cardWidth / layout.pageWidth) * 100}%`;
        card.style.height = `${(layout.cardHeight / layout.pageHeight) * 100}%`;
        card.appendChild(createImage(item, 'proxy-print-preview-image'));
        return card;
    }

    function renderPreview() {
        if (!dom.pages) return;
        const selectedItems = getSelectedItems();
        const copies = selectedItems.flatMap(item => Array.from({ length: item.printCount }, () => item));
        const layout = resolveLayout(currentSettings, copies.length);
        dom.pages.replaceChildren();

        const invalidLayout = layout.capacity < 1;
        const tooMany = copies.length > MAX_TOTAL_COPIES;
        const noCards = copies.length === 0;
        if (invalidLayout || tooMany || noCards) {
            const empty = document.createElement('p');
            empty.className = 'proxy-print-preview-empty';
            empty.textContent = invalidLayout
                ? 'カードサイズが用紙に収まりません。'
                : tooMany
                    ? `印刷枚数は${MAX_TOTAL_COPIES}枚以下にしてください。`
                    : '印刷するカードがありません。';
            dom.pages.appendChild(empty);
        } else {
            const pageCount = Math.ceil(copies.length / layout.capacity);
            for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
                const figure = document.createElement('figure');
                figure.className = 'proxy-print-page-frame';
                const page = document.createElement('div');
                page.className = 'proxy-print-page';
                page.style.aspectRatio = `${layout.pageWidth} / ${layout.pageHeight}`;
                const pageCopies = copies.slice(
                    pageIndex * layout.capacity,
                    (pageIndex + 1) * layout.capacity
                );
                pageCopies.forEach((item, position) => {
                    page.appendChild(renderPreviewCard(item, layout, position));
                });
                const caption = document.createElement('figcaption');
                caption.textContent = `${pageIndex + 1} / ${pageCount}`;
                figure.append(page, caption);
                dom.pages.appendChild(figure);
            }
        }

        const orientationLabel = layout.pageWidth > layout.pageHeight ? '横' : '縦';
        dom.summary.textContent = invalidLayout
            ? '配置できません'
            : `${copies.length}枚・${layout.pageCount}ページ・${layout.columns}列×${layout.rows}行・${orientationLabel}`;
        const actionsDisabled = invalidLayout || tooMany || noCards;
        [dom.downloadButton, dom.shareButton, dom.printButton].forEach(button => {
            if (button) button.disabled = actionsDisabled;
        });
        if (invalidLayout) setStatus('カードサイズまたは用紙余白を調整してください。', 'error');
        else if (tooMany) setStatus(`一度に印刷できるのは${MAX_TOTAL_COPIES}枚までです。`, 'error');
        else setStatus('');
    }

    function syncScopeControls() {
        dom.scopeButtons.forEach(button => {
            const selected = button.dataset.proxyScope === currentScope;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        dom.includeLeader.checked = includeLeader;
    }

    function syncMobileView() {
        dom.viewButtons.forEach(button => {
            const selected = button.dataset.proxyView === activeMobileView;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
        dom.modal.dataset.mobileView = activeMobileView;
    }

    function render() {
        if (!currentJob) return;
        syncScopeControls();
        syncMobileView();
        renderItems();
        renderPreview();
    }

    function sanitizeFilename(value) {
        return String(value || 'デッキ')
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || 'デッキ';
    }

    function loadImageSource(source) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
            image.src = source;
        });
    }

    async function loadItemImage(item) {
        for (const source of item.sources) {
            try {
                return await loadImageSource(source);
            } catch {
                // Try the next local image candidate.
            }
        }
        return null;
    }

    function canvasToJpeg(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('PDF用画像を作成できませんでした。'));
            }, 'image/jpeg', 0.96);
        });
    }

    function drawPlaceholder(ctx, width, height, item) {
        ctx.fillStyle = '#20242a';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#18c7bb';
        ctx.fillRect(0, 0, width, Math.max(14, height * 0.025));
        ctx.fillStyle = '#f4f5f6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${Math.max(22, Math.round(width * 0.07))}px sans-serif`;
        ctx.fillText(item.cardNumber, width / 2, height / 2 - 20);
        ctx.fillStyle = '#bec3ca';
        ctx.font = `600 ${Math.max(16, Math.round(width * 0.04))}px sans-serif`;
        ctx.fillText(item.cardName.slice(0, 22), width / 2, height / 2 + 34);
    }

    async function createJpegRecord(item) {
        const image = await loadItemImage(item);
        const width = image?.naturalWidth || 600;
        const height = image?.naturalHeight || 838;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('PDF用画像の描画を開始できません。');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        if (image) ctx.drawImage(image, 0, 0, width, height);
        else drawPlaceholder(ctx, width, height, item);
        const blob = await canvasToJpeg(canvas);
        return {
            key: item.key,
            width,
            height,
            bytes: new Uint8Array(await blob.arrayBuffer())
        };
    }

    function concatBytes(chunks, totalLength) {
        const output = new Uint8Array(totalLength);
        let offset = 0;
        chunks.forEach(chunk => {
            output.set(chunk, offset);
            offset += chunk.length;
        });
        return output;
    }

    function formatPdfNumber(value) {
        return Number(value.toFixed(4)).toString();
    }

    function buildPdfBytes(options) {
        const encoder = new TextEncoder();
        const copies = options.copies || [];
        const images = options.images || [];
        const capacity = options.columns * options.rows;
        if (!copies.length || capacity < 1) throw new Error('PDFに配置できるカードがありません。');
        const pages = [];
        for (let index = 0; index < copies.length; index += capacity) {
            pages.push(copies.slice(index, index + capacity));
        }

        const imageObjectIds = new Map();
        images.forEach((image, index) => imageObjectIds.set(image.key, 3 + index));
        const firstPageObjectId = 3 + images.length;
        const pageObjects = pages.map((_, index) => ({
            pageId: firstPageObjectId + index * 2,
            contentId: firstPageObjectId + index * 2 + 1
        }));
        const objectCount = 2 + images.length + pages.length * 2;
        const offsets = new Array(objectCount + 1).fill(0);
        const chunks = [];
        let length = 0;
        const pushBytes = bytes => {
            chunks.push(bytes);
            length += bytes.length;
        };
        const pushText = text => pushBytes(encoder.encode(text));
        const beginObject = id => {
            offsets[id] = length;
            pushText(`${id} 0 obj\n`);
        };
        const endObject = () => pushText('endobj\n');

        pushText('%PDF-1.4\n%');
        pushBytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

        beginObject(1);
        pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
        endObject();

        beginObject(2);
        pushText(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjects.map(page => `${page.pageId} 0 R`).join(' ')}] >>\n`);
        endObject();

        images.forEach(image => {
            const id = imageObjectIds.get(image.key);
            beginObject(id);
            pushText(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Interpolate true /Length ${image.bytes.length} >>\nstream\n`);
            pushBytes(image.bytes);
            pushText('\nendstream\n');
            endObject();
        });

        const pageWidthPt = options.pageWidthMm * MM_TO_PT;
        const pageHeightPt = options.pageHeightMm * MM_TO_PT;
        const cardWidthPt = options.cardWidthMm * MM_TO_PT;
        const cardHeightPt = options.cardHeightMm * MM_TO_PT;
        const insetPt = options.insetMm * MM_TO_PT;

        pages.forEach((pageCopies, pageIndex) => {
            const { pageId, contentId } = pageObjects[pageIndex];
            const usedImageKeys = [...new Set(pageCopies.map(copy => copy.key))];
            const resources = usedImageKeys
                .map(key => `/Im${imageObjectIds.get(key)} ${imageObjectIds.get(key)} 0 R`)
                .join(' ');
            let content = '';
            pageCopies.forEach((copy, position) => {
                const column = position % options.columns;
                const row = Math.floor(position / options.columns);
                const x = insetPt + column * cardWidthPt;
                const y = pageHeightPt - insetPt - (row + 1) * cardHeightPt;
                content += `q ${formatPdfNumber(cardWidthPt)} 0 0 ${formatPdfNumber(cardHeightPt)} ${formatPdfNumber(x)} ${formatPdfNumber(y)} cm /Im${imageObjectIds.get(copy.key)} Do Q\n`;
            });
            const contentBytes = encoder.encode(content);

            beginObject(pageId);
            pushText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPdfNumber(pageWidthPt)} ${formatPdfNumber(pageHeightPt)}] /Resources << /XObject << ${resources} >> >> /Contents ${contentId} 0 R >>\n`);
            endObject();

            beginObject(contentId);
            pushText(`<< /Length ${contentBytes.length} >>\nstream\n`);
            pushBytes(contentBytes);
            pushText('endstream\n');
            endObject();
        });

        const xrefOffset = length;
        pushText(`xref\n0 ${objectCount + 1}\n`);
        pushText('0000000000 65535 f \n');
        for (let id = 1; id <= objectCount; id += 1) {
            pushText(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
        }
        pushText(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
        return concatBytes(chunks, length);
    }

    function getPdfSignature() {
        return JSON.stringify({
            name: currentJob?.name,
            settings: currentSettings,
            scope: currentScope,
            includeLeader,
            counts: getActiveCounts(),
            sources: currentJob?.items.map(item => [item.key, item.sources])
        });
    }

    async function createPdfFile() {
        const signature = getPdfSignature();
        if (cachedPdf && signature === cachedSignature) return cachedPdf;
        const selectedItems = getSelectedItems();
        const totalCopies = selectedItems.reduce((sum, item) => sum + item.printCount, 0);
        const layout = resolveLayout(currentSettings, totalCopies);
        if (!totalCopies || layout.capacity < 1 || totalCopies > MAX_TOTAL_COPIES) {
            throw new Error('PDFの作成条件を確認してください。');
        }
        const copies = selectedItems.flatMap(item => (
            Array.from({ length: item.printCount }, () => ({ key: item.key }))
        ));
        const images = [];
        for (let index = 0; index < selectedItems.length; index += 1) {
            setStatus(`PDF用画像を準備中 ${index + 1} / ${selectedItems.length}`, 'progress');
            images.push(await createJpegRecord(selectedItems[index]));
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        setStatus('PDFを作成中...', 'progress');
        const bytes = buildPdfBytes({
            pageWidthMm: layout.pageWidth,
            pageHeightMm: layout.pageHeight,
            cardWidthMm: layout.cardWidth,
            cardHeightMm: layout.cardHeight,
            insetMm: layout.inset,
            columns: layout.columns,
            rows: layout.rows,
            copies,
            images
        });
        const filename = `${sanitizeFilename(currentJob.name)}-プロキシ印刷.pdf`;
        cachedPdf = new File([bytes], filename, { type: 'application/pdf' });
        cachedSignature = signature;
        setStatus(`PDF作成完了・${layout.pageCount}ページ`, 'success');
        return cachedPdf;
    }

    function downloadFile(file) {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async function withPdf(action) {
        setBusy(true);
        try {
            const file = await createPdfFile();
            await action(file);
        } catch (error) {
            console.error('Proxy print PDF generation failed.');
            setStatus(error?.message || 'PDFを作成できませんでした。', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function downloadPdf() {
        await withPdf(async file => downloadFile(file));
    }

    async function sharePdf() {
        await withPdf(async file => {
            if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
                try {
                    await navigator.share({ title: currentJob.name, files: [file] });
                    return;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return;
                }
            }
            downloadFile(file);
            setStatus('共有に対応していないためPDFを保存しました。', 'success');
        });
    }

    async function printPdf() {
        await withPdf(async file => {
            const url = URL.createObjectURL(file);
            const frame = document.createElement('iframe');
            frame.className = 'proxy-print-frame';
            frame.title = '印刷用PDF';
            frame.addEventListener('load', () => {
                try {
                    frame.contentWindow?.focus();
                    frame.contentWindow?.print();
                } catch {
                    window.open(url, '_blank', 'noopener');
                }
            }, { once: true });
            frame.src = url;
            document.body.appendChild(frame);
            setTimeout(() => {
                frame.remove();
                URL.revokeObjectURL(url);
            }, 120000);
        });
    }

    function open(job) {
        init();
        currentJob = normalizeJob(job);
        if (!currentJob.items.length) throw new Error('印刷できるカードがありません。');
        currentSettings = loadSettings();
        currentScope = currentJob.defaultScope;
        includeLeader = true;
        activeMobileView = 'settings';
        countsByScope = { all: {}, missing: {} };
        currentJob.items.forEach(item => {
            countsByScope.all[item.key] = item.count;
            countsByScope.missing[item.key] = item.missingCount;
        });
        invalidatePdf();
        returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dom.title.textContent = `${currentJob.name} プロキシ印刷`;
        syncSettingsInputs();
        dom.modal.style.display = 'flex';
        dom.modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('proxy-print-open');
        dom.shareButton.hidden = typeof navigator.share !== 'function';
        render();
        requestAnimationFrame(() => dom.closeButton.focus());
    }

    function close() {
        if (!initialized || dom.modal.getAttribute('aria-hidden') === 'true') return;
        dom.modal.style.display = 'none';
        dom.modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('proxy-print-open');
        currentJob = null;
        invalidatePdf();
        setStatus('');
        returnFocusElement?.focus?.();
        returnFocusElement = null;
    }

    function bindSettingsInput(element) {
        element.addEventListener('change', () => {
            readSettingsInputs();
            invalidatePdf();
            renderPreview();
        });
    }

    function init() {
        if (initialized || typeof document === 'undefined') return;
        dom.modal = $('#proxy-print-modal');
        if (!dom.modal) return;
        dom.title = $('#proxy-print-title');
        dom.closeButton = $('#proxy-print-close-btn');
        dom.scopeButtons = [...document.querySelectorAll('[data-proxy-scope]')];
        dom.viewButtons = [...document.querySelectorAll('[data-proxy-view]')];
        dom.includeLeader = $('#proxy-print-include-leader');
        dom.paperSize = $('#proxy-print-paper-size');
        dom.orientation = $('#proxy-print-orientation');
        dom.customPaperFields = $('#proxy-print-custom-paper-fields');
        dom.paperWidth = $('#proxy-print-paper-width');
        dom.paperHeight = $('#proxy-print-paper-height');
        dom.cardSize = $('#proxy-print-card-size');
        dom.customCardFields = $('#proxy-print-custom-card-fields');
        dom.cardWidth = $('#proxy-print-card-width');
        dom.cardHeight = $('#proxy-print-card-height');
        dom.edgeInset = $('#proxy-print-edge-inset');
        dom.itemList = $('#proxy-print-item-list');
        dom.summary = $('#proxy-print-summary');
        dom.pages = $('#proxy-print-pages');
        dom.status = $('#proxy-print-status');
        dom.downloadButton = $('#proxy-print-download-btn');
        dom.shareButton = $('#proxy-print-share-btn');
        dom.printButton = $('#proxy-print-print-btn');

        dom.closeButton.addEventListener('click', close);
        dom.modal.addEventListener('click', event => {
            if (event.target === dom.modal) close();
        });
        dom.scopeButtons.forEach(button => {
            button.addEventListener('click', () => {
                currentScope = button.dataset.proxyScope === 'missing' ? 'missing' : 'all';
                invalidatePdf();
                render();
            });
        });
        dom.viewButtons.forEach(button => {
            button.addEventListener('click', () => {
                activeMobileView = button.dataset.proxyView === 'preview' ? 'preview' : 'settings';
                syncMobileView();
            });
        });
        dom.includeLeader.addEventListener('change', () => {
            includeLeader = dom.includeLeader.checked;
            invalidatePdf();
            render();
        });
        [
            dom.paperSize,
            dom.orientation,
            dom.paperWidth,
            dom.paperHeight,
            dom.cardSize,
            dom.cardWidth,
            dom.cardHeight,
            dom.edgeInset
        ].forEach(bindSettingsInput);
        dom.downloadButton.addEventListener('click', downloadPdf);
        dom.shareButton.addEventListener('click', sharePdf);
        dom.printButton.addEventListener('click', printPdf);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && dom.modal.getAttribute('aria-hidden') === 'false') close();
        });
        initialized = true;
    }

    global.OPTCGProxyPrint = Object.freeze({
        open,
        close,
        resolveLayout,
        buildPdfBytes,
        normalizeSettings,
        constants: Object.freeze({ PAPER_SIZES, CARD_SIZES, MAX_TOTAL_COPIES })
    });

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
        else init();
    }
})(window);
