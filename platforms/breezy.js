(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Text that looks like a radio option value rather than a question heading.
    // Breezy's Angular rendering sometimes exposes the first option's label text
    // as the radio group label instead of the actual question text.
    const OPTION_LIKE_RX = /^(yes|no|male|female|other|prefer not|decline|i am|i have|i do not|white|black|hispanic|asian|two or more|native|i identify|none of the above|indeed|university|employee referral|linkedin)/i;

    // Breezy custom employer question name pattern
    const CUSTOM_Q_RX = /^section_\d+_question_\d+$/;

    // Breezy honeypot fields: name starts with "hp_", autocomplete starts with "hp-".
    // Filling these flags the submission as a bot — always skip them.
    const HONEYPOT_NAME_RX = /^hp_/i;
    const HONEYPOT_AC_RX   = /^hp-/i;

    class BreezyFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'breezy'; }

        getFieldAliases() {
            return {
                // c-prefix standard field names (Breezy Angular ATS convention)
                fullName:         ['cname'],
                email:            ['cemail'],
                phone:            ['cphonenumber'],
                desiredSalary:    ['csalary'],
                coverLetter:      ['ccoverletter'],
                summary:          ['csummary'],
                // Breezy EEO dot-namespaced field names + flat alternatives
                gender:           ['eeoc.gender', 'gender'],
                // Bug fix: Breezy uses both "eeoc.race" and "race_ethnicity" across employers
                ethnicity:        ['eeoc.race', 'race_ethnicity'],
                veteranStatus:    ['eeoc.veteran_status'],
                disabilityStatus: ['eeoc.disability_status'],
                // Breezy address field
                streetAddress:    ['caddress'],
                // Breezy salary currency select — default to USD on postFill
                salaryCurrency:   ['salarycurrency'],
            };
        }

        async preFill() {
            // Phase 1: wait for Angular to bootstrap the form (ng-* classes appear on <form>).
            const start = Date.now();
            while (Date.now() - start < 5000) {
                if (document.querySelector('form[class*="ng-"], input[name^="c"]')) break;
                await delay(300);
            }

            // Phase 2: wait for async custom questions to finish rendering.
            // Breezy fetches employer-configured section_X_question_Y inputs via $http
            // AFTER Angular bootstraps, so the form tag gets ng-* classes before those
            // inputs exist. Poll until the section_ count stabilises for 600ms.
            let prev = -1;
            const settle = Date.now();
            while (Date.now() - settle < 4000) {
                const cur = document.querySelectorAll(
                    'input[name^="section_"], textarea[name^="section_"], select[name^="section_"]'
                ).length;
                if (cur > 0 && cur === prev) break; // count stable — done
                prev = cur;
                await delay(300);
            }
            // Give Angular one more digest cycle before we scan the DOM.
            await delay(200);
        }

        async discoverFields() {
            const rules = await super.discoverFields();

            // Bug fix 1: Remove honeypot fields before any further processing.
            // Breezy injects a hidden field (name="hp_7f2b", autocomplete="hp-4f3c9a") on
            // every form. Filling it marks the submission as a bot and silently drops it.
            const filtered = rules.filter(r => {
                const name = r.element?.getAttribute('name') || '';
                const ac   = r.element?.getAttribute('autocomplete') || '';
                return !HONEYPOT_NAME_RX.test(name) && !HONEYPOT_AC_RX.test(ac);
            });

            // Bug fix 3 + 4: Fix labels for custom-named radio groups AND unlabelled
            // custom-named checkboxes. Angular renders the first option's label text
            // (e.g. "Yes", "Indeed") as the group label instead of the actual question
            // heading. Walk up the DOM to find the real question text.
            // For radios: always attempt the fix (OPTION_LIKE_RX was too narrow — it
            // missed labels like "Indeed" from source-discovery radio groups).
            // For checkboxes: only attempt when the label is empty.
            for (const rule of filtered) {
                const name = rule.element?.getAttribute('name') || '';
                if (!CUSTOM_Q_RX.test(name)) continue;

                if (rule.type === 'radio') {
                    const realLabel = _findAngularQuestionLabel(rule.element);
                    if (realLabel) rule.label = realLabel;
                } else if (rule.type === 'checkbox' && !rule.label) {
                    const realLabel = _findAngularQuestionLabel(rule.element);
                    if (realLabel) rule.label = realLabel;
                }
            }

            return filtered;
        }

        async postFill() {
            // Bug fix 5: Auto-check SMS / email consent checkboxes.
            // Match by label text OR by name attribute — Breezy's smsConsent checkbox
            // has an empty label so CONSENT_RX on text alone never fires.
            const CONSENT_RX   = /\b(consent|i agree|i accept|opt.?in)\b/i;
            const CONSENT_NAME_RX = /consent|sms.?opt|optin|i.?agree/i;
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked || !cb.offsetParent) return;
                const name    = cb.getAttribute('name') || '';
                const labelEl = cb.labels?.[0] || cb.closest('label');
                const text = [
                    cb.getAttribute('aria-label') || '',
                    labelEl?.textContent || '',
                    cb.closest('[class*="field"], [class*="consent"], [class*="agree"]')
                        ?.textContent?.substring(0, 200) || ''
                ].join(' ');
                if (CONSENT_RX.test(text) || CONSENT_NAME_RX.test(name)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('input',  { bubbles: true }));
                }
            });

            // Bug fix 6: Fill unnamed pay-period select (Hourly/Weekly/Monthly/Yearly).
            // Breezy places this adjacent to the salary input but gives it no name or
            // label — it cannot be matched by any T1/T2/T3 path.
            document.querySelectorAll('select').forEach(sel => {
                if (sel.name) return; // named selects are handled by field-mapper T1
                const opts = Array.from(sel.options).map(o => o.text.trim().toLowerCase());
                if (opts.includes('yearly') && opts.includes('hourly')) {
                    const yearlyOpt = Array.from(sel.options).find(o => /yearly/i.test(o.text));
                    if (yearlyOpt && sel.value !== yearlyOpt.value) {
                        sel.value = yearlyOpt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            });

            // Bug fix 7: Default salaryCurrency select to "US Dollar ($)".
            // The select has 150+ currency options and is not mapped to any profile field.
            // If the field was already filled by T1 alias mapping leave it alone.
            const currSel = document.querySelector('select[name="salaryCurrency"]');
            if (currSel && !currSel.value) {
                const usdOpt = Array.from(currSel.options).find(o => /US Dollar/i.test(o.text));
                if (usdOpt) {
                    currSel.value = usdOpt.value;
                    currSel.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }

        getNextSelectors() {
            return 'button[type="submit"], button.apply-button, [class*="apply-btn"]';
        }
    }

    /**
     * Walk up from a radio/checkbox input to find the actual question heading text.
     * Breezy's Angular components render the question as a sibling div/p/span
     * above the radio container — not as a <legend> inside a <fieldset>.
     * We look at preceding siblings at each ancestor level until we find
     * non-option-like text that looks like a question.
     */
    function _findAngularQuestionLabel(firstInput) {
        let node = firstInput.parentElement;
        for (let depth = 0; depth < 6; depth++) {
            if (!node || node === document.body) break;

            // Check siblings that come before our node at this level
            const parent = node.parentElement;
            if (parent) {
                for (const child of parent.children) {
                    if (child === node) break;
                    if (child.querySelector('input')) continue; // skip input containers
                    const t = child.textContent?.trim().replace(/\*\s*$/, '').trim();
                    if (t && t.length > 5 && t.length < 200 && !OPTION_LIKE_RX.test(t)) {
                        return t;
                    }
                }
            }

            // Also check direct preceding siblings at this level
            let sib = node.previousElementSibling;
            while (sib) {
                if (!sib.querySelector('input')) {
                    const t = sib.textContent?.trim().replace(/\*\s*$/, '').trim();
                    if (t && t.length > 5 && t.length < 200 && !OPTION_LIKE_RX.test(t)) {
                        return t;
                    }
                }
                sib = sib.previousElementSibling;
            }

            node = parent;
        }
        return '';
    }

    window.QuickApplyFillerFactory.register('breezy', BreezyFiller);
    window.QuickApplyBreezyFiller = BreezyFiller;
})();
