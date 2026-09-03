/**
 * QuickApply — Fill Batch Runner (service-worker module)
 * Opens hidden tabs, sends FILL_FORM, waits for FILL_REPORT, records results.
 * State persisted in chrome.storage.local.quickapply_fill_last_batch so the
 * dashboard can poll it across SW evictions.
 *
 * Calls background.js's _sendMessageToTabFrames() directly — both scripts
 * share the same SW global scope, so the function is accessible at call time.
 */
(function () {
    'use strict';

    const BATCH_KEY           = 'quickapply_fill_last_batch';
    const LOAD_TIMEOUT_MS     = 30_000;   // tab load timeout
    const FILL_TIMEOUT_MS     = 180_000;  // 3 min — multi-step auto-submit
    const POLL_MS             = 500;
    const MSG_RETRY           = 3;        // retries waiting for content script to be ready
    const POST_SUBMIT_WAIT_MS = 5_000;    // stay on success screen before closing tab

    let _running      = false;
    let _cancelled    = false;
    const _activeTabs = new Set();

    function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function _readBatch() {
        const r = await chrome.storage.local.get(BATCH_KEY);
        return r[BATCH_KEY] || null;
    }

    async function _writeBatch(b) {
        await chrome.storage.local.set({ [BATCH_KEY]: b });
    }

    async function _updateRow(index, patch) {
        const b = await _readBatch();
        if (!b?.results?.[index]) return;
        b.results[index] = { ...b.results[index], ...patch };
        await _writeBatch(b);
    }

    function _waitForTabLoad(tabId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onUpd);
                reject(new Error('load_timeout'));
            }, timeoutMs);
            const onUpd = (id, info) => {
                if (id !== tabId || info.status !== 'complete') return;
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(onUpd);
                resolve();
            };
            chrome.tabs.onUpdated.addListener(onUpd);
            // Race: tab may already be loaded before listener attaches
            chrome.tabs.get(tabId, tab => {
                void chrome.runtime.lastError;
                if (tab?.status === 'complete') {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(onUpd);
                    resolve();
                }
            });
        });
    }

    /**
     * Convert a job-description page URL to the apply form URL for known ATS platforms.
     * If already on an apply/application page, or platform not recognised, returns unchanged.
     */
    function _resolveApplyUrl(url) {
        try {
            const u = new URL(url);
            const host = u.hostname.toLowerCase();
            const path = u.pathname;

            // Lever: jobs.lever.co/company/job-id  →  .../apply
            if (host === 'jobs.lever.co' && !/\/apply\/?$/.test(path)) {
                return url.split('?')[0].replace(/\/?$/, '/apply');
            }
            // Ashby: jobs.ashbyhq.com/company/job-id  →  .../application
            if (host === 'jobs.ashbyhq.com' && !/\/application\/?$/.test(path)) {
                return url.split('?')[0].replace(/\/?$/, '/application');
            }
            // Workable: apply.workable.com/company/j/ID/  →  .../apply/
            if (host === 'apply.workable.com' && !/\/apply\/?$/.test(path)) {
                return url.split('?')[0].replace(/\/?$/, '/apply/');
            }
            // Rippling ATS: ats.rippling.com/.../jobs/id  →  .../apply
            if (host === 'ats.rippling.com' && /\/jobs\//.test(path) && !/\/apply\/?/.test(path)) {
                return url.split('?')[0].replace(/\/?$/, '/apply');
            }
            // Greenhouse job boards: boards.greenhouse.io or job-boards.greenhouse.io
            // These already show the embedded form — no URL change needed.
            // Dayforce: jobs.dayforcehcm.com — form is on the same page, no change needed.
        } catch (_) {}
        return url;
    }

    async function _fillOne(entry) {
        let tabId = null;
        let _keepTabOpen = false;
        try {
            // Resolve full client profile — FILL_FORM requires it in payload
            const profile = await globalThis.QuickApplyStorage.getClientById(entry.clientId);
            if (!profile) return { ok: false, reason: 'profile_missing' };

            const applyUrl = _resolveApplyUrl(entry.jobUrl);
            const tab = await new Promise((resolve, reject) => {
                chrome.tabs.create({ url: applyUrl, active: false }, t => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(t);
                });
            });
            tabId = tab.id;
            _activeTabs.add(tabId);

            if (_cancelled) return { ok: false, reason: 'cancelled' };
            await _waitForTabLoad(tabId, LOAD_TIMEOUT_MS);
            if (_cancelled) return { ok: false, reason: 'cancelled' };

            // Belt-and-suspenders: update activeClientId for mini-card display
            try { await chrome.storage.local.set({ activeClientId: entry.clientId }); } catch (_) {}

            // Send FILL_FORM — retried MSG_RETRY times waiting for content script
            // _sendMessageToTabFrames is a global defined in background.js (same SW scope)
            let resp = null;
            for (let attempt = 0; attempt < MSG_RETRY && !_cancelled; attempt++) {
                if (attempt > 0) await _sleep(POLL_MS);
                try {
                    resp = await _sendMessageToTabFrames(tabId, {
                        type: 'FILL_FORM',
                        payload: {
                            profile,
                            settings: { autoAdvanceSteps: true, autoSubmit: true },
                            skipDuplicateCheck: true
                        }
                    });
                } catch (_) { resp = null; }
                // A valid fill response has a FILL_REPORT payload with summary
                if (resp?.payload?.summary) break;
                resp = null;
            }

            if (_cancelled) return { ok: false, reason: 'cancelled' };
            if (!resp) return { ok: false, reason: 'no_receiver' };
            if (resp.payload?.duplicate) return { ok: false, reason: 'duplicate' };
            if (resp.payload?.summary) {
                const submitResult = resp.payload.submitResult || null;
                if (submitResult?.submitted && !_cancelled) {
                    await _sleep(POST_SUBMIT_WAIT_MS);
                }
                // hCaptcha timeout: tab was brought to foreground for user to solve —
                // leave it open so they can complete the submission manually.
                if (submitResult?.keepTabOpen) {
                    _keepTabOpen = true;
                }
                return { ok: true, summary: resp.payload.summary, submitResult };
            }
            return { ok: false, reason: 'fill_timeout' };

        } catch (e) {
            return { ok: false, reason: String(e?.message || 'tab_error') };
        } finally {
            if (tabId != null) {
                _activeTabs.delete(tabId);
                if (!_keepTabOpen) {
                    try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; }); } catch (_) {}
                }
            }
        }
    }

    function _closePendingTabs() {
        const ids = Array.from(_activeTabs);
        _activeTabs.clear();
        for (const id of ids) {
            try { chrome.tabs.remove(id, () => { void chrome.runtime.lastError; }); } catch (_) {}
        }
    }

    /** Run the pending fill queue as a new batch. */
    async function runBatch(concurrency = 1) {
        if (_running) return { ok: false, reason: 'already_running' };
        _running = true;
        _cancelled = false;

        try {
            const queue = await globalThis.QuickApplyFillQueue.listQueue();
            if (!queue.length) return { ok: false, reason: 'empty_queue' };

            const batch = {
                startedAt: Date.now(),
                finishedAt: null,
                status: 'running',
                concurrency,
                results: queue.map(it => ({
                    clientId:   it.clientId,
                    clientName: it.clientName,
                    jobUrl:     it.jobUrl,
                    status:     'pending',
                    summary:    null,
                    error:      null,
                    startedAt:  null,
                    finishedAt: null
                }))
            };
            await _writeBatch(batch);
            await _runLoop(batch.results, concurrency);
            return { ok: true };
        } finally {
            _running = false;
        }
    }

    /** Resume a paused batch from its first pending entry. */
    async function resumeBatch() {
        if (_running) return { ok: false, reason: 'already_running' };
        const b = await _readBatch();
        if (!b?.results) return { ok: false, reason: 'no_batch' };

        // Reset entries stuck in 'running' (from SW eviction) back to pending
        for (let i = 0; i < b.results.length; i++) {
            if (b.results[i].status === 'running') {
                b.results[i] = { ...b.results[i], status: 'pending', startedAt: null };
            }
        }
        b.status = 'running';
        b.finishedAt = null;
        await _writeBatch(b);

        _running = true;
        _cancelled = false;
        try {
            await _runLoop(b.results, b.concurrency || 1);
            return { ok: true };
        } finally {
            _running = false;
        }
    }

    /**
     * Shared loop: works through `results` array picking pending entries.
     * Mutates `results` in memory; _updateRow persists each change to storage.
     */
    async function _runLoop(results, concurrency) {
        const pendingIndices = results
            .map((r, i) => i)
            .filter(i => results[i].status === 'pending');

        let cursor = 0;

        async function _worker() {
            while (!_cancelled) {
                // cursor++ is safe: JS is single-threaded, no race
                const idx = pendingIndices[cursor++];
                if (idx === undefined) return;

                try {
                    const entry = results[idx];
                    await _updateRow(idx, { status: 'running', startedAt: Date.now() });
                    const r = await _fillOne(entry);
                    const finishedAt = Date.now();

                    if (r.ok) {
                        // 'done'         = confirmed submitted (URL changed to /thanks etc.)
                        // 'filled'       = filled but no submit button found
                        // 'submit_error' = button clicked but no confirmation (captcha / validation)
                        const sr = r.submitResult;
                        const status = sr?.submitted ? 'done'
                            : sr?.submitAttempted ? 'submit_error'
                            : 'filled';
                        const error = sr?.submitAttempted ? (sr.reason || 'submit_no_confirm') : null;
                        await _updateRow(idx, { status, summary: r.summary, error, finishedAt });
                    } else {
                        const status = r.reason === 'cancelled' ? 'cancelled' : 'failed';
                        await _updateRow(idx, { status, error: r.reason, finishedAt });
                    }
                } catch (e) {
                    try { await _updateRow(idx, { status: 'failed', error: String(e?.message || 'worker_error'), finishedAt: Date.now() }); } catch (_) {}
                }
            }
        }

        const workerCount = Math.min(concurrency, pendingIndices.length || 1);
        await Promise.all(Array.from({ length: workerCount }, _worker));

        // Finalize batch state
        const finalBatch = await _readBatch();
        if (finalBatch) {
            finalBatch.finishedAt = Date.now();
            finalBatch.status = _cancelled ? 'paused' : 'done';
            // Any entries still pending (shouldn't happen, but defensive)
            for (const row of finalBatch.results) {
                if (row.status === 'pending' || row.status === 'running') {
                    row.status = _cancelled ? 'cancelled' : 'failed';
                    row.finishedAt = Date.now();
                }
            }
            await _writeBatch(finalBatch);
        }

        if (!_cancelled) {
            try { await globalThis.QuickApplyFillQueue.clearQueue(); } catch (_) {}
        }
    }

    /** Pause: stop after current in-flight entry finishes (close tabs, mark paused). */
    async function pauseBatch() {
        _cancelled = true;
        _closePendingTabs();
        const b = await _readBatch();
        if (b) {
            b.status = 'paused';
            b.finishedAt = Date.now();
            await _writeBatch(b);
        }
    }

    /** Cancel: terminate run, mark all remaining entries cancelled. */
    async function cancelBatch() {
        _cancelled = true;
        _closePendingTabs();
        const b = await _readBatch();
        if (b?.results) {
            for (const row of b.results) {
                if (row.status === 'pending' || row.status === 'running') {
                    row.status = 'cancelled';
                    row.finishedAt = Date.now();
                }
            }
            b.status = 'cancelled';
            b.finishedAt = Date.now();
            await _writeBatch(b);
        }
    }

    /** Re-run a single failed/cancelled row in place without touching other rows. */
    async function retryRow(index) {
        if (_running) return { ok: false, reason: 'already_running' };
        const b = await _readBatch();
        if (!b?.results?.[index]) return { ok: false, reason: 'not_found' };
        _cancelled = false;
        const entry = b.results[index];
        await _updateRow(index, { status: 'running', startedAt: Date.now(), error: null, summary: null });
        const r = await _fillOne(entry);
        const finishedAt = Date.now();
        if (r.ok) {
            const sr = r.submitResult;
            const status = sr?.submitted ? 'done'
                : sr?.submitAttempted ? 'submit_error'
                : 'filled';
            const error = sr?.submitAttempted ? (sr.reason || 'submit_no_confirm') : null;
            await _updateRow(index, { status, summary: r.summary, error, finishedAt });
        } else {
            await _updateRow(index, { status: 'failed', error: r.reason, finishedAt });
        }
        return { ok: true, status: r.ok ? (r.submitResult?.submitted ? 'done' : 'filled') : 'failed' };
    }

    /** On SW startup: reset stuck 'running' entries to 'pending', close orphan tabs. */
    async function cleanupOrphanTabs() {
        try {
            const b = await _readBatch();
            if (!b?.results || b.status !== 'running') return;
            let changed = false;
            for (const row of b.results) {
                if (row.status === 'running') {
                    row.status = 'pending';
                    row.startedAt = null;
                    changed = true;
                }
            }
            if (changed) {
                b.status = 'paused';
                b.finishedAt = Date.now();
                await _writeBatch(b);
            }
            // Close any tabs that were left open from the previous SW instance.
            // We track by URL since tab IDs are not persisted.
            const runningUrls = new Set(
                (b.results || [])
                    .filter(r => r.status === 'pending')
                    .map(r => r.jobUrl)
            );
            if (!runningUrls.size) return;
            const tabs = await chrome.tabs.query({});
            for (const t of tabs) {
                if (t.url && runningUrls.has(t.url) && !t.active) {
                    try { chrome.tabs.remove(t.id, () => { void chrome.runtime.lastError; }); } catch (_) {}
                }
            }
        } catch (e) {
            console.warn('[QuickApply FillRunner] orphan cleanup failed:', e?.message);
        }
    }

    globalThis.QuickApplyFillRunner = {
        runBatch, pauseBatch, cancelBatch, resumeBatch, retryRow, cleanupOrphanTabs
    };
})();
