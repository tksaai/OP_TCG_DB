import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('proxy-print.js', root), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ TextEncoder, window }));
const proxyPrint = window.OPTCGProxyPrint;

test('A4 uses exact card dimensions and packs from the top-left without gaps', () => {
    const layout = proxyPrint.resolveLayout({
        paperSize: 'A4',
        orientation: 'auto',
        cardSize: 'standard',
        edgeInset: 0
    }, 10);

    assert.deepEqual({
        pageWidth: layout.pageWidth,
        pageHeight: layout.pageHeight,
        cardWidth: layout.cardWidth,
        cardHeight: layout.cardHeight,
        inset: layout.inset,
        columns: layout.columns,
        rows: layout.rows,
        capacity: layout.capacity,
        pageCount: layout.pageCount
    }, {
        pageWidth: 210,
        pageHeight: 297,
        cardWidth: 63,
        cardHeight: 88,
        inset: 0,
        columns: 3,
        rows: 3,
        capacity: 9,
        pageCount: 2
    });
});

test('custom paper and card dimensions are preserved in landscape mode', () => {
    const layout = proxyPrint.resolveLayout({
        paperSize: 'custom',
        customPaperWidth: 180,
        customPaperHeight: 250,
        orientation: 'landscape',
        cardSize: 'custom',
        customCardWidth: 60,
        customCardHeight: 80,
        edgeInset: 5
    }, 7);

    assert.equal(layout.pageWidth, 250);
    assert.equal(layout.pageHeight, 180);
    assert.equal(layout.cardWidth, 60);
    assert.equal(layout.cardHeight, 80);
    assert.equal(layout.inset, 5);
    assert.equal(layout.columns, 4);
    assert.equal(layout.rows, 2);
    assert.equal(layout.capacity, 8);
    assert.equal(layout.pageCount, 1);
});

test('PDF reuses card image objects and creates the required page count', () => {
    const copies = Array.from({ length: 10 }, () => ({ key: 'card-a' }));
    const bytes = proxyPrint.buildPdfBytes({
        pageWidthMm: 210,
        pageHeightMm: 297,
        cardWidthMm: 63,
        cardHeightMm: 88,
        insetMm: 0,
        columns: 3,
        rows: 3,
        copies,
        images: [{
            key: 'card-a',
            width: 1,
            height: 1,
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
        }]
    });
    const pdfText = Buffer.from(bytes).toString('latin1');

    assert.ok(pdfText.startsWith('%PDF-1.4'));
    assert.match(pdfText, /\/Type \/Pages \/Count 2/);
    assert.equal((pdfText.match(/\/Subtype \/Image/g) || []).length, 1);
    assert.match(pdfText, /q 178\.5827 0 0 249\.4488 0 592\.4409 cm \/Im3 Do Q/);
    assert.match(pdfText, /xref\n0 8\n/);
    assert.ok(pdfText.endsWith('%%EOF\n'));
});

test('proxy print is wired into the deck menu and app shell', async () => {
    const [html, app, css, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="proxy-print-modal"/);
    assert.match(html, /id="proxy-print-paper-size"/);
    assert.match(html, /id="proxy-print-card-size"/);
    assert.match(html, /proxy-print\.js\?v=1\.13\.1/);
    assert.match(app, /createDeckMenuItem\('プロキシ印刷', 'print'/);
    assert.match(app, /getCollectionOwnedCardsForDeck\(deck\)/);
    assert.match(css, /\.proxy-print-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
    assert.match(css, /\.proxy-print-dimension-fields\[hidden\]\s*\{[^}]*display:\s*none/s);
    assert.match(css, /\.proxy-print-preview-card\s*\{[^}]*position:\s*absolute/s);
    assert.match(worker, /proxy-print\.js\?v=1\.13\.1/);
});
