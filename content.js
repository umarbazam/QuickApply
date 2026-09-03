/**
 * QuickApply — Content Script (Auto-Fill Engine)
 * Injected into every page. Listens for messages, fills forms, shows highlights.
 * Reference: ARCHITECTURE.md § 4, DATA_SCHEMA.md § 2, UI_SPEC.md § 5
 */

(function () {
    'use strict';

    // Build marker — confirms WHICH copy of the extension Chrome is running.
    // If you don't see this line in the job page's console after reloading the
    // extension, Chrome is loading a different/stale folder.
    if (window.top === window) console.log('[QuickApply] build=multifill-fix-2026-06-09j (Dayforce JD: DOM-first, placeholder guard)');

    // ── Page-console debug-flag bridge ────────────────────────────────────────
    // chrome.storage isn't reachable from the page's main world, so users can't
    // toggle the verbose fill trace from the application's DevTools console.
    // Listen on document.documentElement for a 'quickapply-debug' CustomEvent —
    // event.detail === true|false sets quickapply_debug in storage and prints
    // confirmation. From the page console, run:
    //   document.documentElement.dispatchEvent(new CustomEvent('quickapply-debug', { detail: true }))
    document.documentElement.addEventListener('quickapply-debug', (e) => {
        const on = !!(e && e.detail);
        try {
            chrome.storage.local.set({ quickapply_debug: on }).then(() => {
                console.log(`[QuickApply] verbose fill trace ${on ? 'ON' : 'OFF'} — reload the tab so the next fill picks it up.`);
            });
        } catch (err) {
            console.warn('[QuickApply] failed to set quickapply_debug:', err && err.message);
        }
    }, false);

    // C2 FIX: bail immediately on CAPTCHA, video embeds, and Google API proxy iframes.
    // These are never real application forms — running on them wastes cycles and pollutes the log.
    const _BLOCKED_HOSTS = new Set([
        'recaptcha.net', 'www.recaptcha.net',
        'hcaptcha.com', 'newassets.hcaptcha.com',
        'youtube.com', 'www.youtube.com', 'youtu.be',
        'tiktok.com', 'www.tiktok.com',
        'content.googleapis.com',
        'accounts.google.com',
        'applyall.com',
        'wonsulting.activehosted.com',
        'chat.google.com',
        'staticxx.facebook.com',
        // Webmail — extension must never fill email client pages
        'mail.google.com',
        'outlook.live.com',
        'outlook.office.com',
        'outlook.office365.com',
        'mail.yahoo.com',
        // Tag managers and interactive content platforms — never ATS forms
        'googletagmanager.com',
        'www.googletagmanager.com',
        'ceros.com',
        'www.ceros.com',
        'view.ceros.com',
        // AI assistants and search — confirmed 3-5 accidental fills from learning data
        'claude.ai',
        'www.google.com',
        'calendar.google.com',
        'meet.google.com',
        'wonsulting.activehosted.com',
        'google.com',
        // Ad/analytics trackers — confirmed fills polluting learning data
        'insight.adsrvr.org',
        'analytics.o11.tech',
        'i.liadm.com',
        'jsv3.recruitics.com',
        'nytrng.com',
        'secure-gl.imrworldwide.com',
        'uip.semasio.net',
        'match.sync.ad.cpe.dotomi.com',
        // Chat/CRM widgets — not job forms
        'app.qualified.com'
    ]);
    if (_BLOCKED_HOSTS.has(window.location.hostname)) return;

    // Legacy fill hooks — used by fill-engine.js stubs (combobox/file) until Phase 3 extraction
    window._qaFillComboboxLegacy = null;  // filled in Phase 3 when combobox logic is extracted
    window._qaFillFileLegacy = null;      // filled in Phase 3 when CV upload is extracted

    /**
     * Detect platform from current URL including query params.
     * Overrides 'generic' when Greenhouse embed params (gh_jid, token+for/board) are present.
     * Replaces all direct detectPlatform() calls in content.js.
     */
    function _getPlatform() {
        let p = window.QuickApplyFieldMapper.detectPlatform(window.location.href);
        if (p === 'generic') {
            try {
                const params = new URLSearchParams(window.location.search);
                if (params.has('gh_jid')) p = 'greenhouse';
                else if (params.has('token') && (params.has('for') || params.has('board'))) p = 'greenhouse';
                else if (document.querySelector('[data-id="grnhse_app"], #grnhse_app, #grnhse_iframe, [id^="grnhse_"]')) p = 'greenhouse';
                // Teamtailor: a large share of customers serve the same career
                // site from their own domain (careers.<company>.com), which the
                // URL-only PLATFORM_PATTERNS can't recognise. Fall back to the
                // careersite markup markers.
                else if (document.querySelector('link[href*="teamtailor-cdn.com"], script[src*="teamtailor-cdn.com"], #job-application-form, turbo-frame#application_form')
                         || /careersite--/.test(document.body?.getAttribute('data-controller') || '')) {
                    if (/\/jobs\/\d+/.test(window.location.pathname)) p = 'teamtailor';
                }
            } catch (_) { }
        }
        return p;
    }

    function _hasGreenhouseLaunchOnlyPage() {
        if (window.top !== window) return false;
        const launcher = document.querySelector('[data-id="grnhse_app"]');
        if (!launcher) return false;
        // Only count the actual iframe (or a populated #grnhse_app) as "frame
        // ready". Samsara-style pages ship an empty <div id="grnhse_app"> +
        // <button data-id="grnhse_app"> as the launcher pair; the bare div
        // matched #grnhse_app before the iframe loaded, so launch-only was
        // never detected and the top-frame filler returned 0-fills, which
        // ended the background's frame-poll loop before the iframe appeared.
        const hasApplicationFrame = !!document.querySelector(
            'iframe[src*="job-boards.greenhouse.io"], iframe[src*="greenhouse.io"], iframe#grnhse_iframe, iframe[id^="grnhse_"]'
        );
        if (hasApplicationFrame) return false;
        const hasRealApplicationField = !!document.querySelector(
            [
                'input[name="first_name"]',
                'input[name="last_name"]',
                'input[name="email"]',
                'input[name="phone"]',
                'input[type="file"]',
                'textarea[name*="cover_letter" i]',
                'form[action*="greenhouse" i]'
            ].join(', ')
        );
        return !hasRealApplicationField;
    }

    /**
     * Returns true if a stored correction value is known-bad and should not be
     * replayed. Catches values stored before Session 15: raw checkbox "on",
     * ATS internal numeric IDs (Greenhouse option IDs), and security code fields.
     */
    function _isBadCorrectionValue(value, fieldContext) {
        if (value == null) return false;
        const v = String(value);
        if (v === 'on' || v === 'off') return true;
        // Boolean primitives serialised to strings — usually bad (raw checkbox values, not labels).
        // Exception: Workday boolean radio fields use value="true"/"false" as the actual option values.
        // These field names are camelCase booleans: candidateIsPreviousWorker, isVeteran, hasDisability.
        // Detect by the presence of a camelCase boolean word: (Is|Has|Was|Did|Does|Can|Were|Have) + Capital.
        if (v === 'true' || v === 'false') {
            const looksLikeBooleanField = /(?:Is|Has|Was|Did|Does|Can|Were|Have|Previous|Former|Eligible)[A-Z]/.test(fieldContext || '');
            if (!looksLikeBooleanField) return true;
        }
        if (/^\d{7,}$/.test(v)) return true;
        if (/captcha|security.?code|verification.?code|verify.?human|robot/i.test(fieldContext || '')) return true;
        // Trailing space — indicates a value that was cut off mid-autocomplete
        if (/ $/.test(v)) return true;
        // Dangling preposition/article/conjunction at end — flag up to 80 chars.
        // Catches AI-truncated fragments like "My experience at" or "positioning at ".
        // 80-char cap avoids flagging legitimate free-text that ends mid-sentence.
        if (v.length < 80 && /\s(a|an|the|not|in|of|to|is|are|at|for|with|by|from|as|on|about|and|or|but)$/i.test(v)) return true;
        // Dangling subject+verb with no predicate — e.g. "I am" stored when a dropdown
        // option starts with "I am …" but the full option text was never captured.
        // These match both "I am a veteran" AND "I am not a veteran" equally badly.
        if (/^(I|They|He|She|We) (am|are|was|were|have|had|will|would|can|could|should)$/i.test(v.trim())) return true;
        // Random alphanumeric token — keyboard smash or generated ID accidentally saved as a correction.
        // Pattern: no spaces, mixed case + digit, 8–25 chars, not a recognisable word or year pattern.
        // e.g. "Nofyz4tKbT", "xK9mPqR2wL" — these never map to a real field option.
        if (/^[A-Za-z0-9]{8,25}$/.test(v) && /[0-9]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) &&
            !/^(yes|no|true|false|opt|h1b|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)/i.test(v) &&
            !/20\d\d/.test(v)) return true;
        return false;
    }

    let highlightTimers = [];
    let cssInjected = false;
    let filledFieldsMap = new Map(); // Track filled fields for correction detection (element → info)
    let _filledSelectorMap = new Map(); // SR FIX: selector → info, survives React element replacement
    let currentProfile = null; // Store last used profile for AI Fill Icon
    let _seenFingerprints = new Set(); // fingerprints attempted on this page load; refill passes resolve only NEW ones

    // ═══════════════════════════════════════════════════════════════════
    // CSS INJECTION — Visual highlights from UI_SPEC.md § 5.1
    // ═══════════════════════════════════════════════════════════════════

    function injectCSS() {
        if (cssInjected) return;
        cssInjected = true;

        const style = document.createElement('style');
        style.id = 'quickapply-styles';
        style.textContent = `
      .quickapply-filled {
        outline: 2px solid #34D399 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(52,211,153,0.12), 0 0 16px rgba(52,211,153,0.15) !important;
        transition: all 0.3s cubic-bezier(0.4,0,0.2,1) !important;
      }
      .quickapply-fuzzy {
        outline: 2px solid #FBBF24 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(251,191,36,0.12), 0 0 16px rgba(251,191,36,0.15) !important;
        transition: all 0.3s cubic-bezier(0.4,0,0.2,1) !important;
      }
      .quickapply-error {
        outline: 2px solid #F87171 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(248,113,113,0.12), 0 0 16px rgba(248,113,113,0.15) !important;
        transition: all 0.3s cubic-bezier(0.4,0,0.2,1) !important;
      }
      .quickapply-filled, .quickapply-fuzzy, .quickapply-error {
        animation: quickapply-pulse 0.6s cubic-bezier(0.34,1.56,0.64,1) !important;
      }
      @keyframes quickapply-pulse {
        0%   { outline-offset: 0px; opacity: 0.5; }
        50%  { outline-offset: 4px; opacity: 1; }
        100% { outline-offset: 2px; opacity: 1; }
      }
      .quickapply-dismiss {
        animation: quickapply-fadeout 0.8s cubic-bezier(0.4,0,0.2,1) forwards !important;
      }
      @keyframes quickapply-fadeout {
        to { outline-color: transparent !important; box-shadow: none !important; }
      }
      .quickapply-ai-btn {
        position: fixed !important;
        top: 8px !important;
        left: 8px !important;
        width: 28px !important;
        height: 28px !important;
        background: linear-gradient(135deg, #7C6AFF, #34D399) !important;
        border: none !important;
        border-radius: 50% !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 10000 !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15) !important;
        transition: all 0.2s cubic-bezier(0.4,0,0.2,1) !important;
        padding: 0 !important;
      }
      .quickapply-ai-btn:hover {
        transform: scale(1.1) rotate(5deg) !important;
        box-shadow: 0 4px 12px rgba(124,106,255,0.3) !important;
      }
      .quickapply-ai-btn:active {
        transform: scale(0.95) !important;
      }
      .quickapply-ai-btn svg {
        width: 16px !important;
        height: 16px !important;
        fill: white !important;
      }
      .quickapply-ai-btn.loading {
        animation: quickapply-spin 1s linear infinite !important;
        opacity: 0.7 !important;
        pointer-events: none !important;
      }
      .quickapply-ai-btn.no-cv {
        background: linear-gradient(135deg, #9CA3AF, #6B7280) !important;
        cursor: pointer !important;
        opacity: 0.6 !important;
      }
      .quickapply-ai-btn.no-api {
        background: linear-gradient(135deg, #F97316, #EF4444) !important;
        cursor: pointer !important;
        opacity: 0.75 !important;
      }
      .quickapply-ai-toast {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        background: #1a1a1a !important;
        color: #fff !important;
        font-family: -apple-system, sans-serif !important;
        font-size: 13px !important;
        line-height: 1.45 !important;
        padding: 12px 16px !important;
        border-radius: 8px !important;
        box-shadow: 0 4px 20px rgba(0,0,0,0.35) !important;
        z-index: 2147483647 !important;
        max-width: 320px !important;
        animation: quickapply-toast-in 0.2s ease !important;
      }
      .quickapply-ai-toast.success { border-left: 3px solid #34D399 !important; }
      .quickapply-ai-toast.error   { border-left: 3px solid #EF4444 !important; }
      .quickapply-ai-toast.info    { border-left: 3px solid #7C6AFF !important; }
      @keyframes quickapply-toast-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes quickapply-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .quickapply-hint-btn {
        position: fixed !important;
        width: 22px !important;
        height: 22px !important;
        background: #F97316 !important;
        border: none !important;
        border-radius: 50% !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 10001 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25) !important;
        font-size: 13px !important;
        font-weight: 700 !important;
        color: white !important;
        font-family: sans-serif !important;
        line-height: 1 !important;
        padding: 0 !important;
        transition: transform 0.15s ease !important;
      }
      .quickapply-hint-btn:hover {
        transform: scale(1.15) !important;
      }
      .quickapply-hint-popup {
        position: fixed !important;
        z-index: 10002 !important;
        background: #FFFFFF !important;
        border: 1px solid #E8E4DF !important;
        border-top: 3px solid #E63B2E !important;
        border-radius: 8px !important;
        padding: 14px 16px !important;
        width: 300px !important;
        box-shadow: 0 8px 24px rgba(20,20,20,0.14) !important;
        font-family: system-ui, sans-serif !important;
        color: #141414 !important;
      }
      .quickapply-hint-popup h4 {
        margin: 0 0 8px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        color: #E63B2E !important;
        text-transform: uppercase !important;
        letter-spacing: 0.07em !important;
      }
      .quickapply-hint-popup .qa-hint-detected {
        font-size: 13px !important;
        color: #141414 !important;
        font-weight: 500 !important;
        margin-bottom: 12px !important;
        word-break: break-word !important;
        line-height: 1.45 !important;
        background: #F8F6F3 !important;
        padding: 8px 10px !important;
        border-radius: 5px !important;
        border-left: 3px solid #E8E4DF !important;
      }
      .quickapply-hint-popup .qa-hint-label {
        font-size: 11px !important;
        font-weight: 600 !important;
        color: #6B6560 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.05em !important;
        margin-bottom: 5px !important;
      }
      .quickapply-hint-popup select,
      .quickapply-hint-popup input[type="text"] {
        width: 100% !important;
        background: #FFFFFF !important;
        border: 1px solid #E8E4DF !important;
        border-radius: 5px !important;
        color: #141414 !important;
        font-size: 13px !important;
        padding: 7px 10px !important;
        margin-bottom: 10px !important;
        box-sizing: border-box !important;
        outline: none !important;
        font-family: system-ui, sans-serif !important;
        height: 36px !important;
      }
      .quickapply-hint-popup select:focus,
      .quickapply-hint-popup input[type="text"]:focus {
        border-color: #E63B2E !important;
        box-shadow: 0 0 0 3px rgba(230,59,46,0.08) !important;
      }
      .quickapply-hint-popup .qa-hint-actions {
        display: flex !important;
        gap: 8px !important;
        justify-content: flex-end !important;
        margin-top: 4px !important;
      }
      .quickapply-hint-popup .qa-hint-actions button {
        padding: 6px 14px !important;
        border-radius: 4px !important;
        font-size: 12px !important;
        cursor: pointer !important;
        font-weight: 600 !important;
        font-family: system-ui, sans-serif !important;
      }
      .quickapply-hint-popup .qa-hint-save {
        background: #E63B2E !important;
        color: white !important;
        border: none !important;
      }
      .quickapply-hint-popup .qa-hint-save:hover {
        background: #CC3326 !important;
      }
      .quickapply-hint-popup .qa-hint-skip {
        background: transparent !important;
        color: #A8A29E !important;
        border: 1px solid #E8E4DF !important;
      }
      .quickapply-hint-popup .qa-hint-skip:hover {
        color: #6B6560 !important;
      }
    `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════════
    // MESSAGE LISTENER
    // ═══════════════════════════════════════════════════════════════════

    // ─── INITIALIZATION ───────────────────────────────────────────────
    async function initializeProfile() {
        try {
            const data = await chrome.storage.local.get(['activeClientId', 'quickapply_clients']);
            if (data.activeClientId && data.quickapply_clients) {
                const profile = data.quickapply_clients.find(c => c.id === data.activeClientId);
                if (profile) {
                    currentProfile = profile;
                    injectCSS(); // Ensure styles are injected for icons
                    console.log(`[QuickApply] Active profile loaded: ${profile.fullName}`);
                    injectAIFillIcons();
                    // Retry passes for SPA platforms (Ashby, Workday, etc.) that render
                    // textareas/contenteditable fields well after DOMContentLoaded
                    setTimeout(() => injectAIFillIcons(), 1500);
                    setTimeout(() => injectAIFillIcons(), 3500);
                    setTimeout(() => injectAIFillIcons(), 6000);
                }
            }
        } catch (e) {
            console.error('[QuickApply] Failed to initialize profile:', e);
        }
    }

    // Call on startup
    initializeProfile();

    // Listen for client switches in storage (e.g., from popup)
    chrome.storage.onChanged.addListener((changes, area) => {
        // React to BOTH active-client switches AND edits to the client data
        // (dashboard "Save"). Without quickapply_clients here, editing a client's
        // address / phone / etc. in the dashboard did not refresh an already-open
        // side widget (or currentProfile) until the page was reloaded.
        if (area === 'local' && (changes.activeClientId || changes.quickapply_clients)) {
            initializeProfile();
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        injectCSS();

        switch (message.type) {
            case 'FILL_FORM': {
                const _sentAt = message.payload?._popupSentAt;
                const _hop = _sentAt ? `${Date.now() - _sentAt}ms after popup dispatch` : 'no sentAt';
                console.log(`[QuickApply Timing] content: FILL_FORM received in ${window.top===window?'top frame':'iframe '+location.host} (${_hop})`);
                pendingProfile = message.payload.profile;
                _lastFillPayload = message.payload;
                // Mark a fill in progress so the MutationObserver doesn't fire a
                // concurrent refill while this user-initiated fill is dispatching
                // input/change events (which themselves trip the observer). The
                // observer checks _fillInProgress at line ~4658 and stands down.
                _fillInProgress = true;
                _fillMultiPass(message.payload).then(report => {
                    // Update badge via background
                    chrome.runtime.sendMessage(report).catch(() => { });
                    sendResponse(report);
                }).catch(e => {
                    console.error('[QuickApply] Fill failed:', e);
                    sendResponse({ error: e.message });
                }).finally(() => { _fillInProgress = false; });
                return true; // async
            }

            case 'CLEAR_FORM':
                handleClear();
                sendResponse({ success: true });
                break;

            case 'SCROLL_TO_FIELD':
                handleScroll(message.payload);
                sendResponse({ success: true });
                break;

            case 'GET_PAGE_INFO':
                sendResponse({
                    url: window.location.href,
                    title: document.title,
                    fieldCount: discoverFields(document).length
                });
                break;

            case 'PING':
                sendResponse({ pong: true });
                break;

            case 'GET_FIT_SCORE': {
                (async () => {
                    try {
                        // Popup scoring is user-visible, so force a fresh read of
                        // the current rendered DOM instead of reusing an early SPA
                        // extraction that may have missed Workday details.
                        let jd = await window.QuickApplyJdExtractor?.extract();
                        if (!jd) {
                            const candidates = [
                                window.QuickApplyWorkdayJD,
                                window.QuickApplyAshbyJD,
                                window.QuickApplyRipplingJD,
                                window.QuickApplyWorkableJD,
                                window.QuickApplySmartRecruitersJD,
                                window.QuickApplyBreezyJD,
                                window.QuickApplyLeverJD,
                                window.QuickApplyNetflixJD,
                                window.QuickApplyGreenhouseJD,
                                window.QuickApplyIcimsJD,
                                window.QuickApplyTikTokJD,
                                window.QuickApplyTeamtailorJD
                            ];
                            const adapter = candidates.find(a => { try { return a?.detect?.(); } catch (_) { return false; } });
                            if (adapter) {
                                // Prefer the adapter's standalone jobKey() so wrapper-site
                                // cases (where extract() bails) still resolve from cache via
                                // the iframe's earlier extraction under the same key.
                                let key = null;
                                try { key = adapter.jobKey?.(); } catch (_) {}
                                if (!key) {
                                    try { key = adapter.extract()?.jobKey; } catch (_) {}
                                }
                                if (key) jd = await window.QuickApplyJdCache.get(key);
                            }
                        }
                        if (!jd) {
                            // chrome.tabs.sendMessage broadcasts to ALL frames. If THIS
                            // frame has no JD (wrapper parent on Shopify careers page,
                            // unrelated iframe like a chat widget, etc.), stay silent so
                            // sibling frames with JD data win the response slot. On a
                            // JD-less page no frame responds and the popup's awaited
                            // sendMessage throws, which it already handles in renderFitCard.
                            sendResponse({ jd: null, fit: null, reason: 'no_jd' });
                            return;
                        }

                        const clientId = message.payload?.clientId;
                        const profile = clientId ? await window.QuickApplyStorage.getClientById(clientId) : null;
                        if (!profile) { sendResponse({ jd, fit: null, reason: 'no_client' }); return; }
                        const settings = await window.QuickApplyStorage.getSettings();

                        const fit = await window.QuickApplyFitMatcher.scoreWithAi(jd, profile, settings);
                        sendResponse({
                            jd: { jobKey: jd.jobKey, title: jd.title, platform: jd.platform, company: jd.company },
                            fit,
                            settings
                        });
                    } catch (e) {
                        sendResponse({ jd: null, fit: null, error: String(e?.message || e) });
                    }
                })();
                return true; // async
            }

            case 'FILL_FROM_SHORTCUT': {
                (async () => {
                    try {
                        const data = await new Promise(r => chrome.storage.local.get('activeClientId', r));
                        const clientId = data?.activeClientId;
                        if (!clientId) { sendResponse({ ok: false, reason: 'no_active_client' }); return; }
                        const profile = await window.QuickApplyStorage.getClientById(clientId);
                        if (!profile) { sendResponse({ ok: false, reason: 'profile_missing' }); return; }
                        const settings = await window.QuickApplyStorage.getSettings();
                        // Reuse the FILL_FORM message path so behavior stays consistent
                        // with popup-driven fills (auto-advance, retry-on-no-fields, etc.)
                        chrome.runtime.sendMessage({
                            type: 'FILL_FORM',
                            payload: { profile, settings }
                        }, () => { void chrome.runtime.lastError; });
                        sendResponse({ ok: true });
                    } catch (e) {
                        sendResponse({ ok: false, error: String(e?.message || e) });
                    }
                })();
                return true;
            }

            case 'TOGGLE_MINI_CARD': {
                if (window.QuickApplyMiniCard?.toggle) window.QuickApplyMiniCard.toggle();
                sendResponse({ ok: true });
                break;
            }

            case 'REFRESH_JD': {
                (async () => {
                    try {
                        // Resolve the current jobKey BEFORE eviction so we can target it.
                        // Walk the same adapter list jd-extractor uses, take the first one
                        // that detects, and ask it for a jobKey without forcing a full extract.
                        const candidates = [
                            window.QuickApplyWorkdayJD, window.QuickApplyAshbyJD,
                            window.QuickApplyRipplingJD, window.QuickApplyWorkableJD,
                            window.QuickApplySmartRecruitersJD, window.QuickApplyBreezyJD,
                            window.QuickApplyLeverJD, window.QuickApplyNetflixJD,
                            window.QuickApplyGreenhouseJD, window.QuickApplyIcimsJD,
                            window.QuickApplyTikTokJD, window.QuickApplyTeamtailorJD
                        ];
                        const adapter = candidates.find(a => { try { return a?.detect?.(); } catch (_) { return false; } });
                        let priorKey = null;
                        if (adapter) {
                            try { priorKey = adapter.jobKey?.() || adapter.extract?.()?.jobKey || null; } catch (_) {}
                        }
                        // Evict so the next extract() writes a fresh JdObject instead of merging
                        // into the stale one (the spec calls for "evict, re-extract, refresh").
                        if (priorKey && window.QuickApplyJdCache?.evict) {
                            await window.QuickApplyJdCache.evict(priorKey);
                        }
                        // jd-extractor maintains a per-frame _lastUrl dedup that would block a
                        // same-URL re-run. Calling extract() directly bypasses it (vs. maybeExtract).
                        const jd = await window.QuickApplyJdExtractor?.extract();
                        if (jd && window.QuickApplyMiniCard?.forceRefresh) {
                            window.QuickApplyMiniCard.forceRefresh(jd.jobKey);
                        }
                        sendResponse({ ok: true, jobKey: jd?.jobKey || null });
                    } catch (e) {
                        sendResponse({ ok: false, error: String(e?.message || e) });
                    }
                })();
                return true;
            }
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    // FILL HANDLER
    // ═══════════════════════════════════════════════════════════════════

    // Build a concise profile summary string for AI normalization prompts.
    // H1 FIX: Added salary, currency, notice period, job title, company, skills —
    // previously missing so AI couldn't normalize salary-range or notice-period dropdowns.
    function buildProfileContext(profile) {
        const fields = [
            // Professional identity — needed for seniority/title dropdowns
            ['Current Job Title', profile.currentJobTitle],
            ['Current Company', profile.currentCompany],
            ['Years of Experience', profile.yearsOfExperience],
            // Compensation — needed for salary-range dropdowns
            ['Expected Salary', profile.expectedSalary],
            ['Salary Currency', profile.salaryCurrency],
            // Availability — needed for notice-period dropdowns
            ['Notice Period', profile.noticePeriod],
            ['Available Start Date', profile.desiredStartDate],
            // Work preferences — needed for type/remote/relocation dropdowns
            ['Work Authorization', profile.workAuthorization],
            ['Live in US', profile.liveInUS],
            ['Willing to Relocate', profile.willingToRelocate],
            ['Desired Employment Type', profile.desiredEmploymentType],
            ['Remote Preference', profile.remotePreference],
            // Employment status
            ['Currently Employed', profile.currentlyEmployed],
            ['Non-Compete', profile.nonCompete],
            ['Security Clearance', profile.securityClearance],
            // Education
            ['Highest Education', profile.highestEducation],
            ['University', profile.university],
            ['Major', profile.major],
            ['Graduation Year', profile.graduationYear],
            // EEO / legal
            ['Veteran Status', profile.veteranStatus],
            ['Disability Status', profile.disabilityStatus],
            ['Gender', profile.gender],
            ['Pronouns', profile.pronouns],
            ['Ethnicity', profile.ethnicity],
            ['Hispanic / Latino', profile.hispanicLatino],
            ['Transgender', profile.transgender],
            ['Sexual Orientation', profile.sexualOrientation],
        ];
        return fields
            .filter(([, v]) => v && String(v).trim())
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
    }

    /**
     * Scrape company name, job title, and job description from the current page.
     * Used to give the AI context for tailored answers ("Why this company?" etc.)
     */
    function scrapeJobContext() {
        try {
            let companyName = '', jobTitle = '', jobDescription = '';

            // ── JSON-LD structured data (most reliable) ──────────────────────
            try {
                const lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                for (const ld of lds) {
                    const d = JSON.parse(ld.textContent || '{}');
                    const posting = Array.isArray(d['@graph'])
                        ? d['@graph'].find(n => n['@type'] === 'JobPosting')
                        : d['@type'] === 'JobPosting' ? d : null;
                    if (posting) {
                        jobTitle = jobTitle || posting.title || '';
                        companyName = companyName || posting.hiringOrganization?.name || posting.employer?.name || '';
                        jobDescription = jobDescription || (posting.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
                        break;
                    }
                }
            } catch (_) { }

            // ── Open Graph / meta fallbacks ───────────────────────────────────
            if (!companyName) companyName = document.querySelector('meta[property="og:site_name"]')?.content || '';
            if (!jobTitle) jobTitle = document.querySelector('meta[property="og:title"]')?.content?.split(/\s+[-–|]\s+/)[0]?.trim() || '';

            // ── ATS-specific selectors ────────────────────────────────────────
            if (!jobTitle) jobTitle = document.querySelector('[class*="job-title"],[class*="position-title"],[data-automation-id*="jobTitle"],[itemprop="title"],[class*="jobTitle"]')?.textContent?.trim() || '';
            if (!companyName) companyName = document.querySelector('[class*="company-name"],[class*="employer-name"],[data-automation-id*="companyName"],[itemprop="name"]')?.textContent?.trim() || '';

            // ── H1 / page title last resort ───────────────────────────────────
            if (!jobTitle) jobTitle = document.querySelector('h1')?.textContent?.trim() || '';
            if (!companyName) {
                const m = document.title.match(/\bat\s+(.+?)(?:\s*[-–|]|$)/i);
                if (m) companyName = m[1].trim();
            }
            if (!companyName) {
                const path = location.pathname || '';
                let slug = '';
                if (/ashbyhq\.com$/i.test(location.hostname)) {
                    const m = path.match(/^\/([^\/]+)\/[0-9a-f-]{20,}/i);
                    if (m) slug = m[1];
                } else if (/workable\.com$/i.test(location.hostname)) {
                    const m = path.match(/^\/([^\/]+)\/j\/[^\/]+/i);
                    if (m) slug = m[1];
                } else if (/greenhouse\.io$/i.test(location.hostname)) {
                    const m = path.match(/^\/([^\/]+)\/(?:jobs|job|apply)\/?/i);
                    if (m) slug = m[1];
                }
                if (slug && !/^(jobs?|careers?|apply)$/i.test(slug)) {
                    companyName = slug
                        .split(/[-_]+/)
                        .filter(Boolean)
                        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                        .join(' ');
                }
            }
            if (!jobTitle && document.title) jobTitle = document.title.split(/\s+at\s+|\s*[-–|]\s*/)[0].trim();

            // ── Job description ───────────────────────────────────────────────
            if (!jobDescription) {
                const descEl = document.querySelector(
                    '[class*="job-description"],[class*="jobDescription"],[class*="job-details"],[class*="description__text"],' +
                    '[itemprop="description"],[data-automation-id="jobPostingDescription"],[class*="job_desc"],[class*="vacancy-description"],' +
                    '#content,[data-mapped="content"],#app_body,.app-body,.opening'
                );
                if (descEl) {
                    jobDescription = descEl.textContent.replace(/\s+/g, ' ').trim();
                    const markers = ['Create a Job Alert', 'Apply for this job * indicates', 'Autofill with MyGreenhouse', 'Voluntary Self-Identification'];
                    let cutAt = jobDescription.length;
                    for (const marker of markers) {
                        const idx = jobDescription.toLowerCase().indexOf(marker.toLowerCase());
                        if (idx > 1000 && idx < cutAt) cutAt = idx;
                    }
                    jobDescription = jobDescription.slice(0, cutAt).trim().substring(0, 5000);
                }
            }

            return {
                companyName: companyName.substring(0, 120).trim(),
                jobTitle: jobTitle.substring(0, 200).trim(),
                jobDescription
            };
        } catch (_) {
            return { companyName: '', jobTitle: '', jobDescription: '' };
        }
    }

    // True when a discovered field already holds a value, so a refill pass can skip
    // it instead of re-resolving + re-filling the whole static form. Only the field
    // TYPES whose re-fill is wasteful/visible are checked (text, date, select,
    // combobox); checkbox/radio/file are cheap or answer-dependent and never skipped.
    function _ruleSatisfied(rule) {
        try {
            let el = rule.element;
            if (!el || !el.isConnected) el = rule.selector ? document.querySelector(rule.selector) : el;
            if (!el) return false; // can't locate it → don't skip, let the fill try
            switch (rule.type) {
                case 'text':
                case 'date':
                    return typeof el.value === 'string' && el.value.trim() !== '';
                case 'select':
                    return el.selectedIndex > 0 && !!String(el.value || '').trim();
                case 'combobox': {
                    if (typeof el.value === 'string' && el.value.trim() !== '') return true;
                    const sc = el.closest('[class*="select__control"]') || el.closest('[class*="select-shell"]') || el.parentElement?.parentElement;
                    const shown = sc?.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
                    return !!(shown && (shown.textContent || '').trim());
                }
                default:
                    return false;
            }
        } catch (_) { return false; }
    }

    async function handleFill(payload) {
        const _fillT0 = performance.now();
        // Wall-clock (HH:MM:SS.mmm) + elapsed-since-this-pass-start, so the log shows
        // both the real time of day and how long each phase takes.
        const _ts = () => {
            const d = new Date();
            const clock = d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            return `${clock} T+${((performance.now() - _fillT0) / 1000).toFixed(3)}s`;
        };
        console.log(`[QuickApply Timing] ${_ts()}  content: handleFill START`);
        const profile = payload.profile;
        currentProfile = profile; // Save for AI Fill Icon
        const settings = payload.settings || {};

        // Inject progress overlay (shadow DOM widget, bottom-right corner)
        injectProgressOverlay();
        const skipCV = payload.skipCV === true; // true for MutationObserver re-fills
        const fillDelay = settings.fillDelay || 50;
        const highlightDuration = settings.highlightDuration || 10;
        const profileContext = buildProfileContext(profile);

        // Detect platform (B6: uses _getPlatform() to catch gh_jid-embedded Greenhouse)
        const platform = _getPlatform();
        const domain = new URL(window.location.href).hostname;

        // SESSION RECORDER: start a new session on first fill (no-op if already recording)
        if (window.__qa_startSession) window.__qa_startSession(profile, platform);

        // ── DUPLICATE-APPLICATION CHECK ─────────────────────────────────────
        // Extract a stable jobKey from the JD adapter (workday-jd, greenhouse-jd, …)
        // or fall back to a canonicalized URL when no adapter matches. Then look up
        // quickapply_applied_jobs[`${clientId}::${jobKey}`]. If present and the popup
        // did not explicitly set skipDuplicateCheck, bail out early so the popup can
        // ask the user "Already applied — fill anyway?".
        let _jobKey = null;
        let _jobMeta = { title: '', company: '', platform };
        try {
            const _jd = await (window.QuickApplyJdExtractor?.extract?.() || Promise.resolve(null));
            if (_jd && _jd.jobKey) {
                _jobKey = _jd.jobKey;
                _jobMeta = { title: _jd.title || '', company: _jd.company || '', platform: _jd.platform || platform };
            }
        } catch (_) {}
        if (!_jobKey) {
            // URL fallback: lowercase host, strip query + hash + trailing slash.
            try {
                const _u = new URL(window.location.href);
                _jobKey = `${_u.host.toLowerCase()}${_u.pathname.replace(/\/+$/, '')}`;
            } catch (_) { _jobKey = window.location.href; }
        }
        const _dedupKey = `${profile.id || 'default'}::${_jobKey}`;
        console.log('[QuickApply Dedup] check', { dedupKey: _dedupKey, skipDuplicateCheck: !!payload.skipDuplicateCheck, jobKey: _jobKey, clientId: profile.id });
        if (!payload.skipDuplicateCheck) {
            try {
                const _store = await new Promise(r => chrome.storage.local.get('quickapply_applied_jobs', r));
                const _indexSnapshot = _store?.quickapply_applied_jobs || {};
                const _prior = _indexSnapshot[_dedupKey];
                console.log('[QuickApply Dedup] storage read', { indexSize: Object.keys(_indexSnapshot).length, allKeys: Object.keys(_indexSnapshot), foundPrior: !!_prior, prior: _prior });
                if (_prior) {
                    try {
                        const _when = _prior.lastAppliedAt
                            ? new Date(_prior.lastAppliedAt).toLocaleDateString()
                            : 'previously';
                        showPageToast(`Already applied to this job on ${_when}.`, 'info', 5000);
                    } catch (_) {}
                    // Workday: one jobKey spans every step (same URL throughout) — warn
                    // but continue filling so the user doesn't need to click twice per step.
                    if (platform !== 'workday') {
                        return {
                            type: 'FILL_REPORT',
                            payload: {
                                duplicate: true,
                                jobKey: _jobKey,
                                dedupKey: _dedupKey,
                                url: window.location.href,
                                platform: _jobMeta.platform,
                                title: _jobMeta.title || _prior.title || '',
                                company: _jobMeta.company || _prior.company || '',
                                clientId: profile.id,
                                clientName: profile.fullName || '',
                                firstAppliedAt: _prior.firstAppliedAt,
                                lastAppliedAt: _prior.lastAppliedAt,
                                count: _prior.count || 1
                            }
                        };
                    }
                }
            } catch (_) {}
        }
        // Expose to outer scope so the FILL_REPORT emitted at the end can carry the jobKey
        // for background.js to upsert into the dedup index.
        const _qaJobKey = _jobKey;
        const _qaJobMeta = _jobMeta;

        console.log(`[QuickApply Timing] ${_ts()}  content: platform=${platform} domain=${domain} → loading corrections/platformMappings`);
        // ── INTELLIGENCE: Load corrections + platform knowledge ──
        let corrections = [];
        let platformMappings = {};
        if (typeof QuickApplyLearning !== 'undefined') {
            try {
                corrections = await QuickApplyLearning.getCorrections(platform, domain, profile.id);
                platformMappings = await QuickApplyLearning.getPlatformMappings(domain);
            } catch (e) { /* Learning engine may not be available */ }
        }
        console.log(`[QuickApply Timing] ${_ts()}  content: corrections loaded (${corrections.length} corrections, ${Object.keys(platformMappings).length} mappings)`);

        // Create platform filler (handles preFill, discoverFields, postFill per ATS)
        const filler = window.QuickApplyFillerFactory
            ? window.QuickApplyFillerFactory.create(platform, profile, settings)
            : null;

        // Run preFill (expand sections, wait for SPA render)
        if (filler) {
            console.log(`[QuickApply Timing] ${_ts()}  content: filler.preFill() START (this is usually where SPA wait happens)`);
            await filler.preFill();
            console.log(`[QuickApply Timing] ${_ts()}  content: filler.preFill() END`);
            if (platform === 'greenhouse' && _hasGreenhouseLaunchOnlyPage()) {
                return { error: 'Application frame not ready' };
            }
        } else {
            // Legacy fallback: SPA wait
            const SPA_PLATFORMS = new Set(['workday', 'workable', 'icims', 'ashby', 'careerpuck', 'greenhouse', 'dayforce']);
            if (SPA_PLATFORMS.has(platform)) {
                console.log(`[QuickApply Timing] ${_ts()}  content: legacy waitForFields START (up to 6s)`);
                const ready = await waitForFields(6000, 300);
                console.log(`[QuickApply Timing] ${_ts()}  content: legacy waitForFields END (ready=${ready})`);
                if (!ready) {
                    const labels = { workday: 'Workday', workable: 'Workable', icims: 'iCIMS', ashby: 'Ashby', careerpuck: 'CareerPuck', greenhouse: 'Greenhouse' };
                    showPageToast(`${labels[platform] || platform} form not detected. Scroll to the form and try again.`, 'info', 5000);
                }
            }
        }

        // ── AUTO-SUBMIT PATH (multi-step fill + optional submission) ──────────────
        // Use submit engine when autoSubmit is enabled in settings. The engine handles
        // its own discovery+fill loop across all form steps, then clicks Submit.
        if (settings.autoSubmit && window.QuickApplySubmitEngine && filler) {
            const _aiInst = window.QuickApplyAI || null;
            if (_aiInst) await _aiInst.init().catch(() => {});

            // Upload CV before filling — ATS parsers (Lever, Ashby, etc.) pre-fill
            // form fields from the PDF, which our field fill then corrects/completes.
            // Must happen first so the DOM settles before discoverFields() runs.
            if (profile.cvData && profile.cvFileName) {
                try { await handleCVUpload(profile); } catch (_) {}
            }

            const _submitResult = await window.QuickApplySubmitEngine.run(
                filler,
                profile,
                profile.resumeText || profile.cvText || '',
                profile.id || 'default',
                { autoAdvanceSteps: settings.autoAdvanceSteps !== false, autoSubmit: true },
                _aiInst,
                (msg, type) => showPageToast(msg, type || 'info', 4000)
            );
            return {
                type: 'FILL_REPORT',
                payload: {
                    results: [],
                    summary: { total: 0, filled: _submitResult?.totalFilled || 0, fuzzy: 0, error: 0, skipped: 0 },
                    platform,
                    clientId: profile.id || null,
                    url: window.location.href,
                    timestamp: new Date().toISOString(),
                    jobKey: _qaJobKey,
                    submitResult: _submitResult
                }
            };
        }
        // ── END AUTO-SUBMIT PATH ──────────────────────────────────────────────────

        // ── BATCH AI RESOLUTION (new precision path) ──────────────────────────────
        // Discover all fields at once, resolve answers via Tier 1/2/3, fill in batch.
        // Falls back to legacy field-by-field path if resolver fails.
        // On Workday, only fire Gemini on the "Application Questions" step.
        // All other steps (My Information, My Experience, Voluntary Disclosures, Review)
        // are filled with T1+T2 (profile direct + fingerprint cache) only.
        const _wdT1Only = platform === 'workday' && (() => {
            try {
                const _step = (window.QuickApplyWorkdayHelpers?.getWorkdayCurrentStepName?.() || '').toLowerCase();
                return !!_step && !/application.{0,10}question/i.test(_step);
            } catch (_) { return false; }
        })();
        const _jobContext = scrapeJobContext();
        let _batchAnswers = null;
        if (window.QuickApplyFieldDiscoverer && window.QuickApplyAIResolver && window.QuickApplyFillEngine) {
            try {
                console.log(`[QuickApply Timing] ${_ts()}  content: discoverFields START`);
                let _batchRules = filler
                    ? await filler.discoverFields()
                    : window.QuickApplyFieldDiscoverer.scan(document, platform);
                console.log(`[QuickApply Timing] ${_ts()}  content: discoverFields END (${_batchRules.length} fields)`);

                // Fill Missing: restrict to only the specific fields that errored last fill.
                if (payload.onlyFingerprints?.size > 0) {
                    _batchRules = _batchRules.filter(r => payload.onlyFingerprints.has(r.fingerprint));
                    console.log(`[QuickApply] Fill Missing: targeting ${_batchRules.length} field(s)`);
                }

                // A fresh fill (not a refill) resets the "seen" set — every field on
                // this page load is recorded so later refill passes can tell which
                // fields are genuinely NEW vs already-attempted.
                if (!payload.skipCV) {
                    _seenFingerprints = new Set(_batchRules.map(r => r.fingerprint));
                }

                // On a refill pass (skipCV), the form was already filled on the first
                // pass. The multipass / observer re-fills exist ONLY to catch fields
                // that rendered LATE. Resolve only fields that are (a) not already
                // filled in the DOM AND (b) a fingerprint we have NEVER attempted.
                // Re-resolving a field seen on an earlier pass is pure waste — that was
                // the ~20s Gemini call on a radio/checkbox _ruleSatisfied can't read,
                // which returned 0 answers and filled nothing. Static forms now make a
                // refill a true no-op (no Gemini, no re-fill); only late-rendered new
                // fields trigger work.
                if (payload.skipCV) {
                    const _allRules = _batchRules;
                    const _unsatisfied = _allRules.filter(r => !_ruleSatisfied(r));
                    _batchRules = _unsatisfied.filter(r => !_seenFingerprints.has(r.fingerprint));
                    for (const r of _allRules) _seenFingerprints.add(r.fingerprint);
                    const _skipped = _allRules.length - _batchRules.length;
                    if (_skipped > 0) console.log(`[QuickApply Timing] ${_ts()}  content: refill — skipping ${_skipped}/${_allRules.length} (already filled or already attempted)`);
                    if (_batchRules.length === 0) {
                        // Nothing new/empty to fill. Return WITHOUT falling through to
                        // the legacy full-form path (which would re-fill everything).
                        // _noNewFields tells _fillMultiPass to stop the loop early.
                        // Still bump the fill guards so the MutationObserver's runaway
                        // cap (_fillCount >= 3 at ~line 4728) engages — otherwise the
                        // early-return skips the counter and the observer keeps firing
                        // refills on every DOM mutation within its 30s window.
                        _lastFillTime = Date.now();
                        _fillCount++;
                        console.log(`[QuickApply Timing] ${_ts()}  content: refill — no new/empty fields, stopping`);
                        return { type: 'FILL_REPORT', payload: {
                            results: [],
                            summary: { total: _allRules.length, filled: 0, fuzzy: 0, error: 0, skipped: _allRules.length },
                            platform, clientId: profile.id || null, url: window.location.href,
                            timestamp: new Date().toISOString(), jobKey: _qaJobKey, _noNewFields: true,
                        } };
                    }
                }
                // QuickApplyAI reads its API key from storage via init() — no key arg in constructor
                let _aiInstance = null;
                if (settings.geminiApiKey !== false && window.QuickApplyAI && !_wdT1Only) {
                    _aiInstance = window.QuickApplyAI;
                    await _aiInstance.init().catch(() => { _aiInstance = null; });
                }

                // Extract resume text from profile (existing cv-parser result stored in profile.resumeText)
                const _resumeText = profile.resumeText || profile.cvText || '';

                // ── L1 FIX: Tier 0 — pre-apply corrections + platform-learned mappings ──
                // Corrections have highest priority (the user explicitly said "this is wrong").
                // Platform-learned mappings (from recordFillResult) are trusted at 0.95.
                // Pre-computing answers here avoids sending already-known fields to Gemini.
                // Opaque field names (Ashby UUIDs, Greenhouse EEO IDs) are matched by
                // _effectiveFieldKey (the stable contextLabel) instead of the per-posting ID.
                const _preAnswers = new Map(); // fingerprint → answer
                if (corrections.length > 0 || Object.keys(platformMappings).length > 0) {
                    for (const _r of _batchRules) {
                        const _el = _r.element;
                        if (!_el) continue;
                        const _name = _el.getAttribute?.('name') || _el.id || '';
                        const _sel = buildSelector(_el);
                        // Use the shared resolveFieldIdentity helper from learning-engine so
                        // opaque-ID detection stays in one place (no local regex to drift).
                        const { effectiveKey: _effKey } = typeof QuickApplyLearning !== 'undefined'
                            ? QuickApplyLearning.resolveFieldIdentity(_name, _r.label)
                            : { effectiveKey: _name };
                        // Correction: selector > fieldName > effective key (opaque labels)
                        const _corr = corrections.find(c =>
                            c.fieldSelector === _sel ||
                            (c.fieldName && c.fieldName === _name) ||
                            (c._effectiveFieldKey && _effKey && c._effectiveFieldKey === _effKey)
                        );
                        const _corrCtx = (_name || '') + ' ' + (_r.label || '');
                        if (_corr && !_isBadCorrectionValue(_corr.correctedValue, _corrCtx)) {
                            _preAnswers.set(_r.fingerprint, _corr.correctedValue);
                            continue;
                        }
                        // Platform-learned mapping: look up profileField → profile value
                        const _normName = _name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);
                        const _learnedField = platformMappings[_normName] || platformMappings[_name];
                        if (_learnedField) {
                            const _learnedVal = profile[_learnedField];
                            if (_learnedVal != null && String(_learnedVal).trim() !== '') {
                                _preAnswers.set(_r.fingerprint, String(_learnedVal));
                            }
                        }
                    }
                }
                // Only send un-pre-answered fields to the AI resolver (saves API tokens)
                const _rulesForAI = _preAnswers.size > 0
                    ? _batchRules.filter(r => !_preAnswers.has(r.fingerprint))
                    : _batchRules;
                if (_preAnswers.size > 0) {
                    console.log(`[QuickApply] Tier-0: ${_preAnswers.size} field(s) pre-answered from corrections/platform knowledge`);
                }

                console.log(`[QuickApply Timing] ${_ts()}  content: AIResolver.resolveBatch START (likely culprit if it stalls — Gemini API calls)`);
                _batchAnswers = await window.QuickApplyAIResolver.resolveBatch(
                    _rulesForAI,
                    profile,
                    _resumeText,
                    profile.id || 'default',
                    _aiInstance,
                    _jobContext,
                    { forceAI: !!settings.forceAI },
                    filler
                );
                console.log(`[QuickApply Timing] ${_ts()}  content: AIResolver.resolveBatch END (${_batchAnswers?.size||0} answers)`);
                // Merge Tier-0 answers — corrections override any AI answer for same field
                for (const [_fp, _ans] of _preAnswers) _batchAnswers.set(_fp, _ans);

                // Fill all fields with batch answers
                // filledSelectors: fresh Set per handleFill call (single-step standalone path).
                // The submit engine (Task 11) manages its own cross-step Set for multi-step forms.
                const _tracker = window.QuickApplyProgressTracker
                    ? new window.QuickApplyProgressTracker(_batchRules.filter(r => r.required).length, profile.id || 'default')
                    : null;
                console.log(`[QuickApply Timing] ${_ts()}  content: FillEngine.fillAll START — form filling begins now`);
                const { count: _filledCount, results: _fillResults } = await window.QuickApplyFillEngine.fillAll(
                    _batchRules,
                    _batchAnswers,
                    { filledSelectors: new Set(), skipFocus: filler?.getQuirks?.().skipFocus ?? false, tracker: _tracker }
                );
                console.log(`[QuickApply Timing] ${_ts()}  content: FillEngine.fillAll END (${_filledCount} filled)`);
                // Emit the FILL_END line with unfilled-question option dump when the
                // user has flipped chrome.storage.local.quickapply_debug = true.
                try { _tracker?.finalize?.(_batchRules, _batchAnswers); } catch (_) {}

                // Dedup write FROM CONTENT (defense-in-depth) — same upsert background does
                // on FILL_REPORT, but executed here so it doesn't depend on the MV3 service
                // worker being alive when FILL_REPORT arrives. The background still runs the
                // same write on FILL_REPORT receipt; both are idempotent (same key, same data).
                if (_filledCount > 0 && _qaJobKey && profile.id) {
                    try {
                        const _ddata = await new Promise(r => chrome.storage.local.get('quickapply_applied_jobs', r));
                        const _didx = _ddata.quickapply_applied_jobs || {};
                        const _dk = `${profile.id}::${_qaJobKey}`;
                        const _dnow = new Date().toISOString();
                        const _dprev = _didx[_dk];
                        _didx[_dk] = {
                            clientId: profile.id,
                            jobKey: _qaJobKey,
                            url: window.location.href,
                            platform: _qaJobMeta.platform || platform,
                            title: _qaJobMeta.title || (_dprev && _dprev.title) || '',
                            company: _qaJobMeta.company || (_dprev && _dprev.company) || '',
                            firstAppliedAt: _dprev?.firstAppliedAt || _dnow,
                            lastAppliedAt: _dnow,
                            count: (_dprev?.count || 0) + 1
                        };
                        await new Promise(r => chrome.storage.local.set({ quickapply_applied_jobs: _didx }, r));
                        // Daily-count write (spec 2026-06-01). Set-semantic
                        // append — re-filling the same job today does not bump
                        // the count. The dedup write above protects against
                        // accidental duplicate fills, this protects the
                        // shift-progress counter.
                        try {
                            const _newCount = await window.QuickApplyStorage.recordDailyFill({
                                clientId: profile.id,
                                jobKey: _qaJobKey,
                                settings
                            });
                            console.log('[QuickApply Daily]', { clientId: profile.id, jobKey: _qaJobKey, newCount: _newCount });
                        } catch (e) {
                            console.warn('[QuickApply Daily] write failed:', e.message);
                        }
                        console.log('[QuickApply Dedup] content wrote entry', { key: _dk, totalEntries: Object.keys(_didx).length });
                    } catch (e) {
                        console.warn('[QuickApply Dedup] content write FAILED:', e.message);
                    }
                }

                // Attach correction listeners to batch-filled fields. Without this the
                // entire correction-learning pipeline is dark on the batch path — user
                // edits to incorrect fills never reach saveCorrection / registerField.
                // ai-resolver stashes _profileField on rules where T1 mapped successfully;
                // T2 (cache) and T3 (AI) hits leave it undefined, which onFieldCorrected
                // handles by treating the field as a custom_label correction.
                for (const _r of _batchRules) {
                    const _ans = _batchAnswers.get(_r.fingerprint);
                    if (_ans == null || _ans === '') continue;
                    const _el = _r.element;
                    if (!_el || !_el.isConnected) continue;
                    const _name = _el.getAttribute?.('name') || _el.id || '';
                    filledFieldsMap.set(_el, {
                        profileField: _r._profileField || null,
                        originalValue: _ans,
                        platform, domain,
                        fieldName: _name,
                        clientId: profile.id,
                        contextLabel: _r.label || null
                    });
                    attachCorrectionListener(_el);
                }

                // ── Feed the learning system from batch fills ─────────────────────────
                // Mirror what the legacy path does (see content.js:1860 area). Without
                // this block the platform-knowledge dict and universal-field-registry
                // never grow from successful batch fills — only corrections and hint-badge
                // saves can update them. After this block, every successful fill teaches
                // the system regardless of which tier resolved each field.
                //
                // GATE: only run when batch actually filled something. If _filledCount === 0
                // the batch falls through to the legacy path below (line 820 early-return is
                // skipped) and legacy will run its own learning hooks. Without this gate we
                // would double-write platformKnowledge/registry/unknownFields entries, AND
                // record false-positive "filled" entries when fillAll failed despite having
                // resolved answers (DOM detached, element disconnected, etc.).
                if (_filledCount > 0 && typeof QuickApplyLearning !== 'undefined') {
                    try {
                        // Per-field registry: only entries where T1 produced a real
                        // profileField. T2/T3 hits have unknown profileField and would
                        // pollute the registry with un-resolvable lookups.
                        for (const _lr of _batchRules) {
                            if (!_batchAnswers.has(_lr.fingerprint)) continue;
                            if (!_lr._profileField) continue;
                            const _lrName = _lr.element?.getAttribute?.('name') || _lr.element?.id || '';
                            if (!_lrName && !_lr.label) continue;
                            QuickApplyLearning.registerField({
                                fieldName: _lrName || _lr.label,
                                label: _lr.label || _lrName,
                                profileField: _lr._profileField,
                                source: 'form_fill',
                                platform
                            }).catch(() => {});
                        }
                        // Domain-level platform knowledge: include ALL fields (filled +
                        // skipped) so fillCount and per-field success ratios stay accurate.
                        // Entries with null profileField are still useful for tracking
                        // which fields exist on the domain across visits.
                        const _learnResults = _batchRules
                            .map(_lr => ({
                                fieldName: _lr._profileField || _lr.label,
                                htmlName: _lr.element?.getAttribute?.('name') || _lr.element?.id || '',
                                contextLabel: _lr.label,
                                profileField: _lr._profileField || null,
                                status: _batchAnswers.has(_lr.fingerprint) ? 'filled' : 'skipped',
                                confidence: 0.85
                            }))
                            .filter(x => x.htmlName || x.fieldName);
                        QuickApplyLearning.recordFillResult(domain, _learnResults).catch(() => {});
                        // Unknown fields: log so the suggestions panel can surface
                        // recurring patterns the user might want to add as custom fields.
                        for (const _lr of _batchRules) {
                            if (_batchAnswers.has(_lr.fingerprint)) continue;
                            const _lrName = _lr.element?.getAttribute?.('name') || _lr.element?.id || '';
                            if (!_lrName && !_lr.label) continue;
                            QuickApplyLearning.logUnknownField({
                                fieldName: _lrName,
                                label: _lr.label,
                                platform
                            }).catch(() => {});
                        }
                    } catch (_lerr) {
                        console.warn('[QuickApply] Learning hooks failed in batch path:', _lerr.message);
                    }
                }

                // Report progress + update overlay
                const _progressData = {
                    filled: _filledCount,
                    total: _batchRules.length,
                    filledLabels: _tracker ? _tracker._filled.slice(-5) : [],
                    missingRequiredLabels: _tracker ? _tracker._errors : [],
                    missingRequiredFingerprints: _batchRules
                        .filter(r => r.required && !_batchAnswers.has(r.fingerprint))
                        .map(r => r.fingerprint).filter(Boolean),
                    required: {
                        filled: _batchRules.filter(r => r.required && _batchAnswers.has(r.fingerprint)).length,
                        total: _batchRules.filter(r => r.required).length
                    },
                    clientId: profile.id,
                };
                chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', ..._progressData }).catch(() => { });
                updateProgressOverlay(_progressData);

                // Show toast with result
                const _req = _batchRules.filter(r => r.required);
                const _reqFilled = _req.filter(r => _batchAnswers.has(r.fingerprint));
                showPageToast(
                    `QuickApply: ${_filledCount} fields filled (${_reqFilled.length}/${_req.length} required)`,
                    'success', 4000
                );

                // Send FILL_REPORT so popup review panel populates (was missing — Bug 2 fix)
                const _fillResultByFp = new Map(_fillResults.map(r => [r.fingerprint, r]));
                const _batchResults = _batchRules.map(r => {
                    const _fr = _fillResultByFp.get(r.fingerprint);
                    return {
                        fieldName: r.label,
                        selector: r.selector,
                        status: _fr?.status ?? 'skipped',
                        value: _fr?.value ?? '',
                        confidence: 0.85,
                    };
                });
                const _batchReport = {
                    type: 'FILL_REPORT',
                    payload: {
                        results: _batchResults,
                        summary: {
                            total: _batchResults.length,
                            filled: _filledCount,
                            fuzzy: 0,
                            error: _batchResults.filter(r => r.status === 'error').length,
                            skipped: _batchResults.filter(r => r.status === 'skipped').length,
                        },
                        platform,
                        clientId: profile.id || null,
                        clientName: (profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim()) || null,
                        url: window.location.href,
                        timestamp: new Date().toISOString(),
                        jobKey: _qaJobKey,
                        jobTitle: _qaJobMeta.title || '',
                        jobCompany: _qaJobMeta.company || '',
                    }
                };
                // Run CV / cover letter / password upload in batch path unconditionally.
                // Previously gated on _filledCount > 0, which meant CV never uploaded when
                // resolver returned 0 answers (no AI key, no profile direct matches) — and
                // _reAssert inside handleCVUpload never ran, leaving ATS-parsed email in place.
                if (!skipCV && profile.cvData && profile.cvFileName) {
                    try { await handleCVUpload(profile); } catch (_) {}
                }
                if (!skipCV && profile.coverLetterData && profile.coverLetterFileName) {
                    try { await handleCoverLetterUpload(profile); } catch (_) {}
                }
                if (profile.defaultPassword) {
                    document.querySelectorAll('input[type="password"]').forEach(pw => {
                        if (!isVisible(pw) || pw.disabled || pw.readOnly || pw.value) return;
                        setReactValue(pw, profile.defaultPassword);
                        dispatchEvents(pw);
                    });
                }

                // Call filler.postFill() — was never called in batch path.
                // AshbyFiller.postFill() sets _cvUploadedThisPageLoad guard and waits for DOM settle.
                // Without this call the re-upload loop guard in ashby.js never activates.
                if (filler) {
                    // Stash the batch results so platform fillers can fill controls the base
                    // engine can't reach (Workday button-dropdowns, date triplets, etc.).
                    filler._lastAnswers = _batchAnswers;
                    filler._lastRules = _batchRules;
                    // Also stash the profile — needed by iCIMS postFill to re-assert
                    // personal-info fields the CV parser overwrites after upload.
                    filler._lastProfile = profile;
                    try { await filler.postFill(); } catch (_) {}

                    // Demote results that postFill could not actually commit.
                    // Platform fillers (Workday, iCIMS) can return false from
                    // their custom handlers (mismatched dropdown option,
                    // isTrusted-gated chip click, bare-month date, CV-parser
                    // overwrote re-asserted email) for rules the fill-engine
                    // had optimistically labeled "filled" based on "answer
                    // exists". Without this pass, the user sees ✓ in the
                    // review panel over fields that are visibly empty. Read
                    // failures from either `_workdayFailedFingerprints` (legacy
                    // name kept for the Workday filler) OR the generalized
                    // `_postFillFailedFingerprints` set; merge both.
                    const failed = new Set([
                        ...(filler._workdayFailedFingerprints || []),
                        ...(filler._postFillFailedFingerprints || [])
                    ]);
                    const succeeded = new Set(filler._postFillSucceededFingerprints || []);
                    if ((failed.size || succeeded.size) && _batchResults && _batchRules) {
                        // Build fingerprint → result-index map for O(n) demotion/promotion
                        const fpToIdx = new Map();
                        for (let i = 0; i < _batchRules.length; i++) {
                            const fp = _batchRules[i]?.fingerprint;
                            if (fp) fpToIdx.set(fp, i);
                        }
                        let demoted = 0;
                        let promoted = 0;
                        for (const fp of failed) {
                            const idx = fpToIdx.get(fp);
                            if (idx == null) continue;
                            const r = _batchResults[idx];
                            if (r && r.status === 'filled') {
                                r.status = 'error';
                                r.confidence = 0.1;
                                r.strategy = 'workday-postfill-failed';
                                demoted++;
                            }
                        }
                        // Promote rules the platform postFill actually committed
                        // but that the engine main pass marked as 'error' (e.g.
                        // Greenhouse react-select committed via trusted CDP click
                        // AFTER the engine's synthetic fallback gave up).
                        for (const fp of succeeded) {
                            const idx = fpToIdx.get(fp);
                            if (idx == null) continue;
                            const r = _batchResults[idx];
                            if (r && r.status !== 'filled') {
                                const prev = r.status;
                                r.status = 'filled';
                                r.confidence = 0.9;
                                r.strategy = 'platform-postfill-trusted';
                                if (prev === 'error' || prev === 'skipped') promoted++;
                            }
                        }
                        if (_batchReport?.payload?.summary) {
                            const s = _batchReport.payload.summary;
                            s.filled = _batchResults.filter(r => r.status === 'filled').length;
                            s.fuzzy = _batchResults.filter(r => r.status === 'fuzzy').length;
                            s.error = _batchResults.filter(r => r.status === 'error').length;
                            s.skipped = _batchResults.filter(r => r.status === 'skipped').length;
                        }
                    }

                    // Refresh the progress overlay using the post-postFill
                    // results. The earlier render at line ~933 happened BEFORE
                    // postFill ran, so it reflected the engine's optimistic /
                    // pessimistic verdict — every react-select Greenhouse
                    // commits via the trusted-click path was still showing ✗.
                    // Now that demote/promote have settled the true status,
                    // rebuild filledLabels / missingRequiredLabels from the
                    // final _batchResults and re-render the chip list.
                    try {
                        const _filledLbls = [];
                        const _missingLbls = [];
                        for (let i = 0; i < _batchRules.length; i++) {
                            const r = _batchRules[i];
                            const res = _batchResults[i];
                            if (!r || !res) continue;
                            const lbl = r.label || r.contextLabel || '';
                            if (!lbl) continue;
                            if (res.status === 'filled') _filledLbls.push(lbl);
                            else if (res.status === 'error' && r.required) _missingLbls.push(lbl);
                        }
                        const _finalData = {
                            filled: _filledLbls.length,
                            total: _batchRules.length,
                            filledLabels: _filledLbls.slice(-5),
                            missingRequiredLabels: _missingLbls,
                            missingRequiredFingerprints: _batchRules
                                .filter((r, i) => r.required && _batchResults[i]?.status === 'error')
                                .map(r => r.fingerprint).filter(Boolean),
                            required: {
                                filled: _batchRules.filter(r => r.required && _batchResults[_batchRules.indexOf(r)]?.status === 'filled').length,
                                total: _batchRules.filter(r => r.required).length
                            },
                            clientId: profile.id,
                        };
                        chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', ..._finalData }).catch(() => {});
                        updateProgressOverlay(_finalData);
                    } catch (_) {}
                }

                if (_filledCount > 0) return _batchReport;
            } catch (batchErr) {
                console.warn('[QuickApply] Batch fill failed, falling back to legacy path:', batchErr.message);
            }
        }
        // ── END BATCH AI RESOLUTION ───────────────────────────────────────────────
        // Legacy field-by-field path continues below (unchanged)...

        // Discover all fillable fields
        const fields = discoverFields(document);
        filledFieldsMap.clear();
        _filledSelectorMap.clear(); // SR FIX: reset selector map on each fill

        const results = [];
        let filledCount = 0;
        let fuzzyCount = 0;
        let errorCount = 0;
        const unknownForHints = []; // fields we couldn't identify — will get hint badges
        // C6 FIX: track profileFields filled this session to prevent the same field being
        // filled 3–6× due to iframe duplicates or EEO groups spanning multiple elements.
        // Corrections always bypass this guard (user explicitly provided the value).
        const _filledProfileFields = new Set();
        // Prevents the same profileField from being corrected twice in one fill session
        // (e.g. two radio groups both matching disabilityStatus via correction-by-profile).
        const _appliedCorrectionByProfile = new Set();

        // EEO fields filled below this confidence get snapped to "Prefer not to say"
        // instead of a potentially wrong affirmative answer. (Improvement 4)
        const EEO_CONFIDENCE_THRESHOLD = 0.65;

        // Live progress bar — send total count before loop starts
        chrome.runtime.sendMessage({
            type: 'FILL_PROGRESS',
            payload: { current: 0, total: fields.length, label: `Found ${fields.length} fields…` }
        }).catch(() => { });
        let _pfIndex = 0;

        for (const field of fields) {
            _pfIndex++;
            chrome.runtime.sendMessage({
                type: 'FILL_PROGRESS',
                payload: { current: _pfIndex, total: fields.length, label: `Field ${_pfIndex} / ${fields.length}` }
            }).catch(() => { });
            // ── Priority 1: Check corrections database ──
            let match = null;
            let value = null;
            let usedCorrection = false;

            // For Select2 <a class="select2-choice"> triggers, use the underlying hidden
            // select's name/id (stored during discoverFields) so identifyField can match it.
            const fieldName = field.getAttribute('name') || field.id ||
                (field.dataset && field.dataset.quickapplyS2SelectName) || '';
            // Compute enriched label once per field — used by identifyField, AI block, and unknown-field handler
            let contextLabel = getElementContext(field);
            // Ashby button groups: the first button in the group has aria-label="Yes"/"No",
            // so getElementContext returns "Yes"/"No" instead of the question text. Override
            // by walking up to the .ashby-application-form-field-entry question title.
            if (field.dataset && field.dataset.quickapplyBtnGroup === 'true' && contextLabel && contextLabel.length <= 5) {
                const entry = field.closest('.ashby-application-form-field-entry, [class*="fieldEntry"]');
                const titleEl = entry && entry.querySelector('.ashby-application-form-question-title, [class*="questionTitle"], [class*="question-title"]');
                const titleText = titleEl && titleEl.textContent.trim();
                if (titleText && titleText.length > 5) contextLabel = titleText;
            }

            // B4: Referral / name-request / hiring-message fields — leave blank.
            // hiring-manager-message-input: SR's "Message to Hiring Team" textarea.
            // Identified as currentCompany by fuzzy match, then stored as bad correction.
            // It's a free-text cover letter box — never fill it with profile data.
            {
                const _refHaystack = [
                    contextLabel || '',
                    field.getAttribute('placeholder') || '',
                    field.getAttribute('aria-label') || '',
                    fieldName || ''
                ].join(' ');
                if (/referr(al|ed)|recruiter.{0,20}name|who\s+referred|referred\s+by|hiring.{0,10}manager.{0,10}message|message.{0,10}hiring.{0,10}team|hiring-manager-message/i.test(_refHaystack)) {
                    results.push({
                        fieldName: contextLabel || fieldName,
                        htmlName: fieldName,
                        contextLabel,
                        status: 'skipped',
                        confidence: 1.0,
                        strategy: 'referral-skip',
                        selector: buildSelector(field)
                    });
                    continue;
                }
            }

            // Pre-compute whether a user correction exists for this field.
            // Skip blocks must not fire when a correction is present — corrections always win.
            // L2 FIX: also check _effectiveFieldKey for opaque names (Ashby UUIDs,
            // Greenhouse EEO IDs) — the per-posting ID differs but the stable label matches.
            const _skipFieldSelector = buildSelector(field);
            const { effectiveKey: _corrEffKey } = typeof QuickApplyLearning !== 'undefined'
                ? QuickApplyLearning.resolveFieldIdentity(fieldName, contextLabel)
                : { effectiveKey: fieldName };
            const _hasCorrectionForField = corrections.length > 0 &&
                corrections.some(c =>
                    (c.fieldName && c.fieldName === fieldName) ||
                    c.fieldSelector === _skipFieldSelector ||
                    (c._effectiveFieldKey && _corrEffKey && c._effectiveFieldKey === _corrEffKey)
                );

            // Skip social media URL/profile fields — URL inputs should not get AI essays.
            // Covers both textarea AI path and text input AI path.
            // Guard: if the user has corrected this field, honour the correction instead.
            if (!_hasCorrectionForField) {
                const _socialHaystack = (contextLabel + ' ' + fieldName).toLowerCase();
                const _isSocialURLField = /\b(twitter|facebook|instagram|tiktok|snapchat|xing)\b/.test(_socialHaystack);
                if (_isSocialURLField) {
                    results.push({
                        fieldName: contextLabel || fieldName,
                        htmlName: fieldName,
                        contextLabel,
                        status: 'skipped',
                        confidence: 1.0,
                        strategy: 'social-url-skip',
                        selector: _skipFieldSelector
                    });
                    continue;
                }
            }

            // Skip intl-tel-input (iti) phone country code search inputs — they are an internal
            // widget input that opens a flag/country picker, not a fillable form field. Filling
            // them inserts text that the widget ignores and pollutes the fill log.
            if (/^iti-\d+__/.test(fieldName) || (field.getAttribute('type') === 'search' && /\bsearch\b/i.test(contextLabel) && /^iti-/.test(fieldName || ''))) {
                continue; // no results.push — these are pure UI widget internals
            }


            if (corrections.length > 0) {
                const selector = buildSelector(field);
                const correction = corrections.find(c =>
                    (c.fieldName && c.fieldName === fieldName) ||
                    c.fieldSelector === selector ||
                    (c._effectiveFieldKey && _corrEffKey && c._effectiveFieldKey === _corrEffKey)
                );
                if (correction) {
                    const _p1Ctx = (fieldName || '') + ' ' + contextLabel;
                    if (_isBadCorrectionValue(correction.correctedValue, _p1Ctx)) {
                        // B3: stale bad correction — skip, fall through to P2/P3-9 identification
                        console.debug(`[QuickApply] B3: Skipping bad correction "${correction.correctedValue}" for "${fieldName}"`);
                    } else {
                        match = {
                            profileField: correction.profileField,
                            confidence: 1.0,
                            strategy: 'correction',
                            _correctedValue: correction.correctedValue,
                            _correctedIndex: correction.correctedIndex
                        };
                        value = correction.correctedValue;
                        usedCorrection = true;
                        // Mark profileField as corrected so P1b can't double-fire
                        if (correction.profileField) _appliedCorrectionByProfile.add(correction.profileField);
                    }
                }
            }

            // ── Priority 2: Check platform learned mappings ──
            // Keys in platformMappings are normalized (lowercase, underscores).
            // fieldName is the raw HTML attribute — must normalize before lookup or it never matches.
            const _normFieldName = fieldName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);
            if (!match && (platformMappings[_normFieldName] || platformMappings[fieldName])) {
                match = {
                    profileField: platformMappings[_normFieldName] || platformMappings[fieldName],
                    confidence: 0.95,
                    strategy: 'platform-learned'
                };
                value = profile[match.profileField];
            }

            // ── Priority 3-8: Standard field identification ──
            if (!match) {
                match = window.QuickApplyFieldMapper.identifyField(field, profile.customFields || [], contextLabel, filler);
            }

            // SmartRecruiters oneclick-ui screening questions are long, numbered,
            // multi-clause custom text ("01 - What Is Your Current Place Of
            // Residence? (The City, State, and Country You Currently Reside)").
            // field-mapper's substring alias matcher has no word-boundary
            // requirement, so a bare mention of "state"/"country" *anywhere* in
            // that sentence wins a weak (confidence 0.6-0.75) match against the
            // profile's state/country field — filling the wrong one-word answer
            // instead of treating this as the open-ended custom question it is.
            //
            // Position, not just length, is what tells a real fix from a false
            // one apart: a label like "Work Authorization Status - What is
            // your..." IS about work authorization (the alias opens the label),
            // and "What is Your Current Salary Expectation..." IS about salary
            // (alias lands early) — those matches are correct and must survive.
            // But "...(The City, State, and Country You Currently Reside)"
            // only mentions "country" in the last third of an unrelated
            // residence question — the alias there is incidental, not the topic.
            // Demote only when the matched alias shows up late (>40% into the
            // label) on a label long enough to actually have "late" text.
            if (platform === 'smartrecruiters' && match && match.confidence < 0.8 && match.alias
                && contextLabel && contextLabel.length > 40) {
                const labelForPos = (match.labelText || contextLabel).toLowerCase();
                const idx = match.aliasIndex != null && match.aliasIndex >= 0
                    ? match.aliasIndex
                    : labelForPos.indexOf(match.alias);
                if (idx >= 0 && (idx / labelForPos.length) > 0.4) {
                    match = null;
                }
            }

            // ── "Don't Overwrite" Policy ──
            // Runs AFTER identification so we know the real profileField before deciding
            // whether the existing value is an overridable EEO default or a real user entry.
            // Exception 1: A correction (usedCorrection=true) always overrides.
            // Exception 2: EEO fields pre-filled with a platform default ("Prefer not to say") —
            //   now detected from the identified profileField first, contextLabel as fallback.
            //   These are overridable only if the candidate has a real answer stored.
            const EEO_PROFILE_FIELDS = new Set(['gender', 'ethnicity', 'veteranStatus', 'disabilityStatus',
                'hispanicLatino', 'sexualOrientation', 'transgender', 'workAuthorization', 'pronouns']);
            const EEO_CONTEXT = /veteran|disability|gender|race|ethnicity|hispanic|sex.{0,10}orient|transgender|legally authorized|work author|sponsorship/i;
            const isEEOField = match
                ? EEO_PROFILE_FIELDS.has(match.profileField)
                : EEO_CONTEXT.test(contextLabel); // Fallback only when field still unidentified
            if (!usedCorrection && hasValue(field, isEEOField)) {
                results.push({
                    fieldName: 'existing',
                    status: 'skipped',
                    confidence: 1.0,
                    strategy: 'already-filled',
                    selector: buildSelector(field)
                });
                continue;
            }

            // ── Priority 1b: Correction by profileField ──
            // After field identification, re-check corrections using the profileField.
            // This catches cases where the HTML field name changed between visits but the
            // field was correctly identified (e.g., "first_name" vs "firstName" — same correction).
            if (!usedCorrection && match && corrections.length > 0) {
                const correctionByProfile = corrections.find(c =>
                    c.profileField === match.profileField &&
                    (c.domain === domain || c.platform === platform)
                );
                if (correctionByProfile) {
                    // Guard: skip if we already applied a correction for this profileField this session.
                    // _appliedCorrectionByProfile is local to handleFill — resets on each new fill.
                    if (_appliedCorrectionByProfile.has(match.profileField)) {
                        // Already corrected — fall through to value-assignment / fill sections
                    } else {
                        const _p1bCtx = (fieldName || '') + ' ' + contextLabel;
                        if (_isBadCorrectionValue(correctionByProfile.correctedValue, _p1bCtx)) {
                            // B3: stale bad correction-by-profile — skip, keep P3-8 match/value
                            console.debug(`[QuickApply] B3: Skipping bad correction-by-profile "${correctionByProfile.correctedValue}" for "${fieldName}"`);
                        } else {
                            value = correctionByProfile.correctedValue;
                            match = {
                                ...match,
                                confidence: 1.0,
                                strategy: 'correction-by-profile',
                                _correctedValue: correctionByProfile.correctedValue,
                                _correctedIndex: correctionByProfile.correctedIndex
                            };
                            usedCorrection = true;
                            // Mark so P1b cannot fire again for this profileField in this session
                            _appliedCorrectionByProfile.add(match.profileField);
                        }
                    }
                }
            }

            // ── Priority 9a: Universal Registry — always runs, no API key needed ──
            // Try fieldName first (exact HTML-name key match), then contextLabel (label fuzzy match).
            // Using `contextLabel || fieldName` previously meant the HTML-name exact-key path was
            // skipped whenever contextLabel was set — defeating ~90% of registry hits.
            if (!match || match.confidence < 0.6) {
                if (typeof QuickApplyLearning !== 'undefined') {
                    try {
                        let registryMatch = fieldName ? await QuickApplyLearning.lookupField(fieldName) : null;
                        if ((!registryMatch || registryMatch.confidence < 0.6) && contextLabel) {
                            registryMatch = await QuickApplyLearning.lookupField(contextLabel);
                        }
                        if (registryMatch && registryMatch.confidence >= 0.6) {
                            match = {
                                profileField: registryMatch.profileField,
                                confidence: registryMatch.confidence,
                                strategy: 'universal-registry'
                            };
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            // ── Priority 9b: AI-Powered Fallback (only when API key is set) ──
            if ((!match || match.confidence < 0.6) && settings.geminiApiKey && !_wdT1Only) {
                try {
                    {
                        // Call Gemini AI (Next-Gen Fallback)
                        const aiResult = await chrome.runtime.sendMessage({
                            type: 'CALL_AI_IDENTIFICATION',
                            payload: {
                                label: contextLabel,
                                name: field.getAttribute('name'),
                                id: field.id,
                                placeholder: field.placeholder,
                                platform,
                                domain,
                                fieldName  // html name/id — for background.js to look up site memory
                            }
                        });

                        if (aiResult && aiResult.profileField) {
                            const isCustom = aiResult.profileField.startsWith('custom_');
                            const profileField = isCustom ? aiResult.profileField.replace('custom_', '') : aiResult.profileField;

                            match = {
                                profileField: profileField,
                                confidence: aiResult.confidence,
                                strategy: 'gemini-3.1',
                                isCustom: isCustom
                            };

                            // Save to Universal Registry (Zero-cost future mapping)
                            if (typeof QuickApplyLearning !== 'undefined') {
                                await QuickApplyLearning.registerField({
                                    label: contextLabel,
                                    fieldName: fieldName,
                                    profileField: profileField,
                                    source: 'gemini-ai',
                                    platform: platform   // C3 FIX: was `domain` (hostname URL), now detected platform string
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error('[QuickApply] AI Identification error:', e);
                }
            }

            // ── Priority 9c: Label Heuristic Quick-Fill (text inputs only, no API needed) ──
            // Handles ubiquitous Greenhouse/ATS custom questions whose answers are deterministic
            // from the label alone. Fires only for plain text/textarea inputs — comboboxes/selects
            // still go through the AI combobox path which picks the right option from the list.
            if (!match && contextLabel && contextLabel.length > 5) {
                const _lhTag = field.tagName.toLowerCase();
                const _lhType = (field.getAttribute('type') || '').toLowerCase();
                const _lhIsText = (_lhTag === 'textarea' || (_lhTag === 'input' && ['text', 'tel', ''].includes(_lhType)))
                    && field.getAttribute('role') !== 'combobox';
                if (_lhIsText) {
                    const _lhCtx = contextLabel.toLowerCase();
                    let _lhValue = null;
                    let _lhStrategy = 'label-heuristic';

                    // "Are you at least 18 / over 18 / minimum age" → Yes
                    if (/\b(at\s+least|minimum|over)\s+18\b|18\s+years\s+of\s+age|must\s+be\s+18/i.test(_lhCtx)) {
                        _lhValue = 'Yes';
                    }
                    // "Previously worked at/for / ever been employed by / former employee of" → No
                    else if (/previously\s+worked\s+(at|for)|ever\s+(been\s+employed|worked)\s+(at|for|by|with)|former\s+employee\s+of|worked\s+(here|there)\s+before|prior\s+employment/i.test(_lhCtx)) {
                        _lhValue = 'No';
                    }
                    // "What city and state / city & state / city, state do you live" → city, state
                    else if (/what\s+(city\s+(and|&|,)\s+state|city\/state)|city\s+(and|&|,)\s+state\s+(do\s+you|are\s+you|you\s+live)/i.test(_lhCtx)) {
                        if (profile.city || profile.state) {
                            _lhValue = [profile.city, profile.state].filter(Boolean).join(', ');
                        }
                    }
                    // "Open to working in our [city] office / work from our office / commutable distance" → Yes
                    else if (/open\s+to\s+working\s+in\s+our\s+\w+\s+office|work\s+(from|in)\s+our\s+(main\s+)?office|commutable\s+distance/i.test(_lhCtx)) {
                        _lhValue = 'Yes';
                    }
                    // "Do you have [SQL|scripting|BI tools|Excel|Python]" → Yes (generic tech skill)
                    else if (/do\s+you\s+have\s+(sql|python|excel|scripting|bi\s+tools|power\s*bi|tableau|looker)/i.test(_lhCtx)) {
                        _lhValue = 'Yes';
                    }

                    if (_lhValue) {
                        try {
                            await _enhancedFill(field, _lhValue);
                            field.classList.add('quickapply-filled');
                            filledFieldsMap.set(field, { profileField: null, originalValue: _lhValue, platform, domain, fieldName, clientId: profile.id });
                            attachCorrectionListener(field);
                            filledCount++;
                            results.push({ fieldName: contextLabel || fieldName, htmlName: fieldName, contextLabel, status: 'filled', value: _lhValue, confidence: 0.85, strategy: _lhStrategy, selector: buildSelector(field) });
                        } catch (_lhErr) {
                            results.push({ fieldName: contextLabel || fieldName, htmlName: fieldName, contextLabel, status: 'error', value: _lhValue, confidence: 0.1, strategy: _lhStrategy, selector: buildSelector(field) });
                        }
                        if (fillDelay > 0) await sleep(fillDelay);
                        continue;
                    }
                }
            }

            if (!match) {
                // ── INTELLIGENCE: Log unknown field for suggestions ──
                if (typeof QuickApplyLearning !== 'undefined' && fieldName) {
                    QuickApplyLearning.logUnknownField({
                        fieldName: fieldName,
                        label: contextLabel,
                        platform: platform
                    }).catch(() => {});
                }

                // Queue for hint badge injection after fill completes
                unknownForHints.push({ field, contextLabel, fieldName });

                // ── Unknown combobox: open dropdown and pick best option using CV ──
                // Handles Greenhouse/React-Select questions with paragraph-length options
                // (e.g. "Scalable Data Architecture — select the option that matches your experience").
                // Typing free text into a combobox input does NOT select an option, so we must
                // open the dropdown, collect its options, then use AI to pick the right one.
                // CV text is optional — AI can pick from options using profile context alone.
                // Removed profile.cvText from condition: binary Yes/No questions are answerable
                // from profile.workAuthorization, employment fields, etc. without a CV.
                // Also handles Select2 <a class="select2-choice"> triggers (Greenhouse custom questions).
                const _isUnknownCombobox = (field.getAttribute && field.getAttribute('role') === 'combobox') ||
                    (field.tagName === 'A' && field.dataset && field.dataset.quickapplyS2 === 'true');
                if (_isUnknownCombobox && contextLabel && contextLabel.length > 5 && settings.geminiApiKey && !_wdT1Only) {
                    try {
                        const ownerDoc = field.ownerDocument || document;
                        // Select2 <a>: click directly. React-Select: find toggle button on .select__control.
                        const _isS2 = field.tagName === 'A' && field.dataset.quickapplyS2 === 'true';
                        if (_isS2) {
                            field.click(); // Select2 opens on direct <a> click
                        } else {
                            const _sc = field.closest('[class*="select__control"]') || field.closest('[class*="select-shell"]');
                            // New Greenhouse combobox: "Toggle flyout" button is a sibling of the
                            // combobox's parent element, not inside select__control. Walk up two levels.
                            const _nearestParent = _sc || field.parentElement?.parentElement;
                            const _tb = _nearestParent?.querySelector('button[aria-label="Toggle flyout"]')
                                // removed: never use generic button — hits clear-x
                            if (_tb) {
                                _tb.click();
                            } else if (_sc) {
                                // React-Select: dispatch mousedown on the control wrapper to trigger open
                                _sc.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                _sc.click();
                            } else {
                                field.click(); field.focus();
                            }
                        }
                        await new Promise(r => setTimeout(r, 300));
                        // Scope to THIS container to avoid phone country list pollution.
                        // Select2 uses '.select2-container' (single underscore) whereas React-Select
                        // uses '.select__container' (double underscore) — check both.
                        const _scc = field.closest('[class*="select__container"]') ||
                            field.closest('[class*="select2-container"]') ||
                            field.closest('[class*="select-shell"]');
                        let comboOpts = _scc ? Array.from(_scc.querySelectorAll('[role="option"]')) : [];
                        if (comboOpts.length === 0) {
                            comboOpts = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                                .filter(o => !o.closest?.('[class*="iti__"]'));
                        }
                        if (comboOpts.length > 0) {
                            const optTexts = comboOpts.map(o => o.textContent.trim()).filter(t => t.length > 0);
                            const aiPick = await chrome.runtime.sendMessage({
                                type: 'CALL_AI_CV_OPTION_SELECT',
                                payload: { label: contextLabel, options: optTexts, cvText: profile.cvText || '', platform, domain, profileContext: buildProfileContext(profile) }
                            });
                            if (aiPick) {
                                const matchedEl = comboOpts.find(o => o.textContent.trim() === aiPick);
                                if (matchedEl) {
                                    matchedEl.click();
                                    await new Promise(r => setTimeout(r, 200));
                                    field.classList.add('quickapply-fuzzy');
                                    filledFieldsMap.set(field, { profileField: null, originalValue: aiPick, platform, domain, fieldName, clientId: profile.id });
                                    attachCorrectionListener(field);
                                    fuzzyCount++;
                                    results.push({ fieldName: contextLabel || fieldName, htmlName: fieldName, contextLabel, status: 'fuzzy', value: aiPick.substring(0, 50), confidence: 0.7, strategy: 'gemini-cv-option', selector: buildSelector(field) });
                                    // C6 FIX: register this mapping in the Universal Field Registry.
                                    // Previously nothing was saved here — same expensive AI call fired on
                                    // every fill. Now P9a picks it up on the next fill at no cost.
                                    if (typeof QuickApplyLearning !== 'undefined' && fieldName) {
                                        QuickApplyLearning.registerField({
                                            fieldName: fieldName,
                                            label: contextLabel,
                                            profileField: `custom_${(contextLabel || fieldName).slice(0, 40).replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
                                            source: 'gemini-ai',
                                            platform: platform
                                        }).catch(() => { });
                                    }
                                    continue;
                                }
                            }
                        }
                        document.body.click(); // close dropdown if nothing selected
                        await new Promise(r => setTimeout(r, 100));
                    } catch (e) {
                        console.error('[QuickApply] Unknown combobox option select error:', e);
                    }
                }

                // ── CV-based answer for unknown textual fields ──
                // If the client has CV text and a Gemini key, ask AI to compose an answer
                // using the candidate's resume as context (handles "tell us about yourself" etc.)
                const fieldTagName = field.tagName.toLowerCase();
                const fieldInputType = (field.getAttribute('type') || '').toLowerCase();
                // Exclude combobox/Select2 inputs — handled above; typing text into a combobox selects nothing
                const isCombobox = (field.getAttribute && field.getAttribute('role') === 'combobox') ||
                    (field.tagName === 'A' && field.dataset && field.dataset.quickapplyS2 === 'true');
                const isTextualField = !isCombobox && (fieldTagName === 'textarea' ||
                    (fieldTagName === 'input' && ['text', '', 'search'].includes(fieldInputType)));

                if (isTextualField && contextLabel && contextLabel.length > 5 && settings.geminiApiKey && profile.cvText && !_wdT1Only) {
                    // H4 FIX: referral/name-request fields ask for a person's name or blank — not an essay.
                    // Sending these to AI produces a long explanation paragraph which is wrong.
                    // Leave blank (the correct answer for "no referral") and skip the AI call.
                    const _isReferralField = /referr(al|ed)|recruiter.{0,20}name|who referred|referred by|refer\s+code|promo.?code/i.test(contextLabel);
                    if (_isReferralField) {
                        results.push({ fieldName: contextLabel, htmlName: fieldName, contextLabel, status: 'skipped', confidence: 1.0, strategy: 'referral-skip', selector: buildSelector(field) });
                        continue;
                    }
                    try {
                        // Check cache first — same key scheme as ai-resolver.js (clientId:fingerprint)
                        let cvAnswer = null;
                        const _cache = window.QuickApplyCache;
                        const _ukFingerprint = _cache ? _cache.makeFingerprint(contextLabel, 'textarea', []) : null;
                        const _ukCacheKey = _ukFingerprint ? (profile.id || 'default') + ':' + _ukFingerprint : null;
                        if (_cache && _ukCacheKey) cvAnswer = await _cache.get(_ukCacheKey);
                        if (!cvAnswer) {
                            cvAnswer = await chrome.runtime.sendMessage({
                                type: 'CALL_AI_CV_ANSWER',
                                payload: { label: contextLabel, cvText: profile.cvText, platform, domain }
                            });
                            if (cvAnswer && _cache && _ukCacheKey) await _cache.set(_ukCacheKey, cvAnswer, platform);
                        }
                        if (cvAnswer) {
                            await _enhancedFill(field, cvAnswer);
                            field.classList.add('quickapply-fuzzy');
                            filledFieldsMap.set(field, {
                                profileField: null,
                                originalValue: cvAnswer,
                                platform, domain, fieldName,
                                clientId: profile.id
                            });
                            attachCorrectionListener(field);
                            fuzzyCount++;
                            results.push({
                                fieldName: contextLabel || fieldName,
                                htmlName: fieldName,
                                contextLabel,
                                status: 'fuzzy',
                                value: cvAnswer.substring(0, 50),
                                confidence: 0.65,
                                strategy: 'cv-ai-answer',
                                selector: buildSelector(field)
                            });
                            continue;
                        }
                    } catch (e) {
                        console.error('[QuickApply] CV answer error:', e);
                    }
                }

                // ── Required combobox fallback (no API key or no options found by AI) ──
                // Greenhouse/Select2 fields backed by a required hidden <select> must have a value
                // for form submission to succeed. When we can't use AI, pick a smart default:
                //   consent/privacy/acknowledgment → first option (affirmative)
                //   interview/employment history   → "No" (safe: user probably hasn't worked there)
                //   anything else                  → "Prefer not to say" > "No" > first option
                // Marked 'error' (red) so user notices and can correct before submitting.
                const _isS2Link = field.tagName === 'A' && field.dataset && field.dataset.quickapplyS2 === 'true';
                if (_isS2Link || (field.getAttribute && field.getAttribute('role') === 'combobox')) {
                    try {
                        const ownerDoc = field.ownerDocument || document;
                        // Check if this combobox has a required hidden <select> sibling (Select2 pattern)
                        const _s2parent = field.closest('.input-group, .select2-container, [class*="select2"]') ||
                            field.closest('div, span');
                        const _hiddenSelect = _s2parent
                            ? _s2parent.querySelector('select[required], select[aria-required="true"]')
                            : null;
                        const _isRequired = !!_hiddenSelect ||
                            field.getAttribute('aria-required') === 'true';
                        // Select2 <a> triggers always need the fallback — they're visible select controls
                        if ((_isRequired || _isS2Link) && contextLabel) {
                            field.click();
                            await new Promise(r => setTimeout(r, 500));
                            const fallbackOpts = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                                .filter(o => !o.closest?.('[class*="iti__"]'));
                            if (fallbackOpts.length > 0) {
                                const optTexts = fallbackOpts.map(o => o.textContent.trim().toLowerCase());
                                // Helper: true if option text is a placeholder (nothing selected yet)
                                const isPlaceholder = (t) => /^please.?select|^--$|^-$|^select\b|^choose\b|^none\b/i.test(t) || !t;
                                // First non-placeholder option index (fallback of last resort)
                                const firstReal = optTexts.findIndex(t => !isPlaceholder(t));
                                const lc = contextLabel.toLowerCase();
                                let targetIdx = -1;
                                // Consent / privacy / acknowledgment → first non-placeholder (affirmative)
                                if (/consent|privacy|acknowledg|agree|terms/i.test(lc)) {
                                    targetIdx = firstReal;
                                }
                                // Interview / employment / agency / offer history → "No" / "never worked" (safe default)
                                else if (/interview|employ|offer|introduc|agency|previous|before|prior|partner/i.test(lc)) {
                                    targetIdx = optTexts.findIndex(t => /^no\b/i.test(t));
                                    if (targetIdx === -1) targetIdx = optTexts.findIndex(t => /prefer not|decline/i.test(t));
                                    if (targetIdx === -1) targetIdx = optTexts.findIndex(t => /never|not.*worked|no\s+prior/i.test(t));
                                    if (targetIdx === -1) targetIdx = firstReal; // e.g. "I have never worked for GoDaddy"
                                }
                                // Any other required combobox → prefer neutral, then first real
                                else {
                                    targetIdx = optTexts.findIndex(t => /prefer not|decline/i.test(t));
                                    if (targetIdx === -1) targetIdx = optTexts.findIndex(t => /^no\b/i.test(t));
                                    if (targetIdx === -1) targetIdx = firstReal;
                                }
                                if (targetIdx >= 0 && targetIdx < fallbackOpts.length) {
                                    fallbackOpts[targetIdx].click();
                                    await new Promise(r => setTimeout(r, 200));
                                    field.classList.add('quickapply-error'); // needs user review
                                    filledFieldsMap.set(field, { profileField: null, originalValue: fallbackOpts[targetIdx].textContent.trim(), platform, domain, fieldName, clientId: profile.id });
                                    attachCorrectionListener(field);
                                    errorCount++;
                                    results.push({ fieldName: contextLabel || fieldName, htmlName: fieldName, contextLabel, status: 'error', value: fallbackOpts[targetIdx].textContent.trim().substring(0, 50), confidence: 0.15, strategy: 'select2-required-fallback', selector: buildSelector(field) });
                                    continue;
                                }
                            }
                            document.body.click(); // close dropdown if nothing selected
                        }
                    } catch (e) { /* ignore */ }
                }

                // Still attach listener to unknown fields so we can "learn" them if user fills them
                filledFieldsMap.set(field, {
                    profileField: null,
                    originalValue: '',
                    platform,
                    domain,
                    fieldName,
                    clientId: profile.id
                });
                attachCorrectionListener(field);
                continue;
            }

            if (!value && value !== 0) {
                if (match.isCustom) {
                    value = match.customValue;
                } else if (match.profileField === 'confirmEmail') {
                    // confirmEmail has no dedicated profile field — always mirrors email
                    value = profile.email;
                } else {
                    value = profile[match.profileField];
                }
            }

            // ── Proactive essay caching (Improvement 2) ──
            // When a custom field was identified but has no stored answer yet, generate one
            // from the CV and immediately cache it as a correction so future fills are free.
            let _essayCacheProfileField = null;
            const _fieldTagForEssay = field.tagName.toLowerCase();
            const _fieldTypeForEssay = (field.getAttribute('type') || '').toLowerCase();
            const _isTextualForEssay = (_fieldTagForEssay === 'textarea' ||
                (_fieldTagForEssay === 'input' && ['text', '', 'search'].includes(_fieldTypeForEssay)));
            if (match.isCustom && !value && _isTextualForEssay &&
                profile.cvText && settings.geminiApiKey && !_wdT1Only && contextLabel && contextLabel.length > 5) {
                // Skip referral / name-request fields — same guard as the unknown-field path
                const _isReferralForEssay = /referr(al|ed)|recruiter.{0,20}name|who referred|referred by|refer\s+code|promo.?code/i.test(contextLabel);
                if (!_isReferralForEssay) {
                    try {
                        // Check cache first before calling AI
                        let _essayAnswer = null;
                        const _eCache = window.QuickApplyCache;
                        const _eFp = _eCache ? _eCache.makeFingerprint(contextLabel, 'textarea', []) : null;
                        const _eCacheKey = _eFp ? (profile.id || 'default') + ':' + _eFp : null;
                        if (_eCache && _eCacheKey) _essayAnswer = await _eCache.get(_eCacheKey);
                        if (!_essayAnswer) {
                            _essayAnswer = await chrome.runtime.sendMessage({
                                type: 'CALL_AI_CV_ANSWER',
                                payload: { label: contextLabel, cvText: profile.cvText, platform, domain }
                            });
                            if (_essayAnswer && _eCache && _eCacheKey) await _eCache.set(_eCacheKey, _essayAnswer, platform);
                        }
                        if (_essayAnswer) {
                            value = _essayAnswer;
                            _essayCacheProfileField = match.profileField || `custom_${contextLabel.slice(0, 40)}`;
                        }
                    } catch (_e2) {
                        console.error('[QuickApply] Proactive essay generation error:', _e2);
                    }
                }
            }

            // liveInUS country fallback — derive from profile.country when liveInUS is not set.
            // Clients based in Canada/UK/etc. don't need a separate liveInUS field in their profile.
            if (!value && match.profileField === 'liveInUS' && profile.country) {
                const _c = profile.country.toLowerCase();
                // ^us$ catches bare country-code "US"; anchored to avoid matching "Russia"/"Belarus"
                const _isUS = /\bunited states\b|^usa$|^us$|\bu\.s\.a?\.?\b/.test(_c);
                value = _isUS ? 'Yes' : 'No';
            }

            // workAuthorization → YES/NO transform for plain text inputs.
            // Greenhouse custom questions like "Are you legally authorized to work in the US?"
            // are <input type="text"> fields expecting "Yes"/"No", not the raw visa type string.
            // If the label asks about authorization/eligibility (not sponsorship), always answer "Yes"
            // because the candidate IS authorized (H1B, OPT, GC, Citizen — all are authorized).
            // If the label asks about sponsorship, derive Yes/No from the visa type.
            if (value && match.profileField === 'workAuthorization') {
                // Only transform when the value is a visa type (not already a plain Yes/No).
                // Applies to ALL field types (text, radio, select).
                const _valIsYN = /^(yes|no|true|false|1|0)$/i.test(String(value).trim());
                if (!_valIsYN) {
                    // Primary: use contextLabel from getElementContext.
                    // Fallback: walk up the DOM — on Greenhouse, getElementContext returns undefined
                    // for workAuthorization radio buttons because the question sits in a custom
                    // fieldset that the standard label-extraction strategies don't reach.
                    let _effectiveCtx = (contextLabel || '').toLowerCase();
                    if (!_effectiveCtx) {
                        let _el = field.parentElement;
                        for (let _d = 0; _d < 6 && _el; _d++, _el = _el.parentElement) {
                            const _q = _el.querySelector('label, legend, [class*="question"], [class*="label"]:not(input)');
                            const _t = (_q && !_q.querySelector('input,select,textarea')) ? _q.textContent.trim() : '';
                            if (_t.length > 8) { _effectiveCtx = _t.toLowerCase(); break; }
                            if ((_el.tagName === 'FIELDSET' || _el.getAttribute('role') === 'group') && _el.firstElementChild) {
                                const _lt = _el.firstElementChild.textContent.trim();
                                if (_lt.length > 8) { _effectiveCtx = _lt.toLowerCase(); break; }
                            }
                        }
                    }
                    if (_effectiveCtx) {
                        if (/legally\s+authorized|eligible\s+to\s+work|authorized\s+to\s+work|right\s+to\s+work/i.test(_effectiveCtx)) {
                            value = 'Yes';
                            match = { ...match, confidence: 0.95, strategy: 'workauth-yn-transform' };
                        } else if (/require\s+sponsor|need\s+sponsor|visa\s+sponsor|sponsorship|to\s+sponsor\s+an?\s+(?:immigration|visa|work)|sponsor\s+an?\s+immigration/i.test(_effectiveCtx)) {
                            const _wa = (profile.workAuthorization || '').toLowerCase();
                            // H1B/OPT/TN/J1/Require Sponsorship = needs sponsor; GC/Citizen/PR/EAD = does not
                            const _needsSponsor = /\bh1b?\b|opt|stem\s*opt|j1\b|\btn\b|e-?3\b|h4\s*ead|l1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(_wa);
                            value = _needsSponsor ? 'Yes' : 'No';
                            match = { ...match, confidence: 0.90, strategy: 'workauth-sponsor-transform' };
                        }
                    }
                }
            }

            if (!value && value !== 0) {
                results.push({
                    fieldName: match.profileField,
                    status: 'skipped',
                    confidence: match.confidence,
                    strategy: match.strategy,
                    selector: buildSelector(field)
                });
                continue;
            }

            // C6 FIX: skip if this profileField was already successfully filled this session.
            // Prevents 3–6× fills of the same field caused by:
            // (a) same field in multiple iframes with different CSS selectors (L7 dedup misses these)
            // (b) EEO radio groups where every <input> discovers as the same profileField
            // Corrections bypass this guard — user explicitly provided a value.
            if (!usedCorrection && match.profileField && _filledProfileFields.has(match.profileField)) {
                results.push({
                    fieldName: match.profileField,
                    status: 'skipped',
                    confidence: match.confidence,
                    strategy: match.strategy,
                    selector: buildSelector(field)
                });
                continue;
            }

            try {
                let fillResult;

                // For corrections on selects, use the stored index directly
                if (usedCorrection && field.tagName.toLowerCase() === 'select' && typeof match._correctedIndex === 'number') {
                    field.selectedIndex = match._correctedIndex;
                    dispatchEvents(field);
                    fillResult = { confidence: 1.0 };
                } else {
                    fillResult = await fillField(field, value, match, fillDelay, contextLabel, filler);
                }

                // ── AI Value Normalization Fallback ──
                // L3 FIX: threshold lowered 0.8 → 0.65. Fuzzy matches (0.65–0.79) are usually
                // correct; firing AI on those burned unnecessary API quota. AI now only runs when
                // the match is genuinely uncertain (< 0.65).
                // ── AI fallback for <select> ──
                if ((!fillResult || fillResult.confidence < 0.65) && settings.geminiApiKey && !_wdT1Only && field.tagName.toLowerCase() === 'select') {
                    try {
                        // C4 FIX: exclude blank placeholder and disabled options before sending to AI.
                        // Without this filter, AI may pick "" (the placeholder option) → selectedIndex=0
                        // → form stays at "Select..." but fill is logged as status:'filled'.
                        const options = Array.from(field.options)
                            .map((opt, i) => ({ text: opt.text.trim(), value: opt.value, index: i }))
                            .filter(o => !field.options[o.index].disabled && o.text && o.value !== '');
                        if (options.length > 0) {
                            const aiMatch = await chrome.runtime.sendMessage({
                                type: 'CALL_AI_NORMALIZATION',
                                payload: {
                                    field: match.profileField,
                                    value: value,
                                    options: options.map(o => o.text),
                                    questionLabel: contextLabel,
                                    profileContext: profileContext,
                                    platform,
                                    domain,
                                    htmlName: fieldName
                                }
                            });
                            if (aiMatch) {
                                const matchedOpt = options.find(o => o.text === aiMatch);
                                if (matchedOpt) {
                                    field.selectedIndex = matchedOpt.index;
                                    field.dispatchEvent(new Event('change', { bubbles: true }));
                                    field.dispatchEvent(new Event('input', { bubbles: true }));
                                    fillResult = { status: 'filled', confidence: 0.9, strategy: 'gemini-select' };
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[QuickApply] AI Normalization error:', e);
                    }
                }

                // ── AI fallback for role="combobox" React-Select fields (Greenhouse, etc.) ──
                // L3 FIX: threshold 0.8 → 0.65 (same rationale as select above).
                const _isComboboxField = field.getAttribute && field.getAttribute('role') === 'combobox';
                if ((!fillResult || fillResult.confidence < 0.65) && settings.geminiApiKey && !_wdT1Only && _isComboboxField) {
                    try {
                        const ownerDoc = field.ownerDocument || document;
                        // Click toggle button FIRST — React-Select opens on button click, not input click
                        const _sc = field.closest('[class*="select__control"]') || field.closest('[class*="select-shell"]');
                        // New Greenhouse combobox: "Toggle flyout" button is a sibling of the
                        // combobox's parent element, not inside select__control. Walk up two levels.
                        const _nearestParent = _sc || field.parentElement?.parentElement;
                        const _tb = _nearestParent?.querySelector('button[aria-label="Toggle flyout"]')
                            // removed: never use generic button — hits clear-x
                        if (_tb) {
                            _tb.click();
                        } else if (_sc) {
                            // React-Select: dispatch mousedown on the control wrapper to trigger open
                            _sc.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            _sc.click();
                        } else {
                            field.click(); field.focus();
                        }
                        await new Promise(r => setTimeout(r, 300));
                        // Scope to THIS container to avoid phone country list pollution.
                        // Select2 uses '.select2-container' (single underscore); React-Select
                        // uses '.select__container' (double underscore) — check both.
                        const _scc = field.closest('[class*="select__container"]') ||
                            field.closest('[class*="select2-container"]') ||
                            field.closest('[class*="select-shell"]');
                        let comboOpts = _scc ? Array.from(_scc.querySelectorAll('[role="option"]')) : [];
                        if (comboOpts.length === 0) {
                            comboOpts = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                                .filter(o => !o.closest?.('[class*="iti__"]'));
                        }
                        if (comboOpts.length > 0) {
                            const optTexts = comboOpts.map(o => o.textContent.trim()).filter(t => t.length > 0);
                            const aiMatch = await chrome.runtime.sendMessage({
                                type: 'CALL_AI_NORMALIZATION',
                                payload: {
                                    field: match.profileField,
                                    value: String(value),
                                    options: optTexts,
                                    questionLabel: contextLabel,
                                    profileContext,
                                    platform, domain,
                                    htmlName: fieldName
                                }
                            });
                            if (aiMatch) {
                                const matchedEl = comboOpts.find(o => o.textContent.trim() === aiMatch);
                                if (matchedEl) {
                                    matchedEl.click();
                                    await new Promise(r => setTimeout(r, 200));
                                    fillResult = { status: 'filled', confidence: 0.9, strategy: 'gemini-combobox' };
                                }
                            }
                        }
                        // Close dropdown if no option was selected
                        if (!fillResult || fillResult.confidence < 0.9) {
                            document.body.click();
                            await new Promise(r => setTimeout(r, 100));
                        }
                    } catch (e) {
                        console.error('[QuickApply] Combobox AI normalization error:', e);
                    }
                }

                // ── AI fallback for radio button groups ──
                const fieldType = (field.getAttribute('type') || '').toLowerCase();
                if ((!fillResult || fillResult.confidence < 0.6) && settings.geminiApiKey && !_wdT1Only &&
                    field.tagName.toLowerCase() === 'input' && fieldType === 'radio') {
                    try {
                        const radioName = field.getAttribute('name');
                        // H5 FIX: radioName can be null (dynamically generated forms).
                        // CSS.escape(null) produces the literal string "null" — query finds nothing.
                        // Guard here so we skip the AI block entirely instead of silently doing nothing.
                        if (!radioName) throw new Error('radio has no name attribute — skip AI block');
                        const ownerDoc = field.ownerDocument || document;
                        const radios = ownerDoc.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`);
                        const radioOpts = Array.from(radios).map((r, i) => ({ text: getRadioLabel(r), value: r.value, index: i }));
                        const aiMatch = await chrome.runtime.sendMessage({
                            type: 'CALL_AI_NORMALIZATION',
                            payload: {
                                field: match.profileField,
                                value: value,
                                options: radioOpts.map(o => o.text),
                                questionLabel: contextLabel,
                                profileContext: profileContext,
                                platform,
                                domain,
                                htmlName: radioName
                            }
                        });
                        if (aiMatch) {
                            const matchedOpt = radioOpts.find(o => o.text === aiMatch);
                            if (matchedOpt) {
                                const targetRadio = Array.from(radios)[matchedOpt.index];
                                if (targetRadio) {
                                    targetRadio.click();
                                    targetRadio.checked = true;
                                    dispatchEvents(targetRadio);
                                    fillResult = { status: 'filled', confidence: 0.9, strategy: 'gemini-radio' };
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[QuickApply] Radio AI Normalization error:', e);
                    }
                }

                // ── Queue hint badge for selects/radios that still failed after AI ──
                if ((!fillResult || fillResult.confidence < 0.5) &&
                    (field.tagName.toLowerCase() === 'select' ||
                        (field.tagName.toLowerCase() === 'input' && fieldType === 'radio'))) {
                    unknownForHints.push({ field, contextLabel, fieldName, _isChoiceField: true, _match: match });
                }

                // ── EEO snap-to-neutral (Improvement 4) ──
                // When an EEO field fills with low confidence, selecting "Prefer not to say/disclose"
                // is safer than leaving a potentially wrong affirmative answer on the form.
                if (isEEOField && match && EEO_PROFILE_FIELDS.has(match.profileField) &&
                    (!fillResult || fillResult.confidence < EEO_CONFIDENCE_THRESHOLD)) {
                    const _neutralPat = /prefer not|decline|not.{0,5}wish|do not wish|choose not|prefer not to (say|disclose|identify|answer)|not specified|i don.t wish/i;
                    try {
                        if (field.tagName.toLowerCase() === 'select') {
                            const _neutralIdx = Array.from(field.options).findIndex(o => _neutralPat.test(o.text));
                            if (_neutralIdx !== -1) {
                                field.selectedIndex = _neutralIdx;
                                field.dispatchEvent(new Event('change', { bubbles: true }));
                                field.dispatchEvent(new Event('input', { bubbles: true }));
                                fillResult = { status: 'filled', confidence: 0.71, strategy: 'eeo-neutral-fallback' };
                            }
                        } else if (field.getAttribute && field.getAttribute('role') === 'combobox') {
                            // Open dropdown using Toggle flyout logic
                            const _sc2 = field.closest('[class*="select__control"]') || field.closest('[class*="select-shell"]');
                            const _np2 = _sc2 || field.parentElement?.parentElement;
                            const _tb2 = _np2?.querySelector('button[aria-label="Toggle flyout"]') // removed: never use generic button — hits clear-x
                            if (_tb2) _tb2.click(); else { field.click(); field.focus(); }
                            await new Promise(r => setTimeout(r, 250));
                            const _ownerDoc2 = field.ownerDocument || document;
                            const _opts2 = deepQueryAll(_ownerDoc2.body || _ownerDoc2, '[role="option"]')
                                .filter(o => !o.closest?.('[class*="iti__"]'));
                            const _neutralEl = _opts2.find(o => _neutralPat.test(o.textContent.trim()));
                            if (_neutralEl) {
                                _neutralEl.click();
                                await new Promise(r => setTimeout(r, 200));
                                fillResult = { status: 'filled', confidence: 0.71, strategy: 'eeo-neutral-fallback' };
                            } else {
                                document.body.click();
                                await new Promise(r => setTimeout(r, 100));
                            }
                        }
                    } catch (_e4) {
                        console.error('[QuickApply] EEO neutral fallback error:', _e4);
                    }
                }

                // Determine highlight class
                let cssClass;
                if (fillResult && fillResult.confidence >= 0.8) {
                    cssClass = 'quickapply-filled';
                    filledCount++;
                } else if (fillResult && fillResult.confidence >= 0.5) {
                    cssClass = 'quickapply-fuzzy';
                    fuzzyCount++;
                } else {
                    cssClass = 'quickapply-error';
                    errorCount++;
                }

                field.classList.add(cssClass);

                // L1 FIX: three-tier status — confidence decay in platform knowledge only fires
                // for 'error' entries. Previously all < 0.8 got 'fuzzy', so bad fills with
                // confidence 0.35 never triggered decay and kept being repeated.
                const _fillStatus = fillResult.confidence >= 0.8 ? 'filled'
                    : fillResult.confidence >= 0.5 ? 'fuzzy'
                        : 'error';

                // F1 FIX: use the strategy from fillResult when AI normalization overrode the
                // initial match — fillResult.strategy is set to 'gemini-select', 'gemini-combobox',
                // or 'gemini-radio' when AI won. Fall back to match.strategy for rule-based fills.

                // Resolve display name — iCIMS comboboxes use placeholder text as their identity.
                // When the field's placeholder matches a known UI widget placeholder, use contextLabel instead.
                const _UI_PLACEHOLDERS = new Set([
                    '— type to search —', 'type to search', 'select...', 'choose...',
                    '-- select --', '- select -', 'search...', '— select —'
                ]);
                const _fieldPlaceholder = (field.getAttribute('placeholder') || '').toLowerCase().trim();
                const _displayFieldName = _UI_PLACEHOLDERS.has(_fieldPlaceholder)
                    ? (contextLabel || fieldName)
                    : match.profileField;

                const resultEntry = {
                    fieldName: _displayFieldName,
                    htmlName: fieldName,         // raw HTML name/id — for platform knowledge key
                    contextLabel: contextLabel,  // human label from page — for registry label storage
                    status: _fillStatus,
                    value: typeof value === 'string' ? value.substring(0, 50) : String(value),
                    confidence: fillResult?.confidence ?? match?.confidence ?? 0.35,
                    strategy: fillResult.strategy || match.strategy,
                    selector: buildSelector(field)
                };
                results.push(resultEntry);

                // ── INTELLIGENCE: Track filled field for correction detection ──
                filledFieldsMap.set(field, {
                    profileField: match.profileField,
                    originalValue: value,
                    platform,
                    domain,
                    fieldName,
                    clientId: profile.id,
                    isCustom: match.isCustom,
                    customLabel: match.customLabel
                });

                // Attach correction listener
                attachCorrectionListener(field);

                // ── Essay cache: save AI-generated answer as correction so next fill is free ──
                // (Improvement 2) Only fires when this fill used a freshly generated essay answer.
                if (_essayCacheProfileField && _fillStatus !== 'error' &&
                    typeof QuickApplyLearning !== 'undefined') {
                    QuickApplyLearning.saveCorrection({
                        clientId: profile.id,
                        platform,
                        domain,
                        fieldSelector: buildSelector(field),
                        fieldName,
                        contextLabel: getElementContext(field),
                        profileField: _essayCacheProfileField,
                        originalValue: '',
                        correctedValue: value,
                        correctedIndex: null,
                        inputType: 'text'
                    }).catch(() => { });
                }

                // C6 FIX: mark this profileField as filled so duplicates are skipped
                // workAuthorization is exempt: two separate questions (authorization + sponsorship) can
                // both map to this profileField but need different answers via yn/sponsor transforms.
                if (match.profileField && match.profileField !== 'workAuthorization') _filledProfileFields.add(match.profileField);

            } catch (err) {
                field.classList.add('quickapply-error');
                errorCount++;
                results.push({
                    fieldName: match.profileField,
                    htmlName: fieldName,
                    contextLabel,
                    status: 'error',
                    error: err.message,
                    confidence: 0,
                    selector: buildSelector(field)
                });
            }

            if (fillDelay > 0) {
                await sleep(fillDelay);
            }
        }

        // Handle CV upload (with integrity check)
        // Skipped on MutationObserver re-fills (skipCV=true) to prevent infinite loop:
        // upload fires change event → Ashby/SR DOM updates → observer re-fills → upload again
        if (!skipCV && profile.cvData && profile.cvFileName) {
            // ── INTELLIGENCE: Verify resume integrity before upload ──
            if (typeof QuickApplyLearning !== 'undefined' && profile.cvHash) {
                try {
                    const integrity = await QuickApplyLearning.verifyFileIntegrity(profile);
                    if (!integrity.valid) {
                        results.push({
                            fieldName: 'cv',
                            status: 'error',
                            confidence: 0,
                            error: `CV integrity check failed: ${integrity.reason}`
                        });
                        errorCount++;
                    } else {
                        const cvResult = await handleCVUpload(profile);
                        results.push(cvResult);
                        if (cvResult.status === 'filled') filledCount++;
                        else errorCount++;
                    }
                } catch (e) {
                    const cvResult = await handleCVUpload(profile);
                    results.push(cvResult);
                    if (cvResult.status === 'filled') filledCount++;
                    else errorCount++;
                }
            } else {
                const cvResult = await handleCVUpload(profile);
                results.push(cvResult);
                if (cvResult.status === 'filled') filledCount++;
                else errorCount++;
            }
        }

        // ── Cover letter upload (separate from CV — targets cover_letter inputs) ──
        if (!skipCV && profile.coverLetterData && profile.coverLetterFileName) {
            const clResult = await handleCoverLetterUpload(profile);
            results.push(clResult);
            if (clResult.status === 'filled') filledCount++;
        }

        // ── Handle password fields (account creation on Workday, etc.) ──
        // Per-client: each profile carries its own account password. A profile
        // with none set simply skips password fields.
        if (profile.defaultPassword) {
            const pwInputs = document.querySelectorAll('input[type="password"]');
            for (const pw of pwInputs) {
                if (!isVisible(pw) || pw.disabled || pw.readOnly) continue;
                if (pw.value && pw.value.length > 0) continue; // already filled
                setReactValue(pw, profile.defaultPassword);
                dispatchEvents(pw);
                pw.classList.add('quickapply-filled');
                filledCount++;
                results.push({ fieldName: 'password', status: 'filled', confidence: 1.0, strategy: 'default-password' });
            }
        }

        // ── INTELLIGENCE: Record fill results for platform learning ──
        if (typeof QuickApplyLearning !== 'undefined') {
            try {
                // Filter out 'skipped' entries before recording:
                // - 'already-filled' skips store key "existing" polluting platform knowledge
                // - 'no-value' skips have no profileField to learn from
                const recordableResults = results.filter(r => r.status !== 'skipped');
                await QuickApplyLearning.recordFillResult(domain, recordableResults);

                // ── Feed successful and fuzzy fills into the Universal Field Registry ──
                // L2 FIX: previously only 'filled' entries were registered. Fuzzy fills (correct
                // but lower-confidence match) were never registered, so the registry stayed thin
                // and P9a rarely helped. Now fuzzy fills are also registered at lower initial
                // confidence (0.35 — below the 0.6 lookup threshold). They become trusted after
                // one human correction or one more 'filled' confirmation, whichever comes first.
                // L4 FIX: pass `platform` (the detected platform string) not `domain` (the URL).
                // Awaited sequentially to prevent concurrent read-modify-write race:
                // if dispatched in parallel, each call reads the same stale registry and
                // the last write wins — only 1 entry survives per fill session.
                for (const r of results) {
                    if ((r.status === 'filled' || r.status === 'fuzzy') && r.fieldName) {
                        await QuickApplyLearning.registerField({
                            fieldName: r.htmlName || r.fieldName,  // HTML attribute name as key
                            label: r.contextLabel || r.fieldName,  // human-readable page label
                            profileField: r.fieldName,             // profile field (e.g. "firstName")
                            source: r.status === 'filled' ? 'form_fill' : 'form_fill_fuzzy',
                            platform: platform                     // L4: platform string not domain URL
                        });
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // SESSION RECORDER: capture this step's fields and fill results
        if (window.__qa_recordStep) window.__qa_recordStep(results);

        // Record fill time for MutationObserver refill window (C5: extended to 30s)
        _lastFillTime = Date.now();
        _fillCount++;

        // Schedule highlight auto-dismiss
        scheduleHighlightDismiss(highlightDuration);

        // Update + auto-dismiss progress overlay (legacy path never called updateProgressOverlay,
        // so the overlay stayed frozen on "Scanning…" indefinitely).
        {
            const _legacyFilled = filledCount + fuzzyCount;
            const _legacyTotal = results.filter(r => r.status !== 'skipped').length;
            updateProgressOverlay({
                filled: _legacyFilled,
                total: _legacyTotal,
                filledLabels: results.filter(r => r.status === 'filled').slice(-5).map(r => r.contextLabel || r.fieldName),
                missingRequiredLabels: results.filter(r => r.status === 'error').map(r => r.contextLabel || r.fieldName),
                missingRequiredFingerprints: [], // legacy path doesn't carry fingerprints — Fill Missing does a full pass
                required: { filled: _legacyFilled, total: _legacyTotal },
                clientId: profile.id
            });
            // Auto-dismiss overlay after 6s (restore fix from a4f1144)
            setTimeout(() => {
                const _h = window._qaProgressHost;
                if (!_h) return;
                _h.style.transition = 'opacity .4s, transform .4s';
                _h.style.opacity = '0';
                _h.style.transform = 'scale(0.88)';
                setTimeout(() => { _h.remove(); delete window._qaProgressHost; delete window._qaProgressShadow; }, 420);
            }, 6000);
        }

        // Build report
        const report = {
            type: 'FILL_REPORT',
            payload: {
                results,
                summary: {
                    total: results.length,
                    filled: filledCount,
                    fuzzy: fuzzyCount,
                    error: errorCount,
                    skipped: results.filter(r => r.status === 'skipped').length
                },
                platform,
                clientId: profile.id || null,   // D4: stored in fill log for application history
                clientName: profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || null,
                url: window.location.href,
                timestamp: new Date().toISOString(),
                jobKey: _qaJobKey,
                jobTitle: _qaJobMeta.title || '',
                jobCompany: _qaJobMeta.company || '',
            }
        };

        try {
            chrome.runtime.sendMessage(report);
        } catch (e) { }

        // Call filler.postFill() in legacy path too — was never called here either.
        // Note: the legacy path doesn't run Workday's discoverWorkdayControls(),
        // so button-dropdowns/dates/multiselects aren't discovered and `results`
        // carries no fingerprints for them. That means Workday's postFill has
        // nothing to fill on this path — the batch/AI path is the only one that
        // can fill those widgets. We still call postFill for the shadow-DOM
        // Polymer notify-path pass and any other filler-side cleanup.
        if (filler) {
            try { await filler.postFill(); } catch (_) {}
        }

        // Inject AI Fill Icons for remaining empty custom fields
        injectAIFillIcons();

        // Inject hint badges for unrecognised fields so user can label them
        if (unknownForHints.length > 0) {
            injectHintBadges(unknownForHints, profile, platform, domain);
        }

        return report;
    }

    // One Fill action, multiple passes. Workday (and other SPA forms) commonly need
    // 2–3 passes: repeating sections expand, date/combobox widgets settle, and
    // lazily-rendered sub-fields only appear AFTER an initial pass — which is why
    // users had to click Fill repeatedly. Run the extra passes automatically so a
    // single trigger (popup / side widget / hotkey) fully fills. Passes 2+ are
    // skipCV (no re-upload) + skipDuplicateCheck (don't bail on the dedup entry the
    // first pass wrote) and hit the T2 answer cache, so they're fast.
    async function _fillMultiPass(payload) {
        // Wall-clock start for the WHOLE application fill (all passes), so the log
        // shows total time to fill one application end-to-end.
        const _appT0 = performance.now();
        const _appStartClock = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const _logDone = () => console.log(`[QuickApply Timing] ${new Date().toLocaleTimeString('en-GB', { hour12: false })}  content: APPLICATION FILL COMPLETE — total ${((performance.now() - _appT0) / 1000).toFixed(1)}s (started ${_appStartClock})`);
        let report = await handleFill(payload);
        let plat = '';
        try { plat = _getPlatform(); } catch (_) {}
        // "Always use AI" → single pass, no automatic refills. Each refill pass would
        // otherwise re-invoke Gemini for any new/empty field; the user asked that
        // forceAI just do one clean AI fill rather than the multi-pass behaviour.
        const _forceAI = !!(payload.settings && payload.settings.forceAI);
        if (_forceAI) { _logDone(); return report; }
        if (/^(workday|smartrecruiters|icims|greenhouse)$/.test(plat) && !payload.skipCV) {
            // Cumulative count for the badge — refill passes now fill only the NEW
            // fields (handleFill skips already-filled ones on skipCV passes), so each
            // pass's report carries just its own delta. Sum them so the headline count
            // still reflects the whole form, not just the last (often empty) pass.
            let _cumFilled = report?.payload?.summary?.filled || 0;
            for (let pass = 0; pass < 2; pass++) {
                await new Promise(r => setTimeout(r, 1300)); // let the DOM settle between passes
                try {
                    const r2 = await handleFill({ ...payload, skipCV: true, skipDuplicateCheck: true });
                    const _f = r2?.payload?.summary?.filled || 0;
                    _cumFilled += _f;
                    // Stop as soon as a pass finds nothing new to fill. Static forms
                    // (greenhouse) settle after pass 1; multi-step forms (Workday/SR)
                    // keep going only while new fields keep appearing — step changes
                    // are handled separately by the MutationObserver.
                    if (r2?.payload?._noNewFields || _f === 0) break;
                    report = r2;
                } catch (_) {}
            }
            if (report?.payload?.summary) report.payload.summary.filled = _cumFilled;
        }
        _logDone();
        return report;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HINT BADGES — "?" on unknown fields so user can label them
    // ═══════════════════════════════════════════════════════════════════

    const HINT_PROFILE_FIELDS = [
        { value: 'firstName', label: 'First Name' },
        { value: 'lastName', label: 'Last Name' },
        { value: 'fullName', label: 'Full Name' },
        { value: 'email', label: 'Email' },
        { value: 'phone', label: 'Phone' },
        { value: 'address', label: 'Address / Street' },
        { value: 'city', label: 'City' },
        { value: 'state', label: 'State / Province' },
        { value: 'zip', label: 'Zip / Postal Code' },
        { value: 'country', label: 'Country' },
        { value: 'jobTitle', label: 'Current Job Title' },
        { value: 'currentCompany', label: 'Current Company' },
        { value: 'yearsExperience', label: 'Years of Experience' },
        { value: 'linkedin', label: 'LinkedIn URL' },
        { value: 'github', label: 'GitHub URL' },
        { value: 'portfolio', label: 'Portfolio / Website URL' },
        { value: 'workAuthorization', label: 'Work Authorization' },
        { value: 'degree', label: 'Degree' },
        { value: 'fieldOfStudy', label: 'Field of Study' },
        { value: 'university', label: 'University / School' },
        { value: 'graduationYear', label: 'Graduation Year' },
        { value: 'expectedSalary', label: 'Expected Salary' },
        { value: 'noticePeriod', label: 'Notice Period' },
        { value: 'coverLetter', label: 'Cover Letter' },
        { value: '__custom__', label: 'Custom / Other…' },
    ];

    /**
     * Inject orange "?" hint badges next to fields that couldn't be identified.
     * @param {Array<{field, contextLabel, fieldName}>} unknownFields
     * @param {object} profile
     * @param {string} platform
     * @param {string} domain
     */
    function injectHintBadges(unknownFields, profile, platform, domain) {
        for (const { field, contextLabel, fieldName, _isChoiceField, _match } of unknownFields) {
            // Skip hidden/invisible fields and fields that already have a badge
            if (field.dataset.quickapplyHintInjected) continue;
            const rect = field.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;

            field.dataset.quickapplyHintInjected = 'true';

            const uid = 'qah_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            field.dataset.qaHintUid = uid;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quickapply-hint-btn';
            btn.title = _isChoiceField
                ? 'QuickApply couldn\'t pick the right option — click to select it'
                : 'QuickApply couldn\'t identify this field — click to teach it';
            btn.textContent = '?';

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showHintPopup(field, btn, uid, profile, platform, domain, contextLabel, fieldName, _isChoiceField, _match);
            });

            document.body.appendChild(btn);
            _hintBtnMap.set(uid, { btn, popup: null });
            _positionHintBtn(btn, field);
        }
    }

    /**
     * Show the answer-capture popup near the hint badge.
     * Primary mode: user types the answer directly.
     * For select/radio: also shows available options to pick from.
     */
    function showHintPopup(field, btn, uid, profile, platform, domain, contextLabel, fieldName, isChoiceField, existingMatch) {
        // Close any other open hint popups first
        _hintBtnMap.forEach((entry) => {
            if (entry.popup) { entry.popup.remove(); entry.popup = null; }
        });

        const popup = document.createElement('div');
        popup.className = 'quickapply-hint-popup';

        const questionText = contextLabel
            ? contextLabel.slice(0, 100)
            : (fieldName || 'Unknown field');

        const clientName = (profile.firstName || profile.fullName || 'this client').split(' ')[0];

        // For select elements: collect available options
        let optionsHtml = '';
        let optionsList = [];
        if (isChoiceField && field.tagName.toLowerCase() === 'select') {
            optionsList = Array.from(field.options).map((opt, i) => ({ text: opt.text.trim(), value: opt.value, index: i })).filter(o => o.text && o.text !== '—' && o.text !== '-');
            if (optionsList.length > 0) {
                // Escape clientName + every option text — these reach innerHTML and
                // option text is attacker-controlled (sourced from the host page DOM).
                optionsHtml = `
                    <div class="qa-hint-label">Select the correct option for ${_escHtml(clientName)}:</div>
                    <select class="qa-hint-option-select">
                        <option value="">— Pick one —</option>
                        ${optionsList.map((o, i) => `<option value="${i}">${_escHtml(o.text)}</option>`).join('')}
                    </select>`;
            }
        } else if (isChoiceField && field.tagName.toLowerCase() === 'input') {
            // Radio group: collect sibling radios
            const radioName = field.getAttribute('name');
            if (radioName) {
                const ownerDoc = field.ownerDocument || document;
                const radios = ownerDoc.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`);
                optionsList = Array.from(radios).map((r, i) => ({ text: getRadioLabel(r), value: r.value, index: i }));
                if (optionsList.length > 0) {
                    optionsHtml = `
                        <div class="qa-hint-label">Select the correct option for ${_escHtml(clientName)}:</div>
                        <select class="qa-hint-option-select">
                            <option value="">— Pick one —</option>
                            ${optionsList.map((o, i) => `<option value="${i}">${_escHtml(o.text)}</option>`).join('')}
                        </select>`;
                }
            }
        }

        // For text fields: show a text input for the answer
        const answerInputHtml = !isChoiceField ? `
            <div class="qa-hint-label">Answer for ${_escHtml(clientName)}:</div>
            <input type="text" class="qa-hint-answer" placeholder="Type the correct answer…" />
        ` : '';

        // questionText is the form's label text — attacker-controlled. Escape before
        // injecting into innerHTML so a label like `<img src=x onerror=…>` can't run.
        popup.innerHTML = `
            <h4>QuickApply — Teach Me</h4>
            <div class="qa-hint-detected">"${_escHtml(questionText)}"</div>
            ${optionsHtml}
            ${answerInputHtml}
            <div class="qa-hint-actions">
                <button class="qa-hint-skip">Skip</button>
                <button class="qa-hint-save">Save &amp; Fill</button>
            </div>
        `;

        const saveBtn = popup.querySelector('.qa-hint-save');
        const skipBtn = popup.querySelector('.qa-hint-skip');
        const answerInput = popup.querySelector('.qa-hint-answer');
        const optionSelect = popup.querySelector('.qa-hint-option-select');

        skipBtn.addEventListener('click', () => {
            popup.remove();
            const entry = _hintBtnMap.get(uid);
            if (entry) entry.popup = null;
        });

        saveBtn.addEventListener('click', async () => {
            let answer = '';
            let chosenOptionIndex = -1;

            if (optionSelect) {
                // Choice field mode: user picked an option
                if (!optionSelect.value) {
                    optionSelect.style.setProperty('border-color', '#E63B2E', 'important');
                    return;
                }
                chosenOptionIndex = parseInt(optionSelect.value, 10);
                answer = optionsList[chosenOptionIndex]?.text || '';
            } else if (answerInput) {
                // Text field mode
                answer = answerInput.value.trim();
                if (!answer) {
                    answerInput.style.setProperty('border-color', '#E63B2E', 'important');
                    return;
                }
            }

            if (!answer) return;

            popup.remove();
            btn.remove();
            _hintBtnMap.delete(uid);

            // ── For choice fields: directly set the value on the element ──
            if (optionSelect && chosenOptionIndex >= 0) {
                if (field.tagName.toLowerCase() === 'select') {
                    field.selectedIndex = optionsList[chosenOptionIndex].index;
                    dispatchEvents(field);
                } else {
                    // Radio: click the chosen radio
                    const radioName = field.getAttribute('name');
                    const ownerDoc = field.ownerDocument || document;
                    const radios = ownerDoc.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`);
                    const targetRadio = radios[optionsList[chosenOptionIndex].index];
                    if (targetRadio) { targetRadio.click(); targetRadio.checked = true; dispatchEvents(targetRadio); }
                }
            } else if (answerInput) {
                // Text field: fill it
                await _enhancedFill(field, answer);
            }

            // ── Save as a custom field on the client profile (answer for next time) ──
            // The label is the question text (contextLabel) so matchByCustomFields can
            // find it next time via tokenOverlap against the same or similar question.
            await learnCustomField(profile.id, questionText, answer, fieldName);

            // ── Register in universal registry ──
            if (typeof QuickApplyLearning !== 'undefined') {
                QuickApplyLearning.registerField({
                    fieldName: fieldName,
                    label: contextLabel || questionText,
                    profileField: `custom_${questionText.slice(0, 40)}`,
                    source: 'user_hint',
                    platform: platform   // C3 FIX: was `domain` (hostname URL)
                }).catch(() => {}); // NEW-24 FIX: catch SW-unavailable rejection silently
            }

            // Visual confirmation
            field.classList.remove('quickapply-error', 'quickapply-fuzzy');
            field.classList.add('quickapply-filled');
        });

        // Position popup near the badge
        document.body.appendChild(popup);
        const entry = _hintBtnMap.get(uid);
        if (entry) entry.popup = popup;

        const btnRect = btn.getBoundingClientRect();
        let top = btnRect.bottom + 6;
        let left = btnRect.left - 260;
        // Keep within viewport
        if (left < 8) left = 8;
        if (top + 220 > window.innerHeight) top = btnRect.top - 226;
        popup.style.setProperty('top', `${top}px`, 'important');
        popup.style.setProperty('left', `${left}px`, 'important');

        // Click outside to close
        const onOutside = (e) => {
            if (!popup.contains(e.target) && e.target !== btn) {
                popup.remove();
                const en = _hintBtnMap.get(uid);
                if (en) en.popup = null;
                document.removeEventListener('mousedown', onOutside, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // AI FILL ICON — Sparkle button for custom questions
    // ═══════════════════════════════════════════════════════════════════

    // Track AI buttons: field UID → button element
    const _aiBtnMap = new Map();

    // Track hint badges: field UID → { btn, popup (if open) }
    const _hintBtnMap = new Map();

    function _positionAIBtn(btn, field) {
        const rect = field.getBoundingClientRect();
        // Hide button if field is not visible
        if (rect.width === 0 && rect.height === 0) {
            btn.style.setProperty('display', 'none', 'important');
            return;
        }
        btn.style.setProperty('display', 'flex', 'important');
        btn.style.setProperty('top', `${rect.top + 8}px`, 'important');
        btn.style.setProperty('left', `${rect.right - 36}px`, 'important');
    }

    function _positionHintBtn(btn, field) {
        const rect = field.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            btn.style.setProperty('display', 'none', 'important');
            return;
        }
        btn.style.setProperty('display', 'flex', 'important');
        // Place just outside the top-right corner of the field (offset from AI btn)
        btn.style.setProperty('top', `${rect.top - 11}px`, 'important');
        btn.style.setProperty('left', `${rect.right - 11}px`, 'important');
    }

    // Single scroll/resize listener updates all AI button and hint badge positions
    window.addEventListener('scroll', () => {
        _aiBtnMap.forEach((btn, uid) => {
            const field = document.querySelector(`[data-qa-field-uid="${uid}"]`);
            if (!field || !document.contains(field)) {
                btn.remove();
                _aiBtnMap.delete(uid);
            } else {
                _positionAIBtn(btn, field);
            }
        });
        _hintBtnMap.forEach(({ btn }, uid) => {
            const field = document.querySelector(`[data-qa-hint-uid="${uid}"]`);
            if (!field || !document.contains(field)) {
                btn.remove();
                _hintBtnMap.delete(uid);
            } else {
                _positionHintBtn(btn, field);
            }
        });
    }, { passive: true, capture: true });

    window.addEventListener('resize', () => {
        _aiBtnMap.forEach((btn, uid) => {
            const field = document.querySelector(`[data-qa-field-uid="${uid}"]`);
            if (field && document.contains(field)) _positionAIBtn(btn, field);
        });
        _hintBtnMap.forEach(({ btn }, uid) => {
            const field = document.querySelector(`[data-qa-hint-uid="${uid}"]`);
            if (field && document.contains(field)) _positionHintBtn(btn, field);
        });
    }, { passive: true });

    function injectAIFillIcons() {
        if (!currentProfile) return;

        const noCv = !currentProfile.cvText;

        // Upgrade greyed buttons when CV becomes available after FILL_FORM.
        // Only flip the visual state — do NOT add a click listener here. Every button
        // already got one at creation (which re-checks cvText at click time), so adding
        // another would double-fire onAIFillClick → two AI calls / double fill per click.
        if (!noCv) {
            _aiBtnMap.forEach((btn, uid) => {
                if (!btn.classList.contains('no-cv')) return;
                const field = document.querySelector(`[data-qa-field-uid="${uid}"]`);
                if (!field) return;
                btn.classList.remove('no-cv');
                btn.title = 'Fill / regenerate with AI (using CV)';
            });
        }

        // Collect candidates: textareas, contenteditable divs, and custom
        // [role="textbox"] components (SmartRecruiters, Greenhouse, etc.).
        // NOTE: we intentionally include ALREADY-FILLED free-text fields too — the
        // button is a persistent "Fill / regenerate with AI" affordance, so the user
        // can re-run the AI after a fill. It used to only attach to empty fields,
        // which made the icon vanish the moment a field had content.
        const candidates = [];
        const seenCandidates = new WeakSet();
        const addCandidate = (el) => {
            if (!seenCandidates.has(el) && isVisible(el)) {
                seenCandidates.add(el);
                candidates.push(el);
            }
        };
        document.querySelectorAll('textarea').forEach(el => addCandidate(el));
        document.querySelectorAll('[contenteditable="true"]').forEach(el => addCandidate(el));
        // Custom role="textbox" elements (SR "Message to Hiring Team", etc.)
        // Exclude plain <input> which also gets role="textbox" in some browsers
        document.querySelectorAll('[role="textbox"]:not(input):not(textarea)').forEach(el => addCandidate(el));
        // SmartRecruiters shadow-DOM textareas: actual <textarea> lives inside spl-textarea's shadowRoot.
        // querySelectorAll('textarea') never finds it — must target the host element directly.
        document.querySelectorAll('spl-textarea').forEach(el => {
            if (!el.shadowRoot) return;
            const nativeTA = el.shadowRoot.querySelector('textarea');
            if (!nativeTA) return;
            addCandidate(el);
        });
        // Single-line <input> fields QuickApply couldn't auto-identify (already
        // carry an orange "?" hint badge from the last fill pass) — e.g. SmartRecruiters
        // screening questions rendered as a plain text input rather than a
        // <textarea> ("What is your salary expectation?"). These are just as
        // AI-fillable as a textarea; the scan above excludes plain <input> by
        // default only to avoid putting the icon on ordinary profile fields
        // (name/email/phone) that were identified correctly.
        document.querySelectorAll('input[data-qa-hint-uid]').forEach(el => {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (['text', 'search', 'tel', 'email', 'url', ''].includes(t)) addCandidate(el);
        });

        candidates.forEach(field => {
            if (field.dataset.quickapplyAiInjected) return;
            field.dataset.quickapplyAiInjected = 'true';

            // Assign a unique ID so scroll listener can find the field
            const uid = 'qa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            field.dataset.qaFieldUid = uid;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quickapply-ai-btn' + (noCv ? ' no-cv' : '');
            btn.title = noCv ? 'No CV uploaded — go to Dashboard to add a CV' : 'Fill / regenerate with AI (using CV)';
            btn.innerHTML = `
                <svg viewBox="0 0 24 24">
                    <path d="M12,2L14.5,9L21.5,11.5L14.5,14L12,21L9.5,14L2.5,11.5L9.5,9L12,2M12,5.5L10.5,10L6,11.5L10.5,13L12,17.5L13.5,13L18,11.5L13.5,10L12,5.5M19,2L19.8,4.2L22,5L19.8,5.8L19,8L18.2,5.8L16,5L18.2,4.2L19,2M5,16L5.8,18.2L8,19L5.8,19.8L5,22L4.2,19.8L2,19L4.2,18.2L5,16Z" />
                </svg>
            `;

            // ALL buttons get a click listener — no-cv ones show a clear explanation
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                onAIFillClick(field, btn);
            });

            // Append to body so position:fixed escapes all overflow:hidden parents
            document.body.appendChild(btn);
            _aiBtnMap.set(uid, btn);
            _positionAIBtn(btn, field);
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // PROGRESS OVERLAY — real-time fill status widget (shadow DOM)
    // ═══════════════════════════════════════════════════════════════════

    function injectProgressOverlay() {
        if (document.getElementById('__qa_progress_host')) return;

        const host = document.createElement('div');
        host.id = '__qa_progress_host';
        // pointer-events:none on the host so this informational overlay never
        // intercepts clicks on the page beneath it (Workday's "Save and Continue"
        // sits bottom-right, exactly under this overlay — it was swallowing the
        // click and blocking step advancement). The visible card re-enables
        // pointer-events for its own buttons.
        host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,sans-serif;transition:opacity .3s,transform .3s;';

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                /* Card is click-through (pointer-events:none) so it never swallows
                   clicks on the page button beneath it (Workday "Save and Continue"
                   is bottom-right, under this card). Only the interactive controls
                   below re-enable pointer events. */
                .overlay { background:#1a1a2e; color:#fff; border-radius:12px; padding:12px 16px;
                           min-width:280px; max-width:360px; box-shadow:0 8px 32px rgba(0,0,0,.4);
                           font-size:13px; user-select:none; pointer-events:none; }
                .close, .btn { pointer-events:auto; }
                .header  { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
                .title   { font-weight:700; font-size:14px; flex:1; }
                .close   { background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0; }
                .bar-bg  { background:#333; border-radius:4px; height:6px; margin-bottom:8px; }
                .bar     { background:#00d4aa; height:6px; border-radius:4px; transition:width .3s; }
                .count   { color:#aaa; font-size:12px; white-space:nowrap; flex-shrink:0; }
                .fields  { display:flex; flex-wrap:wrap; gap:4px; }
                .chip    { padding:2px 8px; border-radius:100px; font-size:11px; }
                .green   { background:#1a3a2a; color:#00d4aa; }
                .red     { background:#3a1a1a; color:#ff6b6b; }
                .actions { margin-top:10px; display:flex; gap:8px; }
                .btn     { padding:5px 12px; border-radius:6px; border:none; cursor:pointer; font-size:12px; }
                .btn-fill { background:#00d4aa; color:#000; font-weight:600; }
                .btn-dim  { background:#333; color:#aaa; }
            </style>
            <div class="overlay" id="qa-overlay">
                <div class="header">
                    <span>⚡</span>
                    <span class="title">QuickApply</span>
                    <span class="count" id="qa-count">Scanning...</span>
                    <button class="close" id="qa-close">✕</button>
                </div>
                <div class="bar-bg"><div class="bar" id="qa-bar" style="width:0%"></div></div>
                <div class="fields" id="qa-fields"></div>
                <div class="actions">
                    <button class="btn btn-fill" id="qa-fill-missing" style="display:none">Fill Missing</button>
                    <button class="btn btn-dim"  id="qa-dismiss">Dismiss</button>
                </div>
            </div>
        `;

        document.body.appendChild(host);

        // Close button
        shadow.getElementById('qa-close').onclick = () => host.remove();
        shadow.getElementById('qa-dismiss').onclick = () => {
            host.style.opacity = '0'; setTimeout(() => host.remove(), 300);
        };

        // Fill Missing: re-run the fill restricted to only the fields that errored.
        // onlyFingerprints narrows discovery to just those fields so the rest of the
        // form is untouched. Falls back to a full pass if no fingerprints were stored
        // (legacy-path fills don't track them).
        shadow.getElementById('qa-fill-missing').onclick = () => {
            if (_fillInProgress) return;
            if (!_lastFillPayload) return;
            host.style.opacity = '0'; setTimeout(() => host.remove(), 300);
            _fillInProgress = true;
            const _targets = new Set(_lastMissingFingerprints);
            _fillMultiPass({
                ..._lastFillPayload,
                skipCV: true,
                skipDuplicateCheck: true,
                onlyFingerprints: _targets.size > 0 ? _targets : undefined,
            })
                .then(report => { chrome.runtime.sendMessage(report).catch(() => {}); })
                .catch(() => {})
                .finally(() => { _fillInProgress = false; });
        };

        // Auto-collapse after 10s idle
        let idleTimer = setTimeout(() => {
            host.style.opacity = '0.4';
            host.style.transform = 'scale(0.85)';
        }, 10000);
        host.addEventListener('mouseenter', () => {
            clearTimeout(idleTimer);
            host.style.opacity = '1';
            host.style.transform = 'scale(1)';
        });

        window._qaProgressShadow = shadow;
        window._qaProgressHost = host;
    }

    function updateProgressOverlay(data) {
        // Always refresh the targeted fingerprint list so Fill Missing is accurate
        // for the most recent fill pass (multi-pass fills call this multiple times).
        _lastMissingFingerprints = data.missingRequiredFingerprints || [];

        const shadow = window._qaProgressShadow;
        if (!shadow) return;

        const { filled, total, required } = data;
        const pct = total > 0 ? Math.round((required.filled / Math.max(required.total, 1)) * 100) : 0;

        shadow.getElementById('qa-bar').style.width = pct + '%';
        shadow.getElementById('qa-count').textContent =
            `${required.filled}/${required.total} required`;

        const fieldsEl = shadow.getElementById('qa-fields');
        // Labels come from form-field text on the host page — escape before innerHTML
        // insertion to neutralise any HTML/event handlers a malicious posting embeds.
        fieldsEl.innerHTML = (data.filledLabels || []).map(l =>
            `<span class="chip green">✓ ${_escHtml(String(l))}</span>`
        ).join('') + (data.missingRequiredLabels || []).map(l =>
            `<span class="chip red">✗ ${_escHtml(String(l))}</span>`
        ).join('');

        if ((data.missingRequiredLabels || []).length > 0) {
            shadow.getElementById('qa-fill-missing').style.display = 'block';
        }
    }

    // Show a brief toast notification on the page (success / error / info)
    function showPageToast(message, type = 'info', durationMs = 4000) {
        const existing = document.querySelector('.quickapply-ai-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `quickapply-ai-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, durationMs);
    }

    async function onAIFillClick(field, btn) {
        // ── Guard: no profile loaded yet ──
        if (!currentProfile) {
            showPageToast('Click "Fill Form" first to load a client profile, then use AI fill.', 'info');
            return;
        }

        // ── Guard: no CV uploaded ──
        if (!currentProfile.cvText) {
            showPageToast('No CV found for this client. Go to Dashboard → edit the client → upload a CV, then save.', 'error', 6000);
            return;
        }

        // ── Guard: extension context still alive ──
        if (!chrome.runtime?.id) {
            showPageToast('Extension was reloaded — please refresh this page and try again.', 'error', 6000);
            return;
        }

        // ── Guard: no API key ──
        let geminiApiKey = null;
        try {
            const data = await chrome.storage.local.get('quickapply_settings');
            geminiApiKey = data?.quickapply_settings?.geminiApiKey?.trim() || null;
        } catch (storageErr) {
            console.warn('[QuickApply] Could not read settings:', storageErr);
        }
        if (!geminiApiKey) {
            showPageToast('No Gemini API key set. Go to Dashboard → Settings → paste your Gemini API key.', 'error', 6000);
            return;
        }

        btn.classList.add('loading');
        const label = getElementContext(field);

        if (!label) {
            showPageToast('Could not read the question text for this field. Try clicking the field label first.', 'info');
            btn.classList.remove('loading');
            return;
        }

        try {
            const _aiPlatform = _getPlatform();
            const _aiDomain = new URL(window.location.href).hostname;
            const answer = await chrome.runtime.sendMessage({
                type: 'CALL_AI_CV_ANSWER',
                payload: { label, cvText: currentProfile.cvText, platform: _aiPlatform, domain: _aiDomain }
            });

            if (answer) {
                // For shadow-DOM host elements (spl-textarea etc.), fill the native
                // textarea inside the shadow root instead of the host itself.
                let fillTarget = field;
                if (field.shadowRoot) {
                    const nativeTA = field.shadowRoot.querySelector('textarea');
                    if (nativeTA) fillTarget = nativeTA;
                }

                const isContentEditable = field.getAttribute('contenteditable') === 'true';
                if (isContentEditable) {
                    field.focus();
                    document.execCommand('selectAll');
                    document.execCommand('insertText', false, answer);
                } else {
                    await _enhancedFill(fillTarget, answer);
                    // Also update Angular/web-component host value attribute if present
                    if (fillTarget !== field && field.hasAttribute('value')) {
                        field.setAttribute('value', answer);
                    }
                }
                field.classList.add('quickapply-filled');

                const platform = _getPlatform();
                const domain = new URL(window.location.href).hostname;
                const fieldName = field.getAttribute('name') || field.id || '';

                filledFieldsMap.set(fillTarget, {
                    profileField: null,
                    originalValue: answer,
                    platform, domain, fieldName,
                    clientId: currentProfile.id
                });
                attachCorrectionListener(fillTarget);

                // Keep the button so the user can regenerate. (It used to remove
                // itself here, which is why the icon vanished after one click.)
                // Reposition in case the field grew taller after the answer landed.
                _positionAIBtn(btn, field);
                showPageToast('AI answer written ✓', 'success', 2500);
            } else {
                // AI returned nothing — explain why
                showPageToast(
                    `AI couldn't answer "${label.substring(0, 60)}${label.length > 60 ? '…' : ''}". ` +
                    'The CV may not have enough information about this topic. Write the answer manually.',
                    'error', 7000
                );
                field.classList.add('quickapply-error');
                setTimeout(() => field.classList.remove('quickapply-error'), 3000);
            }
        } catch (e) {
            console.error('[QuickApply] Manual AI fill failed:', e);
            showPageToast('AI request failed. Check your internet connection and API key.', 'error');
        } finally {
            btn.classList.remove('loading');
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CORRECTION DETECTION — watches for user edits on filled fields
    // ═══════════════════════════════════════════════════════════════════

    function attachCorrectionListener(field) {
        // Remove old listeners to avoid duplicates
        field.removeEventListener('change', onFieldCorrected);
        field.removeEventListener('blur', onFieldCorrected);
        // 'change' fires on native forms; 'blur' catches React/Workday synthetic inputs
        field.addEventListener('change', onFieldCorrected);
        field.addEventListener('blur', onFieldCorrected);
        // SR FIX: also register by CSS selector so corrections survive React element replacement.
        // After SR re-renders (CV parse triggers re-render), the original element is gone but
        // the new element has the same CSS selector — _filledSelectorMap still finds it.
        const _sel = buildSelector(field);
        if (_sel) {
            const _info = filledFieldsMap.get(field);
            if (_info) _filledSelectorMap.set(_sel, _info);
        }
    }

    async function onFieldCorrected(event) {
        // Ignore the extension's OWN programmatic fills. fill-engine.js sets values
        // and dispatches change/blur via element.dispatchEvent(new Event(...)), which
        // produces isTrusted=false. Genuine human edits are isTrusted=true. Without
        // this guard, every re-fill (Ashby postFill, MutationObserver refills) was
        // captured as a "user correction" — poisoning the profile/cache with transient
        // re-render values (e.g. an essay field briefly holding "15"). Those poisoned
        // values then came back as wrong answers on the next fill via T1/T2.
        if (!event.isTrusted) return;
        // Also bail while WE are filling. The Workday/react-select CDP trusted-input
        // bridge dispatches REAL isTrusted=true events (chrome.debugger), so the
        // isTrusted guard alone doesn't stop our own combobox/multiselect fills from
        // being captured as "corrections" — that learned garbage option-ids (e.g.
        // Country/State → opaque hex like "bc33aa31…"). _fillInProgress is set by the
        // user-initiated fill entry points (popup FILL_FORM + side-widget button) and
        // the observer/SPA refills for the whole duration of handleFill.
        if (_fillInProgress) return;
        const field = event.target;
        // Primary lookup: element reference (fast path)
        // Fallback lookup: CSS selector (survives React/SR element replacement)
        const info = filledFieldsMap.get(field) || _filledSelectorMap.get(buildSelector(field));
        if (!info) return;

        // Get the new value the user set
        let newValue;
        const _tagName = field.tagName.toLowerCase();
        const _inputType = (field.getAttribute('type') || '').toLowerCase();
        if (_tagName === 'select') {
            newValue = field.options[field.selectedIndex]?.text || field.value;
        } else if (_tagName === 'input' && _inputType === 'checkbox') {
            // C4 FIX: checkboxes have HTML value="on" — store semantic Yes/No instead.
            // Replaying "on" on a text/select field is meaningless and causes errors.
            newValue = field.checked ? 'Yes' : 'No';
        } else {
            newValue = field.value;
            // C3 FIX: some ATS platforms (Greenhouse) use internal numeric IDs as
            // the <option value> or combobox input value (e.g. "56843325004").
            // Storing these as correctedValue breaks replay on other forms.
            // If the value is a pure long integer, skip storing the correction.
            if (/^\d{7,}$/.test(newValue)) return;
        }

        // Only save if actually different from what we filled
        if (newValue === info.originalValue) return;

        // Never write an empty value back to the profile. React-based forms
        // (Greenhouse / Ashby / Lever) often briefly clear a field during
        // validation or state-reconcile passes — the change event fires with
        // value="" and the correction listener would treat it as a deliberate
        // erase, overwriting "Female" / "I am not a veteran" / "United States"
        // with "" and corrupting the profile across tenants. Real "I want to
        // clear this answer" gestures aren't worth saving anyway: re-fills will
        // pick the field up again from the canonical profile field or AI.
        if (newValue == null || String(newValue).trim() === '') return;

        // M2 FIX: never store corrections for CAPTCHA / security code fields.
        // These are one-time challenges — replaying "R" or any stored answer is always wrong.
        const _labelText = getElementContext(field);
        if (/captcha|security.?code|verification.?code|verify.?human|robot|human.?check/i.test(
            _labelText + ' ' + (info.fieldName || '')
        )) return;

        // Save correction
        if (typeof QuickApplyLearning !== 'undefined') {
            const labelText = _labelText; // already computed above for M2 check

            // ── NEW: Custom Field Learning ──
            // If the field was unknown, or if the user is providing a new answer for a custom field
            if (!info.profileField || info.isCustom) {
                await learnCustomField(info.clientId, labelText || info.fieldName || 'Unknown Field', newValue, info.fieldName);
            }

            QuickApplyLearning.saveCorrection({
                clientId: info.clientId,
                platform: info.platform,
                domain: info.domain,
                fieldSelector: buildSelector(field),
                fieldName: info.fieldName,
                // Stable human label — lets the learning engine key corrections for
                // opaque/UUID field names (Ashby, Greenhouse/iCIMS EEO) so they apply
                // across postings instead of dying with the per-posting field id.
                contextLabel: labelText,
                profileField: info.profileField || `custom_${labelText}`,
                originalValue: info.originalValue,
                correctedValue: newValue,
                correctedIndex: field.tagName.toLowerCase() === 'select' ? field.selectedIndex : null,
                inputType: field.tagName.toLowerCase() === 'select' ? 'select' : 'text'
            }).then(() => {
                // Visual feedback: flash the field to confirm correction was saved
                field.classList.remove('quickapply-fuzzy', 'quickapply-error');
                field.classList.add('quickapply-filled');
                console.log(`[QuickApply] Learned/Corrected: ${info.profileField || labelText} → "${newValue}"`);
                // L4 FIX: registerField is already called inside _saveCorrectionDirect (SW side).
                // The duplicate call here was unhandled (no await/catch) and wrote twice per correction.
            }).catch((err) => {
                // Ignore "Extension context invalidated" — happens when extension reloads mid-session
                if (!String(err).includes('context invalidated')) {
                    console.error('[QuickApply] Failed to save correction:', err);
                }
            });
        }
    }

    /**
     * Helper to save a learned custom field into the client's profile.
     */
    async function learnCustomField(clientId, label, value, fieldName) {
        try {
            if (window.QuickApplyLearning?.isJunkLearnedField?.(label, value)) return;
        } catch (_) {}
        // Route through SW queue to avoid read-modify-write races from concurrent iframes.
        chrome.runtime.sendMessage({
            type: 'LEARNING_SAVE_CUSTOM_FIELD',
            customField: { clientId, label, value, fieldName }
        }).catch(() => {});
    }


    // ═══════════════════════════════════════════════════════════════════
    // FIELD FILLING — handles all input types
    // ═══════════════════════════════════════════════════════════════════

    async function fillField(element, value, match, delay, contextLabel, filler) {
        const tagName = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') || '').toLowerCase();

        // Ashby Yes/No button groups — choice buttons marked during discoverFields
        if (tagName === 'button' && element.dataset.quickapplyBtnGroup === 'true') {
            const parent = element.parentElement;
            if (!parent) return { confidence: 0 };
            const groupBtns = Array.from(parent.querySelectorAll('button[data-quickapply-btn-group]'));
            const options = groupBtns.map((b, i) => ({
                text: b.textContent.trim(),
                value: b.textContent.trim().toLowerCase(),
                index: i
            }));
            const bestMatch = window.QuickApplyFieldMapper.fuzzyMatchOption(
                options, String(value), match ? match.profileField : null, contextLabel, filler
            );
            if (bestMatch) {
                groupBtns[bestMatch.index].click();
                await new Promise(r => setTimeout(r, 150));
                return { confidence: bestMatch.confidence };
            }
            return { confidence: 0.2 };
        }

        // Select2 trigger (<a class="select2-choice">) — Greenhouse/Select2 custom questions.
        // Clicking the <a> opens the dropdown; options appear in #select2-drop with role="option".
        if (tagName === 'a' && element.dataset.quickapplyS2 === 'true') {
            const ownerDoc = element.ownerDocument || document;
            element.click(); // Select2 opens on <a> click
            await new Promise(r => setTimeout(r, 450));
            // Select2 renders its dropdown as a detached #select2-drop div (outside the container)
            // with <li class="select2-result" role="option"> children.
            let s2Opts = Array.from(ownerDoc.querySelectorAll(
                '#select2-drop li.select2-result:not(.select2-result-unselectable):not(.select2-disabled)'
            ));
            if (s2Opts.length === 0) {
                // Fallback: any role="option" not in phone picker
                s2Opts = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                    .filter(o => !o.closest?.('[class*="iti__"]'));
            }
            if (s2Opts.length === 0) return { confidence: 0 };
            const optData = s2Opts.map((o, i) => ({
                text: (o.querySelector('.select2-result-label') || o).textContent.trim(),
                value: (o.querySelector('.select2-result-label') || o).textContent.trim(),
                index: i
            }));
            const bestMatch = window.QuickApplyFieldMapper.fuzzyMatchOption(
                optData, String(value), match ? match.profileField : null, contextLabel, filler
            );
            if (bestMatch && bestMatch.confidence > 0.25) {
                s2Opts[bestMatch.index].click();
                await new Promise(r => setTimeout(r, 200));
                return { confidence: bestMatch.confidence };
            }
            ownerDoc.body.click(); // close dropdown if no match
            return { confidence: 0 };
        }

        // Date inputs (type="date") — Lever graduation/start date fields
        if (tagName === 'input' && type === 'date') {
            const dateVal = String(value).trim();
            let formatted = dateVal;
            if (/^\d{4}$/.test(dateVal)) {
                // Bare year (e.g. graduationYear "2020") → first day of that year
                formatted = `${dateVal}-01-01`;
            } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateVal)) {
                // MM/DD/YYYY → YYYY-MM-DD
                const [m, d, y] = dateVal.split('/');
                formatted = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(dateVal)) {
                // MM-DD-YYYY → YYYY-MM-DD
                const [m, d, y] = dateVal.split('-');
                formatted = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            }
            if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
                setReactValue(element, formatted);
                dispatchEvents(element);
                return { confidence: 0.9 };
            }
            return { confidence: 0.2 };
        }

        // ARIA combobox — Workday and similar custom dropdowns
        // These are <input role="combobox"> that open a [role="listbox"] popup on focus/click.
        // Simply setting value doesn't work — we must open the list and click the right option.
        if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') {
            const ownerDoc = element.ownerDocument || document;

            // Step 1: Click toggle button FIRST.
            // React-Select (Greenhouse) does NOT open on input click — it responds to a click on the
            // .select__control button (the chevron/arrow). Clicking the inner <input> does nothing.
            // For Workday and other implementations that open on focus, fall back to element.click().
            const _selCtrl = element.closest('[class*="select__control"]') || element.closest('[class*="select-shell"]');
            // Never querySelector('button') on _selCtrl — hits the clear-X button when a value
            // is already set, which clears the field instead of opening the dropdown.
            // .select__dropdown-indicator is React-Select's chevron arrow — clicking it reliably
            // opens the menu via React's onMouseDown handler on that element.
            const _flyoutBtn = _selCtrl?.querySelector('button[aria-label="Toggle flyout"]') ||
                _selCtrl?.querySelector('[class*="select__dropdown-indicator"]');
            if (_flyoutBtn) {
                _flyoutBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                _flyoutBtn.click();
            } else if (_selCtrl) {
                // React-Select: mousedown on the control wrapper triggers open.
                // Do NOT also call .click() — click fires after mousedown+mouseup and
                // React-Select interprets it as a toggle, immediately closing the menu.
                _selCtrl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            } else {
                element.click();
                element.focus();
            }
            await new Promise(r => setTimeout(r, 500));

            // Step 2: Scope options to THIS select container.
            // intl-tel-input (phone flag picker) always has 244 [role="option"] elements in the DOM
            // even when closed — deepQueryAll(document.body) would return those, poisoning matches.
            // Greenhouse listboxes render inside .select__container, so scoping avoids pollution.
            const _selContainer = element.closest('[class*="select__container"]') ||
                element.closest('[class*="select2-container"]') ||
                element.closest('[class*="select-shell"]');
            let options = _selContainer
                ? Array.from(_selContainer.querySelectorAll('[role="option"]'))
                : [];
            if (options.length === 0) {
                // Fallback for Workday shadow DOM — use deepQueryAll but strip phone picker options
                options = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                    .filter(o => !o.closest?.('[class*="iti__"]'));
            }

            // Step 3: If no options appeared, type first few characters to trigger filtering
            // (Workday location/job-title fields filter as you type)
            if (options.length === 0) {
                const typed = String(value).substring(0, 4);
                setReactValue(element, typed);
                dispatchEvents(element);
                await new Promise(r => setTimeout(r, 600));
                options = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                    .filter(o => !o.closest?.('[class*="iti__"]'));
            }

            // Step 4: Still nothing — type full value and wait longer
            if (options.length === 0) {
                setReactValue(element, String(value));
                dispatchEvents(element);
                await new Promise(r => setTimeout(r, 800));
                options = deepQueryAll(ownerDoc.body || ownerDoc, '[role="option"]')
                    .filter(o => !o.closest?.('[class*="iti__"]'));
            }

            if (options.length > 0) {
                const optionData = options.map((opt, i) => ({
                    text: opt.textContent.trim(),
                    value: opt.getAttribute('data-value') || opt.getAttribute('value') || opt.textContent.trim(),
                    index: i
                }));

                const bestMatch = window.QuickApplyFieldMapper.fuzzyMatchOption(
                    optionData, String(value), match ? match.profileField : null, contextLabel, filler
                );

                if (bestMatch) {
                    options[bestMatch.index].click();
                    await new Promise(r => setTimeout(r, 200)); // allow Workday to register selection
                    return { confidence: bestMatch.confidence };
                }

                // Single option — pick it (likely a filtered-down result)
                if (options.length === 1) {
                    options[0].click();
                    await new Promise(r => setTimeout(r, 200));
                    return { confidence: 0.75 };
                }
            }

            // Fallback: leave typed value — user reviews
            if (element.getRootNode() !== document) setPolymerValue(element, String(value));
            setReactValue(element, String(value));
            dispatchEvents(element);
            return { confidence: 0.35 };
        }

        // Text-like inputs
        if (tagName === 'input' && ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes(type)) {
            if (element.getRootNode() !== document) setPolymerValue(element, String(value));
            setReactValue(element, String(value));
            dispatchEvents(element);
            return { confidence: match?.confidence ?? 0.8 };
        }

        // Textarea
        if (tagName === 'textarea') {
            if (element.getRootNode() !== document) setPolymerValue(element, String(value));
            setReactValue(element, String(value));
            dispatchEvents(element);
            return { confidence: match?.confidence ?? 0.8 };
        }

        // Select
        if (tagName === 'select') {
            try {
                const options = Array.from(element.options).map((opt, i) => ({
                    text: opt.textContent.trim(),
                    value: opt.value,
                    index: i
                }));

                // Pass contextLabel (the actual question text from the page) so the matcher
                // can detect semantic inversions like "Do you REQUIRE sponsorship?" where
                // workAuthorization="Yes" (authorized) should answer "No".
                const matchResult = window.QuickApplyFieldMapper.fuzzyMatchOption(
                    options, String(value), match.profileField, contextLabel, filler
                );

                if (matchResult) {
                    element.selectedIndex = matchResult.index;
                    dispatchEvents(element);
                    return { confidence: matchResult.confidence };
                } else {
                    // H3 FIX: fuzzyMatchOption failed — likely because option values are internal
                    // ATS IDs (e.g. Greenhouse "56843325004") and the matcher couldn't align.
                    // Try a direct text comparison against the visible option text.
                    const valLower = String(value).toLowerCase();
                    const textMatch = options.find(o =>
                        o.text.toLowerCase() === valLower ||
                        (valLower.length > 2 && o.text.toLowerCase().includes(valLower))
                    );
                    if (textMatch) {
                        element.selectedIndex = textMatch.index;
                        dispatchEvents(element);
                        return { confidence: 0.6 };
                    }
                    return { confidence: 0.2 };
                }
            } catch (e) {
                // B5: element.options or dispatchEvents threw (shadow DOM proxy, detached element)
                // Don't fire events on a broken element — leave it untouched
                console.warn('[QuickApply] B5: select fill error for', fieldName, '—', e.message);
                return { confidence: 0.35, error: e.message };
            }
        }

        // Radio buttons
        if (tagName === 'input' && type === 'radio') {
            const name = element.getAttribute('name');
            if (!name) return { confidence: 0 };

            // Use element's own document — handles fields inside iframes
            const ownerDoc = element.ownerDocument || document;
            const radios = ownerDoc.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);

            // Detect semantic inversion: "Do you require sponsorship?" with workAuthorization="Yes"
            // means the correct radio answer is "No"
            const SPONSORSHIP_Q = /require.{0,20}sponsor|need.{0,20}sponsor|sponsor.{0,20}require|visa sponsor|employer sponsor/i;
            const AUTH_Q = /authorized.{0,20}work|legally authorized|eligible to work|right to work/i;
            const question = contextLabel || '';
            let effectiveValue = String(value).toLowerCase();

            // Semantic inversion for "Do you require sponsorship?" questions.
            // Guard: skip if the workauth-yn-transform already ran upstream (prevents double-inversion
            // where "No" would be flipped back to "Yes" by this code and produce the wrong answer).
            if (match && match.profileField === 'workAuthorization' && question &&
                !['workauth-yn-transform', 'workauth-sponsor-transform'].includes(match.strategy)) {
                const isSponsorQ = SPONSORSHIP_Q.test(question) && !AUTH_Q.test(question);
                if (isSponsorQ) {
                    const profileYes = ['yes', 'true', '1', 'authorized'].includes(effectiveValue);
                    const profileNo = ['no', 'false', '0'].includes(effectiveValue);
                    if (profileYes) effectiveValue = 'no';
                    else if (profileNo) effectiveValue = 'yes';
                }
            }

            const radioOptions = Array.from(radios).map((r, i) => ({
                text: getRadioLabel(r),
                value: r.value,
                index: i
            }));

            // Use fuzzyMatchOption for ALL matched fields (not just EEO).
            // This handles VALUES_MAP fields, exact matches, and substring matches
            // for currentlyEmployed, driversLicense, backgroundCheckConsent, etc.
            if (match && match.profileField) {
                const bestMatch = window.QuickApplyFieldMapper.fuzzyMatchOption(
                    radioOptions, effectiveValue, match.profileField, contextLabel, filler
                );
                if (bestMatch && bestMatch.confidence > 0.4) {
                    const targetRadio = radios[bestMatch.index];
                    if (targetRadio) {
                        targetRadio.click(); // React-controlled radios need native click
                        targetRadio.checked = true;
                        dispatchEvents(targetRadio);
                        return { confidence: bestMatch.confidence };
                    }
                }
            }

            // Generic fallback: direct string match
            for (const radio of radios) {
                const radioVal = (radio.value || '').toLowerCase();
                const radioLabel = getRadioLabel(radio).toLowerCase();
                if (radioVal === effectiveValue || radioLabel === effectiveValue ||
                    (effectiveValue.length > 2 && radioLabel.includes(effectiveValue)) ||
                    (radioLabel.length > 2 && effectiveValue.includes(radioLabel))) {
                    radio.click(); // React-controlled radios need native click
                    radio.checked = true;
                    dispatchEvents(radio);
                    return { confidence: 0.8 };
                }
            }
            return { confidence: 0.3 };
        }

        // Checkboxes — two modes:
        // 1. Standalone consent checkbox: value is yes/no/true/false
        // 2. Multi-select group (skills, languages, certifications): value is comma-separated list
        if (tagName === 'input' && type === 'checkbox') {
            const checkName = element.getAttribute('name') || '';
            const ownerDoc = element.ownerDocument || document;
            // Detect checkbox groups: same name, multiple options, or profileField is multi-value
            const checkGroup = checkName
                ? Array.from(ownerDoc.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(checkName)}"]`))
                : [];

            // workAuthorization checkbox group (Lever): options are country names, not yes/no
            // "Are you legally authorized to work in Canada, the United States, or UK?" checkboxes
            if (checkGroup.length > 1 && match && match.profileField === 'workAuthorization') {
                const isAuthorized = ['yes', 'true', '1', 'authorized', 'oui'].includes(String(value).toLowerCase());
                let checkedCount = 0;
                for (const cb of checkGroup) {
                    const cbText = (cb.value || cb.labels?.[0]?.textContent || '').toLowerCase().trim();
                    const isNoneOption = /none of the above|not authorized|none|no/i.test(cbText);
                    if (isAuthorized) {
                        // Check all country/jurisdiction options; uncheck "None of the above"
                        if (isNoneOption) {
                            if (cb.checked) { cb.checked = false; dispatchEvents(cb); }
                        } else if (!cb.checked) {
                            cb.checked = true;
                            dispatchEvents(cb);
                            checkedCount++;
                        }
                    } else {
                        // Not authorized: check "None of the above", uncheck everything else
                        if (isNoneOption && !cb.checked) {
                            cb.checked = true;
                            dispatchEvents(cb);
                            checkedCount++;
                        } else if (!isNoneOption && cb.checked) {
                            cb.checked = false;
                            dispatchEvents(cb);
                        }
                    }
                }
                return { confidence: checkedCount > 0 ? 0.82 : 0.3 };
            }

            if (checkGroup.length > 1 && match && ['skills', 'languages', 'certifications'].includes(match.profileField)) {
                // Multi-select: split value by comma/semicolon and check all matching boxes
                const targets = String(value).split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
                let checkedCount = 0;
                for (const cb of checkGroup) {
                    const cbLabel = (cb.labels?.[0]?.textContent || cb.value || '').toLowerCase().trim();
                    const cbValue = (cb.value || '').toLowerCase().trim();
                    const matches = targets.some(t =>
                        cbLabel === t || cbValue === t ||
                        cbLabel.includes(t) || t.includes(cbLabel)
                    );
                    if (matches && !cb.checked) {
                        cb.checked = true;
                        dispatchEvents(cb);
                        checkedCount++;
                    }
                }
                return { confidence: checkedCount > 0 ? 0.85 : 0.3 };
            }

            // Standalone consent/boolean checkbox
            const shouldCheck = ['yes', 'true', '1'].includes(String(value).toLowerCase());
            if (element.checked !== shouldCheck) {
                element.checked = shouldCheck;
                dispatchEvents(element);
            }
            return { confidence: 0.7 };
        }

        // Content-editable
        if (element.getAttribute('contenteditable') === 'true') {
            element.innerText = String(value);
            dispatchEvents(element);
            return { confidence: match.confidence };
        }

        return { confidence: 0 };
    }

    // ═══════════════════════════════════════════════════════════════════
    // REACT COMPATIBILITY — native setter bypass
    // ═══════════════════════════════════════════════════════════════════

    // Polymer 2.x data binding — best-effort. Private APIs, all wrapped in try/catch.
    // Called before setReactValue on shadow DOM elements to update Polymer's internal state
    // so the value isn't reset by Polymer's next render cycle.
    function setPolymerValue(element, value) {
        try {
            const host = element.__dataHost;
            if (host && typeof host._setPendingProperty === 'function') {
                host._setPendingProperty('value', value, true);
                if (typeof host._invalidateProperties === 'function') {
                    host._invalidateProperties();
                }
            }
        } catch (_) { }
    }

    /**
     * Enhanced fill: scrollIntoView + fill-engine events (or legacy fallback).
     * Use for text/textarea fills in handleFill where we want smooth scrolling + double cycle.
     */
    async function _enhancedFill(element, value) {
        if (window.QuickApplyFillEngine) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 100));
            window.QuickApplyFillEngine.fillText(element, String(value));
        } else {
            setReactValue(element, String(value));
            dispatchEvents(element);
        }
    }

    function setReactValue(element, value) {
        // Use the element's OWN window, not the extension's window.
        // For shadow DOM elements (Workday), element.ownerDocument.defaultView gives
        // the correct HTMLInputElement prototype — using the extension's window object
        // gives a different prototype and the setter won't trigger React's internal listener.
        const win = element.ownerDocument?.defaultView || window;
        const tag = element.tagName.toLowerCase();

        const proto = tag === 'textarea'
            ? win.HTMLTextAreaElement?.prototype
            : win.HTMLInputElement?.prototype;

        const setter = proto
            ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
            : null;

        // CRITICAL for React controlled inputs (Workable, Greenhouse, Lever):
        // React's _valueTracker records the last value it synced from the DOM.
        // When an 'input' event fires, React checks: tracker.getValue() !== el.value
        // If they match (stale cache), React ignores the event and won't update state.
        // Reset the tracker to the CURRENT value before we change it, so React sees
        // the upcoming change as a genuine user edit.
        if (element._valueTracker) {
            element._valueTracker.setValue(element.value ?? '');
        }

        if (setter) {
            setter.call(element, value);
        } else {
            element.value = value;
        }
    }

    function dispatchEvents(element) {
        // composed:true is CRITICAL for shadow DOM (Workday) — without it, events stop
        // at the shadow root boundary and the React app running outside never sees them.
        //
        // HOWEVER: on non-shadow-DOM React apps (Workable, Greenhouse), dispatching
        // 'focus' with composed:true triggers React 15's onFocus reconciliation, which
        // resets the DOM value back to React's internal state (empty string), undoing our fill.
        //
        // Fix: never dispatch 'focus' at all (it's not needed to trigger onChange),
        // and only use composed:true when the element actually lives inside a shadow root.
        const isInShadow = element.getRootNode() !== document;
        const evtOpts = { bubbles: true, composed: isInShadow };
        const keyOpts = { bubbles: true, composed: isInShadow, key: 'a', keyCode: 65 };

        element.dispatchEvent(new Event('input', evtOpts));
        element.dispatchEvent(new Event('change', evtOpts));
        element.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
        element.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
        // bubbles:false prevents Workday's form-level focusout listener from running
        // premature form-wide validation mid-fill, which freezes the submit button.
        // React and Polymer both respond to non-bubbling blur on the element itself.
        element.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: false }));

        // Polymer 2/3 two-way binding events — only for shadow DOM elements (Workday).
        // Exclude role="combobox": their element.value is the filter text, not the selected value;
        // dispatching bind-value-changed with stale text would clear the selection.
        if (isInShadow && element.getAttribute('role') !== 'combobox') {
            // bind-value-changed only when value is non-empty — avoids clearing Workday selections
            if (element.value) {
                try {
                    element.dispatchEvent(new CustomEvent('bind-value-changed', {
                        bubbles: true,
                        composed: true,
                        detail: { value: element.value }
                    }));
                } catch (_) { }
            }
            // element.set and notifyPath run unconditionally (outside element.value guard)
            // so they also fire when clearing a field — matches Polymer internal API contract.
            if (typeof element.set === 'function') {
                try { element.set('value', element.value); } catch (_) { }
            }
            if (typeof element.notifyPath === 'function') {
                try { element.notifyPath('value', element.value); } catch (_) { }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DOM TRAVERSAL — discovers all fillable fields including Shadow DOM
    // ═══════════════════════════════════════════════════════════════════

    function discoverFields(root) {
        const fields = [];
        const seen = new WeakSet();
        const FIELD_LIMIT = 500; // prevent hanging on massive DOMs (search pages, etc.)

        const add = (el) => {
            if (fields.length >= FIELD_LIMIT) return;
            // Skip aria-hidden fields — managed by autocomplete/geolocation components (e.g. Workable city/postcode)
            if (el.getAttribute('aria-hidden') === 'true') return;
            if (!seen.has(el) && isVisible(el) && !el.disabled && !el.readOnly) {
                seen.add(el);
                fields.push(el);
            }
        };

        const selectors = [
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]):not([type="password"])',
            'select',
            'textarea',
            '[contenteditable="true"]'
        ];

        selectors.forEach(sel => {
            root.querySelectorAll(sel).forEach(add);
        });

        // ARIA role elements — Workday custom dropdowns, SmartRecruiters components
        root.querySelectorAll('[role="combobox"], [role="listbox"], [role="spinbutton"]').forEach(el => {
            if (isVisible(el) && !el.getAttribute('aria-disabled')) add(el);
        });

        // Ashby-style Yes/No button groups — custom questions rendered as sibling <button> choices
        // Detect a container whose direct button children are all short choice words (Yes/No/OUI/NON)
        const seenBtnGroups = new WeakSet();
        root.querySelectorAll('button').forEach(btn => {
            if (!isVisible(btn) || btn.disabled) return;
            const parent = btn.parentElement;
            if (!parent || seenBtnGroups.has(parent)) return;
            const groupBtns = Array.from(parent.children).filter(
                c => c.tagName === 'BUTTON' && isVisible(c) && !c.disabled
            );
            if (groupBtns.length < 2 || groupBtns.length > 6) return;
            const texts = groupBtns.map(b => b.textContent.trim().toLowerCase());
            const isChoiceGroup = (texts.includes('yes') && texts.includes('no')) ||
                (texts.includes('oui') && texts.includes('non'));
            if (!isChoiceGroup) return;
            seenBtnGroups.add(parent);
            groupBtns.forEach(b => { b.dataset.quickapplyBtnGroup = 'true'; });
            // Add only the first button as the representative for this group
            if (!seen.has(groupBtns[0]) && isVisible(groupBtns[0])) {
                seen.add(groupBtns[0]);
                fields.push(groupBtns[0]);
            }
        });

        // Greenhouse/Select2 — visible trigger is <a class="select2-choice"> inside
        // <div class="select2-container">. The actual form control is a display:none
        // <select> sibling. isVisible() rejects hidden selects, so we discover the
        // <a> trigger instead and store the underlying select's name for identification.
        root.querySelectorAll('a.select2-choice').forEach(a => {
            if (!isVisible(a)) return;
            if (a.getAttribute('aria-hidden') === 'true') return;
            const container = a.closest('.select2-container');
            const parentEl = container?.parentElement;
            const hiddenSelect = parentEl ? parentEl.querySelector('select') : null;
            if (hiddenSelect) {
                // Transfer hidden select's name/id so identifyField can use them
                a.dataset.quickapplyS2 = 'true';
                a.dataset.quickapplyS2SelectName = hiddenSelect.name || '';
                a.dataset.quickapplyS2SelectId = hiddenSelect.id || '';
                if (!seen.has(a)) { seen.add(a); fields.push(a); }
            }
        });

        // Shadow DOM traversal (Workday heavily uses shadow DOM)
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                discoverFields(el.shadowRoot).forEach(f => {
                    if (!seen.has(f)) { seen.add(f); fields.push(f); }
                });
            }
        });

        // iframe scanning — SmartRecruiters puts form sections in same-origin iframes
        if (root.querySelectorAll) {
            root.querySelectorAll('iframe').forEach(iframe => {
                try {
                    if (iframe.contentDocument && iframe.contentDocument.body) {
                        discoverFields(iframe.contentDocument).forEach(f => {
                            if (!seen.has(f)) { seen.add(f); fields.push(f); }
                        });
                    }
                } catch (e) { /* cross-origin iframe, skip */ }
            });
        }

        // L7 FIX: Deduplicate by CSS selector string.
        // WeakSet deduplicates identical element references but can't catch two DIFFERENT
        // element objects that represent the same logical field (e.g. a field mirrored in both
        // the main doc and an iframe). Build a selector-keyed Set and drop duplicates.
        const selectorSeen = new Set();
        return fields.filter(f => {
            const sel = buildSelector(f);
            if (!sel || selectorSeen.has(sel)) return false;
            selectorSeen.add(sel);
            return true;
        });
    }

    function isVisible(element) {
        try {
            // getBoundingClientRect works correctly for shadow DOM elements
            // unlike offsetParent which returns null for shadow DOM children
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                // Zero-rect: check computed style to confirm actually hidden
                // (some valid Workday fields have 0 dimensions until focused)
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                // Has CSS but zero rect — likely a shadow DOM field not yet laid out; allow it
            }
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
        } catch (e) {
            // getComputedStyle can throw for elements in closed shadow roots — assume visible
            return true;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CV UPLOAD
    // ═══════════════════════════════════════════════════════════════════

    async function handleCVUpload(profile) {
        // deepQueryAll pierces shadow DOM — SR hides file inputs inside spl-dropzone shadow roots
        let fileInputs = deepQueryAll(document, 'input[type="file"]');
        // SR OneClick: skip the autoparse dropzone (data-test="apply-with-resume-container").
        // That dropzone triggers server-side CV parsing which overwrites already-filled fields.
        // Only upload to the plain attachment dropzone (data-test="resume-upload").
        fileInputs = fileInputs.filter(inp => {
            let host = inp.getRootNode()?.host;
            while (host) {
                if (host.getAttribute('data-test') === 'apply-with-resume-container') return false;
                host = host.getRootNode()?.host;
            }
            return true;
        });
        // Workable: "Autofill application / Import resume from" sits in a plain <div> before any
        // <section> in the form. If it ever injects a file input dynamically (clicking "Upload from
        // computer"), we must skip it — all legitimate form fields (Resume, custom uploads) are
        // inside <section> elements.
        if (_getPlatform() === 'workable') {
            fileInputs = fileInputs.filter(inp => !!inp.closest('section'));
        }

        if (fileInputs.length === 0) {
            return {
                fieldName: 'cv',
                status: 'skipped',
                confidence: 0,
                error: 'No file input found'
            };
        }

        // Find the resume/CV file input by context keywords only.
        // Never fall back to the first file input — that would upload into cover letter,
        // photo, or other unrelated inputs.
        //
        // IMPORTANT: Skip "Autofill from resume" helper sections (present on Ashby, Lever, etc.)
        // These trigger server-side PDF parsing that blocks form submission for minutes.
        // We only want the actual Resume/CV attachment field.
        const AUTOFILL_SECTION_RX = /autofill|auto.fill|auto.populate|quick.fill|import.resume|parse.resume|fill.from.resume|upload.*autofill|autofill.*upload|pre.?fill|fill.from.cv|fill.from.resume|quick.apply|resume.parser|parse.your.resume/i;
        // File inputs whose accept attr includes images/zip/presentations are custom question fields,
        // not resume fields — even if a parent element mentions "resume" in its text.
        // Workable: Resume field accept=".pdf,.doc,.docx,.odt,.rtf" (strict CV-only).
        //           Writing-sample/cover-letter fields accept includes .png,.jpg,.zip,.ppt (broad).
        const NON_CV_ACCEPT_RX = /image\/|video\/|\.zip|\.ppt|\.gif|\.tif|\.jpg|\.jpeg|\.png|\.xlsx|\.xls/i;

        let targetInput = null;  // best: CV keyword + strict CV-only accept + not autofill section
        let broadInput  = null;  // ok:   CV keyword + not autofill section (broad or no accept)
        let fallbackInput = null; // last: CV keyword + inside autofill section
        const CV_KEYWORDS = ['resume', 'résumé', 'cv', 'curriculum vitae', 'curriculum'];
        for (const input of fileInputs) {
            // Check element attributes directly. Walk the DOM-parent chain too
            // so dropzone wrappers (e.g. Netflix's .upload-resume-dropzone) that
            // hold no keyword on the file <input> itself still match. Three
            // levels up is enough for known patterns and avoids picking up
            // unrelated section headings.
            const parentClasses = (() => {
                const out = [];
                let p = input.parentElement;
                for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                    if (p.className) out.push(String(p.className));
                    const dt = p.getAttribute('data-test') || p.getAttribute('data-testid') || '';
                    if (dt) out.push(dt);
                }
                return out.join(' ');
            })();
            const attrText = [
                input.name, input.id, input.getAttribute('data-testid'),
                input.getAttribute('data-automation-id'), input.getAttribute('aria-label'),
                input.getAttribute('accept'),
                parentClasses
            ].filter(Boolean).join(' ').toLowerCase();

            const context = getElementContext(input).toLowerCase();

            // Also walk shadow host chain — SR file inputs live inside spl-dropzone shadow DOM,
            // so parentElement-based getElementContext() can't reach the host's data-test attrs.
            // data-test="resume-upload" on the spl-dropzone host contains the "resume" keyword.
            let shadowHostText = '';
            let _host = input.getRootNode()?.host;
            while (_host) {
                const dt = _host.getAttribute('data-test') || _host.getAttribute('data-testid') || '';
                const al = _host.getAttribute('aria-label') || '';
                shadowHostText += ' ' + dt + ' ' + al;
                _host = _host.getRootNode()?.host;
            }

            // Workday (and similar) put the "Resume/CV" label as a SECTION HEADING above
            // the formField, not on the file input — whose data-automation-id
            // ("file-upload-input-ref") collapses to just "ref" via getElementContext, and
            // whose own formField label is the generic "Upload a file (5MB max)". Walk up to
            // the input's nearest heading-bearing section and fold that heading text in, so
            // the CV keyword is found and the dropzone isn't skipped. Scoping to the NEAREST
            // section keeps a Certifications "Attachments" input from matching the resume
            // section's heading.
            let sectionHeadingText = '';
            {
                const HEADING_SEL = 'h1,h2,h3,h4,h5,h6,legend,[role="heading"],[data-automation-id$="ectionTitle"],[data-automation-id$="anelTitle"]';
                let anc = input.parentElement;
                for (let i = 0; i < 8 && anc; i++, anc = anc.parentElement) {
                    const heads = anc.querySelectorAll(HEADING_SEL);
                    if (heads.length) {
                        for (const h of heads) {
                            const ht = (h.textContent || '').trim();
                            if (ht && ht.length < 60) sectionHeadingText += ' ' + ht.toLowerCase();
                        }
                        break; // nearest section with a heading wins
                    }
                }
            }

            const combined = attrText + ' ' + context + ' ' + shadowHostText.toLowerCase() + ' ' + sectionHeadingText;

            if (!CV_KEYWORDS.some(kw => combined.includes(kw))) continue;

            // Strict CV accept: accept is non-empty and contains no non-document formats.
            // Inputs with broad accept (images, zip, ppt) are custom question fields (e.g. Workable
            // Details section writing-sample / cover-letter uploads) and must not receive the CV.
            const accept = (input.accept || '').toLowerCase();
            const isStrictCV = accept.length > 0 && !NON_CV_ACCEPT_RX.test(accept);

            // Check if this input sits inside an "Autofill from resume" helper section.
            // Walk up to 8 ancestors, checking textContent (300 chars), className, and data-ui attr.
            let inAutofillSection = false;
            let ancestor = input.parentElement;
            for (let i = 0; i < 8 && ancestor; i++) {
                const txt = (ancestor.textContent || '').substring(0, 300);
                const dataUi = (ancestor.getAttribute('data-ui') || '').toLowerCase();
                if (AUTOFILL_SECTION_RX.test(txt) ||
                    AUTOFILL_SECTION_RX.test(ancestor.className || '') ||
                    AUTOFILL_SECTION_RX.test(dataUi)) {
                    inAutofillSection = true;
                    break;
                }
                ancestor = ancestor.parentElement;
            }

            if (!inAutofillSection) {
                if (isStrictCV) {
                    targetInput = input;
                    break; // ideal match: CV keyword + strict doc-only accept + not autofill section
                } else if (!broadInput) {
                    broadInput = input; // CV keyword + not autofill, but broad or empty accept
                }
            } else if (!fallbackInput) {
                fallbackInput = input; // remember in case no better match found
            }
        }

        // Priority: strict-accept real field > broad/empty-accept real field > autofill section
        if (!targetInput) targetInput = broadInput;
        if (!targetInput) targetInput = fallbackInput;

        if (!targetInput) {
            return { fieldName: 'cv', status: 'skipped', confidence: 0, error: 'No resume file input found' };
        }

        // SR FIX: module-level flag survives SR React re-renders that destroy data attributes.
        // Once uploaded on this page load, never re-upload (prevents SR's CV-parse loop).
        if (_cvUploadedThisPageLoad) {
            return { fieldName: 'cv', status: 'skipped', confidence: 1.0, strategy: 'already-uploaded' };
        }
        // Skip if already uploaded (data attribute guard — survives framework re-renders better than files check)
        if (targetInput.dataset.quickapplyUploaded === 'true') {
            return { fieldName: 'cv', status: 'skipped', confidence: 1.0, strategy: 'already-uploaded' };
        }
        // Skip if the file input already has files (e.g., user manually selected one)
        if (targetInput.files && targetInput.files.length > 0) {
            return { fieldName: 'cv', status: 'skipped', confidence: 1.0, strategy: 'already-uploaded' };
        }

        try {
            // Reconstruct the File object from base64
            const binaryString = atob(profile.cvData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const file = new File(
                [bytes],
                profile.cvFileName,
                { type: profile.cvMimeType || 'application/pdf' }
            );

            // Create a DataTransfer to set files on the input
            const dt = new DataTransfer();
            dt.items.add(file);
            targetInput.files = dt.files;

            // Dispatch events
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));

            targetInput.classList.add('quickapply-filled');
            // Mark as uploaded so any subsequent handleFill calls (observer re-fills) skip it
            targetInput.dataset.quickapplyUploaded = 'true';
            // SR FIX: also set module-level flag — survives SR React element replacement
            _cvUploadedThisPageLoad = true;

            // Wait for async upload processing to complete before returning.
            // Ashby (and similar platforms) send the file to their server and update the
            // form state asynchronously — filling other fields during this window triggers
            // "We're updating your forms, please try again when they're finished."
            // Strategy: watch the form for DOM mutations and wait until it goes quiet
            // (no mutations for 400ms), or bail out after 5 seconds max.
            // 10 s max — Ashby's server-side CV parse can take 5-8 s on slow connections.
            // The old 5 s timeout caused re-assertion to run *before* the ATS finished
            // overwriting fields, so the correction was immediately overwritten again.
            await waitForDOMQuiet(targetInput.closest('form') || document.body, 400, 10000);

            // Re-assert profile fields after CV parse.
            // Ashby, Lever, Workable and similar platforms parse the uploaded CV server-side
            // and auto-populate form fields from whatever data is in the PDF (email, name, phone).
            // If the CV data differs from the profile (e.g. old CV with previous email/phone),
            // the ATS silently overwrites what we already filled correctly.
            // After the DOM settles, force profile values back for all commonly-overwritten fields.
            function _reAssert(sels, value) {
                if (!value) return;
                document.querySelectorAll(sels).forEach(el => {
                    if (isVisible(el) && !el.disabled && !el.readOnly && el.value !== String(value)) {
                        setReactValue(el, String(value));
                        dispatchEvents(el);
                        el.classList.add('quickapply-filled');
                    }
                });
            }

            _reAssert([
                'input[type="email"]',
                'input[id="_systemfield_email"]',
                'input[name="_systemfield_email"]',
                'input[id="email"]',
                'input[name="email"]',
                'input[id*="email"]:not([id*="confirm"]):not([id*="verify"])',
                'input[name*="email"]:not([name*="confirm"]):not([name*="verify"])'
            ].join(','), profile.email);

            _reAssert([
                'input[name="firstName"]', 'input[name="first_name"]', 'input[name="firstname"]',
                'input[id="firstName"]', 'input[id="first_name"]', 'input[id="firstname"]',
                'input[data-automation-id*="firstName"]', 'input[data-automation-id*="first_name"]'
            ].join(','), profile.firstName);

            _reAssert([
                'input[name="lastName"]', 'input[name="last_name"]', 'input[name="lastname"]',
                'input[id="lastName"]', 'input[id="last_name"]', 'input[id="lastname"]',
                'input[data-automation-id*="lastName"]', 'input[data-automation-id*="last_name"]'
            ].join(','), profile.lastName);

            // Ashby uses a single combined "Name*" field (id="_systemfield_name")
            // Re-assert full name as "First Last" after CV parse overwrites it.
            const _fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
            _reAssert([
                'input[id="_systemfield_name"]',
                'input[name="_systemfield_name"]'
            ].join(','), _fullName);

            _reAssert([
                'input[type="tel"]',
                'input[name="phone"]', 'input[name="phone_number"]', 'input[name="phonenumber"]',
                'input[id="phone"]', 'input[id="phone_number"]',
                'input[id="_systemfield_phone"]', 'input[name="_systemfield_phone"]'
            ].join(','), profile.phone);

            const _linkedInValue = profile.linkedIn || profile.linkedin || '';
            if (_linkedInValue) {
                _reAssert([
                    'input[id="_systemfield_linkedin"]', 'input[name="_systemfield_linkedin"]',
                    'input[id="linkedin_profile"]', 'input[name="linkedin_profile"]',
                    'input[id*="linkedin" i]', 'input[name*="linkedin" i]'
                ].join(','), _linkedInValue);
            }

            // Deferred second re-assertion: Ashby can fire a second round of field updates
            // (validation, address lookup) up to ~3 s after the first DOM quiet period.
            // Running re-assertion again after 3 s catches any late overwrites.
            setTimeout(() => {
                _reAssert(['input[type="email"]', 'input[id="_systemfield_email"]', 'input[name="_systemfield_email"]'].join(','), profile.email);
                _reAssert(['input[id="_systemfield_name"]', 'input[name="_systemfield_name"]'].join(','), _fullName);
                _reAssert(['input[type="tel"]', 'input[name="phone"]', 'input[name="phone_number"]', 'input[id="_systemfield_phone"]', 'input[name="_systemfield_phone"]'].join(','), profile.phone);
                if (_linkedInValue) _reAssert(['input[id="_systemfield_linkedin"]', 'input[name="_systemfield_linkedin"]', 'input[id*="linkedin" i]'].join(','), _linkedInValue);
            }, 3000);

            return {
                fieldName: 'cv',
                status: 'filled',
                value: profile.cvFileName,
                confidence: 0.9,
                selector: buildSelector(targetInput)
            };
        } catch (err) {
            return {
                fieldName: 'cv',
                status: 'error',
                confidence: 0,
                error: err.message
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // COVER LETTER UPLOAD
    // ═══════════════════════════════════════════════════════════════════

    const _CL_KEYWORDS = ['cover_letter', 'cover-letter', 'coverletter', 'cover letter',
        'motivation', 'motivational letter', 'letter of intent', 'supporting document'];

    async function handleCoverLetterUpload(profile) {
        if (!profile.coverLetterData || !profile.coverLetterFileName) {
            return { fieldName: 'coverLetter', status: 'skipped', confidence: 0, error: 'No cover letter in profile' };
        }

        const fileInputs = deepQueryAll(document, 'input[type="file"]');
        if (fileInputs.length === 0) {
            return { fieldName: 'coverLetter', status: 'skipped', confidence: 0, error: 'No file inputs on page' };
        }

        let targetInput = null;
        for (const input of fileInputs) {
            if (input.dataset.quickapplyCLUploaded === 'true') {
                return { fieldName: 'coverLetter', status: 'skipped', confidence: 1.0, strategy: 'already-uploaded' };
            }
            const attrText = [input.name, input.id, input.getAttribute('aria-label'),
            input.getAttribute('data-testid')].filter(Boolean).join(' ').toLowerCase();
            const ctx = getElementContext(input).toLowerCase();
            const combined = attrText + ' ' + ctx;
            if (_CL_KEYWORDS.some(kw => combined.includes(kw))) {
                targetInput = input;
                break;
            }
        }

        if (!targetInput) {
            return { fieldName: 'coverLetter', status: 'skipped', confidence: 0, error: 'No cover letter file input found' };
        }

        // Skip if the field already has a file
        if (targetInput.files && targetInput.files.length > 0) {
            return { fieldName: 'coverLetter', status: 'skipped', confidence: 1.0, strategy: 'already-uploaded' };
        }

        try {
            const binaryString = atob(profile.coverLetterData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

            const file = new File([bytes], profile.coverLetterFileName,
                { type: profile.coverLetterMimeType || 'application/pdf' });
            const dt = new DataTransfer();
            dt.items.add(file);
            targetInput.files = dt.files;
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.classList.add('quickapply-filled');
            targetInput.dataset.quickapplyCLUploaded = 'true';

            return { fieldName: 'coverLetter', status: 'filled', value: profile.coverLetterFileName, confidence: 0.9, selector: buildSelector(targetInput) };
        } catch (err) {
            return { fieldName: 'coverLetter', status: 'error', confidence: 0, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DOM QUIET WAIT — used after CV upload to let async processing finish
    // ═══════════════════════════════════════════════════════════════════

    // Resolves when the target DOM subtree has been quiet (no mutations) for
    // `quietMs` milliseconds, or when `maxMs` total has elapsed.
    // Used after CV file upload on platforms like Ashby that process files
    // server-side and update the form asynchronously before accepting field fills.
    function waitForDOMQuiet(root, quietMs = 400, maxMs = 5000) {
        return new Promise(resolve => {
            let quietTimer = null;
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                observer.disconnect();
                if (quietTimer) clearTimeout(quietTimer);
                resolve();
            };
            const resetQuiet = () => {
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(done, quietMs);
            };
            const observer = new MutationObserver(resetQuiet);
            observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
            resetQuiet(); // start the quiet countdown immediately
            setTimeout(done, maxMs); // safety valve
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // CLEAR HANDLER
    // ═══════════════════════════════════════════════════════════════════

    function handleClear() {
        const classes = ['quickapply-filled', 'quickapply-fuzzy', 'quickapply-error', 'quickapply-dismiss'];

        // Clear highlight timers
        highlightTimers.forEach(t => clearTimeout(t));
        highlightTimers = [];

        // Remove all quickapply classes and clear values
        let cleared = 0;
        classes.forEach(cls => {
            document.querySelectorAll(`.${cls}`).forEach(el => {
                el.classList.remove(...classes);

                // Reset value
                if (el.tagName === 'SELECT') {
                    el.selectedIndex = 0;
                } else if (el.getAttribute('contenteditable') === 'true') {
                    el.innerText = '';
                } else {
                    el.value = '';
                }

                dispatchEvents(el);
                cleared++;
            });
        });

        return { cleared };
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCROLL TO FIELD
    // ═══════════════════════════════════════════════════════════════════

    function handleScroll(payload) {
        if (!payload.selector) return;

        try {
            const element = document.querySelector(payload.selector);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                element.focus();
            }
        } catch (e) {
            // Invalid selector
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function buildSelector(element) {
        if (element.id) return `#${CSS.escape(element.id)}`;
        if (element.name) return `[name="${CSS.escape(element.name)}"]`;

        // Build a path selector
        const path = [];
        let current = element;
        while (current && current !== document.body) {
            let tag = current.tagName.toLowerCase();
            if (current.id) {
                path.unshift(`#${CSS.escape(current.id)}`);
                break;
            }
            const sibling = current.parentElement
                ? Array.from(current.parentElement.children).filter(c => c.tagName === current.tagName)
                : [];
            if (sibling.length > 1) {
                const index = sibling.indexOf(current) + 1;
                tag += `:nth-of-type(${index})`;
            }
            path.unshift(tag);
            current = current.parentElement;
        }

        return path.join(' > ');
    }

    function getRadioLabel(radio) {
        // Check for associated label
        if (radio.id) {
            const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
            if (label) {
                const clone = label.cloneNode(true);
                clone.querySelectorAll('input, textarea, select').forEach(el => el.remove());
                const text = clone.textContent.trim();
                if (text) return text;
            }
        }
        const parentLabel = radio.closest('label');
        if (parentLabel) {
            const clone = parentLabel.cloneNode(true);
            clone.querySelectorAll('input, textarea, select').forEach(el => el.remove());
            const text = clone.textContent.trim();
            if (text) return text;
        }

        // Check next sibling text
        const next = radio.nextSibling;
        if (next && next.nodeType === Node.TEXT_NODE) return next.textContent.trim();

        return radio.value || '';
    }

    function getElementContext(element) {
        // Use element's own root (handles shadow DOM — Workday, etc.)
        const domRoot = element.getRootNode ? element.getRootNode() : document;
        const rootQuery = (sel) => domRoot.querySelector ? domRoot.querySelector(sel) : document.querySelector(sel);

        // 0. Custom web components (SmartRecruiters spl-textarea etc.) store their
        //    visible label as a 'label' attribute on the host element.
        const labelAttr = element.getAttribute('label');
        if (labelAttr && labelAttr.trim().length > 2) return labelAttr.trim();

        // 1. aria-labelledby → find referenced element(s) within same root
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
            const text = labelledBy.split(' ')
                .map(id => rootQuery(`#${CSS.escape(id)}`))
                .filter(Boolean)
                .map(el => el.textContent.trim())
                .join(' ').trim();
            if (text.length > 2) return text;
        }

        // 2. aria-label directly on the element
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim().length > 2) return ariaLabel.trim();

        // 2b. Workday: data-automation-id label lookup
        const automationId = element.getAttribute('data-automation-id') ||
            element.closest('[data-automation-id]')?.getAttribute('data-automation-id') || '';
        if (automationId) {
            // Strip section prefix to get human-readable label
            const readable = automationId.split(/[_-]/).pop().replace(/([A-Z])/g, ' $1').trim();
            if (readable.length > 2) return readable;
        }

        // 3. Associated <label for="id"> — search within shadow root
        if (element.id) {
            const label = rootQuery(`label[for="${CSS.escape(element.id)}"]`);
            if (label) return label.textContent.trim();
        }

        // 3a. Parent <fieldset> → <legend> — Workday and other platforms wrap custom
        //     open-ended questions in a <fieldset> with the question in <legend>.
        //     Placed AFTER label[for=id] so that section-level fieldsets (e.g.
        //     "Work Experience" grouping many fields) do not override individual labels.
        try {
            const fieldset = element.closest('fieldset');
            if (fieldset) {
                const legend = fieldset.querySelector(':scope > legend');
                if (legend) {
                    const text = legend.textContent.trim();
                    if (text.length > 2) return text;
                }
            }
        } catch (_) { /* closest may throw in some shadow DOM contexts */ }

        // 4. Wrapping <label> — wrapped in try-catch; .closest() throws in some shadow DOM contexts
        try {
            const parentLabel = element.closest('label');
            if (parentLabel) {
                const clone = parentLabel.cloneNode(true);
                clone.querySelectorAll('input, textarea, select').forEach(el => el.remove());
                const text = clone.textContent.trim();
                if (text.length > 2) return text;
            }
        } catch (e) { /* shadow DOM boundary — skip */ }

        // 5. Walk up ancestors looking for a question container — covers Greenhouse,
        //    Lever, Workday, SmartRecruiters, etc. which wrap questions in a section/div
        let ancestor = element.parentElement;
        for (let depth = 0; depth < 8 && ancestor; depth++, ancestor = ancestor.parentElement) {
            // Check preceding siblings of this ancestor for question text
            let sibling = ancestor.previousElementSibling;
            let siblingLimit = 3;
            while (sibling && siblingLimit-- > 0) {
                const text = sibling.textContent.trim();
                // Upper bound guards against grabbing a whole unrelated container's text;
                // 300 was too tight — real employer custom screening questions routinely
                // run past it (e.g. a 444-char multi-part question), so the real label was
                // silently rejected here and the walk-up continued to a wrong/blank one —
                // the AI essay call then answers a different (or empty) question than the
                // one actually shown next to the field.
                if (text.length > 4 && text.length < 600) return text;
                sibling = sibling.previousElementSibling;
            }

            // Check for label/heading elements inside the ancestor (but not inside the field itself)
            // Also checks <th> — iCIMS uses table headers as field labels
            const questionEl = ancestor.querySelector(
                'label, legend, th, h1, h2, h3, h4, h5, h6, [class*="label"], [class*="question"], [class*="title"], [class*="heading"], [class*="field-name"], p'
            );
            if (questionEl && !questionEl.contains(element) && questionEl !== element) {
                const text = questionEl.textContent.trim();
                // Upper bound guards against grabbing a whole unrelated container's text;
                // 300 was too tight — real employer custom screening questions routinely
                // run past it (e.g. a 444-char multi-part question), so the real label was
                // silently rejected here and the walk-up continued to a wrong/blank one —
                // the AI essay call then answers a different (or empty) question than the
                // one actually shown next to the field.
                if (text.length > 4 && text.length < 600) return text;
            }
        }

        // 6. placeholder as last resort
        const placeholder = element.getAttribute('placeholder');
        if (placeholder && placeholder.trim().length > 4) return placeholder.trim();

        return '';
    }


    // EEO default options: these are pre-selected by forms as "safe defaults" but should
    // be overridable by the extension if the candidate has a real answer stored.
    const EEO_DEFAULT_PATTERNS = /prefer not|do not wish|choose not to|decline to self|not specified|do not identify|wish not|i don.t wish/i;

    function hasValue(field, allowEEOOverride) {
        const tagName = field.tagName.toLowerCase();
        const type = (field.getAttribute('type') || '').toLowerCase();

        if (tagName === 'select') {
            const idx = field.selectedIndex;
            if (idx < 0) return false;
            const opt = field.options[idx];
            if (!opt) return false;
            const val = opt.value.trim();
            const text = opt.text.trim().toLowerCase();

            // Placeholder options: always treat as empty
            const isPlaceholder = !val && (
                text === '' || text === '--' || text === '-' || text === 'none' ||
                text.startsWith('select') || text.startsWith('choose') ||
                text.startsWith('please select') || text.startsWith('pick')
            );
            if (isPlaceholder) return false;

            // EEO "Prefer not to say" defaults: treat as empty so the extension
            // can override with the candidate's real answer (if allowEEOOverride=true)
            if (allowEEOOverride && EEO_DEFAULT_PATTERNS.test(text)) return false;

            return true;
        }
        if (type === 'radio') {
            // For radio groups, also allow override of "prefer not to say" default selections
            if (allowEEOOverride && field.checked) {
                const label = field.labels?.[0]?.textContent || field.value || '';
                if (EEO_DEFAULT_PATTERNS.test(label.toLowerCase())) return false;
            }
            return field.checked;
        }
        if (type === 'checkbox') {
            return field.checked;
        }
        return field.value && field.value.trim().length > 0;
    }

    function scheduleHighlightDismiss(seconds) {
        // Clear existing timers
        highlightTimers.forEach(t => clearTimeout(t));
        highlightTimers = [];

        const timer = setTimeout(() => {
            const classes = ['quickapply-filled', 'quickapply-fuzzy', 'quickapply-error'];
            classes.forEach(cls => {
                document.querySelectorAll(`.${cls}`).forEach(el => {
                    el.classList.add('quickapply-dismiss');
                    setTimeout(() => {
                        el.classList.remove(cls, 'quickapply-dismiss');
                    }, 800);
                });
            });
        }, seconds * 1000);

        highlightTimers.push(timer);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Poll until at least one fillable field appears in the DOM (handles Workday SPA rendering).
    // Returns true if fields found, false if timed out.
    async function waitForFields(timeoutMs = 6000, pollMs = 300) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const found = discoverFields(document);
            if (found.length > 0) return true;
            // SmartRecruiters uses Angular web components (spl-*, oc-*) whose inner
            // <input> elements live inside shadow roots — invisible to querySelectorAll.
            // Treat the form as ready when the footer nav buttons appear.
            if (document.querySelector('[data-test="footer-next"], [data-test="footer-submit"]')) return true;
            await sleep(pollMs);
        }
        return false;
    }

    // Deep querySelectorAll that pierces shadow DOM boundaries.
    // Standard querySelectorAll stops at shadow root edges — this traverses them.
    function deepQueryAll(root, selector) {
        const results = [];
        const walk = (node) => {
            try {
                node.querySelectorAll(selector).forEach(el => results.push(el));
                node.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) walk(el.shadowRoot);
                });
            } catch (e) { /* cross-origin or access denied — skip */ }
        };
        walk(root);
        return results;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MUTATION OBSERVER — for dynamically loaded form fields
    // ═══════════════════════════════════════════════════════════════════

    let pendingProfile = null;
    let _lastFillTime = 0;    // timestamp of last handleFill completion
    let _fillInProgress = false; // guard against concurrent fills
    let _fillCount = 0;       // C5 FIX: count fills on this page load to detect runaway refills
    let _cvUploadedThisPageLoad = false; // SR FIX: prevent re-upload when SR re-renders file input
    let _lastFillPayload = null;         // stored so "Fill Missing" in the overlay can re-trigger a fill
    let _lastMissingFingerprints = [];   // fingerprints of error fields from the last fill — used by Fill Missing

    // Disconnect any observer left by a previous injection of this script on the same page.
    // Prevents duplicate fills when popup injects content.js a second time via scripting.executeScript.
    if (window.__quickapply_observer) {
        try { window.__quickapply_observer.disconnect(); } catch (_) { }
    }

    const observer = new MutationObserver((mutations) => {
        if (!currentProfile) return;

        let hasNewFields = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches?.('input, select, textarea') || node.querySelector?.('input, select, textarea')) {
                            hasNewFields = true;
                            break;
                        }
                    }
                }
            }
            if (hasNewFields) break;
        }

        if (hasNewFields) {
            clearTimeout(observer._debounce);
            observer._debounce = setTimeout(() => {
                // Workday stays on the same URL across all form steps — onSPANavigate never fires.
                // Detect step changes by counting [data-automation-id] inputs: each step has different fields.
                // Reset fill guards when count changes so the new step's fields get filled.
                if (_getPlatform() === 'workday') {
                    const _wdCount = document.querySelectorAll('[data-automation-id]').length;
                    if (typeof window.__wdLastCount === 'undefined') window.__wdLastCount = _wdCount;
                    if (_wdCount !== window.__wdLastCount) {
                        window.__wdLastCount = _wdCount;
                        _lastFillTime = 0;   // allow re-fill (module-level, in scope here)
                        _fillCount = 0;      // reset fill counter for new step
                        // Note: _filledProfileFields is local to handleFill — not accessible here.
                        // It resets naturally on the next handleFill() call.
                        // SESSION RECORDER: new Workday step detected
                        if (window.__qa_incrementStep) window.__qa_incrementStep();
                    }
                }

                // SmartRecruiters: Angular multi-step form — URL never changes between steps.
                // Detect step transition by counting visible inputs; a change of >3 means
                // Angular replaced the step content (not just lazy-loading a few extra fields).
                // Reset fill guards so the new step's fields get filled.
                if (_getPlatform() === 'smartrecruiters') {
                    const _srCount = document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
                    if (typeof window.__srLastCount === 'undefined') window.__srLastCount = _srCount;
                    // Only treat a large input-count jump as a genuine step transition when
                    // we are NOT actively filling. preFill clicks "Add" for experience/education,
                    // which adds 7+ new inputs — that's our OWN mutation, not a step change.
                    // Resetting _fillCount here would allow a second preFill run and duplicate entries.
                    if (!_fillInProgress && Math.abs(_srCount - window.__srLastCount) > 3) {
                        window.__srLastCount = _srCount;
                        _lastFillTime = 0;
                        _fillCount = 0;
                    } else {
                        window.__srLastCount = _srCount;
                    }
                }

                if (_fillInProgress) return; // already filling

                // C5 FIX: extended window to 30s (was 5s) — Ashby/SR/Greenhouse post-fill
                // DOM mutations (validation, section reveals) fire 6–21s after initial fill.
                // Also cap at 3 total fills per page load to prevent infinite refill loops.
                if (_fillCount >= 3) return; // disconnect-equivalent: stop triggering refills
                const withinWindow = (Date.now() - _lastFillTime) < 30000;
                const fillProfile = pendingProfile || (withinWindow ? currentProfile : null);

                if (fillProfile) {
                    _fillInProgress = true;
                    // skipCV: true — MutationObserver refills are for lazy-loaded FIELDS only.
                    // CV upload is already done on the initial fill; re-uploading on every
                    // DOM mutation causes an infinite loop (upload → DOM changes → upload → …).
                    handleFill({ profile: fillProfile, skipCV: true }).then(() => {
                        pendingProfile = null;
                        _fillInProgress = false;
                        injectAIFillIcons();
                    }).catch(e => {
                        console.error('[QuickApply] SPA refill failed:', e);
                        pendingProfile = null;
                        _fillInProgress = false;
                    });
                } else {
                    injectAIFillIcons();
                }
            }, 500);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
    window.__quickapply_observer = observer; // store for cleanup on re-injection

    // ── Platform-requested extra pass ────────────────────────────────────
    // The observer above only reacts to ADDED nodes. Some forms reveal fields
    // that were already in the DOM by toggling a wrapper class — Teamtailor's
    // conditional screening questions do exactly that — so no mutation the
    // observer cares about ever fires. A platform filler that detects such a
    // reveal in postFill() can ask for one more pass here.
    // One-shot per page load, and it waits for the in-flight fill (this is
    // called from postFill) to finish before re-entering.
    let _refillRequested = false;
    window.QuickApplyRequestRefill = function requestRefill(reason) {
        if (_refillRequested || !_lastFillPayload) return false;
        _refillRequested = true;
        (async () => {
            for (let i = 0; i < 40 && _fillInProgress; i++) {
                await new Promise(r => setTimeout(r, 250));
            }
            if (_fillInProgress) return;
            console.log(`[QuickApply] platform-requested refill: ${reason}`);
            _fillInProgress = true;
            try {
                const report = await _fillMultiPass({
                    ..._lastFillPayload,
                    skipCV: true,
                    skipDuplicateCheck: true,
                });
                chrome.runtime.sendMessage(report).catch(() => {});
            } catch (e) {
                console.error('[QuickApply] requested refill failed:', e);
            } finally {
                _fillInProgress = false;
            }
        })();
        return true;
    };

    // ═══════════════════════════════════════════════════════════════════
    // SPA PAGE NAVIGATION — iCIMS / CareerPuck multi-page forms
    // When the SPA navigates to a new page (URL hash or path changes),
    // reset the fill window and re-fill if a profile is loaded.
    // This handles iCIMS "Next" button advancing to page 2, 3, etc.
    // ═══════════════════════════════════════════════════════════════════
    let _lastSPAUrl = location.href;

    function onSPANavigate() {
        const newUrl = location.href;
        if (newUrl === _lastSPAUrl) return;
        _lastSPAUrl = newUrl;

        if (!currentProfile) return;

        // Reset fill window AND fill count — new URL = new step, old caps no longer apply
        _lastFillTime = Date.now();
        _fillCount = 0;

        // SESSION RECORDER: SPA navigation = new step
        if (window.__qa_incrementStep) window.__qa_incrementStep();

        // Wait for the new page's fields to render, then fill
        waitForFields(6000, 300).then(ready => {
            if (!ready || _fillInProgress) return;
            _fillInProgress = true;
            handleFill({ profile: currentProfile, skipCV: true }).then(() => {
                _fillInProgress = false;
                injectAIFillIcons();
            }).catch(() => { _fillInProgress = false; });
        });
    }

    window.addEventListener('hashchange', onSPANavigate);
    window.addEventListener('popstate', onSPANavigate);

    // Also patch history.pushState / replaceState (iCIMS uses these)
    ['pushState', 'replaceState'].forEach(method => {
        const original = history[method];
        history[method] = function (...args) {
            original.apply(this, args);
            onSPANavigate();
        };
    });

    // ═══════════════════════════════════════════════════════════════════
    // SESSION RECORDER — Full-fidelity application session capture
    // Records: every field present, every value filled, step navigation,
    // and submit outcome. Stored under quickapply_session_recordings
    // (max 100 entries).
    // ═══════════════════════════════════════════════════════════════════

    let _qaSession = null;
    let _qaStepIndex = 0;
    const _QA_MAX_RECORDINGS = 100;
    const _QA_STORAGE_KEY = 'quickapply_session_recordings';

    function _scanFormFields() {
        const fields = [];
        const seen = new Set();
        document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea'
        ).forEach(el => {
            const key = el.id || el.name || el.getAttribute('data-automation-id') || '';
            if (!key || seen.has(key)) return;
            seen.add(key);
            let label = '';
            if (el.id) {
                const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (lbl) label = lbl.textContent.trim();
            }
            if (!label) label = el.getAttribute('aria-label') || el.placeholder || el.getAttribute('data-automation-id') || '';
            fields.push({
                id: el.id || null,
                name: el.name || null,
                type: el.type || el.tagName.toLowerCase(),
                label: label.slice(0, 120),
                required: el.required || el.getAttribute('aria-required') === 'true',
                automationId: el.getAttribute('data-automation-id') || null,
                value: (el.value || '').slice(0, 300)
            });
        });
        return fields;
    }

    function _getStepLabel() {
        const current = document.querySelector('[data-automation-id*="Step"][aria-current="step"], [class*="current"][data-automation-id*="Step"]');
        if (current) return current.textContent.trim().slice(0, 80);
        const h = document.querySelector('h1, h2, [role="heading"][aria-level="1"]');
        return h ? h.textContent.trim().slice(0, 80) : '';
    }

    function _detectJobInfo() {
        let jobTitle = (document.title || '').split(/[-|–—]/)[0].trim().slice(0, 120);
        let company = '';
        const host = window.location.hostname;
        const wdMatch = host.match(/^([^.]+)\.(wd\d+|myworkday)/);
        if (wdMatch) company = wdMatch[1];
        const og = document.querySelector('meta[property="og:title"]');
        if (og && og.content && og.content.length > jobTitle.length) jobTitle = og.content.trim().slice(0, 120);
        return { jobTitle, company };
    }

    function _startSession(profile, platform) {
        if (_qaSession) return;
        const { jobTitle, company } = _detectJobInfo();
        _qaSession = {
            id: `rec_${Date.now()}_${platform}`,
            platform,
            url: window.location.href,
            jobTitle,
            company,
            clientId: profile.id || null,
            clientName: profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: 'in_progress',
            steps: [],
            _pendingSubmit: false
        };
        _qaStepIndex = 0;

        setTimeout(() => {
            if (!_qaSession || _qaSession.steps.length > 0) return;
            const fields = _scanFormFields();
            if (fields.length === 0) return;
            const step = {
                stepIndex: 0,
                enteredAt: new Date().toISOString(),
                stepLabel: _getStepLabel(),
                fieldsPresent: fields,
                fieldsFilled: [],
                networkRequests: [],
                nextClicked: false,
                nextClickedAt: null,
                nextButtonText: null,
                passive: true
            };
            _qaSession.steps.push(step);
            _attachNavListeners(step);
        }, 3000);
    }

    function _recordStep(fillResults) {
        if (!_qaSession) return;
        const netReqs = [];
        const mappedFills = (fillResults || []).map(r => ({
            fieldName: r.fieldName || null,
            profileField: r.profileField || null,
            value: typeof r.value === 'string' ? r.value.slice(0, 300) : r.value,
            status: r.status,
            strategy: r.strategy || null,
            confidence: r.confidence != null ? Math.round(r.confidence * 100) / 100 : null
        }));

        // If the only existing step is a passive placeholder (created by the 3s timeout before
        // the fill completed), promote it to an active step instead of adding a redundant empty
        // Step 0 before the real fill data. Merge network requests from both windows.
        if (_qaSession.steps.length === 1 && _qaSession.steps[0].passive) {
            const step = _qaSession.steps[0];
            delete step.passive;
            step.fieldsFilled = mappedFills;
            step.fieldsPresent = _scanFormFields();
            step.networkRequests = step.networkRequests.concat(netReqs);
            _attachNavListeners(step);
            return;
        }

        const step = {
            stepIndex: _qaStepIndex,
            enteredAt: new Date().toISOString(),
            stepLabel: _getStepLabel(),
            fieldsPresent: _scanFormFields(),
            fieldsFilled: mappedFills,
            networkRequests: netReqs,
            nextClicked: false,
            nextClickedAt: null,
            nextButtonText: null
        };
        _qaSession.steps.push(step);
        _attachNavListeners(step);
    }

    function _attachNavListeners(step) {
        const NAV_RE = /next|continue|save|proceed|forward|submit|apply|finish|complete|send|review|confirm/i;
        const SUBMIT_RE = /submit|apply|finish|complete|send\s*application|review\s*&?\s*submit|confirm\s*&?\s*submit/i;
        document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(btn => {
            if (btn.__qa_nav_attached) return;
            const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
            if (!NAV_RE.test(text)) return;
            btn.__qa_nav_attached = true;
            btn.addEventListener('click', () => {
                step.nextClicked = true;
                step.nextClickedAt = new Date().toISOString();
                step.nextButtonText = text.slice(0, 60);
                if (_qaSession && SUBMIT_RE.test(text)) {
                    _qaSession._pendingSubmit = true;
                }
            }, { once: true });
        });
    }

    async function _saveSession(outcome) {
        if (!_qaSession) return;
        _qaSession.endedAt = new Date().toISOString();
        _qaSession.outcome = outcome || 'abandoned';
        delete _qaSession._pendingSubmit;
        const session = { ..._qaSession };
        _qaSession = null;
        try {
            const data = await chrome.storage.local.get(_QA_STORAGE_KEY);
            const recordings = data[_QA_STORAGE_KEY] || [];
            recordings.push(session);
            if (recordings.length > _QA_MAX_RECORDINGS) recordings.splice(0, recordings.length - _QA_MAX_RECORDINGS);
            await chrome.storage.local.set({ [_QA_STORAGE_KEY]: recordings });
        } catch (e) {
            if (!/context invalidated/i.test(e.message)) {
                console.error('[QuickApply] Failed to save session recording:', e);
            }
        }
    }

    // ── Save on page unload ──────────────────────────────────────────
    const _SUCCESS_RE = /thank.?you|application.?received|successfully.?submitted|submission.?confirmed|congrat|you.?applied|application.?complete/i;

    function _checkAndSave() {
        if (!_qaSession) return;
        let outcome = 'abandoned';
        if (_qaSession._pendingSubmit) {
            outcome = 'submitted';
        } else {
            const titleText = document.title || '';
            const bodySnippet = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 600) : '';
            const urlStr = window.location.href;
            if (_SUCCESS_RE.test(titleText) || _SUCCESS_RE.test(bodySnippet) || _SUCCESS_RE.test(urlStr)) {
                outcome = 'submitted';
            }
        }
        _saveSession(outcome);
    }

    window.addEventListener('beforeunload', _checkAndSave);

    // ── SPA navigation save (Ashby/React Router) ─────────────────────
    // Ashby uses history.pushState for client-side routing — beforeunload never fires
    // when the form submits and navigates to the confirmation route. Intercept pushState
    // so recording is saved whenever the URL changes while a session is active.
    try {
        const _origPush = history.pushState.bind(history);
        history.pushState = function (...args) {
            _origPush(...args);
            if (_qaSession) {
                // Give the new route 500 ms to render success text, then save
                setTimeout(_checkAndSave, 500);
            }
        };
        const _origReplace = history.replaceState.bind(history);
        history.replaceState = function (...args) {
            _origReplace(...args);
            if (_qaSession) setTimeout(_checkAndSave, 500);
        };
    } catch (_) { /* CSP may block History API patching — safe to ignore */ }

    window.addEventListener('popstate', () => {
        if (_qaSession) setTimeout(_checkAndSave, 500);
    });

    // ── Expose to handleFill and MutationObserver ────────────────────
    window.__qa_startSession = _startSession;
    window.__qa_recordStep = _recordStep;
    window.__qa_incrementStep = () => { _qaStepIndex++; };
    window.__qa_saveSession = _saveSession;

    // ═══════════════════════════════════════════════════════════════════
    // SIDE WIDGET — sticky floating panel injected into ATS pages
    // ═══════════════════════════════════════════════════════════════════

    let _sideWidgetHost = null;
    let _sideWidgetShadow = null;
    let _sideWidgetProfile = null;

    /** Returns false when the extension was reloaded/updated — chrome APIs will throw. */
    function _isExtCtxValid() {
        try { return !!chrome.runtime.id; } catch (_) { return false; }
    }

    function injectSideWidget() {
        if (_sideWidgetHost) return;
        try { if (window.self !== window.top) return; } catch (_) { return; }

        _sideWidgetHost = document.createElement('div');
        _sideWidgetHost.id = 'qa-side-widget-host';
        // Use !important to beat any page CSS that might reset position/z-index.
        // Width = tab only (36px); panel overflows to the left with overflow:visible.
        // No display:flex — shadow DOM content sizes the host via min-height.
        // No pointer-events:none — that blocks shadow DOM children in some browsers.
        _sideWidgetHost.setAttribute('style',
            'all:unset!important;' +
            'position:fixed!important;' +
            'right:0!important;' +
            'top:50%!important;' +
            'transform:translateY(-50%)!important;' +
            'z-index:2147483647!important;' +
            'width:36px!important;' +
            'min-height:90px!important;' +
            'overflow:visible!important;' +
            'display:block!important;'
        );

        _sideWidgetShadow = _sideWidgetHost.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
            :host { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }

            /* Wrapper — positioning context for absolute children */
            #qa-widget {
                position:relative;
                width:36px;
                min-height:90px;
            }

            /* ── TAB (always visible, peeks from right edge) ── */
            #qa-tab {
                position:absolute;
                top:0; right:0;
                width:36px;
                height:100%;
                min-height:90px;
                border-radius:10px 0 0 10px;
                background:linear-gradient(160deg,#7C6AFF 0%,#5B4ED9 100%);
                cursor:pointer;
                display:flex;
                flex-direction:column;
                align-items:center;
                justify-content:center;
                gap:6px;
                box-shadow:-3px 0 12px rgba(92,78,217,.35);
                transition:background .15s ease;
                user-select:none;
            }
            #qa-tab:hover { background:linear-gradient(160deg,#8B7BFF 0%,#6A5EE8 100%); }

            #qa-tab-logo {
                width:20px;
                height:20px;
                border-radius:5px;
                background:#fff;
                display:flex;
                align-items:center;
                justify-content:center;
                font-size:9px;
                font-weight:800;
                color:#7C6AFF;
                letter-spacing:-.5px;
            }
            #qa-tab-initials {
                font-size:10px;
                font-weight:700;
                color:rgba(255,255,255,.9);
                letter-spacing:.5px;
                line-height:1;
            }
            #qa-tab-chevron {
                font-size:10px;
                color:rgba(255,255,255,.6);
                line-height:1;
                transition:transform .25s ease;
            }
            .qa-open #qa-tab-chevron { transform:rotate(180deg); }

            /* ── PANEL — absolutely positioned, slides in from right ── */
            #qa-panel {
                position:absolute;
                top:50%;
                right:36px;
                transform:translateY(-50%) translateX(100%);
                width:272px;
                max-height:82vh;
                background:#fff;
                border-radius:14px 0 0 14px;
                box-shadow:-6px 0 28px rgba(0,0,0,.18);
                transition:transform .25s cubic-bezier(.4,0,.2,1), opacity .2s;
                opacity:0;
                pointer-events:none;
                overflow:hidden;
                overscroll-behavior:contain;
                display:flex;
                flex-direction:column;
            }
            .qa-open #qa-panel {
                transform:translateY(-50%) translateX(0);
                opacity:1;
                pointer-events:auto;
            }

            /* ── PANEL BODY — must be a bounded flex child so inner list can scroll ── */
            #qa-panel-body {
                flex:1;
                min-height:0;
                display:flex;
                flex-direction:column;
                overflow:hidden;
            }

            /* ── PANEL HEADER ── */
            .qa-header {
                background:linear-gradient(135deg,#7C6AFF 0%,#5B4ED9 100%);
                padding:12px 14px 10px;
                display:flex;
                align-items:center;
                justify-content:space-between;
                flex-shrink:0;
            }
            .qa-header-brand {
                display:flex;
                align-items:center;
                gap:7px;
            }
            .qa-header-icon {
                width:22px;
                height:22px;
                border-radius:6px;
                background:#fff;
                display:flex;
                align-items:center;
                justify-content:center;
                font-size:9px;
                font-weight:800;
                color:#7C6AFF;
            }
            .qa-header-title {
                color:#fff;
                font-size:13px;
                font-weight:700;
                letter-spacing:.2px;
            }
            .qa-close-btn {
                width:24px;
                height:24px;
                border-radius:50%;
                background:rgba(255,255,255,.2);
                border:none;
                color:#fff;
                font-size:15px;
                cursor:pointer;
                display:flex;
                align-items:center;
                justify-content:center;
                line-height:1;
                transition:background .15s;
            }
            .qa-close-btn:hover { background:rgba(255,255,255,.35); }

            /* ── CLIENT SECTION ── */
            .qa-client-row {
                padding:12px 14px 10px;
                display:flex;
                align-items:center;
                gap:10px;
                border-bottom:1px solid #F3F0FF;
                flex-shrink:0;
            }
            .qa-avatar {
                width:38px;
                height:38px;
                border-radius:50%;
                display:flex;
                align-items:center;
                justify-content:center;
                font-size:13px;
                font-weight:700;
                border:2px solid currentColor;
                flex-shrink:0;
                line-height:1;
            }
            .qa-client-info { flex:1; min-width:0; }
            .qa-client-name {
                font-size:13px;
                font-weight:700;
                color:#1A1A2E;
                display:flex;
                align-items:center;
                gap:5px;
                min-width:0;
            }
            .qa-client-name-text {
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                flex:1;
                min-width:0;
            }
            .qa-counter {
                display:inline-flex;
                align-items:center;
                gap:2px;
                flex-shrink:0;
            }
            .qa-counter-btn {
                width:15px;
                height:15px;
                border-radius:4px;
                border:none;
                background:#EEE9FF;
                color:#7C6AFF;
                font-size:13px;
                font-weight:700;
                cursor:pointer;
                display:flex;
                align-items:center;
                justify-content:center;
                line-height:1;
                padding:0;
                transition:background .12s;
                flex-shrink:0;
                user-select:none;
            }
            .qa-counter-btn:hover { background:#D9D0FF; }
            .qa-counter-btn:active { background:#C4B8FF; }
            .qa-job-count {
                display:inline-flex;
                align-items:center;
                justify-content:center;
                background:#7C6AFF;
                color:#fff;
                font-size:9px;
                font-weight:800;
                border-radius:20px;
                padding:1px 5px;
                min-width:16px;
                height:15px;
                line-height:1;
                letter-spacing:.2px;
                flex-shrink:0;
                white-space:nowrap;
            }
            .qa-client-email-small {
                font-size:11px;
                color:#8B7EAA;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                margin-top:1px;
            }
            .qa-switch-btn {
                font-size:10px;
                color:#7C6AFF;
                background:none;
                border:1px solid #E8E4FF;
                border-radius:6px;
                padding:3px 7px;
                cursor:pointer;
                font-weight:600;
                white-space:nowrap;
                flex-shrink:0;
                transition:background .15s;
            }
            .qa-switch-btn:hover { background:#F3F0FF; }

            /* ── INFO LIST ── */
            .qa-info-list {
                padding:10px 14px 6px;
                display:flex;
                flex-direction:column;
                gap:4px;
                overflow-y:auto;
                overscroll-behavior:contain;
                flex:1;
                min-height:0;
            }
            .qa-info-row {
                display:flex;
                align-items:center;
                gap:8px;
                padding:6px 8px;
                border-radius:8px;
                transition:background .12s;
            }
            .qa-info-row:hover { background:#F9F7FF; }
            .qa-info-icon {
                width:26px;
                height:26px;
                border-radius:7px;
                background:#F3F0FF;
                display:flex;
                align-items:center;
                justify-content:center;
                font-size:12px;
                flex-shrink:0;
            }
            .qa-info-content { flex:1; min-width:0; }
            .qa-info-label {
                font-size:9.5px;
                color:#A094C0;
                text-transform:uppercase;
                letter-spacing:.5px;
                font-weight:600;
                line-height:1;
                margin-bottom:2px;
            }
            .qa-info-value {
                font-size:12px;
                color:#2D2B4E;
                font-weight:500;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                line-height:1.3;
            }
            .qa-copy-btn {
                width:26px;
                height:26px;
                border:none;
                background:none;
                cursor:pointer;
                border-radius:6px;
                display:flex;
                align-items:center;
                justify-content:center;
                color:#B0A8D0;
                font-size:12px;
                flex-shrink:0;
                transition:background .12s,color .12s;
                padding:0;
            }
            .qa-copy-btn:hover { background:#EEE9FF; color:#7C6AFF; }
            .qa-copy-btn.copied { color:#22C55E !important; background:#F0FDF4 !important; }

            /* ── ACTIONS ── */
            .qa-actions {
                padding:10px 14px 14px;
                display:flex;
                flex-direction:column;
                gap:8px;
                flex-shrink:0;
                border-top:1px solid #F3F0FF;
            }
            .qa-fill-btn {
                width:100%;
                padding:10px 0;
                background:linear-gradient(135deg,#7C6AFF 0%,#5B4ED9 100%);
                color:#fff;
                border:none;
                border-radius:10px;
                font-size:13px;
                font-weight:700;
                cursor:pointer;
                display:flex;
                align-items:center;
                justify-content:center;
                gap:6px;
                transition:opacity .15s,transform .1s;
                letter-spacing:.2px;
            }
            .qa-fill-btn:hover { opacity:.9; transform:translateY(-1px); }
            .qa-fill-btn:active { transform:translateY(0); opacity:1; }
            .qa-fill-btn:disabled { opacity:.5; cursor:default; transform:none; }

            /* ── STATUS TOAST ── */
            .qa-status {
                padding:0 14px;
                font-size:11px;
                color:#5B4ED9;
                font-weight:600;
                text-align:center;
                min-height:0;
                transition:all .2s;
                overflow:hidden;
                max-height:0;
            }
            .qa-status.visible {
                max-height:30px;
                padding-bottom:10px;
            }

            /* ── NO CLIENT STATE ── */
            .qa-no-client {
                padding:20px 14px;
                text-align:center;
                color:#A094C0;
                font-size:12px;
                line-height:1.5;
            }
        `;

        const tpl = document.createElement('div');
        tpl.id = 'qa-widget';
        tpl.innerHTML = `
            <div id="qa-tab" title="QuickApply">
                <div id="qa-tab-logo">QA</div>
                <div id="qa-tab-initials">--</div>
                <div id="qa-tab-chevron">&#9664;</div>
            </div>
            <div id="qa-panel">
                <div class="qa-header">
                    <div class="qa-header-brand">
                        <div class="qa-header-icon">QA</div>
                        <span class="qa-header-title">QuickApply</span>
                    </div>
                    <button class="qa-close-btn" id="qa-close" title="Close">&#x2715;</button>
                </div>
                <div id="qa-panel-body">
                    <div class="qa-no-client">No active client.<br>Open Dashboard to select one.</div>
                </div>
            </div>
        `;

        _sideWidgetShadow.appendChild(style);
        _sideWidgetShadow.appendChild(tpl);
        // Append directly to <html> instead of <body>. React rewrites document.body
        // during hydration error recovery (Remix / Next.js apps) and would wipe a
        // body-attached widget; <html>'s children outside body are safe. The widget
        // is position:fixed so visual placement is unaffected.
        (document.documentElement || document.body).appendChild(_sideWidgetHost);

        // Self-heal: SPA hydration on Remix / Next.js (e.g. job-boards.greenhouse.io)
        // can wipe our widget mid-rerender via a route that bypasses childList
        // mutations on <html> — a MutationObserver scoped to documentElement misses
        // those. Poll for ~30s post-injection, re-appending whenever the host
        // detaches. After 30s the page has long since settled; stop polling.
        let _healAttempts = 0;
        const _healMax = 30;
        const _healTimer = setInterval(() => {
            _healAttempts++;
            if (_healAttempts > _healMax) { clearInterval(_healTimer); return; }
            if (!_sideWidgetHost) { clearInterval(_healTimer); return; }
            if (_sideWidgetHost.isConnected) return;
            try { (document.documentElement || document.body).appendChild(_sideWidgetHost); } catch (_) {}
        }, 1000);

        // ── Events ──
        const getEl = (id) => _sideWidgetShadow.getElementById(id);
        const widget = getEl('qa-widget');

        function togglePanel() {
            const isOpen = widget.classList.contains('qa-open');
            widget.classList.toggle('qa-open', !isOpen);
            try { sessionStorage.setItem('_qa_widget_open', !isOpen ? '1' : '0'); } catch (_) { }
        }

        getEl('qa-tab').addEventListener('click', togglePanel);
        getEl('qa-close').addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });

        // Auto-fold after 5s of mouse being outside the widget
        let _autoFoldTimer = null;

        function _clearAutoFold() {
            if (_autoFoldTimer) { clearTimeout(_autoFoldTimer); _autoFoldTimer = null; }
        }

        function _scheduleAutoFold() {
            _clearAutoFold();
            if (widget.classList.contains('qa-open')) {
                _autoFoldTimer = setTimeout(() => {
                    widget.classList.remove('qa-open');
                    try { sessionStorage.setItem('_qa_widget_open', '0'); } catch (_) { }
                }, 5000);
            }
        }

        // Use the host element for mouseleave/mouseenter since shadow DOM
        // pointer events bubble out through the host boundary
        _sideWidgetHost.addEventListener('mouseenter', _clearAutoFold);
        _sideWidgetHost.addEventListener('mouseleave', _scheduleAutoFold);

        // Restore open state
        try {
            if (sessionStorage.getItem('_qa_widget_open') === '1') {
                widget.classList.add('qa-open');
            }
        } catch (_) { }
    }

    function _buildAddress(p) {
        const parts = [p.streetAddress, p.city, p.state, p.zipCode, p.country].filter(Boolean);
        return parts.join(', ');
    }

    function _escHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function updateSideWidget(profile) {
        if (!_sideWidgetShadow) return;
        _sideWidgetProfile = profile;

        const getEl = (id) => _sideWidgetShadow.getElementById(id);
        const widget = getEl('qa-widget');
        if (!widget) return;

        const tabInitials = getEl('qa-tab-initials');
        const panelBody = getEl('qa-panel-body');

        if (!profile) {
            tabInitials.textContent = '??';
            panelBody.innerHTML = `<div class="qa-no-client">No active client.<br>Open Dashboard to select one.</div>`;
            return;
        }

        // Tab initials
        const initials = ((profile.firstName||'').charAt(0) + (profile.lastName||'').charAt(0)).toUpperCase() || 'QA';
        tabInitials.textContent = initials;

        const color = profile.avatarColor || '#7C6AFF';
        const jobCount = await _getJobCount(profile.id);
        const addr = _buildAddress(profile);

        // Build info rows
        const infoRows = [];
        if (profile.email) {
            infoRows.push({ icon: '✉', label: 'Email', value: profile.email, copy: profile.email });
        }
        if (profile.phone) {
            infoRows.push({ icon: '📞', label: 'Phone', value: profile.phone, copy: profile.phone });
        }
        if (addr) {
            infoRows.push({ icon: '📍', label: 'Address', value: addr, copy: addr });
        }
        if (profile.linkedIn) {
            const liDisplay = profile.linkedIn.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, 'linkedin.com/');
            infoRows.push({ icon: '🔗', label: 'LinkedIn', value: liDisplay, copy: profile.linkedIn });
        }
        if (profile.github) {
            const ghDisplay = profile.github.replace(/^https?:\/\/(www\.)?/i, '');
            infoRows.push({ icon: '💻', label: 'GitHub', value: ghDisplay, copy: profile.github });
        }

        const rowsHtml = infoRows.map((row, i) => `
            <div class="qa-info-row">
                <div class="qa-info-icon">${row.icon}</div>
                <div class="qa-info-content">
                    <div class="qa-info-label">${_escHtml(row.label)}</div>
                    <div class="qa-info-value" title="${_escHtml(row.value)}">${_escHtml(row.value)}</div>
                </div>
                <button class="qa-copy-btn" data-copy-idx="${i}" title="Copy ${_escHtml(row.label)}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
            </div>
        `).join('');

        panelBody.innerHTML = `
            <div class="qa-client-row">
                <div class="qa-avatar" style="color:${_escHtml(color)};border-color:${_escHtml(color)}">${_escHtml(initials)}</div>
                <div class="qa-client-info">
                    <div class="qa-client-name"><span class="qa-client-name-text">${_escHtml(profile.fullName || profile.firstName || 'Client')}</span><div class="qa-counter"><button class="qa-counter-btn" id="qa-counter-minus" title="Remove 1 job">−</button><span class="qa-job-count" id="qa-job-count">${jobCount}</span><button class="qa-counter-btn" id="qa-counter-plus" title="Add 1 job">+</button></div></div>
                    <div class="qa-client-email-small">${_escHtml(profile.email || '')}</div>
                </div>
                <button class="qa-switch-btn" id="qa-switch-btn">Switch</button>
            </div>
            <div class="qa-info-list" id="qa-info-list">${rowsHtml}</div>
            <div class="qa-actions">
                <button class="qa-fill-btn" id="qa-fill-btn">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    Fill Form
                </button>
            </div>
            <div class="qa-status" id="qa-status"></div>
        `;

        // ── Copy button events ──
        const copyValues = infoRows.map(r => r.copy);
        panelBody.querySelectorAll('.qa-copy-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-copy-idx'), 10);
                const val = copyValues[idx];
                if (!val) return;
                try {
                    await navigator.clipboard.writeText(val);
                    btn.classList.add('copied');
                    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
                    setTimeout(() => {
                        btn.classList.remove('copied');
                        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
                    }, 2000);
                } catch (_) { /* clipboard blocked */ }
            });
        });

        // ── Counter +/− buttons ──
        panelBody.querySelector('#qa-counter-plus')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!_isExtCtxValid()) return;
            const newCount = await _adjustJobCounter(profile.id, +1);
            _updateJobCountBadge(newCount);
        });
        panelBody.querySelector('#qa-counter-minus')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!_isExtCtxValid()) return;
            const newCount = await _adjustJobCounter(profile.id, -1);
            _updateJobCountBadge(newCount);
        });

        // ── Switch client — show inline client list inside the panel ──
        const switchBtn = panelBody.querySelector('#qa-switch-btn');
        if (switchBtn) {
            switchBtn.addEventListener('click', async () => {
                if (!_isExtCtxValid()) { _showWidgetStatus('Reload page to use QuickApply'); return; }
                let allClients = [];
                try { allClients = await QuickApplyStorage.getClients(); } catch (_) { }
                if (!allClients.length) return;

                // Load all job counters in one storage read
                let allCounters = {};
                try {
                    const cr = await new Promise(res => chrome.storage.local.get(['quickapply_job_counters'], d => res(d)));
                    allCounters = cr.quickapply_job_counters || {};
                } catch (_) { }

                // Render a mini client-picker inside the panel body
                panelBody.innerHTML = `
                    <div class="qa-client-row" style="border-bottom:none;padding-bottom:6px;">
                        <button class="qa-switch-btn" id="qa-picker-back" style="margin-right:auto;">&#8592; Back</button>
                        <span style="font-size:12px;font-weight:700;color:#1A1A2E;">Select Client</span>
                    </div>
                    <div class="qa-info-list" id="qa-client-picker" style="gap:2px;padding-top:4px;">
                        ${allClients.map(c => {
                            const ini = ((c.firstName||'').charAt(0) + (c.lastName||'').charAt(0)).toUpperCase() || 'QA';
                            const col = c.avatarColor || '#7C6AFF';
                            const isActive = _sideWidgetProfile && c.id === _sideWidgetProfile.id;
                            const cnt = (allCounters[c.id] && allCounters[c.id].count) || 0;
                            return `<div class="qa-info-row" data-client-id="${_escHtml(c.id)}" style="cursor:pointer;${isActive ? 'background:#F3F0FF;' : ''}">
                                <div class="qa-avatar" style="color:${_escHtml(col)};border-color:${_escHtml(col)};width:32px;height:32px;font-size:11px;flex-shrink:0;">${_escHtml(ini)}</div>
                                <div class="qa-info-content">
                                    <div class="qa-info-value" style="font-weight:${isActive ? '700' : '500'};display:flex;align-items:center;gap:5px;">${_escHtml(c.fullName || c.firstName || 'Client')}${cnt > 0 ? `<span class="qa-job-count">${cnt}</span>` : ''}</div>
                                    <div class="qa-info-label" style="margin-top:2px;text-transform:none;letter-spacing:0;">${_escHtml(c.email || '')}</div>
                                </div>
                                ${isActive ? '<span style="color:#7C6AFF;font-size:11px;font-weight:700;">✓</span>' : ''}
                            </div>`;
                        }).join('')}
                    </div>
                `;

                // Back button
                panelBody.querySelector('#qa-picker-back').addEventListener('click', () => {
                    updateSideWidget(_sideWidgetProfile);
                });

                // Client row click — select and switch
                panelBody.querySelectorAll('[data-client-id]').forEach(row => {
                    row.addEventListener('click', async () => {
                        const cid = row.getAttribute('data-client-id');
                        const chosen = allClients.find(c => c.id === cid);
                        if (!chosen) return;
                        // Persist selection (same as popup does)
                        try { if (_isExtCtxValid()) chrome.storage.local.set({ activeClientId: cid }); } catch (_) { }
                        currentProfile = chosen;
                        updateSideWidget(chosen);
                    });
                });
            });
        }

        // ── Fill Form ──
        const fillBtn = panelBody.querySelector('#qa-fill-btn');
        if (fillBtn) {
            fillBtn.addEventListener('click', async () => {
                if (!_isExtCtxValid()) { _showWidgetStatus('Reload page to use QuickApply'); return; }
                if (_fillInProgress) {
                    _showWidgetStatus('Fill already in progress…');
                    return;
                }
                fillBtn.disabled = true;
                fillBtn.textContent = 'Filling…';
                _showWidgetStatus('');
                _fillInProgress = true; // block observer refills racing this fill (reset in finally)

                // Collapse panel immediately so it never blocks form buttons
                const _widgetEl = _sideWidgetShadow.getElementById('qa-widget');
                if (_widgetEl) {
                    _widgetEl.classList.remove('qa-open');
                    try { sessionStorage.setItem('_qa_widget_open', '0'); } catch (_) { }
                }

                try {
                    const settings = await QuickApplyStorage.getSettings().catch(() => ({}));
                    // skipDuplicateCheck: an explicit Fill-button click is a deliberate
                    // request to fill THIS page. The duplicate-application guard exists to
                    // warn before re-applying — it must not block multi-step forms (Workday
                    // keeps one jobKey across My Information → My Experience → …; step 1's
                    // fill writes the dedup entry, which otherwise bailed every later step).
                    const report = await _fillMultiPass({ profile: _sideWidgetProfile, settings, skipDuplicateCheck: true });
                    const s = report && report.summary;
                    // Show result on the tab badge only — never re-open panel after fill
                    // so the panel never blocks form buttons the user needs to click.
                    _showWidgetTabBadge(s ? `✓${s.filled}` : '✓');
                    // Increment job counter (URL dedup — same origin+pathname = 1 job)
                    if (_sideWidgetProfile && _sideWidgetProfile.id) {
                        const newCount = await _incrementJobCounter(_sideWidgetProfile.id, window.location.href);
                        _updateJobCountBadge(newCount);
                    }
                } catch (err) {
                    _showWidgetStatus('Error: ' + (err.message || 'unknown'));
                } finally {
                    _fillInProgress = false;
                    fillBtn.disabled = false;
                    fillBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg> Fill Form';
                }
            });
        }
    }

    function _showWidgetStatus(msg) {
        if (!_sideWidgetShadow) return;
        const el = _sideWidgetShadow.querySelector('#qa-status');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('visible', !!msg);
    }

    /** Get the job application count for a client from storage. */
    async function _getJobCount(clientId) {
        if (!clientId || !_isExtCtxValid()) return 0;
        try {
            const r = await new Promise(res => chrome.storage.local.get(['quickapply_job_counters'], d => res(d)));
            const all = r.quickapply_job_counters || {};
            return (all[clientId] && all[clientId].count) || 0;
        } catch (_) { return 0; }
    }

    /**
     * Increment job counter for a client, deduplicating by normalized URL.
     * Multi-page forms (same origin+pathname) count as 1 job.
     * Returns the new count.
     */
    async function _incrementJobCounter(clientId, rawUrl) {
        if (!clientId || !rawUrl || !_isExtCtxValid()) return 0;
        try {
            const normUrl = (() => { try { const u = new URL(rawUrl); return u.origin + u.pathname; } catch (_) { return rawUrl; } })();
            const r = await new Promise(res => chrome.storage.local.get(['quickapply_job_counters'], d => res(d)));
            const all = r.quickapply_job_counters || {};
            const entry = all[clientId] || { count: 0, urls: [] };
            if (!entry.urls.includes(normUrl)) {
                entry.urls.push(normUrl);
                entry.count = entry.urls.length;
                all[clientId] = entry;
                await new Promise(res => chrome.storage.local.set({ quickapply_job_counters: all }, res));
            }
            return entry.count;
        } catch (_) { return 0; }
    }

    /** Update the job count badge in the widget without a full re-render. */
    function _updateJobCountBadge(count) {
        if (!_sideWidgetShadow) return;
        const badge = _sideWidgetShadow.getElementById('qa-job-count');
        if (!badge) return;
        badge.textContent = count;
    }

    /**
     * Manually adjust job counter by delta (+1 or -1), bypassing URL dedup.
     * Used by the +/− buttons for manual correction.
     */
    async function _adjustJobCounter(clientId, delta) {
        if (!clientId || !_isExtCtxValid()) return 0;
        try {
            const r = await new Promise(res => chrome.storage.local.get(['quickapply_job_counters'], d => res(d)));
            const all = r.quickapply_job_counters || {};
            const entry = all[clientId] || { count: 0, urls: [] };
            entry.count = Math.max(0, entry.count + delta);
            all[clientId] = entry;
            await new Promise(res => chrome.storage.local.set({ quickapply_job_counters: all }, res));
            return entry.count;
        } catch (_) { return 0; }
    }

    /** Show a brief success badge on the tab itself without opening the panel. */
    function _showWidgetTabBadge(text) {
        if (!_sideWidgetShadow) return;
        const initials = _sideWidgetShadow.getElementById('qa-tab-initials');
        if (!initials) return;
        const orig = initials.textContent;
        const origColor = initials.style.color;
        initials.textContent = text;
        initials.style.color = '#4ade80'; // green
        setTimeout(() => {
            initials.textContent = orig;
            initials.style.color = origColor;
        }, 4000);
    }

    // ── Wire into initializeProfile ──
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.activeClientId && _sideWidgetShadow) {
            // Profile will be updated by initializeProfile → currentProfile → updateSideWidget
            setTimeout(() => updateSideWidget(currentProfile), 300);
        }
    });

    // Bootstrap widget after DOM ready, then refresh with profile
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectSideWidget();
            setTimeout(() => updateSideWidget(currentProfile), 500);
        });
    } else {
        injectSideWidget();
        setTimeout(() => updateSideWidget(currentProfile), 500);
    }

    // Also patch initializeProfile to refresh widget when profile loads
    const _origInit = initializeProfile;
    // eslint-disable-next-line no-func-assign
    initializeProfile = async function () {
        if (!_isExtCtxValid()) return;
        try { await _origInit(); } catch (e) {
            if (!/context invalidated/i.test(e.message)) throw e;
            return;
        }
        updateSideWidget(currentProfile);
    };

    // ── Job Analyzer hook ────────────────────────────────────────────────
    (function _setupJdExtractor() {
        function run() {
            if (window.QuickApplyJdExtractor) {
                window.QuickApplyJdExtractor.maybeExtract().catch(() => {});
            }
        }
        // Force a fresh extraction even when the URL hasn't changed — needed for
        // the embed iframe case where the title H1 renders AFTER content scripts
        // load, so the first extract() captures body but no title.
        function forceRun() {
            if (window.QuickApplyJdExtractor) {
                window.QuickApplyJdExtractor.extract().catch(() => {});
            }
        }
        // Initial extraction once DOM has settled
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(run, 200);
        } else {
            window.addEventListener('DOMContentLoaded', () => setTimeout(run, 200));
        }
        // SPA navigation (Workday)
        window.addEventListener('popstate', () => setTimeout(run, 400));
        // Title-change heuristic — fires when JD content swaps in. Use forceRun
        // because Workday SPA + Greenhouse-embed both swap the title without
        // navigation, and maybeExtract's URL dedup would otherwise refuse.
        let lastTitle = document.title;
        new MutationObserver(() => {
            if (document.title !== lastTitle) { lastTitle = document.title; setTimeout(forceRun, 400); }
        }).observe(document.querySelector('title') || document.head, { childList: true, subtree: true });
    })();

})();
