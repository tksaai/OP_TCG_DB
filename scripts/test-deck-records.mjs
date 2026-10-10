import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('deck-records.js', root), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ window, console }));
const records = window.OPTCGDeckRecords;

test('tournament records normalize and summarize deck match history', () => {
    const tournament = records.createTournament({
        name: ' フラッグシップバトル ',
        date: '2026-10-03',
        adjustmentId: 'adjustment-1'
    });
    tournament.matches.push(
        records.createMatch({
            opponentDeck: '赤ゾロ',
            rpsResult: 'win',
            playOrder: 'first',
            result: 'win'
        }),
        records.createMatch({
            opponentDeck: '青ナミ',
            rpsResult: 'loss',
            playOrder: 'second',
            result: 'loss'
        }),
        records.createMatch({
            opponentDeck: '緑ボニー',
            rpsResult: 'win',
            playOrder: 'second',
            result: 'draw'
        })
    );

    const normalized = records.normalizeTournamentRecords([tournament]);
    const summary = records.summarizeTournamentRecords(normalized);
    assert.equal(normalized[0].name, 'フラッグシップバトル');
    assert.equal(normalized[0].adjustmentId, 'adjustment-1');
    assert.equal(normalized[0].matches.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
        tournamentCount: 1,
        matchCount: 3,
        wins: 1,
        losses: 1,
        draws: 1,
        rpsWins: 2,
        rpsLosses: 1
    });
});

test('invalid or incomplete match entries are not restored', () => {
    const normalized = records.normalizeTournamentRecords([{
        id: 'tournament-1',
        name: '交流会',
        date: '2026-10-03',
        matches: [
            {
                id: 'match-valid',
                opponentDeck: '黒ルッチ',
                rpsResult: 'loss',
                playOrder: 'first',
                result: 'win'
            },
            {
                id: 'match-invalid',
                opponentDeck: '',
                rpsResult: 'win',
                playOrder: 'first',
                result: 'win'
            }
        ]
    }]);

    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].matches.length, 1);
    assert.equal(normalized[0].matches[0].id, 'match-valid');
});

test('deleting an adjustment unlinks tournaments without deleting their matches', () => {
    const tournament = records.createTournament({
        name: 'スタンダードバトル',
        date: '2026-10-10',
        adjustmentId: 'adjustment-delete'
    });
    tournament.matches.push(records.createMatch({
        opponentDeck: '紫ルフィ',
        rpsResult: 'win',
        playOrder: 'second',
        result: 'win'
    }));

    const unlinked = records.unlinkAdjustment([tournament], 'adjustment-delete');
    assert.equal(unlinked.length, 1);
    assert.equal(unlinked[0].adjustmentId, undefined);
    assert.equal(unlinked[0].name, 'スタンダードバトル');
    assert.equal(unlinked[0].matches.length, 1);
});

test('deck UI wires tournament records and the five-column composition list', async () => {
    const [html, app, css, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="tournament-records-modal"/);
    assert.match(html, /id="deck-composition-modal"/);
    assert.match(html, /id="deck-list-preview-btn"/);
    assert.match(html, /id="deck-builder-panel"/);
    assert.doesNotMatch(html, /id="deck-show-toggle-btn"/);
    assert.match(html, /deck-records\.js\?v=1\.14\.1/);
    assert.match(app, /tournaments: getDeckTournamentRecords\(editingDeckMeta\)/);
    assert.match(app, /function renderDeckBuilderPanel\(/);
    assert.match(app, /deck-builder-card-stepper/u);
    assert.match(app, /1枚増やす/u);
    assert.match(app, /createDeckMenuItem\('大会記録'/);
    assert.match(app, /createDeckMenuItem\('リスト表示'/);
    assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
    assert.match(worker, /deck-records\.js\?v=1\.14\.1/);
});
