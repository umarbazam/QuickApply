/**
 * QuickApply — SAP SuccessFactors filler.
 *
 * SuccessFactors career sites (vendor-hosted *.successfactors.com and white-
 * labeled jobs.<company>.com) share a common form skeleton:
 *   - Standard <input>, <select>, <textarea> elements (some SAP UI5 / Fiori
 *     wrappers on newer tenants, but most fields still degrade to native form
 *     controls).
 *   - Field IDs often look like `applicationForm_<group>_<row>_<field>` or
 *     contain SF-specific prefixes (`applicationFormElement_`, `apdContact_`).
 *   - Multi-step flow: "Apply" → "Save" → "Submit". The page exposes
 *     "Save and Continue" or "Apply" CTAs.
 *
 * Two CV-parser flows are common:
 *   1) Resume parse on upload — repopulates name/email/phone/address. We need
 *      to re-assert profile values after parsing.
 *   2) Returning candidate fast-fill from SF profile — pulls saved Candidate
 *      Profile data into the form. We don't touch this path; the user is
 *      already authenticated and the prefill is theirs.
 */
(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // SF field IDs we want to lock back to profile values after CV parse.
    // The dotted suffix (anchored with $) is more stable than full ID matches.
    const REASSERT_PLAN = [
        { profileKey: 'firstName',     idRx: /firstName$|givenName$|apdContact.firstName/i,    labelRx: /first\s*name|given\s*name/i },
        { profileKey: 'lastName',      idRx: /lastName$|familyName$|apdContact.lastName/i,    labelRx: /last\s*name|family\s*name|surname/i },
        { profileKey: 'middleName',    idRx: /middleName$/i,                                  labelRx: /middle\s*name/i },
        { profileKey: 'email',         idRx: /email$|emailAddress$|apdContact.email/i,       labelRx: /e[\s_-]?mail/i },
        { profileKey: 'phone',         idRx: /phone$|phoneNumber$|cellPhone$|mobile$|apdContact.phone/i, labelRx: /phone|mobile|telephone/i },
        { profileKey: 'streetAddress', idRx: /address1$|addressLine1$|street1$|street$/i,    labelRx: /^address(\s*(line)?\s*1)?$|street\s*1/i },
        { profileKey: 'city',          idRx: /city$/i,                                       labelRx: /^city$/i },
        { profileKey: 'state',         idRx: /state$|stateProvince$|province$|region$/i,    labelRx: /state|province|region/i },
        { profileKey: 'zipCode',       idRx: /zip$|postal$|postalCode$|zipCode$/i,         labelRx: /zip|postal/i },
        { profileKey: 'country',       idRx: /country$/i,                                  labelRx: /country/i }
    ];

    function _setNativeValue(el, value) {
        if (!el) return false;
        try {
            const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, String(value));
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur',   { bubbles: true }));
            return true;
        } catch (_) { return false; }
    }

    function _findInputByPlan(plan, root = document) {
        // Pass A: id/name suffix match
        const all = root.querySelectorAll('input, textarea');
        for (const el of all) {
            const id = el.id || '';
            const nm = el.getAttribute('name') || '';
            if (plan.idRx.test(id) || plan.idRx.test(nm)) return el;
        }
        // Pass B: label text match
        for (const lbl of root.querySelectorAll('label')) {
            const t = (lbl.textContent || '').trim();
            if (!plan.labelRx.test(t)) continue;
            const forId = lbl.getAttribute('for');
            if (forId) {
                const el = root.getElementById?.(forId) || document.getElementById(forId);
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el;
            }
            const nested = lbl.querySelector('input, textarea');
            if (nested) return nested;
        }
        return null;
    }

    function _reAssertProfile(profile) {
        if (!profile) return;
        for (const plan of REASSERT_PLAN) {
            const expected = profile[plan.profileKey];
            if (!expected) continue;
            const el = _findInputByPlan(plan);
            if (!el || el.disabled || el.readOnly) continue;
            if (String(el.value || '').trim() === String(expected).trim()) continue;
            _setNativeValue(el, expected);
        }
    }

    function waitForDOMSettle(quietMs = 400, timeoutMs = 8000) {
        return new Promise(resolve => {
            if (!document.body) return resolve();
            let timer;
            const reset = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
            const done = () => { observer.disconnect(); resolve(); };
            const observer = new MutationObserver(reset);
            observer.observe(document.body, { childList: true, subtree: true });
            reset();
            setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
        });
    }

    class SuccessFactorsFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'successfactors'; }

        getFieldAliases() {
            return {
                // SF tenants use varied wording for the standard contact block.
                firstName: ['given name', 'first / given name'],
                lastName:  ['family name', 'surname', 'last / family name'],
                streetAddress: [
                    'address line 1', 'address 1', 'street address', 'street 1',
                    'street name and number', 'house number and street'
                ],
                streetAddress2: ['address line 2', 'address 2', 'street 2', 'apt/suite'],
                city: ['city / town', 'town', 'city or town'],
                state: ['state/province', 'state / province', 'province', 'region'],
                zipCode: ['postal code', 'zip / postal code', 'postcode'],
                country: ['country/region', 'country / region'],
                // SF often phrases legal-auth/sponsorship as long sentences.
                workAuthorization: [
                    'legally authorized to work',
                    'authorized to work in',
                    'eligible to work in',
                    'require sponsorship for employment',
                    'require sponsorship to work',
                    'require visa sponsorship',
                    'need sponsorship for employment',
                    'now or in the future, require sponsorship'
                ],
                // "How did you hear about us?" — SF labels this a few ways.
                heardAboutUs: [
                    'how did you hear', 'how did you learn', 'source',
                    'referral source', 'where did you hear about'
                ]
            };
        }

        getQuirks() {
            // SF uses standard form controls; no special focus handling needed.
            return {};
        }

        async preFill() {
            // SF career forms render quickly but can lazy-load EEO/voluntary
            // sections in collapsed accordions. Wait for the body to settle
            // before scanning so we don't miss late-arriving fields.
            await waitForDOMSettle(400, 2500);

            // Expand any collapsed sections so their fields are discoverable.
            // SF uses <button aria-expanded="false"> on disclosure widgets.
            const toggles = document.querySelectorAll('button[aria-expanded="false"]');
            for (const btn of toggles) {
                const t = (btn.textContent || '').toLowerCase();
                // Only expand obviously useful sections — skip "More info" menus
                // and language switchers.
                if (/section|details|address|contact|equal employment|voluntary|self.identif|education|experience|profile/i.test(t)) {
                    try { btn.click(); } catch (_) {}
                }
            }
            await delay(200);
        }

        async postFill() {
            // Give SF's CV parser (when present) time to overwrite fields,
            // then re-assert client-profile values into the contact block.
            await waitForDOMSettle(500, 6000);
            _reAssertProfile(this.profile);

            // Auto-check required consent / privacy / data-processing checkboxes.
            // SF's Data Privacy Statement is the most common blocker.
            const CONSENT_RX = /\bi consent\b|\bi agree\b|\bi accept\b|data privacy|data protection|terms.*conditions|read.*understood/i;
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked || cb.disabled) return;
                const labelText = [
                    cb.getAttribute('aria-label') || '',
                    cb.labels?.[0]?.textContent || '',
                    cb.closest('label')?.textContent || '',
                    cb.closest('[role="group"], fieldset')?.textContent?.substring(0, 200) || ''
                ].join(' ');
                if (CONSENT_RX.test(labelText)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('input',  { bubbles: true }));
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        }

        getNextSelectors() {
            // SF CTA labels (in order of preference):
            //   "Apply" → triggers form open
            //   "Save and Continue" → multi-step nav
            //   "Submit" → final submit
            //   "Next" → page nav
            return [
                'button[data-apply-button]',
                'button[id*="applyButton"]',
                'button[id*="saveAndContinue" i]',
                'button[id*="submitButton" i]',
                'button[type="submit"]',
                'button[id*="next" i]',
                'input[type="submit"]'
            ].join(', ');
        }
    }

    window.QuickApplyFillerFactory.register('successfactors', SuccessFactorsFiller);
    window.QuickApplySuccessFactorsFiller = SuccessFactorsFiller;
})();
