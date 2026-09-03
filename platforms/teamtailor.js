/**
 * QuickApply — Teamtailor application form filler.
 *
 * Teamtailor (`{tenant}.teamtailor.com`, plus white-label custom domains) is a
 * Rails + Stimulus + Turbo career site. Three things need platform handling:
 *
 *  1. The form does not exist on page load. It lives in a lazily-loaded
 *     `<turbo-frame id="application_form">` that only fetches
 *     `/jobs/{id}/applications/new` when the candidate clicks
 *     "Apply for this job" — so preFill() clicks that button and waits for
 *     `#job-application-form` to appear in the same document.
 *
 *  2. Field names are Rails-nested — `candidate[first_name]`,
 *     `candidate[location][query]`,
 *     `candidate[job_applications_attributes][0][cover_letter]`. field-mapper
 *     strips brackets before matching, so the aliases below are the
 *     bracket-free forms.
 *
 *  3. "Address" is a Places-style autocomplete: typing alone leaves
 *     `candidate[location][place_id]` / `[city]` / `[state]` / `[country]`
 *     empty and the address is discarded server-side. postFill() types the
 *     profile address, picks the best suggestion, and confirms the hidden
 *     fields were populated (same shape as the Lever location commit).
 *
 * Screening questions need no special handling: Teamtailor renders free-text
 * answers with a real `<label for>` and choice/boolean answers as
 * `<fieldset><legend>`, both of which the generic discoverer already reads.
 * The one wrinkle is the visually-hidden "Required" marker inside those
 * labels, which the discoverer's legend path glues onto the question text —
 * discoverFields() below recomputes those labels without the marker.
 */
