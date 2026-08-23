/* Browser-only card feature matching for deck image import. */

'use strict';

const FEATURE_DATA_PATH = './card-features.json';
const RESULT_CANDIDATE_LIMIT = 3;

let featureIndexPromise = null;

function decodeFeature(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

async function loadFeatureIndex() {
    if (featureIndexPromise) return featureIndexPromise;
    featureIndexPromise = (async () => {
        const response = await fetch(FEATURE_DATA_PATH);
        if (!response.ok) throw new Error(`画像認識データを取得できませんでした (${response.status})`);
        const payload = await response.json();
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (payload.version !== 1 || width < 2 || height < 2 || !Array.isArray(payload.features)) {
            throw new Error('画像認識データの形式が正しくありません。');
        }

        const byType = { LEADER: new Map(), DECK: new Map() };
        payload.features.forEach(entry => {
            if (!entry?.n || !entry?.f) return;
            const type = entry.t === 'LEADER' ? 'LEADER' : 'DECK';
            const variants = byType[type].get(entry.n) || [];
            const feature = decodeFeature(entry.f);
            if (feature.length !== width * height * 3) return;
            variants.push({
                path: entry.p || '',
                variantIndex: Number(entry.v) || 0,
                feature
            });
            byType[type].set(entry.n, variants);
        });

        return {
            width,
            height,
            totalImages: Number(payload.totalImages) || payload.features.length,
            groups: {
                LEADER: [...byType.LEADER.entries()].map(([number, variants]) => ({ number, variants })),
                DECK: [...byType.DECK.entries()].map(([number, variants]) => ({ number, variants }))
            }
        };
    })().catch(error => {
        featureIndexPromise = null;
        throw error;
    });
    return featureIndexPromise;
}

function featureDistance(query, candidate, width, height) {
    let distance = 0;
    let compared = 0;
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            if (x >= width - 3 && y <= 2) continue;
            if (x >= width - 3 && y >= height - 3) continue;
            const offset = (y * width + x) * 3;
            distance += Math.abs(query[offset] - candidate[offset]) * 0.62;
            distance += Math.abs(query[offset + 1] - candidate[offset + 1]) * 0.19;
            distance += Math.abs(query[offset + 2] - candidate[offset + 2]) * 0.19;
            compared += 1;
        }
    }
    return compared > 0 ? distance / (compared * 255) : 1;
}

function addTopCandidate(top, candidate) {
    let insertAt = top.findIndex(item => candidate.distance < item.distance);
    if (insertAt < 0) insertAt = top.length;
    top.splice(insertAt, 0, candidate);
    if (top.length > RESULT_CANDIDATE_LIMIT) top.length = RESULT_CANDIDATE_LIMIT;
}

function matchGroups(query, groups, width, height, type) {
    const top = [];
    groups.forEach(group => {
        let best = null;
        group.variants.forEach(variant => {
            const distance = featureDistance(query, variant.feature, width, height);
            if (!best || distance < best.distance) {
                best = { distance, path: variant.path, variantIndex: variant.variantIndex };
            }
        });
        if (best) {
            addTopCandidate(top, {
                cardNumber: group.number,
                cardType: type,
                distance: best.distance,
                variantPath: best.path,
                variantIndex: best.variantIndex
            });
        }
    });

    const bestDistance = top[0]?.distance ?? 1;
    const secondDistance = top[1]?.distance ?? 1;
    const similarity = 1 - bestDistance;
    const margin = Math.max(0, secondDistance - bestDistance);
    const confidence = clamp((similarity - 0.45) / 0.5 + margin * 0.8, 0, 0.995);
    return {
        confidence,
        similarity,
        candidates: top.map(item => ({
            cardNumber: item.cardNumber,
            cardType: item.cardType,
            score: clamp((1 - item.distance - 0.35) / 0.65, 0, 0.995),
            similarity: 1 - item.distance,
            variantPath: item.variantPath,
            variantIndex: item.variantIndex
        }))
    };
}

async function matchRegions(message) {
    const index = await loadFeatureIndex();
    const featureLength = index.width * index.height * 3;
    const queries = new Uint8Array(message.buffer);
    const regions = Array.isArray(message.regions) ? message.regions : [];
    if (queries.length !== featureLength * regions.length) {
        throw new Error('切り出し画像の特徴量サイズが正しくありません。');
    }

    const results = [];
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
        const query = queries.subarray(regionIndex * featureLength, (regionIndex + 1) * featureLength);
        const leader = matchGroups(query, index.groups.LEADER, index.width, index.height, 'LEADER');
        const deck = matchGroups(query, index.groups.DECK, index.width, index.height, 'DECK');
        results.push({
            id: regions[regionIndex].id,
            leader,
            deck
        });
        self.postMessage({
            type: 'progress',
            completed: regionIndex + 1,
            total: regions.length
        });
        if (regionIndex % 3 === 2) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return results;
}

self.addEventListener('message', async event => {
    const message = event.data || {};
    try {
        if (message.type === 'init') {
            const index = await loadFeatureIndex();
            self.postMessage({
                type: 'ready',
                totalImages: index.totalImages,
                width: index.width,
                height: index.height
            });
            return;
        }
        if (message.type === 'match') {
            const results = await matchRegions(message);
            self.postMessage({ type: 'result', requestId: message.requestId, results });
        }
    } catch (error) {
        self.postMessage({
            type: 'error',
            requestId: message.requestId,
            message: error?.message || 'カード画像の照合に失敗しました。'
        });
    }
});
