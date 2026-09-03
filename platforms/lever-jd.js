/**
 * QuickApply — Lever JD extractor (jobs.lever.co/{tenant}/{jobId}).
 *
 * Lever emits a Schema.org JobPosting JSON-LD on every public posting and
 * also exposes structured DOM hooks (.sort-by-location, .sort-by-commitment,
 * .sort-by-department, .sort-by-workplace-type) — workplace type isn't in
 * the JSON-LD, so we read it from the DOM and merge.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)lever\.co$/i;

    function detect() {
        return HOST_RX.test(location.hostname) && /^\/[^\/]+\/[0-9a-f-]{20,}/i.test(location.pathname);
    }

    function _jobKey() {
        const m = location.pathname.match(/^\/([^\/]+)\/([0-9a-f-]{20,})/i);
        if (m) return `lever:${m[1]}:${m[2]}`;
        return `lever:${location.pathname}`;
    }

    function _readJobPostingLd() {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
            try {
                const data = JSON.parse(s.textContent);
                if (Array.isArray(data)) {
                    const found = data.find(d => d && d['@type'] === 'JobPosting');
                    if (found) return found;
                } else if (data && data['@type'] === 'JobPosting') {
                    return data;
                } else if (data && Array.isArray(data['@graph'])) {
                    const found = data['@graph'].find(d => d && d['@type'] === 'JobPosting');
                    if (found) return found;
                }
            } catch (_) {}
        }
        return null;
    }

    function _stripHtml(html) {
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = String(html);
        const txt = tmp.innerText || tmp.textContent || '';
        return txt.replace(/\s+/g, ' ').trim();
    }

    function _normEmployment(s) {
        if (!s) return null;
        const norm = String(s).toLowerCase().replace(/[\s_-]/g, '');
        if (/fulltime|ft\b/.test(norm)) return 'Full-time';
        if (/parttime|pt\b/.test(norm)) return 'Part-time';
        if (/contract|contractor|temp(orary)?/.test(norm)) return 'Contract';
        if (/intern/.test(norm)) return 'Internship';
        return s.trim();
    }

    function _formatLocation(jobLocation, fallbackText) {
        const places = jobLocation ? (Array.isArray(jobLocation) ? jobLocation : [jobLocation]) : [];
        const parts = [];
        for (const place of places) {
            const addr = place?.address;
            if (!addr) continue;
            const bits = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
            if (bits.length) parts.push(bits.join(', '));
        }
        if (parts.length) return parts.join('; ');
        return fallbackText || null;
    }

    /** Lever posts an "On-Site" / "Remote" / "Hybrid" badge in .sort-by-workplace-type. */
    function _readWorkplaceType() {
        const el = document.querySelector('.sort-by-workplace-type, [class*="workplaceTypes"]');
        return el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') : null;
    }

    function _readDomFlags(workplaceType, locationStr, body) {
        const wt = String(workplaceType || '').toLowerCase();
        if (/remote/.test(wt))  return { isRemote: true,  isHybrid: false, isOnsite: false };
        if (/hybrid/.test(wt))  return { isRemote: false, isHybrid: true,  isOnsite: false };
        if (/on[- ]?site|in[- ]?office|in[- ]?person/.test(wt)) return { isRemote: false, isHybrid: false, isOnsite: true };
        return window.QuickApplyJdHelpers.parseLocationFlags(locationStr, body);
    }

    function _readDomEmployment() {
        const el = document.querySelector('.sort-by-commitment, [class*="commitment"]');
        if (!el) return null;
        // Strip the trailing " /" Lever appends to category badges
        return (el.innerText || '').replace(/[\s\/]+$/, '').trim() || null;
    }

    function _readDomDepartment() {
        const el = document.querySelector('.sort-by-department, [class*="department"]');
        if (!el) return null;
        return (el.innerText || '').replace(/[\s\/]+$/, '').trim() || null;
    }

    function _readDomLocationText() {
        const el = document.querySelector('.sort-by-location, [class*="location"]');
        if (!el) return null;
        return (el.innerText || '').replace(/[\s\/]+$/, '').trim() || null;
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const ld = _readJobPostingLd();
        const workplaceType = _readWorkplaceType();
        const domLocation = _readDomLocationText();
        const domEmployment = _readDomEmployment();
        const department = _readDomDepartment();

        if (ld) {
            const title = ld.title || document.querySelector('.posting-headline h2, h2')?.innerText?.trim();
            const company = ld.hiringOrganization?.name || null;
            const location_ = _formatLocation(ld.jobLocation, domLocation);
            const employmentType = _normEmployment(ld.employmentType || domEmployment);
            const body = _stripHtml(ld.description).slice(0, 12000);
            const flags = _readDomFlags(workplaceType, location_, body);
            const salaryRange = (ld.baseSalary
                ? (function () {
                    const v = ld.baseSalary.value || ld.baseSalary;
                    const min = Number(v?.minValue ?? v?.value);
                    const max = Number(v?.maxValue ?? v?.value) || min;
                    if (!Number.isFinite(min) || min <= 0) return null;
                    const unit = String(v?.unitText || '').toLowerCase();
                    const mult = /hour/.test(unit) ? 2080 : /month/.test(unit) ? 12 : /week/.test(unit) ? 52 : 1;
                    return { min: Math.round(min * mult), max: Math.round((max || min) * mult), currency: ld.baseSalary.currency || 'USD' };
                })()
                : null) || H.parseSalary(body);

            if (!title && !body) return null;
            return {
                jobKey: _jobKey(),
                url: location.href,
                platform: 'lever',
                extractedAt: new Date().toISOString(),
                title,
                company,
                location: location_,
                locationFlags: flags,
                employmentType,
                requiredYoE: H.parseYoE(body),
                visaText: H.parseVisaText(body),
                salaryRange,
                descriptionText: body,
                department
            };
        }

        // JSON-LD missing — DOM-only fallback
        const title = document.querySelector('.posting-headline h2, h2, h1')?.innerText?.trim()
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        const desc = document.querySelector('[data-qa="job-description"], .section-wrapper.page-full-width');
        const body = desc
            ? (desc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000)
            : H.bodyTextNearH1();
        if (!title && !body) return null;
        const flags = _readDomFlags(workplaceType, domLocation, body);
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'lever',
            extractedAt: new Date().toISOString(),
            title,
            company: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
            location: domLocation,
            locationFlags: flags,
            employmentType: _normEmployment(domEmployment) || H.parseEmploymentType(body, domLocation),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body,
            department
        };
    }

    window.QuickApplyLeverJD = { detect, extract, jobKey: _jobKey };
})();
