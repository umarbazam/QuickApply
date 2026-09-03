(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    const GENERIC_LABEL_RX = /^(select\.?\.\.|select|search|textbox)\s*$/i;
    // Rippling anti-scraping: some custom question labels are replaced at render
    // time with short-token garbled strings ("Kl V Fl Nf Lz"). Pattern: 3+ short
    // alphanumeric tokens separated by whitespace.
    const GARBLED_LABEL_RX = /^([A-Za-z0-9]{1,6}\s+){2,}[A-Za-z0-9]{1,7}$/;

    class RipplingFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'rippling'; }

        getFieldAliases() {
            return {
                city: ['location'],
                currentCompany: ['current company'],
                workAuthorization: [
                    'are you legally authorized to work',
                    'authorized to work in the united states',
                    'work authorization',
                    'legally authorized to work',
                    'eligible to work',
                ],
                requiresSponsorship: [
                    'require visa sponsorship',
                    'will you require sponsorship',
                    'sponsorship required',
                    'require sponsorship',
                ],
            };
        }

        async preFill() {
            const start = Date.now();
            while (Date.now() - start < 5000) {
                if (document.querySelector('[data-testid^="input-"]')) return;
                await delay(300);
            }
        }

        async discoverFields() {
            const rules = await super.discoverFields();

            // ── Step 1: Stamp role="combobox" and fix rule.type ───────────────────
            // NOTE: do NOT add 'select-shell' class. select-shell routes fill-engine
            // to click sc, but sc.click() does not bubble down to the comboDiv. Only
            // comboDiv.click() opens the menu for Type B (pure-div) comboboxes.
            document.querySelectorAll('[data-testid="select-controller"]').forEach(sc => {
                const inp = sc.querySelector('input');
                if (inp && !inp.getAttribute('role')) inp.setAttribute('role', 'combobox');
            });
            for (const rule of rules) {
                if (rule.element?.closest('[data-testid="select-controller"]')) {
                    rule.type = 'combobox';
                }
            }

            // ── Step 2: Dedup per select-controller, swap element to INPUT if present
            const seenSelectControllers = new WeakSet();
            const deduplicated = [];
            for (const rule of rules) {
                const sc = rule.element?.closest('[data-testid="select-controller"]');
                if (sc) {
                    if (seenSelectControllers.has(sc)) continue;
                    seenSelectControllers.add(sc);
                    // Skip phone-country pickers. Rippling pre-fills these with the
                    // user's locale ("+1 US", "+44 GB"). No profile field matches, so
                    // AI batch would otherwise type junk ("No", job titles) into the
                    // searchable input — producing bugs like "+47 NO" on BambooHealth.
                    const innerInp = sc.querySelector('input');
                    if (innerInp && /^\+\d+\s*[A-Z]{2}/.test(innerInp.value || '')) continue;
                    if (rule.element.tagName !== 'INPUT') {
                        if (innerInp) rule.element = innerInp;
                    }
                    deduplicated.push(rule);
                } else {
                    if (rule.type === 'combobox' &&
                        rule.element?.tagName !== 'INPUT' &&
                        rule.element?.querySelector('[data-testid="select-controller"]')) {
                        continue;
                    }
                    deduplicated.push(rule);
                }
            }

            // ── Step 3: Fix generic/garbled/empty labels via aria-labelledby + sibling walk
            for (const rule of deduplicated) {
                const lbl = (rule.label || '').trim();
                const needsFix = !lbl
                    || lbl.length < 3
                    || GENERIC_LABEL_RX.test(lbl)
                    || GARBLED_LABEL_RX.test(lbl);
                if (!needsFix) continue;
                const realLabel = _findRipplingFieldLabel(rule.element);
                if (realLabel) rule.label = realLabel;
            }

            // ── Step 4: Skip pronouns ─────────────────────────────────────────────
            return deduplicated.filter(r => !/^pronouns?$/i.test(r.label || ''));
        }

        async postFill() {
            await delay(300);

            // Close any stuck-open dropdown from the main fill cycle before we start
            document.body.click();
            await delay(200);

            // EEO comboboxes (targeted by data-testid="eeoc.*") + work auth/sponsor
            await this._fillEEOComboboxes();
            await this._fillWorkAuthComboboxes();

            // Location: React-controlled Google Places input needs execCommand
            await this._fixLocationField();

            // Rippling CV parser can overwrite email after resume upload
            const email = this.profile?.email;
            if (email) {
                const emailInput = document.querySelector(
                    'input[data-testid="input-email"], input[type="email"], input[name="email"]'
                );
                if (emailInput) {
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeInputValueSetter.call(emailInput, email);
                    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            // ── Custom-question radio groups (Rippling ATS) ───────────────────────
            // name="customQuestions.<formId>.<questionId>"; the input has no
            // <label for>, the visible label is in a sibling DIV with
            // data-testid="radio-label-..." and the question text is in the
            // previousElementSibling of the closest [data-testid="field"]
            // ancestor. Walk up, pattern-match, and click.
            await this._fillCustomQuestionRadios();

            // SMS consent radio
            const SMS_CONSENT_RX = /consent to receiving text messages|agree.*text message|text message.*agreement/i;
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            for (const radio of radios) {
                const label = _radioLabelText(radio);
                if (/yes.*consent|i consent.*text/i.test(label) && !radio.checked) {
                    const group = radio.closest('[role="radiogroup"], fieldset, [class*="radioGroup"]');
                    const groupText = group?.textContent?.substring(0, 200) || '';
                    if (!group || SMS_CONSENT_RX.test(groupText) || SMS_CONSENT_RX.test(label)) {
                        radio.click();
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                        await delay(100);
                    }
                }
            }

            // Default unfilled Yes/No radio groups to "No"
            const radioGroups = document.querySelectorAll('[role="radiogroup"]');
            for (const group of radioGroups) {
                if (group.querySelector('input[type="radio"]:checked')) continue;
                const radiosInGroup = Array.from(group.querySelectorAll('input[type="radio"]'));
                if (radiosInGroup.length !== 2) continue;
                const labels = radiosInGroup.map(r => _radioLabelText(r).toLowerCase());
                if (!labels.some(l => /^yes\b/.test(l)) || !labels.some(l => /^no\b/.test(l))) continue;
                const groupText = (group.textContent || '').substring(0, 300).toLowerCase();
                if (/disability|veteran|military|gender|race|ethnicity|sms|text message/i.test(groupText)) continue;
                const noRadio = radiosInGroup.find((_, i) => /^no\b/.test(labels[i]));
                if (noRadio) {
                    noRadio.click();
                    noRadio.checked = true;
                    noRadio.dispatchEvent(new Event('change', { bubbles: true }));
                    await delay(100);
                }
            }
        }

        async _fillCustomQuestionRadios() {
            const profile = this.profile || {};
            const waLower = String(profile.workAuthorization || '').toLowerCase();
            const needsSponsor = /\bh1b?\b|\bopt\b|stem\s*opt|\bj1\b|\btn\b|e-?3\b|h4\s*ead|\bl1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(waLower);
            const willingRelocate = /yes|true|1/i.test(String(profile.willingToRelocate || ''));

            // Pattern → answer keyword. Check in order; first match wins.
            const PATTERNS = [
                { rx: /minimum\s+age|are\s+you\s+(?:at\s+least\s+)?\d{2}\s*\+?\s*(?:years?\s+(?:of\s+age|old))?/i, want: 'yes' },
                { rx: /(legally\s+)?authoriz(ed|ation)\s+to\s+work|right\s+to\s+work|eligible\s+to\s+work/i, want: 'yes' },
                { rx: /(require|need).{0,30}sponsor|visa\s+sponsor|sponsorship\s+for\s+employment/i, want: needsSponsor ? 'yes' : 'no' },
                { rx: /background\s+check|drug\s+(screen|test)|criminal\s+history/i, want: 'yes' },
                { rx: /commute|onsite|on-?site|in.{0,8}office|in.{0,8}person|willing\s+to\s+relocate/i, want: willingRelocate ? 'yes' : 'no' },
                { rx: /\bi\s+agree\b|\bi\s+consent\b|\bi\s+accept\b|terms\s+and\s+conditions|privacy\s+policy/i, want: 'yes' },
                { rx: /internal\s+candidate|discussed.{0,30}supervisor|current\s+supervisor/i, want: 'na' },
                { rx: /worked\s+at\s+|previously\s+(been\s+)?employed|former\s+employee/i, want: 'no' },
                { rx: /at\s+least\s+\d+\s+years?\s+of\s+experience|\d+\+\s*years?\s+of\s+experience/i, want: 'yes' }
            ];

            // Group radios by their customQuestions.* name
            const groups = new Map();
            document.querySelectorAll('input[type="radio"][name^="customQuestions."]').forEach(r => {
                const n = r.name;
                if (!groups.has(n)) groups.set(n, []);
                groups.get(n).push(r);
            });

            for (const [, radioList] of groups) {
                if (radioList.some(r => r.checked)) continue;
                // Question text = previousElementSibling of the closest [data-testid="field"] ancestor
                const fieldAncestor = radioList[0].closest('[data-testid="field"]');
                const questionEl = fieldAncestor?.previousElementSibling;
                const questionText = (questionEl?.innerText || questionEl?.textContent || '').trim();
                if (!questionText) continue;

                let want = null;
                for (const p of PATTERNS) {
                    if (p.rx.test(questionText)) { want = p.want; break; }
                }
                if (!want) continue;

                // Map intent to a radio in this group
                const matchValue = (val, target) => {
                    const v = String(val || '').trim().toLowerCase();
                    if (target === 'yes') {
                        // Prefer "Yes with a Visa" when sponsor is needed and the JD asks
                        // about authorization — otherwise plain "Yes" wins
                        if (needsSponsor && /yes.{0,5}visa/.test(v)) return 100;
                        return v === 'yes' ? 90 : v.startsWith('yes') ? 80 : 0;
                    }
                    if (target === 'no')  return v === 'no' ? 90 : v.startsWith('no') ? 80 : 0;
                    if (target === 'na')  return /^n\/?a$|not\s+applicable/.test(v) ? 90 : 0;
                    return 0;
                };
                radioList.sort((a, b) => matchValue(b.value, want) - matchValue(a.value, want));
                const target = radioList[0];
                if (matchValue(target.value, want) === 0) continue;

                // Click both the input and its label sibling — Rippling's React
                // form sometimes only commits via the label container click.
                target.checked = true;
                target.dispatchEvent(new Event('change', { bubbles: true }));
                target.dispatchEvent(new Event('input',  { bubbles: true }));
                target.click();
                await delay(80);
            }
        }

        async _fillEEOComboboxes() {
            // Rippling marks EEO question wrappers with data-testid="eeoc.<category>"
            // on the ancestor div containing the select-controller:
            //   eeoc.gender | eeoc.race | eeoc.hispanicOrLatino |
            //   eeoc.veteranStatus | eeoc.disabilityStatus
            // More reliable than walking sibling text — race nests 7+ levels deep.
            const categories = [
                { testid: 'eeoc.gender', getValue: () => this._genderValue() },
                { testid: 'eeoc.race', getValue: () => this._raceValue() },
                { testid: 'eeoc.hispanicOrLatino', getValue: () => this._hispanicValue() },
                { testid: 'eeoc.veteranStatus', getValue: () => this._veteranValue() },
                { testid: 'eeoc.disabilityStatus', getValue: () => this._disabilityValue() },
            ];
            for (const cat of categories) {
                const wrapper = document.querySelector(`[data-testid="${cat.testid}"]`);
                if (!wrapper) continue;
                const sc = wrapper.querySelector('[data-testid="select-controller"]');
                if (!sc) continue;
                const targetValue = cat.getValue();
                if (!targetValue) continue;
                await this._fillSelectControllerWithValue(sc, targetValue);
            }
        }

        async _fillWorkAuthComboboxes() {
            // Work authorization & sponsorship questions don't live under eeoc.* so
            // match them by question text. Check sponsorship first, since the
            // combined "authorized to work WITHOUT sponsorship" phrasing overlaps
            // both regexes but the semantic answer is the sponsorship one.
            const controllers = document.querySelectorAll('[data-testid="select-controller"]');
            for (const sc of controllers) {
                if (sc.closest('[data-testid^="eeoc."]')) continue; // handled elsewhere
                const comboDiv = sc.querySelector('[role="combobox"]');
                if (!comboDiv) continue;
                const label = _findRipplingFieldLabel(comboDiv);
                if (!label) continue;

                const wa = (this.profile.workAuthorization || '').toLowerCase();
                const isCitizenOrPR = /citizen|permanent resident|green card|\bgc\b/i.test(wa);

                let targetValue = null;
                if (/without.*sponsor|without.*need.*sponsor/i.test(label) &&
                    /authoriz|eligible/i.test(label)) {
                    // "Authorized to work WITHOUT sponsorship" — H1B answers "No"
                    targetValue = isCitizenOrPR ? 'Yes' : 'No';
                } else if (/require.*sponsor|visa sponsor|need.*sponsor|sponsorship/i.test(label)) {
                    // Pure sponsorship question — H1B answers "Yes"
                    targetValue = isCitizenOrPR ? 'No' : 'Yes';
                } else if (/eligible to work|legally authorized|authorized to work|work authorization/i.test(label)) {
                    // Pure work authorization — any valid status answers "Yes"
                    targetValue = 'Yes';
                }
                if (!targetValue) continue;

                await this._fillSelectControllerWithValue(sc, targetValue);
            }
        }

        /**
         * Open the select-controller, type (if searchable), find and click the
         * best-matching visible option. Handles both Type A (searchable input)
         * and Type B (pure-div combobox with no inner input) uniformly.
         */
        /**
         * Open the select-controller, type (if searchable), find and click the
         * best-matching visible option. Handles both Type A (searchable input)
         * and Type B (pure-div combobox with no inner input) uniformly.
         */
        async _fillSelectControllerWithValue(sc, targetValue) {
            const comboDiv = sc.querySelector('[role="combobox"]');
            const input = sc.querySelector('input');
            if (!comboDiv) return false;

            // Close any lingering-open dropdown from the previous fill — otherwise
            // comboDiv.click() toggles OUR target closed instead of opening it.
            document.body.click();
            await delay(200);

            // Click comboDiv (not sc). sc.click() does NOT bubble down to comboDiv.
            comboDiv.click();
            await delay(400);

            if (input) {
                // Type A: type targetValue to filter options
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeSetter.call(input, targetValue);
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true, inputType: 'insertText', data: targetValue,
                }));
                await delay(600);
            } else {
                // Type B: options appear directly after click
                await delay(300);
            }

            // Scope option query to the ACTIVE listbox via comboDiv's aria-controls.
            // Rippling keeps prior dropdown portals in the DOM, so a global
            // [role="option"] query accumulates options from every combobox ever
            // opened — we'd match the wrong one.
            const listboxId = comboDiv.getAttribute('aria-controls');
            const listbox = listboxId ? document.getElementById(listboxId) : null;
            const optSource = listbox || document;
            const opts = Array.from(
                optSource.querySelectorAll('[role="option"], .select__option, li[aria-selected]')
            ).filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const tLow = targetValue.toLowerCase();
            let best = opts.find(o => o.textContent.trim().toLowerCase() === tLow);
            if (!best) {
                best = opts.find(o => {
                    const oLow = o.textContent.trim().toLowerCase();
                    return oLow.startsWith(tLow.substring(0, Math.min(6, tLow.length))) ||
                        tLow.startsWith(oLow.substring(0, Math.min(6, oLow.length)));
                });
            }
            if (!best && opts.length === 1) best = opts[0];
            if (best) {
                best.click();
                await delay(200);
                return true;
            }
            document.body.click();
            await delay(200);
            return false;
        }

        _genderValue() {
            const g = (this.profile.gender || '').toLowerCase();
            if (/^m/i.test(g)) return 'Male';
            if (/^f/i.test(g)) return 'Female';
            return 'Decline to Self Identify';
        }

        _raceValue() {
            const eth = (this.profile.ethnicity || '').toLowerCase();
            if (!eth || /prefer not|decline/i.test(eth)) return 'Decline to Self Identify';
            if (/asian/i.test(eth)) return 'Asian';
            if (/black|african/i.test(eth)) return 'Black or African American';
            if (/hispanic|latin/i.test(eth)) return 'Hispanic or Latino';
            if (/white|caucasian/i.test(eth)) return 'White';
            if (/native|american indian|alaska/i.test(eth)) return 'American Indian or Alaska Native';
            if (/pacific|hawaiian/i.test(eth)) return 'Native Hawaiian or Other Pacific Islander';
            if (/two or more|multiracial/i.test(eth)) return 'Two or More Races';
            return 'Decline to Self Identify';
        }

        _hispanicValue() {
            const eth = (this.profile.ethnicity || '').toLowerCase();
            return /hispanic|latin/i.test(eth) ? 'Yes' : 'No';
        }

        _veteranValue() {
            const v = (this.profile.veteranStatus || '').toLowerCase();
            if (/yes|true|veteran|protected/i.test(v) && !/not|never|non/i.test(v)) {
                return 'I Identify as One or More of the Classifications of Protected Veterans';
            }
            return 'I am not a Protected Veteran';
        }

        _disabilityValue() {
            const d = (this.profile.disabilityStatus || '').toLowerCase();
            if (/yes|has|have/i.test(d) && !/don|not|no/i.test(d)) return 'Yes, I Have a Disability';
            if (/no|not|don/i.test(d)) return "No, I Don't Have a Disability";
            return "I Don't Wish to Answer";
        }

        async _fixLocationField() {
            const city = this.profile?.city;
            if (!city) return;
            // Rippling location is a React-controlled Google Places input.
            // setNativeValue() fails (React resets value on re-render).
            // document.execCommand('insertText') fires the native input event
            // React's onChange actually observes.
            const locationInput = document.querySelector(
                '[data-testid="location"] input, [data-testid="input-undefined"][aria-label="textbox"]'
            );
            if (!locationInput) return;

            locationInput.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, city);
            await delay(1500);

            const suggestions = Array.from(
                document.querySelectorAll('[role="option"], [role="listitem"], .pac-item')
            ).filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            if (suggestions.length > 0) {
                suggestions[0].click();
                await delay(300);
            }
        }

        getNextSelectors() { return 'button'; }
    }

    /**
     * Resolve a radio option's visible text. Rippling's styled radios (e.g.
     * name="sms_opt_in") render the option label as a sibling DOM subtree
     * (div#label-<name>-<id>) referenced only via aria-labelledby — the radio's
     * own <label> ancestor and parentElement are empty, so those checks alone
     * always return ''.
     */
    function _radioLabelText(radio) {
        const byLabel = radio.closest('label')?.textContent?.trim();
        if (byLabel) return byLabel;
        const byParent = radio.parentElement?.textContent?.trim();
        if (byParent) return byParent;
        const lbAttr = radio.getAttribute('aria-labelledby');
        if (lbAttr) {
            const joined = lbAttr.trim().split(/\s+/).map(id => {
                const ref = document.getElementById(id);
                return ref ? (ref.innerText || ref.textContent || '').trim() : '';
            }).filter(Boolean).join(' ');
            if (joined) return joined;
        }
        return '';
    }

    /**
     * Resolve the real question label for a Rippling form field. Precedence:
     *   1. aria-labelledby → document.getElementById(id).innerText
     *   2. sibling walk up to depth 10 looking for a previous-sibling text node
     */
    function _findRipplingFieldLabel(el) {
        // Check el and ancestors up to the select-controller for aria-labelledby.
        // Per ARIA spec, the value is a whitespace-separated list of IDs — resolve
        // each and join. Rippling uses both single-ID and multi-ID forms.
        let probe = el;
        for (let i = 0; i < 4 && probe; i++) {
            const lbAttr = probe.getAttribute?.('aria-labelledby');
            if (lbAttr) {
                const joined = lbAttr.trim().split(/\s+/).map(id => {
                    const ref = document.getElementById(id);
                    return ref ? (ref.innerText || ref.textContent || '').trim() : '';
                }).filter(Boolean).join(' ');
                const t = joined.replace(/[\*✱]\s*$/, '').trim();
                if (t.length > 2 && t.length < 200 && !GENERIC_LABEL_RX.test(t)) return t;
            }
            probe = probe.parentElement;
        }

        // Fallback: sibling walk (depth extended to 10 — race field nests deep)
        let node = el;
        for (let depth = 0; depth < 10; depth++) {
            if (!node || node === document.body) break;

            let sib = node.previousElementSibling;
            while (sib) {
                if (!sib.querySelector('input, select, textarea')) {
                    const raw = (sib.innerText || sib.textContent || '').trim();
                    const t = raw.replace(/[\*✱]\s*$/, '').trim();
                    if (t.length > 2 && t.length < 200 &&
                        !GENERIC_LABEL_RX.test(t) &&
                        !/^(drop or select|total \d|the résumé will|progress bar)/i.test(t) &&
                        !/^([A-Za-z0-9]{1,6} ){3,}[A-Za-z0-9]{1,7}$/.test(t)) {
                        return t;
                    }
                }
                sib = sib.previousElementSibling;
            }
            node = node.parentElement;
        }
        return '';
    }

    window.QuickApplyFillerFactory.register('rippling', RipplingFiller);
    window.QuickApplyRipplingFiller = RipplingFiller;
})();
