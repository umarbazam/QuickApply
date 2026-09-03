/**
 * QuickApply — Mini-Card Dismissals
 *
 * Dismissals are keyed by `${host}::${jobKey}` so dismissing the mini-card on
 * ONE job posting doesn't suppress every other job on the same host. This
 * matters for ATS-direct hosts like job-boards.greenhouse.io that host
 * hundreds of unrelated JDs per host.
 *
 * Storage key: quickapply_minicard_dismissals — flat { [`host::jobKey`]: timestampMs }.
 * Legacy entries (plain host keys without `::`) are read forward — they still
 * suppress THAT host until the entry expires — but new dismissals always carry
 * a jobKey suffix.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'quickapply_minicard_dismissals';
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;

    function _composeKey(host, jobKey) {
        const h = String(host || '').trim();
        const k = String(jobKey || '').trim();
        if (!h) return '';
        return k ? `${h}::${k}` : h;
    }

    async function _read() {
        const res = await chrome.storage.local.get(STORAGE_KEY);
        return res[STORAGE_KEY] || {};
    }
    async function _write(obj) {
        await chrome.storage.local.set({ [STORAGE_KEY]: obj });
    }

    async function isDismissed(host, jobKey) {
        const composite = _composeKey(host, jobKey);
        if (!composite) return false;
        const all = await _read();
        // Prefer the precise composite key. Fall back to the legacy host-only
        // entry so existing dismissals continue to work until they expire.
        const ts = all[composite] != null ? all[composite] : all[host];
        if (!ts) return false;
        if (Date.now() - ts > TTL_MS) {
            if (all[composite] != null) delete all[composite];
            if (all[host] != null && composite !== host) delete all[host];
            await _write(all);
            return false;
        }
        return true;
    }

    async function dismiss(host, jobKey) {
        const composite = _composeKey(host, jobKey);
        if (!composite) return;
        const all = await _read();
        all[composite] = Date.now();
        await _write(all);
    }

    async function clear(host, jobKey) {
        const composite = _composeKey(host, jobKey);
        if (!composite) return;
        const all = await _read();
        let changed = false;
        if (composite in all) { delete all[composite]; changed = true; }
        // Also clear any legacy host-only entry so the user gets a fresh start.
        if (jobKey && host in all) { delete all[host]; changed = true; }
        if (changed) await _write(all);
    }

    /** Drop every dismissal (used by the dashboard "Show mini-cards again" button). */
    async function clearAll() {
        await _write({});
    }

    window.QuickApplyMiniCardDismissals = { isDismissed, dismiss, clear, clearAll };
})();
