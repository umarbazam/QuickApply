/**
 * QuickApply — Netflix Careers form filler (explore.jobs.netflix.net).
 *
 * Netflix uses a custom Vue/Vuetify-based application form. Field IDs follow a
 * consistent "{Section}_{field}" convention: Contact_Information_email,
 * Contact_Information_firstname, Contact_Information_lastname,
 * Contact_Information_phone, Contact_Information_city,
 * Additional_Documents_candidate_portfolio_url, etc.
 *
 * The dropdown selects (country code, country/state) are Vuetify autocompletes
 * with placeholder="Select" and IDs like input-5, input-8 — these need their
 * "menu" item clicked rather than a value typed.
 */
(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    class NetflixFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'netflix'; }

        getFieldAliases() {
            return {
                email:        ['contact_information_email'],
                firstName:    ['contact_information_firstname'],
                lastName:     ['contact_information_lastname'],
                phone:        ['contact_information_phone'],
                city:         ['contact_information_city'],
                state:        ['contact_information_state'],
                country:      ['contact_information_country'],
                streetAddress:['contact_information_address'],
                zipCode:      ['contact_information_zipcode', 'contact_information_zip'],
                linkedIn:     ['additional_documents_candidate_portfolio_url',
                               'additional_documents_linkedin_url'],
                portfolio:    ['additional_documents_portfolio_url',
                               'additional_documents_candidate_portfolio_url'],
                github:       ['additional_documents_github_url']
            };
        }

        async postFill() {
            // ── Lock Contact_Information_* fields ─────────────────────────────
            // Netflix's React form sometimes wipes inputs with
            // autocomplete="one-time-code" (City uses this — likely an
            // anti-autofill measure). Force-set profile values once more
            // with the native setter so the lock survives re-renders.
            const profile = this.profile || {};
            const lock = (selectors, value) => {
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
            lock('#Contact_Information_email,    [data-test-id="Contact_Information_email"]',     profile.email);
            lock('#Contact_Information_firstname,[data-test-id="Contact_Information_firstname"]', profile.firstName);
            lock('#Contact_Information_lastname, [data-test-id="Contact_Information_lastname"]',  profile.lastName);
            lock('#Contact_Information_phone,    [data-test-id="Contact_Information_phone"]',     profile.phone);
            lock('#Contact_Information_city,     [data-test-id="Contact_Information_city"]',      profile.city);
            lock('[data-test-id="Additional_Documents_candidate_portfolio_url"]', profile.linkedIn || profile.portfolio);

            // ── Vuetify autocomplete dropdowns (country code, country, state) ──
            // These have placeholder="Select" or "Select country code" and IDs
            // like input-5, input-8. Their value is committed only when the
            // user clicks an option from the dropdown menu, not when text is
            // typed. Map by the visible label that sits above the input.
            await this._commitVuetifyAutocomplete('Country code', this._countryCallingCode());
            await this._commitVuetifyAutocomplete('Country', this.profile?.country);
            await this._commitVuetifyAutocomplete('State', this.profile?.state);
            await this._commitVuetifyAutocomplete('Province', this.profile?.state);
            await this._commitVuetifyAutocomplete('Region', this.profile?.state);

            // Generic consent / terms / privacy checkboxes
            const CONSENT_RX = /\bi\s+(agree|accept|consent)\b|\bterms\b|\bprivacy\s*(policy|notice)\b|\bgdpr\b/i;
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (cb.checked) return;
                // Skip OneTrust cookie-banner checkboxes
                if (/^ot-/i.test(cb.id || cb.name || '')) return;
                const labelText = [
                    cb.getAttribute('aria-label') || '',
                    cb.labels?.[0]?.textContent || '',
                    cb.closest('label, [class*="checkbox" i], [class*="field" i]')?.textContent?.slice(0, 200) || ''
                ].join(' ');
                if (CONSENT_RX.test(labelText)) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('input',  { bubbles: true }));
                }
            });
        }

        /**
         * Locate a Vuetify autocomplete input by its visible label, focus + type,
         * wait for the .v-list-item options to appear, and click the best match.
         */
        async _commitVuetifyAutocomplete(labelText, value) {
            if (!value) return;
            // Find the input whose preceding label matches `labelText`
            const labels = Array.from(document.querySelectorAll('label, .v-label'));
            const target = labels.find(l => {
                const t = (l.innerText || l.textContent || '').trim();
                return new RegExp(`^${labelText}\\s*\\*?$`, 'i').test(t)
                    || new RegExp(`\\b${labelText}\\b`, 'i').test(t);
            });
            if (!target) return;
            // Vuetify pattern: label sits above the input inside a .v-input
            // wrapper. The input itself has placeholder="Select" or similar.
            const wrapper = target.closest('.v-input') || target.parentElement?.parentElement;
            const input = wrapper?.querySelector('input[type="text"], input:not([type])');
            if (!input) return;
            if (input.value && input.value.trim().toLowerCase() === String(value).trim().toLowerCase()) return;

            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            // Clear + type
            input.focus();
            setter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await delay(120);
            for (const c of String(value)) {
                setter.call(input, input.value + c);
                input.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }));
                await delay(50);
            }

            // Wait for the menu to render. Vuetify renders options as
            // .v-list-item / .v-menu__content > .v-list-item--link
            let options = [];
            for (let i = 0; i < 25; i++) {
                options = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-overlay-container .v-list-item, [role="listbox"] [role="option"]'))
                    .filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
                if (options.length) break;
                await delay(120);
            }
            if (!options.length) return;

            // Best-match scoring: exact > startsWith > contains
            const want = String(value).trim().toLowerCase();
            const score = (text) => {
                const lc = String(text || '').trim().toLowerCase();
                if (lc === want) return 100;
                if (lc.startsWith(want)) return 50;
                if (lc.includes(want)) return 25;
                return 0;
            };
            options.sort((a, b) => score(b.innerText || b.textContent) - score(a.innerText || a.textContent));
            const choice = options[0];
            if (score(choice.innerText || choice.textContent) === 0) return;

            ['mousedown', 'mouseup', 'click'].forEach(t => {
                choice.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
            });
            await delay(200);
        }

        /**
         * Derive the country calling code from the profile (e.g. "+1" for US).
         */
        _countryCallingCode() {
            const c = String(this.profile?.country || '').toLowerCase();
            const map = {
                'united states': '+1', 'usa': '+1', 'us': '+1',
                'canada': '+1', 'united kingdom': '+44', 'uk': '+44', 'gb': '+44',
                'india': '+91', 'pakistan': '+92', 'germany': '+49', 'france': '+33',
                'japan': '+81', 'china': '+86', 'australia': '+61', 'mexico': '+52',
                'brazil': '+55', 'spain': '+34', 'italy': '+39'
            };
            for (const key of Object.keys(map)) {
                if (c.includes(key)) return map[key];
            }
            return null;
        }

        getNextSelectors() {
            // Submit button on Netflix's apply form
            return 'button[type="submit"], [class*="submit" i] button';
        }
    }

    window.QuickApplyFillerFactory.register('netflix', NetflixFiller);
    window.QuickApplyNetflixFiller = NetflixFiller;
})();
