/**
 * QuickApply — Fill Queue
 * Storage key: quickapply_fill_queue is [{clientId, clientName, jobUrl, addedAt}].
 * Loaded by importScripts in background.js (globalThis, not window).
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'quickapply_fill_queue';

    async function _read() {
        const r = await chrome.storage.local.get(STORAGE_KEY);
        const list = r[STORAGE_KEY];
        return Array.isArray(list) ? list : [];
    }

    async function _write(list) {
        await chrome.storage.local.set({ [STORAGE_KEY]: list });
    }

    /** Append an array of {clientId, clientName, jobUrl} pairs. Skips entries missing clientId or jobUrl. */
    async function addPairs(pairs) {
        const list = await _read();
        for (const p of pairs) {
            if (!p.clientId || !p.jobUrl) continue;
            const alreadyQueued = list.some(e => e.clientId === p.clientId && e.jobUrl === p.jobUrl);
            if (alreadyQueued) continue;
            list.push({ clientId: p.clientId, clientName: p.clientName || '', jobUrl: p.jobUrl, addedAt: Date.now() });
        }
        await _write(list);
        return list.length;
    }

    /** Append a single {clientId, clientName, jobUrl} pair — used by context menu. */
    async function addPair(clientId, clientName, jobUrl) {
        if (!clientId || !jobUrl) return (await _read()).length;
        return addPairs([{ clientId, clientName, jobUrl }]);
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

    async function removeAtIndex(index) {
        const list = await _read();
        if (index < 0 || index >= list.length) return list.length;
        list.splice(index, 1);
        await _write(list);
        return list.length;
    }

    globalThis.QuickApplyFillQueue = {
        addPairs, addPair, listQueue, queueCount, clearQueue, removeAtIndex
    };
})();
