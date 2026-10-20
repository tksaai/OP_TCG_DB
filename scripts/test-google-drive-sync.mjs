import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('google-drive-sync.js', root), 'utf8');

function loadModule(fetchImpl) {
    const requests = [];
    let tokenOptions = null;
    const window = {
        fetch: async (url, options = {}) => {
            requests.push({ url: String(url), options });
            return fetchImpl(String(url), options, requests.length);
        },
        google: {
            accounts: {
                oauth2: {
                    initTokenClient(options) {
                        tokenOptions = options;
                        return {
                            callback: options.callback,
                            requestAccessToken() {
                                this.callback({ access_token: 'memory-only-token', expires_in: 3600 });
                            }
                        };
                    },
                    revoke(_token, callback) {
                        callback();
                    }
                }
            }
        }
    };
    const context = vm.createContext({
        window,
        TextEncoder,
        URLSearchParams,
        AbortController,
        setTimeout,
        clearTimeout,
        Date
    });
    vm.runInContext(source, context);
    return { api: window.OPTCGGoogleDrive, requests, getTokenOptions: () => tokenOptions };
}

test('Drive sync uses appDataFolder scope and never persists OAuth tokens', async () => {
    const { api, getTokenOptions } = loadModule(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ files: [] })
    }));
    const client = api.createClient({
        clientId: '123456789-example.apps.googleusercontent.com'
    });

    assert.equal(client.isConfigured(), true);
    await client.connect();
    assert.equal(client.isConnected(), true);
    assert.equal(getTokenOptions().scope, 'https://www.googleapis.com/auth/drive.appdata');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u);
});

test('snapshot save stays in appDataFolder and disables HTTP caching and credentials', async () => {
    const { api, requests } = loadModule(async (_url, _options, index) => {
        if (index === 1) {
            return { ok: true, status: 200, json: async () => ({ files: [] }) };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ id: 'sync-file', modifiedTime: '2026-10-20T00:00:00.000Z' })
        };
    });
    const client = api.createClient({ clientId: '123456789-example.apps.googleusercontent.com' });
    await client.saveSnapshot({ format: 'op-tcg-db-user-sync', version: 1, data: {} });

    assert.match(requests[0].url, /spaces=appDataFolder/u);
    assert.match(requests[1].url, /uploadType=multipart/u);
    assert.match(String(requests[1].options.body), /"parents":\["appDataFolder"\]/u);
    requests.forEach(({ options }) => {
        assert.equal(options.cache, 'no-store');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.referrerPolicy, 'no-referrer');
        assert.equal(options.headers.Authorization, 'Bearer memory-only-token');
    });
});

test('Drive quota responses stop sync before any local fallback is attempted', async () => {
    const { api } = loadModule(async () => ({ ok: false, status: 429 }));
    const client = api.createClient({ clientId: '123456789-example.apps.googleusercontent.com' });
    await assert.rejects(
        () => client.loadSnapshot(),
        error => error?.code === 'quota_exceeded'
    );
});

test('app exposes optional manual upload and restore without syncing sensitive settings', async () => {
    const [html, app, worker] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('service-worker.js', root), 'utf8')
    ]);

    assert.match(
        html,
        /name="google-drive-client-id" content="968667787936-13o1j14h8ehqav2c1ik159trupn1gu61\.apps\.googleusercontent\.com"/u
    );
    assert.match(html, /id="google-drive-connect-btn"/u);
    assert.match(html, /id="google-drive-upload-btn"/u);
    assert.match(html, /id="google-drive-download-btn"/u);
    assert.match(app, /buildGoogleDriveSyncSnapshot/u);
    assert.match(app, /STORE_DECKS,\s*STORE_COLLECTION,\s*STORE_OPENING_SESSIONS/u);
    assert.match(app, /wantedCards: normalizeWantedCards/u);
    const snapshotStart = app.indexOf('async function buildGoogleDriveSyncSnapshot()');
    const snapshotEnd = app.indexOf('function normalizeSyncRecordList', snapshotStart);
    const snapshotSource = app.slice(snapshotStart, snapshotEnd);
    assert.doesNotMatch(snapshotSource, /GITHUB_TOKEN_STORAGE_KEY|githubToken/u);
    assert.match(app, /listBadgesVisible:\s*areListBadgesVisible\(\)/u);
    assert.doesNotMatch(app, /isListBadgesVisible/u);
    assert.match(worker, /google-drive-sync\.js\?v=/u);
});
