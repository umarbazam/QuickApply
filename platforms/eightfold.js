/**
 * QuickApply — Eightfold.ai Careers form filler.
 *
 * Eightfold's application form uses accessible custom widgets (real
 * role="combobox" + aria-controls listboxes, standard <input type="file">)
 * that the generic field-discoverer/fill-engine already handle. Field IDs
 * follow a "{Section}_{field}" convention — Contact_Information_firstname,
 * Contact_Information_lastname, Contact_Information_email,
 * Contact_Information_phone, Preliminary_Questions_middleName,
 * Preliminary_Questions_address1/2, Preliminary_Questions_city,
 * Preliminary_Questions_zip — all of which already contain the generic
 * aliases in field-mapper.js (firstname, lastname, email, phone, middlename,
 * address1, address2, city, zip), so no extra aliasing is needed.
 *
 * The one field the generic engine can't identify: a text input under
 * "Applicant's Acknowledgement and Electronic Signature" that acts as an
 * e-signature (type your full name to sign, label reads "I accept"). It
 * carries no name attribute and no [type] attribute either — only a
 * data-test-id containing "esigABSignature" — so it's handled here.
 */
(function () {
    'use strict';

    class EightfoldFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'eightfold'; }

        async postFill() {
            const profile = this.profile || {};
            const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
            if (!fullName) return;

            let field = document.querySelector('input[data-test-id*="esig" i], input[data-test-id*="signature" i]');
            if (!field) {
                const labels = Array.from(document.querySelectorAll('div, span, label'));
                const signatureLabel = labels.find(el => /^i accept$/i.test((el.textContent || '').trim()));
                field = signatureLabel?.querySelector('input, textarea') || null;
            }
            if (!field || field.value.trim()) return;

            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(field, fullName);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
        }
    }

    window.QuickApplyFillerFactory.register('eightfold', EightfoldFiller);
    window.QuickApplyEightfoldFiller = EightfoldFiller;
})();
