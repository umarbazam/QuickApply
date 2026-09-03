/**
 * QuickApply Field Discoverer — scans a form and returns FieldRule[]
 * Each FieldRule has: label, type, required, options, element, selector, fingerprint, platform
 */
(function () {
    'use strict';

    const FIELD_LIMIT = 500;

    const FIELD_TYPES = {
        TEXT: 'text', DATE: 'date', SELECT: 'select',
        RADIO: 'radio', CHECKBOX: 'checkbox', COMBOBOX: 'combobox', FILE: 'file'
    };

    // ── Label Extraction ──────────────────────────────────────────────────────

    /** Clean a raw label string: strip required markers, normalize whitespace */
    function cleanLabel(raw) {
        if (!raw) return '';
        const cleaned = raw
            .replace(/\s*\(required\)\s*/gi, '')
            .replace(/\s*\(optional\)\s*/gi, '')
            .replace(/\s*\*\s*$/, '')
            .replace(/\*/g, '');
        // First NON-EMPTY line, not literally the first line. Pretty-printed
        // server-rendered markup (Teamtailor legends, its choice/boolean option
        // labels) puts a newline right after the opening tag, so `split('\n')[0]`
        // returned "" and the field was dropped for having no label at all.
        return cleaned.split('\n').map(s => s.trim()).find(Boolean) || '';
    }

    /** Clean label from a cloned DOM node (removes required-marker child elements) */
    function cleanLabelNode(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll(
            '.requiredField, .labelRequiredIcon, span[class*="required"], span.asterisk, .asterisk'
        ).forEach(el => el.remove());
        // Prefer first text node
        const textNode = Array.from(clone.childNodes).find(
            n => n.nodeType === Node.TEXT_NODE && n.nodeValue?.trim()
        );
        const raw = textNode ? textNode.nodeValue : (clone.textContent || '');
        return cleanLabel(raw);
    }

    /** Humanize a data-automation-id value into a readable label */
    function humanizeAutomationId(id) {
        if (!id) return '';
        // Known exact mappings
        if (id.includes('startDate') || id.endsWith('-start')) return 'Start Date';
        if (id.includes('endDate')   || id.endsWith('-end'))   return 'End Date';
        // Strip known prefixes
        let s = id.replace(/^(info|public-site-|pageField-|field-)/, '');
        // camelCase → spaces
        s = s.replace(/([A-Z])/g, ' $1');
        // kebab/snake → spaces
        s = s.replace(/[-_]/g, ' ');
        return s.replace(/\s+/g, ' ').trim();
    }

    /**
     * Extract human-readable label for a form element.
     * 9-strategy chain — first non-empty result wins.
     */
    function getLabel(element, doc) {
        const id = element.id;

        // Strategy 1: label[for=id]
        if (id) {
            const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) {
                const span = lbl.querySelector('[data-automation-id*="-label-span"]');
                if (span) return cleanLabel(span.textContent);
                return cleanLabelNode(lbl);
            }
        }

        // Strategy 2: data-automation-id humanization
        const autoId = element.getAttribute('data-automation-id');
        if (autoId) {
            const h = humanizeAutomationId(autoId);
            if (h) return h;
        }

        // Strategy 3: previous sibling label/legend
        const sib = element.previousElementSibling;
        if (sib) {
            const tag = sib.tagName;
            if (tag === 'LABEL' || tag === 'LEGEND') {
                const text = cleanLabelNode(sib);
                if (text) return text;
            }
        }

        // Strategy 4: closest .form-group > label
        const fg = element.closest('.form-group, .form-field, .field-wrapper');
        if (fg) {
            const lbl = fg.querySelector(':scope > label');
            if (lbl) { const t = cleanLabelNode(lbl); if (t) return t; }
        }

        // Strategy 5: wrapping label ancestor
        const wrapLabel = element.closest('label');
        if (wrapLabel) {
            const span = wrapLabel.querySelector('[data-automation-id*="-label-span"]');
            if (span) return cleanLabel(span.textContent);
            return cleanLabelNode(wrapLabel);
        }

        // Strategy 6: XPath — iCIMS labelText, Workday tc_formLabel (platform-specific div/p labels)
        const xpathContainer = element.closest(
            '[class*="labelText"],[class*="tc_formLabel"],[class*="field-container"],[class*="fieldWrapper"],[class*="form-row"]'
        );
        if (xpathContainer) {
            const xpathExprs = [
                './/div[contains(@class,"labelText")]',
                './/div[contains(@class,"datasetlabelText")]',
                './/div[contains(@class,"tc_formLabel")]',
                './/p[contains(@class,"tc_formLabel")]',
                './/span[contains(@class,"tc_formTitle")]',
                './/label[contains(@class,"Label")]'
            ];
            for (const xpath of xpathExprs) {
                try {
                    const result = doc.evaluate(xpath, xpathContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const node = result.singleNodeValue;
                    if (node && node !== element) { const t = cleanLabel(node.textContent); if (t) return t; }
                } catch (_) {}
            }
        }

        // Strategy 7: parent's label child
        const parentLabel = element.parentElement?.querySelector('label');
        if (parentLabel) { const t = cleanLabelNode(parentLabel); if (t) return t; }

        // Strategy 8: aria-label / aria-labelledby
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel?.trim()) return cleanLabel(ariaLabel);
        const ariaLabelledBy = element.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
            const target = doc.getElementById(ariaLabelledBy);
            if (target) { const t = cleanLabel(target.textContent); if (t) return t; }
        }

        // Strategy 9: placeholder as last resort
        const ph = element.getAttribute('placeholder');
        if (ph) {
            return cleanLabel(ph.replace(/^(enter|type|search|provide)\s+(your\s+)?/i, ''));
        }

        // Strategy 10: shadow host chain. SmartRecruiters spl-* components store
        // the visible label as a 'label' (or 'aria-label') attribute on the host
        // element; Oracle JET <oj-*> components (Oracle HCM Cloud / iadyup.fa.ocs
        // .oraclecloud.com/hcmUI) use 'label-hint' for the same purpose. The
        // actual <input> lives 2-3 shadow levels deep with no associated label in
        // the DOM, so we walk up the shadow host chain looking for either form.
        let shadowHost = element.getRootNode()?.host;
        while (shadowHost) {
            const hostLabel = shadowHost.getAttribute('label')
                || shadowHost.getAttribute('aria-label')
                || shadowHost.getAttribute('label-hint');   // Oracle JET
            if (hostLabel?.trim().length > 2) return cleanLabel(hostLabel);
            shadowHost = shadowHost.getRootNode()?.host;
        }

        // Strategy 11: <oj-label> sibling / ancestor (Oracle HCM Cloud). The
        // label-hint pattern above is the common case, but some Oracle Recruiting
        // forms keep the visible text inside a separate <oj-label> element next
        // to the input's host. The host's id is referenced by oj-label's `for`.
        const ojHost = element.closest('oj-input-text, oj-input-number, oj-input-date, oj-input-date-time, oj-input-time, oj-input-password, oj-text-area, oj-select-single, oj-select-multiple, oj-combobox-one, oj-combobox-many, oj-checkboxset, oj-radioset, oj-input-file');
        if (ojHost) {
            // direct attr on the OJ host
            const hint = ojHost.getAttribute('label-hint') || ojHost.getAttribute('aria-label');
            if (hint?.trim().length > 2) return cleanLabel(hint);
            // <oj-label for="<ojHost.id>">
            if (ojHost.id) {
                const ojLbl = doc.querySelector(`oj-label[for="${CSS.escape(ojHost.id)}"]`);
                if (ojLbl) { const t = cleanLabel(ojLbl.textContent); if (t) return t; }
            }
            // immediate previous-sibling <oj-label>
            const prevOjLbl = ojHost.previousElementSibling;
            if (prevOjLbl && prevOjLbl.tagName?.toLowerCase() === 'oj-label') {
                const t = cleanLabel(prevOjLbl.textContent);
                if (t) return t;
            }
        }

        return '';
    }

    // ── Field Type Detection ─────────────────────────────────────────────────

    function getFieldType(element) {
        const tag = element.tagName.toLowerCase();
        const type = (element.type || '').toLowerCase();
        if (tag === 'select') return FIELD_TYPES.SELECT;
        if (tag === 'textarea') return FIELD_TYPES.TEXT;
        if (element.getAttribute('role') === 'combobox' || element.getAttribute('role') === 'listbox') return FIELD_TYPES.COMBOBOX;
        if (type === 'radio') return FIELD_TYPES.RADIO;
        if (type === 'checkbox') return FIELD_TYPES.CHECKBOX;
        if (type === 'file') return FIELD_TYPES.FILE;
        if (type === 'date' || type === 'month' || type === 'week' || type === 'datetime-local') return FIELD_TYPES.DATE;
        // Detect inputs inside React-Select / custom dropdown wrappers that don't set role="combobox"
        if (tag === 'input' && (
            element.closest('[class*="select__control"]') ||
            element.closest('[class*="select-container"]') ||
            element.closest('[class*="dropdown__control"]') ||
            element.closest('[class*="select-shell"]')
        )) return FIELD_TYPES.COMBOBOX;
        return FIELD_TYPES.TEXT;
    }

    // ── Visibility Check ─────────────────────────────────────────────────────

    function isVisible(element) {
        // getBoundingClientRect works in shadow DOM; offsetParent does not
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
    }

    // ── CSS Selector ─────────────────────────────────────────────────────────

    function getSelector(element) {
        try {
            if (element.id) return '#' + CSS.escape(element.id);
            if (element.name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(element.name)}"]`;
            const autoId = element.getAttribute('data-automation-id');
            if (autoId) return `[data-automation-id="${CSS.escape(autoId)}"]`;
            // Unique positional path. A bare `tag:nth-child(N)` is NOT unique:
            // document.querySelector() returns the first match anywhere (wrong element
            // for SCROLL_TO_FIELD), and the fillAll dedup (filledSelectors) collapses
            // distinct fields that share it — silently skipping the second one. Walk up
            // to the nearest id-bearing ancestor (or root), emitting tag:nth-child(n)
            // at each level, so the path resolves to exactly this element.
            const parts = [];
            let el = element;
            while (el && el.nodeType === 1) {
                if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
                const parent = el.parentElement;
                if (!parent) { parts.unshift(el.tagName.toLowerCase()); break; }
                const idx = Array.prototype.indexOf.call(parent.children, el) + 1;
                parts.unshift(`${el.tagName.toLowerCase()}:nth-child(${idx})`);
                el = parent;
            }
            return parts.join(' > ');
        } catch (_) { return ''; }
    }

    // ── Required Detection ───────────────────────────────────────────────────

    function isRequired(element, labelElement) {
        if (element.required) return true;
        if (element.getAttribute('aria-required') === 'true') return true;
        if (labelElement?.querySelector('.requiredField, .labelRequiredIcon, [class*="required"]')) return true;
        const label = labelElement?.textContent || '';
        if (/\*/.test(label)) return true;
        return false;
    }

    // ── Options Extraction ───────────────────────────────────────────────────

    function getOptions(element, type) {
        if (type === FIELD_TYPES.SELECT) {
            return Array.from(element.options)
                .filter(o => !o.disabled && o.value !== '' && o.text.trim() !== '')
                .map(o => o.text.trim());
        }
        if (type === FIELD_TYPES.RADIO) {
            // Handled in groupRadios — returns options array from label texts
            return [];
        }
        if (type === FIELD_TYPES.COMBOBOX) {
            const doc = element.ownerDocument || document;
            // Collect options from the listbox ASSOCIATED WITH THIS combobox only.
            // A global `document.querySelector('[role="listbox"]')` grabbed whatever
            // listbox happened to be first/open in the page — on Greenhouse that is the
            // phone country-picker (Afghanistan+93, …), so EVERY combobox (Yes/No,
            // Gender, Veteran Status…) was handed the country list and the AI answered
            // "Canada+1" to all of them. react-select renders a combobox's options only
            // while its menu is open, so for closed menus we return [] and let the AI
            // answer free-text (fillCombobox matches against the real options on open).
            let listbox = null;
            const ownsId = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
            if (ownsId) { try { listbox = doc.getElementById(ownsId); } catch (_) {} }
            if (!listbox) {
                const wrap = element.closest('[class*="select__control"], [class*="select-shell"], [class*="select__"], [role="combobox"]')
                    || element.parentElement;
                listbox = wrap ? wrap.querySelector('[role="listbox"]') : null;
            }
            if (listbox) {
                return Array.from(listbox.querySelectorAll('[role="option"]'))
                    .map(o => o.textContent.trim())
                    .filter(Boolean);
            }
        }
        return [];
    }

    // ── Radio Grouping ───────────────────────────────────────────────────────

    /**
     * Extract the question label for a radio group.
     * Tries fieldset/group context first (e.g. Ashby where the question is a sibling div,
     * not a legend), then falls back to getLabel on the first radio element.
     */
    function getRadioGroupLabel(members, doc) {
        const first = members[0];
        // 1. Closest fieldset or role=group — look for legend or first non-radio child
        const fieldset = first.closest('fieldset, [role="group"]');
        if (fieldset) {
            const legend = fieldset.querySelector(':scope > legend');
            if (legend) { const t = cleanLabel(legend.textContent); if (t) return t; }
            // Ashby pattern: first child div contains the question text, not radio inputs
            for (const child of fieldset.children) {
                if (!child.querySelector('input[type="radio"]') && child.textContent?.trim()) {
                    const t = cleanLabel(child.textContent);
                    if (t) return t;
                }
            }
        }
        // 2. Fall back to label of first radio (option text — less ideal but usable)
        return getLabel(first, doc);
    }

    /** Group radio inputs by name into a single FieldRule each */
    function groupRadios(radios, doc) {
        const groups = new Map();
        for (const radio of radios) {
            const name = radio.name || radio.id || String(Math.random());
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(radio);
        }
        const rules = [];
        for (const [, members] of groups) {
            const first = members[0];
            const label = getRadioGroupLabel(members, doc) || (members[1] ? getLabel(members[1], doc) : '') || '';
            if (!label) continue;
            const options = members.map(r => {
                const lbl = getLabel(r, doc);
                return lbl || r.value || '';
            }).filter(Boolean);
            const labelElement = first.id
                ? doc.querySelector(`label[for="${CSS.escape(first.id)}"]`) || null
                : null;
            rules.push({
                label,
                type: FIELD_TYPES.RADIO,
                required: isRequired(first, labelElement),
                options,
                element: first,
                elements: members,  // all radio inputs in this group
                labelElement,
                selector: getSelector(first),
                fingerprint: window.QuickApplyCache?.makeFingerprint(label, FIELD_TYPES.RADIO, options) ?? '',
                platform: '',
                multiline: false,
            });
        }
        return rules;
    }

    // ── Skip Guards ──────────────────────────────────────────────────────────

    function shouldSkip(element) {
        const type = (element.type || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type)) return true;
        // Skip aria-hidden fields and their children (Workable address)
        if (element.getAttribute('aria-hidden') === 'true') return true;
        if (element.closest('[aria-hidden="true"]')) return true;
        // Skip intl-tel-input INTERNAL pieces (country picker dropdown, listbox,
        // search input, flag container), but NOT the phone tel-input itself.
        // Newer versions of intl-tel-input tag the phone <input> with class
        // .iti__tel-input — the previous broad `[class*="iti__"]` filter then
        // silently dropped the entire phone field from discovery. The actual
        // phone input is kept; only the country-picker internals are skipped.
        const itiHit = element.closest('[class*="iti__"]');
        if (itiHit && !element.closest('input.iti__tel-input, input[type="tel"]')) return true;
        // Skip react-select v5's hidden `requiredInput` proxy. react-select
        // injects an empty <input> with class matching `*requiredInput*` so
        // HTML5 form validation blocks submission when no option is selected;
        // it has no id/name/label of its own. Discovering it caused every
        // combobox on a Greenhouse form to collapse onto a single fingerprint
        // ("" type=text), which made the batch AI resolver overwrite all
        // answers with the LAST resolved value (country/phone bleed). The
        // real fillable target is the sibling `<input role="combobox">`.
        if (element.tagName === 'INPUT' && /requiredinput/i.test(element.className || '')
            && element.getAttribute('role') !== 'combobox') return true;
        if (!isVisible(element)) return true;
        return false;
    }

    // ── Core Scanner ─────────────────────────────────────────────────────────

    /**
     * Recursively scan a document/element for form fields.
     * Handles shadow DOM and same-origin iframes.
     */
    function scan(root, platform = '') {
        const rules = [];
        const seenElements = new WeakSet();
        const seenSelectors = new Set();
        const seenShadowRoots = new WeakSet();
        const radiosToGroup = [];

        function processElement(element, doc) {
            if (rules.length >= FIELD_LIMIT) return;
            if (seenElements.has(element)) return;

            // Recurse into shadow DOM
            if (element.shadowRoot && !seenShadowRoots.has(element.shadowRoot)) {
                seenShadowRoots.add(element.shadowRoot);
                scanDoc(element.shadowRoot, doc);
            }

            if (shouldSkip(element)) return;

            const tag = element.tagName?.toLowerCase();
            if (!['input', 'select', 'textarea'].includes(tag) &&
                !['combobox', 'listbox'].includes(element.getAttribute('role') || '')) {
                return;
            }

            const type = getFieldType(element);

            // Radio: collect for grouping
            if (type === FIELD_TYPES.RADIO) {
                radiosToGroup.push(element);
                seenElements.add(element);
                return;
            }

            let label = getLabel(element, doc);
            if (!label) {
                // Synthesize from data-automation-id → name → id rather than silently dropping
                // the field. Workday fields often have a label only inside a sibling shadow root
                // that the 9-strategy chain can't reach — the automation ID is the next best thing.
                const autoId = element.getAttribute('data-automation-id');
                if (autoId) label = humanizeAutomationId(autoId);
                if (!label && element.name) label = element.name.replace(/[-_]/g, ' ').replace(/([A-Z])/g, ' $1').trim();
                if (!label && element.id)   label = element.id.replace(/[-_]/g, ' ').replace(/([A-Z])/g, ' $1').trim();
            }
            if (!label) return;  // truly unlabeled — nothing to match against

            const sel = getSelector(element);
            if (seenSelectors.has(sel)) return;

            const labelElement = doc.querySelector(`label[for="${CSS.escape(element.id)}"]`) || null;
            const options = getOptions(element, type);
            const fingerprint = window.QuickApplyCache?.makeFingerprint(label, type, options) ?? '';

            rules.push({
                label,
                type,
                required: isRequired(element, labelElement),
                options,
                element,
                labelElement,
                selector: sel,
                fingerprint,
                platform,
                multiline: tag === 'textarea',
            });

            seenElements.add(element);
            if (sel) seenSelectors.add(sel);
        }

        function scanDoc(docRoot, parentDoc) {
            const doc = docRoot.ownerDocument || docRoot;

            // Standard inputs
            const inputs = docRoot.querySelectorAll(
                'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),' +
                'select, textarea, [role="combobox"], [role="listbox"]'
            );
            for (const el of inputs) processElement(el, doc);

            // Recurse into shadow roots of all elements
            const allEls = docRoot.querySelectorAll('*');
            for (const el of allEls) {
                if (el.shadowRoot && !seenShadowRoots.has(el.shadowRoot)) {
                    seenShadowRoots.add(el.shadowRoot);
                    scanDoc(el.shadowRoot, doc);
                }
            }

            // Recurse into same-origin iframes
            const iframes = docRoot.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iDoc = iframe.contentDocument;
                    if (iDoc) scanDoc(iDoc, iDoc);
                } catch (_) { /* cross-origin — skip */ }
            }
        }

        scanDoc(root, root.ownerDocument || root);

        // Group radio inputs
        const radioRules = groupRadios(radiosToGroup, root.ownerDocument || root);
        rules.push(...radioRules);

        // Fingerprint collision guard: when two or more rules share the same fingerprint
        // in one batch (e.g. all Lever "Type your response" text inputs), the resolver
        // would answer only ONE and apply it to all — filling every custom question with
        // the same value. Re-fingerprint collisions with a selector-based hash so each
        // gets its own AI call while non-colliding fingerprints stay shareable across
        // postings (cache still hits for truly identical questions on different URLs).
        const _fpCount = new Map();
        for (const r of rules) _fpCount.set(r.fingerprint, (_fpCount.get(r.fingerprint) || 0) + 1);
        const _seenCollision = new Map(); // fingerprint → collision index
        for (const r of rules) {
            if ((_fpCount.get(r.fingerprint) || 0) > 1) {
                const idx = (_seenCollision.get(r.fingerprint) || 0) + 1;
                _seenCollision.set(r.fingerprint, idx);
                // Re-fingerprint with element selector so each field is individually resolved.
                r.fingerprint = window.QuickApplyCache?.makeFingerprint(
                    r.label + '\x00' + (r.selector || String(idx)), r.type, r.options
                ) ?? r.fingerprint + '_' + idx;
            }
        }

        return rules;
    }

    window.QuickApplyFieldDiscoverer = { scan, FIELD_LIMIT, FIELD_TYPES };
})();
