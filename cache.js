/**
 * QuickApply Cache — Fingerprint-based answer cache (L1 memory + L2 chrome.storage)
 * Cache key: clientId + ":" + fnv1a(normalizedLabel|type|sortedOptions)
 */
// Note: get/set/evictExpired use read-modify-write on the full store object.
// Concurrent writes from multiple iframes (all_frames: true) may occasionally
// clobber each other's useCount increments. This is an accepted known limitation.
(function () {
    'use strict';

    const STORAGE_KEY = 'qa_cache_v2';
    const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

    // L1: in-memory map for current session
    const _l1 = new Map();

    /** FNV-1a 32-bit hash — synchronous, no crypto.subtle needed */
    function fnv1a(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 0x01000193) >>> 0;
        }
        return hash.toString(16);
    }

    /**
     * Build fingerprint for a field rule.
     * Platform-agnostic: same question on any ATS = same fingerprint.
     */
    function makeFingerprint(label, type, options = []) {
        label = label || '';
        const norm = label.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const optStr = [...options].sort().join(',').toLowerCase();
        return fnv1a(`${norm}|${type}|${optStr}`);
    }

    /** Get cached answer. Returns null on miss. */
    async function get(cacheKey) {
        // L1 hit
        if (_l1.has(cacheKey)) return _l1.get(cacheKey);

        // L2 hit
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            const store = res[STORAGE_KEY] || {};
            const entry = store[cacheKey];
            if (!entry) return null;
            if (Date.now() - entry.timestamp > TTL_MS) {
                // Expired — evict lazily
                delete store[cacheKey];
                chrome.storage.local.set({ [STORAGE_KEY]: store }).catch(() => {});
                return null;
            }
            // Promote to L1
            _l1.set(cacheKey, entry.answer);
            // Increment useCount
            entry.useCount = (entry.useCount || 0) + 1;
            chrome.storage.local.set({ [STORAGE_KEY]: store }).catch(() => {});
            return entry.answer;
        } catch (_) { return null; }
    }

    /** Write answer to L1 + L2. */
    async function set(cacheKey, answer, platform = '') {
        _l1.set(cacheKey, answer);
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            const store = res[STORAGE_KEY] || {};
            store[cacheKey] = { answer, timestamp: Date.now(), useCount: (store[cacheKey]?.useCount || 0) + 1, platform };
            await chrome.storage.local.set({ [STORAGE_KEY]: store });
        } catch (_) {}
    }

    /** Evict all entries older than TTL. Called from background.js onStartup. */
    async function evictExpired() {
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            const store = res[STORAGE_KEY] || {};
            const now = Date.now();
            let evicted = 0;
            for (const key of Object.keys(store)) {
                if (now - store[key].timestamp > TTL_MS) { delete store[key]; evicted++; }
            }
            if (evicted > 0) await chrome.storage.local.set({ [STORAGE_KEY]: store });
            return evicted;
        } catch (_) { return 0; }
    }

    /** Clear all cache entries for a specific clientId prefix. */
    async function clearForClient(clientId) {
        _l1.forEach((_, k) => { if (k.startsWith(clientId + ':')) _l1.delete(k); });
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            const store = res[STORAGE_KEY] || {};
            for (const key of Object.keys(store)) {
                if (key.startsWith(clientId + ':')) delete store[key];
            }
            await chrome.storage.local.set({ [STORAGE_KEY]: store });
        } catch (_) {}
    }

    /** Clear ALL cache entries (dashboard button). */
    async function clearAll() {
        _l1.clear();
        try {
            await chrome.storage.local.remove(STORAGE_KEY);
        } catch (_) {}
    }

    /** Return cache stats for dashboard panel. */
    async function stats() {
        try {
            const res = await chrome.storage.local.get(STORAGE_KEY);
            const store = res[STORAGE_KEY] || {};
            const entries = Object.values(store);
            const byPlatform = {};
            for (const e of entries) {
                byPlatform[e.platform || 'unknown'] = (byPlatform[e.platform || 'unknown'] || 0) + 1;
            }
            return { total: entries.length, byPlatform, l1Size: _l1.size };
        } catch (_) { return { total: 0, byPlatform: {}, l1Size: 0 }; }
    }

    window.QuickApplyCache = { makeFingerprint, get, set, evictExpired, clearForClient, clearAll, stats };
})();
