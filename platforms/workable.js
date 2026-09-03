(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Read the human-readable question text for a given form element.
    // Workable custom fields (QA_/CA_) often have opaque name= attributes;
    // the visible question lives in a labeled span or a parent container.
    function _workableQuestionText(el) {
        // 1. Explicit aria-labelledby on the element
        const lby = el.getAttribute('aria-labelledby');
        if (lby) {
            const t = lby.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').replace(/^\*\s*/, '').trim();
            if (t.length > 5) return t;
        }
        // 2. Workable naming convention: <fieldName>_label element
        if (el.name) {
            const labeled = document.getElementById(el.name + '_label');
            if (labeled) {
                const t = (labeled.innerText || '').replace(/^\*\s*/, '').trim();
                if (t.length > 5) return t;
            }
        }
        // 3. Walk up ancestors looking for a compact question string
        let cur = el.parentElement;
        for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
            const raw = (cur.innerText || '').trim();
            const t = raw.replace(/^\*\s*\n?/, '').trim();
            if (t.length > 10 && t.length < 300) return t;
        }
        return '';
    }

    class WorkableFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'workable'; }

        // React 15 focus guard — never dispatch focus on Workable fields
        getQuirks() { return { skipFocus: true }; }

        async discoverFields() {
            const rules = await super.discoverFields();

            const enriched = rules.filter(rule => {
                if (rule.element.getAttribute('aria-hidden') === 'true') return false;
                const ancestor = rule.element.closest('[aria-hidden="true"]');
                if (ancestor) return false;
                return true;
            });

            // Enrich opaque QA_/CA_ labels with the actual question text so the
            // AI resolver can map them to profile fields instead of skipping them.
            //
            // Workable renders each custom question as TWO elements:
            //   1. visible input[role="combobox"][name=""]   — what the user types into
            //   2. hidden input[aria-hidden="true"][name="QA_xxx"]  — backing store
            //
            // The field-discoverer picks up the COMBOBOX (not the hidden input) with
            // a fallback label of "SVGs not supported by this browser." (from the SVG
            // icon in the label DOM). We look for the sibling hidden backing input and
            // use its parent container to read the actual question text.
            for (const rule of enriched) {
                const el = rule.element;
                const lbl = rule.label || '';

                // Case A: field-discoverer name-fallback label e.g. "CA 29872" or "QA 11964272"
                if (/^(CA|QA)\s+\d+$/i.test(lbl) || /^(CA|QA)_\d+$/i.test(lbl)) {
                    const q = _workableQuestionText(el);
                    if (q && q.length > 5) rule.label = q.replace(/^\*\s*/, '').trim();
                    continue;
                }

                // Case B: visible combobox proxy — find sibling hidden QA_/CA_ input.
                // The combobox has no name attribute (getAttribute returns null).
                // The hidden backing input is ~4 levels up in the DOM tree, so we
                // walk up to 8 ancestors looking for a container that holds it.
                if (el.getAttribute('role') === 'combobox' && !el.getAttribute('name')) {
                    let container = el.parentElement;
                    let hiddenBacking = null;
                    for (let lvl = 0; lvl < 8 && container && !hiddenBacking; lvl++, container = container.parentElement) {
                        hiddenBacking =
                            container.querySelector('input[aria-hidden="true"][name^="QA_"]') ||
                            container.querySelector('input[aria-hidden="true"][name^="CA_"]');
                    }
                    if (hiddenBacking) {
                        const q = _workableQuestionText(hiddenBacking);
                        let baseLabel = q && q.length > 5 ? q.replace(/^\*\s*/, '').trim() : '';

                        // For select-style (readonly) comboboxes the options are not discoverable
                        // from the DOM until the dropdown is opened. Briefly open + read + close
                        // so the AI sees the real option texts and can return one verbatim.
                        if (el.getAttribute('aria-autocomplete') === 'none' || el.getAttribute('readonly')) {
                            let opts = [];
                            try {
                                const listboxId = `input_${hiddenBacking.name}_listbox`;
                                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                el.click();
                                await delay(200);
                                const listbox = document.getElementById(listboxId)
                                    || document.querySelector('[role="listbox"]');
                                if (listbox) {
                                    opts = [...listbox.querySelectorAll('[role="option"]')]
                                        .map(o => o.textContent.trim()).filter(Boolean);
                                }
                                // Close the dropdown
                                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                                await delay(50);
                            } catch (_) {}

                            if (opts.length > 0 && baseLabel) {
                                rule.label = baseLabel + ' (Options: ' + opts.join(' / ') + ')';
                            } else if (baseLabel) {
                                rule.label = baseLabel;
                            }
                        } else if (baseLabel) {
                            rule.label = baseLabel;
                        }
                    }
                }
            }

            return enriched;
        }

        async postFill() {
            // Workable encodes custom Yes/No questions as radio groups named
            // QA_<numericId>. The label/legend isn't on the input — it lives
            // on the enclosing .styles--3aPac container as the first text
            // line. Map the question to a default answer and click the
            // appropriate radio.
            const profile = this.profile || {};

            const waLower = String(profile.workAuthorization || '').toLowerCase();
            const needsSponsor = /\bh1b?\b|\bopt\b|stem\s*opt|\bj1\b|\btn\b|e-?3\b|h4\s*ead|\bl1\b|require.{0,4}sponsor|need.{0,4}sponsor/i.test(waLower);
            const willingRelocate = /yes|true|1/i.test(String(profile.willingToRelocate || ''));

            const PATTERNS = [
                { rx: /minimum\s+age|are\s+you\s+(?:at\s+least\s+)?\d{2}\s*\+?\s*(?:years?\s+(?:of\s+age|old))?|do\s+you\s+meet\s+this\s+requirement.*age/i, answer: 'yes' },
                { rx: /(legally\s+)?authoriz(ed|ation)\s+to\s+work|right\s+to\s+work|eligible\s+to\s+work/i, answer: 'yes' },
                { rx: /(require|need).{0,30}sponsor|visa\s+sponsor|sponsorship\s+for\s+employment/i, answer: needsSponsor ? 'yes' : 'no' },
                { rx: /reside\s+in|currently\s+(?:live|located)\s+in|based\s+in\s+the\s+(?:us|united\s+states|continental)/i, answer: 'yes' },
                { rx: /background\s+check|drug\s+(screen|test)|criminal\s+history/i, answer: 'yes' },
                { rx: /commute|onsite|on-?site|in.{0,8}office|in.{0,8}person|relocat/i, answer: willingRelocate ? 'yes' : 'no' },
                { rx: /\bi\s+agree\b|\bi\s+consent\b|\bi\s+accept\b|terms\s+and\s+conditions|privacy\s+policy/i, answer: 'yes' },
                { rx: /worked\s+at\s+|previously\s+(been\s+)?employed|former\s+employee/i, answer: 'no' },
                { rx: /at\s+least\s+\d+\s+years?\s+of\s+experience|\d+\+\s*years?\s+of\s+experience/i, answer: 'yes' },
                // Skills-style questions: "Do you have ...", "Have you ...", "Are you familiar with ...",
                // "Are you experienced ...", "Are you proficient ..." default to YES — we're applying
                // for the role, the natural answer is that the candidate has the listed skill.
                // If the user disagrees they can correct it; correction storage will retrain.
                { rx: /\b(do|have|are)\s+you\s+(have|familiar|experienced|proficient|comfortable|able|capable|skilled|good|fluent)\b/i, answer: 'yes' },
                { rx: /\bproven\s+(track\s+record|experience|ability)/i, answer: 'yes' },
                { rx: /\b(experience|track\s+record)\s+(in|with|of|growing|building|managing|leading)/i, answer: 'yes' }
            ];

            // Resolve the question text from a fieldset's aria-labelledby reference,
            // falling back to the parent-walking heuristic. The aria-labelledby path
            // is reliable: the fieldset literally points at the label element. The
            // fallback handles older Workable variants without aria-labelledby.
            function _questionText(radio) {
                const fs = radio.closest('fieldset[role="radiogroup"]');
                const labelledby = fs?.getAttribute('aria-labelledby');
                if (labelledby) {
                    const target = document.getElementById(labelledby);
                    if (target) {
                        const t = (target.innerText || target.textContent || '').trim();
                        if (t) return t.replace(/^\*\s*/, '').replace(/\s*\*$/, '').trim();
                    }
                }
                // Fallback: walk up looking for first ancestor whose innerText
                // is a reasonable question (30-600 chars after stripping
                // YES/NO suffix and SVG fallback noise).
                let cur = radio.parentElement;
                for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
                    const raw = (cur.innerText || '').trim();
                    const t = raw
                        .replace(/SVGs not supported by this browser\.?/gi, '')
                        .replace(/\s*YES\s*\n?\s*NO\s*$/i, '')
                        .replace(/^\*\s*\n?/, '')
                        .trim();
                    if (t.length > 30 && t.length < 600) return t;
                }
                return '';
            }

            // Group radios by name — covers both QA_* (standard) and CA_* (custom) radio fields
            const groups = new Map();
            document.querySelectorAll('input[type="radio"][name^="QA_"], input[type="radio"][name^="CA_"]').forEach(r => {
                const n = r.name;
                if (!groups.has(n)) groups.set(n, []);
                groups.get(n).push(r);
            });

            for (const [, radios] of groups) {
                if (radios.some(r => r.checked)) continue; // already answered
                const first = radios[0];
                const questionText = _questionText(first);
                if (!questionText) continue;

                let answer = null;
                for (const p of PATTERNS) {
                    if (p.rx.test(questionText)) { answer = p.answer; break; }
                }
                if (!answer) continue;

                // Click the matching radio. QA_* radios use value="true"/"false";
                // CA_* radios use numeric option IDs. Fall back to parent <label>
                // text ("Yes"/"No") for any radio with an opaque numeric value.
                const target = radios.find(r => {
                    const parentLbl = (r.closest('label')?.innerText || '').trim().toLowerCase();
                    if (answer === 'yes') return r.value === 'true' || /yes|true|1/i.test(r.value) || parentLbl === 'yes';
                    if (answer === 'no')  return r.value === 'false' || /no|false|0/i.test(r.value) || parentLbl === 'no';
                    return false;
                });
                if (target) {
                    // Click order matters on the React 15 Workable UI: the
                    // VISIBLE control is the wrapper div with role="radio"
                    // (id="wrapper_<inputId>"); the inner <input> is
                    // aria-hidden and not pointer-targetable. Clicking the
                    // wrapper updates React state. Native input check + events
                    // are still set as a belt-and-suspenders fallback for form
                    // submission validators that read input.checked.
                    const wrapper = document.getElementById('wrapper_' + target.id)
                        || target.closest('[role="radio"]')
                        || target.closest('[data-ui="option"]');
                    if (wrapper) {
                        try { wrapper.click(); } catch (_) {}
                    }
                    // Also click the wrapping <label> (Workable labels wrap the
                    // input rather than using for=...). Some validators only
                    // accept the input-via-label click.
                    const parentLabel = target.closest('label');
                    if (parentLabel && parentLabel !== wrapper) {
                        try { parentLabel.click(); } catch (_) {}
                    }
                    if (!target.checked) {
                        target.checked = true;
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                        target.dispatchEvent(new Event('input',  { bubbles: true }));
                    }
                }
            }

            // Generic consent/agree checkboxes (privacy, terms, etc.)
            const CONSENT_RX = /\bi\s+(agree|accept|consent)\b|\bterms\b|\bprivacy\b|\bgdpr\b|process.{0,10}data/i;
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked) return;
                const labelText = [
                    cb.getAttribute('aria-label') || '',
                    cb.labels?.[0]?.textContent || '',
                    cb.closest('[class*="field"], [class*="question"], label')?.textContent?.slice(0, 200) || ''
                ].join(' ');
                if (CONSENT_RX.test(labelText)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('input',  { bubbles: true }));
                }
            });

            // ── Workable multi-select checkbox groups ──
            // Workable renders skill/tool "check all that apply" questions as
            // div[role="group"] containers with div[role="checkbox"] wrappers.
            // The actual <input type="checkbox"> inside is aria-hidden — clicking
            // it doesn't update React state. We must click the div[role="checkbox"].
            // Option text lives in #checkbox_label_<wrapperID>.
            // We match options against the profile text corpus to select relevant ones.
            const profileCorpus = [
                profile.skills || '',
                profile.summary || '',
                ...(Array.isArray(profile.workHistory) ? profile.workHistory.flatMap(j => [j.title || '', j.description || '']) : []),
                profile.coverLetter || '',
            ].join(' ').toLowerCase();

            const cbGroupEls = document.querySelectorAll('[role="group"]');
            for (const grp of cbGroupEls) {
                const wrappers = grp.querySelectorAll('[role="checkbox"]');
                if (!wrappers.length) continue;
                // Skip if already answered
                if ([...wrappers].some(w => w.getAttribute('aria-checked') === 'true')) continue;

                const options = [];
                for (const w of wrappers) {
                    const wLbyIds = (w.getAttribute('aria-labelledby') || '').split(/\s+/);
                    const cbLabelId = wLbyIds.find(id => id.startsWith('checkbox_label_'));
                    const text = (cbLabelId ? document.getElementById(cbLabelId)?.innerText : null) || w.getAttribute('aria-label') || '';
                    if (text.trim()) options.push({ el: w, text: text.trim() });
                }
                if (!options.length) continue;

                // Match against profile corpus — skip "None"/"None of these" fallback options
                const toCheck = profileCorpus.length > 10
                    ? options.filter(o => {
                        if (/^none/i.test(o.text)) return false;
                        const keywords = o.text.toLowerCase().replace(/[()]/g, '').split(/[\s,\/\-]+/).filter(w => w.length > 3);
                        return keywords.some(kw => profileCorpus.includes(kw));
                    })
                    : [];

                for (const opt of toCheck) {
                    try { opt.el.click(); } catch (_) {}
                    await delay(80);
                }
            }
        }

        getNextSelectors() { return 'button[type="submit"]'; }
    }

    window.QuickApplyFillerFactory.register('workable', WorkableFiller);
    window.QuickApplyWorkableFiller = WorkableFiller;
})();
