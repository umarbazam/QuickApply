/**
 * GenericFiller — fallback for unrecognised ATS platforms.
 * Full field discovery, standard fill, no special handling.
 */
(function () {
    'use strict';

    class GenericFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'generic'; }

        getNextSelectors() {
            return [
                'button[type="submit"]',
                'input[type="submit"]',
                'button',
                '[role="button"]'
            ].join(', ');
        }
    }

    window.QuickApplyFillerFactory.register('generic', GenericFiller);
    window.QuickApplyGenericFiller = GenericFiller;
})();
