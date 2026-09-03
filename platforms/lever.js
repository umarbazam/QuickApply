(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Lever cards[UUID][fieldN] pattern — custom employer question fields
    const CARDS_RX     = /^cards\[/;
    // Lever DEI survey pattern
    const SURVEYS_RX   = /^surveysResponses\[/;
    // Required-field indicator Lever appends to label text
    const LEVER_REQ_RX = /[\u2731*✱]\s*$|\s*✱\s*No location found.*$/;

    const _PRONOUN_OPT_RX = /\bhe\b.*\bhim\b|\bshe\b.*\bher\b|\bthey\b.*\bthem\b|use.*name.*only|my pronoun/i;
    class LeverFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'lever'; }

        async preFill() {
            // Lever forms are React-rendered; wait up to 6 s for the name/email
            // inputs to appear before discovery + fill starts.
            const start = Date.now();
            while (Date.now() - start < 6000) {
                if (document.querySelector('input[name="name"], input[name="email"]')) return;
                await delay(200);
            }
        }

        getFieldAliases() {
            return {
                // Lever uses name="location" for the city/location autocomplete field.
                city: ['location'],

                // Bug fix 1: Lever standard EEO <select> fields — map to profile EEO fields.
                // These use name=eeo[gender], eeo[race], eeo[veteran], eeo[disability]
                // and were falling through to T3 Gemini with garbled concatenated labels.
                gender:           ['eeo[gender]'],
                ethnicity:        ['eeo[race]'],
                veteranStatus:    ['eeo[veteran]'],
                disabilityStatus: ['eeo[disability]'],

                // URL field name variants across Lever forms.
                // Standard Lever fields: urls[LinkedIn], urls[Twitter], urls[GitHub],
                // urls[Portfolio], urls[Other] — name attr lowercased, brackets stripped by mapper.
                // e.g. urls[LinkedIn] → urlslinkedin → matched by alias 'urls[linkedin]' → urlslinkedin.
                // twitter has no profile field — left for AI/T3 or skipped (optional).
                linkedIn: [
                    'urls[linkedin]', 'urls[linkedin profile]', 'urls[linkedin ]',
                    'urls[linkedin url]',
                ],
                github: ['urls[github]', 'urls[github url]', 'urls[github / other]'],
                portfolio: [
                    'urls[portfolio]', 'urls[portfolio url]', 'urls[portfolio/website]',
                    'urls[other]', 'urls[other website]', 'urls[personal website]',
                    'urls[website / blog / portfolio]', 'urls[personal website or portfolio]',
                    'urls[personal website ]',
                    'urls[other (website, portfolio, github, etc.)]',
                ],
            };
        }

        async discoverFields() {
            const rules = await super.discoverFields();

            // Bug fix 2: cards[...] and surveysResponses[...] fields often have a
            // bad label — radios get the first option value (e.g. "Yes", "LinkedIn"),
            // text/textarea inputs get the placeholder ("Type your response").
            // Neither tells Gemini what the question is asking.
            // Walk the DOM upward to find the .application-label question heading
            // and replace the label for ALL field types under these name patterns.
            for (const rule of rules) {
                const name = rule.element?.getAttribute('name') || '';
                if (!CARDS_RX.test(name) && !SURVEYS_RX.test(name)) continue;

                const realLabel = _findLeverQuestionLabel(rule.element);
                if (realLabel) {
                    rule.label = realLabel;
                }
            }

            // Remove pronoun-option checkboxes and legalConsent fields:
            // - Pronoun checkboxes are personal preference and cause AI resolver errors.
            //   The cards[] pronoun group is already skipped by _fillEEOCheckboxes, but
            //   non-cards pronoun inputs (name="pronouns" or individual option labels)
            //   reach the main fill engine and get wrong AI answers.
            // - legalConsent fields are handled entirely in _fillLegalConsentSection().
            return rules.filter(r => {
                const name = (r.element?.getAttribute('name') || '').toLowerCase();
                if (/^legalconsent/.test(name)) return false;
                if (/^pronouns$/.test(name)) return false;
                // EEO disability signature + date — owned entirely by postFill
                if (name === 'eeo[disabilitysignature]' || name === 'eeo[disabilitysignaturedate]') return false;
                if (r.type === 'checkbox' && _PRONOUN_OPT_RX.test(r.label)) return false;
                return true;
            });
        }

        async postFill() {
            // ── EEO checkbox groups (cards[...] checkboxes) ──
            await this._fillEEOCheckboxes();

            // ── DEI survey radio/checkbox groups (surveysResponses[...]) ──
            // Bug fix 3: these are completely separate from the standard EEO checkboxes
            // and were never handled — gender, veteran, disability, race radio groups
            // on Everlywell, Hatchit, Woven-by-Toyota etc. were left for T3 Gemini
            // with first-option-value labels, producing unreliable results.
            await this._fillSurveyEEOFields();

            // ── Location autocomplete commit ──
            // Lever's #location-input renders a Google-Places-style dropdown
            // (.dropdown-location items in the same .application-question
            // container) when the user types. Just setting input.value via
            // React's native setter doesn't open the dropdown and the form
            // shows "No location found ✱". We have to type char-by-char and
            // click the first matching suggestion.
            await this._commitLocationAutocomplete();

            // ── Identity re-fill after Lever's CV parse ──
            // Lever's server-side CV parser overwrites name/email/phone after upload.
            // Wait for it to settle, then re-fill those three fields.
            await delay(500);
            const freshRules = await super.discoverFields();
            const identityNames = new Set(['name', 'email', 'phone']);
            const identityRules = freshRules.filter(r =>
                identityNames.has(r.element?.getAttribute('name') || '')
            );
            if (identityRules.length > 0) {
                const answers = await window.QuickApplyAIResolver.resolveBatch(
                    identityRules, this.profile, '', this.profile.id || 'default', null, {}, {}, this
                );
                await window.QuickApplyFillEngine.fillAll(identityRules, answers);
            }

            // ── EEO disability signature + date ──
            // Standard Lever EEO section includes a signature line and date under
            // the disability question. These use name="eeo[disabilitySignature]"
            // and name="eeo[disabilitySignatureDate]" — not covered by legalconsent.
            await this._fillEEODisabilitySignature();

            // ── FCRA / legal-consent section ──
            // Lever forms with background-check disclosures need the consent
            // checkbox ticked, then a full-name signature and today's date.
            // These fields are excluded from the main fill pass (discoverFields
            // filters name^="legalconsent") so postFill owns them completely.
            await this._fillLegalConsentSection();
        }

        async _fillEEODisabilitySignature() {
            const _setInput = (el, val) => {
                const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                s.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const qs = sel => document.querySelector(sel);
            const p = this.profile || {};
            const full = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '';

            const sigEl = qs('input[name="eeo[disabilitySignature]"]');
            if (sigEl && full) _setInput(sigEl, full);

            const dateEl = qs('input[name="eeo[disabilitySignatureDate]"]');
            if (dateEl) {
                const d = new Date();
                const v = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
                _setInput(dateEl, v);
            }
        }

        async _fillLegalConsentSection() {
            const _setInput = (el, val) => {
                const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                s.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const qs = sel => document.querySelector(sel);

            // Tick the disclosure/consent checkbox
            const consentCb = qs('input[type="checkbox"][name^="legalConsent"]') ||
                               qs('input[type="checkbox"][name^="legalconsent"]');
            if (consentCb && !consentCb.checked) {
                consentCb.checked = true;
                consentCb.dispatchEvent(new Event('change', { bubbles: true }));
                await delay(200);
            }

            // Signature → full name from profile
            const sigEl = qs('input[name*="legalConsent"][name*="signature"]') ||
                          qs('input[name*="legalconsent"][name*="signature"]');
            if (sigEl && !sigEl.value) {
                const p = this.profile || {};
                const full = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '';
                if (full) _setInput(sigEl, full);
            }

            // Date → today MM/DD/YYYY
            const dateEl = qs('input[name*="legalConsent"][name*="date"]') ||
                           qs('input[name*="legalconsent"][name*="date"]') ||
                           qs('input[placeholder="MM/DD/YYYY"][name*="egal"]') ||
                           qs('input[placeholder="MM/DD/YYYY"][name*="onsent"]');
            if (dateEl && !dateEl.value) {
                const d = new Date();
                const v = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
                _setInput(dateEl, v);
            }
        }

        async _commitLocationAutocomplete() {
            const input = document.querySelector('#location-input, input[name="location"]');
            if (!input) return;
            // Build the query string from profile city/state/country
            const profile = this.profile || {};
            const queryParts = [profile.city, profile.state, profile.country].filter(Boolean);
            if (!queryParts.length) return;
            const query = queryParts.join(', ');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

            // Check if the value is already committed (Lever shows the picked
            // suggestion without a "No location found" error). If the input
            // already has the right value AND no error message, skip.
            const existing = (input.value || '').trim();
            const errorEl = input.closest('.application-question')?.querySelector('.error-message, [class*="error"]');
            if (existing && !errorEl && existing.toLowerCase().startsWith(profile.city?.toLowerCase() || '???')) {
                return;
            }

            // Clear existing value
            setter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await delay(120);
            input.focus();

            // Type char-by-char so Lever's autocomplete fetches as we go.
            // 80 ms per char is fast enough to feel snappy but slow enough for
            // the debounce-based XHR to fire.
            for (const c of query) {
                const cur = input.value + c;
                setter.call(input, cur);
                input.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }));
                await delay(60);
            }

            // Wait for dropdown to populate
            const container = input.closest('.application-question');
            if (!container) return;
            let options = [];
            for (let i = 0; i < 20; i++) {
                options = Array.from(container.querySelectorAll('.dropdown-location, [class*="dropdown-location"]'))
                    .filter(el => {
                        const text = (el.innerText || el.textContent || '').trim();
                        if (!text) return false;
                        // Walk ancestors up to container — if any are display:none the dropdown is closed
                        let node = el.parentElement;
                        while (node && node !== container) {
                            if (window.getComputedStyle(node).display === 'none') return false;
                            node = node.parentElement;
                        }
                        return true;
                    });
                if (options.length) break;
                await delay(150);
            }
            if (!options.length) return;

            // Pick the suggestion that best matches the profile.
            // Score each by token overlap with [city, state, country].
            const wantTokens = queryParts
                .flatMap(s => String(s).toLowerCase().split(/[\s,]+/))
                .filter(t => t.length > 1);
            const score = (text) => {
                const lc = text.toLowerCase();
                return wantTokens.reduce((n, t) => n + (lc.includes(t) ? 1 : 0), 0);
            };
            options.sort((a, b) => score(b.innerText) - score(a.innerText));
            const choice = options[0];

            // Click — Lever listens on mousedown for these dropdowns
            ['mousedown', 'mouseup', 'click'].forEach(type => {
                choice.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            await delay(200);
        }

        async _fillEEOCheckboxes() {
            const groups = new Map();
            document.querySelectorAll('input[type="checkbox"][name^="cards["]').forEach(cb => {
                const n = cb.name;
                if (!groups.has(n)) groups.set(n, []);
                groups.get(n).push(cb);
            });

            for (const [name, members] of groups) {
                // Bug fix 5: pronouns checkbox group — personal preference, leave unchecked.
                // The group uses name="pronouns" but some employers put pronoun checkboxes
                // inside cards[...] names; detect by label content too.
                const labels = members.map(cb => {
                    const lbl = cb.closest('label') ||
                        document.querySelector(`label[for="${CSS.escape(cb.id)}"]`);
                    return (lbl?.textContent || cb.value || '').trim();
                });

                if (labels.some(l => /\bhe\b.*\bhim\b|\bshe\b.*\bher\b|\bthey\b.*\bthem\b/i.test(l))) {
                    continue; // pronoun group — leave unchecked
                }

                // Acknowledge/consent checkbox — auto-check it
                if (members.length === 1 && /acknowledge|consent|agree/i.test(labels[0])) {
                    if (!members[0].checked) {
                        members[0].checked = true;
                        members[0].dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    continue;
                }

                let targetLabel = null;

                if (labels.some(l => /veteran/i.test(l))) {
                    const profileValue = (this.profile.veteranStatus || '').toLowerCase();
                    targetLabel = this._matchEEOLabel(labels, profileValue, {
                        // Bug fix 4: extend yes pattern to cover "I identify as...protected veteran"
                        // and "I Identify as a Veteran" variants used by Palantir and others
                        yes: /yes.*veteran|i am a veteran|i identify as.*veteran|one or more.*veteran|protected veteran/i,
                        no:  /no.*veteran|not a veteran|i am not/i,
                    });
                } else if (labels.some(l => /disability|disabled/i.test(l))) {
                    const profileValue = (this.profile.disabilityStatus || '').toLowerCase();
                    targetLabel = this._matchEEOLabel(labels, profileValue, {
                        yes: /yes.*disability|i have a disability|history.*disability/i,
                        no:  /no.*disability|do not have|not.*disability/i,
                    });
                } else if (labels.some(l => /hispanic.*latin|non-hispanic/i.test(l))) {
                    const profileValue = (this.profile.hispanicLatino || '').toLowerCase();
                    if (/yes|hispanic|latino/i.test(profileValue)) {
                        targetLabel = labels.find(l => /^hispanic or latin/i.test(l));
                    } else if (/no|not/i.test(profileValue)) {
                        targetLabel = labels.find(l => /non-hispanic/i.test(l));
                    }
                } else if (labels.some(l => /american indian|alaska|pacific islander/i.test(l))) {
                    const profileValue = (this.profile.ethnicity || '').toLowerCase();
                    if (profileValue && !/prefer not|decline/i.test(profileValue)) {
                        const words = profileValue.split(/\s+/).filter(w => w.length > 3);
                        targetLabel = labels.find(l =>
                            words.some(w => l.toLowerCase().includes(w))
                        );
                    }
                }

                if (!targetLabel) {
                    targetLabel = labels.find(l => /prefer not|not disclose/i.test(l)) || null;
                }

                if (targetLabel) {
                    const idx = labels.indexOf(targetLabel);
                    if (idx >= 0 && !members[idx].checked) {
                        members[idx].checked = true;
                        members[idx].dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            }
        }

        // Bug fix 3: Handle surveysResponses[UUID][responses][fieldN] DEI survey fields.
        // These are Lever's separate diversity survey and use radio groups (and occasionally
        // checkboxes) for gender, veteran status, disability, race, age, sexual orientation.
        // Age, sexual orientation, education level are sensitive/not-in-profile — skipped.
        async _fillSurveyEEOFields() {
            // ── Radio groups ──
            const radioGroups = new Map();
            document.querySelectorAll('input[type="radio"][name^="surveysResponses["]').forEach(r => {
                const n = r.name;
                if (!radioGroups.has(n)) radioGroups.set(n, []);
                radioGroups.get(n).push(r);
            });

            for (const [, members] of radioGroups) {
                const opts = members.map(r => {
                    const lbl = r.closest('label') ||
                        document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
                    return { el: r, text: (lbl?.textContent || r.value || '').trim() };
                });
                const texts = opts.map(o => o.text);

                let targetText = null;

                if (texts.some(t => /\bfemale\b|\bwoman\b/i.test(t)) &&
                    texts.some(t => /\bmale\b|\bman\b/i.test(t))) {
                    // Gender radio
                    const g = (this.profile.gender || '').toLowerCase();
                    if (/^m/i.test(g)) {
                        targetText = texts.find(t => /^male$|^man$|cisgender male/i.test(t));
                    } else if (/^f/i.test(g)) {
                        targetText = texts.find(t => /^female$|^woman$|cisgender female/i.test(t));
                    }
                    if (!targetText) targetText = texts.find(t => /prefer not|decline|not.*answer/i.test(t));

                } else if (texts.some(t => /veteran|military|reserve/i.test(t))) {
                    // Veteran / military status radio
                    const v = (this.profile.veteranStatus || '').toLowerCase();
                    if (/yes|true|veteran|protected/i.test(v)) {
                        targetText = texts.find(t =>
                            /i am a veteran|i identify.*veteran|protected veteran|active reserve/i.test(t)
                        );
                    } else if (/no|false/i.test(v)) {
                        targetText = texts.find(t =>
                            /not a veteran|i am not|no military|inactive|have not been/i.test(t)
                        );
                    }
                    if (!targetText) targetText = texts.find(t => /prefer not|decline|not.*answer/i.test(t));

                } else if (texts.some(t => /disability|disabled/i.test(t)) ||
                           (texts.length <= 4 && texts.some(t => /^yes$/i.test(t)) && texts.some(t => /^no$/i.test(t)))) {
                    // Disability Yes/No (when the radio is in a disability context)
                    // Only handle small yes/no groups that follow a disability question
                    if (texts.some(t => /disability|disabled/i.test(t))) {
                        const d = (this.profile.disabilityStatus || '').toLowerCase();
                        if (/yes|has|have/i.test(d)) {
                            targetText = texts.find(t => /^yes|yes.*disability|i have.*disability|identify.*disability/i.test(t));
                        } else if (/no|not/i.test(d)) {
                            targetText = texts.find(t => /^no$|no.*disability|do not.*disability/i.test(t));
                        }
                        if (!targetText) targetText = texts.find(t => /prefer not|decline|not.*answer/i.test(t));
                    }
                } else if (texts.some(t => /white|caucasian|hispanic|african american|asian|native/i.test(t))) {
                    // Race / ethnicity single-select radio (some forms use radio not checkbox)
                    const eth = (this.profile.ethnicity || '').toLowerCase();
                    if (eth && !/prefer not|decline/i.test(eth)) {
                        const words = eth.split(/\s+/).filter(w => w.length > 3);
                        targetText = texts.find(t =>
                            words.some(w => t.toLowerCase().includes(w))
                        );
                    }
                    if (!targetText) targetText = texts.find(t => /prefer not|decline|not.*answer/i.test(t));
                }
                // Sexual orientation, pronouns, age, education — skip (sensitive / not in profile)

                if (targetText) {
                    const target = opts.find(o => o.text === targetText);
                    if (target && !target.el.checked) {
                        target.el.checked = true;
                        target.el.dispatchEvent(new Event('change', { bubbles: true }));
                        target.el.dispatchEvent(new Event('click',  { bubbles: true }));
                    }
                }
            }

            // ── Multi-select race checkboxes (surveysResponses) ──
            const cbGroups = new Map();
            document.querySelectorAll('input[type="checkbox"][name^="surveysResponses["]').forEach(cb => {
                const n = cb.name;
                if (!cbGroups.has(n)) cbGroups.set(n, []);
                cbGroups.get(n).push(cb);
            });

            for (const [, members] of cbGroups) {
                if (members.length < 2) continue;
                const labels = members.map(cb => {
                    const lbl = cb.closest('label') ||
                        document.querySelector(`label[for="${CSS.escape(cb.id)}"]`);
                    return (lbl?.textContent || cb.value || '').trim();
                });

                if (!labels.some(l => /caucasian|african american|hispanic|asian|native|latino/i.test(l))) {
                    continue; // not a race/ethnicity group
                }

                const eth = (this.profile.ethnicity || '').toLowerCase();
                if (!eth || /prefer not|decline/i.test(eth)) {
                    // Check "prefer not to answer" if available
                    const idx = labels.findIndex(l => /prefer not|decline|not.*answer/i.test(l));
                    if (idx >= 0 && !members[idx].checked) {
                        members[idx].checked = true;
                        members[idx].dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    continue;
                }

                const words = eth.split(/\s+/).filter(w => w.length > 3);
                const idx = labels.findIndex(l =>
                    words.some(w => l.toLowerCase().includes(w))
                );
                if (idx >= 0 && !members[idx].checked) {
                    members[idx].checked = true;
                    members[idx].dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }

        /** Match EEO label — returns the label string for the best option */
        _matchEEOLabel(labels, profileValue, patterns) {
            if (/yes|true|1/i.test(profileValue)) {
                return labels.find(l => patterns.yes.test(l));
            }
            if (/no|false|0/i.test(profileValue)) {
                return labels.find(l => patterns.no.test(l));
            }
            return labels.find(l => /prefer not|not disclose/i.test(l));
        }

        getNextSelectors() { return 'button[type="submit"]'; }
    }

    /**
     * Walk up from a radio/checkbox input to find Lever's question heading text.
     * Lever renders questions as:
     *   .application-question
     *     .application-label  ← question text (what we want)
     *     .application-field
     *       <radio inputs>
     *
     * The .application-label is a previous sibling of the container that holds
     * the radio inputs, so we scan previousElementSibling at each ancestor level.
     * We only return text from elements with no input descendants (to avoid
     * accidentally picking up another question's option text).
     *
     * Returns '' if nothing useful is found.
     */
    function _findLeverQuestionLabel(el) {
        let node = el;
        for (let d = 0; d < 8; d++) {
            if (!node || node === document.body) break;
            let sib = node.previousElementSibling;
            while (sib) {
                if (!sib.querySelector('input, select, textarea')) {
                    const raw = sib.textContent.trim();
                    const t = raw.replace(LEVER_REQ_RX, '').trim();
                    if (t.length > 3 && t.length < 300) return t;
                }
                sib = sib.previousElementSibling;
            }
            node = node.parentElement;
        }
        return '';
    }

    window.QuickApplyFillerFactory.register('lever', LeverFiller);
    window.QuickApplyLeverFiller = LeverFiller;
})();
