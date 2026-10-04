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

const {
    detectDenseIndividualGridLayout,
    detectFiveColumnDeckListLayout,
    featureWidth,
    featureHeight
} = window.OPTCGImageImport.__test;

assert.equal(featureWidth, 12);
assert.equal(featureHeight, 17);

function createPixelPainter(width, height) {
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
    return { pixels, fillRect, outlineRect };
}

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
    const { pixels, fillRect, outlineRect } = createPixelPainter(width, height);

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

function createFiveColumnDeckList({ width = 863, height = 1280, cardTypes = 19 } = {}) {
    const { pixels, fillRect, outlineRect } = createPixelPainter(width, height);
    fillRect(0, 0, width, height, [248, 247, 242]);

    const mainBandHeight = Math.round(width * 0.023);
    const leaderBandY = Math.round(height * 0.784);
    const leaderBandHeight = Math.round(width * 0.023);
    fillRect(0, 0, width, mainBandHeight, [18, 17, 21]);
    fillRect(0, leaderBandY, width, leaderBandHeight, [18, 17, 21]);

    const cardWidth = width * (202 / 1065);
    const cardHeight = cardWidth * 1.397;
    const xStart = width * (7 / 1065);
    const xStride = width * (212 / 1065);
    const yStart = mainBandHeight + width * (15 / 1065);
    const yStride = width * (299 / 1065);

    for (let index = 0; index < cardTypes; index += 1) {
        const row = Math.floor(index / 5);
        const column = index % 5;
        const x = xStart + column * xStride;
        const y = yStart + row * yStride;
        const color = [
            72 + (index * 29) % 130,
            58 + (index * 17) % 135,
            68 + (index * 23) % 125
        ];
        fillRect(x, y, cardWidth, cardHeight, color, true);
        outlineRect(x, y, cardWidth, cardHeight);
    }

    const leaderY = leaderBandY + leaderBandHeight + width * (17 / 1065);
    fillRect(xStart, leaderY, cardWidth, cardHeight, [118, 48, 52], true);
    outlineRect(xStart, leaderY, cardWidth, cardHeight);
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
        const leader = result.regions.find(region => region.hintRole === 'leader');
        const expectedLeaderWidth = layout.panelRight * 0.78;
        const expectedLeaderX = (layout.panelRight - expectedLeaderWidth) / 2;
        const leaderTolerance = layout.cardWidth * 0.1;
        assert.ok(leader.x <= expectedLeaderX + leaderTolerance);
        assert.ok(leader.y <= layout.gridY + leaderTolerance);
        assert.ok(
            leader.x + leader.width
            >= expectedLeaderX + expectedLeaderWidth - leaderTolerance,
            JSON.stringify({ leader, expectedLeaderX, expectedLeaderWidth, leaderTolerance })
        );
        assert.ok(
            leader.y + leader.height
            >= layout.gridY + expectedLeaderWidth * 1.397 - leaderTolerance,
            JSON.stringify({ leader, expectedLeaderWidth, leaderTolerance })
        );
        const deck = result.regions.filter(region => region.hintRole === 'deck');
        assert.equal(deck.length, 50);
        assert.ok(deck.every(region => region.count === 1 && region.countMode === 'none'));
        assert.ok(Math.abs(deck[0].x - layout.gridX) <= layout.cardWidth * 0.12);
        assert.ok(Math.abs(deck[0].y - layout.gridY) <= layout.cardWidth * 0.12);
    });
}

test('five-column portrait list ignores the empty final slot', () => {
    const width = 863;
    const height = 1280;
    const result = detectFiveColumnDeckListLayout(
        createFiveColumnDeckList({ width, height, cardTypes: 19 }),
        width,
        height
    );

    assert.ok(result);
    assert.equal(result.layout, 'カード番号付き5列');
    const leader = result.regions.filter(region => region.hintRole === 'leader');
    const deck = result.regions.filter(region => region.hintRole === 'deck');
    assert.equal(leader.length, 1);
    assert.equal(deck.length, 19);
    assert.ok(deck.every(region => region.countMode === 'corner' && region.signal >= 13));
    const finalRowY = Math.max(...deck.map(region => region.y));
    assert.equal(deck.filter(region => Math.abs(region.y - finalRowY) < 1).length, 4);
});