(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    const FORM_SEL = '#job-application-form';
    // The overlay trigger; the duplicate floating button starts out [disabled].
    const TRIGGER_SEL = '[data-action*="form-overlay#showFormOverlay"]:not([disabled])';
    const LOCATION_SEL = '#candidate_location, input[name="candidate[location][query]"]';

    class TeamtailorFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'teamtailor'; }

        getFieldAliases() {
            // Bracket-free forms of the Rails field names (field-mapper strips
            // [ ] before alias matching), plus the DOM ids where they differ.
            return {
                firstName:     ['candidatefirst_name', 'candidate_first_name'],
                lastName:      ['candidatelast_name', 'candidate_last_name'],
                email:         ['candidateemail', 'candidate_email'],
                phone:         ['candidatephone', 'candidate_phone'],
                streetAddress: ['candidatelocationquery', 'candidate_location'],
                coverLetter:   [
                    'candidatejob_applications_attributes0cover_letter',
                    'candidate_job_applications_attributes_0_cover_letter'
                ],
            };
        }

        async preFill() {
            // Wait for the careersite to render either the form (standalone
            // /applications/new page) or the apply trigger (job page).
            const start = Date.now();
            while (Date.now() - start < 5000) {
                if (document.querySelector(FORM_SEL) || _trigger()) break;
                await delay(200);
            }

            if (!document.querySelector(FORM_SEL)) {
                const trigger = _trigger();
                if (trigger) {
                    trigger.click();
                    // Turbo has to fetch the frame over the network before any
                    // field exists — give it up to 12 s on a cold cache.
                    const t0 = Date.now();
                    while (Date.now() - t0 < 12000) {
                        if (document.querySelector(FORM_SEL)) break;
                        await delay(250);
                    }
                }
            }

            // Let the frame's Stimulus controllers boot (phone-input builds the
            // country picker, forms--inputs--upload swaps in the Dropzone input).
            if (document.querySelector(FORM_SEL)) await delay(500);
        }

        async discoverFields() {
            let rules = await super.discoverFields();

            // Career sites also ship a "Connect / job alerts" email form in the
            // footer (name="full_email"). Once the application form is open it
            // is the only thing worth filling on the page.
            if (document.querySelector(FORM_SEL)) {
                rules = rules.filter(r => r.element?.closest(FORM_SEL));
            }

            // Teamtailor marks required fields with `<sup>*</sup>` plus a
            // visually-hidden `<span class="sr-only">Required</span>`. The
            // discoverer's label[for] path takes the first text node and is
            // unaffected, but its fieldset/legend path uses textContent, so
            // every choice/boolean question label comes back as
            // "…work visa in Sweden?Required". Recompute from the label node
            // with the markers stripped.
            for (const rule of rules) {
                const node = _labelNodeFor(rule);
                if (node) {
                    const clean = _cleanTeamtailorLabel(node);
                    if (clean && clean !== rule.label) rule.label = clean;
                }
                // Question blocks carry their own mandatory flag; a radio
                // group's asterisk lives in the legend, not in the per-option
                // label that isRequired() inspects.
                if (!rule.required &&
                    rule.element?.closest('.question[data-question-mandatory="true"]')) {
                    rule.required = true;
                }
            }

            return rules;
        }

        async postFill() {
            // The CV goes to S3 through Dropzone; Teamtailor dims and disables
            // the form while an upload is in flight, so wait for it to land
            // before driving the address autocomplete.
            await _waitForUpload();
            await this._commitLocationAutocomplete();
            _tickConsent();
            await _requestPassForRevealedQuestions();
        }

        /**
         * Type the profile address into the Places-style autocomplete and pick
         * the closest suggestion, so the hidden place_id / city / state /
         * country / lat / long inputs the server actually reads get populated.
         */
        async _commitLocationAutocomplete() {
            const input = document.querySelector(LOCATION_SEL);
            if (!input || input.disabled) return;

            // Already committed (either by the candidate or by an earlier pass).
            const placeId = document.querySelector('input[name="candidate[location][place_id]"]');
            if (placeId && placeId.value) return;

            const p = this.profile || {};
            const street = [p.streetAddress, p.city, p.state].filter(Boolean);
            const cityLevel = [p.city, p.state, p.country].filter(Boolean);
            const queries = [];
            if (street.length >= 2) queries.push(street.join(', '));
            if (cityLevel.length) queries.push(cityLevel.join(', '));
            if (!queries.length) return;

            const wrap = input.closest('[data-controller~="forms--inputs--location"]') || input.parentElement;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

            for (const query of queries) {
                setter.call(input, '');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await delay(120);
                input.focus();

                // Type char-by-char — the controller fetches suggestions off
                // debounced input events, so a single value assignment yields
                // an empty listbox.
                for (const c of query.slice(0, 80)) {
                    setter.call(input, input.value + c);
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }));
                    await delay(55);
                }

                const option = await _waitForSuggestion(wrap, query);
                if (!option) continue;

                ['mousedown', 'mouseup', 'click'].forEach(type => {
                    option.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });

                // selectSuggestion fetches place details before writing the
                // hidden inputs — confirm one of them actually landed.
                for (let i = 0; i < 20; i++) {
                    if (placeId?.value) return;
                    await delay(150);
                }
                if (placeId?.value) return;
            }
        }

        getNextSelectors() {
            return '#job-application-form input[type="submit"], #job-application-form button[type="submit"]';
        }
    }

    /**
     * Answering a screening question can reveal a follow-up question that was
     * already in the DOM behind a `hidden` wrapper class (`data-question-show-if-*`).
     * No nodes are added, so the content script's MutationObserver never fires
     * and the revealed question — often mandatory — stays blank. Ask for one
     * extra fill pass instead.
     */
    async function _requestPassForRevealedQuestions() {
        for (let i = 0; i < 8; i++) {
            if (_unansweredMandatoryQuestion()) break;
            await delay(300);
        }
        if (!_unansweredMandatoryQuestion()) return;
        window.QuickApplyRequestRefill?.('teamtailor: conditional question revealed');
    }

    /** A visible, mandatory question block with no answer yet. */
    function _unansweredMandatoryQuestion() {
        for (const q of document.querySelectorAll('.question[data-question-mandatory="true"]')) {
            const fields = [...q.querySelectorAll('input, textarea, select')]
                .filter(el => el.type !== 'hidden');
            if (!fields.length) continue;
            if (!fields.some(el => el.getBoundingClientRect().height > 0)) continue; // still collapsed
            const answered = fields.some(el => (el.type === 'radio' || el.type === 'checkbox')
                ? el.checked
                : String(el.value || '').trim() !== '');
            if (!answered) return q;
        }
        return null;
    }

    /**
     * Tick the privacy-policy acknowledgement. Tenants with GDPR consent
     * enabled render `candidate[consent_given]` as a real checkbox and block
     * submission until it is ticked (tenants without it ship the same field as
     * a hidden input already set to 1). Scoped to that one field by name —
     * every other checkbox on the form is an employer question and is left to
     * the normal matching/AI path.
     */
    function _tickConsent() {
        const cb = document.querySelector('input[type="checkbox"][name="candidate[consent_given]"]');
        if (!cb || cb.checked || cb.disabled) return;
        cb.click();
        if (!cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event('input', { bubbles: true }));
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    /** Visible, enabled "Apply for this job" overlay trigger. */
    function _trigger() {
        for (const el of document.querySelectorAll(TRIGGER_SEL)) {
            if (!el.disabled && el.getBoundingClientRect().height > 0) return el;
        }
        return null;
    }

    /** The <label>/<legend> element a discovered rule's question text comes from. */
    function _labelNodeFor(rule) {
        const el = rule.element;
        if (!el) return null;
        // Radio groups: the question is the fieldset legend. The element's own
        // label[for] holds only its option text ("Yes"), so it must not win here.
        if ((el.type || '').toLowerCase() === 'radio') {
            const fs = el.closest('fieldset, [role="group"]');
            return fs ? fs.querySelector(':scope > legend') : null;
        }
        if (rule.labelElement) return rule.labelElement;
        if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) return lbl;
        }
        return null;
    }

    function _cleanTeamtailorLabel(node) {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('.sr-only, [data-asterisk], sup').forEach(el => el.remove());
        return (clone.textContent || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*\*\s*$/, '')
            .trim();
    }

    /**
     * Resolve once every Dropzone preview on the form has finished uploading
     * (or errored). Returns immediately when nothing is uploading.
     */
    async function _waitForUpload(maxMs = 20000) {
        const pending = () => Array.from(document.querySelectorAll('.dz-preview'))
            .filter(el => !el.classList.contains('dz-success')
                       && !el.classList.contains('dz-complete')
                       && !el.classList.contains('dz-error'));
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            if (!pending().length) return;
            await delay(300);
        }
    }

    /** Best-matching suggestion in the location listbox, or null. */
    async function _waitForSuggestion(wrap, query) {
        if (!wrap) return null;
        const wantTokens = query.toLowerCase().split(/[\s,]+/).filter(t => t.length > 1);
        for (let i = 0; i < 24; i++) {
            const options = Array.from(wrap.querySelectorAll('[role="option"]'))
                .filter(el => el.getBoundingClientRect().height > 0);
            if (options.length) {
                const score = el => {
                    const text = (el.getAttribute('data-description') || el.textContent || '').toLowerCase();
                    return wantTokens.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
                };
                options.sort((a, b) => score(b) - score(a));
                return options[0];
            }
            await delay(150);
        }
        return null;
    }

    window.QuickApplyFillerFactory.register('teamtailor', TeamtailorFiller);
    window.QuickApplyTeamtailorFiller = TeamtailorFiller;
})();
