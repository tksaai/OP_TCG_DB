import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const passthroughNames = new Set(['card', 'delay', 'force', 'limit', 'series']);

function argValue(name, fallback = '') {
    const arg = args.find(item => item === `--${name}` || item.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const [, value = 'true'] = arg.split('=');
    return value;
}

function hasArg(name) {
    return args.includes(`--${name}`) || args.some(item => item.startsWith(`--${name}=`));
}

function run(command, commandArgs) {
    console.log(`\n> ${[command, ...commandArgs].join(' ')}`);
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

const dryRun = hasArg('dry-run');
const skipWebp = hasArg('skip-webp');
const skipManifest = hasArg('skip-manifest');
const pythonCommand = argValue('python', 'python');

const officialSyncArgs = [
    path.join('scripts', 'sync-official-images.mjs'),
    '--missing-only'
];

for (const arg of args) {
    const match = arg.match(/^--([^=]+)(?:=.*)?$/);
    if (!match) continue;
    if (passthroughNames.has(match[1]) || match[1] === 'dry-run') {
        officialSyncArgs.push(arg);
    }
}

run(process.execPath, officialSyncArgs);

if (dryRun) {
    console.log('\nDry run complete. WebP conversion and manifest rebuild were skipped.');
    process.exit(0);
}

if (!skipWebp) {
    run(pythonCommand, [path.join('scripts', 'convert-images-to-webp.py')]);
}

if (!skipManifest) {
    run(process.execPath, [path.join('scripts', 'build-image-manifest.mjs')]);
}

console.log('\nNew release sync complete.');
