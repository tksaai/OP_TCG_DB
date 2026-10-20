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

test('deck UI wires OPTCGSim file import, confirmation and export', async () => {
    const [html, app, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="import-optcgsim-deck-btn"/);
    assert.match(html, /id="import-optcgsim-deck-input"[^>]*accept="\.deck,text\/plain"/);
    assert.match(html, /optcgsim-deck\.js\?v=/);
    assert.match(app, /confirmAndSaveSharedDeck\(\s*imported,/s);
    assert.match(
        app,
        /createDeckMenuItem\('OPTCGSim出力', 'export', \(\) => exportDeckForOptcgSim\(deck\)\)/u
    );
    assert.match(app, /OPTCGSimの\.deckファイルから読み込んだ結果です/u);
    assert.match(worker, /optcgsim-deck\.js\?v=/);
});
