(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    class SmartRecruitersFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'smartrecruiters'; }

        async preFill() {
            // Wait for Angular to bootstrap spl-input components.
            // The <spl-input> HTML tag exists in the DOM immediately (before Angular
            // is ready), so checking for the element alone breaks the loop too early.
            // We must wait until the shadow root has been rendered with an <input>
            // inside — that's the signal that Angular's CVA has bootstrapped.
            for (let i = 0; i < 60; i++) {
                const host = document.querySelector('spl-input');
                if (host?.shadowRoot?.querySelector('input')) break;
                await delay(500);
            }

            // SR OneClick: Experience and Education sections start with NO visible entry fields.
            // Clicking "Add" creates a new <oc-experience-entry> / <oc-education-entry> DOM node.
            // The actual <button> lives inside spl-button's shadow root — pierce to it.
            // Guard: if entries already exist (from a prior fill pass) skip the click to
            // avoid adding duplicate experience/education rows.
            for (const [addSel, sectionSel] of [
                ['[data-test="add-experience"]', '[data-test="experience"]'],
                ['[data-test="add-education"]',  '[data-test="education"]'],
            ]) {
                const section = document.querySelector(sectionSel);
                if (section?.querySelector('spl-input, input:not([type="hidden"])')) continue;
                const btn = document.querySelector(addSel);
                if (!btn) continue;
                const splBtn = btn.querySelector('spl-button');
                const shadowBtn = splBtn?.shadowRoot?.querySelector('button');
                (shadowBtn || btn).click();
                await delay(500);
            }
        }

        async discoverFields() {
            const rules = await super.discoverFields();

            for (const rule of rules) {
                const lbl = (rule.label || '').toLowerCase();
                // "Let the company know about your interest working there" is SR's
                // cover-letter / motivation textarea. Normalise so the label-matcher
                // hits coverLetter instead of sending it to Gemini which misidentifies it.
                if (/let the company know|message to the hiring|message to hiring/i.test(lbl)) {
                    rule.label = 'Cover Letter';
                }
            }

            // Skip City/address autocomplete (autocomplete="off" + geocomplete widget resets on blur)
            return rules.filter(rule => {
                const el = rule.element;
                if (el.getAttribute('autocomplete') === 'off') {
                    if (/city|country|state|province|zip|postal/i.test(rule.label)) return false;
                }
                return true;
            });
        }

        async postFill() {
            // ── Privacy / GDPR consent checkbox ──
            // spl-checkbox wraps the actual <input type="checkbox"> in its shadow root.
            // The outer element has no label attribute — the text lives in light DOM —
            // so the field discoverer can't label it and the fill engine skips it.
            // Tick it here directly.
            const consentHost = document.querySelector('spl-checkbox');
            const consentCb   = consentHost?.shadowRoot?.querySelector('input[type="checkbox"]');
            if (consentCb && !consentCb.checked) {
                consentCb.checked = true;
                consentCb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                consentCb.dispatchEvent(new Event('click',  { bubbles: true, composed: true }));
                if (consentHost) {
                    consentHost.classList.remove('ng-pristine');
                    consentHost.classList.add('ng-dirty', 'ng-touched');
                }
            }

            // ── Angular ng-dirty ──
            // SmartRecruiters OneClick UI is Angular-based. After we set the
            // value on the inner <input> inside an spl-input shadow root and
            // dispatch composed input/change events, Angular's CVA correctly
            // syncs the value AND marks the control as ng-valid / ng-touched —
            // BUT NOT ng-dirty. Some submission validators only enable Next
            // when every required field is ng-dirty. We forcibly mark each
            // filled host as ng-dirty (and remove ng-pristine) so the form
            // accepts the values on submit.
            const SPL_HOSTS = 'spl-input, spl-textarea, spl-phone-field, spl-date-field, spl-autocomplete, spl-checkbox, spl-dropdown';
            document.querySelectorAll(SPL_HOSTS).forEach(host => {
                const shadow = host.shadowRoot;
                if (!shadow) return;
                const filled = [...shadow.querySelectorAll('input, textarea')]
                    .some(el => {
                        if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
                        return el.value && String(el.value).trim() !== '';
                    });
                if (!filled) return;
                host.classList.remove('ng-pristine');
                host.classList.add('ng-dirty');
                // Mirror onto the inner input — Angular reads both
                shadow.querySelectorAll('input, textarea').forEach(el => {
                    el.classList?.remove('ng-pristine');
                    el.classList?.add('ng-dirty');
                });
            });

            // Autocomplete fields (City, Title, Company, Office location,
            // Institution, School location) — typing alone doesn't lock in a
            // value. The host opens an spl-autocomplete menu; the user has to
            // pick an option. After typing, wait briefly for the menu to render,
            // then click the first visible option that matches.
            const autocompletes = document.querySelectorAll('spl-autocomplete');
            for (const ac of autocompletes) {
                const inner = ac.shadowRoot?.querySelector('input');
                if (!inner || !inner.value || String(inner.value).trim() === '') continue;
                const wanted = String(inner.value).trim().toLowerCase();
                // Re-fire input to wake the dropdown
                try {
                    inner.focus();
                    inner.dispatchEvent(new InputEvent('input', {
                        bubbles: true, composed: true,
                        inputType: 'insertText', data: inner.value
                    }));
                } catch (_) {}
                await delay(500);
                // Hunt for an option list: light DOM (Angular Material-style portal)
                // OR shadow DOM. Options for SR carry [role="option"] or .option class.
                const optionSelectors = ['[role="option"]', '.spl-option', '.option', 'li[aria-selected]'];
                let options = [];
                for (const sel of optionSelectors) {
                    options = [...document.querySelectorAll(sel)]
                        .filter(o => o.getBoundingClientRect().width > 0);
                    if (options.length) break;
                }
                if (!options.length) {
                    // Some SR variants put the menu inside spl-autocomplete's shadow root
                    for (const sel of optionSelectors) {
                        options = [...(ac.shadowRoot?.querySelectorAll(sel) || [])]
                            .filter(o => o.getBoundingClientRect().width > 0);
                        if (options.length) break;
                    }
                }
                if (!options.length) continue;
                // Pick exact, prefix, or first option as fallback
                let best = options.find(o => (o.textContent || '').trim().toLowerCase() === wanted);
                if (!best) best = options.find(o => (o.textContent || '').trim().toLowerCase().startsWith(wanted.slice(0, 8)));
                if (!best) best = options[0];
                try { best.click(); } catch (_) {}
                await delay(150);
            }
        }

        getNextSelectors() {
            // oc-button elements — no shadow DOM on outer Angular components, so direct query works.
            // footer-next = page 1 → page 2; footer-submit = final submission.
            // getButtonType in submit-engine.js classifies footer-submit as 'submit' via data-test check.
            return '[data-test="footer-next"], [data-test="footer-submit"]';
        }
    }

    window.QuickApplyFillerFactory.register('smartrecruiters', SmartRecruitersFiller);
    window.QuickApplySmartRecruitersFiller = SmartRecruitersFiller;
})();
