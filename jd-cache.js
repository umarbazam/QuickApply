/**
 * QuickApply JD Cache — Job description objects (L1 memory + L2 chrome.storage)
 * Storage key: quickapply_jd_cache
 * Cap: 100 entries (LRU on overflow)
 * TTL: 7 days
 */
(function () {
    'use strict';

    // Note: get/put use read-modify-write on the full store object.
    // Concurrent writes from multiple iframes (all_frames: true) may occasionally
    // clobber each other's lastAccess updates or LRU evictions. This is an
    // accepted known limitation, mirroring cache.js.

    const STORAGE_KEY = 'quickapply_jd_cache';
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_ENTRIES = 100;

    const _l1 = new Map();   // jobKey -> JdObject

    async function _readStore() {
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            return res[STORAGE_KEY] || {};
        } catch (_) { return {}; }
    }
    async function _writeStore(store) {
        try { await chrome.storage.local.set({ [STORAGE_KEY]: store }); } catch (_) {}
    }

    /** Get JdObject by jobKey. Updates lastAccess. Null on miss/expired. */
    async function get(jobKey) {
        if (!jobKey) return null;
        if (_l1.has(jobKey)) {
            _l1.get(jobKey).lastAccess = Date.now();
            return _l1.get(jobKey);
        }
        const store = await _readStore();
        const entry = store[jobKey];
        if (!entry) return null;
        const ts = new Date(entry.extractedAt).getTime();
        if (!ts || Date.now() - ts > TTL_MS) {
            // Missing/invalid extractedAt is treated as expired (same as evictExpired).
            delete store[jobKey];
            _writeStore(store);
            return null;
        }
        entry.lastAccess = Date.now();
        store[jobKey] = entry;
        _writeStore(store);
        _l1.set(jobKey, entry);
        return entry;
    }

    /** Put a JdObject. Caller is responsible for extractedAt. */
    async function put(jdObject) {
        if (!jdObject || !jdObject.jobKey) return;
        jdObject.lastAccess = Date.now();
        _l1.set(jdObject.jobKey, jdObject);
        const store = await _readStore();
        store[jdObject.jobKey] = jdObject;
        // LRU evict if over cap
        const keys = Object.keys(store);
        if (keys.length > MAX_ENTRIES) {
            const sorted = keys.map(k => [k, store[k].lastAccess || 0]).sort((a, b) => a[1] - b[1]);
            const toEvict = sorted.slice(0, keys.length - MAX_ENTRIES).map(x => x[0]);
            toEvict.forEach(k => { delete store[k]; _l1.delete(k); });
        }
        await _writeStore(store);
    }

    /** Update only the fitScores section for a (jobKey, clientId) pair. */
    async function putFitScores(jobKey, clientId, scores) {
        const jd = await get(jobKey);
        if (!jd) return;
        jd.fitScores = jd.fitScores || {};
        jd.fitScores[clientId] = { ...scores, scoredAt: new Date().toISOString() };
        await put(jd);
    }

    /** Drop one entry. */
    async function evict(jobKey) {
        _l1.delete(jobKey);
        const store = await _readStore();
        delete store[jobKey];
        await _writeStore(store);
    }

    /** Drop all entries older than TTL. Called from background on startup. */
    async function evictExpired() {
        const store = await _readStore();
        const now = Date.now();
        let evicted = 0;
        for (const [k, entry] of Object.entries(store)) {
            const ts = new Date(entry.extractedAt).getTime();
            if (!ts || now - ts > TTL_MS) { delete store[k]; _l1.delete(k); evicted++; }
        }
        if (evicted) await _writeStore(store);
        return evicted;
    }

    function size() { return _l1.size; }

    window.QuickApplyJdCache = { get, put, putFitScores, evict, evictExpired, size };
})();
