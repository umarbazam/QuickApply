/**
 * QuickApply — UKG Pro Recruiting (UltiPro) filler.
 *
 * Live structure verified 2026-05-31 against
 *   recruiting2.ultipro.com/<tenant>/JobBoard/<boardUuid>/OpportunityApply
 *
 * Stable PascalCase IDs on the contact / EEO block:
 *   FirstName, PreferredName, FamilyName, FormerName,
 *   Phone, Country, AddressLine1, AddressLine2, City, PostalCode,
 *   WillingToRelocate (checkbox), ApplicantSource (select),
 *   Gender, HispanicOrigin, USFederalContractor (all selects),
 *   YourName, TodaysDate, EmployeeId (text)
 *
 * Custom client questions render as:
 *   - <input type="radio" name="MultipleChoiceResponse{N}"> Yes/No groups
 *   - <textarea id="TextResponse{N}"> open responses
 *   - <input type="radio" name="employeereferral"> Yes/No
 *   - <input type="radio" name="AreYouDisabled"> 3-option disability question
 *
 * Framework: Knockout.js (1000+ `data-bind` attrs on the form). The base
 * fill-engine's input+change dispatch already wakes KO observables — no
 * special handling needed for the basic text/select path. The custom-question
 * radio groups have no profile mapping; postFill applies safe Yes/No defaults
 * based on label pattern (mirrors the Ashby approach).
 *
 * Email is NOT collected on the form — the logged-in UKG account email is used.
 */
