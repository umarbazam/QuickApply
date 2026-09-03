/**
 * QuickApply AI Resolver — Tiered field answer resolution
 * Tier 1: profile direct (field-mapper.js aliases, no AI)
 * Tier 2: fingerprint cache (L1 memory + L2 chrome.storage)
 * Tier 3: Gemini batch call
 *
 * Returns: Map<fingerprint, answer>
 */
(function () {
    'use strict';

    /**
     * Resolve answers for all discovered field rules.
     * @param {FieldRule[]} rules - from field-discoverer.js
     * @param {object} profile - client profile
     * @param {string} resumeText - extracted CV text
     * @param {string} clientId - for cache key isolation
     * @param {object} aiInstance - window.QuickApplyAI instance
     * @returns {Map<fingerprint, string|string[]>}
     */
    async function resolveBatch(rules, profile, resumeText, clientId, aiInstance, jobContext = {}, options = {}, filler = null) {
        const answers = new Map();  // fingerprint → answer
        const cache = window.QuickApplyCache;
        const mapper = window.QuickApplyFieldMapper;

        // A bare 32-hex string or UUID is a platform-internal option id (Workday
        // "How did you hear" / Country / State, Greenhouse EEO ids), never a real
        // answer. Such values get into customFields/cache when a fill is wrongly
        // learned as a correction. Treat them as "no answer" so the field falls
        // through to AI (which returns the human-readable text, e.g. "LinkedIn").
        const _isOpaqueId = v => {
            const s = String(v == null ? '' : v).trim();
            return /^[0-9a-f]{32}$/i.test(s) ||
                   /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
        };

        // Identity fields are unambiguous and must ALWAYS come straight from the
        // profile — sending them to Gemini wastes latency and risks an embarrassing
        // wrong name/email/phone. Used to protect them even under forceAI.
        const IDENTITY_FIELDS = new Set([
            'firstName', 'lastName', 'fullName', 'middleName', 'preferredName',
            'email', 'confirmEmail', 'alternateEmail',
            'phone', 'linkedIn', 'portfolio', 'github'
        ]);

        // ── Force-AI short-circuit ────────────────────────────────────────────
        // When the user enables "Always use AI" in settings, send ambiguous fields
        // straight to Gemini — bypassing cache and any wrong profile mappings — at
        // the cost of API tokens + latency. EXCEPTION: identity fields (name/email/
        // phone/links) are still resolved deterministically from the profile. Before
        // this, forceAI sent EVERY field to Gemini on EVERY fill, which made repeat
        // fills slow (no cache short-circuit) and let the AI guess identity values.
        if (options.forceAI && aiInstance) {
            // Resolve identity fields from the profile first.
            for (const rule of rules) {
                if (rule.type === 'file') continue;
                if (rule.type !== 'text' && rule.type !== 'date') continue;
                try {
                    const match = mapper.identifyField(
                        rule.element, profile.customFields || [], rule.label, filler
                    );
                    if (match && !match.isCustom && IDENTITY_FIELDS.has(match.profileField)) {
                        const profileValue = profile[match.profileField];
                        if (profileValue != null && String(profileValue).trim() !== '') {
                            answers.set(rule.fingerprint, String(profileValue));
                            rule._profileField = match.profileField;
                        }
                    }
                } catch (_) {}
            }

            // Everything still unresolved goes to Gemini.
            const _allRules = rules.filter(r => r.type !== 'file' && !answers.has(r.fingerprint));
            if (_allRules.length > 0) {
                try {
                    const _results = await aiInstance.callGeminiBatch(_allRules, profile, resumeText, jobContext);
                    const _platform = rules[0]?.platform || '';
                    for (const { fingerprint, answer } of _results) {
                        if (answer === '' || answer == null) continue;
                        answers.set(fingerprint, answer);
                        const _r = _allRules.find(r => r.fingerprint === fingerprint);
                        if (_r) {
                            const _key = clientId + ':' + fingerprint;
                            await cache.set(_key, answer, _platform);
                        }
                    }
                } catch (err) {
                    console.warn('[QuickApply AIResolver] Force-AI batch failed:', err.message);
                }
            }
            return answers;
        }

        // ── Tier 1: Profile Direct ────────────────────────────────────────────
        // identifyField returns { profileField, confidence } but never sets .value.
        // For TEXT-type fields, the raw profile value is the correct answer (name, email,
        // phone, URL, address, etc.). Skip radio/select/combobox — those need VALUES_MAP
        // transformation or AI option-picking handled by T2/T3.

        for (const rule of rules) {
            if (rule.type === 'file') continue;
            if (rule.type !== 'text' && rule.type !== 'date') continue; // T1 for plain text only

            try {
                const match = mapper.identifyField(
                    rule.element,
                    profile.customFields || [],
                    rule.label,
                    filler
                );
                if (match && match.profileField) {
                    const profileValue = match.isCustom
                        ? match.customValue
                        : profile[match.profileField];
                    if (profileValue != null && String(profileValue).trim() !== '' && !_isOpaqueId(profileValue)) {
                        answers.set(rule.fingerprint, String(profileValue));
                        // Stash the profileField on the rule so the caller (content.js batch
                        // path) can feed real mapping data to QuickApplyLearning.registerField.
                        // T2 (cache) and T3 (AI) hits leave this undefined — those entries are
                        // skipped by the registry update because their profileField is unknown.
                        rule._profileField = match.profileField;
                    }
                }
            } catch (_) {}
        }

        // ── Tier 2: Fingerprint Cache ─────────────────────────────────────────
        const unresolved = rules.filter(r => !answers.has(r.fingerprint) && r.type !== 'file');

        for (const rule of unresolved) {
            const cacheKey = clientId + ':' + rule.fingerprint;
            const cached = await cache.get(cacheKey);
            if (cached !== null && cached !== undefined && !_isOpaqueId(cached)) {
                answers.set(rule.fingerprint, cached);
            }
        }

        // Catch-all: drop any opaque option-id (Workday hex / UUID) that slipped
        // through T1/T2 via any rule path, so the field is re-resolved by AI below
        // instead of feeding a garbage id to the filler (which can't match it to a
        // visible option and leaves the required field blank).
        for (const [fp, val] of answers) { if (_isOpaqueId(val)) answers.delete(fp); }

        // ── Tier 3: Gemini Batch ──────────────────────────────────────────────
        const batchRules = rules.filter(r => !answers.has(r.fingerprint) && r.type !== 'file');

        if (batchRules.length > 0 && aiInstance) {
            try {
                const batchResults = await aiInstance.callGeminiBatch(batchRules, profile, resumeText, jobContext);
                const platform = rules[0]?.platform || '';

                for (const { fingerprint, answer } of batchResults) {
                    if (answer === '' || answer == null) continue;
                    answers.set(fingerprint, answer);
                    // Write to cache
                    const rule = batchRules.find(r => r.fingerprint === fingerprint);
                    if (rule) {
                        const cacheKey = clientId + ':' + fingerprint;
                        await cache.set(cacheKey, answer, platform);
                    }
                }
            } catch (err) {
                console.warn('[QuickApply AIResolver] Batch call failed, using Tier 1+2 only:', err.message);
            }
        }

        return answers;
    }

    window.QuickApplyAIResolver = { resolveBatch };
})();
