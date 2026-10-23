import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const python = process.env.PYTHON || 'python';
const builder = path.join(root, 'scripts', 'build-card-features.py');

function parseSummary(output) {
    const line = String(output || '').split(/\r?\n/).find(value => value.startsWith('{') && value.includes('"generated"'));
    assert.ok(line, `特徴量生成結果を取得できません: ${output}`);
    return JSON.parse(line);
}

function runBuilder(paths, { force = false } = {}) {
    const args = [
        builder,
        `--manifest=${paths.manifest}`,
        `--cards=${paths.cards}`,
        `--provisional=${paths.provisional}`,
        `--output=${paths.output}`,
        `--cache=${paths.cache}`
    ];
    if (force) args.push('--force');
    const result = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return parseSummary(result.stdout);
}

const sourceManifest = JSON.parse(await readFile(path.join(root, 'image-manifest.json'), 'utf8'));
const sourceImages = Object.values(sourceManifest.cards || {})
    .flat()
    .map(variant => path.join(root, String(variant?.path || '')))
    .filter(Boolean);
assert.ok(sourceImages.length >= 2, '差分生成テスト用の画像が不足しています');

const temporary = await mkdtemp(path.join(tmpdir(), 'op-tcg-features-'));
try {
    const image = path.join(temporary, 'card.webp');
    const paths = {
        manifest: path.join(temporary, 'manifest.json'),
        cards: path.join(temporary, 'cards.json'),
        provisional: path.join(temporary, 'provisional.json'),
        output: path.join(temporary, 'features.json'),
        cache: path.join(temporary, 'feature-cache.json')
    };
    const writeManifest = async cards => writeFile(paths.manifest, JSON.stringify({ cards }), 'utf8');

    await copyFile(sourceImages[0], image);
    await writeFile(paths.cards, JSON.stringify([{ cardNumber: 'TEST-001', cardType: 'CHARACTER' }]), 'utf8');
    await writeFile(paths.provisional, '[]', 'utf8');
    await writeManifest({
        'TEST-001': [{ path: image.replace(/\\/g, '/'), variantIndex: 0, cardType: 'CHARACTER' }]
    });

    assert.deepEqual(runBuilder(paths), {
        total: 1, generated: 1, reused: 0, removed: 0, failures: 0, forced: false
    });
    assert.deepEqual(runBuilder(paths), {
        total: 1, generated: 0, reused: 1, removed: 0, failures: 0, forced: false
    });
    assert.deepEqual(runBuilder(paths, { force: true }), {
        total: 1, generated: 1, reused: 0, removed: 0, failures: 0, forced: true
    });

    await copyFile(sourceImages[1], image);
    assert.deepEqual(runBuilder(paths), {
        total: 1, generated: 1, reused: 0, removed: 0, failures: 0, forced: false
    });

    await writeManifest({});
    assert.deepEqual(runBuilder(paths), {
        total: 0, generated: 0, reused: 0, removed: 1, failures: 0, forced: false
    });
    const output = JSON.parse(await readFile(paths.output, 'utf8'));
    const cache = JSON.parse(await readFile(paths.cache, 'utf8'));
    assert.deepEqual(output.features, [], '削除画像の特徴量が残っています');
    assert.deepEqual(cache.entries, {}, '削除画像のハッシュがキャッシュに残っています');
} finally {
    await rm(temporary, { recursive: true, force: true });
}

console.log('Incremental card feature tests passed.');
