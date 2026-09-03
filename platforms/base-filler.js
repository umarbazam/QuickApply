/**
 * QuickApply BaseFiller — base class for all platform-specific fillers.
 * Subclasses override preFill(), discoverFields(), postFill() as needed.
 */
(function () {
    'use strict';

    class BaseFiller {
        constructor(profile, settings) {
            this.profile = profile;
            this.settings = settings;
        }

        /** Run before field discovery — expand sections, wait for SPA render */
        async preFill() {}

        /** Discover all fillable fields on the current form */
        async discoverFields() {
            const platform = this.getSiteLabel();
            return window.QuickApplyFieldDiscoverer.scan(document, platform);
        }

        /** Run after filling — save entries, re-fill overwritten fields */
        async postFill() {}

        /** Platform identifier string — matches _getPlatform() return values */
        getSiteLabel() { return 'generic'; }

        /**
         * Per-platform value map overrides.
         * Return an object keyed by profileField, each value being a synonyms map
         * matching the shape of VALUES_MAP in field-mapper.js.
         * Merged ON TOP of global VALUES_MAP — only describe what's different.
         * @returns {Object}
         */
        getValueOverrides() { return {}; }

        /**
         * Per-platform field alias extensions.
         * Return an object keyed by profileField (e.g. 'firstName'), each value
         * being an array of additional alias strings to match.
         * Merged into FIELD_MAPPINGS at match time.
         * @returns {Object}
         */
        getFieldAliases() { return {}; }

        /**
         * Per-platform quirk flags.
         * Replaces the old get skipFocus() property.
         * Known flags: { skipFocus: bool, usesSelect2: bool }
         * @returns {Object}
         */
        getQuirks() { return {}; }

        /** CSS selector for Next/Continue/Submit buttons on this platform */
        getNextSelectors() {
            return 'button[type="submit"], input[type="submit"]';
        }
    }

    /**
     * PlatformFillerFactory — creates the correct filler for the current platform.
     * Accepts the resolved platform string from content.js _getPlatform().
     * content.js remains sole owner of _getPlatform() — factory never reads window.location.
     */
    class PlatformFillerFactory {
        static create(platform, profile, settings) {
            const map = window._qaFillerClassMap || {};
            const Cls = map[platform];
            if (Cls) return new Cls(profile, settings);
            // Fall back to GenericFiller (registered by platforms/generic.js).
            // BaseFiller is the last-resort fallback if generic.js failed to load.
            return new (map['generic'] || BaseFiller)(profile, settings);
        }

        /** Called by each platform module to register its filler class */
        static register(platform, cls) {
            window._qaFillerClassMap = window._qaFillerClassMap || {};
            window._qaFillerClassMap[platform] = cls;
        }
    }

    window.QuickApplyBaseFiller = BaseFiller;
    window.QuickApplyFillerFactory = PlatformFillerFactory;
})();
