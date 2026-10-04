import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('image exports use an adaptive high-resolution canvas', async () => {
    const source = await readFile(new URL('app.js', root), 'utf8');

    assert.match(source, /const EXPORT_IMAGE_MAX_SCALE = 3;/);
    assert.match(source, /const EXPORT_IMAGE_MAX_PIXELS = 14_000_000;/);
    assert.match(source, /const EXPORT_IMAGE_MAX_DIMENSION = 8192;/);
    assert.match(source, /function getExportCanvasScale\(/);
    assert.match(source, /function createExportCanvas\(/);
    assert.match(source, /ctx\.imageSmoothingQuality = 'high';/);
    assert.equal(
        [...source.matchAll(/createExportCanvas\(canvasWidth, canvasHeight\)/g)].length,
        2
    );
    assert.match(source, /width: canvas\.width,[\s\S]*height: canvas\.height/);
});
