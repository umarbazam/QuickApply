/**
 * QuickApply — Floating Mini-Card overlay
 * Top-frame-only; Shadow-DOM-isolated; verdict + worst-row preview.
 *
 * Listens for `quickapply:jd-extracted` from jd-extractor.js, scores against
 * the active client via the in-frame FitMatcher, and renders bottom-right.
 * Dismissable per-host (7-day TTL) and gated on `showMiniCard` setting.
 */
(function () {
    'use strict';

    const LOG = (...args) => console.log('[QuickApply MiniCard]', ...args);

    if (window !== window.top) return;
    if (!/^https?:/.test(location.protocol)) return;

    const HOST_ID = 'quickapply-mini-card-host';
    let _shadowRoot = null;
    let _currentJobKey = null;
    let _hidden = false; // hard-hidden by Alt+Shift+J or close button — survives until next page nav
    let _healTimer = null;
    let _fitWeights = null; // user's settings.fitWeights, so _localRecompute matches the popup/fit-matcher

    function _ensureHost() {
        let host = document.getElementById(HOST_ID);
        if (host) return host;
        host = document.createElement('div');
        host.id = HOST_ID;
        // Inline styles: the host is a positioned shell. All visible chrome lives in shadow.
        // Anchored bottom-LEFT (not right): every major ATS (Workday, Greenhouse, Lever,
        // Ashby, Workable) right-aligns its primary footer action button, and a bottom-right
        // card at max z-index sits directly over it and swallows the click ("Save and
        // Continue"/"Submit" become un-clickable). pointer-events:none makes the host shell
        // itself click-through; the visible .card re-enables pointer-events for its own controls.
        host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483646;pointer-events:none;';
        // Append to <html> not <body>: React error-boundary recovery (Remix /
        // Next.js apps like job-boards.greenhouse.io) rewrites document.body and
        // would wipe a body-attached host. position:fixed keeps the visual
        // placement identical.
        (document.documentElement || document.body).appendChild(host);
        // Self-heal: SPA hydration can still detach our host AFTER append (the
        // route that bypasses childList mutations on <html>). Poll for 30s
        // post-attach and re-append on detach. Stops after the page settles.
        if (!_healTimer) {
            let attempts = 0;
            _healTimer = setInterval(() => {
                attempts++;
                if (attempts > 30 || _hidden) { clearInterval(_healTimer); _healTimer = null; return; }
                const h = document.getElementById(HOST_ID);
                if (h && h.isConnected) return;
                try { (document.documentElement || document.body).appendChild(host); } catch (_) {}
            }, 1000);
        }
        _shadowRoot = host.attachShadow({ mode: 'closed' });
        _shadowRoot.innerHTML = `
<style>
  :host { all: initial; }
  .card {
    pointer-events: auto; /* re-enable interaction; host shell is pointer-events:none */
    width: 280px; max-width: calc(100vw - 32px);
    background: #FFFFFF; color: #141414;
    border: 1px solid #E8E4DF;
    border-radius: 8px;
    box-shadow: 0 4px 18px rgba(20,20,20,0.18);
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 12px; line-height: 1.45;
    padding: 12px 14px 10px;
    transition: opacity 200ms ease, transform 200ms ease;
    /* Cap the card height so the verdict + close button stay visible even when
       the expanded breakdown, AI hint, and gap summary push the content tall.
       Anything beyond max-height becomes scrollable. min(70vh, 600px) keeps
       it comfortable on both small and tall screens. */
    max-height: min(70vh, 600px);
    display: flex; flex-direction: column;
  }
  /* Header (verdict + ✕) stays pinned at the top while body scrolls. */
  .header { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-shrink: 0; }
  /* The body holds everything except the header + footer — it's the part that
     scrolls when the content overflows the cap. */
  .body { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-height: 0; }
  .footer { flex-shrink: 0; }
  /* Custom scrollbar (WebKit) — narrow + subtle so it doesn't draw attention. */
  .body::-webkit-scrollbar { width: 6px; }
  .body::-webkit-scrollbar-thumb { background: #D6D2CD; border-radius: 3px; }
  .body::-webkit-scrollbar-thumb:hover { background: #B8B3AD; }
  .body::-webkit-scrollbar-track { background: transparent; }
  .verdict { font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
  .verdict[data-verdict="strong"]    { color: #2D9E6B; }
  .verdict[data-verdict="good"]      { color: #2D9E6B; opacity: .85; }
  .verdict[data-verdict="weak"]      { color: #D97706; }
  .verdict[data-verdict="poor"]      { color: #D97706; opacity: .9; }
  .verdict[data-verdict="not_a_fit"] { color: #DC2626; }
  .today-chip {
    display: inline-block; margin-left: 8px;
    padding: 1px 6px; border-radius: 8px;
    background: #FAFAF8; border: 1px solid #E8E4DF;
    color: #141414; font-size: 10.5px; font-variant-numeric: tabular-nums;
    font-weight: 600;
    vertical-align: middle;
  }
  .today-chip.hidden { display: none; }
  .today-chip[data-tier="green"]  { background: #DCFCE7; border-color: #86EFAC; color: #14532D; }
  .today-chip[data-tier="yellow"] { background: #FEF3C7; border-color: #FCD34D; color: #78350F; }
  .today-chip[data-tier="red"]    { background: #FEE2E2; border-color: #FCA5A5; color: #7F1D1D; }
  .today-chip[data-tier="capped"] { background: #F5F5F0; border-color: #D6D2CD; color: #6B6560; }
  .close {
    background: transparent; border: none; cursor: pointer;
    color: #A8A29E; font-size: 16px; line-height: 1;
    padding: 0 2px; margin: -4px -4px 0 0;
  }
  .close:hover { color: #141414; }
  .meta { color: #A8A29E; font-size: 11px; margin-bottom: 8px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .reject-pills {
    display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px;
  }
  .reject-pills.hidden { display: none; }
  .reject-pill {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: #DC2626; color: #FFFFFF;
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
    border: none; cursor: help; font-family: inherit;
    line-height: 1.4;
  }
  .reject-pill:hover { background: #B91C1C; }
  .row { display: grid; grid-template-columns: 8px 1fr 44px;
         gap: 8px; align-items: start; padding-top: 6px;
         border-top: 1px solid #E8E4DF; }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: #E8E4DF; }
  .dot[data-status="pass"]   { background: #2D9E6B; }
  .dot[data-status="fail"]   { background: #DC2626; }
  .dot[data-status="manual"] { background: #D97706; }
  .label { font-weight: 500; font-size: 11.5px; }
  .reason { color: #6B6560; font-size: 11px; line-height: 1.45; }
  /* Per-row Ignore / Restore link rendered next to the score column. */
  .ignore-link {
    background: none; border: none; padding: 0; margin-left: 6px;
    font-family: inherit; font-size: 10.5px; color: #6B6560;
    text-decoration: underline; cursor: pointer;
  }
  .ignore-link:hover { color: #141414; }
  .row.ignored .label,
  .row.ignored .reason,
  .row.ignored .score { opacity: 0.5; text-decoration: line-through; }
  .row.ignored .ignored-reason {
    display: block; font-size: 10.5px; color: #6B6560;
    font-style: italic; margin-top: 2px;
  }
  /* AI consider-anyway hint: shown when client target seniority doesn't match
     JD level but the CV still supports applying. */
  .ai-suggest {
    margin: 8px 0 0; padding: 6px 8px; border-radius: 4px;
    background: #EFF6FF; border-left: 3px solid #2563EB;
    font-size: 11px; color: #1E3A8A; line-height: 1.45;
  }
  .ai-suggest.hidden { display: none; }
  .ai-suggest b { font-weight: 600; }
  /* Already-applied banner — shown when the active client has previously filled
     this exact job (same clientId + jobKey). Mirrors the popup warning so the
     status is visible without opening the popup. */
  .applied-banner {
    margin: 0 0 8px; padding: 8px 10px; border-radius: 6px;
    background: #FEF3C7; border: 1px solid #FCD34D;
    color: #78350F; font-size: 11px; line-height: 1.45;
    display: flex; align-items: flex-start; gap: 8px;
  }
  .applied-banner.hidden { display: none; }
  .applied-banner__icon { flex: 0 0 auto; color: #B45309; font-size: 14px; line-height: 1.1; }
  .applied-banner__body { flex: 1 1 auto; min-width: 0; }
  .applied-banner__title { font-weight: 600; color: #78350F; }
  .applied-banner__detail { margin-top: 1px; color: #92400E; }
  /* Gap summary line — concise "what's missing" rendered under the breakdown. */
  .gap-summary {
    margin: 8px 0 0; padding: 6px 8px; border-radius: 4px;
    background: #FAFAF8; border-left: 3px solid #D97706;
    font-size: 11px; color: #6B6560; line-height: 1.45;
  }
  .gap-summary.hidden { display: none; }
  .gap-summary b { color: #141414; font-weight: 600; }
  .score { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; font-size: 11.5px; }
  .footer { margin-top: 6px; display: flex; justify-content: flex-end; gap: 10px; }
  .open-popup { background: transparent; border: none; cursor: pointer;
                color: #E63B2E; font-size: 11px; font-weight: 600; padding: 2px 0;
                font-family: inherit; letter-spacing: 0.01em; }
  .open-popup:hover { opacity: 0.75; }
  .card { cursor: pointer; }
  .card.expanded { cursor: default; }
  .all-rows { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .all-rows .row { padding-top: 4px; }
  .hidden { display: none; }
  @media (prefers-reduced-motion: reduce) {
    .card { transition: none; }
  }
</style>
<div class="card" role="status" aria-live="polite">
  <div class="header">
    <span class="verdict" data-verdict=""></span>
    <span class="today-chip hidden" title=""></span>
    <button class="close" aria-label="Dismiss for 7 days" title="Dismiss for 7 days">×</button>
  </div>
  <div class="body">
    <div class="meta"></div>
    <div class="applied-banner hidden">
      <span class="applied-banner__icon" aria-hidden="true">⚠</span>
      <span class="applied-banner__body">
        <span class="applied-banner__title">Already applied to this job</span>
        <span class="applied-banner__detail"></span>
      </span>
    </div>
    <div class="reject-pills hidden"></div>
    <div class="row hidden">
      <span class="dot"></span>
      <span class="label-and-reason">
        <span class="label"></span><br><span class="reason"></span>
      </span>
      <span class="score"></span>
    </div>
    <div class="all-rows hidden"></div>
    <div class="ai-suggest hidden"></div>
    <div class="gap-summary hidden"></div>
  </div>
  <div class="footer">
    <button class="open-popup">Click card to expand · ✕ to dismiss</button>
  </div>
</div>`;
        const closeBtn = _shadowRoot.querySelector('.close');
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            (async () => {
                try { await window.QuickApplyMiniCardDismissals.dismiss(location.host, _currentJobKey); } catch (_) {}
                _remove();
            })();
        });
        // Click the card body to expand to the full breakdown inline; click again to collapse.
        const cardEl = _shadowRoot.querySelector('.card');
        cardEl.addEventListener('click', (ev) => {
            // Ignore clicks on the close button — already handled with stopPropagation,
            // but defense-in-depth in case the SVG/text inside the button bubbles.
            if (ev.target.closest('.close')) return;
            const expanded = cardEl.classList.toggle('expanded');
            const allRows = _shadowRoot.querySelector('.all-rows');
            const oneRow = _shadowRoot.querySelector('.row');
            if (expanded) {
                allRows.classList.remove('hidden');
                oneRow.classList.add('hidden');
            } else {
                allRows.classList.add('hidden');
                // Restore the single-row preview only if there was one to show.
                if (oneRow.dataset.hasContent === '1') oneRow.classList.remove('hidden');
            }
        });
        return host;
    }

    function _remove() {
        const host = document.getElementById(HOST_ID);
        if (host) host.remove();
        _shadowRoot = null;
        if (_healTimer) { clearInterval(_healTimer); _healTimer = null; }
    }

    function _hideHard() {
        _hidden = true;
        _remove();
    }

    // Per-job per-param ignore overrides. Keyed by jobKey + paramKey. Mutates
    // fit.parameters[i].ignored / .ignoredReason in place when applied.
    async function _loadOverrides(jobKey) {
        try {
            const r = await chrome.storage.local.get('quickapply_jd_param_overrides');
            return (r && r.quickapply_jd_param_overrides && r.quickapply_jd_param_overrides[jobKey]) || {};
        } catch (_) { return {}; }
    }
    async function _saveOverride(jobKey, paramKey, override) {
        try {
            const r = await chrome.storage.local.get('quickapply_jd_param_overrides');
            const all = (r && r.quickapply_jd_param_overrides) || {};
            all[jobKey] = all[jobKey] || {};
            if (override) all[jobKey][paramKey] = override;
            else delete all[jobKey][paramKey];
            await chrome.storage.local.set({ quickapply_jd_param_overrides: all });
        } catch (_) {}
    }
    function _applyOverridesToFit(fit, overrides) {
        for (const p of fit.parameters || []) {
            const ov = overrides && overrides[p.key];
            if (ov && ov.ignored) { p.ignored = true; p.ignoredReason = ov.justification || ''; }
            else { delete p.ignored; delete p.ignoredReason; }
        }
    }
    // Local recompute that mirrors fit-matcher's _recompute math. Required because
    // ignoring a param needs to update overallPct/verdict in place without going
    // back to the fit-matcher pipeline. Weights default to the same constants.
    function _localRecompute(fit) {
        // Honor the user's custom weights so the mini-card overall matches the
        // popup (which scores through fit-matcher with settings.fitWeights).
        const W = _fitWeights || { yoe: 40, title: 25, skills: 25, salary: 10 };
        const hardFailed = (fit.parameters || []).some(p => p.kind === 'hard' && p.status === 'fail' && !p.ignored);
        let totalW = 0, sumW = 0;
        for (const p of fit.parameters || []) {
            if (p.kind !== 'soft' || p.ignored) continue;
            if (p.status === 'skipped' || p.status === 'manual' || p.score == null) continue;
            const w = W[p.key] || 0; totalW += w; sumW += w * p.score;
        }
        const pct = totalW > 0 ? Math.round(sumW / totalW) : 0;
        fit.overallPct = hardFailed ? 0 : pct;
        fit.verdict = hardFailed ? 'not_a_fit'
            : pct >= 80 ? 'strong' : pct >= 60 ? 'good' : pct >= 40 ? 'weak' : 'poor';
    }
    function _buildGapSummary(fit) {
        const bits = [];
        const params = fit.parameters || [];
        // Hard fails (not ignored) — surface first
        const hardFails = params.filter(p => p.kind === 'hard' && p.status === 'fail' && !p.ignored);
        for (const p of hardFails) bits.push(`<b>${p.label}</b>: ${p.reason || 'no match'}`);
        // Missing skills if exposed on the skills param
        const skills = params.find(p => p.key === 'skills' && !p.ignored);
        const missing = skills && Array.isArray(skills.missingSkills) ? skills.missingSkills.slice(0, 3) : [];
        if (missing.length) bits.push(`Missing skills: <b>${missing.join(', ')}</b>`);
        // YoE / Title low scores (excluding ignored)
        for (const p of params) {
            if (p.ignored || p.kind !== 'soft' || p.score == null || p.score >= 50) continue;
            bits.push(`Low ${p.label.toLowerCase()} (${p.score}%): ${p.reason || ''}`);
        }
        return bits.slice(0, 4).join(' · ');
    }

    async function _showOrUpdate(fit, jd) {
        if (_hidden) return;
        _ensureHost();
        if (!_shadowRoot) return;
        // Apply any user-saved ignore overrides + recompute pct/verdict before
        // we render. This is what makes "Ignore YoE" stick across reopens of
        // the card without re-running the AI.
        if (_currentJobKey) {
            const overrides = await _loadOverrides(_currentJobKey);
            _applyOverridesToFit(fit, overrides);
            _localRecompute(fit);
        }
        const verdictEl = _shadowRoot.querySelector('.verdict');
        const metaEl = _shadowRoot.querySelector('.meta');
        const rowEl = _shadowRoot.querySelector('.row');
        const dotEl = rowEl.querySelector('.dot');
        const labelEl = rowEl.querySelector('.label');
        const reasonEl = rowEl.querySelector('.reason');
        const scoreEl = rowEl.querySelector('.score');

        const labels = { strong:'Strong fit', good:'Good fit', weak:'Weak fit', poor:'Poor fit', not_a_fit:'Not a fit' };
        const hasManual = fit.parameters.some(p => p.status === 'manual');
        // ALWAYS show the percentage — including for Not a fit. User asked:
        // "on the top even declare not fit should have the percentage like the
        // fit but contain the not fit tag".
        const pctSuffix = ` · ${fit.overallPct}%`;
        verdictEl.textContent = `${labels[fit.verdict] || fit.verdict}${pctSuffix}${hasManual ? ' ⚠' : ''}`;
        verdictEl.dataset.verdict = fit.verdict;

        const titleBits = [jd?.title, jd?.company].filter(Boolean);
        metaEl.textContent = titleBits.join(' · ');

        // Already-applied indicator. Reads the dedup index written by content.js /
        // background.js on each successful FILL_REPORT. Keyed by `${clientId}::${jobKey}`
        // so it's per-client per-job — switching clients re-evaluates.
        try {
            const bannerEl = _shadowRoot.querySelector('.applied-banner');
            const bannerDetail = bannerEl && bannerEl.querySelector('.applied-banner__detail');
            if (bannerEl && _currentJobKey) {
                const _activeData = await new Promise(r => chrome.storage.local.get('activeClientId', r));
                const _activeId = _activeData?.activeClientId;
                const _idxData = await new Promise(r => chrome.storage.local.get('quickapply_applied_jobs', r));
                const _idx = _idxData?.quickapply_applied_jobs || {};
                const _prior = _activeId ? _idx[`${_activeId}::${_currentJobKey}`] : null;
                if (_prior) {
                    const _when = _prior.lastAppliedAt
                        ? new Date(_prior.lastAppliedAt).toLocaleDateString()
                        : 'previously';
                    const _countSuffix = _prior.count > 1 ? ` (${_prior.count}×)` : '';
                    if (bannerDetail) bannerDetail.textContent = `Last filled on ${_when}${_countSuffix}.`;
                    bannerEl.classList.remove('hidden');
                } else {
                    bannerEl.classList.add('hidden');
                }
            } else if (bannerEl) {
                bannerEl.classList.add('hidden');
            }
        } catch (_) { /* dedup is best-effort; never block the fit card */ }

        // Today's submission chip: reads quickapply_daily_counts for the active
        // client and current shift date. Hidden when no active client or when
        // effective target is 0.
        try {
            const chipEl = _shadowRoot.querySelector('.today-chip');
            if (chipEl && _currentJobKey) {
                const settings = await window.QuickApplyStorage.getSettings();
                const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
                const today = window.QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
                const counts = await window.QuickApplyStorage.getDailyCounts();
                const activeData = await new Promise(r => chrome.storage.local.get('activeClientId', r));
                const activeId = activeData?.activeClientId;
                if (!activeId) {
                    chipEl.classList.add('hidden');
                } else {
                    const client = await window.QuickApplyStorage.getClientById(activeId);
                    const entry = counts[today]?.[activeId];
                    const submitted = entry ? entry.jobKeys.length : 0;
                    const target = window.QuickApplyStorage.getEffectiveTarget(client, entry, settings);
                    if (target <= 0) {
                        chipEl.classList.add('hidden');
                    } else {
                        const pct = Math.min(100, Math.round((submitted / target) * 100));
                        const tier = entry && entry.cappedTarget != null ? 'capped'
                                   : pct >= 100 ? 'green'
                                   : pct >= 50 ? 'yellow' : 'red';
                        chipEl.textContent = `${submitted}/${target} today`;
                        chipEl.dataset.tier = tier;
                        const clientName = client?.fullName || `${client?.firstName || ''} ${client?.lastName || ''}`.trim() || 'Active client';
                        chipEl.title = `${clientName} · ${submitted} of ${target} submissions today (cutoff ${cutoff}:00)`;
                        chipEl.classList.remove('hidden');
                    }
                }
            } else if (chipEl) {
                chipEl.classList.add('hidden');
            }
        } catch (_) { /* chip is best-effort */ }

        // Reject pills: when verdict is not_a_fit, surface the hard-fail params
        // as small red pills so the user instantly sees WHY (location? visa?).
        const pillsEl = _shadowRoot.querySelector('.reject-pills');
        pillsEl.innerHTML = '';
        if (fit.verdict === 'not_a_fit') {
            const hardFails = (fit.parameters || []).filter(p => p.kind === 'hard' && p.status === 'fail');
            for (const p of hardFails) {
                const pill = document.createElement('span');
                pill.className = 'reject-pill';
                pill.textContent = p.label || p.key;
                pill.title = p.reason || '';
                pillsEl.appendChild(pill);
            }
            pillsEl.classList.toggle('hidden', hardFails.length === 0);
        } else {
            pillsEl.classList.add('hidden');
        }

        const weights = { yoe:40, title:25, skills:25, salary:10 };
        const primary = window.QuickApplyFitCardCompact?.pickPrimaryParam?.(fit.parameters, weights);
        const cardEl = _shadowRoot.querySelector('.card');
        const isExpanded = cardEl.classList.contains('expanded');
        if (primary) {
            rowEl.dataset.hasContent = '1';
            if (!isExpanded) rowEl.classList.remove('hidden');
            dotEl.dataset.status = primary.status;
            labelEl.textContent = primary.label;
            reasonEl.textContent = primary.reason || '';
            scoreEl.textContent = primary.score == null ? '—' : `${primary.score}%`;
        } else {
            rowEl.dataset.hasContent = '0';
            rowEl.classList.add('hidden');
        }

        // Populate the full breakdown for click-to-expand.
        const allRowsEl = _shadowRoot.querySelector('.all-rows');
        allRowsEl.innerHTML = '';
        for (const p of fit.parameters) {
            const r = document.createElement('div');
            r.className = 'row' + (p.ignored ? ' ignored' : '');
            r.style.borderTop = '1px solid #E8E4DF';
            const d = document.createElement('span');
            d.className = 'dot'; d.dataset.status = p.status;
            const lr = document.createElement('span');
            lr.className = 'label-and-reason';
            const lbl = document.createElement('span');
            lbl.className = 'label'; lbl.textContent = p.label;
            const rsn = document.createElement('span');
            rsn.className = 'reason'; rsn.textContent = p.reason || '';
            lr.append(lbl, document.createElement('br'), rsn);
            if (p.ignored && p.ignoredReason) {
                const ir = document.createElement('span');
                ir.className = 'ignored-reason';
                ir.textContent = `Ignored: ${p.ignoredReason}`;
                lr.appendChild(ir);
            }
            const sc = document.createElement('span');
            sc.className = 'score';
            sc.textContent = p.score == null ? '—' : `${p.score}%`;
            // Per-row Ignore / Restore link. Enabled on every parameter; user
            // can dismiss any soft (or even hard) signal with a justification.
            const tog = document.createElement('button');
            tog.className = 'ignore-link';
            tog.textContent = p.ignored ? 'Restore' : 'Ignore';
            tog.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (p.ignored) {
                    await _saveOverride(_currentJobKey, p.key, null);
                } else {
                    const why = prompt(`Why ignore the "${p.label}" parameter for this job?`, '');
                    if (why == null) return;
                    await _saveOverride(_currentJobKey, p.key, { ignored: true, justification: why.trim(), at: Date.now() });
                }
                _refresh(_currentJobKey);
            });
            sc.appendChild(tog);
            r.append(d, lr, sc);
            allRowsEl.appendChild(r);
        }
        if (!isExpanded) allRowsEl.classList.add('hidden');

        // AI consider-anyway hint: surfaces when there's a client-target ↔ JD
        // seniority mismatch but the CV still supports applying. fit.considerAnyway
        // is set by fit-matcher from the AI's batched response (ai-engine).
        const aiEl = _shadowRoot.querySelector('.ai-suggest');
        if (fit.considerAnyway && fit.considerAnywayReason) {
            aiEl.innerHTML = `<b>AI suggests:</b> consider applying — ${escapeHtml(fit.considerAnywayReason)}`;
            aiEl.classList.remove('hidden');
        } else if (fit.considerAnyway === false && fit.considerAnywayReason) {
            aiEl.innerHTML = `<b>AI suggests:</b> skip — ${escapeHtml(fit.considerAnywayReason)}`;
            aiEl.classList.remove('hidden');
        } else {
            aiEl.classList.add('hidden');
        }

        // Gap summary: one-line "what's missing" rendered under the breakdown.
        // Built from hard fails (not ignored) + missing skills + low soft scores.
        const gapEl = _shadowRoot.querySelector('.gap-summary');
        const gapText = _buildGapSummary(fit);
        if (gapText) { gapEl.innerHTML = `<b>Gaps:</b> ${gapText}`; gapEl.classList.remove('hidden'); }
        else gapEl.classList.add('hidden');
    }
    function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

    async function _refresh(jobKey) {
        if (!jobKey) { LOG('refresh skip: no jobKey'); return; }
        if (_hidden) { LOG('refresh skip: hidden'); return; }
        _currentJobKey = jobKey;

        let settings = {};
        try { settings = await window.QuickApplyStorage.getSettings(); }
        catch (e) { LOG('refresh skip: getSettings threw', e); return; }
        if (settings.showMiniCard === false) { LOG('refresh skip: showMiniCard=false'); return; }
        _fitWeights = settings.fitWeights || null;

        try {
            if (await window.QuickApplyMiniCardDismissals.isDismissed(location.host, jobKey)) {
                LOG('refresh skip: job dismissed'); return;
            }
        } catch (e) { LOG('dismissal check threw', e); }

        const data = await new Promise(resolve => chrome.storage.local.get('activeClientId', resolve));
        const activeId = data?.activeClientId;
        if (!activeId) { LOG('refresh skip: no activeClientId'); return; }

        const profile = await window.QuickApplyStorage.getClientById(activeId);
        if (!profile) { LOG('refresh skip: profile missing for', activeId); return; }

        const jd = await window.QuickApplyJdCache.get(jobKey);
        if (!jd) { LOG('refresh skip: no JD for', jobKey); return; }

        let fit;
        try {
            fit = await window.QuickApplyFitMatcher.scoreWithAi(jd, profile, settings);
        } catch (e) { LOG('scoreWithAi threw', e); return; }
        if (!fit) { LOG('refresh skip: scoreWithAi returned null'); return; }

        _showOrUpdate(fit, jd);
    }

    document.addEventListener('quickapply:jd-extracted', (e) => {
        const jobKey = e?.detail?.jobKey;
        if (!jobKey) return;
        _refresh(jobKey);
    });

    // Re-score when the active client switches, the client's data is edited
    // (dashboard Save), or the fit weights change — otherwise the mini-card shows
    // the previous client's / pre-edit score until the page is reloaded. Debounced
    // so the many quickapply_clients writes during a fill don't thrash recompute.
    let _scTimer = null;
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (!(changes.activeClientId || changes.quickapply_clients || changes.quickapply_settings)) return;
            if (!_currentJobKey) return;
            clearTimeout(_scTimer);
            _scTimer = setTimeout(() => { if (_currentJobKey) _refresh(_currentJobKey); }, 600);
        });
    } catch (_) {}

    // Public API for shortcut handlers in content.js (Task 10) and the future
    // dashboard "show again" button. Exposed here, not on a window.X namespace
    // since content.js can call functions from the same isolated world.
    window.QuickApplyMiniCard = {
        toggle() {
            if (_hidden) {
                _hidden = false;
                if (_currentJobKey) _refresh(_currentJobKey);
            } else {
                _hideHard();
            }
        },
        forceShow() {
            _hidden = false;
            if (_currentJobKey) _refresh(_currentJobKey);
        },
        forceRefresh(jobKey) {
            const k = jobKey || _currentJobKey;
            if (k) _refresh(k);
        }
    };
})();
