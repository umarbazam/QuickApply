/**
 * QuickApply — Rippling ATS JD extractor (ats.rippling.com).
 *
 * Rippling renders the visible page as a thin React shell — every structured
 * field (workLocations, employmentType, department, payRangeDetails,
 * companyName, description) lives in the #__NEXT_DATA__ JSON blob. Reading
 * from there is far more reliable than DOM scraping. Falls back to DOM
 * heuristics only when the JSON isn't present.
 *
 * URL pattern: /{lang}/{org}/jobs/{uuid} or /{org}/jobs/{uuid}.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)ats\.rippling\.com$/i;

    function detect() {
        return HOST_RX.test(location.hostname) && /\/jobs\/[0-9a-f-]{20,}/i.test(location.pathname);
    }

    function _jobKey() {
        const m = location.pathname.match(/\/([^\/]+)\/jobs\/([0-9a-f-]{20,})/i);
        if (m) return `rippling:${m[1]}:${m[2]}`;
        return `rippling:${location.pathname}`;
    }

    function _readJobPost() {
        const el = document.querySelector('#__NEXT_DATA__');
        if (!el) return null;
        try {
            const data = JSON.parse(el.textContent);
            return data?.props?.pageProps?.apiData?.jobPost || null;
        } catch (_) { return null; }
    }

    function _stripHtml(html) {
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = String(html);
        const txt = tmp.innerText || tmp.textContent || '';
        return txt.replace(/\s+/g, ' ').trim();
    }

    function _normEmployment(emp) {
        if (!emp) return null;
        const id = String(emp.id || emp.label || '').toLowerCase();
        if (/full[- ]?time|ft\b/.test(id)) return 'Full-time';
        if (/part[- ]?time|pt\b/.test(id)) return 'Part-time';
        if (/contract|contractor/.test(id)) return 'Contract';
        if (/intern/.test(id)) return 'Internship';
        return emp.id || emp.label || null;
    }

    /** workLocations is an array of strings like "Remote (United States)" or "New York, NY". */
    function _parseLocations(workLocations) {
        if (!Array.isArray(workLocations) || !workLocations.length) return { location: null, flags: null };
        const joined = workLocations.join('; ');
        const lc = joined.toLowerCase();
        const flags = {
            isRemote: /\bremote\b/.test(lc) && !/\bnot\s+remote\b/.test(lc),
            isHybrid: /\bhybrid\b/.test(lc),
            isOnsite: /\b(on[- ]?site|in[- ]?office|in[- ]?person)\b/.test(lc)
        };
        return { location: joined, flags };
    }

    function _parsePayRange(payRangeDetails, currencyDefault = 'USD') {
        if (!Array.isArray(payRangeDetails) || !payRangeDetails.length) return null;
        // Each entry can be { min, max, currency, frequency } or similar; shape varies.
        const first = payRangeDetails[0] || {};
        const min = Number(first.min || first.minimum || first.lowAmount || first.low);
        const max = Number(first.max || first.maximum || first.highAmount || first.high) || min;
        if (!Number.isFinite(min) || min <= 0) return null;
        const freq = String(first.frequency || first.period || '').toLowerCase();
        const mult = /hour/.test(freq) ? 2080 : /month/.test(freq) ? 12 : 1;
        return { min: Math.round(min * mult), max: Math.round((max || min) * mult), currency: first.currency || currencyDefault };
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const jp = _readJobPost();

        if (jp) {
            const title = jp.name || null;
            const company = jp.companyName || null;
            const { location, flags } = _parseLocations(jp.workLocations);
            const employmentType = _normEmployment(jp.employmentType);
            // description is { role: html, company: html }
            const roleHtml = jp.description?.role || '';
            const companyHtml = jp.description?.company || '';
            const body = (_stripHtml(roleHtml) + '\n\n' + _stripHtml(companyHtml)).trim().slice(0, 8000);
            const salaryFromJson = _parsePayRange(jp.payRangeDetails);

            return {
                jobKey: _jobKey(),
                url: location ? jp.url || globalThis.location.href : globalThis.location.href,
                platform: 'rippling',
                extractedAt: new Date().toISOString(),
                title,
                company,
                location,
                locationFlags: flags || H.parseLocationFlags(location, body),
                employmentType,
                requiredYoE: H.parseYoE(body),
                visaText: H.parseVisaText(body),
                salaryRange: salaryFromJson || H.parseSalary(body),
                descriptionText: body,
                department: jp.department?.name || null
            };
        }

        // Fallback: __NEXT_DATA__ missing (e.g. rendered server-side without hydration JSON)
        const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        const titleSplit = (s) => {
            if (!s) return { title: null, company: null };
            const m = s.match(/^(.+?)\s+(?:\||–|—|-)\s+(.+)$/);
            if (m) return { title: m[1].trim(), company: m[2].trim() };
            return { title: s.trim(), company: null };
        };
        let { title, company } = titleSplit(og || document.title);
        if (!title) title = document.querySelector('h1, h2')?.innerText?.trim() || null;
        const preview = document.querySelector('.ATS_htmlPreview, [class*="htmlPreview" i]');
        const body = preview ? (preview.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000)
                             : H.bodyTextNearH1();
        const flags = H.parseLocationFlags(null, body);
        return {
            jobKey: _jobKey(),
            url: globalThis.location.href,
            platform: 'rippling',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: null,
            locationFlags: flags,
            employmentType: H.parseEmploymentType(body, null),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyRipplingJD = { detect, extract, jobKey: _jobKey };
})();
