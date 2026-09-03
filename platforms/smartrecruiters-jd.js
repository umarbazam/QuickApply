/**
 * QuickApply — SmartRecruiters JD extractor (jobs.smartrecruiters.com).
 *
 * SR uses Schema.org microdata, but the address components are <meta>
 * elements with values in the `content` attribute (innerText is empty).
 * Description + responsibilities + qualifications + incentives live in
 * separate [itemprop=...] divs and need to be joined for the body.
 *
 * SR's newer "oneclick-ui" apply flow (/oneclick-ui/company/{slug}/
 * publication/{uuid}[/screening]) ships none of that microdata — it's an
 * Angular app that exposes the same job/company data via a
 * `window.__OC_CONTEXT__` global instead (also includes the full structured
 * screening-question list). Without recognising these pages, no JD ever
 * gets cached for this jobKey, so the fit-card popup (and the "Fill" action
 * it leads to) never appears anywhere in the oneclick-ui flow.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)smartrecruiters\.com$/i;

    function _ocContext() {
        try { return window.__OC_CONTEXT__ && window.__OC_CONTEXT__.job ? window.__OC_CONTEXT__ : null; } catch (_) { return null; }
    }

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        return !!document.querySelector('[itemprop="title"], [itemprop="description"]') || !!_ocContext();
    }

    /** Read [itemprop=name]; returns content for <meta>, innerText otherwise. */
    function _itemprop(name, root = document) {
        const el = root.querySelector(`[itemprop="${name}"]`);
        if (!el) return null;
        const v = el.tagName === 'META' ? el.getAttribute('content') : (el.innerText || el.textContent || '');
        return v ? v.trim().replace(/\s+/g, ' ') : null;
    }

    function _jobKey() {
        const m = location.pathname.match(/^\/([^\/]+)\/(\d{10,})/);
        if (m) return `smartrecruiters:${m[1]}:${m[2]}`;
        // oneclick-ui: no numeric job id in the URL (only an opaque publication
        // uuid) — __OC_CONTEXT__.job.id is the same numeric id the classic JD
        // page's URL carries, so keying off it lets a JD extracted from the
        // classic page and one extracted here merge into the same cache entry.
        const oc = _ocContext();
        if (oc?.job?.id && oc?.company?.companyIdentifier) return `smartrecruiters:${oc.company.companyIdentifier}:${oc.job.id}`;
        return `smartrecruiters:${location.pathname}`;
    }

    /**
     * Build a human-readable location string from the address components.
     * Prefers locality + region + country; falls back to whatever is present.
     */
    function _buildLocation() {
        const street = _itemprop('streetAddress');
        const city = _itemprop('addressLocality');
        const region = _itemprop('addressRegion');
        const country = _itemprop('addressCountry');
        const parts = [city, region].filter(Boolean);
        if (street && !parts.length) parts.push(street);
        if (country && !parts.includes(country)) parts.push(country);
        const out = parts.join(', ');
        return out || _itemprop('address') || null;
    }

    function _normEmployment(s) {
        if (!s) return null;
        const norm = s.toLowerCase();
        if (/full[- ]?time/.test(norm)) return 'Full-time';
        if (/part[- ]?time/.test(norm)) return 'Part-time';
        if (/contract/.test(norm)) return 'Contract';
        if (/intern/.test(norm)) return 'Internship';
        return s;
    }

    /**
     * SR salaries can show as "USD 25 - USD 27 - hourly" or "$25.00 - 27.00"
     * with "Hourly Rate" nearby. Detect hourly/monthly and convert to annual
     * so the value compares cleanly with client.expectedSalary.
     */
    function _parseSrSalary(body) {
        const text = String(body || '');
        // Pull the chunk near 'Compensation' / 'Salary' / 'Hourly Rate' to avoid
        // catching unrelated dollar mentions (e.g. theme park ticket prices).
        const ctxRx = /(?:Compensation|Salary|Hourly\s*Rate|Pay\s*Range|Base\s*Salary)\s*[:\-]?\s*([^\n.]{0,160})/i;
        const ctxMatch = ctxRx.exec(text);
        const scope = ctxMatch ? ctxMatch[1] : text;

        // Match "USD 25" or "$25" with optional decimals and an optional range
        const rx = /(?:USD|EUR|GBP|\$)\s*([\d,]+(?:\.\d+)?)\s*(?:[-–]|to)\s*(?:USD|EUR|GBP|\$)?\s*([\d,]+(?:\.\d+)?)?/i;
        const m = rx.exec(scope);
        if (!m) return null;
        const toNum = s => s ? parseFloat(String(s).replace(/,/g, '')) : null;
        let min = toNum(m[1]);
        let max = toNum(m[2]) || min;
        if (min == null) return null;

        const isHourly = /\bhourly\b|\bper\s*hour\b|\b\/\s*hr\b/i.test(scope) || /\bhourly\b|\bper\s*hour\b|\b\/\s*hr\b/i.test(text.slice(0, ctxMatch ? ctxMatch.index + 200 : 0));
        const isMonthly = /\bmonthly\b|\bper\s*month\b/i.test(scope);
        if (isHourly) { min = min * 2080; max = max * 2080; }
        else if (isMonthly) { min = min * 12; max = max * 12; }
        return { min: Math.round(min), max: Math.round(max), currency: /EUR/i.test(scope) ? 'EUR' : /GBP/i.test(scope) ? 'GBP' : 'USD' };
    }

    /**
     * oneclick-ui apply/screening pages carry no JD body text (they're the
     * application form, not the listing) — just title/company/location from
     * __OC_CONTEXT__. Returning a thin JD here is still useful: it's enough
     * for the fit-card popup to appear, and jd-extractor's per-field merge
     * fills in body/salary/etc. from a classic-page visit if one is cached
     * under the same jobKey.
     */
    function _extractFromOcContext(oc) {
        const H = window.QuickApplyJdHelpers;
        const title = oc.job?.title || null;
        const company = oc.company?.name || null;
        const location_ = oc.job?.location || null;
        if (!title) return null;
        const flags = H.parseLocationFlags(location_, oc.job?.locationRemote ? 'remote' : '');
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'smartrecruiters',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType: null,
            requiredYoE: { min: null, max: null },
            visaText: null,
            salaryRange: null,
            descriptionText: ''
        };
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;

        if (!document.querySelector('[itemprop="title"], [itemprop="description"]')) {
            const oc = _ocContext();
            if (oc) return _extractFromOcContext(oc);
        }

        const title = _itemprop('title')
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || document.querySelector('h1')?.innerText?.trim();

        // Hiring org's name lives in a nested itemprop. Fall back to og:site_name.
        const hiringOrg = document.querySelector('[itemprop="hiringOrganization"]');
        const company = (hiringOrg && _itemprop('name', hiringOrg))
            || document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
            || null;

        const location_ = _buildLocation();

        // Body = description + responsibilities + qualifications + incentives
        const sections = ['description', 'responsibilities', 'qualifications', 'incentives']
            .map(p => _itemprop(p))
            .filter(Boolean);
        const body = sections.join('\n\n').slice(0, 12000);

        // SR puts the work-mode signal either in a banner above the JD ("Employees
        // work in a hybrid mode") OR deep in the qualifications / additional-
        // requirements section ("Hybrid: This position currently has a hybrid
        // schedule…"). Use the full body, not just the first 2 KB.
        const visibleTop = (document.body.innerText || '').slice(0, 2000);
        const flagsHaystack = `${location_ || ''}\n${visibleTop}\n${body}`;
        const flags = H.parseLocationFlags(location_, flagsHaystack);

        const employmentType = _normEmployment(_itemprop('employmentType')) || H.parseEmploymentType(body, location_);
        const salaryRange = _parseSrSalary(`${visibleTop}\n${body}`) || H.parseSalary(body);

        if (!title && !body) return null;
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'smartrecruiters',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange,
            descriptionText: body
        };
    }

    window.QuickApplySmartRecruitersJD = { detect, extract, jobKey: _jobKey };
})();
