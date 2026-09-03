(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // iCIMS embeds the application form inside an iframe on a same-origin
    // wrapper page. Content scripts run in every frame (manifest sets
    // `all_frames: true`), so the form-iframe gets its own iCIMSFiller. The
    // wrapper frame has no form fields and the base discoverer returns
    // nothing — harmless no-op.

    // iCIMS uses highly stable field ids on its profile forms:
    //   PersonProfileFields.FirstName / .MiddleName / .LastName / .Email / .Login
    //   -1_PersonProfileFields.PhoneNumber / .PhoneType
    //   -1_PersonProfileFields.AddressStreet1 / .AddressStreet2 / .AddressCity
    //                          / .AddressZip / .AddressType
    // The `-1_` prefix is an iCIMS row-index; the suffix after the dot is
    // stable across tenants. Matching on the dotted suffix (anchored with $)
    // is far more reliable than fuzzy label matching — and critically it keeps
    // AddressStreet1 / AddressStreet2 / AddressCity / AddressZip DISTINCT.
    // A plain "address" substring match collapses all four onto streetAddress.
    const REASSERT_PLAN = [
        { profileKey: 'email',         idRx: /PersonProfileFields\.Email$/i,         labelRx: /e[\s_-]?mail/i },
        { profileKey: 'email',         idRx: /PersonProfileFields\.Login$/i,         labelRx: /^login$/i },
        { profileKey: 'firstName',     idRx: /PersonProfileFields\.FirstName$/i,     labelRx: /first[\s_-]?name/i },
        { profileKey: 'middleName',    idRx: /PersonProfileFields\.MiddleName$/i,    labelRx: /middle[\s_-]?name/i },
        { profileKey: 'lastName',      idRx: /PersonProfileFields\.LastName$/i,      labelRx: /last[\s_-]?name|surname/i },
        { profileKey: 'phone',         idRx: /PersonProfileFields\.PhoneNumber$/i,   labelRx: /phone|mobile|telephone/i },
        { profileKey: 'streetAddress', idRx: /PersonProfileFields\.AddressStreet1$/i, labelRx: /^address(\s*line)?\s*1?$/i },
        { profileKey: 'city',          idRx: /PersonProfileFields\.AddressCity$/i,   labelRx: /^city$/i },
        { profileKey: 'zipCode',       idRx: /PersonProfileFields\.AddressZip$/i,    labelRx: /zip|postal/i }
    ];

    // Re-fill any input whose current value differs from `expected`. Uses the
    // native HTMLInputElement / HTMLTextAreaElement value setter so React /
    // Polymer / iCIMS's own JS sees the update, then dispatches input + change
    // + blur so any onChange/onBlur listeners re-validate. Returns true if the
    // field ends up holding `expected`.
    function _reassert(input, expected) {
        if (!input || expected == null || expected === '') return true;
        const want = String(expected);
        if (String(input.value ?? '') === want) return true;
        try {
            input.focus();
            const view = input.ownerDocument.defaultView;
            const proto = input.tagName === 'TEXTAREA'
                ? view.HTMLTextAreaElement.prototype
                : view.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, want);
            input.dispatchEvent(new view.Event('input', { bubbles: true }));
            input.dispatchEvent(new view.Event('change', { bubbles: true }));
            input.dispatchEvent(new view.FocusEvent('blur', { bubbles: true }));
            return String(input.value ?? '') === want;
        } catch (_) {
            return false;
        }
    }

    // Find a visible, editable input by an id regex (preferred — iCIMS ids are
    // stable) with a label-regex fallback for non-standard tenants.
    function _findInput(root, idRx, labelRx) {
        const candidates = Array.from(root.querySelectorAll('input, textarea')).filter(el =>
            el.offsetParent !== null && !el.disabled && !el.readOnly
            && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && el.type !== 'file'
        );
        for (const el of candidates) {
            if (idRx && (idRx.test(el.id || '') || idRx.test(el.name || ''))) return el;
        }
        if (labelRx) {
            for (const el of candidates) {
                const labelByFor = el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
                const label = (labelByFor?.textContent || el.closest('label')?.textContent
                    || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                if (label && labelRx.test(label)) return el;
            }
        }
        return null;
    }

    // Poll an input's value until it has been stable for `quietMs`, OR
    // `timeoutMs` elapses. Used to wait for iCIMS's CV parser to finish
    // overwriting the email/name/phone fields before we re-assert.
    async function _waitForStable(input, { quietMs = 800, timeoutMs = 10000 } = {}) {
        if (!input) return null;
        let last = input.value;
        let stableSince = Date.now();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await delay(150);
            const cur = input.value;
            if (cur !== last) { last = cur; stableSince = Date.now(); continue; }
            if (Date.now() - stableSince >= quietMs) return cur;
        }
        return last;
    }

    // Re-assert every personal-info field in REASSERT_PLAN from `profile`,
    // then clear AddressStreet2 if the (greedy) generic engine duplicated the
    // street into it and the profile carries no real second address line.
    // Returns a Set of fingerprints (when `rules` is supplied) for fields that
    // would not hold the profile value — so content.js can demote them.
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
                await delay(250);
                if (String(inp.value ?? '') === String(expected)) { ok = true; break; }
            }
            if (!ok && rules) {
                try {
                    const rule = rules.find(r => r.element === inp || r.labelElement === inp);
                    if (rule?.fingerprint) failed.add(rule.fingerprint);
                } catch (_) {}
            }
        }
        // AddressStreet2 dedup: the generic engine matches the "Address"
        // substring on AddressStreet2's id/label and writes the street value
        // into it. If the profile has no genuine second address line and
        // Street2 just mirrors Street1, blank it.
        try {
            const street1 = _findInput(root, /PersonProfileFields\.AddressStreet1$/i, null);
            const street2 = _findInput(root, /PersonProfileFields\.AddressStreet2$/i, null);
            const realLine2 = profile.addressLine2 || profile.streetAddress2 || profile.apartment;
            if (street2 && street1 && !realLine2 && street2.value && street2.value === street1.value) {
                _reassert(street2, '');
            } else if (street2 && realLine2) {
                _reassert(street2, realLine2);
            }
        } catch (_) {}
        return failed;
    }

    class iCIMSFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'icims'; }

        // Precise iCIMS field aliases. iCIMS ids carry the meaning in the
        // dotted suffix; without these the generic mapper collapses every
        // `*.Address*` field onto streetAddress (AddressCity / AddressZip /
        // AddressStreet2 all wrongly receive the street). Substrings match the
        // lowercased id/name.
        getFieldAliases() {
            return {
                firstName: ['personprofilefields.firstname'],
                middleName: ['personprofilefields.middlename'],
                lastName: ['personprofilefields.lastname'],
                email: ['personprofilefields.email'],
                phone: ['personprofilefields.phonenumber'],
                streetAddress: ['personprofilefields.addressstreet1'],
                addressLine2: ['personprofilefields.addressstreet2'],
                city: ['personprofilefields.addresscity'],
                state: ['personprofilefields.addressregion', 'personprofilefields.addressstate'],
                zipCode: ['personprofilefields.addresszip'],
                country: ['personprofilefields.addresscountry']
            };
        }

        async preFill() {
            // Wait for iCIMS's async form render — many tenants stream the
            // question DOM in after the initial document settles.
            const start = Date.now();
            while (Date.now() - start < 6000) {
                const fields = document.querySelectorAll(
                    'input[id^="Question_"], input[id^="rcf"], input[type="email"], [id*="PersonProfileFields"]'
                );
                if (fields.length > 0) break;
                await delay(300);
            }
        }

        async discoverFields() {
            const rules = await super.discoverFields();
            // For opaque Question_XXXXX field names, set fingerprint using contextLabel
            for (const rule of rules) {
                const name = rule.element?.name || rule.element?.id || '';
                if (/^question_\d|rcf\d|input_\d/i.test(name) && rule.label) {
                    rule.fingerprint = window.QuickApplyCache.makeFingerprint(
                        rule.label, rule.type, rule.options
                    );
                }
            }
            return rules;
        }

        // Re-assert personal-info fields AFTER the iCIMS CV parser has had a
        // chance to overwrite them. Covers the in-place-parse case (parser
        // mutates fields without a navigation). The cross-navigation case —
        // where the resume upload reloads the page — is handled separately by
        // the _icimsPostResumeBootstrap below, which fires on the fresh page.
        async postFill() {
            const profile = this._lastProfile;
            if (!profile) return;
            // Canary-wait: let the parser settle on the email field first.
            const emailInput = _findInput(document, /PersonProfileFields\.Email$/i, /e[\s_-]?mail/i);
            if (emailInput) {
                await _waitForStable(emailInput, { quietMs: 800, timeoutMs: 10000 });
            } else {
                await delay(500);
            }
            this._postFillFailedFingerprints =
                await _reassertProfileFields(document, profile, this._lastRules || []);
        }

        getNextSelectors() {
            return 'button[title*="Next" i], button[title*="Continue" i], button[title*="Submit" i], button[type="submit"], input[type="submit"]';
        }
    }

    window.QuickApplyFillerFactory.register('icims', iCIMSFiller);
    window.QuickApplyiCIMSFiller = iCIMSFiller;

    // ── Post-CV-parse re-assertion bootstrap ──────────────────────────────
    // iCIMS's resume upload SUBMITS a form that NAVIGATES the page — the new
    // URL carries `resumeSubmitted=1`. The CV parser's extracted values
    // (notably an email lifted from the CV's contact block) populate the
    // freshly-loaded form, overwriting whatever the extension filled. Because
    // that's a full navigation, iCIMSFiller.postFill() from the original fill
    // cycle ran on the now-destroyed page and its re-assertion was lost.
    //
    // This bootstrap runs on EVERY iCIMS page load (content scripts re-inject
    // per navigation). When the URL shows we just came back from a resume
    // submit, it reads the active client profile straight from chrome.storage
    // and re-asserts the personal-info fields over the parser's values.
    (async function _icimsPostResumeBootstrap() {
        try {
            if (!/(^|\.)icims\.com$/i.test(location.hostname)) return;
            // The post-upload navigation carries resumeSubmitted=1. Some
            // tenants also land on `from=profilebuilder` — accept either.
            const justParsed = /[?&]resumeSubmitted=1\b/i.test(location.search)
                || /[?&]from=profilebuilder\b/i.test(location.search);
            if (!justParsed) return;
            if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

            const data = await new Promise(res =>
                chrome.storage.local.get(['activeClientId', 'quickapply_clients'], res));
            const profile = (data.quickapply_clients || []).find(c => c.id === data.activeClientId);
            if (!profile) return;

            // Wait for the iCIMS profile form to render in this frame.
            const start = Date.now();
            let emailEl = null;
            while (Date.now() - start < 8000) {
                emailEl = _findInput(document, /PersonProfileFields\.Email$/i, /e[\s_-]?mail/i);
                if (emailEl) break;
                await delay(300);
            }
            if (!emailEl) return;
            // Give the CV parser time to finish writing into the fresh page.
            await _waitForStable(emailEl, { quietMs: 800, timeoutMs: 10000 });
            await _reassertProfileFields(document, profile, null);
        } catch (_) {}
    })();
})();
