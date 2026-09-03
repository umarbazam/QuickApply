/**
 * QuickApply Popup — Client list, fill trigger, review panel
 * Reference: UI_SPEC.md § 3, DATA_SCHEMA.md § 2.1
 */

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────
    let clients = [];
    let selectedClient = null;
    let lastReport = null;

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const AVATAR_COLORS = [
        '#F87171', '#34D399', '#7C6AFF', '#FBBF24', '#60A5FA',
        '#F472B6', '#2DD4BF', '#C084FC', '#FB923C', '#A3E635'
    ];

    // ─── Initialize ───────────────────────────────────────────────────
    // Only run init when the popup's own DOM is present. This file is also
    // loaded by chrome-extension://.../test/test-fit-card-compact.html to
    // exercise pickPrimaryParam in isolation, where #client-list doesn't exist.
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('client-list')) init();
    });

    async function init() {
        await loadClients();
        await renderInitialState();
        bindEvents();
        await renderJdQueue();
    }

    async function loadClients() {
        try {
            clients = await QuickApplyStorage.getClients();
        } catch (e) {
            console.error('[QuickApply Popup] Failed to load clients:', e);
            clients = [];
        }
    }

    // ─── Rendering ────────────────────────────────────────────────────

    async function renderInitialState() {
        if (clients.length === 0) {
            showState('empty');
            return;
        }

        // Restore last fill report if it was saved within the last 3 minutes.
        // This handles the case where the popup was closed while filling was in progress.
        const _repData = await chrome.storage.local.get('quickapply_last_report');
        if (_repData.quickapply_last_report) {
            const _rep = _repData.quickapply_last_report;
            if (Date.now() - _rep.savedAt < 3 * 60 * 1000 && _rep.payload) {
                // Restore the client context too so the review badge renders correctly
                if (_rep.payload.clientId) {
                    selectedClient = clients.find(c => c.id === _rep.payload.clientId) || null;
                }
                lastReport = _rep.payload;
                // Clear so we don't re-show it on next open
                chrome.storage.local.remove('quickapply_last_report');
                showReview(lastReport);
                return;
            }
        }

        // Check for a previously selected default client
        const data = await chrome.storage.local.get('activeClientId');
        if (data.activeClientId) {
            const active = clients.find(c => c.id === data.activeClientId);
            if (active) {
                selectedClient = active;
                showDefaultClient(active);
                return;
            }
        }

        // No default — show client list
        showState('list');
        await renderClientList(clients);
    }

    function showDefaultClient(client) {
        selectedClient = client;
        const initials = getInitials(client.firstName, client.lastName);
        const color = client.avatarColor || '#7C6AFF';

        const avatarEl = $('#default-avatar-el');
        avatarEl.textContent = initials;
        avatarEl.style.borderColor = color;
        avatarEl.style.color = color;
        $('#default-name-el').textContent = client.fullName || 'Unnamed';
        $('#default-email-el').textContent = client.email || 'No email';

        showState('default');
        renderFitCard(client);
    }

    // ─── Fit Card (Job Analyzer) ─────────────────────────────────────
    // The matcher and JdCache live in the content script; popup just
    // sends GET_FIT_SCORE { clientId } and renders the FitResult.
    async function renderFitCard(client) {
        const card = $('#fit-card');
        if (!card || !client) return;
        card.classList.add('hidden');
        card.classList.remove('fit-card--compact');
        const toggleBtn = $('#fit-card-toggle');
        if (toggleBtn) {
            toggleBtn.classList.add('hidden');
            toggleBtn.textContent = 'Show details';
            toggleBtn.dataset.expanded = '0';
        }

        let settings = {};
        try { settings = await QuickApplyStorage.getSettings(); } catch (_) {}
        const showVerdict = settings.showFitVerdict !== false;
        const showBreakdown = settings.showFitBreakdown !== false;
        const compact = settings.fitCardMode === 'compact';
        if (!showVerdict && !showBreakdown) return;

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) return;

        let resp;
        try {
            resp = await chrome.runtime.sendMessage({
                type: 'GET_FIT_SCORE',
                targetTabId: tabId,
                payload: { clientId: client.id }
            });
        } catch (_) { return; } // page has no content script (chrome://, etc.)

        if (!resp?.fit) {
            const verdictEl = $('#fit-verdict');
            const breakdownEl = $('#fit-breakdown');
            if (resp?.error) {
                verdictEl.textContent = "Couldn't analyze this job — fill anyway";
                verdictEl.dataset.verdict = '';
                $('#fit-job-meta').textContent = '';
                breakdownEl.innerHTML = '';
                card.classList.remove('hidden');
            } else if (resp?.reason === 'no_client') {
                verdictEl.textContent = 'Pick a client to see fit';
                verdictEl.dataset.verdict = '';
                $('#fit-job-meta').textContent = '';
                breakdownEl.innerHTML = '';
                card.classList.remove('hidden');
            }
            return;
        }

        const fit = resp.fit;
        const verdictEl = $('#fit-verdict');
        const jobMetaEl = $('#fit-job-meta');
        const breakdownEl = $('#fit-breakdown');

        if (showVerdict) {
            const labels = { strong:'Strong fit', good:'Good fit', weak:'Weak fit', poor:'Poor fit', not_a_fit:'Not a fit' };
            const hasManual = fit.parameters.some(p => p.status === 'manual');
            const pctSuffix = fit.verdict === 'not_a_fit' ? '' : ` · ${fit.overallPct}%`;
            verdictEl.textContent = `${labels[fit.verdict] || fit.verdict}${pctSuffix}${hasManual ? ' ⚠' : ''}`;
            verdictEl.dataset.verdict = fit.verdict;
            verdictEl.style.display = '';
        } else {
            verdictEl.style.display = 'none';
        }

        const jobBits = [resp.jd?.title, resp.jd?.company].filter(Boolean);
        jobMetaEl.textContent = jobBits.join(' · ');

        breakdownEl.innerHTML = '';
        if (!showBreakdown) {
            breakdownEl.style.display = 'none';
            card.classList.remove('hidden');
            return;
        }

        const renderRow = (p) => {
            const row = document.createElement('div');
            row.className = 'fit-row';
            const dot = document.createElement('span');
            dot.className = 'fit-row__dot';
            dot.dataset.status = p.status;
            const label = document.createElement('span');
            label.className = 'fit-row__label';
            label.textContent = p.label;
            const score = document.createElement('span');
            score.className = 'fit-row__score';
            score.textContent = p.score == null ? '—' : `${p.score}%`;
            const reason = document.createElement('span');
            reason.className = 'fit-row__reason';
            reason.textContent = p.reason || '';
            if (p.aiUsed) {
                const aiTag = document.createElement('span');
                aiTag.className = 'fit-row__ai-tag';
                aiTag.textContent = 'AI';
                aiTag.title = 'Verdict assisted by Gemini';
                reason.appendChild(document.createTextNode(' '));
                reason.appendChild(aiTag);
            }
            row.append(dot, label, score, reason);
            return row;
        };

        const renderAll = () => {
            breakdownEl.innerHTML = '';
            for (const p of fit.parameters) breakdownEl.appendChild(renderRow(p));
            breakdownEl.style.display = '';
        };

        if (compact) {
            const weights = settings.fitWeights || { yoe:40, title:25, skills:25, salary:10 };
            const primary = pickPrimaryParam(fit.parameters, weights);
            card.classList.add('fit-card--compact');
            if (primary) {
                breakdownEl.appendChild(renderRow(primary));
                breakdownEl.style.display = '';
                if (toggleBtn) {
                    toggleBtn.classList.remove('hidden');
                    toggleBtn.onclick = () => {
                        const expanded = toggleBtn.dataset.expanded === '1';
                        if (expanded) {
                            breakdownEl.innerHTML = '';
                            breakdownEl.appendChild(renderRow(primary));
                            toggleBtn.textContent = 'Show details';
                            toggleBtn.dataset.expanded = '0';
                        } else {
                            renderAll();
                            toggleBtn.textContent = 'Hide details';
                            toggleBtn.dataset.expanded = '1';
                        }
                    };
                }
            } else {
                breakdownEl.style.display = 'none';
            }
        } else {
            renderAll();
        }

        card.classList.remove('hidden');
    }

    function showState(state) {
        $$('.popup-state').forEach(el => el.classList.add('hidden'));
        const el = $(`#state-${state}`);
        if (el) el.classList.remove('hidden');
    }

    // ─── Daily Counter Helpers ───────────────────────────────────────

    function _shiftDateLabel(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function _tierFor(pct) {
        if (pct >= 100) return 'green';
        if (pct >= 50) return 'yellow';
        return 'red';
    }

    function _paintCardCounter(clientId, submitted, target, capped) {
        const el = document.querySelector(`.client-counter[data-client-id="${CSS.escape(clientId)}"]`);
        if (!el) return;
        const textEl = el.querySelector('.client-counter__text');
        const fillEl = el.querySelector('.client-counter__fill');
        if (target <= 0) {
            textEl.textContent = `${submitted}`;
            fillEl.style.width = '0%';
            return;
        }
        textEl.textContent = `${submitted} / ${target}`;
        const pct = Math.min(100, Math.round((submitted / target) * 100));
        fillEl.style.width = pct + '%';
        fillEl.dataset.tier = capped ? 'capped' : _tierFor(pct);
        el.classList.toggle('client-counter--capped', capped);
    }

    async function _renderShiftHeader(clients, settings) {
        const strip = $('#shift-header-strip');
        if (!strip) return;
        if (!clients || clients.length === 0) {
            strip.classList.add('hidden');
            return;
        }
        const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
        const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
        const counts = await QuickApplyStorage.getDailyCounts();
        const day = counts[today] || {};
        let submitted = 0;
        let target = 0;
        let clientsLeft = 0;
        for (const client of clients) {
            const entry = day[client.id];
            const t = QuickApplyStorage.getEffectiveTarget(client, entry, settings);
            const s = entry ? entry.jobKeys.length : 0;
            _paintCardCounter(client.id, s, t, !!(entry && entry.cappedTarget != null));
            if (t > 0) {
                submitted += s;
                target += t;
                if (s < t) clientsLeft += 1;
            }
        }
        if (target === 0) {
            strip.classList.add('hidden');
            return;
        }
        const pct = target > 0 ? Math.min(100, Math.round((submitted / target) * 100)) : 0;
        $('#shift-header-date').textContent = `Today (${_shiftDateLabel(today)})`;
        $('#shift-header-totals').textContent = `${submitted} / ${target}`;
        $('#shift-header-remaining').textContent = clientsLeft > 0
            ? `${clientsLeft} client${clientsLeft === 1 ? '' : 's'} left`
            : 'all on target';
        const fill = $('#shift-header-fill');
        fill.style.width = pct + '%';
        fill.dataset.tier = _tierFor(pct);
        strip.classList.remove('hidden');
    }

    let _kebabInitialized = false;
    function _initKebabDelegation() {
        if (_kebabInitialized) return;
        _kebabInitialized = true;
        const container = $('#client-list');
        if (!container) return;

        // Close any open kebab when clicking outside.
        document.addEventListener('click', (ev) => {
            if (ev.target.closest('.client-kebab') || ev.target.closest('.client-kebab-menu')) return;
            container.querySelectorAll('.client-kebab-menu').forEach(m => m.classList.add('hidden'));
        });

        container.addEventListener('click', async (ev) => {
            const kebab = ev.target.closest('.client-kebab');
            if (kebab) {
                ev.stopPropagation();
                const id = kebab.dataset.clientId;
                const menu = container.querySelector(`.client-kebab-menu[data-menu-client-id="${CSS.escape(id)}"]`);
                if (!menu) return;
                container.querySelectorAll('.client-kebab-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
                menu.classList.toggle('hidden');
                const settings = await QuickApplyStorage.getSettings();
                const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
                const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
                const counts = await QuickApplyStorage.getDailyCounts();
                const entry = counts[today]?.[id];
                const isCapped = !!(entry && entry.cappedTarget != null);
                menu.querySelector('[data-action="mark-done"]').hidden = isCapped || !entry || entry.jobKeys.length === 0;
                menu.querySelector('[data-action="undo-done"]').hidden = !isCapped;
                return;
            }
            const item = ev.target.closest('.client-kebab-menu__item');
            if (!item) return;
            ev.stopPropagation();
            const menu = item.closest('.client-kebab-menu');
            const id = menu.dataset.menuClientId;
            const action = item.dataset.action;
            menu.classList.add('hidden');
            await _handleKebabAction(id, action);
        });
    }

    async function _handleKebabAction(clientId, action) {
        const settings = await QuickApplyStorage.getSettings();
        if (action === 'mark-done') {
            const counts = await QuickApplyStorage.getDailyCounts();
            const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
            const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
            const entry = counts[today]?.[clientId];
            const current = entry ? entry.jobKeys.length : 0;
            await QuickApplyStorage.setCappedTarget({ clientId, value: current, settings });
        } else if (action === 'undo-done') {
            await QuickApplyStorage.setCappedTarget({ clientId, value: null, settings });
        } else if (action === 'set-target') {
            const all = await QuickApplyStorage.getClients();
            const client = all.find(c => c.id === clientId);
            const currentEff = QuickApplyStorage.getEffectiveTarget(client, null, settings);
            const input = window.prompt('Daily target (0–50) for this client. Leave blank to clear override.', String(currentEff));
            if (input === null) return;
            const trimmed = String(input).trim();
            let nextVal;
            if (trimmed === '') {
                nextVal = null;
            } else {
                const n = Number(trimmed);
                if (!Number.isInteger(n) || n < 0 || n > 50) return;
                nextVal = n;
            }
            client.dailyTarget = nextVal;
            await QuickApplyStorage.saveClient(client);
        }
        const refreshed = await QuickApplyStorage.getClients();
        clients.length = 0; clients.push(...refreshed);
        handleSearch($('#search-input').value);
    }

    async function renderClientList(list) {
        const container = $('#client-list');
        container.innerHTML = '';

        list.forEach(client => {
            const card = document.createElement('div');
            card.className = 'client-card';
            card.setAttribute('data-id', client.id);

            const initials = getInitials(client.firstName, client.lastName);
            const color = client.avatarColor || '#7C6AFF';

            card.innerHTML = `
        <div class="client-avatar" style="color: ${color}; border-color: ${color};">
          ${escapeHtml(initials)}
        </div>
        <div class="client-info">
          <div class="client-name">${escapeHtml(client.fullName || 'Unnamed')}</div>
          <div class="client-email">${escapeHtml(client.email || 'No email')}</div>
        </div>
        <div class="client-counter" data-client-id="${escapeHtml(client.id)}">
          <span class="client-counter__text">– / –</span>
          <div class="client-counter__bar"><div class="client-counter__fill"></div></div>
        </div>
        <span class="apply-arrow">→</span>
        <button type="button" class="client-kebab" data-client-id="${escapeHtml(client.id)}" aria-label="Client options" aria-haspopup="menu">⋯</button>
        <div class="client-kebab-menu hidden" data-menu-client-id="${escapeHtml(client.id)}" role="menu">
          <button type="button" class="client-kebab-menu__item" data-action="mark-done">Mark as done for today</button>
          <button type="button" class="client-kebab-menu__item" data-action="undo-done" hidden>Undo "done for today"</button>
          <button type="button" class="client-kebab-menu__item" data-action="set-target">Set daily target…</button>
        </div>
      `;

            card.addEventListener('click', (ev) => {
                if (ev.target.closest('.client-kebab') || ev.target.closest('.client-kebab-menu')) return;
                showDefaultClient(client);
                applyForClient(client);
            });
            container.appendChild(card);
        });

        _initKebabDelegation();

        const settings = await QuickApplyStorage.getSettings();
        await _renderShiftHeader(list, settings);

        $('#list-client-count').textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;
    }

    // ─── Apply (Fill Form) ───────────────────────────────────────────

    async function applyForClient(client, opts = {}) {
        const _t0 = performance.now();
        window.__qaFillT0 = _t0;
        console.log(`[QuickApply Timing] T+0.000s  popup: Fill button clicked → applyForClient (client=${client?.id || '?'})`);
        selectedClient = client;
        showState('filling');
        $('#filling-progress').textContent = 'Sending to page...';
        const _bar = $('#fill-progress-bar');
        if (_bar) _bar.style.width = '0%';

        try {
            // Get active tab
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs[0]) {
                showState('list');
                return;
            }

            const settings = await QuickApplyStorage.getSettings();

            // Persist active client ID for automatic AI icon injection on future page loads
            chrome.storage.local.set({ activeClientId: client.id });

            // Merge opts.autoSubmit into settings — content.js reads settings.autoSubmit,
            // not payload.autoSubmit, so the previous payload-root placement was a dead opt.
            // If the user already saw the duplicate warning for this job and clicked Fill
            // Anyway, bypass the content-side dedup check on this attempt.
            const fillPayload = {
                profile: client,
                settings: opts.autoSubmit ? { ...settings, autoSubmit: true } : settings,
                skipDuplicateCheck: !!_pendingDuplicate,
                _popupSentAt: Date.now()
            };
            if (_pendingDuplicate) {
                hideDuplicateWarning();
                _pendingDuplicate = null;
            }

            console.log(`[QuickApply Timing] T+${((performance.now()-_t0)/1000).toFixed(3)}s  popup: dispatching FILL_FORM → background (tab=${tabs[0].id})`);
            // Route through background so embedded ATS frames receive the fill request too.
            chrome.runtime.sendMessage({
                type: 'FILL_FORM',
                targetTabId: tabs[0].id,
                payload: fillPayload
            }, (response) => {
                if (chrome.runtime.lastError) {
                    // Content script not available — may need injection
                    $('#filling-progress').textContent = 'Injecting scripts...';
                    chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id, allFrames: true },
                        // MUST mirror manifest.json content_scripts exactly. Previously listed
                        // only 4 of 21 files; content.js then crashed on first reference to
                        // QuickApplyCache / AIResolver / FillEngine / platform fillers, so the
                        // popup-driven retry path silently failed on pages that predate the
                        // extension install (the only path this fallback exists for).
                        files: [
                            'storage.js',
                            'cache.js',
                            'field-mapper.js',
                            'learning-engine.js',
                            'field-discoverer.js',
                            'fill-engine.js',
                            'ai-engine.js',
                            'ai-resolver.js',
                            'platforms/base-filler.js',
                            'platforms/generic.js',
                            'platforms/workday.js',
                            'platforms/greenhouse.js',
                            'platforms/icims.js',
                            'platforms/smartrecruiters.js',
                            'platforms/lever.js',
                            'platforms/ashby.js',
                            'platforms/workable.js',
                            'platforms/rippling.js',
                            'platforms/breezy.js',
                            'platforms/teamtailor.js',
                            'submit-engine.js',
                            'content.js'
                        ]
                    }, () => {
                        if (chrome.runtime.lastError) {
                            console.error('[QuickApply] Script injection failed:', chrome.runtime.lastError.message);
                            showState('list');
                            return;
                        }
                        // Retry
                        setTimeout(() => {
                            chrome.runtime.sendMessage({
                                type: 'FILL_FORM',
                                targetTabId: tabs[0].id,
                                payload: fillPayload
                            }, handleFillResponse);
                        }, 300);
                    });
                } else {
                    handleFillResponse(response);
                }
            });
        } catch (err) {
            console.error('[QuickApply Popup] Fill error:', err);
            showState('list');
        }
    }

    // Latest duplicate detection (cleared on Switch / Dismiss / successful fill).
    // When non-null, the next Fill Form click re-sends FILL_FORM with skipDuplicateCheck:true.
    let _pendingDuplicate = null;

    function handleFillResponse(response) {
        console.log('[QuickApply Dedup] popup handleFillResponse', {
            hasResponse: !!response,
            hasPayload: !!response?.payload,
            duplicate: !!response?.payload?.duplicate,
            payloadKeys: response?.payload ? Object.keys(response.payload) : []
        });
        // Bug-127 fix: always read lastError to suppress "Unchecked runtime.lastError" warning.
        // eslint-disable-next-line no-unused-vars
        const _lastErr = chrome.runtime.lastError;
        if (!response || !response.payload) {
            const msg = _lastErr
                ? 'Connection failed — reload the page and try again.'
                : 'No response from page — try again.';
            const prog = $('#filling-progress');
            if (prog) prog.textContent = msg;
            setTimeout(() => showState('list'), 2000);
            return;
        }

        if (response.payload.duplicate) {
            showDuplicateInline(response.payload);
            return;
        }

        // Successful fill cleared any prior duplicate state for this job.
        _pendingDuplicate = null;
        hideDuplicateWarning();
        lastReport = response.payload;
        showReview(lastReport);
    }

    function showDuplicateInline(payload) {
        console.log('[QuickApply Dedup] popup showDuplicateInline called', payload);
        _pendingDuplicate = payload;
        // Return the user to the default client state (where the Fill button + warning live).
        showState('default');
        const warn = $('#duplicate-warning');
        const detail = $('#duplicate-warning-detail');
        const fillLabel = $('#btn-fill-now-label');
        const fillBtn = $('#btn-fill-now');
        console.log('[QuickApply Dedup] popup DOM lookup', { warn: !!warn, detail: !!detail, fillLabel: !!fillLabel, fillBtn: !!fillBtn });
        if (detail) {
            const titleLine = payload.title
                ? `<strong>${escapeHtml(payload.title)}</strong>${payload.company ? ' at ' + escapeHtml(payload.company) : ''}. `
                : '';
            const last = payload.lastAppliedAt ? new Date(payload.lastAppliedAt).toLocaleDateString() : 'earlier';
            const countSuffix = payload.count > 1 ? ` (${payload.count}×)` : '';
            detail.innerHTML = `${titleLine}Last filled on <strong>${escapeHtml(last)}</strong>${countSuffix}. Click <em>Fill Anyway</em> to apply again.`;
        }
        if (warn) warn.classList.remove('hidden');
        if (fillLabel) fillLabel.textContent = 'Fill Anyway';
        if (fillBtn) fillBtn.classList.add('btn-fill-now--anyway');
    }

    function hideDuplicateWarning() {
        const warn = $('#duplicate-warning');
        const fillLabel = $('#btn-fill-now-label');
        const fillBtn = $('#btn-fill-now');
        if (warn) warn.classList.add('hidden');
        if (fillLabel) fillLabel.textContent = 'Fill Form';
        if (fillBtn) fillBtn.classList.remove('btn-fill-now--anyway');
    }

    // ─── Listen for fill report from content script ───────────────────

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'FILL_REPORT' && message.payload) {
            // Duplicate broadcasts must NOT route to showReview — they carry no summary/results
            // and would otherwise overwrite the inline duplicate warning with a blank report.
            if (message.payload.duplicate) {
                showDuplicateInline(message.payload);
                return;
            }
            _pendingDuplicate = null;
            hideDuplicateWarning();
            lastReport = message.payload;
            showReview(message.payload);
        }
        if (message.type === 'FILL_PROGRESS') {
            const { current, total, label } = message.payload || {};
            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            const bar = $('#fill-progress-bar');
            if (bar) bar.style.width = pct + '%';
            const prog = $('#filling-progress');
            if (prog) prog.textContent = label || `${current} / ${total} fields`;
        }
    });

    // ─── Review Panel ─────────────────────────────────────────────────

    function showReview(report) {
        showState('review');

        // Client badge
        const badge = $('#review-badge');
        if (selectedClient) {
            const initials = getInitials(selectedClient.firstName, selectedClient.lastName);
            const color = selectedClient.avatarColor || '#7C6AFF';
            const platform = report.platform || 'generic';

            badge.innerHTML = `
        <div class="badge-avatar" style="color: ${color}; border-color: ${color};">${escapeHtml(initials)}</div>
        <span class="badge-name">${escapeHtml(selectedClient.fullName || 'Unknown')}</span>
        <span class="badge-platform">${escapeHtml(platform)}</span>
      `;
        }

        // Summary bar
        const summary = report.summary || {};
        $('#review-summary').innerHTML = `
      <div class="summary-stat"><span class="stat-dot success"></span>${summary.filled ?? 0} Filled</div>
      <div class="summary-stat"><span class="stat-dot warning"></span>${summary.fuzzy ?? 0} Fuzzy</div>
      <div class="summary-stat"><span class="stat-dot error"></span>${summary.error ?? 0} Missed</div>
    `;

        // Results rows
        const resultsContainer = $('#review-results');
        resultsContainer.innerHTML = '';

        const displayResults = report.results.filter(r => r.status !== 'skipped');

        displayResults.forEach(result => {
            const row = document.createElement('div');
            row.className = 'review-row';
            row.setAttribute('data-selector', result.selector || '');

            let statusIcon = '✅';
            if (result.status === 'fuzzy') statusIcon = '⚠️';
            else if (result.status === 'error') statusIcon = '❌';
            else if (result.status === 'skipped') statusIcon = '⏭️';

            const labelText = formatFieldName(result.fieldName);
            const valueText = result.value || result.error || '—';

            let pillHtml = '';
            if (result.status === 'fuzzy' && result.confidence) {
                pillHtml = `<span class="confidence-pill">${Math.round(result.confidence * 100)}%</span>`;
            }

            row.innerHTML = `
        <span class="review-status">${statusIcon}</span>
        <span class="review-field-label">${escapeHtml(labelText)}</span>
        <span class="review-field-value">${escapeHtml(valueText)}</span>
        ${pillHtml}
      `;

            // Click → scroll to field on page
            row.addEventListener('click', () => {
                if (result.selector) scrollToField(result.selector);
            });

            resultsContainer.appendChild(row);
        });

        // Update reminder text based on whether auto-submit ran
        const reminder = document.querySelector('.review-reminder');
        if (reminder) {
            if (report.autoSubmitted && report.autoSubmitted.submitted) {
                reminder.textContent = '✅ Form submitted — check page for confirmation';
                reminder.style.color = 'var(--color-success)';
            } else if (report.autoSubmitted && !report.autoSubmitted.submitted) {
                const reason = report.autoSubmitted.reason || 'Submit button not found';
                reminder.textContent = `⚠️ ${reason} — submit manually`;
                reminder.style.color = 'var(--color-warning)';
            } else {
                reminder.textContent = '⚠️ Review all fields, then submit manually';
                reminder.style.color = '';
            }
        }
    }

    // ─── Actions ──────────────────────────────────────────────────────

    async function scrollToField(selector) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'SCROLL_TO_FIELD',
                payload: { selector }
            });
        }
    }

    async function clearForm() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_FORM' });
        }
        showState('list');
        selectedClient = null;
        lastReport = null;
    }

    function editOnPage() {
        if (!lastReport) return;
        // Find first error or fuzzy field
        const target = lastReport.results.find(r => r.status === 'error' || r.status === 'fuzzy');
        if (!target || !target.selector) {
            // Nothing to jump to — all fields filled OK. Close popup so the
            // user can interact with the page directly.
            window.close();
            return;
        }
        scrollToField(target.selector);
        // Close the popup so the field is fully visible and the user can type.
        window.close();
    }

    function refill() {
        lastReport = null;
        if (selectedClient) {
            showDefaultClient(selectedClient);
        } else {
            showState('list');
            renderClientList(clients);
        }
    }

    function openDashboard() {
        chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    }

    // ─── Search ───────────────────────────────────────────────────────

    function handleSearch(query) {
        const clearBtn = $('#search-clear');
        if (query) {
            clearBtn.classList.remove('hidden');
            const filtered = clients.filter(c =>
                (c.fullName || '').toLowerCase().includes(query.toLowerCase()) ||
                (c.email || '').toLowerCase().includes(query.toLowerCase())
            );
            renderClientList(filtered);
        } else {
            clearBtn.classList.add('hidden');
            renderClientList(clients);
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function getInitials(first, last) {
        const f = (first || '').charAt(0).toUpperCase();
        const l = (last || '').charAt(0).toUpperCase();
        return f + l || '??';
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatFieldName(field) {
        // camelCase → Title Case
        return field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    }

    // ─── Compact Fit Card helper ─────────────────────────────────────
    // Picks the single most surprising row to surface in compact mode.
    // Priority: first hard fail → first manual → lowest-scoring soft.
    // Tie on score breaks by lowest weight (less-weighted misses still surprise).
    // Returns null when nothing is worth surfacing (all hard pass + soft pass/skipped).
    function pickPrimaryParam(parameters, weights) {
        if (!Array.isArray(parameters)) return null;
        const w = weights || { yoe:40, title:25, skills:25, salary:10 };

        const hardFail = parameters.find(p => p.kind === 'hard' && p.status === 'fail');
        if (hardFail) return hardFail;

        const manual = parameters.find(p => p.status === 'manual');
        if (manual) return manual;

        const scored = parameters.filter(p =>
            p.kind === 'soft' && p.status === 'pass' && typeof p.score === 'number'
        );
        if (!scored.length) return null;

        let best = scored[0];
        for (let i = 1; i < scored.length; i++) {
            const cand = scored[i];
            if (cand.score < best.score) { best = cand; continue; }
            if (cand.score === best.score && (w[cand.key] || 0) < (w[best.key] || 0)) {
                best = cand;
            }
        }
        // If the "lowest" soft row is already a strong score (>=75), nothing's worth
        // surfacing — caller renders verdict-only.
        return best.score < 75 ? best : null;
    }

    // Expose for self-tests + reuse from mini-card.js (Task 6).
    if (typeof window !== 'undefined') {
        window.QuickApplyFitCardCompact = { pickPrimaryParam };
    }

    // ─── Bind Events ──────────────────────────────────────────────────

    function bindEvents() {
        // Search
        $('#search-input').addEventListener('input', (e) => handleSearch(e.target.value));
        $('#search-clear').addEventListener('click', () => {
            $('#search-input').value = '';
            handleSearch('');
        });

        // Gear / Dashboard buttons
        $('#btn-gear').addEventListener('click', openDashboard);
        $('#btn-empty-dashboard').addEventListener('click', openDashboard);
        $('#btn-footer-dashboard').addEventListener('click', openDashboard);

        // Default client state
        $('#btn-fill-now').addEventListener('click', () => {
            if (selectedClient) applyForClient(selectedClient, {});
        });
        $('#btn-fill-submit')?.addEventListener('click', () => {
            if (selectedClient) applyForClient(selectedClient, { autoSubmit: true });
        });
        $('#btn-change-client').addEventListener('click', () => {
            _pendingDuplicate = null;
            hideDuplicateWarning();
            showState('list');
            renderClientList(clients);
        });

        // Review actions
        $('#btn-back').addEventListener('click', refill);
        $('#btn-edit').addEventListener('click', editOnPage);
        $('#btn-refill').addEventListener('click', refill);
        $('#btn-clear').addEventListener('click', clearForm);

        // Duplicate-application inline warning: dismiss button just clears the warning
        // and resets the Fill button label. The next Fill click then goes through the
        // normal dedup path again (and would warn again).
        $('#btn-duplicate-dismiss')?.addEventListener('click', () => {
            _pendingDuplicate = null;
            hideDuplicateWarning();
        });

        // Load fill behaviour settings
        chrome.storage.local.get('quickapply_settings', res => {
            const s = res.quickapply_settings || {};
            document.getElementById('autoAdvanceSteps').checked = s.autoAdvanceSteps !== false; // default ON
            document.getElementById('autoSubmit').checked = !!s.autoSubmit; // default OFF
            document.getElementById('forceAI').checked = !!s.forceAI; // default OFF
        });

        // Save on change
        ['autoAdvanceSteps', 'autoSubmit', 'forceAI'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', async (e) => {
                const res = await chrome.storage.local.get('quickapply_settings');
                const s = res.quickapply_settings || {};
                s[id] = e.target.checked;
                chrome.storage.local.set({ quickapply_settings: s });
            });
        });
    }

    // ─── JD Analyzer Queue (popup) ───────────────────────────────────
    async function renderJdQueue() {
        const card = $('#jd-queue-card');
        const list = $('#jd-queue-list');
        const countEl = $('#jd-queue-count');
        if (!card || !list || !countEl) return;
        let items = [];
        try {
            items = (await globalThis.QuickApplyJdQueue?.listQueue()) || [];
        } catch (_) { items = []; }
        if (!items.length) {
            card.classList.add('hidden');
            list.innerHTML = '';
            countEl.textContent = '0';
            return;
        }
        countEl.textContent = String(items.length);
        list.innerHTML = '';
        const MAX = 5;
        const displayed = items.slice(0, MAX);
        for (const it of displayed) {
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.className = 'jd-queue-url';
            try {
                const u = new URL(it.url);
                span.textContent = u.host + u.pathname;
                span.title = it.url;
            } catch (_) { span.textContent = it.url; span.title = it.url; }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'jd-queue-remove';
            btn.textContent = '×';
            btn.setAttribute('aria-label', 'Remove from queue');
            btn.addEventListener('click', async () => {
                try { await globalThis.QuickApplyJdQueue.removeFromQueue(it.url); } catch (_) {}
                renderJdQueue();
            });
            li.append(span, btn);
            list.appendChild(li);
        }
        if (items.length > MAX) {
            const li = document.createElement('li');
            li.style.color = 'var(--color-text-muted, #6B6560)';
            li.textContent = `+${items.length - MAX} more`;
            list.appendChild(li);
        }
        card.classList.remove('hidden');
    }

    // Re-render whenever storage changes (e.g. context menu adds while popup open).
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.quickapply_jd_queue) renderJdQueue();
    });

    // Wire Run + Clear buttons. Run sends RUN_BATCH to background — receiver
    // is implemented in Task 4. Until then, the click is logged.
    document.addEventListener('DOMContentLoaded', () => {
        const runBtn = document.getElementById('btn-jd-queue-run');
        const clearBtn = document.getElementById('btn-jd-queue-clear');
        if (runBtn) {
            runBtn.addEventListener('click', async () => {
                runBtn.disabled = true;
                runBtn.textContent = 'Starting…';
                try {
                    await chrome.runtime.sendMessage({ type: 'RUN_BATCH' });
                } catch (_) {}
                window.close();
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                try { await globalThis.QuickApplyJdQueue.clearQueue(); } catch (_) {}
                renderJdQueue();
            });
        }
    });

})();
