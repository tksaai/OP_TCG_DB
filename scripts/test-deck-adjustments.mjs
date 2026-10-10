import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('deck-adjustments.js', root), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ window, console }));
const adjustments = window.OPTCGDeckAdjustments;

function createSnapshot(overrides = {}) {
    return {
        leader: 'OP01-001',
        cards: {
            'OP01-002': 4,
            'OP01-003': 4,
            'OP01-004': 2
        },
        ...overrides
    };
}

test('adjustment history records only changed deck compositions', () => {
    const first = adjustments.recordAdjustment([], createSnapshot(), {});
    assert.equal(first.adjustments.length, 1);
    assert.equal(first.created.label, '記録開始時');

    const unchanged = adjustments.recordAdjustment(first.adjustments, createSnapshot(), {
        activeAdjustmentId: first.activeAdjustmentId,
        note: '同じ構成'
    });
    assert.equal(unchanged.adjustments.length, 1);
    assert.equal(unchanged.created, null);

    const changed = adjustments.recordAdjustment(first.adjustments, createSnapshot({
        cards: {
            'OP01-002': 3,
            'OP01-003': 4,
            'OP01-005': 3
        }
    }), {
        activeAdjustmentId: first.activeAdjustmentId,
        note: '速攻対策'
    });
    assert.equal(changed.adjustments.length, 2);
    assert.equal(changed.created.label, '速攻対策');
    assert.notEqual(changed.activeAdjustmentId, first.activeAdjustmentId);
});

test('restoring an older composition can create a new timeline entry', () => {
    const first = adjustments.recordAdjustment([], createSnapshot(), {});
    const second = adjustments.recordAdjustment(first.adjustments, createSnapshot({
        leader: 'OP02-001'
    }), { activeAdjustmentId: first.activeAdjustmentId });
    const restored = adjustments.recordAdjustment(second.adjustments, first.adjustments[0], {
        activeAdjustmentId: '',
        note: '初期案から再調整'
    });

    assert.equal(restored.adjustments.length, 3);
    assert.equal(restored.created.label, '初期案から再調整');
    assert.equal(restored.created.leader, 'OP01-001');
});

test('adjustment history stays bounded without blocking later deck saves', () => {
    let state = { adjustments: [], activeAdjustmentId: '' };
    for (let index = 0; index <= adjustments.MAX_ADJUSTMENTS; index += 1) {
        state = adjustments.recordAdjustment(
            state.adjustments,
            createSnapshot({ leader: `OP${String(index).padStart(2, '0')}-001` }),
            {
                activeAdjustmentId: state.activeAdjustmentId,
                note: index === adjustments.MAX_ADJUSTMENTS ? '長'.repeat(120) : ''
            }
        );
    }

    assert.equal(state.adjustments.length, adjustments.MAX_ADJUSTMENTS);
    assert.equal(state.adjustments.at(-1).label.length, adjustments.MAX_LABEL_LENGTH);
    assert.equal(state.adjustments.at(-1).note.length, 120);
    assert.equal(state.adjustments.some(item => item.leader === 'OP00-001'), false);
});

test('adjustment normalization keeps artwork choices and reports changes', () => {
    const normalized = adjustments.normalizeAdjustmentHistory([{
        id: 'adjustment-1',
        label: ' 初期案 ',
        leader: 'OP01-001',
        leaderVariantId: 'OP01-001_alt-1',
        cards: { 'OP01-002': 4, invalid: 0 },
        cardVariants: { 'OP01-002::alt-1': 2 }
    }]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].label, '初期案');
    assert.equal(normalized[0].leaderVariantId, 'OP01-001_alt-1');
    assert.deepEqual(JSON.parse(JSON.stringify(normalized[0].cardVariants)), {
        'OP01-002::alt-1': 2
    });

    const change = adjustments.summarizeAdjustmentChange(
        createSnapshot(),
        createSnapshot({ leader: 'OP02-001', cards: { 'OP01-002': 2, 'OP01-005': 4 } })
    );
    assert.deepEqual(JSON.parse(JSON.stringify(change)), {
        added: 4,
        removed: 8,
        changedTypes: 4,
        leaderChanged: true
    });
});

test('deck UI wires optional adjustment history and tournament association', async () => {
    const [html, app, css, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(html, /id="deck-adjustment-modal"/);
    assert.match(html, /id="deck-adjustment-enabled-toggle"/);
    assert.match(html, /id="tournament-adjustment-select"/);
    assert.match(html, /deck-adjustments\.js\?v=1\.14\.0/);
    assert.match(app, /recordAdjustment\(adjustments, currentSnapshot/);
    assert.match(app, /createDeckMenuItem\('調整履歴'/u);
    assert.match(app, /adjustmentId: dom\.tournamentAdjustmentField/);
    assert.match(css, /\.deck-adjustment-row\.is-active/);
    assert.match(worker, /deck-adjustments\.js\?v=1\.14\.0/);
});
