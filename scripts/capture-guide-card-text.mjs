import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:49200/';
const OUTPUT_PATH = path.resolve('guide/assets/card-text-view.png');

const targetResponse = await fetch(`${CDP_ENDPOINT}/json/new?${encodeURIComponent(APP_URL)}`, {
    method: 'PUT'
});
if (!targetResponse.ok) {
    throw new Error(`Chrome DevTools target creation failed: ${targetResponse.status}`);
}

const target = await targetResponse.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
});

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Page evaluation failed.');
    }
    return result.result.value;
}

try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
        screenWidth: 390,
        screenHeight: 844
    });

    await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const check = () => {
            const image = document.querySelector('img[alt="光月おでん"]');
            if (image) return resolve(true);
            if (Date.now() >= deadline) return reject(new Error('Card list did not load.'));
            setTimeout(check, 100);
        };
        check();
    })`);
    await evaluate(`document.querySelector('img[alt="光月おでん"]').click()`);
    await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => {
            const button = document.querySelector('#lightbox-text-toggle-btn');
            if (button && !button.hidden) {
                button.click();
                return resolve(true);
            }
            if (Date.now() >= deadline) return reject(new Error('Text view button did not appear.'));
            setTimeout(check, 50);
        };
        check();
    })`);

    const screenshot = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
    });
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, Buffer.from(screenshot.data, 'base64'));
    console.log(OUTPUT_PATH);
} finally {
    await send('Target.closeTarget', { targetId: target.id }).catch(() => {});
    socket.close();
}
