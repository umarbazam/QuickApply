/**
 * QuickApply — JD Analyzer Queue
 * Storage key: quickapply_jd_queue is a flat list [{ url, addedAt }].
 * Loaded as a content script in popup/dashboard contexts AND imported by
 * the service worker via importScripts(). globalThis is used (not window)
 * because service workers don't have window.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'quickapply_jd_queue';

    function _normalize(url) {
        return String(url || '').trim().toLowerCase();
    }

    async function _read() {
        const r = await chrome.storage.local.get(STORAGE_KEY);
        const list = r[STORAGE_KEY];
        return Array.isArray(list) ? list : [];
    }

    async function _write(list) {
        await chrome.storage.local.set({ [STORAGE_KEY]: list });
    }

    async function addToQueue(url) {
        const u = String(url || '').trim();
        if (!u) return (await _read()).length;
        const list = await _read();
        const norm = _normalize(u);
        if (list.some(it => _normalize(it.url) === norm)) return list.length;
        list.push({ url: u, addedAt: Date.now() });
        await _write(list);
        return list.length;
    }

    async function removeFromQueue(url) {
        const norm = _normalize(url);
        const list = await _read();
        const next = list.filter(it => _normalize(it.url) !== norm);
        if (next.length !== list.length) await _write(next);
        return next.length;
    }

    async function listQueue() {
        return await _read();
    }

    async function queueCount() {
        return (await _read()).length;
    }

    async function clearQueue() {
        await _write([]);
    }

    globalThis.QuickApplyJdQueue = {
        addToQueue, removeFromQueue, listQueue, queueCount, clearQueue
    };
})();
