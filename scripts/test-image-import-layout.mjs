import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../image-import.js', import.meta.url), 'utf8');
const window = { location: { hostname: 'localhost' } };
const context = vm.createContext({
    window,
    document: { querySelector: () => null, addEventListener: () => {} },
    console,
    requestAnimationFrame: callback => callback()
});
vm.runInContext(source, context);

const { detectDenseIndividualGridLayout } = window.OPTCGImageImport.__test;

function createDeckSheet({
    width,
    height,
    panelRight,
    gridX,
    gridY,
    cardWidth,
    columnStride,
    rowStride
}) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    const paint = (x, y, red, green, blue) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const offset = (y * width + x) * 4;
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
        pixels[offset + 3] = 255;
    };
    const fillRect = (x, y, rectWidth, rectHeight, color, textured = false) => {
        for (let row = Math.floor(y); row < Math.ceil(y + rectHeight); row += 1) {
            for (let column = Math.floor(x); column < Math.ceil(x + rectWidth); column += 1) {
                const shade = textured && ((row >> 2) + (column >> 2)) % 2 ? 34 : 0;
                paint(column, row, Math.max(0, color[0] - shade), Math.max(0, color[1] - shade), Math.max(0, color[2] - shade));
            }
        }
    };
    const outlineRect = (x, y, rectWidth, rectHeight, color = [24, 24, 24]) => {
        fillRect(x, y, rectWidth, 3, color);
        fillRect(x, y + rectHeight - 3, rectWidth, 3, color);
        fillRect(x, y, 3, rectHeight, color);
        fillRect(x + rectWidth - 3, y, 3, rectHeight, color);
    };

    fillRect(0, 0, width, height, [248, 246, 240]);
    fillRect(0, 0, panelRight, height, [174, 102, 34]);

    const leaderWidth = panelRight * 0.78;
    const leaderX = (panelRight - leaderWidth) / 2;
    const leaderHeight = leaderWidth * 1.397;
    fillRect(leaderX, gridY, leaderWidth, leaderHeight, [95, 45, 126], true);
    outlineRect(leaderX, gridY, leaderWidth, leaderHeight);

    const cardHeight = cardWidth * 1.397;
    for (let row = 0; row < 5; row += 1) {
        for (let column = 0; column < 10; column += 1) {
            const red = 55 + (column * 29 + row * 17) % 145;
            const green = 45 + (column * 13 + row * 31) % 155;
            const blue = 60 + (column * 19 + row * 23) % 135;
            const x = gridX + column * columnStride;
            const y = gridY + row * rowStride;
            fillRect(x, y, cardWidth, cardHeight, [red, green, blue], true);
            outlineRect(x, y, cardWidth, cardHeight);
        }
    }
    return pixels;
}

const layouts = [
    {
        name: 'reference landscape proportions',
        width: 1280,
        height: 671,
        panelRight: 312,
        gridX: 342,
        gridY: 37,
        cardWidth: 80,
        columnStride: 92,
        rowStride: 120
    },
    {
        name: 'shifted margins and spacing',
        width: 1440,
        height: 760,
        panelRight: 330,
        gridX: 365,
        gridY: 45,
        cardWidth: 86,
        columnStride: 98,
        rowStride: 128
    }
];

for (const layout of layouts) {
    test(`dense deck sheet detects leader plus 50 individual cards: ${layout.name}`, () => {
        const result = detectDenseIndividualGridLayout(
            createDeckSheet(layout),
            layout.width,
            layout.height
        );
        assert.ok(result);
        assert.equal(result.layout, '可変50枚グリッド');
        assert.equal(result.regions.length, 51);
        assert.equal(result.regions.filter(region => region.hintRole === 'leader').length, 1);
        const deck = result.regions.filter(region => region.hintRole === 'deck');
        assert.equal(deck.length, 50);
        assert.ok(deck.every(region => region.count === 1 && region.countMode === 'none'));
    });
}
