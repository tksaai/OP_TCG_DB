(function(global) {
    'use strict';

    const MAX_TOURNAMENTS = 200;
    const MAX_MATCHES_PER_TOURNAMENT = 100;
    const MAX_NAME_LENGTH = 80;
    const RPS_RESULTS = new Set(['win', 'loss']);
    const PLAY_ORDERS = new Set(['first', 'second']);
    const MATCH_RESULTS = new Set(['win', 'loss', 'draw']);

    function normalizeText(value, maxLength = MAX_NAME_LENGTH) {
        return String(value || '').trim().slice(0, maxLength);
    }

    function toLocalDateValue(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function normalizeDate(value, fallback = '') {
        const text = String(value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
        const date = new Date(`${text}T00:00:00`);
        if (Number.isNaN(date.getTime()) || toLocalDateValue(date) !== text) return fallback;
        return text;
    }

    function createRecordId(prefix) {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return `${prefix}-${global.crypto.randomUUID()}`;
        }
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function normalizeTimestamp(value, fallback = '') {
        const text = String(value || '').trim();
        return text && !Number.isNaN(Date.parse(text)) ? text : fallback;
    }

    function normalizeMatch(rawMatch) {
        if (!rawMatch || typeof rawMatch !== 'object') return null;
        const opponentDeck = normalizeText(rawMatch.opponentDeck);
        const rpsResult = String(rawMatch.rpsResult || '');
        const playOrder = String(rawMatch.playOrder || '');
        const result = String(rawMatch.result || '');
        if (!opponentDeck || !RPS_RESULTS.has(rpsResult) || !PLAY_ORDERS.has(playOrder) || !MATCH_RESULTS.has(result)) {
            return null;
        }
        const now = new Date().toISOString();
        return {
            id: normalizeText(rawMatch.id, 120) || createRecordId('match'),
            opponentDeck,
            rpsResult,
            playOrder,
            result,
            createdAt: normalizeTimestamp(rawMatch.createdAt, now),
            updatedAt: normalizeTimestamp(rawMatch.updatedAt, now)
        };
    }

    function normalizeTournament(rawTournament) {
        if (!rawTournament || typeof rawTournament !== 'object') return null;
        const name = normalizeText(rawTournament.name);
        if (!name) return null;
        const now = new Date().toISOString();
        const date = normalizeDate(rawTournament.date, toLocalDateValue());
        const matches = Array.isArray(rawTournament.matches)
            ? rawTournament.matches
                .slice(0, MAX_MATCHES_PER_TOURNAMENT)
                .map(normalizeMatch)
                .filter(Boolean)
            : [];
        const adjustmentId = normalizeText(rawTournament.adjustmentId, 120);
        return {
            id: normalizeText(rawTournament.id, 120) || createRecordId('tournament'),
            name,
            date,
            ...(adjustmentId ? { adjustmentId } : {}),
            matches,
            createdAt: normalizeTimestamp(rawTournament.createdAt, now),
            updatedAt: normalizeTimestamp(rawTournament.updatedAt, now)
        };
    }

    function normalizeTournamentRecords(records) {
        if (!Array.isArray(records)) return [];
        return records
            .slice(0, MAX_TOURNAMENTS)
            .map(normalizeTournament)
            .filter(Boolean);
    }

    function createTournament(input = {}) {
        const name = normalizeText(input.name);
        if (!name) throw new Error('大会名を入力してください。');
        const now = new Date().toISOString();
        const adjustmentId = normalizeText(input.adjustmentId, 120);
        return {
            id: createRecordId('tournament'),
            name,
            date: normalizeDate(input.date, toLocalDateValue()),
            ...(adjustmentId ? { adjustmentId } : {}),
            matches: [],
            createdAt: now,
            updatedAt: now
        };
    }

    function createMatch(input = {}) {
        const match = normalizeMatch({
            ...input,
            id: createRecordId('match'),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        if (!match) throw new Error('対戦内容をすべて入力してください。');
        return match;
    }

    function summarizeTournamentRecords(records) {
        const tournaments = normalizeTournamentRecords(records);
        const summary = {
            tournamentCount: tournaments.length,
            matchCount: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            rpsWins: 0,
            rpsLosses: 0
        };
        tournaments.forEach(tournament => {
            tournament.matches.forEach(match => {
                summary.matchCount += 1;
                if (match.result === 'win') summary.wins += 1;
                else if (match.result === 'loss') summary.losses += 1;
                else summary.draws += 1;
                if (match.rpsResult === 'win') summary.rpsWins += 1;
                else summary.rpsLosses += 1;
            });
        });
        return summary;
    }

    global.OPTCGDeckRecords = Object.freeze({
        MAX_TOURNAMENTS,
        MAX_MATCHES_PER_TOURNAMENT,
        RPS_RESULTS: Object.freeze([...RPS_RESULTS]),
        PLAY_ORDERS: Object.freeze([...PLAY_ORDERS]),
        MATCH_RESULTS: Object.freeze([...MATCH_RESULTS]),
        toLocalDateValue,
        normalizeTournamentRecords,
        createTournament,
        createMatch,
        summarizeTournamentRecords
    });
})(typeof window !== 'undefined' ? window : globalThis);
