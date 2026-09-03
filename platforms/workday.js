(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Robert Half / generic Workday tenants surface the repeatable sections
    // (Work Experience, Education, Languages, Websites) collapsed behind an Add
    // button. The sub-fields don't exist in the DOM until the button is clicked,
    // so field discovery sees an empty section and the filler does nothing.
    // Skip heuristic: a section is already expanded iff it has a Delete button
    // (Workday renders Delete only on entries that exist) or an h5 header ("Work
    // Experience 1") — NOT by any nested input, because Workday IDs commonly
    // contain `--` and would false-positive the skip check.
    // Sections the user does not want filled on Workday "My Experience". Skipping
    // them means we never click their "Add" (so no empty required sub-rows appear)
    // and discovery drops any of their fields. Work Experience / Education /
    // Websites are intentionally NOT here — those are filled.
    const _WORKDAY_SKIP_SECTIONS = /certification|^skills?$|\blanguages?\b/i;

    // Nearest section heading (h2–h5) above an element — used to classify which
    // repeating section a field/Add-button belongs to.
    function _workdaySectionTitle(el) {
        let n = el;
        for (let i = 0; i < 12 && n; i++) {
            n = n.parentElement;
            if (!n) break;
            const h = n.querySelector(':scope > h2, :scope > h3, :scope > h4, :scope > h5');
            if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
        }
        return '';
    }

    async function expandRepeatingSections(root = document) {
        const addButtons = _queryAllDeep(root,
            '[data-automation-id="add-button"], button[data-automation-id$="-add"], button[data-automation-id*="Add"]'
        );
        let clicked = 0;
        for (const btn of addButtons) {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            // Don't expand sections the user wants left empty (Certifications/Skills/
            // Languages) — clicking Add would create an empty (sometimes required) row.
            if (_WORKDAY_SKIP_SECTIONS.test(_workdaySectionTitle(btn))) continue;
            const section = btn.closest('[role="group"], fieldset, section');
            if (section && (
                section.querySelector('button[data-automation-id*="elete"], button[aria-label^="Delete"]') ||
                section.querySelector('h5')
            )) continue;
            try { btn.click(); clicked++; await delay(250); } catch (_) {}
        }
        return clicked;
    }

    // Clean a label: strip the "*" required-marker, trailing "(Required)" aria
    // cruft, "Expanded" state text, selected-count announcements, and "Select One"
    // placeholders. Workday often concatenates these into textContent.
    function cleanWorkdayLabel(raw) {
        if (!raw) return '';
        return String(raw)
            .replace(/\s*\*\s*/g, ' ')
            .replace(/\s*(?:\(Required\)|Required)\s*$/i, '')
            .replace(/\s*Select One\s*$/i, '')
            .replace(/\s*Expanded\s*$/i, '')
            .replace(/\s*\d+\s+items?\s+selected(?:,.*)?$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Workday renders its visible dropdowns as <button aria-haspopup="listbox">
    // and its dates as a triplet of [role="spinbutton"] elements. The hierarchical
    // multiselects (How Did You Hear About Us, Country Phone Code, Skills) are
    // <input> inside a [data-automation-id="multiSelectContainer"]. None of these
    // match the base discoverer's selector set, so we synthesise FieldRules for
    // them here.
    // Recursively collect matching elements across shadow DOM — a handful of
    // Workday tenants wrap the form in a closed/open shadow root, and plain
    // querySelectorAll misses them.
    function _queryAllDeep(root, selector) {
        const out = [];
        const visited = new WeakSet();
        (function walk(node) {
            if (!node || visited.has(node)) return;
            visited.add(node);
            try {
                for (const el of node.querySelectorAll(selector)) out.push(el);
            } catch (_) {}
            try {
                for (const el of node.querySelectorAll('*')) {
                    if (el.shadowRoot) walk(el.shadowRoot);
                }
            } catch (_) {}
        })(root);
        return out;
    }

    function discoverWorkdayControls(root) {
        const rules = [];
        const seen = new WeakSet();

        const humanize = (id) => (id || '')
            .replace(/^formField-/, '')
            .replace(/([A-Z])/g, ' $1')
            .replace(/[-_]+/g, ' ')
            .trim();

        function extractLabel(container, primaryEl) {
            const autoId = container.getAttribute('data-automation-id');
            // 1. label[for=primaryEl.id]
            if (primaryEl?.id) {
                const l = container.querySelector(`label[for="${CSS.escape(primaryEl.id)}"]`);
                if (l) {
                    const t = cleanWorkdayLabel(l.textContent);
                    if (t) return { text: t, el: l };
                }
            }
            // 2. direct <label> / <legend> (pick the first short one — rich-label
            //    regions contain paragraphs we don't want).
            const labelEl = container.querySelector(':scope > fieldset > legend, :scope > label, :scope > fieldset > label');
            if (labelEl) {
                const t = cleanWorkdayLabel(labelEl.textContent);
                if (t) return { text: t, el: labelEl };
            }
            const anyLabel = container.querySelector('label, legend');
            if (anyLabel) {
                const t = cleanWorkdayLabel(anyLabel.textContent);
                if (t) return { text: t, el: anyLabel };
            }
            // 3. aria-label on primaryEl minus trailing state words
            if (primaryEl) {
                const t = cleanWorkdayLabel((primaryEl.getAttribute('aria-label') || '')
                    .replace(/\s+(Select One|Required|Expanded|Collapsed)\b/gi, ''));
                if (t) return { text: t, el: null };
            }
            const t = humanize(autoId);
            return t ? { text: t, el: null } : null;
        }

        // 1. Button-as-dropdown (State, Degree, Phone Type, Compensation, EEO, etc.)
        const buttons = _queryAllDeep(root, 'button[aria-haspopup="listbox"]');
        for (const btn of buttons) {
            if (seen.has(btn)) continue;
            seen.add(btn);
            const container = btn.closest('[data-automation-id^="formField-"]');
            if (!container) continue;
            const autoId = container.getAttribute('data-automation-id');
            // If multiple buttons share the container (e.g. Language: Overall /
            // Reading / Speaking / Writing), distinguish by btn.id so each gets a
            // rule. Use the first-label as the container label, combined with the
            // button's own aria-label to disambiguate.
            const info = extractLabel(container, btn);
            if (!info) continue;
            const ariaOnly = cleanWorkdayLabel((btn.getAttribute('aria-label') || '')
                .replace(/\s+(Select One|Required|Expanded|Collapsed)\b/gi, ''));
            const label = ariaOnly && ariaOnly !== info.text ? ariaOnly : info.text;

            rules.push({
                label,
                type: 'combobox',
                required: btn.getAttribute('aria-required') === 'true'
                    || /\*/.test(info.el?.textContent || ''),
                options: [],
                element: btn,
                labelElement: info.el || null,
                selector: autoId && btn.id
                    ? `[data-automation-id="${CSS.escape(autoId)}"] #${CSS.escape(btn.id)}`
                    : (autoId ? `[data-automation-id="${CSS.escape(autoId)}"] button[aria-haspopup="listbox"]` : ''),
                fingerprint: window.QuickApplyCache?.makeFingerprint?.(label, 'combobox', []) ?? '',
                platform: 'workday',
                multiline: false,
                _workdayKind: 'buttonDropdown'
            });
        }

        // 2. Date triplet (dateInputWrapper → three spinbuttons)
        const dateWrappers = _queryAllDeep(root, '[data-automation-id="dateInputWrapper"]');
        for (const wrap of dateWrappers) {
            if (seen.has(wrap)) continue;
            seen.add(wrap);
            const container = wrap.closest('[data-automation-id^="formField-"]');
            if (!container) continue;
            const month = wrap.querySelector('[data-automation-id="dateSectionMonth-input"]');
            const day = wrap.querySelector('[data-automation-id="dateSectionDay-input"]');
            const year = wrap.querySelector('[data-automation-id="dateSectionYear-input"]');
            if (!month || !year) continue;
            const info = extractLabel(container, wrap);
            if (!info) continue;
            rules.push({
                label: info.text,
                type: 'date',
                required: /\*/.test(info.el?.textContent || ''),
                options: [],
                element: wrap,
                labelElement: info.el || null,
                selector: `[data-automation-id="${CSS.escape(container.getAttribute('data-automation-id'))}"] [data-automation-id="dateInputWrapper"]`,
                fingerprint: window.QuickApplyCache?.makeFingerprint?.(info.text, 'date', []) ?? '',
                platform: 'workday',
                multiline: false,
                _workdayKind: 'dateTriplet',
                _workdayDateParts: { month, day, year },
                _workdayContainerId: container.getAttribute('data-automation-id')
            });
        }

        // 3. Multi-select search (source / countryPhoneCode / skills / fieldOfStudy)
        //    Rendered as <input type="text" placeholder="Search"> inside a
        //    [data-automation-id="multiSelectContainer"]. Clicking the input opens
        //    a tree of options — leaves end with "role=option" + no sub-caret.
        const multiSelects = _queryAllDeep(root, '[data-automation-id="multiSelectContainer"]');
        for (const msc of multiSelects) {
            if (seen.has(msc)) continue;
            seen.add(msc);
            const container = msc.closest('[data-automation-id^="formField-"]');
            if (!container) continue;
            // Workday's search input has no explicit type attribute (defaults to
            // text); `input[type="text"]` fails to match it. Use :not([type=hidden]).
            const input = msc.querySelector('input:not([type="hidden"])');
            if (!input) continue;
            const info = extractLabel(container, input);
            if (!info) continue;
            rules.push({
                label: info.text,
                type: 'combobox',
                required: input.getAttribute('aria-required') === 'true'
                    || /\*/.test(info.el?.textContent || ''),
                options: [],
                element: input,
                labelElement: info.el || null,
                selector: `[data-automation-id="${CSS.escape(container.getAttribute('data-automation-id'))}"] [data-automation-id="multiSelectContainer"] input`,
                fingerprint: window.QuickApplyCache?.makeFingerprint?.(info.text, 'combobox', []) ?? '',
                platform: 'workday',
                multiline: false,
                _workdayKind: 'multiSelect',
                _workdayMultiSelectContainer: msc
            });
        }

        return rules;
    }

    // Count visible listboxes so we can tell when ours opened (avoids matching
    // a stale listbox left over from a previous fill).
    function _visibleListboxes() {
        return Array.from(document.querySelectorAll('[role="listbox"]'))
            .filter(l => l.getAttribute('aria-hidden') !== 'true' && l.offsetParent !== null);
    }

    // Workday's multiselectlistitem (promptLeafNode) listens for `mousedown`, not
    // `click`. A plain `el.click()` from page context only fires a click event, so
    // selection silently fails. Dispatch a full pointer/mouse sequence so the
    // widget's handler runs regardless of which phase it listens on.
    function _workdayRealClick(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const init = {
            bubbles: true, cancelable: true, composed: true,
            view: el.ownerDocument?.defaultView || window,
            button: 0, buttons: 1,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
        };
        const pInit = { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true };
        try { el.dispatchEvent(new PointerEvent('pointerover', pInit)); } catch (_) {}
        try { el.dispatchEvent(new PointerEvent('pointerenter', pInit)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseover', init)); } catch (_) {}
        try { el.dispatchEvent(new PointerEvent('pointerdown', pInit)); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch (_) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', { ...pInit, buttons: 0 })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 })); } catch (_) {}
        // Fallback for elements whose handler is on the native click path only
        try { el.click?.(); } catch (_) {}
        return true;
    }

    // Trusted-click variant. Workday's multi-select chip-add callback is gated
    // on event.isTrusted on several tenants (Clio, Adobe) — a synthetic click
    // flips aria-selected on the option but never renders a chip. The CDP
    // bridge in trusted-input.js dispatches a browser-originated mouse event
    // that satisfies the gate. Falls back to the synthetic path when the
    // bridge is unavailable (debugger permission revoked, attach failed).
    async function _workdayTrustedClick(el) {
        if (!el) return false;
        const bridge = window.QuickApplyTrustedInput;
        if (bridge && await bridge.available()) {
            const ok = await bridge.click(el);
            if (ok) return true;
        }
        return _workdayRealClick(el);
    }

    function _optionText(el) {
        // Workday appends ", press delete to clear value." to selected options'
        // aria-label. Strip that so matching works on first-read.
        return (el.innerText || el.textContent || '')
            .replace(/,\s*press delete.*$/i, '')
            .trim();
    }

    // AI/profile values often use vocabulary that doesn't match Workday's
    // controlled-list labels exactly. The matcher below is strict (exact /
    // startsWith / includes) so without synonyms, "Male" never resolves to
    // Workday's "Man" option, and we silently leave the dropdown unset.
    // Keep this map narrow — only well-known one-to-many vocabulary gaps that
    // recur across tenants. Each key is the lowercase target; values are
    // candidate option-text equivalents (also lowercase).
    const WORKDAY_VALUE_SYNONYMS = {
        male: ['man'],
        man: ['male'],
        female: ['woman'],
        woman: ['female'],
        nonbinary: ['non-binary', 'non binary'],
        'non-binary': ['nonbinary', 'non binary'],
        'non binary': ['nonbinary', 'non-binary'],
        'prefer not to say': ['prefer not to respond', 'prefer not to disclose', 'decline to state'],
        'prefer not to respond': ['prefer not to say', 'prefer not to disclose'],
        'not a veteran': ['i am not a veteran', 'i am not a protected veteran'],
        veteran: ['i am a protected veteran', 'protected veteran'],
        'protected veteran': ['i am a protected veteran'],
        // The "Hispanic or Latino" question's options are usually exactly Yes/No
        // — listed here to make any "true"/"false" AI answer fall through to
        // the right side instead of failing silently.
        true: ['yes'],
        false: ['no'],
        yes: ['true'],
        no: ['false']
    };

    async function fillWorkdayButtonDropdown(btn, value) {
        if (!btn || value == null) return false;
        // Fully dismiss any stale picker — a lingering listbox in the `before`
        // set would cause us to miss the real open event.
        await _dismissAllPickers();

        // Snapshot the button's visible label BEFORE we open the picker.
        // Workday button-dropdowns render the SELECTED option's text as the
        // button's own textContent (replacing the "Select One" placeholder).
        // Comparing before-vs-after is the most reliable signal that the
        // click actually committed — independent of whether the option's
        // aria-selected flipped, whether isTrusted gating blocked us, or
        // whether we clicked the wrong option text.
        const buttonTextBefore = (btn.textContent || '').trim();

        const before = new Set(_visibleListboxes());
        btn.scrollIntoView({ block: 'center' });
        await delay(80);
        _workdayRealClick(btn);

        const deadline = Date.now() + 2500;
        let listbox = null;
        while (Date.now() < deadline) {
            const now = _visibleListboxes().filter(l => !before.has(l));
            if (now.length) { listbox = now[now.length - 1]; break; }
            await delay(80);
        }
        if (!listbox) listbox = _visibleListboxes().pop() || null;
        if (!listbox) return false;

        const target = String(value).trim().toLowerCase();
        const opts = Array.from(listbox.querySelectorAll('[role="option"]'))
            .filter(o => {
                const r = o.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && o.getAttribute('aria-disabled') !== 'true';
            });
        // Strict order: exact → exact-after-punctuation-strip → startsWith →
        // includes (only when target length > 3 to avoid "Yes" → "Yes, I have a…").
        const norm = s => s.toLowerCase().replace(/[^\w]/g, ' ').replace(/\s+/g, ' ').trim();
        const nTarget = norm(target);
        const findIn = (needle) => {
            const lc = needle.toLowerCase();
            const n = norm(lc);
            return opts.find(o => _optionText(o).toLowerCase() === lc)
                || opts.find(o => norm(_optionText(o)) === n)
                || opts.find(o => _optionText(o).toLowerCase().startsWith(lc + ' ') || _optionText(o).toLowerCase().startsWith(lc + ','))
                || (lc.length > 3 ? opts.find(o => _optionText(o).toLowerCase().includes(lc)) : null);
        };
        let match = findIn(target);
        // Synonym pre-pass: if no direct match, try documented vocabulary
        // equivalents (e.g. "Male" → "Man" on Workday's gender dropdown).
        if (!match) {
            const syns = WORKDAY_VALUE_SYNONYMS[target] || WORKDAY_VALUE_SYNONYMS[nTarget] || [];
            for (const syn of syns) {
                match = findIn(syn);
                if (match) break;
            }
        }

        if (!match) {
            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (_) {}
            return false;
        }
        match.scrollIntoView({ block: 'center' });
        // Prefer the inner promptLeafNode / promptOption when present — that's
        // where Workday attaches its handler for hierarchical multiselects. For
        // simple listbox options the match element itself works.
        const clickTarget = match.querySelector('[data-automation-id="promptLeafNode"]')
            || match.querySelector('[data-automation-id="promptOption"]')
            || match;
        _workdayRealClick(clickTarget);
        await delay(200);
        // Ensure popup closes (some options don't auto-close)
        if (_visibleListboxes().length) {
            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (_) {}
        }

        // Verify the click left the button in a non-placeholder state. Success
        // criterion is "button now shows a real value", NOT "value changed
        // from before" — clicking the same option idempotently leaves the
        // text identical, which still counts as a successful fill. The only
        // real failure case is the picker re-rendering with the "Select One"
        // placeholder after the click (which happens when isTrusted gating
        // rejects the option commit). Poll up to ~800 ms because Workday
        // updates the button label asynchronously.
        const placeholderRx = /^select one\b|^\s*$/i;
        for (let i = 0; i < 8; i++) {
            const now = (btn.textContent || '').trim();
            if (now && !placeholderRx.test(now)) return true;
            await delay(100);
        }
        // The option click silently failed (isTrusted gating, race, or
        // Workday re-rendered with the placeholder). Return honest failure
        // so postFill can surface this in the fill report instead of ✓.
        // `buttonTextBefore` is reserved here for future debugging output;
        // we don't gate success on it because that produces false-fails on
        // idempotent re-clicks of the already-selected option.
        void buttonTextBefore;
        return false;
    }

    // Map of value keywords → hints for which top-level Workday category usually
    // holds them. Used as a fallback when the target token doesn't appear in any
    // visible category label (e.g. LinkedIn isn't literally "Social Media").
    const WORKDAY_SOURCE_HINTS = {
        linkedin:   ['website', 'job board', 'social media', 'social'],
        indeed:     ['website', 'job board'],
        glassdoor:  ['website', 'job board'],
        monster:    ['website', 'job board'],
        dice:       ['website', 'job board'],
        careerbuilder: ['website', 'job board'],
        ziprecruiter: ['website', 'job board'],
        google:     ['website', 'search', 'job board'],
        referral:   ['employee referral', 'referral'],
        friend:     ['employee referral', 'referral'],
        colleague:  ['employee referral', 'referral'],
        recruiter:  ['recruiter', 'recruitment agency', 'agency'],
        agency:     ['recruitment agency', 'recruiter'],
        facebook:   ['social media', 'social'],
        twitter:    ['social media', 'social'],
        instagram:  ['social media', 'social'],
        tiktok:     ['social media', 'social'],
        'company website': ['company', 'career'],
        career_fair: ['event', 'career fair', 'campus', 'recruit']
    };

    function _scopeActivePanel() {
        // Prefer the LAST activeListContainer in the DOM (Workday appends a new
        // panel on each open). Fall back to the last visible role=listbox
        // attached to the body (not inline like selectedItemList).
        const panels = Array.from(document.querySelectorAll('[data-automation-id="activeListContainer"]'))
            .filter(p => p.offsetParent !== null);
        if (panels.length) return panels[panels.length - 1];
        const listboxes = _visibleListboxes().filter(l =>
            !l.closest('[data-automation-id="multiselectInputContainer"]')
        );
        return listboxes.length ? listboxes[listboxes.length - 1] : null;
    }

    // Open a Workday prompt/multiselect panel robustly. Tenants vary: some open on
    // a synthetic click of the container, some only on the prompt icon button, some
    // need a TRUSTED click, some open via ArrowDown on the input. Returns true once
    // an active panel appears.
    async function _openPromptPanel(openTarget, input) {
        const waitPanel = async () => { for (let i = 0; i < 12; i++) { await delay(80); if (_scopeActivePanel()) return true; } return false; };
        if (openTarget) { _workdayRealClick(openTarget); if (await waitPanel()) return 'container'; }
        // Prompt icon button (the ≡ / search icon Workday renders on the right)
        const icon = openTarget?.querySelector?.(
            '[data-automation-id="promptIcon"], [data-automation-id*="rompt"], button, [role="button"], [class*="promptIcon"]'
        );
        if (icon && icon !== openTarget) { _workdayRealClick(icon); if (await waitPanel()) return 'icon'; }
        if (openTarget) { await _workdayTrustedClick(openTarget); if (await waitPanel()) return 'trusted'; }
        if (input) {
            try { input.focus(); } catch (_) {}
            try { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, composed: true })); } catch (_) {}
            if (await waitPanel()) return 'arrowdown';
        }
        return null;
    }

    async function _dismissAllPickers() {
        for (let i = 0; i < 3; i++) {
            if (!_scopeActivePanel() && !_visibleListboxes().length) return;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            try { document.body.click(); } catch (_) {}
            await delay(120);
        }
    }

    // Workday's hierarchical multiselect (How Did You Hear About Us, Country Phone
    // Code, Skills). Two shapes:
    //   flat — one level of leaves (Phone Code, Skills)
    //   tree — parent categories whose child leaves we must drill into
    // Strategy: dismiss any stale picker, open this one, try direct leaf match.
    // If none, try each top-level category that looks promising (either by token
    // overlap with the value or by the VALUE_HINTS dictionary); if still none,
    // walk every category. At each level, look for the leaf match.
    async function fillWorkdayMultiSelect(rule, value) {
        const input = rule.element;
        if (!input) return false;
        // Debug trace for prompt fills — off by default. Flip to a label regex like
        // /hear|source|school|university/i.test(rule.label || '') to trace.
        const _dbg = false;
        const _log = (...a) => { if (_dbg) console.log('[WD-SOURCE]', ...a); };
        _log('START label=', JSON.stringify(rule.label), 'value=', JSON.stringify(value));
        // Workday's handler is on the multiselectInputContainer wrapper, NOT
        // the nested <input>. Clicking the input directly fails to open the
        // picker; clicking the wrapper does.
        const openTarget = input.closest('[data-automation-id="multiselectInputContainer"]')
            || input.closest('[data-automation-id="multiSelectContainer"]')
            || input;
        await _dismissAllPickers();
        openTarget.scrollIntoView({ block: 'center' });
        await delay(100);

        // Chip-count growth is the ONLY reliable success signal across tenants.
        // On Clio-style tenants Workday's "add to selectedItems" callback is
        // gated on event.isTrusted, so a synthetic click can flip aria-selected
        // on the option without ever rendering a chip. Counting "we clicked" as
        // success silently leaves required fields empty and the user sees a
        // "12/12 ✓" badge over a half-filled form.
        const formField = openTarget.closest('[data-automation-id^="formField-"]');
        const chipList = formField?.querySelector('[data-automation-id="selectedItemList"]');
        // Success signal: chip elements, OR the "N item(s) selected" count Workday
        // renders in the field label/aria. Some tenants (this NCH one) commit the
        // selection and bump the count without rendering a child in selectedItemList,
        // so chip-children alone is a false-negative that makes the category walk
        // keep clicking (and risk toggling the just-added value off).
        const chipCount = () => {
            const n = chipList?.children?.length || 0;
            if (n) return n;
            const txt = formField?.textContent || '';
            const m = txt.match(/(\d+)\s+items?\s+selected/i);
            return m ? parseInt(m[1], 10) : 0;
        };
        // Read the visible chip labels (lowercased, stripped of the
        // ", press delete to clear value." suffix Workday adds). Used to
        // short-circuit when the target is already represented — clicking the
        // option again would TOGGLE IT OFF, which is the opposite of what we
        // want and was the root cause of the false-failure pattern.
        const currentChipTexts = () => Array.from(chipList?.children || [])
            .map(c => (c.textContent || '').replace(/,\s*press delete.*$/i, '').trim().toLowerCase());
        // Click an element and poll for a chip to appear within ~700ms. The
        // shorter delay used elsewhere isn't enough on slower React updates.
        // Uses trusted CDP click when available — required on tenants that
        // gate the chip-add callback on event.isTrusted.
        const clickAndVerify = async (el) => {
            const before = chipCount();
            await _workdayTrustedClick(el);
            for (let i = 0; i < 9; i++) {
                await delay(80);
                if (chipCount() > before) return true;
            }
            return false;
        };

        const values = Array.isArray(value) ? value : String(value).split(/\s*,\s*/).filter(Boolean);
        let filled = 0;

        for (const v of values) {
            const target = String(v).trim();
            if (!target) continue;
            const t = target.toLowerCase();
            const tokens = t.split(/\W+/).filter(w => w.length > 2);

            // Already-chip short-circuit: if a chip whose text matches the
            // target (exact, startsWith, or includes for tokens > 3 chars) is
            // already present — from a prior fill session, Workday's saved
            // state, or a previous postFill in the same run — count it as
            // filled WITHOUT clicking. Clicking would toggle the chip off.
            const present = currentChipTexts();
            const alreadyHere = present.some(ct =>
                ct === t ||
                ct.startsWith(t + ' ') || ct.startsWith(t + '(') || ct.startsWith(t + ',') ||
                (t.length > 3 && ct.includes(t))
            );
            if (alreadyHere) { filled++; continue; }

            const _openedVia = await _openPromptPanel(openTarget, input);
            await delay(200);
            if (_dbg) {
                const p = _scopeActivePanel();
                const o = p ? Array.from(p.querySelectorAll('[role="option"],[data-automation-id="menuItem"]')).filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0;}) : [];
                _log('openedVia=', _openedVia, 'panel=', !!p, 'rootOpts=', JSON.stringify(o.slice(0,12).map(x=>_optionText(x))));
            }

            const clickTargetOf = (opt) => opt.querySelector('[data-automation-id="promptLeafNode"]')
                || opt.querySelector('[data-automation-id="promptOption"]')
                || opt;

            const pickLeaf = (panel) => {
                const opts = Array.from(panel.querySelectorAll('[role="option"], [data-automation-id="menuItem"]'))
                    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                return opts.find(o => _optionText(o).toLowerCase() === t)
                    || opts.find(o => _optionText(o).toLowerCase().startsWith(t + ' ') || _optionText(o).toLowerCase().startsWith(t + '(') || _optionText(o).toLowerCase().startsWith(t + ','));
            };

            // Attempt 0: SEARCH. Most Workday prompts (How Did You Hear, Skills,
            // Country Phone Code) are searchable — typing the value filters the list
            // to the matching leaf, which we then click (or Enter selects). This is
            // far more reliable than walking a category tree and works regardless of
            // where the leaf lives in the hierarchy.
            {
                // Workday prompts like School / Skills render a SEPARATE live search
                // box — <input data-automation-id="searchBox"> — INSIDE the open panel.
                // Typing there (TRUSTED, per character) fires the server query
                // (e.g. GET .../schools?search=northeas) and renders matching options.
                // The field's own display input is NOT wired to this search, and the
                // box ignores untrusted input — so we must use the CDP per-key bridge
                // on the searchBox element specifically. (Verified against a real
                // human fill captured over CDP.)
                const bridge = window.QuickApplyTrustedInput;
                if (bridge && bridge.typeKeys && await bridge.available()) {
                    // Try progressively shorter queries — a full multi-word value
                    // (e.g. "Northeastern University") often returns nothing while a
                    // distinctive prefix ("Northeastern") matches. Each query re-opens
                    // the prompt fresh so the search box starts empty.
                    const _words = target.split(/\s+/).filter(Boolean);
                    const queries = [...new Set([target, _words.slice(0, 2).join(' '), _words[0]])]
                        .filter(q => q && q.length >= 2);
                    let sLeaf = null, _searchFilled = false;
                    for (const q of queries) {
                        await _dismissAllPickers();
                        await bridge.click(openTarget || input);   // trusted open (fresh)
                        await delay(500);
                        const _panel = _scopeActivePanel();
                        const searchBox = (_panel && _panel.querySelector('[data-automation-id="searchBox"]'))
                            || document.querySelector('[data-automation-id="searchBox"]');
                        if (!searchBox) break;   // no live search box → not a search prompt; use drill
                        await bridge.click(searchBox);          // trusted focus on the live box
                        await delay(150);
                        const _chipBefore = chipCount();
                        await bridge.typeKeys(q, false);         // trusted per-key → fires the server search as you type
                        // Poll for async results across ALL open panels (Workday renders
                        // the result list in a separate master-detail panel).
                        const _allOpts = () => Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], [data-automation-id="promptLeafNode"]'))
                            .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
                            .filter(o => !/^(no items|select one)/i.test(_optionText(o)));
                        let real = [];
                        for (let i = 0; i < 18; i++) {
                            await delay(200);
                            real = _allOpts();
                            if (real.length) break;
                        }
                        _log('searchBox q=', JSON.stringify(q), '=>', JSON.stringify(real.map(o => _optionText(o)).slice(0, 8)));
                        // Pick the BEST match (exact > startsWith > includes) so we don't
                        // grab the wrong school; only fall to first/Enter when ambiguous.
                        sLeaf = real.find(o => _optionText(o).toLowerCase() === t)
                            || real.find(o => _optionText(o).toLowerCase().startsWith(t))
                            || real.find(o => _optionText(o).toLowerCase().includes(t))
                            || real.find(o => _optionText(o).toLowerCase().includes(q.toLowerCase()))
                            || (real.length === 1 ? real[0] : null);
                        if (sLeaf) break;
                        // Press ENTER only when the list is genuinely EMPTY — that's the
                        // School-style typeahead that needs Enter to commit the top server
                        // match. When the list has options but none matched (e.g. the
                        // "How did you hear" categories), do NOT Enter (it'd select the
                        // wrong thing) — let the hierarchical drill below handle it.
                        if (real.length === 0) {
                            await bridge.typeKeys('', true);
                            await delay(700);
                            if (chipCount() > _chipBefore) { _log('selected via Enter q=', JSON.stringify(q)); filled++; _searchFilled = true; await _dismissAllPickers(); break; }
                        }
                    }
                    if (_searchFilled) continue;   // Enter already committed the selection
                    if (sLeaf && await clickAndVerify(clickTargetOf(sLeaf))) { _log('selected via searchBox'); filled++; await _dismissAllPickers(); continue; }
                    // No live search box, or no match — fall through to the category
                    // drill below (handles hierarchical prompts like "How did you hear").
                    await _dismissAllPickers();
                    await _openPromptPanel(openTarget, input);
                    await delay(300);
                }
            }

            // Attempt 1: direct leaf from root panel
            let panel = _scopeActivePanel();
            if (panel) {
                const direct = pickLeaf(panel);
                if (direct) {
                    if (await clickAndVerify(clickTargetOf(direct))) {
                        filled++;
                        await _dismissAllPickers();
                        continue;
                    }
                    // Click didn't commit — fall through to category walk.
                }
            }

            // Attempt 2: targeted hierarchical drill. Leaves (LinkedIn) nest under
            // categories (Websites). For each category — hint-ranked so the likely
            // parent is tried first — re-open a FRESH root (stale refs break the
            // drill), click the category, then POLL up to ~2s for either a terminal
            // chip or a sub-panel that contains our leaf. Retry the click once to
            // absorb the render race that made this flaky.
            const rootPanel = _scopeActivePanel();
            if (!rootPanel) continue;
            const _vis = (root) => Array.from(root.querySelectorAll('[role="option"], [data-automation-id="menuItem"]'))
                .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const rootTexts = [...new Set(_vis(rootPanel).map(o => _optionText(o)))]
                .filter(x => x && !/^no items/i.test(x));
            const rootSet = new Set(rootTexts.map(s => s.toLowerCase()));
            const hints = WORKDAY_SOURCE_HINTS[t] || [];
            const catScore = (s) => { const x = s.toLowerCase();
                return (hints.some(h => x.includes(h)) ? 2 : 0) + (tokens.some(k => x.includes(k)) ? 1 : 0); };
            const ordered = [...rootTexts].sort((a, b) => catScore(b) - catScore(a));
            _log('drill order=', JSON.stringify(ordered), 'hints=', JSON.stringify(hints));

            let found = false;
            for (const catText of ordered) {
                if (found) break;
                for (let attempt = 0; attempt < 2 && !found; attempt++) {
                    await _dismissAllPickers();
                    if (!await _openPromptPanel(openTarget, input)) break;
                    await delay(250);
                    const rp = _scopeActivePanel();
                    const cat = rp && _vis(rp).find(o => _optionText(o).toLowerCase() === catText.toLowerCase());
                    if (!cat) break;
                    const before = chipCount();
                    cat.scrollIntoView({ block: 'center' });
                    await _workdayTrustedClick(clickTargetOf(cat));
                    // Poll for: terminal chip (category WAS the leaf) | leaf in any
                    // open panel (Workday renders leaves in a SEPARATE master-detail
                    // panel, not the one _scopeActivePanel returns) | drilled-but-empty.
                    let leaf = null, drilled = false, terminal = false;
                    for (let i = 0; i < 20; i++) {
                        await delay(100);
                        if (chipCount() > before) { terminal = true; break; }
                        const panels = Array.from(document.querySelectorAll('[data-automation-id="activeListContainer"]'))
                            .filter(p => p.offsetParent !== null);
                        const sOpts = panels.flatMap(p => _vis(p));
                        if (sOpts.some(o => !rootSet.has(_optionText(o).toLowerCase()) && !/^no items/i.test(_optionText(o)))) drilled = true;
                        leaf = sOpts.find(o => _optionText(o).toLowerCase() === t)
                            || sOpts.find(o => _optionText(o).toLowerCase().startsWith(t + ' ') || _optionText(o).toLowerCase().startsWith(t + '('))
                            || sOpts.find(o => _optionText(o).toLowerCase() === t.replace(/\s+/g, ''));
                        if (leaf) break;
                    }
                    _log('drill cat=', JSON.stringify(catText), 'terminal=', terminal, 'drilled=', drilled, 'leaf=', leaf ? _optionText(leaf) : 'NONE');
                    if (terminal) { found = true; filled++; break; }
                    if (leaf) { if (await clickAndVerify(clickTargetOf(leaf))) { found = true; filled++; } break; }
                    if (drilled) break;   // category opened but our leaf isn't here → next category
                    // no drill, no chip → render race; retry the click once
                }
            }
            if (found) { await _dismissAllPickers(); continue; }
            await _dismissAllPickers();

            // Between value iterations for a multi-value field, always return
            // the picker to a known-closed state so the next open click reliably
            // TOGGLES ON (not off).
            await _dismissAllPickers();
        }

        await _dismissAllPickers();
        _log('END filled=', filled);
        return filled > 0;
    }

    // Workday dates: the visible "04" display is decorative; the actual state is
    // in the spinbutton, which on newer Workday builds only commits on TRUSTED
    // key events (event.isTrusted === true). Extensions can't forge that from
    // page context, so we do our best-effort synthetic sequence plus a native
    // value-setter fallback. If a tenant ignores both, the date field stays blank
    // and the user sees an inline "field required" error — no silent success.
    // Re-resolve the spinbuttons by container ID because Workday can remove and
    // re-render them between discovery and postFill (virtualization).
    // Self-Identify and similar pages have a Date* field that wants TODAY's date
    // (the date the candidate is signing the form). The AI sometimes resolves this
    // to date-of-birth or another profile date, so we override before filling
    // whenever the rule's label looks like a "today / signature" date prompt.
    function _isTodayDateLabel(label) {
        if (!label) return false;
        const s = String(label).toLowerCase().trim();
        if (/(birth|graduation|start|hire|end|expir|issue|valid|anniversar)/i.test(s)) return false;
        if (/^date\*?\s*$/i.test(s)) return true;
        if (/(today'?s?\s*date|signature\s*date|date\s*sign(ed)?|date\s*of\s*signature)/i.test(s)) return true;
        return false;
    }
    function _todayMMDDYYYY() {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}/${dd}/${d.getFullYear()}`;
    }

    async function fillWorkdayDate(rule, value) {
        // Override AI-resolved date when the field is a today's-date / signature prompt.
        // Catches the Self-Identify "Date*" field that otherwise gets a random profile date.
        if (_isTodayDateLabel(rule.label)) {
            value = _todayMMDDYYYY();
        }
        let parts = rule._workdayDateParts;
        const containerId = rule._workdayContainerId;
        const isLive = (el) => el && el.isConnected;
        if (!parts || !isLive(parts.month) || !isLive(parts.year)) {
            const cont = containerId
                ? document.querySelector(`[data-automation-id="${CSS.escape(containerId)}"]`)
                : null;
            if (!cont) return false;
            parts = {
                month: cont.querySelector('[data-automation-id="dateSectionMonth-input"]'),
                day:   cont.querySelector('[data-automation-id="dateSectionDay-input"]'),
                year:  cont.querySelector('[data-automation-id="dateSectionYear-input"]')
            };
            if (!parts.month || !parts.year) return false;
        }
        // Normalize to MM DD YYYY digits
        const str = String(value || '').trim();
        const m = str.match(/(\d{1,2})[\/\-. ]+(\d{1,2})[\/\-. ]+(\d{2,4})/)
            || str.match(/(\d{4})[\/\-. ]+(\d{1,2})[\/\-. ]+(\d{1,2})/);
        let mm, dd, yyyy;
        if (m) {
            if (m[1].length === 4) { [yyyy, mm, dd] = [m[1], m[2], m[3]]; }
            else { [mm, dd, yyyy] = [m[1], m[2], m[3]]; }
        } else {
            // Accept MM/YYYY (startDate / endDate) — only if this date has no Day part
            const mo = str.match(/(\d{1,2})[\/\-. ]+(\d{2,4})/);
            if (mo) { [mm, yyyy] = [mo[1], mo[2]]; dd = ''; }
            // Year-only ("2024") — common when the AI parses an education
            // graduation year from a CV. Workday's Education "From"/"To
            // (Actual or Expected)" date fields render as year-only triplets
            // (no Month/Day inputs); we still set yyyy and let the part-fill
            // skip absent inputs.
            else if (/^\d{4}$/.test(str)) { yyyy = str; mm = ''; dd = ''; }
            // Bare 1-2 digit value ("12"): we have no year context, so
            // refuse — better to leave blank than write a corrupt month into
            // a year input. The AI should be returning structured dates.
            else return false;
        }
        if (yyyy.length === 2) yyyy = '20' + yyyy;
        const expectDay = !!parts.day;
        if (expectDay && !dd) dd = '01';   // default if MM/YYYY provided for MM/DD/YYYY field

        const { month, day, year } = parts;
        // Scroll into view with headroom so sticky footer doesn't intercept focus
        const wrap = rule.element || month;
        wrap.scrollIntoView({ block: 'center' });
        await delay(120);

        // Clear existing values (happens when Workday pre-fills or earlier attempt
        // partially wrote digits).
        const clearOne = (el) => {
            if (!el) return;
            el.focus();
            const v = String(el.value || '');
            for (let i = 0; i < Math.max(v.length, 1); i++) {
                const ev = { bubbles: true, key: 'Backspace', code: 'Backspace', keyCode: 8 };
                try { el.dispatchEvent(new KeyboardEvent('keydown', ev)); } catch (_) {}
                try { el.dispatchEvent(new KeyboardEvent('keyup', ev)); } catch (_) {}
            }
        };
        clearOne(year); clearOne(day); clearOne(month);
        // Workday debounces its spinbutton state update; 60ms was too short on
        // slower tenants and the first typed digit would land before the clear
        // committed. 180ms has been reliable across Robert Half / Veritiv / Adobe.
        await delay(180);

        // Year-only: skip the month/day typing and focus year directly. Avoids
        // writing zeros into month/day that some Workday tenants reject and
        // others treat as month=0 → invalid.
        const yearOnly = !mm && yyyy;
        if (yearOnly) {
            year.focus();
            for (const ch of yyyy.padStart(4, '0')) {
                const active = document.activeElement;
                const evtInit = { bubbles: true, key: ch, code: 'Digit' + ch, keyCode: 48 + Number(ch) };
                try { active.dispatchEvent(new KeyboardEvent('keydown', evtInit)); } catch (_) {}
                try { active.dispatchEvent(new KeyboardEvent('keypress', evtInit)); } catch (_) {}
                try { active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })); } catch (_) {}
                try { active.dispatchEvent(new KeyboardEvent('keyup', evtInit)); } catch (_) {}
                await delay(35);
            }
        } else {
            month.focus();
            const digits = mm.padStart(2, '0')
                + (expectDay ? dd.padStart(2, '0') : '')
                + yyyy.padStart(4, '0');
            for (const ch of digits) {
                const active = document.activeElement;
                const evtInit = { bubbles: true, key: ch, code: 'Digit' + ch, keyCode: 48 + Number(ch) };
                try { active.dispatchEvent(new KeyboardEvent('keydown', evtInit)); } catch (_) {}
                try { active.dispatchEvent(new KeyboardEvent('keypress', evtInit)); } catch (_) {}
                try { active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })); } catch (_) {}
                try { active.dispatchEvent(new KeyboardEvent('keyup', evtInit)); } catch (_) {}
                await delay(35);
            }
        }

        // Fallback: if synthetic keys didn't commit, try the native value setter
        // + aria-valuenow attribute mutation. Some Workday tenants accept this.
        if ((!yearOnly && (!month.value || !year.value)) || (yearOnly && !year.value)) {
            const setVal = (el, v) => {
                if (!el) return;
                el.focus();
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter?.call(el, v);
                el.setAttribute('aria-valuenow', v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            if (!yearOnly) {
                setVal(month, String(Number(mm)));
                if (expectDay) setVal(day, String(Number(dd)));
            }
            setVal(year, yyyy);
        }

        try { document.activeElement?.dispatchEvent(new FocusEvent('blur', { bubbles: true })); } catch (_) {}
        if (yearOnly) return Boolean(year.value);
        return Boolean(month.value && year.value && (!expectDay || day.value));
    }

    // Detect the current Workday application step name from the DOM.
    // Returns the visible step label (e.g. "My Information", "Application Questions")
    // or an empty string when the step bar is absent (non-application pages).
    function getWorkdayCurrentStepName() {
        // wd5 / newer builds: horizontal step tab bar with aria-selected on the active tab
        const stepTab = document.querySelector(
            '[data-automation-id="stepTabBar"] [aria-selected="true"],' +
            '[data-automation-id="step"][aria-selected="true"],' +
            '[role="tablist"] [role="tab"][aria-selected="true"]'
        );
        if (stepTab) return stepTab.textContent.replace(/\s+/g, ' ').trim();
        // Older builds: page header contains the step title as an h1/h2
        const header = document.querySelector('[data-automation-id="pageHeader"]');
        if (header) {
            const h = header.querySelector('h1, h2') || header;
            return (h.textContent || '').replace(/\s+/g, ' ').trim();
        }
        // Breadcrumb / stepper fallback
        const breadcrumb = document.querySelector('[data-automation-id="breadcrumb"] [aria-current="page"]');
        if (breadcrumb) return breadcrumb.textContent.replace(/\s+/g, ' ').trim();
        return '';
    }

    class WorkdayFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'workday'; }

        async preFill() {
            const start = Date.now();
            while (Date.now() - start < 6000) {
                const fields = document.querySelectorAll('[data-automation-id]');
                if (fields.length > 3) break;
                await delay(300);
            }
            // Expand Work Experience / Education / Languages / Websites
            let total = 0, pass = 0;
            do {
                pass = await expandRepeatingSections(document);
                total += pass;
                if (pass) await delay(400);
            } while (pass > 0 && total < 8);
        }

        async discoverFields() {
            const base = window.QuickApplyFieldDiscoverer.scan(document, 'workday');
            const extra = discoverWorkdayControls(document);
            // Dedup: when a rule collides on selector or on (label+type), prefer
            // the one with `_workdayKind` set — it routes through the Workday
            // postFill handlers that actually know how to click button-dropdowns,
            // spinbutton dates, and hierarchical multiselects. Losing that flag
            // silently falls back to the generic engine, which no-ops on these.
            const byKey = new Map();
            const keyOf = (r) => r.selector || (r.label + '|' + r.type);
            for (const r of [...base, ...extra]) {
                const key = keyOf(r);
                const existing = byKey.get(key);
                if (!existing || (r._workdayKind && !existing._workdayKind)) {
                    byKey.set(key, r);
                }
            }
            // Drop fields the generic engine will mis-fill on Workday. Today:
            //  - `formField-preferredCheck` (Disney/wd5): a checkbox labeled
            //    "I have a preferred name". The engine fills it with the label
            //    string ("I have a preferred name") which is truthy → checkbox
            //    flips on → Workday reveals the preferred-name sub-section
            //    (Prefix / First / Middle / Last) → the engine fuzzy-matches
            //    those to the legal-name aliases and writes duplicate values.
            //    The candidate didn't ask for a preferred name; leave it off.
            //  - `formField-regionSubdivision1` ("County"): free-text. The AI
            //    has no county data and fuzzy-matches the state ("California")
            //    into it. Skip rather than write the wrong value.
            //  - `formField-extension` ("Phone Extension"): digit code for an
            //    office line (x123) — not "alternate phone". The label "Phone
            //    Extension" still fuzzy-matches the phone value at the engine
            //    layer even after the `alternatePhone:['extension']` alias was
            //    removed. No profile key carries an actual extension; skip.
            const skipContainerIds = new Set([
                'formField-preferredCheck',
                'formField-regionSubdivision1',
                'formField-extension'
            ]);
            return Array.from(byKey.values()).filter(r => {
                try {
                    const cont = r.element?.closest?.('[data-automation-id^="formField-"]')
                        || r.labelElement?.closest?.('[data-automation-id^="formField-"]');
                    const id = cont?.getAttribute?.('data-automation-id');
                    if (skipContainerIds.has(id)) return false;

                    // Skip fields in sections the user wants left empty
                    // (Certifications / Skills / Languages). Classified by the
                    // nearest section heading so it's robust across tenants.
                    if (_WORKDAY_SKIP_SECTIONS.test(_workdaySectionTitle(r.element || cont))) return false;

                    // Drop base-discoverer rules for the individual spinbutton
                    // inputs inside a Workday date triplet. They have
                    // role="spinbutton" and live inside a
                    // [data-automation-id="dateInputWrapper"]; the generic
                    // engine treats them as plain inputs and writes whatever
                    // the AI returned (degree strings, "12", etc.) into them,
                    // corrupting the date. The synthesised dateTriplet rule
                    // (`_workdayKind:'dateTriplet'`) handles these correctly in
                    // postFill, so we let only that rule survive.
                    if (!r._workdayKind && r.element?.getAttribute?.('role') === 'spinbutton'
                        && r.element.closest?.('[data-automation-id="dateInputWrapper"]')) {
                        return false;
                    }

                    // Drop base-discoverer rules whose element IS a Workday
                    // multiselect/picker that already has a _workdayKind rule.
                    // The base rule writes its answer into the inner search
                    // input as raw text — which becomes a "search query" Workday
                    // never commits, leaving the field with stray text AND no
                    // chip. The dedup map only catches collisions on selector;
                    // these don't collide because the workday rule's selector
                    // targets the container, not the inner input.
                    if (!r._workdayKind && r.element?.closest?.('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]')) {
                        return false;
                    }

                    return true;
                } catch (_) { return true; }
            });
        }

        async postFill() {
            // Fill the Workday-specific controls that fill-engine can't resolve directly.
            // content.js stashes the resolved answers Map on the filler before calling us.
            const answers = this._lastAnswers;
            const getAnswer = (rule) => {
                if (!answers) return null;
                if (typeof answers.get === 'function') return answers.get(rule.fingerprint);
                return answers[rule.fingerprint];
            };
            // Prefer cached rules (same objects fill-engine saw) to avoid re-running discovery
            const rules = this._lastRules?.length ? this._lastRules : await this.discoverFields();
            // Track which `_workdayKind` rules silently failed to commit so
            // content.js can demote them from "filled" → "error" in the fill
            // report. Without this, fill-engine reports every `_workdayKind`
            // rule with an answer as ✓, but postFill's actual handlers can
            // return false (mismatched dropdown option, isTrusted-gated chip
            // click, bare-month date that won't parse) leaving the field
            // visibly empty under a green checkmark. Exposed at
            // `this._workdayFailedFingerprints` for content.js to read.
            const failedFingerprints = new Set();
            for (const rule of rules) {
                if (!rule._workdayKind) continue;
                let answer = getAnswer(rule);
                // Today's-date triplets (Self-Identify "Date*") fill even when the AI
                // skipped them — fillWorkdayDate will rewrite to today's date anyway.
                const todayDateOverride = rule._workdayKind === 'dateTriplet' &&
                                          _isTodayDateLabel(rule.label);
                if ((answer == null || answer === '') && !todayDateOverride) continue;
                let ok = false;
                try {
                    if (rule._workdayKind === 'buttonDropdown') {
                        ok = await fillWorkdayButtonDropdown(rule.element, answer);
                    } else if (rule._workdayKind === 'dateTriplet') {
                        ok = await fillWorkdayDate(rule, answer);
                    } else if (rule._workdayKind === 'multiSelect') {
                        ok = await fillWorkdayMultiSelect(rule, answer);
                    }
                } catch (_) { ok = false; }
                if (!ok && rule.fingerprint) failedFingerprints.add(rule.fingerprint);
            }

            // Terms-acceptance checkboxes (Voluntary Disclosures "I have read
            // and I agree to the above", and similar) are gated by the base
            // engine's `fillCheckbox`, which writes `checked=true` via the
            // native setter. On Workday/wd5 the React layer ignores the
            // synthetic event chain and the visible checkbox stays unchecked
            // while the report claims ✓. Re-click via the trusted-event-shape
            // helper used elsewhere in this file, then verify the checkbox
            // committed. Any rule still unchecked goes into the failure set so
            // the report's stats are honest.
            const TERMS_CONTAINER_IDS = [
                'formField-acceptTermsAndAgreements',
                'formField-acceptTerms',
                'formField-termsAndConditions'
            ];
            for (const rule of rules) {
                if (rule._workdayKind) continue; // workday-kind rules already handled above
                const cont = rule.element?.closest?.('[data-automation-id^="formField-"]')
                    || rule.labelElement?.closest?.('[data-automation-id^="formField-"]');
                const containerId = cont?.getAttribute?.('data-automation-id');
                if (!TERMS_CONTAINER_IDS.includes(containerId)) continue;
                const cb = cont.querySelector('input[type="checkbox"]');
                if (!cb) continue;
                const answer = getAnswer(rule);
                const wantChecked = answer === true || answer === 'true' || answer === 'on'
                    || (typeof answer === 'string' && /^(yes|i (have read|agree))/i.test(answer));
                if (!wantChecked) continue;
                if (cb.checked) continue; // base engine already succeeded
                // Force a real-click via the same trusted-event-shape helper the
                // dropdown/multiselect paths use. Click the label or wrapper
                // when present — Workday often attaches its handler there.
                const clickTarget = cont.querySelector('label[for="' + (cb.id ? CSS.escape(cb.id) : '') + '"]')
                    || cont.querySelector('[data-automation-id*="check"]')
                    || cb;
                _workdayRealClick(clickTarget);
                await delay(180);
                if (!cb.checked) {
                    // Last resort: dispatch a direct click on the input element
                    try { cb.click(); } catch (_) {}
                    await delay(120);
                }
                if (!cb.checked && rule.fingerprint) failedFingerprints.add(rule.fingerprint);
            }

            // ── Default-answer pass: unfilled REQUIRED Yes/No button-dropdowns ──
            // Eligibility / work-authorization / consent questions the AI left blank
            // (e.g. "If you are under 18, can you provide proof of eligibility?",
            // "Are you able to comply with this policy?") get a safe "Yes" so the step
            // isn't blocked. We deliberately DO NOT touch adverse questions (felony,
            // fired, non-compete, fraud, disciplinary, investigation) — those are
            // answered by the AI (usually "No") and a wrong "Yes" would be harmful; an
            // unanswered adverse question is left blank for the human.
            const _AFFIRM_DEFAULT = /eligible to work|eligible for employment|legally eligible|authorized to work|right to work|work authorization|proof of (your )?eligibilit|able to comply|comply with (this|the) polic|\bconsent\b|i agree|acknowledge|under 18|18 years/i;
            const _ADVERSE_Q = /felony|misdemeanor|convicted|\bfired\b|asked to resign|terminated|non-?compete|restrictive covenant|fraud|disciplin|investigat|charge/i;
            for (const rule of rules) {
                if (rule._workdayKind !== 'buttonDropdown') continue;
                const btn = rule.element;
                if (!btn) continue;
                const cur = (btn.textContent || '').trim().toLowerCase();
                if (cur && cur !== 'select one') continue;          // already answered
                const label = rule.label || '';
                if (!_AFFIRM_DEFAULT.test(label) || _ADVERSE_Q.test(label)) continue;
                try { await fillWorkdayButtonDropdown(btn, 'Yes'); } catch (_) {}
            }

            this._workdayFailedFingerprints = failedFingerprints;

            // Workday's phoneNumber input validates strictly and rejects values
            // that include the country-code prefix ("+1 (555) ...") OR display
            // formatting ("(555) 123-4567") — countryPhoneCode is a sibling field
            // that owns the prefix, and the input itself wants digits only. The
            // generic engine writes the profile answer verbatim, so on tenants
            // where the profile carries either we land in an immediate "Enter a
            // valid format for Phone Number." error state.
            // Normalize defensively to digits-only (with a leading "1" country
            // code stripped for US 11-digit numbers) and redispatch input/change/blur.
            try {
                const phoneCont = document.querySelector('[data-automation-id="formField-phoneNumber"]');
                const phoneInput = phoneCont?.querySelector('input');
                if (phoneInput && phoneInput.value) {
                    const digits = phoneInput.value.replace(/\D/g, '');
                    const normalized = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
                    if (normalized && normalized !== phoneInput.value) {
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        phoneInput.focus();
                        setter?.call(phoneInput, normalized);
                        phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
                        phoneInput.dispatchEvent(new Event('change', { bubbles: true }));
                        phoneInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                    }
                }
            } catch (_) {}

            // Legacy Polymer notify-path pass for any shadow-DOM inputs
            function collectShadowElements(root, selector, results = []) {
                try {
                    for (const el of root.querySelectorAll(selector)) results.push(el);
                    for (const el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) collectShadowElements(el.shadowRoot, selector, results);
                    }
                } catch (_) {}
                return results;
            }
            const shadowInputs = collectShadowElements(document, '[data-automation-id]');
            for (const el of shadowInputs) {
                if (el.value && typeof el.set === 'function') {
                    try { el.set('value', el.value); } catch (_) {}
                    try { el.notifyPath?.('value', el.value); } catch (_) {}
                }
            }
        }

        getFieldAliases() {
            return {
                firstName: ['legalname--firstname', 'legal-name-section--first-name'],
                lastName: ['legalname--lastname', 'legal-name-section--last-name'],
                email: ['emailaddress'],
                phone: ['phonenumber'],
                // NOTE: Workday's `formField-extension` is "Phone Extension"
                // (digit code like x123), NOT an alternate phone line. Aliasing
                // `alternatePhone` to it caused the full phone number to land in
                // the Extension field on Clio-tenant. Leave it unmapped — a
                // future profile key (`phoneExtension`) can be wired here.
                streetAddress: ['addressline1'],
                city: ['city'],
                state: ['countryregion', 'country-region', 'country_region'],
                zipCode: ['postalcode'],
                country: ['country'],
                currentJobTitle: ['jobtitle'],
                currentCompany: ['companyname'],
                university: ['schoolname'],
                major: ['fieldofstudy'],
                gpa: ['gradeaverage'],
                heardAboutUs: ['source'],
                linkedIn: ['linkedinaccount'],
                portfolio: ['url'],
                // Workday custom-question stems that we can spot by auto-id substring
                workAuthorization: ['legally authorized to work', 'require sponsorship or other support'],
                expectedSalary: ['desired compensation'],
                desiredStartDate: ['anticipated eligibility', 'eligibility time for employment']
            };
        }

        getNextSelectors() {
            return [
                'button[data-automation-id="pageFooterNextButton"]',
                'button[data-automation-id="bottom-navigation-next-button"]',
                'button[data-automation-id="pageFooterSaveButton"]',
                // Review → Submit (final step) and Save for Later variants
                'button[data-automation-id="pageFooterSubmitButton"]',
                'button[data-automation-id="submitApplication"]',
                'button[data-automation-id="saveForLaterButton"]'
            ].join(', ');
        }
    }

    window.QuickApplyFillerFactory.register('workday', WorkdayFiller);
    window.QuickApplyWorkdayFiller = WorkdayFiller;
    window.QuickApplyWorkdayHelpers = {
        expandRepeatingSections,
        discoverWorkdayControls,
        fillWorkdayButtonDropdown,
        fillWorkdayDate,
        fillWorkdayMultiSelect,
        cleanWorkdayLabel,
        getWorkdayCurrentStepName
    };
})();
