/**
 * QuickApply — JdExtractor: picks the right platform adapter and writes to JdCache.
 */
(function () {
    'use strict';

    function _adapter() {
        // Order matters: more specific hosts first. Workday and host-locked
        // adapters before Greenhouse (Greenhouse also detects via #grnhse_app
        // markers on wrapper sites and would otherwise win on a wrapper page
        // that happens to embed two providers).
        const adapters = [
            window.QuickApplyWorkdayJD,
            window.QuickApplyAshbyJD,
            window.QuickApplyRipplingJD,
            window.QuickApplyWorkableJD,
            window.QuickApplySmartRecruitersJD,
            window.QuickApplyBreezyJD,
            window.QuickApplyLeverJD,
            window.QuickApplyNetflixJD,
            window.QuickApplyGemJD,
            window.QuickApplyGreenhouseJD,
            window.QuickApplyIcimsJD,
            window.QuickApplyTikTokJD,
            window.QuickApplySuccessFactorsJD,
            window.QuickApplyUltiProJD,
            window.QuickApplyDayforceJD,
            window.QuickApplyEightfoldJD,
            window.QuickApplyTeamtailorJD
        ];
        for (const a of adapters) {
            try { if (a && a.detect && a.detect()) return a; } catch (_) {}
        }
        return null;
    }

    function _dispatch(jd) {
        if (!jd || !jd.jobKey) return;
        try {
            document.dispatchEvent(new CustomEvent('quickapply:jd-extracted', {
                detail: { jobKey: jd.jobKey, title: jd.title, company: jd.company, platform: jd.platform }
            }));
        } catch (_) { /* CustomEvent constructor unavailable on ancient pages → ignore */ }
    }

    /** Returns the JdObject that was cached, or null. */
    async function extract() {
        const adapter = _adapter();
        if (!adapter) return null;
        let jd;
        try { jd = adapter.extract(); } catch (e) { return null; }
        if (!jd || !jd.jobKey) return null;

        const existing = await window.QuickApplyJdCache.get(jd.jobKey);
        if (!existing) {
            await window.QuickApplyJdCache.put(jd);
            _dispatch(jd);
            return jd;
        }

        // Per-field merge so each structured field takes whichever side has
        // real data. Handles three races:
        //   - Apply page extracts thin (no body) → keep JD-page body
        //   - Wrapper-iframe race: iframe + parent both run; merge picks richer
        //   - Late-hydration: an early extract captured body but not location/
        //     employment; today's re-extract fills them in even when the body
        //     length is identical
        //
        // For text fields (title, location, body, etc.) "richer" means longer:
        // a wrapper page's document.title fallback like "Job" must not clobber
        // the iframe's "Senior Machine Learning Engineer" when both are truthy.
        const pickLonger = (a, b) => {
            const sa = a == null ? '' : String(a);
            const sb = b == null ? '' : String(b);
            if (!sa.trim()) return b;
            if (!sb.trim()) return a;
            return sa.length >= sb.length ? a : b;
        };
        const badLocation = (v) => {
            const s = String(v || '').replace(/\s+/g, ' ').trim();
            return s.length > 180
                || /\b(Products|Industries|Resources|Support|Privacy Policy|Terms|Login|Get a Demo|Contact)\b/i.test(s);
        };
        const pickLocation = (a, b) => {
            if (badLocation(a) && !badLocation(b)) return b;
            if (badLocation(b) && !badLocation(a)) return a;
            return pickLonger(a, b);
        };
        const hasExplicitContract = (text) => {
            const cleaned = String(text || '').toLowerCase()
                .replace(/\bcontractors?\b/g, '')
                .replace(/\bcontracts\b/g, '');
            return /\b(contract|contract[- ]based|contract role|contract position|fixed[- ]term|temporary)\b/.test(cleaned);
        };
        const pickEmploymentType = (fresh, old, freshText, oldText) => {
            if (!fresh && old === 'Contract' && String(freshText || '').length > String(oldText || '').length) return null;
            if (old === 'Contract' && !hasExplicitContract(oldText)) return fresh || null;
            if (fresh === 'Contract' && !hasExplicitContract(freshText)) return old || null;
            return pickLonger(fresh, old);
        };
        const pickAny = (a, b) => (a != null ? a : b);
        const newFlags = jd.locationFlags || {};
        const oldFlags = existing.locationFlags || {};
        const newHasFlag = newFlags.isRemote || newFlags.isHybrid || newFlags.isOnsite;
        const merged = {
            ...jd,
            title: pickLonger(jd.title, existing.title),
            company: pickLonger(jd.company, existing.company),
            location: pickLocation(jd.location, existing.location),
            locationFlags: newHasFlag ? newFlags : (oldFlags.isRemote || oldFlags.isHybrid || oldFlags.isOnsite ? oldFlags : newFlags),
            employmentType: pickEmploymentType(jd.employmentType, existing.employmentType, jd.descriptionText, existing.descriptionText),
            requiredYoE: jd.requiredYoE?.min != null ? jd.requiredYoE :
                         (existing.requiredYoE?.min != null ? existing.requiredYoE : jd.requiredYoE),
            salaryRange: pickAny(jd.salaryRange, existing.salaryRange),
            visaText: pickLonger(jd.visaText, existing.visaText),
            descriptionText: (jd.descriptionText?.length || 0) >= (existing.descriptionText?.length || 0)
                ? jd.descriptionText : existing.descriptionText,
            fitScores: existing.fitScores  // preserve AI verdicts across re-extractions
        };
        await window.QuickApplyJdCache.put(merged);
        _dispatch(merged);
        return merged;
    }

    /** Hook called from content.js. Idempotent — safe to call repeatedly. */
    let _lastUrl = '';
    async function maybeExtract() {
        if (location.href === _lastUrl) return null;
        _lastUrl = location.href;
        return await extract();
    }

    window.QuickApplyJdExtractor = { extract, maybeExtract };
})();
