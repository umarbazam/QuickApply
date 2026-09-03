/**
 * QuickApply — Gem.com application form filler.
 *
 * Gem applications live at jobs.gem.com/<company>/<jobId>. The form is React +
 * CSS-in-JS (vanilla-extract style): class names are stable PREFIXES with a
 * numeric build suffix (`input-88`, `textField-81`, `radioInput-124`). Never
 * key on the numeric tail — always use `[class^="prefix-"]` patterns.
 *
 * Quirks the base discoverer cannot handle on its own:
 *
 *   1. Core text inputs (First name, Last name, Email, LinkedIn URL, Phone
 *      number, Location) and the free-text essay textareas have NO
 *      id/name/aria-label/placeholder/<label for>. Their visible label is a
 *      sibling DIV/SPAN one ancestor up from the `.textField-*` /
 *      `.textareaField-*` wrapper. We attach the label as `aria-label` on the
 *      input so the shared field-discoverer's aria-label strategy picks it up.
 *
 *   2. Radio screening questions are rendered with each option as a separate
 *      <input type="radio"> carrying a UNIQUE opaque id and NO name attribute.
 *      The shared discoverer's groupRadios keys by `name || id`, so every
 *      Gem radio collapses into a singleton group with its OPTION text as the
 *      "label" — the actual question is lost. We post-process the rule set
 *      and merge singletons by walking up to the shared question ancestor.
 *
 *   3. Resume upload is a HIDDEN <input type="file"> whose visible trigger is
 *      a "Click to upload or drag and drop here" div. The discoverer drops it
 *      via the visibility guard, so the standard fillFile path never fires.
 *      We populate the file in postFill via DataTransfer (mirrors the legacy
 *      _qaFillFileLegacy logic).
 */
