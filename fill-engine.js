/**
 * QuickApply Fill Engine — fills form fields with enhanced event dispatch.
 * Replaces setReactValue + dispatchEvents in content.js.
 * scrollIntoView before every fill. Platform-aware event sequences.
 */
(function () {
    'use strict';

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── Native Value Setter (React/Polymer safe) ──────────────────────────────

    function setNativeValue(element, value) {
        // Reset React value tracker so React sees upcoming change as genuine user input
        try {
            if (element._valueTracker) element._valueTracker.setValue(element.value ?? '');
        } catch (_) {}

        // Use correct window context (critical for shadow DOM — different prototype chain)
        const win = element.ownerDocument?.defaultView || window;
        const proto = element.tagName === 'TEXTAREA'
            ? win.HTMLTextAreaElement?.prototype
            : win.HTMLInputElement?.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        try {
            setter ? setter.call(element, value) : (element.value = value);
        } catch (_) {
            try { element.value = value; } catch (_2) {}
        }
    }

    // ── Event Dispatch ────────────────────────────────────────────────────────

    /**
     * Dispatch the full event sequence after setting a value.
     * NOTE: 'focus' is NEVER dispatched in fillText.
     * React 15 (Workable/Greenhouse) resets field value on any focus event —
     * composed:false does NOT prevent this; React's listener fires regardless.
     */
    function dispatchValueEvents(element) {
        const isInShadow = element.getRootNode() !== document;
        const evtOpts = { bubbles: true, composed: isInShadow };

        // InputEvent with inputType — React 17+ checks this
        try {
            element.dispatchEvent(new InputEvent('input', {
                bubbles: true, composed: isInShadow,
                inputType: 'insertText',
                data: typeof element.value === 'string' ? element.value : null
            }));
        } catch (_) {
            element.dispatchEvent(new Event('input', evtOpts));
        }

        try { element.dispatchEvent(new Event('change', evtOpts)); } catch (_) {}
        try { element.dispatchEvent(new KeyboardEvent('keydown', { ...evtOpts, key: 'a', keyCode: 65 })); } catch (_) {}
        try { element.dispatchEvent(new KeyboardEvent('keyup',   { ...evtOpts, key: 'a', keyCode: 65 })); } catch (_) {}
        try { element.dispatchEvent(new FocusEvent('blur', evtOpts)); } catch (_) {}

        // Second change+blur cycle — Angular/Vue/custom frameworks
        try { element.dispatchEvent(new Event('change', evtOpts)); } catch (_) {}
        try { element.dispatchEvent(new FocusEvent('blur', evtOpts)); } catch (_) {}

        // Polymer two-way binding (Workday shadow DOM only)
        if (isInShadow && element.getAttribute('role') !== 'combobox') {
            if (element.value) {
                try {
                    element.dispatchEvent(new CustomEvent('bind-value-changed', {
                        bubbles: true, composed: true,
                        detail: { value: element.value }
                    }));
                } catch (_) {}
            }
            if (typeof element.set === 'function') try { element.set('value', element.value); } catch (_) {}
            if (typeof element.notifyPath === 'function') try { element.notifyPath('value', element.value); } catch (_) {}
        }
    }

    // ── Fill by Type ──────────────────────────────────────────────────────────

    async function fillText(element, value) {
        if (!element || value == null || String(value).trim() === '') return false;
        let stringValue = String(value);
        // <input type="number"> rejects any non-numeric string with the console
        // warning "The specified value … cannot be parsed, or is out of range"
        // and the assignment silently no-ops. Ashby (and other ATSes that let
        // recruiters pick the input type) sometimes mark Phone Number / Salary /
        // Years-of-Experience custom questions as `type=number`, so a profile
        // value like "555-123-4567" or "$120,000" fails to land. Strip to digits
        // (+ first dot for decimals) so the browser accepts the value.
        if (element.type === 'number') {
            const digits = stringValue.replace(/[^\d.]/g, '');
            if (!digits || !/\d/.test(digits)) return false;
            stringValue = digits;
        }
        setNativeValue(element, stringValue);
        dispatchValueEvents(element);
        return true;
    }

    async function fillSelect(rule, answer) {
        const el = rule.element;
        const target = String(Array.isArray(answer) ? answer[0] : answer).trim();
        if (!el || !target) return false;

        const options = Array.from(el.options).filter(o => !o.disabled);

        // Pass 1: exact text match (case-insensitive)
        let match = options.find(o => o.text.trim().toLowerCase() === target.toLowerCase());
        // Pass 2: exact value match
        if (!match) match = options.find(o => o.value.trim().toLowerCase() === target.toLowerCase());
        // Pass 3: token overlap — preserves C++, .NET, etc.
        if (!match) {
            const targetTokens = target.toLowerCase().split(/\s+/);
            match = options.find(o => {
                const optTokens = o.text.trim().toLowerCase().split(/\s+/);
                return targetTokens.every(t => optTokens.some(ot => ot === t || ot.includes(t) || t.includes(ot)));
            });
        }
        // Pass 4: aggressive normalization (last resort)
        if (!match) {
            const norm = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
            if (norm) {
                match = options.find(o => {
                    const t = o.text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                    return t && (t === norm || t.includes(norm) || norm.includes(t));
                });
            }
        }

        if (!match) return false;

        // Already on the right option — skip the re-open/re-fire. Multipass and
        // observer re-fills would otherwise re-dispatch mousedown/click + change on
        // every pass, which is wasted work and a visible flicker (the "form keeps
        // filling 3-6 times" symptom).
        if (el.selectedIndex === match.index) return true;

        const isInShadow = el.getRootNode() !== document;

        // Simulate clicking the dropdown to open it — satisfies React/Angular click listeners
        // and makes the interaction look like a real user selection.
        try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('click',     { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}

        // Short pause — lets any click-handler open the dropdown before we set the value
        await delay(30);

        // Set the selected option via both selectedIndex and the native value setter.
        // selectedIndex is more reliable for React (it tracks index, not value string).
        el.selectedIndex = match.index;

        const win = el.ownerDocument?.defaultView || window;
        const proto = win.HTMLSelectElement?.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        try { setter ? setter.call(el, match.value) : (el.value = match.value); } catch (_) { el.value = match.value; }

        // Reset _valueTracker so React's synthetic onChange fires
        try { if (el._valueTracker?.setValue) el._valueTracker.setValue(''); } catch (_) {}

        // Fire change + input to commit the selection in all frameworks
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: false, composed: isInShadow }));
        el.dispatchEvent(new Event('input',  { bubbles: true, composed: isInShadow }));
        return true;
    }

    /**
     * Ashby (and similar) render some "radio" questions as sibling <button> choice chips.
     * fillRadio() cannot toggle those — click the best-matching button instead.
     */
    function _btnIsActive(btn) {
        const cls = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
        return cls.includes('selected') || cls.includes('active') || cls.includes('pressed')
            || btn.getAttribute('aria-pressed') === 'true'
            || btn.getAttribute('aria-current') === 'true'
            || (btn.getAttribute('data-state') || '') === 'on';
    }

    async function fillButtonGroup(rule, answer) {
        const raw = Array.isArray(answer) ? answer[0] : answer;
        if (raw == null || String(raw).trim() === '') return false;

        let buttons = (rule.elements || [rule.element]).filter(
            b => b && b.tagName === 'BUTTON'
        );
        if (!buttons.length) return false;

        // React re-renders can detach stored element references.
        // Re-query from the closest stable container if any button is stale.
        if (!buttons[0].isConnected) {
            const anchor = buttons.find(b => b.isConnected) || null;
            const container = (anchor || rule.element)
                ?.closest?.('.ashby-application-form-field-entry, [class*="fieldEntry"], [class*="FieldEntry"], [class*="yesno"], [class*="ButtonGroup"]')
                || (anchor || rule.element)?.parentElement?.parentElement;
            if (container?.isConnected) {
                const fresh = Array.from(container.querySelectorAll(
                    'button[class*="_option_"], button[class*="option"], button[role="radio"]'
                )).filter(b => b.textContent?.trim());
                if (fresh.length >= 2) buttons = fresh;
            }
            if (!buttons.length || !buttons[0].isConnected) return false;
        }

        const mapper = window.QuickApplyFieldMapper;
        const tmpProf = { customFields: [] };
        const tmpFiller = window.QuickApplyAshbyFiller
            ? new window.QuickApplyAshbyFiller(tmpProf, {})
            : null;

        let fieldName = null;
        try {
            if (mapper?.identifyField) {
                const idn = mapper.identifyField(buttons[0], [], rule.label || '', tmpFiller);
                fieldName = idn?.profileField || null;
            }
        } catch (_) {}

        const options = buttons.map((b, i) => ({
            text: b.textContent.trim(),
            value: b.textContent.trim().toLowerCase(),
            index: i
        }));

        const targetStr = String(raw).trim();
        let pick = null;
        try {
            if (mapper?.fuzzyMatchOption) {
                pick = mapper.fuzzyMatchOption(options, targetStr, fieldName, rule.label || '', tmpFiller);
            }
        } catch (_) {}

        if (pick && pick.confidence > 0.2 && buttons[pick.index]) {
            const btn = buttons[pick.index];
            if (_btnIsActive(btn)) return true; // already selected — skip to avoid toggle-off
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(80);
            btn.click();
            await delay(250); // longer wait — React needs time to set _active_ class
            return true;
        }

        const t = targetStr.toLowerCase();
        for (const b of buttons) {
            const txt = (b.textContent || '').trim().toLowerCase();
            if (txt && (txt === t || txt.includes(t) || t.includes(txt))) {
                if (_btnIsActive(b)) return true; // already selected — skip to avoid toggle-off
                b.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await delay(80);
                b.click();
                await delay(250); // longer wait — React needs time to set _active_ class
                return true;
            }
        }
        return false;
    }

    async function fillRadio(rule, answer, { skipFocus = false } = {}) {
        if (rule.isButtonGroup) {
            return await fillButtonGroup(rule, answer);
        }

        const target = String(Array.isArray(answer) ? answer[0] : answer).trim().toLowerCase();
        if (!target) return false;

        const members = rule.elements || [rule.element];
        const doc = rule.element.ownerDocument || document;
        const isInShadow = rule.element.getRootNode() !== document;
        const evtOpts = { bubbles: true, composed: isInShadow };

        const win = rule.element.ownerDocument?.defaultView || window;
        const checkedSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype, 'checked')?.set;

        for (const radio of members) {
            // Collect label text from multiple sources — modern ATS often use parent labels
            // or aria-label instead of explicit label[for] elements.
            const labelEl = radio.id ? doc.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null;
            const parentLabel = radio.closest('label');
            const ariaLabel = radio.getAttribute('aria-label') || '';
            const labelText = (labelEl?.textContent || parentLabel?.textContent || ariaLabel || radio.value || '').trim().toLowerCase();

            // Guard against empty labelText: "".includes(x) is false but
            // target.includes("") is ALWAYS true, which would match an unlabeled
            // radio against any answer and select the wrong option.
            const matches = (labelText && (labelText === target || labelText.includes(target) || target.includes(labelText)))
                || (radio.value && radio.value.toLowerCase() === target);

            if (matches && !radio.checked) {
                try { checkedSetter ? checkedSetter.call(radio, true) : (radio.checked = true); } catch (_) { radio.checked = true; }
                try { if (radio._valueTracker?.setValue) radio._valueTracker.setValue(''); } catch (_) {}

                // Many ATS (Greenhouse, Ashby, Workday) use visually-hidden radio inputs with
                // a styled <label> as the visible button. Clicking the hidden input sets .checked
                // but the custom UI won't update. Click the label instead for correct visual state.
                const rect = radio.getBoundingClientRect();
                const isVisuallyHidden = rect.width === 0 || rect.height === 0;
                if (isVisuallyHidden && (labelEl || parentLabel)) {
                    (labelEl || parentLabel).click();
                } else {
                    radio.click();
                }

                await delay(50);
                // If still not checked, try clicking the label as a last resort
                if (!radio.checked) {
                    if (labelEl) labelEl.click();
                    else if (parentLabel) parentLabel.click();
                    else { try { checkedSetter ? checkedSetter.call(radio, true) : (radio.checked = true); } catch (_) {} }
                }
                try { radio.dispatchEvent(new Event('change', { ...evtOpts, cancelable: false })); } catch (_) {}
                try { radio.dispatchEvent(new Event('input', evtOpts)); } catch (_) {}
                return true;
            }
        }
        return false;
    }

    async function fillCheckbox(rule, answer) {
        const targets = (Array.isArray(answer) ? answer : [answer]).map(v => String(v).trim().toLowerCase());
        if (!targets.length) return false;

        const members = rule.elements || [rule.element];
        let filled = false;

        const win = (members[0]?.ownerDocument?.defaultView) || window;
        const checkedSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype, 'checked')?.set;

        for (const checkbox of members) {
            const doc = checkbox.ownerDocument || document;
            const labelEl = checkbox.id ? doc.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`) : null;
            const parentLabel = checkbox.closest('label');
            const ariaLabel = checkbox.getAttribute('aria-label') || '';
            const labelText = (labelEl?.textContent || parentLabel?.textContent || ariaLabel || checkbox.value || '').trim().toLowerCase();
            // Guard against empty labelText: t.includes("") is ALWAYS true, which
            // would check an unlabeled checkbox against any answer.
            const shouldCheck = !!labelText && targets.some(t => t && (labelText === t || labelText.includes(t) || t.includes(labelText)));

            if (shouldCheck && !checkbox.checked) {
                try { checkedSetter ? checkedSetter.call(checkbox, true) : (checkbox.checked = true); } catch (_) { checkbox.checked = true; }
                try { if (checkbox._valueTracker?.setValue) checkbox._valueTracker.setValue(''); } catch (_) {}

                // Click the label when checkbox is visually hidden (custom-styled checkboxes)
                const rect = checkbox.getBoundingClientRect();
                const isVisuallyHidden = rect.width === 0 || rect.height === 0;
                if (isVisuallyHidden && (labelEl || parentLabel)) {
                    (labelEl || parentLabel).click();
                } else {
                    checkbox.click();
                }

                await delay(50);
                if (!checkbox.checked) {
                    if (labelEl) labelEl.click();
                    else if (parentLabel) parentLabel.click();
                    else { try { checkedSetter ? checkedSetter.call(checkbox, true) : (checkbox.checked = true); } catch (_) {} }
                }
                const isInShadow = checkbox.getRootNode() !== document;
                const evtOpts = { bubbles: true, cancelable: false, composed: isInShadow };
                try { checkbox.dispatchEvent(new Event('change', evtOpts)); } catch (_) {}
                try { checkbox.dispatchEvent(new Event('input', { bubbles: true, composed: isInShadow })); } catch (_) {}
                filled = true;
            }
        }
        return filled;
    }

    async function fillDate(element, value) {
        // Try direct fill first
        const formatted = String(value);
        setNativeValue(element, formatted);
        dispatchValueEvents(element);

        // If date picker detected, wait and check if value took
        await delay(100);
        if (element.value === formatted) return true;

        // Field holds something other than `formatted` — either the picker ignored our
        // value or a stale value remained. Reporting success here would surface a green
        // "filled" badge for a date that is actually wrong, so callers must see false.
        return false;
    }

    async function fillCombobox(rule, answer) {
        const target = String(Array.isArray(answer) ? answer[0] : answer).trim();
        if (!target) return false;

        const el = rule.element;
        if (!el) return false;

        // Already shows the target selection? Don't re-open the menu. React-select
        // renders the current value as a .__single-value / multi-value chip. Without
        // this guard, multipass + observer re-fills re-open and re-select the same
        // dropdown on every pass — the visible "form keeps filling" symptom.
        {
            const _sc = el.closest('[class*="select__control"]') || el.closest('[class*="select-shell"]') || el.parentElement?.parentElement;
            const _shown = _sc?.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
            const _shownTxt = (_shown?.textContent || '').trim().toLowerCase();
            const _tLow = target.toLowerCase();
            if (_shownTxt && (_shownTxt === _tLow
                || _shownTxt.startsWith(_tLow.slice(0, 12))
                || _tLow.startsWith(_shownTxt.slice(0, 12)))) {
                return true;
            }
        }

        const ownerDoc = el.ownerDocument || document;
        const isInShadow = el.getRootNode() !== document;
        const evtOpts = { bubbles: true, composed: isInShadow };

        // Detect React-Select / custom select wrappers
        const sc = el.closest('[class*="select__control"]') || el.closest('[class*="select-shell"]');
        const nearestParent = sc || el.parentElement?.parentElement;
        const toggleBtn = nearestParent?.querySelector('button[aria-label="Toggle flyout"]')
            || sc?.querySelector('button');

        const openTarget = toggleBtn || sc || el;
        // mousedown + mouseup + click to reliably open React / custom dropdowns
        try { openTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
        try { openTarget.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
        openTarget.click();

        // Keyboard fallback: some react-select variants (new Greenhouse forms at
        // job-boards.greenhouse.io, where the combobox is wrapped in .select-shell
        // / .select__control with no separate toggle button) ignore mousedown on
        // the wrapper. ArrowDown on the input itself reliably opens those. This
        // is a no-op when the menu is already open — pressing ArrowDown a second
        // time just moves the highlight, which the subsequent option-search
        // ignores. Guarded on aria-expanded so we don't double-fire on variants
        // that opened cleanly.
        if (el.getAttribute('aria-expanded') === 'false') {
            try {
                el.focus();
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40,
                    bubbles: true, composed: isInShadow, cancelable: true
                }));
            } catch (_) {}
        }

        // Option selectors + finder declared BEFORE _typeAndWait because the poll inside
        // _typeAndWait calls _findOpts (which reads optionSelectors). A `const` is in the
        // temporal dead zone until its line runs, so it must precede the first call.
        const optionSelectors = [
            '[role="option"]',
            '[role="listitem"]',
            '.select__option',
            'li[aria-selected]',
            '[class*="menu-item"]',
            '[class*="option__label"]',
            '[class*="option"][class*="item"]',
        ];

        function _findOpts(root) {
            for (const sel of optionSelectors) {
                const found = Array.from(root.querySelectorAll(sel)).filter(o => {
                    const r = o.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                if (found.length > 0) return found;
            }
            return [];
        }

        // Always type to filter after opening — essential for searchable dropdowns (React-Select,
        // country/state pickers). For React-Select: click opens the menu showing all options,
        // typing narrows the list. For plain autocomplete inputs: typing triggers suggestions.
        async function _typeAndWait(query) {
            setNativeValue(el, query);
            try {
                el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: isInShadow, inputType: 'insertText', data: query }));
            } catch (_) {
                el.dispatchEvent(new Event('input', evtOpts));
            }
            // Poll for options to render instead of a flat 700ms wait. Fast dropdowns
            // (Yes/No, Gender, demographics) render in ~50ms and return immediately;
            // slow location autocompletes get up to 900ms. Faster AND more reliable
            // than a fixed wait that was both too long for menus and too short for APIs.
            const _deadline = Date.now() + 900;
            while (Date.now() < _deadline) {
                await delay(60);
                if (_findOpts(ownerDoc).length || _findOpts(document.body || ownerDoc.body || ownerDoc).length) return;
            }
        }

        // Capture the unfiltered option list before typing.
        // Click opens the full menu; typing narrows it. Grab a pre-filter
        // snapshot here so we can fall back to it when the typed query
        // produces zero results or no string match.
        await delay(150);
        let preTypeOpts = _findOpts(ownerDoc);
        if (!preTypeOpts.length) preTypeOpts = _findOpts(document.body || ownerDoc.body || ownerDoc);

        await _typeAndWait(target);

        // Collect visible options. React portals render menus into document.body
        // outside the component tree, so search both ownerDoc and document.body.
        let opts = _findOpts(ownerDoc);
        if (opts.length === 0) opts = _findOpts(document.body || ownerDoc.body || ownerDoc);

        // Fallback: retry with shorter query (first two comma-parts).
        // E.g. "Roxbury, Massachusetts, USA" → "Roxbury, Massachusetts"
        // Prevents substring false-match where "massa" matches inside "massachusetts".
        if (opts.length === 0 && target.includes(',')) {
            const shorter = target.split(',').slice(0, 2).join(',').trim();
            await _typeAndWait(shorter);
            opts = _findOpts(ownerDoc);
            if (opts.length === 0) opts = _findOpts(document.body || ownerDoc.body || ownerDoc);
        }

        // Helper: run full matching cascade against an option list.
        // Returns the best matching option element, or null.
        const tLow = target.toLowerCase();
        function _matchInList(list) {
            let b = list.find(o => o.textContent.trim().toLowerCase() === tLow);
            if (!b) b = list.find(o => {
                const oLow = o.textContent.trim().toLowerCase();
                return oLow.startsWith(tLow.substring(0, Math.min(tLow.length, 12)))
                    || tLow.startsWith(oLow.substring(0, Math.min(oLow.length, 12)));
            });
            if (!b) b = list.find(o => {
                const oLow = o.textContent.trim().toLowerCase();
                const fw = oLow.split(/[,\s]/)[0];
                return fw.length >= 3 && tLow.includes(fw);
            });
            if (!b && list.length === 1) b = list[0];
            // numeric → range
            if (!b && /^\d+(\.\d+)?$/.test(target)) {
                const num = parseFloat(target);
                b = list.find(o => {
                    const oText = o.textContent.trim();
                    const rm = oText.match(/(\d+)\s*[-–]\s*(\d+)/);
                    if (rm) return num >= parseFloat(rm[1]) && num <= parseFloat(rm[2]);
                    const pm = oText.match(/(\d+)\+/);
                    return pm && num >= parseFloat(pm[1]);
                });
            }
            // range-range overlap
            if (!b) {
                const tRM = target.match(/(\d+)\s*[-–]\s*(\d+)/);
                if (tRM) {
                    const tMin = parseFloat(tRM[1]), tMax = parseFloat(tRM[2]);
                    let bs = -1;
                    list.forEach(o => {
                        const oText = o.textContent.trim();
                        const oR = oText.match(/(\d+)\s*[-–]\s*(\d+)/);
                        let s = -1;
                        if (oR) { s = Math.min(tMax, parseFloat(oR[2])) - Math.max(tMin, parseFloat(oR[1])); }
                        else { const pm = oText.match(/(\d+)\+/); if (pm && tMax >= parseFloat(pm[1])) s = 0.5; }
                        if (s > bs) { bs = s; b = o; }
                    });
                    if (bs < 0) b = null;
                }
            }
            // word overlap: pick option sharing the most content words (≥4 chars) with target.
            // Handles "No experience" → "No Salesforce experience", "Basic" → "Basic user", etc.
            if (!b) {
                const tWords = tLow.split(/\W+/).filter(w => w.length >= 4);
                if (tWords.length > 0) {
                    let bestScore = 0;
                    list.forEach(o => {
                        const oLow = o.textContent.trim().toLowerCase();
                        const score = tWords.filter(w => oLow.includes(w)).length;
                        if (score > bestScore) { bestScore = score; b = o; }
                    });
                    if (bestScore === 0) b = null;
                }
            }
            // word-boundary substring
            if (!b && tLow.length >= 4) {
                const esc = tLow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const wbRe = new RegExp('(?:^|\\s|[^a-z0-9])' + esc + '(?:\\s|[^a-z0-9]|$)', 'i');
                b = list.find(o => wbRe.test(o.textContent.trim()));
            }
            return b || null;
        }

        if (opts.length === 0) {
            // Typing produced no visible options (query may have filtered list to nothing).
            // Try matching against the pre-typing full snapshot, re-type the matched option's
            // own text so the dropdown re-shows it, then click it directly.
            if (preTypeOpts.length > 0) {
                const preMatch = _matchInList(preTypeOpts);
                if (preMatch) {
                    const exactText = preMatch.textContent.trim();
                    await _typeAndWait(exactText);
                    const reOpts = (() => {
                        const r = _findOpts(ownerDoc);
                        return r.length ? r : _findOpts(document.body || ownerDoc.body || ownerDoc);
                    })();
                    if (reOpts.length > 0) {
                        const eLow = exactText.toLowerCase();
                        const reMatch = reOpts.find(o => o.textContent.trim().toLowerCase() === eLow)
                            || reOpts.find(o => o.textContent.trim().toLowerCase().startsWith(eLow.slice(0, 12)))
                            || reOpts[0];
                        if (reMatch) {
                            const _bT = reMatch.querySelector('[class*="option-content"], [class*="option__label"]') || reMatch;
                            for (const type of ['mousedown', 'mouseup', 'click']) {
                                try { _bT.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
                            }
                            await delay(150);
                            return true;
                        }
                    }
                }
            }

            // No preTypeOpts match or re-type didn't produce clickable options.
            if (sc || toggleBtn) {
                try { el.dispatchEvent(new KeyboardEvent('keydown', { ...evtOpts, key: 'Escape', keyCode: 27 })); } catch (_) {}
                setNativeValue(el, '');
                try { el.dispatchEvent(new Event('input', evtOpts)); } catch (_) {}
                return false;
            }
            dispatchValueEvents(el);
            return el.value !== '';
        }

        // opts is non-empty: run the matching cascade against the typed-filtered list.
        let best = _matchInList(opts);

        if (best) {
            // Dispatch a full mouse sequence, not just .click(). Ant Design selects
            // (Dayforce, and other antd-based ATSs) commit the option on mousedown and
            // call preventDefault, so a bare .click() opened the menu but never selected.
            // react-select also honors mousedown — so this is safe across widgets.
            const _bTarget = best.querySelector('[class*="option-content"], [class*="option__label"]') || best;
            for (const type of ['mousedown', 'mouseup', 'click']) {
                try { _bTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: isInShadow, cancelable: true })); } catch (_) {}
            }
            await delay(150);
            return true;
        }

        // No option matched — close menu and clear input so no garbage value remains
        try { el.dispatchEvent(new KeyboardEvent('keydown', { ...evtOpts, key: 'Escape', keyCode: 27 })); } catch (_) {}
        setNativeValue(el, '');
        try { el.dispatchEvent(new Event('input', evtOpts)); } catch (_) {}
        return false;
    }

    async function fillFile(rule, answer) {
        // CV upload delegates to existing content.js file upload logic
        if (window._qaFillFileLegacy) {
            return window._qaFillFileLegacy(rule);
        }
        return false;
    }

    // ── ProgressTracker ───────────────────────────────────────────────────────

    class ProgressTracker {
        constructor(total, clientId) {
            this._total = total;
            this._filled = [];   // {label, value, ms}
            this._errors = [];   // {label, reason, ms}
            this._clientId = clientId;
            this._t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this._debug = false;
            // Read the debug flag without blocking; if set we'll catch up at the next
            // mark*() call. The FILL_START line fires when the flag resolves so it
            // shows even before the first field is touched.
            try {
                chrome.storage.local.get('quickapply_debug').then(s => {
                    this._debug = !!s.quickapply_debug;
                    if (this._debug) console.log(`[QuickApply] FILL_START t=0ms total=${total} url=${(location.pathname + location.search).slice(0, 80)}`);
                }).catch(() => {});
            } catch (_) {}
        }
        _elapsed() { return Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._t0); }
        _pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }

        markFilled(rule, value) {
            const ms = this._elapsed();
            this._filled.push({ label: rule.label, value, ms });
            if (this._debug) console.log(`  ✓ ${this._pad(rule.label, 32)} → ${JSON.stringify(value ?? '').slice(0, 40)}  [${ms}ms]`);
            this._notify();
        }
        markError(rule, reason = 'unknown') {
            const ms = this._elapsed();
            this._errors.push({ label: rule.label, reason, ms });
            if (this._debug) console.log(`  ✗ ${this._pad(rule.label, 32)} → ERROR: ${reason}  [${ms}ms]`);
            this._notify();
        }

        // Call once after fillAll() returns. Walks the rule list to surface the
        // required-but-unfilled fields along with their available option text —
        // the same info the user previously had to dig out manually after a stall.
        finalize(allRules = [], answersMap = null) {
            const ms = this._elapsed();
            if (!this._debug) return;
            const filledLabels = new Set(this._filled.map(f => f.label));
            const errorLabels = new Set(this._errors.map(e => e.label));
            const unfilled = (allRules || []).filter(r => r && r.required && !filledLabels.has(r.label) && !errorLabels.has(r.label));
            console.log(`[QuickApply] FILL_END filled=${this._filled.length}/${this._total} errors=${this._errors.length} unfilled=${unfilled.length} t=${ms}ms`);
            if (unfilled.length) {
                console.log('  unfilled questions:');
                for (const r of unfilled) {
                    const opts = this._optionsOf(r);
                    console.log(`    "${r.label}"  opts=${opts.length ? JSON.stringify(opts) : '(no enumerable options)'}`);
                }
            }
            if (this._errors.length) {
                console.log('  errors:');
                for (const e of this._errors) console.log(`    "${e.label}"  reason=${e.reason}`);
            }
        }

        _optionsOf(rule) {
            try {
                const el = rule.element;
                if (!el) return [];
                if (el.tagName === 'SELECT') return [...el.options].map(o => (o.text || o.value || '').trim()).filter(Boolean).slice(0, 16);
                if (rule.type === 'radio') {
                    const name = el.getAttribute && el.getAttribute('name');
                    if (name) return [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
                        .map(r => {
                            const lbl = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
                            return ((lbl && lbl.innerText) || r.value || '').replace(/\s+/g, ' ').trim();
                        }).filter(Boolean).slice(0, 16);
                }
                if (rule.type === 'combobox' || rule.type === 'select') {
                    return [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"], [data-automation-id="promptLeafNode"]')]
                        .filter(o => o.getBoundingClientRect().width > 0)
                        .map(o => (o.innerText || '').trim())
                        .filter(Boolean).slice(0, 16);
                }
                return [];
            } catch { return []; }
        }

        _notify() {
            const required = { filled: this._filled.length, total: this._total };
            chrome.runtime.sendMessage({
                type: 'FILL_PROGRESS',
                filled: this._filled.length,
                total: this._total,
                filledLabels: this._filled.slice(-5).map(f => f.label),
                missingRequiredLabels: this._errors.map(e => e.label),
                required
            }).catch(() => {});
        }

        snapshot() {
            return { filled: this._filled.length, total: this._total, errors: this._errors };
        }
    }
    window.QuickApplyProgressTracker = ProgressTracker;

    // ── Main Entry Points ─────────────────────────────────────────────────────

    /**
     * Fill a single field rule with the given answer.
     * scrollIntoView before every fill to handle virtualised lists.
     */
    async function fillField(rule, answer, { skipFocus = false } = {}) {
        try {
            // Scroll into view — prevents React virtualizer from not rendering the element.
            // 'auto' (instant) not 'smooth': smooth animates the page for ~hundreds of ms
            // per field, which on a long form is most of the visible fill time.
            rule.element.scrollIntoView({ behavior: 'auto', block: 'center' });
            await delay(60);

            switch (rule.type) {
                case 'text':     return await fillText(rule.element, answer);
                case 'date':     return await fillDate(rule.element, answer);
                case 'select':   return await fillSelect(rule, answer);
                case 'radio':    return await fillRadio(rule, answer, { skipFocus });
                case 'checkbox': return await fillCheckbox(rule, answer);
                case 'combobox': return await fillCombobox(rule, answer);
                case 'file':     return await fillFile(rule, answer);
                default:         return false;
            }
        } catch (err) {
            console.warn('[QuickApply FillEngine] fillField error:', rule.label, err);
            return false;
        }
    }

    /**
     * Fill all rules from an answers Map.
     * filledSelectors: Set of already-filled selectors (cross-step guard in submit engine).
     * skipFocus: from filler.getQuirks().skipFocus — true on React 15 platforms (e.g. Workable).
     * tracker: optional ProgressTracker instance.
     */
    async function fillAll(rules, answersMap, { filledSelectors = new Set(), skipFocus = false, tracker = null } = {}) {
        let filled = 0;
        const results = [];
        for (const rule of rules) {
            if (filledSelectors.has(rule.selector)) continue;

            // Rules flagged with a platform-specific fill path (e.g. Workday button-dropdowns,
            // date triplets, Gem dropdown-buttons) are handled by the filler's postFill()
            // instead. Skip here so we don't pollute the field with a failed generic fill.
            if (rule._workdayKind || rule._postFillKind) {
                const _v = answersMap.get(rule.fingerprint);
                if (_v != null) {
                    if (tracker) tracker.markFilled(rule, _v);
                    filled++;
                    if (rule.selector) filledSelectors.add(rule.selector);
                    results.push({ fingerprint: rule.fingerprint, status: 'deferred', value: String(_v) });
                } else {
                    results.push({ fingerprint: rule.fingerprint, status: 'skipped' });
                }
                continue;
            }

            const answer = answersMap.get(rule.fingerprint);
            if (answer === undefined || answer === null || answer === '') {
                if (rule.required && tracker) tracker.markError(rule, 'no_answer_from_resolver');
                results.push({ fingerprint: rule.fingerprint, status: 'skipped' });
                continue;
            }

            const success = await fillField(rule, answer, { skipFocus });
            if (success) {
                filledSelectors.add(rule.selector);
                filled++;
                if (tracker) tracker.markFilled(rule, answer);
                results.push({ fingerprint: rule.fingerprint, status: 'filled', value: String(Array.isArray(answer) ? answer.join(', ') : answer) });
            } else {
                if (rule.required && tracker) tracker.markError(rule, 'fillField_returned_false');
                results.push({ fingerprint: rule.fingerprint, status: 'error', value: String(Array.isArray(answer) ? answer.join(', ') : answer) });
            }
            await delay(40);  // pacing between fields
        }
        return { count: filled, results };
    }

    window.QuickApplyFillEngine = { fillAll, fillField, fillText, fillSelect, fillRadio, fillCheckbox, fillDate, fillCombobox, fillFile };
})();
