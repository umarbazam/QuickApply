/**
 * QuickApply — Ceridian Dayforce filler.
 *
 * Dayforce candidate portal: jobs.dayforcehcm.com/<lang>/<tenant>/CANDIDATEPORTAL/
 *   jobs/<id>/apply/manualApplication. Login required (we never auto-fill login).
 *
 * The application is a multi-step Ant Design (antd) form:
 *   Candidate Info → Questionnaire → Submit.
 * Personal-info fields carry very stable ids: `jobPostingApplication_personalInfo_<field>`.
 * Choice fields (Country, State/Province, Preferred Contact Method, How-did-you-hear,
 * Prefix, Suffix) are antd `ant-select` comboboxes whose options are
 * `div[role="option"].ant-select-item-option` and which COMMIT ON MOUSEDOWN — handled
 * generically by fill-engine.fillCombobox (full mouse sequence on the option).
 *
 * A "Import Resume" parser can overwrite the personal-info fields; postFill re-asserts
 * the profile values afterwards (same hazard/approach as the iCIMS filler).
 */
(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // profileKey → stable Dayforce id suffix. Anchored on the `_personalInfo_<field>`
    // tail so it stays distinct (address1 / address2 / city / county / postalCode must
    // not collapse onto streetAddress the way a bare "address" substring would).
    const REASSERT_PLAN = [
        { profileKey: 'email',         idRx: /personalInfo_email$/i,        labelRx: /^email/i },
        { profileKey: 'email',         idRx: /personalInfo_confirmEmail$/i, labelRx: /confirm.*email/i },
        { profileKey: 'firstName',     idRx: /personalInfo_firstName$/i,    labelRx: /first[\s_-]?name/i },
        { profileKey: 'middleName',    idRx: /personalInfo_middleName$/i,   labelRx: /middle[\s_-]?name/i },
        { profileKey: 'lastName',      idRx: /personalInfo_lastName$/i,     labelRx: /last[\s_-]?name|surname/i },
        { profileKey: 'linkedin',      idRx: /personalInfo_linkedInURL$/i,  labelRx: /linkedin/i },
        { profileKey: 'phone',         idRx: /personalInfo_mobilePhone$/i,  labelRx: /mobile|phone/i },
        { profileKey: 'streetAddress', idRx: /personalInfo_address1$/i,     labelRx: /address(\s*line)?\s*1?$/i },
        { profileKey: 'addressLine2',  idRx: /personalInfo_address2$/i,     labelRx: /address(\s*line)?\s*2$/i },
        { profileKey: 'city',          idRx: /personalInfo_city$/i,         labelRx: /^city$/i },
        { profileKey: 'zipCode',       idRx: /personalInfo_postalCode$/i,   labelRx: /zip|postal/i }
    ];

    function _reassert(input, expected) {
        if (!input || expected == null || expected === '') return true;
        const want = String(expected);
        if (String(input.value ?? '') === want) return true;
        try {
            input.focus();
            const view = input.ownerDocument.defaultView;
            const proto = input.tagName === 'TEXTAREA'
                ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, want);
            input.dispatchEvent(new view.Event('input', { bubbles: true }));
            input.dispatchEvent(new view.Event('change', { bubbles: true }));
            input.dispatchEvent(new view.FocusEvent('blur', { bubbles: true }));
            return String(input.value ?? '') === want;
        } catch (_) { return false; }
    }

    function _findInput(root, idRx, labelRx) {
        const cands = Array.from(root.querySelectorAll('input, textarea')).filter(el =>
            el.offsetParent !== null && !el.disabled && !el.readOnly
            && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && el.type !== 'file');
        for (const el of cands) if (idRx && (idRx.test(el.id || '') || idRx.test(el.name || ''))) return el;
        if (labelRx) for (const el of cands) {
            const lblFor = el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
            const label = (lblFor?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (label && labelRx.test(label)) return el;
        }
        return null;
    }

    // Wait until an input's value has been stable for `quietMs` (the Import-Resume
    // parser overwrites fields asynchronously) before re-asserting over it.
    async function _waitForStable(input, { quietMs = 700, timeoutMs = 8000 } = {}) {
        if (!input) return null;
        let last = input.value, stableSince = Date.now();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await delay(150);
            const cur = input.value;
            if (cur !== last) { last = cur; stableSince = Date.now(); continue; }
            if (Date.now() - stableSince >= quietMs) return cur;
        }
        return last;
    }

    // Select a value in an Ant Design combobox (open → type to filter → mousedown the
    // matching option). Needed for cascading selects like State/Province, whose options
    // only load AFTER Country is chosen — so fillAll's first pass finds the menu empty.
    // Returns true if the option was selected (or already set).
    async function _selectAntd(root, idRx, value) {
        if (value == null || value === '') return true;
        const want = String(value).trim().toLowerCase();
        const input = Array.from(root.querySelectorAll('input[role="combobox"], input[type="search"]'))
            .find(el => el.offsetParent !== null && (idRx.test(el.id || '') || idRx.test(el.name || '')));
        if (!input) return false;
        const shell = input.closest('.ant-select');
        // Already populated? Don't reopen.
        const cur = shell?.querySelector('.ant-select-selection-item')?.textContent?.trim().toLowerCase();
        if (cur && (cur === want || cur.startsWith(want.slice(0, 10)) || want.startsWith(cur.slice(0, 10)))) return true;

        // Snapshot currently-open antd dropdown portals so we can isolate the
        // one we're about to open — avoids picking up options from a still-open
        // prior dropdown when Country and State are filled in quick succession.
        const _preOpen = new Set(
            Array.from(document.querySelectorAll('.ant-select-dropdown'))
                .filter(d => d.getBoundingClientRect().width > 0)
        );
        const opener = shell?.querySelector('.ant-select-selector') || input;
        for (const t of ['mousedown', 'mouseup', 'click']) {
            try { opener.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (_) {}
        }
        try {
            input.focus();
            const proto = input.ownerDocument.defaultView.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(value));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}

        // Poll for options in the newly-opened panel only. Prefer the panel that
        // appeared after our click; fall back to any visible panel if the snapshot
        // missed an already-open one (e.g. first fill, no pre-existing panels).
        let opts = [];
        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
            await delay(80);
            const _newPanel = Array.from(document.querySelectorAll('.ant-select-dropdown'))
                .find(d => !_preOpen.has(d) && d.getBoundingClientRect().width > 0)
                || Array.from(document.querySelectorAll('.ant-select-dropdown'))
                    .filter(d => d.getBoundingClientRect().width > 0).pop();
            opts = _newPanel
                ? Array.from(_newPanel.querySelectorAll('.ant-select-item-option, [role="option"]'))
                    .filter(o => o.getBoundingClientRect().width > 0)
                : [];
            if (opts.length) break;
        }
        if (!opts.length) { try { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (_) {} return false; }

        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        let best = opts.find(o => norm(o.textContent) === want)
            || opts.find(o => norm(o.textContent).startsWith(want.slice(0, 10)) || want.startsWith(norm(o.textContent).slice(0, 10)))
            || (opts.length === 1 ? opts[0] : null);
        if (!best) { try { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (_) {} return false; }
        const target = best.querySelector('.ant-select-item-option-content') || best;
        for (const t of ['mousedown', 'mouseup', 'click']) {
            try { target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (_) {}
        }
        await delay(150);
        const now = shell?.querySelector('.ant-select-selection-item')?.textContent?.trim();
        return !!now;
    }

    async function _reassertProfileFields(root, profile, rules) {
        const failed = new Set();
        for (const { profileKey, idRx, labelRx } of REASSERT_PLAN) {
            const expected = profile[profileKey];
            if (!expected) continue;
            const inp = _findInput(root, idRx, labelRx);
            if (!inp) continue;
            let ok = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                _reassert(inp, expected);
                await delay(200);
                if (String(inp.value ?? '') === String(expected)) { ok = true; break; }
            }
            if (!ok && rules) {
                try {
                    const rule = rules.find(r => r.element === inp || r.labelElement === inp);
                    if (rule?.fingerprint) failed.add(rule.fingerprint);
                } catch (_) {}
            }
        }
        return failed;
    }

    class DayforceFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'dayforce'; }

        // Map Dayforce's stable ids to profile fields so identifyField resolves them
        // deterministically (substring match on lowercased id/name). confirmEmail →
        // email; linkedInURL → linkedin; *Code comboboxes → country/state.
        getFieldAliases() {
            return {
                email:         ['personalinfo_email', 'personalinfo_confirmemail', 'confirmemail'],
                firstName:     ['personalinfo_firstname'],
                middleName:    ['personalinfo_middlename'],
                lastName:      ['personalinfo_lastname'],
                phone:         ['personalinfo_mobilephone'],
                linkedin:      ['personalinfo_linkedinurl', 'linkedinurl'],
                streetAddress: ['personalinfo_address1'],
                addressLine2:  ['personalinfo_address2'],
                city:          ['personalinfo_city'],
                state:         ['personalinfo_statecode', 'statecode'],
                zipCode:       ['personalinfo_postalcode', 'postalcode'],
                country:       ['personalinfo_countrycode', 'countrycode']
            };
        }

        // Wait for the antd application form to render after auth/navigation.
        async preFill() {
            const start = Date.now();
            while (Date.now() - start < 8000) {
                if (document.querySelector('[id^="jobPostingApplication_personalInfo_"], [id*="jobPostingApplication"]')) break;
                await delay(300);
            }
        }

        // Re-assert personal-info text fields AFTER the Import-Resume parser (if used)
        // has settled, so the parser's CV-derived values don't shadow the profile.
        async postFill() {
            const profile = this._lastProfile;
            if (!profile) return;
            const emailInput = _findInput(document, /personalInfo_email$/i, /^email/i);
            if (emailInput) await _waitForStable(emailInput, { quietMs: 700, timeoutMs: 8000 });
            else await delay(400);
            this._postFillFailedFingerprints =
                await _reassertProfileFields(document, profile, this._lastRules || []);

            // Cascading antd selects: Country must be committed before State/Province
            // options load, so the engine's first pass leaves State empty. Re-commit
            // Country, then fill State, here — after the country selection has settled.
            try {
                if (profile.country) await _selectAntd(document, /personalInfo_countryCode$/i, profile.country);
                const stateVal = profile.state || profile.province || profile.stateProvince;
                if (stateVal) { await delay(300); await _selectAntd(document, /personalInfo_stateCode$/i, stateVal); }
            } catch (_) {}
        }

        getNextSelectors() {
            return 'button[type="submit"], input[type="submit"], button[class*="next" i], button[class*="continue" i], button[class*="submit" i]';
        }
    }

    window.QuickApplyFillerFactory.register('dayforce', DayforceFiller);
    window.QuickApplyDayforceFiller = DayforceFiller;
})();
