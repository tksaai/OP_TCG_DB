(function(global) {
    'use strict';

    const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
    const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
    const DRIVE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/drive/v3';
    const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
    const SYNC_FILE_NAME = 'op-tcg-db-sync.json';
    const MAX_SYNC_BYTES = 5 * 1024 * 1024;
    const REQUEST_TIMEOUT_MS = 15000;

    let gisLoader = null;

    function createSyncError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function loadGoogleIdentityScript(documentRef = global.document) {
        if (global.google?.accounts?.oauth2) return Promise.resolve(global.google);
        if (gisLoader) return gisLoader;
        if (!documentRef?.head) {
            return Promise.reject(createSyncError('gis_unavailable', 'Google認証を読み込めませんでした。'));
        }

        gisLoader = new Promise((resolve, reject) => {
            const existing = documentRef.querySelector(`script[src="${GIS_SCRIPT_URL}"]`);
            const script = existing || documentRef.createElement('script');
            const cleanup = () => {
                script.removeEventListener('load', handleLoad);
                script.removeEventListener('error', handleError);
            };
            const handleLoad = () => {
                cleanup();
                if (global.google?.accounts?.oauth2) resolve(global.google);
                else reject(createSyncError('gis_unavailable', 'Google認証を初期化できませんでした。'));
            };
            const handleError = () => {
                cleanup();
                gisLoader = null;
                reject(createSyncError('gis_unavailable', 'Google認証を読み込めませんでした。'));
            };
            script.addEventListener('load', handleLoad, { once: true });
            script.addEventListener('error', handleError, { once: true });
            if (!existing) {
                script.src = GIS_SCRIPT_URL;
                script.async = true;
                script.defer = true;
                script.referrerPolicy = 'no-referrer';
                documentRef.head.appendChild(script);
            }
        });
        return gisLoader;
    }

    function getUtf8ByteLength(value) {
        return new TextEncoder().encode(String(value || '')).byteLength;
    }

    function createClient({ clientId, fetchImpl = global.fetch?.bind(global), documentRef = global.document } = {}) {
        const normalizedClientId = String(clientId || '').trim();
        let tokenClient = null;
        let accessToken = '';
        let accessTokenExpiresAt = 0;

        function isConfigured() {
            return /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(normalizedClientId);
        }

        function isConnected() {
            return Boolean(accessToken) && Date.now() < accessTokenExpiresAt;
        }

        async function ensureTokenClient() {
            if (!isConfigured()) {
                throw createSyncError('not_configured', 'Google Drive同期はまだ設定されていません。');
            }
            if (typeof fetchImpl !== 'function') {
                throw createSyncError('network_unavailable', 'この環境ではGoogle Driveへ接続できません。');
            }
            const google = await loadGoogleIdentityScript(documentRef);
            if (!tokenClient) {
                tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: normalizedClientId,
                    scope: DRIVE_APPDATA_SCOPE,
                    callback: () => {}
                });
            }
            return tokenClient;
        }

        async function requestAccessToken({ forceConsent = false } = {}) {
            if (isConnected() && !forceConsent) return accessToken;
            const client = await ensureTokenClient();
            return new Promise((resolve, reject) => {
                client.callback = response => {
                    if (!response || response.error || !response.access_token) {
                        accessToken = '';
                        accessTokenExpiresAt = 0;
                        reject(createSyncError(
                            response?.error === 'access_denied' ? 'access_denied' : 'auth_failed',
                            response?.error === 'access_denied'
                                ? 'Google Driveへの接続がキャンセルされました。'
                                : 'Google Driveへ接続できませんでした。'
                        ));
                        return;
                    }
                    accessToken = response.access_token;
                    const expiresIn = Math.max(0, Number(response.expires_in) || 3600);
                    accessTokenExpiresAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
                    resolve(accessToken);
                };
                client.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
            });
        }

        async function authorizedFetch(url, options = {}) {
            const token = await requestAccessToken();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetchImpl(url, {
                    ...options,
                    cache: 'no-store',
                    credentials: 'omit',
                    redirect: 'error',
                    referrerPolicy: 'no-referrer',
                    headers: {
                        ...(options.headers || {}),
                        Authorization: `Bearer ${token}`
                    },
                    signal: controller.signal
                });
                if (response.status === 401) {
                    accessToken = '';
                    accessTokenExpiresAt = 0;
                    throw createSyncError('auth_expired', 'Google Driveへの接続期限が切れました。もう一度接続してください。');
                }
                if (response.status === 403 || response.status === 429) {
                    throw createSyncError('quota_exceeded', 'Google Driveの無料利用上限に達したため同期を停止しました。');
                }
                return response;
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw createSyncError('timeout', 'Google Driveとの通信がタイムアウトしました。');
                }
                if (error?.name === 'TypeError') {
                    throw createSyncError('network_unavailable', 'Google Driveへ接続できませんでした。');
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }

        async function findSyncFile() {
            const params = new URLSearchParams({
                spaces: 'appDataFolder',
                q: `name = '${SYNC_FILE_NAME}' and trashed = false`,
                orderBy: 'modifiedTime desc',
                pageSize: '10',
                fields: 'files(id,name,modifiedTime,size)'
            });
            const response = await authorizedFetch(`${DRIVE_API_BASE_URL}/files?${params}`);
            if (!response.ok) throw createSyncError('drive_error', 'Google Driveの同期データを確認できませんでした。');
            const payload = await response.json();
            const files = Array.isArray(payload?.files) ? payload.files : [];
            return files.find(file => file?.name === SYNC_FILE_NAME) || null;
        }

        async function readSyncFile(file) {
            const response = await authorizedFetch(
                `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(file.id)}?alt=media`
            );
            if (!response.ok) throw createSyncError('drive_error', 'Google Driveの同期データを取得できませんでした。');
            const text = await response.text();
            if (getUtf8ByteLength(text) > MAX_SYNC_BYTES) {
                throw createSyncError('too_large', 'Google Driveの同期データが大きすぎます。');
            }
            try {
                return { data: JSON.parse(text), file };
            } catch (error) {
                throw createSyncError('invalid_json', 'Google Driveの同期データが壊れています。');
            }
        }

        async function loadSnapshot() {
            const file = await findSyncFile();
            return file ? readSyncFile(file) : null;
        }

        async function createSyncFile(json) {
            const boundary = `op-tcg-db-${Date.now().toString(36)}`;
            const metadata = JSON.stringify({
                name: SYNC_FILE_NAME,
                mimeType: 'application/json',
                parents: ['appDataFolder']
            });
            const body = [
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n`,
                `--${boundary}--`
            ].join('');
            return authorizedFetch(
                `${DRIVE_UPLOAD_BASE_URL}/files?uploadType=multipart&fields=id,name,modifiedTime,size`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                    body
                }
            );
        }

        async function updateSyncFile(fileId, json) {
            return authorizedFetch(
                `${DRIVE_UPLOAD_BASE_URL}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime,size`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                    body: json
                }
            );
        }

        async function saveSnapshot(snapshot) {
            const json = JSON.stringify(snapshot);
            if (getUtf8ByteLength(json) > MAX_SYNC_BYTES) {
                throw createSyncError('too_large', '同期データが5MBを超えたため保存を中止しました。');
            }
            const existing = await findSyncFile();
            const response = existing
                ? await updateSyncFile(existing.id, json)
                : await createSyncFile(json);
            if (!response.ok) throw createSyncError('drive_error', 'Google Driveへ同期データを保存できませんでした。');
            return response.json();
        }

        async function connect() {
            await requestAccessToken();
            return true;
        }

        function disconnect() {
            const token = accessToken;
            accessToken = '';
            accessTokenExpiresAt = 0;
            if (token && global.google?.accounts?.oauth2?.revoke) {
                global.google.accounts.oauth2.revoke(token, () => {});
            }
        }

        return Object.freeze({
            isConfigured,
            isConnected,
            connect,
            disconnect,
            loadSnapshot,
            saveSnapshot
        });
    }

    global.OPTCGGoogleDrive = Object.freeze({
        createClient,
        constants: Object.freeze({
            DRIVE_APPDATA_SCOPE,
            SYNC_FILE_NAME,
            MAX_SYNC_BYTES
        })
    });
})(window);
