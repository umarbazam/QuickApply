(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** Infer required flag for Ashby field-entry UI (matches scrape "requiredVisual" heuristics). */
    function _ashbyInferRequired(container, labelText) {
        const t = (labelText || '').trim();
        if (/✱/.test(t) || /\*+\s*$/.test(t)) return true;
        if (/\(required\)|\brequired\b/i.test(t)) return true;
        if (!container) return false;
        try {
            if (container.querySelector('[aria-required="true"]')) return true;
            if (container.querySelector(
                '[class*="requiredField"], [class*="labelRequired"], [class*="Required"], [class*="required"]'
            )) return true;
        } catch (_) {}
        return false;
    }

    function _btnAlreadyActive(btn) {
        const cls = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
        return cls.includes('selected') || cls.includes('active') || cls.includes('pressed')
            || btn.getAttribute('aria-pressed') === 'true'
            || btn.getAttribute('aria-current') === 'true'
            || (btn.getAttribute('data-state') || '') === 'on';
    }

    function _ashbyButtonGroupAnswered(rule) {
        const btns = rule.elements || [rule.element];
        let sawButton = false;
        for (const b of btns) {
            if (!b || b.tagName !== 'BUTTON') continue;
            sawButton = true;
            if (b.getAttribute('aria-pressed') === 'true') return true;
            if (b.getAttribute('aria-current') === 'true') return true;
            const ds = b.getAttribute('data-state') || '';
            if (ds === 'on' || ds === 'checked') return true;
            const cls = (typeof b.className === 'string' ? b.className : '').toLowerCase();
            // \b word boundaries miss CSS-module names like _selected_abc123 (underscore = \w)
            // Use simple substring match instead — safe since we're checking button elements only.
            // Ashby uses CSS-module class _active_<hash> for selected buttons
            if (cls.includes('selected') || cls.includes('pressed') || cls.includes('active')) return true;
        }
        return false;
    }

    function _ashbyRuleStillEmpty(rule) {
        if (!rule || !rule.element) return true;
        try {
            if (rule.type === 'file') {
                const el = rule.element;
                return !(el.files && el.files.length > 0);
            }
            if (rule.type === 'checkbox') {
                const members = rule.elements || [rule.element];
                return !members.some(m => m && m.checked);
            }
            if (rule.type === 'radio') {
                if (rule.isButtonGroup) return !_ashbyButtonGroupAnswered(rule);
                const members = rule.elements || [rule.element];
                return !members.some(m =>
                    m && m.tagName === 'INPUT' && m.type === 'radio' && m.checked
                );
            }
            if (rule.type === 'select') {
                return !rule.element.value;
            }
            if (rule.type === 'combobox' || rule.type === 'text' || rule.type === 'date') {
                return !String(rule.element.value || '').trim();
            }
        } catch (_) {}
        return true;
    }

    async function _ashbyRetryUnfilledRequired(self) {
        const skipFocus = self.getQuirks?.().skipFocus ?? false;
        const maxRounds = 2;
        // Wait before first discovery so the preceding fillAll's button clicks have
        // time to settle in React's state. Without this delay, button groups appear
        // "still empty" (the _active_ class hasn't been added yet) and get re-clicked,
        // toggling them back off.
        await delay(700);

        // Bug fix: pass aiInstance so Gemini T3 runs on retry for unfilled required fields.
        // Previously always passed null, meaning required combobox/radio fields were never
        // answered by AI on the retry pass even with a valid Gemini key.
        let _retryAI = null;
        if (window.QuickApplyAI) {
            _retryAI = window.QuickApplyAI;
            await _retryAI.init().catch(() => { _retryAI = null; });
        }

        for (let round = 0; round < maxRounds; round++) {
            if (!window.QuickApplyAIResolver || !window.QuickApplyFillEngine) break;
            let rules;
            try {
                rules = await self.discoverFields();
            } catch (_) { break; }
            const pending = rules.filter(r => r.required && _ashbyRuleStillEmpty(r));
            if (!pending.length) break;

            let answers;
            try {
                answers = await window.QuickApplyAIResolver.resolveBatch(
                    pending,
                    self.profile,
                    self.profile?.resumeText || self.profile?.cvText || '',
                    self.profile.id || 'default',
                    _retryAI,
                    {},
                    { forceAI: !!self.settings?.forceAI }
                );
            } catch (_) { break; }
            if (!answers || answers.size === 0) break;

            await window.QuickApplyFillEngine.fillAll(
                pending,
                answers,
                { filledSelectors: new Set(), skipFocus }
            );
            await delay(700);
        }
    }

    // Module-level guard: prevent CV re-upload loop
    let _cvUploadedThisPageLoad = false;

    class AshbyFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'ashby'; }

        getFieldAliases() {
            return {
                // Ashby uses "Location" / "Current Location" combobox/text for city (98+ form slots).
                // Global city aliases don't include these label texts, so add them here.
                city: [
                    'location', 'current location', 'current_location',
                    'where are you currently located', 'where are you located',
                    'where are you based', 'where do you currently reside',
                    'home location', 'city of residence', 'city and state',
                    'city & state', 'city, state', 'where are you physically based',
                    'city & state where you will be working from',
                ],
                // Ashby EEO radio groups use name="UUID__systemfield_eeoc_race".
                // The global alias "eeo_race" fails substring-match against "eeoc_race" (extra 'c').
                // Without this, matchByLabel fires first and returns hispanicLatino (first option
                // text "Hispanic or Latino" contains "hispanic" alias) — wrong field entirely.
                ethnicity: ['eeoc_race', 'race/ ethnicity', 'race/ethnicity'],
                // Strengthen the other three EEO names too (currently work via global substrings
                // but an explicit alias raises confidence from 0.6 → 1.0)
                gender: ['eeoc_gender'],
                veteranStatus: ['eeoc_veteran_status'],
                disabilityStatus: ['eeoc_disability_status'],
                // Work authorization + sponsorship button groups use varied label phrasing.
                // Both map to workAuthorization so workauth-yn-transform and
                // workauth-sponsor-transform can produce client-specific Yes/No answers.
                workAuthorization: [
                    // Legal authorization variants
                    'legally authorized to work',
                    'currently legally authorized',
                    'authorized to work lawfully',
                    'authorized to work in the united states',
                    'eligible to work in the united states',
                    'work authorization status',
                    // Visa sponsorship variants (workauth-sponsor-transform handles these)
                    'require visa sponsorship',
                    'require sponsorship',
                    'need visa sponsorship',
                    'need sponsorship',
                    'sponsor an immigration',
                    'require ironclad to sponsor',
                    'require to sponsor',
                    'now or in the future, require sponsorship',
                    'in the future, require sponsorship',
                    'will you, now or in the future',
                    'will you now, or in the future',
                    'require an employment visa',
                ],
            };
        }

        async discoverFields() {
            const rules = await super.discoverFields();
            const doc = document;

            // ── Button group detection ────────────────────────────────────────
            // Ashby renders some choice questions as sibling <button> chips instead of
            // <input type="radio"> elements. field-discoverer never sees these because
            // it only scans input/select/textarea tags.
            //
            // Detection strategy (two passes, deduped by fingerprint):
            //
            // Pass A — current Ashby DOM: buttons carry class *_option_* (CSS module hash).
            //   e.g. "_container_pjyt6_1 _option_y2cw4_33"
            //   Group by parent element → each parent = one button group.
            //
            // Pass B — legacy / fallback: containers with ButtonGroup/yesNo class names.
            //   Covers older Ashby builds or any future rename that keeps these keywords.

            const buttonGroupMap = new Map(); // parentEl → [btn, ...]

            // Pass A: option-style buttons (current Ashby class pattern)
            for (const btn of doc.querySelectorAll('button[class*="_option_"]')) {
                if (!btn.textContent?.trim()) continue; // skip empty / toggle buttons
                const p = btn.parentElement;
                if (!p) continue;
                if (!buttonGroupMap.has(p)) buttonGroupMap.set(p, []);
                buttonGroupMap.get(p).push(btn);
            }

            // Pass B: legacy class-name containers
            for (const groupEl of doc.querySelectorAll('[class*="ButtonGroup"], [class*="yesNo"], [class*="yesno"]')) {
                const btns = Array.from(groupEl.querySelectorAll('button'))
                    .filter(b => b.textContent?.trim());
                if (btns.length >= 2 && !buttonGroupMap.has(groupEl)) {
                    buttonGroupMap.set(groupEl, btns);
                }
            }

            // Track fingerprints already produced by super.discoverFields() to avoid duplicates
            const existingFingerprints = new Set(rules.map(r => r.fingerprint));

            for (const [groupEl, buttons] of buttonGroupMap) {
                if (buttons.length < 2) continue;

                // Find the fieldEntry wrapper.
                // Stable class "ashby-application-form-field-entry" is preferred —
                // it never changes between Ashby deploys. CSS-module class [class*="fieldEntry"]
                // is the fallback.
                const container = buttons[0].closest(
                    '.ashby-application-form-field-entry, [class*="fieldEntry"], [class*="FieldEntry"], [class*="question"], [class*="field"]'
                );
                if (!container) continue;

                // Skip if this fieldEntry already has real radio inputs
                // (would be double-counted with rules from super.discoverFields())
                if (container.querySelector('input[type="radio"]')) continue;

                // Extract question label:
                // 1. Explicit label/legend element inside the container
                let label = container.querySelector(
                    'label, legend, [class*="label"]:not(button), [class*="Label"]:not(button)'
                )?.textContent?.trim();

                // 2. First direct child of container that does NOT contain the buttons
                if (!label) {
                    for (const child of container.children) {
                        if (child.contains(buttons[0])) continue; // skip the button subtree
                        const t = child.textContent?.trim();
                        if (t && t.length > 2) { label = t; break; }
                    }
                }

                if (!label) continue;
                // Strip trailing asterisk / required markers
                label = label.replace(/\s*[\*✱]+\s*$/, '').replace(/\s*\(required\)\s*$/i, '').trim();
                if (!label) continue;

                const options = buttons.map(b => b.textContent.trim());
                const fingerprint = window.QuickApplyCache.makeFingerprint(label, 'radio', options);
                if (existingFingerprints.has(fingerprint)) continue; // already in rules
                existingFingerprints.add(fingerprint);

                const required = _ashbyInferRequired(container, label);
                rules.push({
                    label,
                    type: 'radio',
                    required,
                    options,
                    element: buttons[0],
                    elements: buttons,
                    labelElement: null,
                    // Use fingerprint-based selector so filledSelectors dedup treats
                    // each button group independently (all groups share the generic
                    // 'button[class*="_option_"]' CSS selector which would cause
                    // fillAll to skip every button group after the first one).
                    selector: `ashby-btn-group:${fingerprint}`,
                    fingerprint,
                    platform: 'ashby',
                    multiline: false,
                    isButtonGroup: true,
                });
            }

            // Filter out file inputs if CV already uploaded this page load
            if (_cvUploadedThisPageLoad) {
                return rules.filter(r => r.type !== 'file');
            }

            return rules;
        }

        async postFill() {
            _cvUploadedThisPageLoad = true;
            // Wait for Ashby's server-side CV parser to complete and overwrite form fields.
            // 10 s max — Ashby's parse can be slow on large PDFs.
            await waitForDOMSettle(600, 12000);

            // ── Re-fill all fields after CV parse ──
            // Ashby's CV parser rewrites EVERY field (name, email, phone, LinkedIn,
            // work auth, custom questions). The _reAssert in handleCVUpload only fixes
            // name/email/phone. Run a full batch re-fill from cache to restore everything.
            try {
                if (window.QuickApplyFieldDiscoverer &&
                    window.QuickApplyAIResolver &&
                    window.QuickApplyFillEngine) {
                    const _rules = await this.discoverFields();
                    // Pass aiInstance=null — answers come from Tier 2 cache (populated by
                    // the first fill pass). No AI call needed or wanted here.
                    const _answers = await window.QuickApplyAIResolver.resolveBatch(
                        _rules, this.profile, '', this.profile.id || 'default', null
                    );
                    if (_answers.size > 0) {
                        const _skip = this.getQuirks?.().skipFocus ?? false;
                        await window.QuickApplyFillEngine.fillAll(_rules, _answers, {
                            filledSelectors: new Set(),
                            skipFocus: _skip
                        });
                    }
                }
            } catch (_) {}

            // Auto-check required consent/agree checkboxes (e.g. "I consent to receive emails
            // and/or text messages"). These are required for submission and safe to auto-check
            // since recruiters are applying on behalf of clients.
            const CONSENT_RX = /\bconsent\b|\bi agree\b|\bi accept\b/i;
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked) return;
                // Look for consent-related text in the checkbox's label or enclosing group
                const labelText = [
                    cb.getAttribute('aria-label') || '',
                    cb.labels?.[0]?.textContent || '',
                    cb.closest('[role="group"]')?.textContent?.substring(0, 150) || '',
                    cb.closest('[class*="field"], [class*="Field"], [class*="question"]')?.textContent?.substring(0, 150) || ''
                ].join(' ');
                if (CONSENT_RX.test(labelText)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });

            // Auto-select communicationConsent radio buttons.
            // Ashby injects name="communicationConsent" radio groups (SMS opt-in) that the
            // normal fill loop misses — no profile field maps to this name. Always select Yes.
            const radioGroups = new Map();
            document.querySelectorAll('input[type="radio"]').forEach(r => {
                const nm = r.getAttribute('name') || '';
                if (!radioGroups.has(nm)) radioGroups.set(nm, []);
                radioGroups.get(nm).push(r);
            });
            for (const [name, radios] of radioGroups) {
                if (!/consent/i.test(name)) continue;
                if (radios.some(r => r.checked)) continue; // already answered
                for (const radio of radios) {
                    const lbl = radio.id
                        ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)
                        : radio.closest('label');
                    const lblTxt = lbl?.textContent || radio.value || '';
                    if (/\byes\b|\bconsent\b|\bagree\b|\baccept\b/i.test(lblTxt)) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                        radio.dispatchEvent(new Event('input', { bubbles: true }));
                        break;
                    }
                }
            }

            // ── FINAL email/name/phone lock ────────────────────────────────────
            // Ashby's server-side CV parser can fire a SECOND time after our
            // re-fill (when we dispatch input/change events the platform may
            // re-validate and re-parse). Lock profile values into the system
            // fields one more time at the end so user sees client values, not
            // whatever email/name/phone the CV happened to contain.
            const _profile = this.profile || {};
            const _lockField = (selectors, value) => {
                if (!value) return;
                document.querySelectorAll(selectors).forEach(el => {
                    if (el.disabled || el.readOnly) return;
                    if (String(el.value) === String(value)) return;
                    try {
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        setter.call(el, String(value));
                        el.dispatchEvent(new Event('input',  { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur',   { bubbles: true }));
                    } catch (_) {}
                });
            };
            const _fullName = [_profile.firstName, _profile.lastName].filter(Boolean).join(' ');
            _lockField('input[id="_systemfield_name"], input[name="_systemfield_name"]', _fullName);
            _lockField('input[id="_systemfield_email"], input[name="_systemfield_email"], input[type="email"]:not([id*="confirm"]):not([name*="confirm"])', _profile.email);
            _lockField('input[id="_systemfield_phone"], input[name="_systemfield_phone"], input[type="tel"]', _profile.phone);

            // ── Auto-check preferredLocations checkboxes ───────────────────────
            // Ashby JDs often ask "which offices would you consider?" as a
            // multi-select checkbox group. Match each checkbox label against
            // the client's preferredLocations and check the matches.
            const prefLocs = (Array.isArray(_profile.preferredLocations) ? _profile.preferredLocations : [])
                .map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
            if (prefLocs.length) {
                const LOC_ALIASES = {
                    'sf': 'san francisco', 'nyc': 'new york', 'la': 'los angeles', 'dc': 'washington'
                };
                const norm = s => {
                    const lc = String(s || '').trim().toLowerCase();
                    return LOC_ALIASES[lc] || lc;
                };
                const expandedPrefs = prefLocs.flatMap(p => {
                    const n = norm(p);
                    return [n, ...n.split(/[,/]| or | and /).map(s => norm(s.trim())).filter(Boolean)];
                });
                document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    if (cb.checked) return;
                    const label = (cb.getAttribute('name') || cb.getAttribute('aria-label') || '').toLowerCase();
                    if (!label || /^[0-9a-f-]{8}-/i.test(label)) return; // skip hex-id checkboxes
                    const labelTokens = label.split(/[,/]| or | and /).map(s => norm(s.trim())).filter(Boolean);
                    const hit = expandedPrefs.some(p =>
                        labelTokens.some(t => t === p || (p.length > 3 && t.includes(p)) || (t.length > 3 && p.includes(t)))
                    );
                    if (hit) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        cb.dispatchEvent(new Event('input',  { bubbles: true }));
                    }
                });
            }

            try {
                await _ashbyRetryUnfilledRequired(this);
            } catch (_) {}

            // ── Default-answer remaining unfilled Yes/No button groups ──────────
            // Some button groups have no profile field mapping (compensation confirm,
            // essential functions, etc.) and are skipped by the resolver. Apply safe
            // defaults based on label pattern so they don't block form submission.
            await delay(400);
            const _prof = this.profile || {};
            const _willingToRelocate = /yes|true|1/i.test(String(_prof.willingToRelocate || ''));
            // Determine visa sponsorship need from workAuthorization value
            const _waLower = (String(_prof.workAuthorization || '')).toLowerCase();
            const _needsSponsor = /\bh1b?\b|opt\b|stem\s*opt|\bj1\b|\btn\b|e-?3\b|h4\s*ead|\bl1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(_waLower);
            const YES_DEFAULT = /able to perform|can you perform|essential function|i have reviewed|confirm.*compensation|review.*compensation|i confirm|i agree|i accept|consent/i;
            const NO_DEFAULT  = /previously (been )?employed|prior.*employer|formerly employed/i;
            // Legal work authorization: always Yes (H1B, OPT, GC, Citizen — all are authorized)
            const LEGAL_AUTH = /legally authorized|authorized to work|eligible to work|right to work|work authorization/i;
            // Visa sponsorship: Yes if candidate needs sponsorship (H1B/OPT), No otherwise
            const SPONSOR_PAT = /require.*sponsor|need.*sponsor|visa sponsor|sponsor.*immigration|sponsor.*visa|sponsorship/i;
            // Remote work in the US / US residency: Yes (candidate is US-based)
            const _isUSBased = /\b(united states|usa|u\.s\.a?\.?)\b/i.test(String(_prof.city || '') + ' ' + String(_prof.state || '') + ' ' + String(_prof.country || ''));
            const US_REMOTE_PAT = /remote.{0,30}(united states|usa|u\.s\.)|place.{0,15}work.{0,20}(united states|usa|u\.s\.)|work.{0,20}(based|located).{0,20}(united states|usa|u\.s\.)|(united states|usa|u\.s\.).{0,20}(remote|work|based)/i;
            // In-office / commutable / on-site questions: Yes if willing to relocate, else No
            const OFFICE_PATTERN = /tri.?state|commutable|hybrid.*office|in.*office.*days|on.?site|in.*(nyc|new york|san francisco|sf|chicago|austin|seattle|boston|los angeles|la|atlanta|el segundo|denver|miami|dc|washington)/i;
            document.querySelectorAll('.ashby-application-form-field-entry').forEach(entry => {
                const btns = Array.from(entry.querySelectorAll('button[class*="_option_"]'));
                if (btns.length < 2) return;
                // Skip already-answered groups
                if (btns.some(b => _btnAlreadyActive(b))) return;
                const label = entry.querySelector('.ashby-application-form-question-title')?.textContent?.trim() || '';
                let targetText = null;
                if (YES_DEFAULT.test(label))           targetText = 'Yes';
                else if (NO_DEFAULT.test(label))       targetText = 'No';
                else if (LEGAL_AUTH.test(label))       targetText = 'Yes';
                else if (SPONSOR_PAT.test(label))      targetText = _needsSponsor ? 'Yes' : 'No';
                else if (US_REMOTE_PAT.test(label))    targetText = _isUSBased ? 'Yes' : 'No';
                else if (OFFICE_PATTERN.test(label))   targetText = _willingToRelocate ? 'Yes' : 'No';
                if (!targetText) return;
                const targetBtn = btns.find(b => b.textContent.trim() === targetText);
                if (targetBtn) targetBtn.click();
            });

            // ── Default-answer unfilled native radio groups (same patterns as button groups) ──
            // Some Ashby forms (e.g. Sierra) use <input type="radio"> for Yes/No questions
            // instead of button[class*="_option_"] chips. The button-group pass above won't touch
            // these — handle them here with the same label-pattern logic.
            await delay(200);
            const WORK_FROM_PAT = /work.{0,20}from.{0,15}(sf\b|san francisco|new york|nyc|chicago|austin|seattle|boston|los angeles|la\b|atlanta|el segundo|denver|miami|washington|dc\b)|able.{0,20}work.{0,15}(on.?site|in.*(sf\b|san francisco|bay area))/i;
            const AI_CONSENT_PAT = /metaview|ai.*notetaking|notetaking.*tool|transcrib.*interview|record.*interview/i;
            const HEARD_RADIO_PAT = /where did you (first )?hear|how did you hear|how did you learn|first learned about|hear about this (role|position|job|opportunit)/i;
            const _heardRadioPref = ['linkedin', 'social media', 'job board', 'glassdoor', 'indeed', 'referral', 'friend', 'colleague'];
            const _nativeRadioGroups = new Map();
            document.querySelectorAll('input[type="radio"]').forEach(r => {
                const nm = r.getAttribute('name') || '';
                if (!_nativeRadioGroups.has(nm)) _nativeRadioGroups.set(nm, []);
                _nativeRadioGroups.get(nm).push(r);
            });
            for (const [_rName, _radios] of _nativeRadioGroups) {
                if (_radios.some(r => r.checked)) continue; // already answered
                const _rEntry = _radios[0].closest('.ashby-application-form-field-entry, fieldset, [class*="fieldEntry"], [class*="question"]');
                const _rLabel = (_rEntry?.querySelector('.ashby-application-form-question-title, legend, [class*="questionTitle"], [class*="label"]')?.textContent?.trim())
                    || _rName;
                let _rTarget = null; // radio value prefix to match
                if      (LEGAL_AUTH.test(_rLabel))     _rTarget = 'yes';
                else if (SPONSOR_PAT.test(_rLabel))    _rTarget = _needsSponsor ? 'yes' : 'no';
                else if (YES_DEFAULT.test(_rLabel))    _rTarget = 'yes';
                else if (AI_CONSENT_PAT.test(_rLabel)) _rTarget = 'yes';
                else if (NO_DEFAULT.test(_rLabel))     _rTarget = 'no';
                else if (US_REMOTE_PAT.test(_rLabel))  _rTarget = _isUSBased ? 'yes' : 'no';
                else if (WORK_FROM_PAT.test(_rLabel))  _rTarget = _willingToRelocate ? 'yes' : 'no';
                else if (HEARD_RADIO_PAT.test(_rLabel)) {
                    for (const _r of _radios) {
                        const _rl = _r.id ? document.querySelector(`label[for="${CSS.escape(_r.id)}"]`) : _r.closest('label');
                        const _rt = (_rl?.textContent || _r.value || '').toLowerCase();
                        if (_heardRadioPref.some(p => _rt.includes(p))) {
                            _r.checked = true;
                            _r.dispatchEvent(new Event('change', { bubbles: true }));
                            _r.dispatchEvent(new Event('input', { bubbles: true }));
                            break;
                        }
                    }
                    continue;
                }
                if (!_rTarget) continue;
                for (const _r of _radios) {
                    const _rl = _r.id ? document.querySelector(`label[for="${CSS.escape(_r.id)}"]`) : _r.closest('label');
                    const _rt = (_rl?.textContent || _r.value || '').toLowerCase().trim();
                    if (_rt.startsWith(_rTarget)) {
                        _r.checked = true;
                        _r.dispatchEvent(new Event('change', { bubbles: true }));
                        _r.dispatchEvent(new Event('input', { bubbles: true }));
                        break;
                    }
                }
            }

            // ── EEO field filling pass ────────────────────────────────────────────
            // Fills gender, race/ethnicity, veteran status, disability — fields T1 skips
            // (non-text) and T3 misses when Gemini isn't active.
            // Supports both <select> dropdowns (Radiant-style) and checkbox groups (Sierra-style).
            await delay(200);
            const _eeoFields = [
                { key: 'gender',           pat: /\bgender\b/i,            namePat: /eeoc_gender/i },
                { key: 'ethnicity',        pat: /\b(race|ethnicity)\b/i,  namePat: /eeoc_race/i },
                { key: 'veteranStatus',    pat: /\bveteran\b/i,           namePat: /eeoc_veteran/i },
                { key: 'disabilityStatus', pat: /\bdisabilit/i,           namePat: /eeoc_disab/i },
                { key: 'pronouns',         pat: /\bpronoun/i,             namePat: /eeoc_pronoun|pronoun/i },
                { key: 'sexualOrientation',pat: /sexual orientation|lgbtq/i, namePat: /eeoc_sexual|eeoc_orientation/i },
            ];
            function _eeoNorm(s) {
                return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
            }
            function _eeoMatch(profileVal, optionText) {
                const pv = _eeoNorm(profileVal);
                const ot = _eeoNorm(optionText);
                if (!pv || pv.length < 2) return false;
                if (pv === ot) return true;
                // Word-boundary match: avoids "male" matching "female"
                try {
                    if (new RegExp('\\b' + pv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(ot)) return true;
                } catch (_) {}
                // Prefix match (handles "Asian" → "Asian or Asian American")
                if (ot.startsWith(pv)) return true;
                // Phrase-prefix match: first 8 chars (handles "I am not a veteran" → "I am not a protected veteran")
                const pvPrefix = pv.substring(0, Math.min(8, pv.length));
                if (pvPrefix.length >= 5 && ot.startsWith(pvPrefix)) {
                    // Guard: negation must agree
                    const pvNeg = /\bnot\b|\bno\b|\bdon t\b/.test(pv);
                    const otNeg = /\bnot\b|\bno\b|\bdon t\b/.test(ot);
                    if (pvNeg === otNeg) return true;
                }
                return false;
            }
            for (const { key, pat, namePat } of _eeoFields) {
                const profileVal = _prof[key];
                if (!profileVal) continue;
                for (const entry of document.querySelectorAll('.ashby-application-form-field-entry')) {
                    const labelTxt = entry.querySelector('.ashby-application-form-question-title')?.textContent?.trim() || '';
                    const entryNameEl = entry.querySelector('[name]');
                    const entryName = entryNameEl?.getAttribute('name') || '';
                    if (!pat.test(labelTxt) && !namePat.test(entryName)) continue;
                    // Try <select> (Radiant-style)
                    const selEl = entry.querySelector('select');
                    if (selEl) {
                        if (selEl.value && selEl.value !== '') continue; // already filled
                        const opt = Array.from(selEl.options).find(o => _eeoMatch(profileVal, o.text));
                        if (opt) {
                            selEl.value = opt.value;
                            selEl.dispatchEvent(new Event('change', { bubbles: true }));
                            selEl.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        break;
                    }
                    // Try combobox (Ashby custom select)
                    // Bug fix: use fillCombobox engine first (handles React setNativeValue);
                    // previous MouseEvent('mousedown') approach failed on React-controlled dropdowns.
                    const cbxEl = entry.querySelector('[role="combobox"]');
                    if (cbxEl && !cbxEl.value?.trim()) {
                        // Skip if single-value already showing
                        const _sc2 = cbxEl.closest('[class*="select__container"], [class*="select-shell"], [class*="select__control"]');
                        if (_sc2?.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent?.trim()) break;

                        const _engine = window.QuickApplyFillEngine;
                        let _cbxFilled = false;
                        if (_engine?.fillCombobox) {
                            try {
                                const _cbxRule = { element: cbxEl, type: 'combobox', fingerprint: '_ashby_eeo_' + (cbxEl.id || key) };
                                _cbxFilled = await _engine.fillCombobox(_cbxRule, profileVal);
                            } catch (_) {}
                        }
                        if (!_cbxFilled) {
                            // Fallback: open via click and pick from visible options
                            const sc2 = cbxEl.closest('[class*="select__control"]') || cbxEl.closest('[class*="select-shell"]');
                            const tb2 = sc2?.querySelector('button') || sc2 || cbxEl;
                            try { tb2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
                            tb2.click();
                            await delay(350);
                            const optEls2 = Array.from(document.querySelectorAll('[role="option"], [role="listitem"]'))
                                .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                            const chosen2 = optEls2.find(o => _eeoMatch(profileVal, o.textContent.trim()));
                            if (chosen2) { chosen2.click(); await delay(150); }
                            else {
                                try { cbxEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); } catch (_) {}
                            }
                        }
                        break;
                    }
                    // Try checkboxes (Sierra-style: one checkbox per option)
                    const cbEls = Array.from(entry.querySelectorAll('input[type="checkbox"]'));
                    if (cbEls.length > 0) {
                        for (const cb of cbEls) {
                            if (cb.checked) continue;
                            const lbl2 = cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : cb.closest('label');
                            const cbTxt = lbl2?.textContent?.trim() || cb.value || '';
                            if (_eeoMatch(profileVal, cbTxt)) {
                                cb.checked = true;
                                cb.dispatchEvent(new Event('change', { bubbles: true }));
                                cb.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                        }
                        break;
                    }
                    // Try radio buttons (if EEO uses radios and native-radio pass missed them)
                    const rbEls = Array.from(entry.querySelectorAll('input[type="radio"]'));
                    if (rbEls.length > 0 && !rbEls.some(r => r.checked)) {
                        for (const rb of rbEls) {
                            const lbl3 = rb.id ? document.querySelector(`label[for="${CSS.escape(rb.id)}"]`) : rb.closest('label');
                            const rbTxt = lbl3?.textContent?.trim() || rb.value || '';
                            if (_eeoMatch(profileVal, rbTxt)) {
                                rb.checked = true;
                                rb.dispatchEvent(new Event('change', { bubbles: true }));
                                rb.dispatchEvent(new Event('input', { bubbles: true }));
                                break;
                            }
                        }
                        break;
                    }
                }
            }

            // ── Default-answer "Where did you first hear about this role?" combobox ──
            // Ashby's custom combobox doesn't respond to typed filtering — fillCombobox
            // fails because typed options don't appear via standard option selectors.
            // Mirror the _isUnknownCombobox path: open without typing, pick from all options.
            await delay(300);
            const HEARD_ABOUT_PAT = /where did you (first )?hear|first learned about|how did you (learn|hear)|where did you learn|where (you )?(first )?learned|where did you come across|let us know where/i;
            const _heardPref = ((_prof.heardAboutUs || '') + ' LinkedIn').toLowerCase();
            for (const entry of document.querySelectorAll('.ashby-application-form-field-entry')) {
                const labelTxt = entry.querySelector('.ashby-application-form-question-title')?.textContent?.trim() || '';
                if (!HEARD_ABOUT_PAT.test(labelTxt)) continue;
                const comboEl = entry.querySelector('[role="combobox"]');
                if (!comboEl || comboEl.value?.trim()) continue; // skip if already filled
                // Open dropdown without typing to get full option list
                const sc = comboEl.closest('[class*="select__control"]') || comboEl.closest('[class*="select-shell"]');
                const tb = sc?.querySelector('button') || sc || comboEl;
                try { tb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
                tb.click();
                await delay(400);
                // Collect all visible options (Ashby listbox uses [role="option"])
                const optEls = Array.from(document.querySelectorAll('[role="option"], [role="listitem"]'))
                    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                if (!optEls.length) {
                    try { comboEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); } catch (_) {}
                    continue;
                }
                // Pick best match: profile heardAboutUs value or "LinkedIn", else first option
                const chosen = optEls.find(o => _heardPref.split(' ').some(w => w.length > 3 && o.textContent.trim().toLowerCase().includes(w)))
                    || optEls[0];
                chosen.click();
                await delay(200);
            }
        }

        getNextSelectors() { return 'button[type="submit"]'; }
    }

    function waitForDOMSettle(quietMs = 400, timeoutMs = 5000) {
        return new Promise(resolve => {
            let timer;
            const reset = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
            const done = () => { observer.disconnect(); resolve(); };
            const observer = new MutationObserver(reset);
            observer.observe(document.body, { childList: true, subtree: true });
            reset();
            setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
        });
    }

    window.QuickApplyFillerFactory.register('ashby', AshbyFiller);
    window.QuickApplyAshbyFiller = AshbyFiller;
})();
