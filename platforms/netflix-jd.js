/**
 * QuickApply — Netflix Careers JD extractor
 * (explore.jobs.netflix.net/careers/job/{numericId} and /careers/apply?pid={id}).
 *
 * Netflix emits a clean Schema.org JobPosting JSON-LD on every public posting.
 * URL pattern: /careers/job/{id} for the JD page, /careers/apply?pid={id} for the form.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)jobs\.netflix\.net$/i;

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        // Either /careers/job/{id} or /careers/apply?pid={id}
        if (/\/careers\/job\/\d+/i.test(location.pathname)) return true;
        if (/\/careers\/apply/i.test(location.pathname) && new URLSearchParams(location.search).get('pid')) return true;
        return false;
    }

    function _jobKey() {
        const pidMatch = location.pathname.match(/\/careers\/job\/(\d+)/i);
        if (pidMatch) return `netflix:${pidMatch[1]}`;
        const pid = new URLSearchParams(location.search).get('pid');
        if (pid && /^\d+$/.test(pid)) return `netflix:${pid}`;
        return `netflix:${location.pathname}`;
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
        const norm = String(s).toUpperCase().replace(/[\s-]/g, '_');
        if (/FULL_?TIME/.test(norm)) return 'Full-time';
        if (/PART_?TIME/.test(norm)) return 'Part-time';
        if (/CONTRACT|CONTRACTOR/.test(norm)) return 'Contract';
        if (/INTERN/.test(norm)) return 'Internship';
        if (/TEMPORARY|TEMP/.test(norm)) return 'Contract';
        return s;
    }

    function _formatLocation(jobLocation, fallbackText) {
        const places = jobLocation ? (Array.isArray(jobLocation) ? jobLocation : [jobLocation]) : [];
        const parts = [];
        for (const place of places) {
            const addr = place?.address;
            if (!addr) continue;
            // Country can be a string or { name: '...' } object
            const country = addr.addressCountry?.name || addr.addressCountry;
            const region = addr.addressRegion;
            const city = addr.addressLocality;
            const bits = [city, region, country].filter(Boolean);
            if (bits.length) parts.push(bits.join(', '));
        }
        if (parts.length) return parts.join('; ');
        return fallbackText || null;
    }

    function _parseLdSalary(baseSalary) {
        if (!baseSalary) return null;
        const v = baseSalary.value || baseSalary;
        const min = Number(v?.minValue ?? v?.value);
        const max = Number(v?.maxValue ?? v?.value) || min;
        if (!Number.isFinite(min) || min <= 0) return null;
        const unit = String(v?.unitText || baseSalary?.unitText || '').toLowerCase();
        const mult = /hour/.test(unit) ? 2080 : /month/.test(unit) ? 12 : /week/.test(unit) ? 52 : 1;
        return {
            min: Math.round(min * mult),
            max: Math.round((max || min) * mult),
            currency: baseSalary.currency || 'USD'
        };
    }

    function _bodyTextFallback() {
        const main = document.querySelector('main, [role="main"], article');
        if (!main) return '';
        return (main.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const ld = _readJobPostingLd();

        if (ld) {
            const title = ld.title || document.querySelector('h1')?.innerText?.trim() || null;
            const company = ld.hiringOrganization?.name || 'Netflix';
            // The JD page itself shows "USA - Remote" in the title bar; use that
            // as a fallback when the LD-encoded location is misleading (Netflix
            // sometimes lists Panama as a placeholder address for Remote roles).
            const titleBarText = document.title || '';
            const usaRemoteHint = /USA\s*-\s*Remote|Remote\s*\([^)]*USA[^)]*\)/i.test(titleBarText) ? 'USA - Remote' : null;
            const location_ = _formatLocation(ld.jobLocation, usaRemoteHint);
            const employmentType = _normEmployment(ld.employmentType);
            const body = _stripHtml(ld.description).slice(0, 12000) || _bodyTextFallback();
            const salary = _parseLdSalary(ld.baseSalary) || H.parseSalary(body);
            // Netflix JDs frequently say "USA - Remote" in the page header even
            // when JSON-LD has a region; if the page text mentions "Remote",
            // flag it.
            const flagSrc = `${location_ || ''} ${titleBarText} ${body.slice(0, 2000)}`;
            const flags = H.parseLocationFlags(location_, flagSrc);

            if (!title && !body) return null;
            return {
                jobKey: _jobKey(),
                url: location.href,
                platform: 'netflix',
                extractedAt: new Date().toISOString(),
                title,
                company,
                location: location_,
                locationFlags: flags,
                employmentType,
                requiredYoE: H.parseYoE(body),
                visaText: H.parseVisaText(body),
                salaryRange: salary,
                descriptionText: body
            };
        }

        // Fallback: JSON-LD missing
        const title = document.querySelector('h1')?.innerText?.trim()
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        const body = _bodyTextFallback();
        if (!title && !body) return null;
        const flags = H.parseLocationFlags(null, body);
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'netflix',
            extractedAt: new Date().toISOString(),
            title,
            company: 'Netflix',
            location: null,
            locationFlags: flags,
            employmentType: H.parseEmploymentType(body, null),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyNetflixJD = { detect, extract, jobKey: _jobKey };
})();
