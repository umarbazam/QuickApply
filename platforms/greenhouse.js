(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    const CONSENT_TEXT_RX = /\b(consent|i agree|i accept|acknowledge|privacy policy|data retention|by checking this box)\b/i;

    function _isVisibleElement(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
    }

    function _hasGreenhouseApplicationFrame() {
        // Match the actual iframe only — an empty <div id="grnhse_app">
        // placeholder (Samsara-style lazy-loaded embeds) is NOT a ready frame.
        return !!document.querySelector('iframe[src*="job-boards.greenhouse.io"], iframe[src*="greenhouse.io"], iframe#grnhse_iframe, iframe[id^="grnhse_"]');
    }

    function _hasGreenhouseApplicationFields() {
        return !!document.querySelector([
            'input[name="first_name"]',
            'input[name="last_name"]',
            'input[name="email"]',
            'input[name="phone"]',
            'input[type="file"]',
            'textarea[name*="cover_letter" i]',
            'form[action*="greenhouse" i]'
        ].join(', '));
    }

    function _findGreenhouseLauncher() {
        const launcher = document.querySelector('[data-id="grnhse_app"]');
        if (launcher && _isVisibleElement(launcher)) return launcher;

        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
            .filter(_isVisibleElement)
            .filter(el => !el.closest('form'));

        return buttons.find(el => {
            const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt) return false;
            const idText = `${el.id || ''} ${el.getAttribute('data-id') || ''}`.toLowerCase();
            if (/submit|continue|next|save/.test(idText)) return false;
            return /^apply now$/i.test(txt) || /^apply$/i.test(txt) || /\bapply now\b/i.test(txt);
        }) || null;
    }

    // Read a react-select's COMMITTED value — the `.select__single-value` div.
    // Empty string means the dropdown has no selection (the engine typing
    // filter text into `.select__input` does NOT commit a value).
    function _ghComboValue(inputEl) {
        if (!inputEl) return '';
        const c = inputEl.closest('[class*="select__container"], .select-shell, [class*="select-shell"]');
        if (!c) return '';
        const single = c.querySelector('[class*="single-value"], [class*="singleValue"]');
        if (single?.textContent?.trim()) return single.textContent.trim();
        // react-select multi-select stores committed values as chips
        // (`.select__multi-value__label`). "How did you learn about this job?"
        // on modern Greenhouse renders as multi even when one answer is
        // expected, so we must check chip labels too — otherwise _ghComboValue
        // returns empty for filled fields and the catch-all marks them failed.
        const chips = c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue__label"]');
        if (chips.length) return Array.from(chips).map(x => x.textContent.trim()).filter(Boolean).join(', ');
        return '';
    }

    // ── React-Select fill helper ──────────────────────────────────────────────
    // Greenhouse dropdowns are react-select: the visible `.select__input` is a
    // FILTER box, not a value holder — setting `.value` types filter text that
    // react-select discards on blur. The only reliable fill is open-menu →
    // click-option. This helper tries fill-engine's combobox path first, then
    // a direct open+click fallback, and — critically — VERIFIES the
    // `.select__single-value` actually committed before returning true (so the
    // caller never reports a false success).
    //   force=true  → re-fill even if a value is already present; first clicks
    //                 the `.select__clear-indicator` to drop the stale value.
    //                 Used for the Country field, which can pick up a stray
    //                 "+1" from the intl-tel-input phone widget.
    async function _ghFillCombo(inputEl, targetText, force = false) {
        if (!inputEl) return false;
        // Accept an array of candidate target strings — used when the option
        // text isn't predictable (consent dropdowns can be "Yes" / "I Agree"
        // / "I Acknowledge" depending on the company's form). Tries each in
        // order, picking the first that resolves to an actual option.
        const _candidates = Array.isArray(targetText)
            ? targetText.filter(Boolean).map(String)
            : (targetText != null && targetText !== '' ? [String(targetText)] : []);
        if (!_candidates.length) return false;
        for (let _ci = 0; _ci < _candidates.length; _ci++) {
            const _ok = await _ghFillComboSingle(inputEl, _candidates[_ci], force && _ci === 0);
            if (_ok) return true;
            // Clear any stale filter text the previous attempt may have typed
            // into the select__input. react-select keeps that text between
            // open/close cycles; without clearing, the next open shows an
            // empty filtered menu and the next candidate can't match.
            try {
                const _input = inputEl.closest('[class*="select__container"], .select-shell, [class*="select-shell"]')
                    ?.querySelector('input.select__input, input[class*="select__input"]') || inputEl;
                if (_input.value) {
                    _input.focus();
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(_input, '');
                    _input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
                }
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 150));
            } catch (_) {}
        }
        return false;
    }

    async function _ghFillComboSingle(inputEl, targetText, force = false) {
        if (!inputEl || !targetText) return false;
        const container = inputEl.closest('[class*="select__container"], .select-shell, [class*="select-shell"]');

        const existing = _ghComboValue(inputEl);
        if (existing && !force) return true;            // already committed
        if (existing && force) {
            // Clear the stale value so the option click registers cleanly.
            const clearEl = container?.querySelector('[class*="clear-indicator"], [class*="clearIndicator"]');
            if (clearEl) {
                try { clearEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
                try { clearEl.click(); } catch (_) {}
                await delay(150);
            }
        }

        // Preferred path — TRUSTED browser-side click via CDP. react-select v5
        // on modern Greenhouse only renders its option menu in response to an
        // `event.isTrusted === true` pointer event; synthetic clicks open the
        // visible control but leave the menu unpopulated. The bridge in
        // trusted-input.js routes through chrome.debugger to deliver real
        // browser-originated events. If unavailable (extension permission
        // revoked, etc.) we fall through to the synthetic paths below.
        const _trusted = window.QuickApplyTrustedInput;
        if (_trusted && await _trusted.available()) {
            const _openEl = inputEl.closest('[class*="select__control"]') || container;
            if (_openEl && await _trusted.click(_openEl)) {
                // Generous wait for the menu to render — short lists (Yes/No)
                // sometimes need >500ms before react-select paints `[role=option]`.
                await delay(700);
                const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
                const _nt = _norm(targetText);
                const _visibleOpts = () => Array.from(document.querySelectorAll('[role="option"]'))
                    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                const _pick = (opts) =>
                    opts.find(o => _norm(o.textContent) === _nt)
                    || opts.find(o => _norm(o.textContent).startsWith(_nt))
                    || (_nt.length > 3 ? opts.find(o => _norm(o.textContent).includes(_nt)) : null);
                let _opts = _visibleOpts();
                // Strategy 1: option already visible — click it. Avoid typing,
                // because for "How did you hear" the option list is short
                // (~8 items, all shown at once) and typing "LinkedIn" wipes
                // the list instead of filtering it.
                let _chosen = _pick(_opts);
                if (!_chosen && !_opts.length) {
                    // Open didn't render — short retry after another wait.
                    await delay(400);
                    _opts = _visibleOpts();
                    _chosen = _pick(_opts);
                }
                if (!_chosen) {
                    // Long virtualized lists (Country 200+) only render the
                    // first window. Type a short head to filter — react-select
                    // narrows the menu to matching items.
                    const _typed = String(targetText).slice(0, Math.min(8, targetText.length));
                    await _trusted.type(_typed);
                    await delay(550);
                    _opts = _visibleOpts();
                    _chosen = _pick(_opts);
                }
                if (_chosen) {
                    await _trusted.click(_chosen);
                    for (let i = 0; i < 8; i++) { await delay(100); if (_ghComboValue(inputEl)) return true; }
                }
                // Close any lingering menu before falling through.
                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
                await delay(150);
            }
        }

        // Synthetic fallback path — reuse fill-engine's combobox logic
        // (handles React setNativeValue). Used when the trusted bridge isn't
        // available or didn't commit.
        const engine = window.QuickApplyFillEngine;
        if (engine?.fillCombobox) {
            try {
                // Element-specific fingerprint — a shared one made the engine
                // skip later comboboxes thinking the field was already done.
                const rule = { element: inputEl, type: 'combobox', fingerprint: '_gh_pf_' + (inputEl.id || inputEl.name || Math.random().toString(36).slice(2, 8)) };
                await engine.fillCombobox(rule, targetText);
            } catch (_) {}
        }
        // Verify the engine path actually committed.
        for (let i = 0; i < 6; i++) { await delay(100); if (_ghComboValue(inputEl)) return true; }

        // Fallback: open the menu, TYPE the target text into `.select__input`,
        // and click the matching option. Critical: a synthetic mousedown+click
        // opens the visual control but react-select does NOT populate
        // `[role=option]` until the input value changes (filter render). So
        // after opening, we set inputEl.value via the native setter + dispatch
        // an InputEvent — that's what makes react-select render its option
        // list. Then we read+click; finally we verify `.select__single-value`.
        try {
            inputEl.scrollIntoView({ block: 'center', behavior: 'instant' });
            await delay(150);
            const ctrl = inputEl.closest('[class*="select__control"]');
            const indicator = container?.querySelector('[class*="dropdown-indicator"], [class*="indicator"]:last-child');
            const openEl = indicator || ctrl || inputEl.parentElement;
            try { openEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
            openEl.click();
            await delay(250);

            // Type the target into the select__input so react-select renders
            // matching options. Use the native setter so React sees the change;
            // dispatch a proper InputEvent (react-select listens for it).
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
            const nt = norm(targetText);
            try {
                inputEl.focus();
                const proto = window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                // Truncate the typed query for long answers (e.g. AI returns a
                // full disability sentence) — react-select filters on prefix,
                // a 12-char head is enough to render the right option without
                // over-filtering away near-matches.
                const typed = String(targetText).slice(0, 24);
                setter.call(inputEl, typed);
                inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: typed, inputType: 'insertText' }));
            } catch (_) {}
            // Wait up to ~800ms for options to render after typing.
            let opts = [];
            for (let i = 0; i < 8; i++) {
                await delay(100);
                opts = Array.from(document.querySelectorAll('[role="option"]'))
                    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                if (opts.length) break;
            }

            let chosen = opts.find(o => norm(o.textContent.trim()) === nt);
            if (!chosen) chosen = opts.find(o => norm(o.textContent.trim()).startsWith(nt));
            if (!chosen && nt.length > 3) chosen = opts.find(o => norm(o.textContent.trim()).includes(nt));
            if (!chosen) {
                const pfx = nt.substring(0, Math.min(8, nt.length));
                if (pfx.length >= 5) {
                    const pvNeg = /\bnot\b|\bno\b|\bdon t\b/.test(nt);
                    chosen = opts.find(o => {
                        const ot = norm(o.textContent.trim());
                        if (!ot.startsWith(pfx)) return false;
                        return pvNeg === /\bnot\b|\bno\b|\bdon t\b/.test(ot);
                    });
                }
            }
            if (chosen) {
                chosen.click();
                for (let i = 0; i < 6; i++) { await delay(100); if (_ghComboValue(inputEl)) return true; }
            }
            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
        } catch (_) {}
        return !!_ghComboValue(inputEl);
    }

    // Get the label text for a combobox input using Greenhouse's aria-labelledby pattern.
    // Greenhouse labels have id="{fieldId}-label" and the input has aria-labelledby="{fieldId}-label".
    // Bug fix: aria-labelledby can be space-separated list of IDs — join all referenced label texts.
    function _ghGetComboLabel(inputEl) {
        const lblId = inputEl.getAttribute('aria-labelledby');
        if (lblId) {
            const text = lblId.trim().split(/\s+/)
                .map(id => document.getElementById(id)?.textContent?.trim() || '')
                .filter(Boolean).join(' ');
            if (text) return text;
        }
        // Fallback: look for <label for="{inputId}">
        if (inputEl.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`);
            if (lbl) return lbl.textContent?.trim() || '';
        }
        // Fallback: walk up to field container and find label
        const container = inputEl.closest('.field, [class*="field"], [class*="question"]');
        return container?.querySelector('label')?.textContent?.trim() || '';
    }

    class GreenhouseFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'greenhouse'; }

        getFieldAliases() {
            return {
                city: [
                    'location', 'candidate-location', 'candidate_location',
                    'location (city)', 'city', 'current location',
                ],
                preferredFirstName: ['preferred_name', 'preferred first name', 'preferred name'],
                workAuthorization: [
                    'legally authorized to work in the united states',
                    'legally authorized to work in the us',
                    'legally authorized to work in canada',
                    'legally authorized to work in the country',
                    'authorized to work in the country',
                    'authorized to work lawfully',
                    'authorized to work in the united states',
                    'eligible to work in the united states',
                    'work authorization status',
                ],
                ethnicity: ['race', 'race/ethnicity', 'racial', 'ethnic background'],
                veteranStatus: ['veteran_status', 'veteran status', 'protected veteran status', 'veteran status:'],
                disabilityStatus: ['disability_status', 'disability status', 'disability status:'],
                gender: ['gender', 'gender identity', 'gender:'],
            };
        }

        getValueOverrides() {
            return {
                veteranStatus: {
                    'I am not a protected veteran': [
                        'i am not a protected veteran', 'i am not a veteran',
                        'not a protected veteran', 'not a veteran',
                        'non-veteran', 'never served', 'have not served',
                        'no, i am not a veteran', 'no veteran', 'no',
                    ],
                    'I identify as one or more of the classifications of a protected veteran': [
                        'i am a protected veteran', 'i am a veteran',
                        'protected veteran', 'yes, veteran', 'yes i am a veteran',
                    ],
                },
                disabilityStatus: {
                    'No, I do not have a disability and have not had one in the past': [
                        'no', 'no disability', 'no, i do not have a disability',
                        'i do not have a disability',
                    ],
                    'Yes, I have a disability, or have had one in the past': [
                        'yes', 'yes, i have a disability', 'i have a disability',
                    ],
                },
                gender: {
                    'Female': ['female', 'woman', 'f'],
                    'Male':   ['male', 'man', 'm'],
                    'Non-binary': ['non-binary', 'nonbinary', 'non binary', 'enby'],
                },
            };
        }

        async preFill() {
            const launcher = _findGreenhouseLauncher();
            if (launcher) {
                try { launcher.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
                try { launcher.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
                try { launcher.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) {}
                try { launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
                try { launcher.click(); } catch (_) {}
                await delay(500);
            }
            if (launcher && !_hasGreenhouseApplicationFrame() && !_hasGreenhouseApplicationFields()) {
                await delay(500);
            }
            // New Greenhouse Remix (job-boards.greenhouse.io) is a React SPA that
            // server-side renders the form HTML but must hydrate React before event
            // handlers are active. The tab load event fires when HTML is parsed, but
            // React hydration takes 1-3 s more. Without this wait, our synthetic
            // change/input events (CV upload, field fill) fire before React's onChange
            // is attached — the S3 upload never starts and fields aren't committed.
            // Check for React fiber on a known stable input (first_name) as the
            // hydration signal — React attaches __reactFiber$* to DOM elements.
            if (/job-boards\.greenhouse\.io/i.test(window.location.hostname)) {
                const hydStart = Date.now();
                while (Date.now() - hydStart < 5000) {
                    const el = document.getElementById('first_name') || document.getElementById('email');
                    if (el && Object.keys(el).some(k => k.startsWith('__reactFiber'))) break;
                    await delay(200);
                }
            }
            // SPA hydration race: when the GH iframe is reached cross-origin
            // (Samsara, Fivetran, Airbnb), the iframe's content script runs at
            // document_idle but the Remix `entry.client.js` is still hydrating
            // React — fields aren't in the DOM yet, so an immediate
            // discoverFields finds 0 and the fill report shows "0/0 filled".
            //
            // Scope this wait to the IFRAME context only. In the top wrapper
            // frame (samsara.com, fivetran.com), the form fields never appear
            // here — they're inside the cross-origin iframe — so any wait is
            // pure latency before content.js can hit its launch-only bail.
            // The background's frame-poll loop will then deliver FILL_FORM to
            // the iframe, where this same preFill runs and waits productively.
            if (window.top !== window) {
                const fieldStart = Date.now();
                while (Date.now() - fieldStart < 6000) {
                    if (_hasGreenhouseApplicationFields()
                        || document.querySelector('input#first_name, input#last_name, input#email, form#application-form')) break;
                    await delay(250);
                }
            }

            const addEdu = document.querySelector('a[id*="add_education"], button[id*="add_education"]');
            if (addEdu) { addEdu.click(); await delay(300); }
            const addExp = document.querySelector('a[id*="add_employment"], button[id*="add_employment"]');
            if (addExp) { addExp.click(); await delay(300); }
        }

        async discoverFields() {
            const rules = await super.discoverFields();
            // Handle Select2 legacy widgets (older Greenhouse forms)
            for (const rule of rules) {
                if (rule.element.classList?.contains('select2-choice') ||
                    rule.element.closest?.('.select2-container')) {
                    const container = rule.element.closest?.('.select2-container');
                    const hiddenSel = container?.previousElementSibling;
                    if (hiddenSel?.tagName === 'SELECT') {
                        rule.element = hiddenSel;
                        rule.type = 'select';
                    }
                }
            }
            return rules;
        }

        async postFill() {
            const _prof = this.profile || {};
            const _waLower = String(_prof.workAuthorization || '').toLowerCase();
            const _needsSponsor = /\bh1b?\b|opt\b|stem\s*opt|\bj1\b|\btn\b|e-?3\b|h4\s*ead|\bl1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(_waLower);
            const _willingToRelocate = /yes|true|1/i.test(String(_prof.willingToRelocate || ''));
            const _isLocal = (() => {
                const profileCity = (_prof.city || '').toLowerCase();
                const profileState = (_prof.state || '').toLowerCase();
                // No location stored: defer to relocation willingness rather than assuming
                // local — assuming-local would make commuting/local-area questions answer
                // "Yes" by default for any user who hasn't filled in city/state.
                if (!profileCity && !profileState) return _willingToRelocate;
                const bodyText = document.body.textContent.toLowerCase();
                return profileCity.length > 2 && bodyText.includes(profileCity)
                    || profileState.length > 1 && bodyText.includes(profileState)
                    || _willingToRelocate;
            })();
            const _profileLocationCandidates = () => {
                const parts = [_prof.city, _prof.state, _prof.country].filter(v => v && String(v).trim());
                const joined = parts.join(', ');
                return [
                    _prof.location,
                    _prof.currentLocation,
                    joined,
                    [_prof.city, _prof.state].filter(Boolean).join(', '),
                    _prof.city
                ].filter(v => v && String(v).trim());
            };
            const _moneyNumber = (value) => {
                if (value == null) return null;
                const s = String(value).toLowerCase().replace(/,/g, '').trim();
                const m = s.match(/(\d+(?:\.\d+)?)/);
                if (!m) return null;
                let n = parseFloat(m[1]);
                if (!Number.isFinite(n)) return null;
                if (/\bk\b/.test(s) || (n > 0 && n < 1000)) n *= 1000;
                return n;
            };
            const _compensationCandidates = () => {
                const raw = _prof.expectedSalary || _prof.desiredSalary || _prof.salaryExpectation || _prof.compensation;
                const n = _moneyNumber(raw);
                if (!n) return raw ? [String(raw)] : null;
                const k = Math.round(n / 1000);
                const buckets = [
                    { min: 80, max: Infinity, label: '$80K+' },
                    { min: 70, max: 80, label: '$70K-$80K' },
                    { min: 60, max: 70, label: '$60K-$70K' },
                    { min: 50, max: 60, label: '$50K-$60K' },
                    { min: 40, max: 50, label: '$40K-$50K' },
                ];
                const hit = buckets.find(b => k >= b.min && k <= b.max);
                const labels = hit ? [hit.label] : [];
                return [
                    ...labels,
                    `$${k}K`,
                    `$${k},000`,
                    String(Math.round(n)),
                    String(raw || '')
                ].filter(Boolean);
            };
            const _normAnswer = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const _answerMatches = (existing, ans) => {
                const ex = _normAnswer(existing);
                if (!ex) return false;
                const candidates = (Array.isArray(ans) ? ans : [ans]).filter(Boolean).map(_normAnswer);
                return candidates.some(c => c && (ex === c || ex.startsWith(c) || c.startsWith(ex)));
            };
            const _degreeCandidates = () => {
                const raw = _prof.degree || _prof.highestEducation || '';
                const low = String(raw).toLowerCase();
                if (/master|ms\b|m\.s/.test(low)) return ["Master's Degree", 'Master of Science', 'Masters'];
                if (/bachelor|bs\b|ba\b|b\.s|b\.a/.test(low)) return ["Bachelor's Degree", 'Bachelor of Science', 'Bachelors'];
                if (/doctor|phd|ph\.d|md\b|m\.d/.test(low)) return ['Doctor of Philosophy (PhD)', 'Doctorate', 'Doctoral Degree'];
                if (/associate/.test(low)) return ["Associate's Degree", 'Associate Degree'];
                return raw ? [String(raw)] : null;
            };

            // ── Country of residence ───────────────────────────────────────────
            await delay(200);
            const _countryInput = document.getElementById('country');
            if (_countryInput) {
                const _cv = _ghComboValue(_countryInput);
                // Re-fill when empty OR when it holds a stray value that isn't a
                // country — the intl-tel-input phone widget can bleed a "+1"
                // dial code into this react-select. A plausible country value
                // contains a letter; "+1" / pure digits never does.
                const _badValue = _cv && !/[a-z]/i.test(_cv);
                if (!_cv || _badValue) {
                    // Normalize abbreviated country codes to full names for option matching
                    const _COUNTRY_NORM = {
                        'us': 'United States', 'usa': 'United States',
                        'u.s.': 'United States', 'u.s.a.': 'United States', 'u.s.a': 'United States',
                        'uk': 'United Kingdom', 'gb': 'United Kingdom',
                        'ca': 'Canada', 'au': 'Australia', 'de': 'Germany',
                        'fr': 'France', 'in': 'India', 'sg': 'Singapore',
                    };
                    const _cRaw = (_prof.country || 'United States').trim();
                    const _cVal = _COUNTRY_NORM[_cRaw.toLowerCase()] || _cRaw;
                    await _ghFillCombo(_countryInput, _cVal, _badValue);
                    await delay(200);
                }
            }

            // Current city/location. Modern Greenhouse renders this as a
            // searchable react-select/Places field, so the generic batch pass
            // skips it unless AI supplies an answer. Use the profile location
            // directly and let _ghFillCombo pick the first matching suggestion.
            const _locInput = document.getElementById('candidate-location');
            if (_locInput && !_ghComboValue(_locInput)) {
                const _locVals = _profileLocationCandidates();
                if (_locVals.length) {
                    await _ghFillCombo(_locInput, _locVals);
                    await delay(200);
                }
            }

            // Education is optional on many Greenhouse forms, but when filled it
            // must be the profile's actual school/degree. Correct stale AI/cache
            // choices like first alphabetic school or unrelated medical degrees.
            const _schoolInput = document.getElementById('school--0');
            const _schoolAns = _prof.university || _prof.school;
            if (_schoolInput && _schoolAns && !_answerMatches(_ghComboValue(_schoolInput), _schoolAns)) {
                await _ghFillCombo(_schoolInput, String(_schoolAns), !!_ghComboValue(_schoolInput));
                await delay(200);
            }
            const _degreeInput = document.getElementById('degree--0');
            const _degreeAns = _degreeCandidates();
            if (_degreeInput && _degreeAns && !_answerMatches(_ghComboValue(_degreeInput), _degreeAns)) {
                await _ghFillCombo(_degreeInput, _degreeAns, !!_ghComboValue(_degreeInput));
                await delay(200);
            }

            // ── Standard EEO comboboxes (by known IDs, 80+ forms each) ─────────
            // Gender
            await delay(300);
            const _gEl = document.getElementById('gender');
            if (_gEl) {
                const g = String(_prof.gender || '').toLowerCase();
                let ans = _prof.gender || 'Decline To Self Identify';
                if (/\bfemale\b|\bwoman\b/.test(g))      ans = 'Female';
                else if (/\bmale\b|\bman\b/.test(g))     ans = 'Male';
                else if (/non.?binary|nonbinary/.test(g)) ans = 'Non-binary';
                const existing = _ghComboValue(_gEl);
                if (!existing || !_answerMatches(existing, ans)) await _ghFillCombo(_gEl, ans, !!existing);
                await delay(200);
            }

            // Hispanic/Latino (derived from ethnicity profile field)
            const _hEl = document.getElementById('hispanic_ethnicity');
            if (_hEl) {
                const _isHispanic = /hispanic|latino|latina|latinx/i.test(String(_prof.ethnicity || ''));
                const ans = _isHispanic ? 'Yes' : 'No';
                const existing = _ghComboValue(_hEl);
                if (!existing || !_answerMatches(existing, ans)) await _ghFillCombo(_hEl, ans, !!existing);
                await delay(200);
            }

            // Veteran status
            const _vEl = document.getElementById('veteran_status');
            if (_vEl) {
                const v = String(_prof.veteranStatus || '').toLowerCase();
                let ans = "I don't wish to answer";
                if (/not.*veteran|non.?veteran|never.*served|^no\b/.test(v))
                    ans = 'I am not a protected veteran';
                else if (/veteran|served|military/.test(v))
                    ans = 'I identify as one or more of the classifications of a protected veteran';
                else if (_prof.veteranStatus) ans = _prof.veteranStatus;
                const existing = _ghComboValue(_vEl);
                if (!existing || !_answerMatches(existing, ans)) await _ghFillCombo(_vEl, ans, !!existing);
                await delay(200);
            }

            // Disability status
            const _dEl = document.getElementById('disability_status');
            if (_dEl) {
                const d = String(_prof.disabilityStatus || '').toLowerCase();
                let ans = 'I do not want to answer';
                if (/^no\b|don.?t have|do not have|no disab/.test(d))
                    ans = 'No, I do not have a disability and have not had one in the past';
                else if (/^yes\b|have a disab/.test(d))
                    ans = 'Yes, I have a disability, or have had one in the past';
                else if (_prof.disabilityStatus) ans = _prof.disabilityStatus;
                const existing = _ghComboValue(_dEl);
                if (!existing || !_answerMatches(existing, ans)) await _ghFillCombo(_dEl, ans, !!existing);
                await delay(200);
            }

            // ── Extended EEO comboboxes (by label pattern, numeric custom IDs) ──
            // Find ALL comboboxes on the page, get label via aria-labelledby, route by pattern.
            await delay(200);
            const EEO_ROUTES = [
                {
                    pat: /how would you describe your (gender|gender identity)|what gender|i identify my gender|voluntary.*gender/i,
                    answer: () => {
                        const g = String(_prof.gender || '').toLowerCase();
                        if (/\bfemale\b|\bwoman\b/.test(g)) return 'Female';
                        if (/\bmale\b|\bman\b/.test(g)) return 'Male';
                        if (/non.?binary|nonbinary/.test(g)) return 'Non-binary';
                        return _prof.gender || null;
                    },
                },
                {
                    pat: /how would you describe your racial|select.*ethnicit|i identify.*ethnicit|voluntary.*race|ethnic background|ethnic identit|racial.*background|identify your race|please identify your race|what is your race|^race\b/i,
                    answer: () => {
                        const e = String(_prof.ethnicity || '').toLowerCase();
                        if (/\basian\b/.test(e)) return 'Asian';
                        if (/black|african/.test(e)) return 'Black or African American';
                        if (/hispanic|latino|latina|latinx/.test(e)) return 'Hispanic';
                        if (/\bwhite\b|caucasian|european/.test(e)) return 'White';
                        if (/native hawaiian|pacific island/.test(e)) return 'Native Hawaiian or Pacific Islander';
                        if (/american indian|alaska native|indigenous/.test(e)) return 'American Indian';
                        if (/two.*more|multi.*racial|biracial/.test(e)) return 'Two or More Races';
                        if (/middle eastern|north african/.test(e)) return 'Middle Eastern';
                        return _prof.ethnicity || null;
                    },
                },
                {
                    pat: /how would you describe your sexual orientation|what sexual orientation|i identify.*sexual/i,
                    answer: () => {
                        const s = String(_prof.sexualOrientation || '').toLowerCase();
                        if (/heterosexual|straight/.test(s)) return 'Heterosexual';
                        if (/bisexual|pansexual/.test(s)) return 'Bisexual';
                        if (/\bgay\b/.test(s)) return 'Gay';
                        if (/lesbian/.test(s)) return 'Lesbian';
                        if (/asexual/.test(s)) return 'Asexual';
                        if (/queer/.test(s)) return 'Queer';
                        return _prof.sexualOrientation || null;
                    },
                },
                { pat: /identify as transgender|transgender experience|are you transgender/i, answer: () => "I don't wish to answer" },
                {
                    pat: /veteran or active member|have you served|served.*military|veteran.*armed forces|do you identify as a veteran/i,
                    answer: () => {
                        const v = String(_prof.veteranStatus || '').toLowerCase();
                        if (/not.*veteran|^no\b|never/.test(v)) return 'No';
                        if (/veteran|served/.test(v)) return 'Yes';
                        return "I don't wish to answer";
                    },
                },
                {
                    pat: /disability|chronic condition|person with a disability|ada/i,
                    answer: () => {
                        const d = String(_prof.disabilityStatus || '').toLowerCase();
                        if (/^no\b|don.?t have|do not have/.test(d)) return 'No';
                        if (/^yes\b/.test(d)) return 'Yes';
                        return "I don't wish to answer";
                    },
                },
                {
                    pat: /are you hispanic or latinx|hispanic or latino|are you hispanic/i,
                    answer: () => /hispanic|latino|latina|latinx/i.test(String(_prof.ethnicity || '')) ? 'Yes' : 'No',
                },
            ];

            // Skip known fixed-ID EEO fields already handled above
            const _handled = new Set(['gender', 'hispanic_ethnicity', 'veteran_status', 'disability_status']);

            for (const input of document.querySelectorAll('[role="combobox"]')) {
                if (_handled.has(input.id)) continue;
                const lbl = _ghGetComboLabel(input);
                if (!lbl) continue;
                const route = EEO_ROUTES.find(r => r.pat.test(lbl));
                if (!route) continue;
                const ans = route.answer();
                if (!ans) continue;
                // Skip if already filled
                const cont = input.closest('[class*="select__container"], .select-shell');
                if (cont?.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent?.trim()) continue;
                await _ghFillCombo(input, ans);
                await delay(200);
            }

            // ── Yes/No custom question comboboxes (work auth, sponsorship, etc.) ──
            await delay(300);
            // "legally able to work" / "able to work in" / "authorized to work" — all phrasings of the same question.
            const LEGAL_AUTH_PAT = /legally authorized|legally able to work|authorized to work|eligible to work|able to work in|right to work|legal.{0,5}right.{0,5}to work/i;
            const SPONSOR_PAT    = /require.*sponsor|need.*sponsor|visa sponsor|sponsor.*immigration|sponsorship|immigration.*sponsorship/i;
            const PREV_EMP_PAT   = /previously (been )?employed|previously worked for|currently work for|prior.*employer|formerly.*employed|ever.*worked.*for.*before|ever\s+work(ed)?\s+(for|at|with)\b|ever.*been.*employed|ever.*employed.*by|worked.*here.*before|employed.*here.*before/i;
            const AGE_PAT        = /at least.*18|over.*18|age requirement|18.*year/i;
            const RELOCATION_PAT = /open to relocat|willing to relocat|able to relocat/i;
            const OFFICE_PAT     = /in.person|in.*office|on.?site|commut.*distance|hybrid.*office|office.*25%|regularly.*commute/i;
            const PREV_INTER_PAT = /previously interviewed|applied.*before|prior.*application|interviewed.*before|ever\s+interviewed\s+(with|at|for|by)\b/i;
            // Restrictive-covenant questions ("Are you subject to a Non-Compete / Non-Solicit?").
            // Older PROHIBITED_PAT required the word "agreement"; many forms omit it.
            const NONCOMPETE_PAT = /non.?compete|non.?solicit|restrictive covenant/i;
            // Catch-all certification/acknowledgement dropdowns rendered as Yes/No.
            // Must be tested BEFORE LEGAL_AUTH/STATE/BG_CHECK because the long legal
            // paragraph contains "eligible to work in the United States", "federal,
            // state, or local law", and "background investigation" — all of which
            // would otherwise mis-route this consent question.
            const CERTIFY_PAT    = /i certify|certify that|i acknowledge and agree|i have read and (agree|understand|accept)|i authorize and consent|i agree to the (terms|above)/i;
            // Legal/residential address country dropdown (distinct from the dedicated
            // top-level Country field handled by id="country").
            const LEGAL_COUNTRY_PAT = /legal address\s*[-–]?\s*country|country of (residence|citizenship)/i;
            // Bug fix: removed overly broad `anyone.*employ` and `know.*anyone.*at` which
            // matched unrelated questions like "Is anyone employed at your current company?"
            const CONFLICT_PAT   = /relative.*employ|family.*employ|employ.*relative|spouse.*employ|partner.*employ|conflict.*interest|related.*to.*employee|relationship.*employee|work.*alongside.*relative|friend.*or.*relative.*work.*here|family.*or.*friend.*at.*this/i;
            const PROHIBITED_PAT = /prohibited.*perform|restrict.*perform|limiting.*agreement|non.?compete.*agreement|restrictive.*covenant|encumber.*perform|prevent.*perform|excluded.*participate/i;
            const CONCERNS_PAT   = /concern.*perform|concern.*this (job|role|position)|concern.*ability.*perform|issues.*perform/i;
            const LOCAL_AREA_PAT = /local to|within.*commuting|commutable.*distance|able.*commute\b/i;
            const STATE_PAT      = /what state do you live in|state.*(live|reside|located)|current state|state of residence|legal address\s*[-–]?\s*state|address\s*[-–]\s*state/i;
            const WORK_HOURS_PAT = /comfortable.*(working )?hours|working hours|work schedule|schedule.*(comfortable|available)|8\s*(am|a\.m\.).*5\s*(pm|p\.m\.)|time\s*zone|timezone/i;
            const COMP_PAT       = /desired compensation|compensation expectation|salary expectation|expected salary|desired salary|pay expectation/i;
            // Acknowledge / consent screening (background check, drug test, references).
            // Greenhouse renders these as dropdowns with Yes/No options — answering
            // "No" disqualifies the applicant, so we default to "Yes" (consent) unless
            // the profile says otherwise. Long consent paragraphs are the giveaway:
            // we match the question phrasing wherever it appears in the label.
            const BG_CHECK_PAT  = /background check|background investigation|criminal (record|conviction|history|background)|consent to.*background|disclosure of.*criminal/i;
            const DRUG_TEST_PAT = /drug (test|screen|screening)/i;

            // Use for...of (not forEach) to properly await each async fill
            for (const input of document.querySelectorAll('[role="combobox"]')) {
                // Skip fixed EEO IDs and structural form fields
                if (_handled.has(input.id)) continue;
                if (['candidate-location', 'school--0', 'degree--0',
                     'discipline--0', 'start-month--0', 'end-month--0'].includes(input.id)) continue;
                // Skip country here — handled by the dedicated Country pass above
                if (input.id === 'country') continue;

                const lbl = _ghGetComboLabel(input);
                if (!lbl) continue;

                // Skip if already routed as EEO above
                if (EEO_ROUTES.some(r => r.pat.test(lbl))) continue;

                let ans = null;
                // CERTIFY first — its legal paragraph contains phrases that trip
                // LEGAL_AUTH / STATE / BG_CHECK, so it must short-circuit those.
                if      (CERTIFY_PAT.test(lbl))     ans = ['Yes', 'I Agree', 'I Acknowledge', 'I Consent', 'Agree'];
                else if (LEGAL_AUTH_PAT.test(lbl))  ans = 'Yes';
                else if (SPONSOR_PAT.test(lbl))     ans = _needsSponsor ? 'Yes' : 'No';
                else if (PREV_EMP_PAT.test(lbl))    ans = 'No';
                else if (PREV_INTER_PAT.test(lbl))  ans = 'No';
                else if (NONCOMPETE_PAT.test(lbl))  ans = 'No';
                else if (AGE_PAT.test(lbl))         ans = 'Yes';
                else if (RELOCATION_PAT.test(lbl))  ans = _willingToRelocate ? 'Yes' : 'No';
                else if (OFFICE_PAT.test(lbl))      ans = _isLocal ? 'Yes' : 'No';
                else if (CONFLICT_PAT.test(lbl))    ans = 'No';
                else if (PROHIBITED_PAT.test(lbl))  ans = 'No';
                else if (CONCERNS_PAT.test(lbl))    ans = 'No';
                else if (LOCAL_AREA_PAT.test(lbl))  ans = _isLocal ? 'Yes' : 'No';
                else if (STATE_PAT.test(lbl))       ans = _prof.state || _prof.region || null;
                else if (LEGAL_COUNTRY_PAT.test(lbl)) ans = _prof.country || 'United States';
                else if (WORK_HOURS_PAT.test(lbl))  ans = 'Yes';
                else if (COMP_PAT.test(lbl))        ans = _compensationCandidates();
                else if (BG_CHECK_PAT.test(lbl)) {
                    // Consent dropdowns vary across companies: "Yes/No",
                    // "I Acknowledge / I Do Not Acknowledge", "I Agree / I Decline",
                    // "I Consent / I Do Not Consent". Pass candidates in order
                    // so the first one whose option exists wins.
                    const _no = /^no\b|refuse|decline/i.test(String(_prof.backgroundCheckConsent || ''));
                    // Order matters: most Greenhouse background-check dropdowns
                    // use "I Acknowledge" rather than "Yes". Try that first to
                    // avoid leaving stale filter text from a failed "Yes" attempt.
                    ans = _no
                        ? ['I Do Not Acknowledge', 'I Do Not Agree', 'I Do Not Consent', 'No', 'Decline']
                        : ['I Acknowledge', 'I Agree', 'I Consent', 'Yes', 'Acknowledge'];
                } else if (DRUG_TEST_PAT.test(lbl)) {
                    const _no = /^no\b|refuse|decline/i.test(String(_prof.drugTestConsent || ''));
                    ans = _no
                        ? ['No', 'I Do Not Agree', 'Decline']
                        : ['Yes', 'I Agree', 'I Consent'];
                }

                if (!ans) continue;
                const existing = _ghComboValue(input);
                if (existing && _answerMatches(existing, ans)) continue;
                await _ghFillCombo(input, ans, !!existing);
                await delay(150);
            }

            // ── "How did you hear about this job?" combobox ───────────────────
            // Routed through _ghFillCombo so it uses the trusted-click path
            // (CDP Input.dispatchMouseEvent via background.js). react-select v5
            // only renders [role=option] in response to a trusted pointer event;
            // synthetic mousedown+click opens the visual control but the option
            // list stays empty, so the previous direct-open implementation here
            // never committed a value.
            await delay(200);
            const HEARD_PAT = /how did you (hear|find|learn|initially hear).*?(job|role|position|opening|about us)|where did you (hear|learn|find).{0,40}(job|role|position|opening|about us)/i;
            const _heardPref = _prof.heardAboutUs || 'LinkedIn';

            for (const input of document.querySelectorAll('[role="combobox"]')) {
                const lbl = _ghGetComboLabel(input);
                if (!HEARD_PAT.test(lbl)) continue;
                if (_ghComboValue(input)) continue;
                await _ghFillCombo(input, _heardPref);
                await delay(200);
                break;
            }

            // ── Catch-all: AI-driven fill for every remaining combobox ─────────
            // The hardcoded pattern handlers above only cover questions we can
            // recognise by regex. Real Greenhouse forms carry company-specific
            // dropdown questions (procurement experience, role screening, "do
            // you currently work for X", the EEO "identify your race", ...)
            // that match NO pattern and were therefore skipped entirely — the
            // AI was never consulted. The fill engine HAS already resolved an
            // answer for every discovered rule; content.js stashes that answers
            // map (`_lastAnswers`) plus the rules (`_lastRules`) on the filler.
            // Here we apply those AI answers to any still-empty react-select.
            // Failures are recorded on `_postFillFailedFingerprints` so
            // content.js demotes them from "filled" → "error" in the report
            // (react-select silently drops engine-typed text, so without this
            // the report shows false-✓ over empty dropdowns).
            await delay(200);
            const _answers = this._lastAnswers;
            const _rules = this._lastRules || [];
            const _getAnswer = (rule) => {
                if (!_answers || !rule) return null;
                if (typeof _answers.get === 'function') return _answers.get(rule.fingerprint);
                return _answers[rule.fingerprint];
            };
            const _comboShell = (el) => el?.closest?.('[class*="select__container"], .select-shell, [class*="select-shell"]') || null;
            const _comboFailed = new Set();
            // The batch AI resolver on modern Greenhouse forms exhibits
            // cross-field contamination: every combobox can come back resolved
            // to the COUNTRY value (e.g. "United States+1", with the
            // intl-tel-input phone code appended). Likely caused by the
            // hidden requiredInput proxies react-select renders — they share
            // empty id/name/label, so all comboboxes collapse onto a single
            // fingerprint and the country answer overwrites every slot.
            // Until that's fixed at the discoverer/mapper level, sanitize the
            // contaminated answer here: if it looks like a phone/country
            // value and the question isn't about country, fall back to a
            // sensible default derived from the label.
            const _isCountryContamination = (a) =>
                typeof a === 'string' && (/\+\d/.test(a) || /^united states/i.test(a) || /^\+?\d+$/.test(a.trim()));
            const _looksLikeYesNo = async (input) => {
                // Cheap check: read options if the menu rendered, else inspect
                // the placeholder + label for clues. Most binary questions
                // ("Do you …", "Have you …", "Are you …") are Yes/No.
                const lbl = _ghGetComboLabel(input).toLowerCase();
                return /^(do|did|have|has|are|is|were|was|will|would|can|could|should)\b/.test(lbl) || /\?$/.test(lbl);
            };
            if (_answers) {
                for (const input of document.querySelectorAll('[role="combobox"]')) {
                    // Skip the intl-tel-input phone search box — not a form field.
                    if (/iti[_-]/.test(input.id || '') || /iti__/.test(input.className || '')) continue;
                    if (_handled.has(input.id)) continue;
                    // Skip anything already committed by the handlers above.
                    if (_ghComboValue(input)) continue;
                    const shell = _comboShell(input);
                    const rule = _rules.find(r => r.element === input)
                        || (shell ? _rules.find(r => r.element && _comboShell(r.element) === shell) : null);
                    let ans = _getAnswer(rule);
                    if (Array.isArray(ans)) ans = ans[0];
                    const lblLow = _ghGetComboLabel(input).toLowerCase();
                    // Sanitize cross-field contamination.
                    if (_isCountryContamination(ans) && !/country|location|where.*based|phone code/i.test(lblLow)) {
                        if (/legally (authorized|able) to work|authorized to work|eligible to work|able to work in|right to work/.test(lblLow)) {
                            // Authorization questions default to YES — defaulting to No
                            // disqualifies the applicant for any role they're entitled to.
                            ans = 'Yes';
                        } else if (/background check|criminal (record|conviction|history)|drug (test|screen)/.test(lblLow)) {
                            // Consent screens — saying No disqualifies; default to Yes.
                            // Pass candidates for I Acknowledge / I Agree / I Consent variants.
                            ans = ['Yes', 'I Acknowledge', 'I Agree', 'I Consent', 'Acknowledge'];
                        } else if (/how did you (hear|learn|find)/.test(lblLow)) {
                            ans = _prof.heardAboutUs || 'LinkedIn';
                        } else if (await _looksLikeYesNo(input)) {
                            // Default Yes/No screens to "No" — overclaiming on
                            // citizenship/prior-employment/conflicts is the
                            // more harmful direction.
                            ans = 'No';
                        } else {
                            ans = null;
                        }
                    }
                    if (ans == null || ans === '') continue;
                    const ok = await _ghFillCombo(input, Array.isArray(ans) ? ans : String(ans));
                    if (!ok && rule?.fingerprint) _comboFailed.add(rule.fingerprint);
                    await delay(150);
                }
            }
            this._postFillFailedFingerprints = _comboFailed;

            // ── Promote fingerprints whose combobox now actually shows a value ──
            // The engine main pass (BEFORE postFill) marks react-select fields
            // as `status: 'error'` when its synthetic type/click can't commit.
            // After postFill runs the trusted-input path, those same fields ARE
            // committed in the DOM. content.js's demotion loop only goes
            // filled→error, never error→filled, so the user would see ✗ over
            // a filled field. Build a parallel "succeeded" fingerprint set
            // from rules whose `[role=combobox]` now has a value, and let
            // content.js promote those.
            const _comboSucceeded = new Set();
            for (const rule of _rules) {
                const el = rule?.element;
                if (!el || el.getAttribute?.('role') !== 'combobox') continue;
                if (!rule.fingerprint) continue;
                if (_comboFailed.has(rule.fingerprint)) continue;
                if (_ghComboValue(el)) _comboSucceeded.add(rule.fingerprint);
            }
            this._postFillSucceededFingerprints = _comboSucceeded;

            // ── GDPR / consent checkboxes ──────────────────────────────────────
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked || !cb.offsetParent) return;
                const name = cb.getAttribute('name') || '';
                const labelEl = cb.labels?.[0] || cb.closest('label') ||
                    (cb.id && document.querySelector(`label[for="${CSS.escape(cb.id)}"]`));
                const labelText = [
                    cb.getAttribute('aria-label') || '',
                    labelEl?.textContent || '',
                    cb.closest('[class*="field"], [class*="consent"], [class*="gdpr"]')
                        ?.textContent?.substring(0, 300) || ''
                ].join(' ');
                if (/^gdpr_/.test(name) || CONSENT_TEXT_RX.test(labelText)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('input',  { bubbles: true }));
                }
            });
        }

        getNextSelectors() {
            return 'button[type="submit"], input[type="submit"], button.btn--pill:not(.btn--secondary), button.btn--rounded:not(.btn--secondary), button.btn--rectangle:not(.btn--secondary)';
        }
    }

    window.QuickApplyFillerFactory.register('greenhouse', GreenhouseFiller);
    window.QuickApplyGreenhouseFiller = GreenhouseFiller;
})();
