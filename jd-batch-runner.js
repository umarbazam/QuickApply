/**
 * QuickApply — JD Analyzer batch runner (service-worker module).
 * Opens hidden background tabs, sends GET_FIT_SCORE, captures results, closes tabs.
 * State is persisted to chrome.storage.local.quickapply_jd_last_batch so the
 * dashboard (which polls it every 1s) can render results even across SW evictions.
 */
(function () {
    'use strict';

    const BATCH_KEY = 'quickapply_jd_last_batch';
    const CONCURRENCY = 10;
    const FIRST_ATTEMPT_SETTLE_MS = 10_000;
    const RETRY_SETTLE_MS = 5_000;
    const POLL_MS = 500;

    let _running = false;
    let _cancelled = false;
    let _activeTabIds = new Set();

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
        if (!b || !b.results || !b.results[index]) return;
        b.results[index] = { ...b.results[index], ...patch };
        await _writeBatch(b);
    }

    /** Wait for tab to reach status:'complete'; resolves with that tab object. */
    function _waitForComplete(tabId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onUpd);
                reject(new Error('load_timeout'));
            }, timeoutMs);
            const onUpd = (id, info, tab) => {
                if (id === tabId && info.status === 'complete') {
                    clearTimeout(t);
                    chrome.tabs.onUpdated.removeListener(onUpd);
                    resolve(tab);
                }
            };
            chrome.tabs.onUpdated.addListener(onUpd);
            // Also race against an immediate query in case the tab finished
            // loading before our listener attached.
            chrome.tabs.get(tabId, (tab) => {
                void chrome.runtime.lastError;
                if (tab && tab.status === 'complete') {
                    clearTimeout(t);
                    chrome.tabs.onUpdated.removeListener(onUpd);
                    resolve(tab);
                }
            });
        });
    }

    /** sendMessage with timeout — resolves with response or null on timeout/error. */
    function _sendWithTimeout(tabId, msg, timeoutMs) {
        return new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
            try {
                chrome.tabs.sendMessage(tabId, msg, (resp) => {
                    void chrome.runtime.lastError;
                    if (done) return;
                    done = true;
                    clearTimeout(t);
                    resolve(resp || null);
                });
            } catch (_) { if (!done) { done = true; clearTimeout(t); resolve(null); } }
        });
    }

    /** Score one URL by opening a hidden tab and polling GET_FIT_SCORE. */
    async function _scoreOne(url, clientId, settleBudgetMs) {
        let tabId = null;
        try {
            const tab = await new Promise((resolve, reject) => {
                chrome.tabs.create({ url, active: false }, (t) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(t);
                });
            });
            tabId = tab.id;
            _activeTabIds.add(tabId);

            if (_cancelled) return { ok: false, reason: 'cancelled' };
            await _waitForComplete(tabId, settleBudgetMs);
            if (_cancelled) return { ok: false, reason: 'cancelled' };

            const deadline = Date.now() + settleBudgetMs;
            let resp = null;
            while (Date.now() < deadline) {
                if (_cancelled) return { ok: false, reason: 'cancelled' };
                resp = await _sendWithTimeout(tabId, {
                    type: 'GET_FIT_SCORE',
                    payload: { clientId }
                }, 1500);
                if (resp && resp.fit) break;
                await _sleep(POLL_MS);
            }
            if (resp && resp.fit) {
                return { ok: true, fit: resp.fit, jd: resp.jd || {} };
            }
            return { ok: false, reason: resp?.reason || 'no_fit' };
        } catch (e) {
            return { ok: false, reason: String(e?.message || 'tab_error') };
        } finally {
            if (tabId != null) {
                _activeTabIds.delete(tabId);
                try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; }); } catch (_) {}
            }
        }
    }

    /** Main entry. Single-URL, no concurrency, no retry — Task 5/6 extend. */
    async function runBatch() {
        if (_running) return { ok: false, reason: 'already_running' };
        _running = true;
        _cancelled = false;
        try {
            const queue = await globalThis.QuickApplyJdQueue.listQueue();
            if (!queue.length) return { ok: false, reason: 'empty_queue' };

            const data = await chrome.storage.local.get('activeClientId');
            const clientId = data?.activeClientId || null;

            // Cache strategy: each tab's GET_FIT_SCORE handler routes through
            // FitMatcher.scoreWithAi, which already reads cached fit verdicts
            // from JdCache before calling Gemini. A second run of the same URL
            // for the same client therefore costs ~0 AI tokens — the bottleneck
            // is just the tab open/load, which is unavoidable for SPA platforms
            // where jobKey resolution requires DOM. A future optimization could
            // skip even the tab open by hashing URL → jobKey for SSR platforms.

            const batch = {
                clientId,
                startedAt: Date.now(),
                finishedAt: null,
                results: queue.map(it => ({ url: it.url, status: 'pending', attempts: 0 }))
            };
            await _writeBatch(batch);

            // Worker-pool: CONCURRENCY workers each pull the next pending index.
            let cursor = 0;
            async function _worker() {
                while (true) {
                    if (_cancelled) return;
                    const i = cursor++;
                    if (i >= batch.results.length) return;
                    await _updateRow(i, { status: 'running', attempts: 1 });
                    let r = await _scoreOne(batch.results[i].url, clientId, FIRST_ATTEMPT_SETTLE_MS);
                    if (!r.ok && !_cancelled) {
                        await _updateRow(i, { status: 'running', attempts: 2 });
                        r = await _scoreOne(batch.results[i].url, clientId, RETRY_SETTLE_MS);
                    }
                    if (r.ok) {
                        await _updateRow(i, {
                            status: 'scored',
                            fit: r.fit,
                            jdMeta: { title: r.jd.title, company: r.jd.company, jobKey: r.jd.jobKey, platform: r.jd.platform }
                        });
                    } else {
                        await _updateRow(i, { status: 'failed', reason: r.reason });
                    }
                }
            }
            const workers = [];
            for (let w = 0; w < Math.min(CONCURRENCY, batch.results.length); w++) {
                workers.push(_worker());
            }
            await Promise.all(workers);

            // After workers exit, mark any still-pending rows as cancelled.
            const post = await _readBatch();
            if (post && post.results) {
                for (let i = 0; i < post.results.length; i++) {
                    if (post.results[i].status === 'pending' || post.results[i].status === 'running') {
                        await _updateRow(i, { status: 'cancelled' });
                    }
                }
            }

            const finalBatch = await _readBatch();
            if (finalBatch) { finalBatch.finishedAt = Date.now(); await _writeBatch(finalBatch); }

            // Clear the queue once results are written.
            try { await globalThis.QuickApplyJdQueue.clearQueue(); } catch (_) {}
            return { ok: true };
        } finally {
            _running = false;
        }
    }

    function cancelBatch() {
        _cancelled = true;
        // Close any in-flight tabs so workers exit promptly.
        const ids = Array.from(_activeTabIds);
        _activeTabIds.clear();
        for (const id of ids) {
            try { chrome.tabs.remove(id, () => { void chrome.runtime.lastError; }); } catch (_) {}
        }
    }

    /**
     * Retry one previously-failed row IN PLACE. Reads the existing batch,
     * finds the row matching `url`, marks it running, scores it against the
     * batch's locked clientId, and writes the result back to the SAME row.
     * Does NOT touch the queue or other rows — so the other previously-scored
     * results stay visible in the dashboard table.
     */
    async function retryRow(url) {
        const batch = await _readBatch();
        if (!batch || !batch.results) return { ok: false, reason: 'no_batch' };
        const idx = batch.results.findIndex(r => r.url === url);
        if (idx < 0) return { ok: false, reason: 'row_not_found' };
        _cancelled = false;
        const clientId = batch.clientId || null;
        const prevAttempts = batch.results[idx].attempts || 0;
        await _updateRow(idx, {
            status: 'running', attempts: prevAttempts + 1,
            reason: undefined, fit: undefined, jdMeta: undefined
        });
        let r = await _scoreOne(url, clientId, FIRST_ATTEMPT_SETTLE_MS);
        if (!r.ok) {
            await _updateRow(idx, { status: 'running', attempts: prevAttempts + 2 });
            r = await _scoreOne(url, clientId, RETRY_SETTLE_MS);
        }
        if (r.ok) {
            await _updateRow(idx, {
                status: 'scored',
                fit: r.fit,
                jdMeta: { title: r.jd.title, company: r.jd.company, jobKey: r.jd.jobKey, platform: r.jd.platform }
            });
        } else {
            await _updateRow(idx, { status: 'failed', reason: r.reason });
        }
        return { ok: true, status: r.ok ? 'scored' : 'failed' };
    }

    globalThis.QuickApplyJdBatchRunner = { runBatch, cancelBatch, retryRow };
})();
