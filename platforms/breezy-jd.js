/**
 * QuickApply — Breezy HR JD extractor (*.breezy.hr).
 *
 * Breezy emits a clean Schema.org JobPosting JSON-LD on every public posting,
 * which is far more reliable than scraping the React-rendered DOM. We read
 * the JSON-LD first and only fall back to selectors when it's missing.
 *
 * URL pattern: https://{tenant}.breezy.hr/p/{jobId}
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)breezy\.hr$/i;

    function detect() {
        return HOST_RX.test(location.hostname) && /^\/p\//.test(location.pathname);
    }

    function _jobKey() {
        const m = location.pathname.match(/^\/p\/([^\/?#]+)/);
        const tenant = location.hostname.split('.')[0] || 'unknown';
        if (m) return `breezy:${tenant}:${m[1]}`;
        return `breezy:${tenant}:${location.pathname}`;
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
                } else if (data && data['@graph']) {
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
        const norm = String(s).toUpperCase().replace(/[\s-]/g, '_');
        if (/FULL_?TIME/.test(norm)) return 'Full-time';
        if (/PART_?TIME/.test(norm)) return 'Part-time';
        if (/CONTRACT|CONTRACTOR/.test(norm)) return 'Contract';
        if (/INTERN/.test(norm)) return 'Internship';
        if (/TEMPORARY|TEMP/.test(norm)) return 'Contract';
        return s;
    }

    function _formatLocation(jobLocation) {
        if (!jobLocation) return null;
        const places = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
        const parts = [];
        for (const place of places) {
            const addr = place?.address;
            if (!addr) continue;
            const bits = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
            if (bits.length) parts.push(bits.join(', '));
        }
        return parts.length ? parts.join('; ') : null;
    }

    function _parseLdSalary(baseSalary) {
        if (!baseSalary) return null;
        const v = baseSalary.value || baseSalary;
        const min = Number(v?.minValue ?? v?.value ?? v?.minimum);
        const max = Number(v?.maxValue ?? v?.value ?? v?.maximum) || min;
        if (!Number.isFinite(min) || min <= 0) return null;
        const unit = String(v?.unitText || baseSalary?.unitText || '').toLowerCase();
        const mult = /hour/.test(unit) ? 2080 : /month/.test(unit) ? 12 : /week/.test(unit) ? 52 : 1;
        return {
            min: Math.round(min * mult),
            max: Math.round((max || min) * mult),
            currency: baseSalary.currency || 'USD'
        };
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const ld = _readJobPostingLd();

        if (ld) {
            const title = ld.title || document.querySelector('h1')?.innerText?.trim() || null;
            const company = ld.hiringOrganization?.name || null;
            const location_ = _formatLocation(ld.jobLocation);
            const employmentType = _normEmployment(ld.employmentType);
            const body = _stripHtml(ld.description).slice(0, 12000);
            const salaryFromLd = _parseLdSalary(ld.baseSalary);
            const flags = H.parseLocationFlags(location_, body);

            if (!title && !body) return null;
            return {
                jobKey: _jobKey(),
                url: location.href,
                platform: 'breezy',
                extractedAt: new Date().toISOString(),
                title,
                company,
                location: location_,
                locationFlags: flags,
                employmentType,
                requiredYoE: H.parseYoE(body),
                visaText: H.parseVisaText(body),
                salaryRange: salaryFromLd || H.parseSalary(body),
                descriptionText: body
            };
        }

        // Fallback: JSON-LD missing — scrape DOM
        const title = document.querySelector('h1')?.innerText?.trim()
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        const desc = document.querySelector('.position-description, [class*="position-description"]');
        const body = desc ? (desc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000)
                          : H.bodyTextNearH1();
        if (!title && !body) return null;
        const flags = H.parseLocationFlags(null, body);
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'breezy',
            extractedAt: new Date().toISOString(),
            title,
            company: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
            location: null,
            locationFlags: flags,
            employmentType: H.parseEmploymentType(body, null),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyBreezyJD = { detect, extract, jobKey: _jobKey };
})();
