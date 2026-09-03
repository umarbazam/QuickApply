/**
 * QuickApply — Eightfold.ai JD extractor.
 * Multi-tenant ATS: <company>.eightfold.ai/careers/job/{id}[-slug] for the JD
 * page, <company>.eightfold.ai/careers/apply?pid={id} for the apply form.
 *
 * Eightfold emits a clean Schema.org JobPosting JSON-LD on every public
 * posting (same shape as Netflix's) — that is the primary source of truth.
 */
(function () {
    'use strict';

    const HOST_RX = /\.eightfold\.ai$/i;

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        if (/\/careers\/job\/\d+/i.test(location.pathname)) return true;
        if (/\/careers\/apply/i.test(location.pathname) && new URLSearchParams(location.search).get('pid')) return true;
        return false;
    }

    function _jobId() {
        const pathMatch = location.pathname.match(/\/careers\/job\/(\d+)/i);
        if (pathMatch) return pathMatch[1];
        const pid = new URLSearchParams(location.search).get('pid');
        if (pid && /^\d+$/.test(pid)) return pid;
        return null;
    }

    function _jobKey() {
        const id = _jobId();
        return id ? `eightfold:${location.hostname}:${id}` : `eightfold:${location.hostname}:${location.pathname}`;
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

    // Eightfold's JobPosting LD often ships empty addressLocality/addressRegion
    // (remote-first roles) with only addressCountry + jobLocationType=TELECOMMUTE
    // populated. Fall back to the plain-text location chips rendered near <h1>
    // (e.g. "USA" / "Remote") when the structured address is empty.
    function _formatLocation(ld) {
        const place = ld.jobLocation;
        const addr = place?.address;
        const country = addr?.addressCountry?.name || addr?.addressCountry;
        const region = addr?.addressRegion;
        const city = addr?.addressLocality;
        const bits = [city, region, country].filter(Boolean);
        if (bits.length) {
            if (String(ld.jobLocationType || '').toUpperCase() === 'TELECOMMUTE') bits.push('Remote');
            return bits.join(', ');
        }
        const h1 = document.querySelector('h1');
        const chips = h1 ? Array.from(h1.parentElement?.querySelectorAll('p, span') || [])
            .map(el => el.textContent.trim()).filter(Boolean).slice(0, 3) : [];
        if (chips.length) return chips.join(', ');
        if (String(ld.jobLocationType || '').toUpperCase() === 'TELECOMMUTE') return 'Remote';
        return null;
    }

    function _stripHtml(text) {
        if (!text) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = String(text);
        const txt = tmp.innerText || tmp.textContent || String(text);
        return txt.replace(/\s+/g, ' ').trim();
    }

    function _bodyTextFallback() {
        const heading = Array.from(document.querySelectorAll('h2')).find(h => /job description/i.test(h.textContent));
        const container = heading ? heading.parentElement : document.querySelector('main, [role="main"], article');
        if (!container) return '';
        return (container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const ld = _readJobPostingLd();

        const title = ld?.title || document.querySelector('h1')?.innerText?.trim() || null;
        const company = ld?.hiringOrganization?.name || null;
        const location_ = ld ? _formatLocation(ld) : null;
        const employmentType = ld ? _normEmployment(ld.employmentType) : null;
        const body = (ld?.description ? _stripHtml(ld.description) : '') || _bodyTextFallback();
        if (!title && !body) return null;

        const flags = H.parseLocationFlags(location_, `${location_ || ''} ${body}`);
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'eightfold',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType: employmentType || H.parseEmploymentType(body, location_),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyEightfoldJD = { detect, extract, jobKey: _jobKey };
})();
