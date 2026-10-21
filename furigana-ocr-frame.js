(function() {
    'use strict';

    const CHANNEL = 'op-tcg-furigana-ocr';
    const HIRAGANA_WHITELIST = 'ぁあぃいぅうぇえぉおかがきぎくぐけげこござさしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわをんー';
    let workerPromise = null;
    let activeRequestId = '';
    let queue = Promise.resolve();

    function send(message) {
        parent.postMessage({ channel: CHANNEL, ...message }, '*');
    }

    async function getWorker() {
        if (workerPromise) return workerPromise;
        if (!self.Tesseract) throw new Error('OCRライブラリを読み込めませんでした。');
        workerPromise = (async () => {
            const worker = await self.Tesseract.createWorker('jpn', 1, {
                logger(message) {
                    if (message.status === 'recognizing text') {
                        send({
                            type: 'progress',
                            requestId: activeRequestId,
                            progress: Number(message.progress || 0)
                        });
                    }
                }
            });
            await worker.setParameters({
                tessedit_pageseg_mode: self.Tesseract.PSM.SINGLE_LINE,
                preserve_interword_spaces: '1',
                user_defined_dpi: '300',
                tessedit_char_whitelist: HIRAGANA_WHITELIST
            });
            return worker;
        })();
        return workerPromise;
    }

    async function recognize(requestId, image) {
        activeRequestId = requestId;
        try {
            const worker = await getWorker();
            const result = await worker.recognize(image);
            send({
                type: 'result',
                requestId,
                text: String(result?.data?.text || '').slice(0, 256),
                confidence: Number(result?.data?.confidence || 0)
            });
        } catch (error) {
            send({
                type: 'error',
                requestId,
                message: error instanceof Error ? error.message : '画像を解析できませんでした。'
            });
        } finally {
            activeRequestId = '';
        }
    }

    addEventListener('message', event => {
        const data = event.data;
        if (event.source !== parent || !data || data.channel !== CHANNEL) return;
        if (data.type === 'ping') {
            send({ type: 'ready' });
            return;
        }
        if (data.type !== 'recognize' || typeof data.requestId !== 'string' || !(data.image instanceof Blob)) return;
        queue = queue.then(() => recognize(data.requestId, data.image));
    });

    send({ type: 'ready' });
})();
