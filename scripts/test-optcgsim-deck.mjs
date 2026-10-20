import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('optcgsim-deck.js', root), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ window, TextEncoder }));
const optcgSim = window.OPTCGSimDeck;

const attachedDeck = [
    '1xST01-001',
    '4xST01-003',
    '4xST01-006',
    '4xST01-007',
    '4xST01-002',
    '4xST01-004',
    '4xST01-009',
    '2xST01-011',
    '4xST01-005',
    '4xST01-008',
    '1xST01-013',
    '4xST01-010',
    '2xST01-014',
    '2xST01-016',
    '2xST01-015',
    '2xST01-017'
].join('\r\n');

function resolveStarterCard(cardNumber) {
    if (!/^ST01-\d{3}$/.test(cardNumber)) return null;
    return { cardNumber, cardType: cardNumber === 'ST01-001' ? 'LEADER' : 'CHARACTER' };
}

test('attached OPTCGSim deck imports as one leader plus its 47-card draft', () => {
    const parsed = optcgSim.parseDeck(attachedDeck, {
        fileName: 'name.deck',
        resolveCard: resolveStarterCard
    });

    assert.equal(parsed.name, 'name');
    assert.equal(parsed.leader, 'ST01-001');
    assert.equal(Object.values(parsed.cards).reduce((sum, count) => sum + count, 0), 47);
    assert.equal(parsed.cards['ST01-011'], 2);
    assert.deepEqual([...parsed.unknownCardNumbers], []);
});

test('OPTCGSim export uses canonical card numbers and round-trips', () => {
    const parsed = optcgSim.parseDeck(attachedDeck, {
        fileName: 'name.deck',
        resolveCard: resolveStarterCard
    });
    const exported = optcgSim.serializeDeck(parsed);

    assert.ok(exported.startsWith('1xST01-001\r\n'));
    assert.ok(exported.endsWith('\r\n'));
    assert.match(exported, /2xST01-011\r\n/);
    assert.deepEqual(
        optcgSim.parseDeck(exported, { fileName: 'roundtrip.deck', resolveCard: resolveStarterCard }).cards,
        parsed.cards
    );
});

test('OPTCGSim import validates rows, leader count and the 50-card upper limit', () => {
    assert.throws(
        () => optcgSim.parseDeck('5xST01-001', { resolveCard: resolveStarterCard }),
        /1行目を読み取れません/u
    );
    assert.throws(
        () => optcgSim.parseDeck(
            attachedDeck
                .replace('1xST01-013', '4xST01-013')
                .replace('2xST01-017', '3xST01-017'),
            {
                resolveCard: resolveStarterCard
            }
        ),
        /現在は51枚/u
    );
    assert.throws(
        () => optcgSim.parseDeck(attachedDeck.replace('1xST01-001', '2xST01-001'), {
            resolveCard: resolveStarterCard
        }),
        /リーダーカードは1枚/u
    );
});

test('unknown cards remain visible for confirmation while first unknown card can be the leader', () => {
    const unknownDeck = attachedDeck
        .replace('ST01-001', 'ZZ99-001')
        .replace('ST01-017', 'ZZ99-017');
    const parsed = optcgSim.parseDeck(unknownDeck, {
        fileName: 'future.deck',
        resolveCard: resolveStarterCard
    });

    assert.equal(parsed.leader, 'ZZ99-001');
    assert.deepEqual([...parsed.unknownCardNumbers], ['ZZ99-001', 'ZZ99-017']);
});

test('deck UI wires OPTCGSim text import, confirmation and clipboard copy', async () => {
    const [html, app, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="import-optcgsim-deck-btn"/);
    assert.match(html, /id="optcgsim-text-modal"/);
    assert.match(html, /id="optcgsim-text-input"[^>]*placeholder="1xST01-001/u);
    assert.match(html, /id="optcgsim-text-paste-btn"/);
    assert.doesNotMatch(html, /id="import-optcgsim-deck-input"/);
    assert.match(html, /optcgsim-deck\.js\?v=/);
    assert.match(app, /confirmAndSaveSharedDeck\(\s*imported,/s);
    assert.match(app, /importOptcgSimDeckBtn\.addEventListener\('click', openOptcgSimTextImport\)/u);
    assert.match(app, /navigator\.clipboard\.readText\(\)/u);
    assert.doesNotMatch(app, /importOptcgSimDeckFile/u);
    assert.match(
        app,
        /createDeckMenuItem\('OPTCGSim用にコピー', 'copy', \(\) => copyDeckForOptcgSim\(deck\)\)/u
    );
    const copyFunctionStart = app.indexOf('async function copyDeckForOptcgSim(deck)');
    const copyFunctionEnd = app.indexOf('function compareDeckCards', copyFunctionStart);
    const copyFunction = app.slice(copyFunctionStart, copyFunctionEnd);
    assert.match(copyFunction, /await copyTextToClipboard\(source\)/u);
    assert.doesNotMatch(copyFunction, /downloadBlob|\.deck/u);
    assert.match(app, /OPTCGSimのデッキデータから読み込んだ結果です/u);
    assert.match(worker, /optcgsim-deck\.js\?v=/);
});