(function () {
    'use strict';

    const delay = ms => new Promise(r => setTimeout(r, ms));

    function _isYesNoGroup(radios) {
        if (!radios || radios.length < 2 || radios.length > 4) return false;
        const labels = radios.map(r => {
            const lbl = r.id
                ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)
                : r.closest('label');
            return (lbl?.textContent || r.value || '').trim().toLowerCase();
        });
        const hasYes = labels.some(l => /^yes(\s|$|,)/.test(l) || l === 'yes or not applicable');
        const hasNo  = labels.some(l => /^no(\s|$|,)/.test(l));
        return hasYes && hasNo;
    }

    function _radioLabelText(r) {
        const lbl = r.id
            ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)
            : r.closest('label');
        return (lbl?.textContent || r.value || '').trim();
    }

    function _checkRadio(r) {
        r.checked = true;
        r.dispatchEvent(new Event('input',  { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Find the human-readable label/heading that introduces a radio group.
    // UltiPro radios have no <fieldset>/<legend> — the question label lives in
    // a preceding sibling block before the option list.
    function _questionLabelFor(radio) {
        // Walk up looking for an enclosing question container (KO renders one
        // <div class="form-group"> or similar per question).
        const container = radio.closest('.form-group, [data-bind*="Question"], [data-bind*="MultipleChoice"], li, fieldset')
                       || radio.parentElement?.parentElement;
        if (!container) return '';
        // The question text is typically the first non-empty block-level text
        // that does NOT contain the radio inputs themselves.
        for (const child of container.children) {
            if (child.contains(radio)) continue;
            const t = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.length > 6) return t;
        }
        // Fallback: container text minus the radio option labels.
        const allRadios = container.querySelectorAll('input[type=radio]');
        const optTexts = [...allRadios].map(_radioLabelText);
        let t = (container.innerText || '').replace(/\s+/g, ' ').trim();
        for (const ot of optTexts) t = t.replace(ot, '');
        return t.trim();
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

    class UltiProFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'ultipro'; }

        getFieldAliases() {
            return {
                // UKG uses British-English phrasing on some tenants (Postcode,
                // Town/City, Licences, Behaviours), and PascalCase IDs the
                // global aliases don't have.
                firstName:     ['firstname'],
                lastName:      ['family name', 'familyname', 'last name'],
                preferredName: ['preferredname', 'preferred name', 'nickname'],
                phone:         ['primary telephone', 'primarytelephone'],
                streetAddress: ['addressline1', 'address 1', 'address line 1'],
                streetAddress2:['addressline2', 'address 2', 'address line 2'],
                city:          ['town/city', 'town / city'],
                zipCode:       ['postcode', 'postalcode', 'postal code'],
                country:       ['country'],
                heardAboutUs:  ['applicantsource', 'how did you hear about this opportunity'],
                // EEO IDs are PascalCase: Gender, HispanicOrigin, USFederalContractor, AreYouDisabled
                ethnicity:        ['hispanicorigin', 'ethnic origin', 'race / ethnicity'],
                veteranStatus:    ['usfederalcontractor', 'are you a protected veteran', 'protected veteran'],
                disabilityStatus: ['areyoudisabled'],
                // "Willing to relocate" is a single checkbox bound to the
                // boolean profile flag.
                willingToRelocate: ['willingtorelocate', 'willing to relocate'],
                // Acknowledgement / for-employer-use block at the bottom.
                fullName:         ['yourname'],
                // EmployeeId is "if applicable" — leave for AI / typically blank.
                employeeId:       ['employeeid', 'employee id'],
                workAuthorization: [
                    'legally authorized to work', 'authorized to work',
                    'eligible to work', 'right to work',
                    'require sponsorship', 'need sponsorship',
                    'now or in the future, require sponsorship'
                ]
            };
        }

        async preFill() {
            // KO renders the form into `<div class="opportunity-render-view">`
            // after a brief delay. Wait for it before scanning.
            for (let i = 0; i < 30; i++) {
                if (document.querySelector('#FirstName, #FamilyName, [name="MultipleChoiceResponse0"]')) break;
                await delay(300);
            }
            await waitForDOMSettle(400, 2500);
        }

        async postFill() {
            await waitForDOMSettle(400, 3000);

            const profile = this.profile || {};
            const profCountryUS = /\b(united states|usa|u\.s\.a?\.?)\b/i.test(
                String(profile.city || '') + ' ' + String(profile.state || '') + ' ' + String(profile.country || '')
            );
            const waLower = String(profile.workAuthorization || '').toLowerCase();
            const needsSponsor = /\bh1b?\b|opt\b|stem\s*opt|\bj1\b|\btn\b|e-?3\b|h4\s*ead|\bl1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(waLower);
            const willingToRelocate = /yes|true|1/i.test(String(profile.willingToRelocate || ''));

            // ── Auto-check "Willing to relocate" checkbox ──
            const wr = document.getElementById('WillingToRelocate');
            if (wr && wr.type === 'checkbox' && wr.checked !== willingToRelocate) {
                wr.checked = willingToRelocate;
                wr.dispatchEvent(new Event('click',  { bubbles: true }));
                wr.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // ── Default-answer unfilled Yes/No radio groups ──
            // UltiPro custom questions ship as MultipleChoiceResponse{N} with
            // Yes/No (and sometimes "Not Applicable") options. Apply label-
            // pattern defaults; safe + matches Convergint-style screening Qs.
            const LEGAL_AUTH = /legally authorized|authorized to work|eligible to work|right to work|work authorization|18 years|over the age of 18|legal age/i;
            const SPONSOR_PAT = /require.*sponsor|need.*sponsor|visa sponsor|sponsor.*immigration|sponsor.*visa|sponsorship/i;
            const NON_COMPETE = /non.?compete|nda|non.?disclosure|restrictive covenant|confidentiality agreement/i;
            const PRIOR_EMPLOY = /previously (been )?employed|prior.*employer|formerly employed|ever been employed|previously worked|former employee|currently employed by|employed by (the company|convergint|our company)/i;
            const FELONY_PAT = /convict|felony|criminal (record|history|background)/i;
            const REFERRAL_PAT = /referred by|employee referral|referral from|colleague refer/i;
            const YES_OK = /can you (perform|legally|safely)|able to perform|able to (work|travel)|reliable transportation|willing to (work|travel|relocate)|consent|i agree|i acknowledge|i confirm|18 or older|at least 18|essential function|background check|drug screen|drug test|consent to|i understand/i;

            const radioGroups = new Map(); // name → [radios]
            document.querySelectorAll('input[type=radio]').forEach(r => {
                const nm = r.name || '';
                if (!nm) return;
                if (!radioGroups.has(nm)) radioGroups.set(nm, []);
                radioGroups.get(nm).push(r);
            });

            for (const [name, radios] of radioGroups) {
                // Skip already-answered
                if (radios.some(r => r.checked)) continue;
                if (!_isYesNoGroup(radios)) continue;
                const qLabel = _questionLabelFor(radios[0]);
                if (!qLabel) continue;
                let target = null; // 'yes' | 'no'
                if      (LEGAL_AUTH.test(qLabel))    target = 'yes';
                else if (SPONSOR_PAT.test(qLabel))   target = needsSponsor ? 'yes' : 'no';
                else if (NON_COMPETE.test(qLabel))   target = 'no';
                else if (PRIOR_EMPLOY.test(qLabel))  target = 'no';
                else if (FELONY_PAT.test(qLabel))    target = 'no';
                else if (REFERRAL_PAT.test(qLabel))  target = 'no';
                else if (YES_OK.test(qLabel))        target = 'yes';
                if (!target) continue;
                const yesRx = /^yes\b|^yes or not applicable$/i;
                const noRx  = /^no\b/i;
                const pick = radios.find(r => {
                    const t = _radioLabelText(r);
                    return target === 'yes' ? yesRx.test(t) : noRx.test(t);
                });
                if (pick) _checkRadio(pick);
            }

            // ── "Are you a protected veteran?" / disability radios ──
            // AreYouDisabled has 3 options: Yes / No / I do not want to answer.
            // Prefer the profile.disabilityStatus value; fall back to a safe
            // "I do not want to answer" if none provided.
            const disabilityRadios = [...document.querySelectorAll('input[type=radio][name="AreYouDisabled"]')];
            if (disabilityRadios.length && !disabilityRadios.some(r => r.checked)) {
                const want = String(profile.disabilityStatus || 'I do not want to answer').toLowerCase();
                let pick = null;
                if (/^no\b|do not have/.test(want))    pick = disabilityRadios.find(r => /^no/i.test(_radioLabelText(r)));
                else if (/^yes\b|have a/.test(want))   pick = disabilityRadios.find(r => /^yes/i.test(_radioLabelText(r)));
                else                                    pick = disabilityRadios.find(r => /not want to answer|prefer not/i.test(_radioLabelText(r)));
                if (pick) _checkRadio(pick);
            }

            // ── "TodaysDate" auto-fill ──
            // For-employer-use block has a Date field at the bottom; UKG accepts
            // common formats (MM/DD/YYYY). Honor the user's locale-ish format
            // by reading the placeholder, else default MM/DD/YYYY.
            const dateEl = document.getElementById('TodaysDate');
            if (dateEl && !String(dateEl.value || '').trim()) {
                const d = new Date();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const y = d.getFullYear();
                try {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(dateEl, `${m}/${dd}/${y}`);
                    dateEl.dispatchEvent(new Event('input',  { bubbles: true }));
                    dateEl.dispatchEvent(new Event('change', { bubbles: true }));
                } catch (_) {}
            }

            // ── "YourName" auto-fill ──
            const yn = document.getElementById('YourName');
            if (yn && !String(yn.value || '').trim()) {
                const full = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
                if (full) {
                    try {
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        setter.call(yn, full);
                        yn.dispatchEvent(new Event('input',  { bubbles: true }));
                        yn.dispatchEvent(new Event('change', { bubbles: true }));
                    } catch (_) {}
                }
            }
        }

        getNextSelectors() {
            // UltiPro CTAs: "Apply now", "Submit", "Continue", "Next". KO often
            // binds the action to a button without type=submit, so we cast wider.
            return [
                'button[data-bind*="submit" i]',
                'button[data-bind*="apply" i]',
                'button[type="submit"]',
                'button.btn-primary',
                'a.btn-primary[role="button"]',
                'input[type="submit"]'
            ].join(', ');
        }
    }

    window.QuickApplyFillerFactory.register('ultipro', UltiProFiller);
    window.QuickApplyUltiProFiller = UltiProFiller;
})();