(function () {
    'use strict';

    function _isInputish(el) {
        if (!el) return false;
        if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) return true;
        return !!el.querySelector?.('input, textarea, select');
    }

    function _cleanLabelText(raw) {
        return String(raw || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*\*\s*$/, '')
            .replace(/\(optional\)/i, '')
            .replace(/\(required\)/i, '')
            .trim();
    }

    // ── Gem button-dropdown helpers ──────────────────────────────────────
    // Gender / Race / Veteran status etc. render as a <button> whose only
    // visible content is "Please select" + a chevron <i><svg>. On click a
    // sibling <menu class="menu-XX"> appears with <li role="menuitem">s.
    function _isGemDropdownButton(el) {
        if (!el || el.tagName !== 'BUTTON') return false;
        if (el.type === 'submit') return false;
        // The dropdown content lives in a `buttonContentContainer-XX` child.
        // Submit / "Apply" buttons don't have that container.
        if (!el.querySelector('[class^="buttonContentContainer-"]')) return false;
        // Skip Expand/Collapse / text-style buttons used for descriptions.
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/\btext-\d+\b/.test(cls)) return false;
        return true;
    }
    function _gemDropdownLabel(button) {
        // The label is rendered as a sibling DIV one ancestor up, class
        // `bodyImportant-XX` or similar. Walk up to .input-XX and read its
        // first text-bearing child that isn't the button.
        let cur = button.parentElement;
        for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
            const cls = typeof cur.className === 'string' ? cur.className : '';
            if (/(^|\s)input-\d+/.test(cls) || /(^|\s)field-\d+/.test(cls)) {
                for (const child of cur.children) {
                    if (child === button || child.contains(button)) continue;
                    const t = (child.textContent || '').trim();
                    if (t && t.length > 0 && t.length < 80 && !child.querySelector('button, input, select, textarea')) {
                        return t.replace(/\s*\*\s*$/, '').trim();
                    }
                }
            }
            cur = cur.parentElement;
        }
        // Fallback: nearest preceding text node
        let sib = button.previousElementSibling || button.parentElement?.previousElementSibling;
        let hops = 0;
        while (sib && hops < 4) {
            const t = (sib.textContent || '').trim();
            if (t && t.length < 80) return t.replace(/\s*\*\s*$/, '').trim();
            sib = sib.previousElementSibling;
            hops++;
        }
        return '';
    }
    function _gemDropdownCurrentValue(button) {
        // Empty state shows "Please select"; otherwise the option text.
        const container = button.querySelector('[class^="buttonContentContainer-"]');
        const txt = (container?.firstChild?.textContent || container?.textContent || '').trim();
        if (!txt || /^Please\s+select$/i.test(txt)) return '';
        return txt;
    }
    async function _fillGemDropdown(button, answer) {
        if (!button || answer == null || String(answer).trim() === '') return false;
        // If already filled with the same value, no-op.
        const cur = _gemDropdownCurrentValue(button);
        const normAns = String(answer).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        if (cur && cur.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() === normAns) return true;

        button.scrollIntoView({ behavior: 'instant', block: 'center' });
        button.click();
        // Wait for the menu to render (Gem is React, ~150ms typical).
        await new Promise(r => setTimeout(r, 250));
        let menu = [...document.querySelectorAll('menu, [class^="menu-"]')]
            .filter(m => m.offsetParent !== null)
            .pop();
        if (!menu) {
            // Retry once with longer wait — slow networks / cold React paths
            await new Promise(r => setTimeout(r, 350));
            menu = [...document.querySelectorAll('menu, [class^="menu-"]')]
                .filter(m => m.offsetParent !== null)
                .pop();
        }
        if (!menu) return false;

        const items = [...menu.querySelectorAll('li[role="menuitem"], [class^="dropdownItem-"], [role="option"]')]
            .filter(i => i.offsetParent !== null);
        if (!items.length) return false;

        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const want = norm(answer);
        // Pass 1: exact normalized match
        let match = items.find(i => norm(i.textContent) === want);
        // Pass 2: item text contains answer
        if (!match) match = items.find(i => norm(i.textContent).includes(want));
        // Pass 3: answer contains item text (e.g. AI returns "I am not a protected veteran" vs item "Not a veteran")
        if (!match) match = items.find(i => want.includes(norm(i.textContent)));
        // Pass 4: token overlap — ≥ 50% of item's tokens appear in answer
        if (!match) {
            const wantTokens = new Set(want.split(' '));
            match = items.find(i => {
                const itTokens = norm(i.textContent).split(' ').filter(Boolean);
                if (!itTokens.length) return false;
                const overlap = itTokens.filter(t => wantTokens.has(t)).length;
                return overlap / itTokens.length >= 0.5;
            });
        }
        if (!match) {
            // Close the menu and give up — clicking outside dismisses Gem's menu.
            document.body.click();
            return false;
        }
        match.click();
        await new Promise(r => setTimeout(r, 150));
        // Verify the button text actually flipped (React onClick committed)
        const after = _gemDropdownCurrentValue(button);
        return !!after && after !== 'Please select';
    }

    function _looksLikeQuestion(text) {
        if (!text) return false;
        const t = String(text).trim();
        if (t.length < 8 || t.length > 220) return false;
        if (/\n/.test(t)) return false;
        // Gem marks required questions with a trailing "*", and many also end
        // with "?". Either is a strong question signal.
        return /[*?]\s*$/.test(t);
    }

    // ── Pass 1 (text inputs): walk to the .textField-* wrapper, label = its
    // previousElementSibling.
    function _findGemLabel(el) {
        let cur = el;
        for (let depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
            const cls = typeof cur.className === 'string' ? cur.className : '';
            if (/(^|\s)(textField-|textareaField-|textArea-|inputWrapper-|field-|formField-|select-)/.test(cls)) {
                const sib = cur.previousElementSibling;
                if (sib && !_isInputish(sib)) {
                    const t = _cleanLabelText(sib.textContent);
                    if (t && t.length <= 120) return t;
                }
            }
            cur = cur.parentElement;
        }
        // Generic fallback: walk parents and take the first prev-sibling whose
        // text is label-shaped (short, alphanumeric-leading, no inputs).
        cur = el.parentElement;
        for (let depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
            const sib = cur.previousElementSibling;
            if (sib && !_isInputish(sib)) {
                const t = _cleanLabelText(sib.textContent);
                if (t && /^[A-Za-z]/.test(t) && t.length >= 2 && t.length <= 120 && !/\n/.test(t)) {
                    return t;
                }
            }
            cur = cur.parentElement;
        }
        return '';
    }

    function _hasNoLabelHint(el) {
        if (el.getAttribute('aria-label')) return false;
        if (el.getAttribute('aria-labelledby')) return false;
        if (el.placeholder) return false;
        if (el.name) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        if (el.closest('label')) return false;
        return true;
    }

    // ── Pass 2 (radios): for a given radio, find the question text by walking
    // up until we hit a container whose previousElementSibling text is
    // question-shaped (ends with "*" or "?"). All radios that resolve to the
    // SAME question div are one group.
    function _findRadioQuestion(radio) {
        let cur = radio.parentElement;
        for (let depth = 0; depth < 8 && cur && cur !== document.body; depth++) {
            const sib = cur.previousElementSibling;
            if (sib && !_isInputish(sib)) {
                const raw = sib.textContent || '';
                if (_looksLikeQuestion(raw)) {
                    return { questionEl: sib, text: _cleanLabelText(raw) };
                }
            }
            cur = cur.parentElement;
        }
        return null;
    }

    class GemFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'gem'; }

        getFieldAliases() {
            return {
                firstName: ['first name'],
                lastName: ['last name'],
                email: ['email'],
                phone: ['phone number', 'phone'],
                linkedIn: ['linkedin url', 'linkedin profile', 'linkedin'],
                city: ['location', 'where are you located', 'current location'],
            };
        }

        async preFill() {
            // Wait for the form to mount (Gem is a client-rendered SPA).
            const start = Date.now();
            while (Date.now() - start < 4000) {
                if (document.querySelector('input[type="text"], textarea')) break;
                await new Promise(r => setTimeout(r, 200));
            }
            // Give Gem an extra beat to run its server-driven "Save your info
            // to apply to other roles faster" auto-fill so we clear AFTER it
            // populates, not before.
            await new Promise(r => setTimeout(r, 300));

            // ── Clear any pre-filled values from Gem's saved-candidate cache ──
            // Gem stores the prior candidate server-side keyed by session
            // cookies (`cssessionkey`) and re-populates the form on every new
            // Gem job. Without this clear, the first/last/email/phone persist
            // as the previous QuickApply client and only the radios/essays get
            // overwritten — a mid-merge that confuses users.
            function clearTextLike(el) {
                if (!el.value && (el.tagName !== 'TEXTAREA' || !el.textContent)) return;
                const proto = el.tagName === 'TEXTAREA'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                try { setter ? setter.call(el, '') : (el.value = ''); } catch (_) { el.value = ''; }
                // Reset React's value tracker so the next .value assignment
                // fires React's synthetic onChange (otherwise the tracker
                // thinks the value is still '' and skips the listener).
                try { if (el._valueTracker?.setValue) el._valueTracker.setValue('x'); } catch (_) {}
                try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); } catch (_) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // Scope the clear to the application form container — avoid clobbering
            // CSRF/state inputs or fields injected by other extensions outside the form.
            const _clearRoot = document.querySelector('form') || document.querySelector('main') || document.body;
            for (const el of _clearRoot.querySelectorAll(
                'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], textarea'
            )) {
                clearTextLike(el);
            }
            // Uncheck pre-selected radios / checkboxes — Gem's saved profile
            // re-applies the prior screening-question answers, which are
            // almost always wrong for the new client / new role.
            for (const el of document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')) {
                el.checked = false;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // Wipe any pre-attached file. Gem typically can't re-attach the
            // previous File (browsers don't expose stored file content), but
            // some forms surface a "Click to replace" state from the prior
            // upload that postFill would otherwise skip via its idempotency
            // guard. Clear so postFill's DataTransfer always lands.
            for (const fi of document.querySelectorAll('input[type="file"]')) {
                try {
                    if (fi.files && fi.files.length) {
                        const dt = new DataTransfer();
                        fi.files = dt.files;
                        fi.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } catch (_) {}
            }
        }

        async discoverFields() {
            // ── PASS 1: aria-label attach for unlabelled text/textarea ──
            const textCandidates = document.querySelectorAll(
                'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], textarea'
            );
            for (const el of textCandidates) {
                if (!_hasNoLabelHint(el)) continue;
                const label = _findGemLabel(el);
                if (label) {
                    try { el.setAttribute('aria-label', label); } catch (_) {}
                }
            }

            // ── PASS 2: synthetic `name` for radio groups, keyed by question ──
            // Walk every radio that lacks a name. Group those that resolve to
            // the same question element (identity comparison on the DOM node,
            // not text — two questions with identical text would still group
            // distinctly because their DOM nodes differ).
            const questionToName = new Map();
            let radioGroupSeq = 0;
            for (const radio of document.querySelectorAll('input[type="radio"]')) {
                if (radio.name) continue;
                const found = _findRadioQuestion(radio);
                if (!found) continue;
                let synth = questionToName.get(found.questionEl);
                if (!synth) {
                    synth = `gem_radio_${++radioGroupSeq}`;
                    questionToName.set(found.questionEl, synth);
                }
                try { radio.setAttribute('name', synth); } catch (_) {}
                // The discoverer's getRadioGroupLabel does a `closest('fieldset,[role="group"]')`
                // check first. Tag the question element's parent as a group and
                // give it an aria-label so the discoverer picks up the question.
                // Idempotent — only set if not already tagged.
                const groupHost = found.questionEl.parentElement;
                if (groupHost && groupHost.getAttribute('role') !== 'group') {
                    try {
                        groupHost.setAttribute('role', 'group');
                        groupHost.setAttribute('aria-label', found.text);
                    } catch (_) {}
                }
            }

            // ── PASS 2b: checkbox question context ──
            // Gem multi-select questions ("Which technologies do you know? [x]
            // React [x] Vue") render each option as a separate <input
            // type="checkbox"> with its own labelled-for-id. The base
            // discoverer creates one per-option boolean rule with the OPTION
            // text as the label — losing the parent question. Without that
            // context the AI resolver can't decide whether a given option
            // belongs in the answer set. Re-label each unlabelled checkbox's
            // aria-label to "Question — Option" so the AI sees both. Single
            // standalone checkboxes (agree-to-terms etc.) are NOT touched —
            // they have their own self-explanatory labels.
            const checkboxQuestionGroups = new Map(); // question DOM node → [checkbox elements]
            for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                if (cb.getAttribute('aria-label')) continue;
                const found = _findRadioQuestion(cb); // same walk-up; question-shape regex catches both
                if (!found) continue;
                if (!checkboxQuestionGroups.has(found.questionEl)) {
                    checkboxQuestionGroups.set(found.questionEl, { text: found.text, members: [] });
                }
                checkboxQuestionGroups.get(found.questionEl).members.push(cb);
            }
            // Only rewrite labels for question groups that have 2+ checkboxes
            // (real multi-select). Singletons are standalone — leave alone.
            for (const { text, members } of checkboxQuestionGroups.values()) {
                if (members.length < 2) continue;
                for (const cb of members) {
                    const optionLabel = cb.id
                        ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`)?.textContent?.trim()
                        : '';
                    const composite = optionLabel ? `${text} — ${optionLabel}` : text;
                    try { cb.setAttribute('aria-label', composite); } catch (_) {}
                }
            }

            const rules = await super.discoverFields();

            // ── PASS 3b: Gem button-dropdowns (Gender / Race / Veteran status) ──
            // These render as <button> with "Please select" + chevron icon; the
            // base field-discoverer doesn't pick them up (no input/select/role).
            // Add them as combobox rules with _postFillKind so fill-engine
            // routes them through postFill instead of the generic combobox path.
            for (const btn of document.querySelectorAll('button')) {
                if (!_isGemDropdownButton(btn)) continue;
                const label = _gemDropdownLabel(btn);
                if (!label) continue;
                // De-dupe — if some earlier pass already added this button, skip.
                if (rules.some(r => r.element === btn)) continue;
                rules.push({
                    label,
                    type: 'combobox',
                    required: /\*\s*$/.test(btn.parentElement?.querySelector('[class^="bodyImportant-"]')?.textContent || ''),
                    options: [], // populated lazily on click by _fillGemDropdown
                    element: btn,
                    labelElement: null,
                    selector: '',
                    fingerprint: window.QuickApplyCache?.makeFingerprint?.(label, 'combobox', []) ?? '',
                    platform: 'gem',
                    multiline: false,
                    _postFillKind: 'gemDropdown'
                });
            }

            // ── PASS 3: rewrite radio-group rule labels to the real question ──
            // Even though we set `role=group` + `aria-label`, the discoverer's
            // `getRadioGroupLabel` falls through to `getLabel(first, doc)` for
            // groups that don't yield a legend / first-non-radio-child — and
            // `getLabel` on a radio prefers label-for-id (= the option text).
            // Re-derive the question from the radio's DOM and overwrite.
            for (const rule of rules) {
                if (rule.type !== 'radio') continue;
                const first = rule.element;
                if (!first) continue;
                const found = _findRadioQuestion(first);
                if (found && found.text) {
                    rule.label = found.text;
                    rule.fingerprint = window.QuickApplyCache?.makeFingerprint(
                        found.text, rule.type, rule.options
                    ) ?? rule.fingerprint;
                }
            }

            return rules;
        }

        async postFill() {
            await super.postFill?.();

            // ── Re-assert profile-driven fields after Gem's late auto-fill ──
            // Gem fetches the candidate's saved profile from its server (keyed
            // by `cssessionkey` cookie) and re-populates the form via a React
            // useEffect that can fire AFTER our preFill clear has already run.
            // The fillAll pass writes the new client's values, but if Gem's
            // profile fetch resolves between our fill and the user's first
            // interaction, the prior candidate's name/email leak back in.
            //
            // Iterate every text/textarea rule from the last fill — for each
            // one with a resolved answer, verify the element's current value
            // still matches; if not, force-set via native setter + tracker
            // reset. Do two passes 600ms apart so we catch repopulations that
            // fire after the first re-assert. Cheap (10 fields × 2 passes).
            const answers = this._lastAnswers;
            const lastRules = this._lastRules || [];
            const getAnswer = (rule) => {
                if (!answers) return null;
                if (typeof answers.get === 'function') return answers.get(rule.fingerprint);
                return answers[rule.fingerprint];
            };
            function setNative(el, v) {
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                try { setter ? setter.call(el, v) : (el.value = v); } catch (_) { el.value = v; }
                try { if (el._valueTracker?.setValue) el._valueTracker.setValue(''); } catch (_) {}
                try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' })); } catch (_) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            async function reassertOnce() {
                let changed = 0;
                for (const rule of lastRules) {
                    if (rule.type !== 'text' && rule.type !== 'textarea') continue;
                    const expected = getAnswer(rule);
                    if (expected == null || expected === '') continue;
                    const el = rule.element;
                    if (!el || !el.isConnected) continue;
                    if (String(el.value ?? '') === String(expected)) continue;
                    setNative(el, String(expected));
                    changed++;
                }
                // Radio re-assert: if AI picked an option, ensure the selected
                // option still matches. Gem's saved profile sometimes
                // re-checks the prior candidate's answer mid-fill.
                for (const rule of lastRules) {
                    if (rule.type !== 'radio' || !rule.elements?.length) continue;
                    const expected = getAnswer(rule);
                    if (expected == null || expected === '') continue;
                    const want = String(expected).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g,' ').trim();
                    let target = null;
                    for (const radio of rule.elements) {
                        const lbl = (document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g,' ').trim();
                        if (lbl === want || lbl.includes(want) || want.includes(lbl)) { target = radio; break; }
                    }
                    if (!target || target.checked) continue;
                    target.click();
                    changed++;
                }
                return changed;
            }
            // Pass 1 — immediate
            const p1 = await reassertOnce();
            if (p1) console.log(`[QuickApply Gem] re-asserted ${p1} field(s) (pass 1)`);
            // Pass 2 — after Gem's React has had time to apply its delayed
            // server-side profile fetch.
            await new Promise(r => setTimeout(r, 600));
            const p2 = await reassertOnce();
            if (p2) console.log(`[QuickApply Gem] re-asserted ${p2} field(s) (pass 2)`);

            // ── Gem button-dropdowns (Gender / Race / Veteran status) ──
            // content.js stashes the AI-resolved answers + rules on the filler
            // before calling postFill in the batch path. Iterate rules tagged
            // with _postFillKind === 'gemDropdown' and click through the
            // button → menu → item flow for each. Reuses `answers`/`lastRules`/
            // `getAnswer` declared above for the re-assert block.
            for (const rule of lastRules) {
                if (rule._postFillKind !== 'gemDropdown') continue;
                const answer = getAnswer(rule);
                if (answer == null || answer === '') continue;
                try {
                    const ok = await _fillGemDropdown(rule.element, answer);
                    console.log('[QuickApply Gem] dropdown', ok ? '✓' : '✗', rule.label, '→', answer);
                } catch (e) {
                    console.warn('[QuickApply Gem] dropdown threw:', rule.label, e);
                }
            }

            // ── Resume upload via direct DataTransfer ──
            // The visible upload region is a "Click to upload or drag and drop
            // here" div; the actual <input type="file"> is hidden so the field
            // discoverer drops it and the standard fillFile path never fires.
            // Populate the file input directly via DataTransfer (verified live:
            // dispatching `change` on the hidden input flips Gem's UI to show
            // the uploaded file). Idempotent across re-runs.
            const fileInputs = [...document.querySelectorAll('input[type="file"]')];
            if (!fileInputs.length) {
                console.warn('[QuickApply Gem] CV upload skipped: no file input on page');
                return;
            }
            if (fileInputs.some(i => i.files && i.files.length > 0)) {
                console.log('[QuickApply Gem] CV upload skipped: file already present');
                return;
            }

            const profile = this.profile || {};
            if (!profile.cvData || !profile.cvFileName) {
                console.warn('[QuickApply Gem] CV upload skipped: profile has no cvData/cvFileName — upload a CV in the QuickApply dashboard for this client');
                return;
            }

            let file;
            try {
                const bin = atob(profile.cvData);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                file = new File([bytes], profile.cvFileName, {
                    type: profile.cvMimeType || 'application/pdf'
                });
            } catch (e) {
                console.warn('[QuickApply Gem] CV upload failed: could not reconstruct File from cvData', e);
                return;
            }

            // Gem accepts the FIRST file input as the resume. Don't blanket-fill
            // every file input on the page — there can be cover-letter file
            // inputs that the user may want to leave blank or fill separately.
            // We pick the input whose enclosing block's label text mentions
            // "resume" or "cv"; fall back to the first input.
            function blockLabel(fi) {
                let cur = fi.parentElement;
                for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
                    const sib = cur.previousElementSibling;
                    if (sib) {
                        const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
                        if (t && t.length < 60) return t;
                    }
                    cur = cur.parentElement;
                }
                return '';
            }
            const labelled = fileInputs.map(fi => ({ fi, label: blockLabel(fi) }));
            const resumeMatch = labelled.find(x => /\b(resume|cv|curriculum)\b/i.test(x.label));
            const targetInput = (resumeMatch ? resumeMatch.fi : labelled[0].fi);

            try {
                const dt = new DataTransfer();
                dt.items.add(file);
                targetInput.files = dt.files;
                // Comprehensive event sequence — React file dropzones can
                // listen to any combination of change/input/drop. The bubbling
                // change event was sufficient in live testing, but include
                // input + a deferred re-dispatch in case Gem's React handler
                // mounts after the first render pass.
                targetInput.dispatchEvent(new Event('change', { bubbles: true }));
                targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                console.log('[QuickApply Gem] CV uploaded:', profile.cvFileName, '→', blockLabel(targetInput) || '(first file input)');

                // Some React apps re-render the input on initial change and
                // wipe `.files` mid-cycle. Wait a beat and re-assert if the
                // file got cleared.
                await new Promise(r => setTimeout(r, 400));
                const stillThere = [...document.querySelectorAll('input[type="file"]')]
                    .some(i => i.files && i.files.length > 0);
                if (!stillThere) {
                    const reTarget = document.querySelector('input[type="file"]');
                    if (reTarget) {
                        const dt2 = new DataTransfer();
                        dt2.items.add(file);
                        reTarget.files = dt2.files;
                        reTarget.dispatchEvent(new Event('change', { bubbles: true }));
                        console.log('[QuickApply Gem] CV re-asserted after React re-render');
                    }
                }
            } catch (e) {
                console.warn('[QuickApply Gem] CV upload failed during DataTransfer:', e);
            }
        }
    }

    window.QuickApplyFillerFactory.register('gem', GemFiller);
})();
