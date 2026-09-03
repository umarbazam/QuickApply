/**
 * QuickApply — Ashby JD extractor (jobs.ashbyhq.com).
 * Title from <h1>. Body from .ashby-job-posting-right-pane (or og:description /
 * H1 walk-up). Structured sidebar fields (Location / Employment Type / Location
 * Type / Compensation) are matched by their label text — Ashby uses
 * hash-suffixed CSS module classes that change between releases, so class-based
 * selectors are not reliable. JobKey is the UUID in the path.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)ashbyhq\.com$/i;

    function detect() {
        return HOST_RX.test(location.hostname) && /\/[0-9a-f-]{20,}/i.test(location.pathname);
    }

    function _bodyText() {
        const right = document.querySelector('.ashby-job-posting-right-pane, [class*="JobPostingRightPane"]');
        if (right) {
            const t = (right.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 200) return t.slice(0, 8000);
        }
        const meta = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
        if (meta && meta.length > 200) return meta.replace(/\s+/g, ' ').slice(0, 8000);
        return window.QuickApplyJdHelpers.bodyTextNearH1();
    }

    function _jsonLdCompany() {
        try {
            const lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const ld of lds) {
                const data = JSON.parse(ld.textContent || '{}');
                const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
                for (const node of nodes) {
                    if (!node || node['@type'] !== 'JobPosting') continue;
                    const name = node.hiringOrganization?.name || node.employer?.name || '';
                    if (name && String(name).trim()) return String(name).trim();
                }
            }
        } catch (_) {}
        return '';
    }

    function _companyFromTitle() {
        const title = document.title || document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        if (!title) return '';
        const cleaned = String(title).replace(/\s+/g, ' ').trim();
        const atMatch = cleaned.match(/\bat\s+(.+?)(?:\s*[-–|]|$)/i);
        if (atMatch) return atMatch[1].trim();
        const parts = cleaned.split(/\s+[-–|]\s+/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            const tail = parts[parts.length - 1];
            if (tail && !/ashby/i.test(tail)) return tail;
        }
        return '';
    }

    function _companyFromSlug() {
        const m = location.pathname.match(/^\/([^\/]+)\/[0-9a-f-]{20,}/i);
        if (!m) return '';
        return m[1]
            .split(/[-_]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    /**
     * Find an Ashby sidebar field's value by its label text. Ashby renders
     * each metadata block as `<div class="_section"><h2>Label</h2><p|ul>Value</p|ul></div>`,
     * so we look for an element whose textContent is exactly the label and
     * read the next sibling. textContent (not innerText) so the test matches
     * even if the label is wrapped in display:flex/grid containers that
     * break innerText into multiple lines.
     */
    function _findSidebarValue(label) {
        const target = label.toLowerCase();
        const candidates = document.querySelectorAll('h2, h3, h4, div, span, dt');
        for (const el of candidates) {
            const t = (el.textContent || '').trim();
            if (t.toLowerCase() !== target) continue;
            const sib = el.nextElementSibling;
            if (sib) {
                const v = (sib.textContent || '').replace(/\s+/g, ' ').trim();
                if (v) return v;
            }
            const parent = el.parentElement?.textContent?.trim();
            if (parent) {
                const stripped = parent.replace(new RegExp(`^${label}\\s*`, 'i'), '').replace(/\s+/g, ' ').trim();
                if (stripped) return stripped;
            }
        }
        return null;
    }

    function _company() {
        return window.QuickApplyJdHelpers.firstTextOf([
            'meta[property="og:site_name"]', '[class*="CompanyName" i]'
        ]) || _jsonLdCompany() || _companyFromTitle() || _companyFromSlug();
    }

    function _jobKey() {
        const m = location.pathname.match(/^\/([^\/]+)\/([0-9a-f-]{20,})/i);
        if (m) return `ashby:${m[1]}:${m[2]}`;
        return `ashby:${location.pathname}`;
    }

    /**
     * Ashby's Compensation block is e.g. "Estimated Base Salary $24 – $27 per
     * hour" or "$120,000 – $140,000 per year". Normalize hourly to annual
     * (× 2080) so it compares cleanly against client.expectedSalary which is
     * usually annual.
     */
    function _parseAshbyCompensation(text) {
        if (!text) return null;
        const moneyRx = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:k|K)?\s*(?:[-–]|to)?\s*\$?\s*([\d,]+(?:\.\d+)?)?\s*(?:k|K)?/;
        const m = moneyRx.exec(text);
        if (!m) return null;
        const toNum = (s) => s ? parseInt(String(s).replace(/,/g, ''), 10) : null;
        let min = toNum(m[1]);
        let max = toNum(m[2]) || min;
        if (min == null) return null;
        const isHourly = /\bper\s*hour\b|\bhourly\b|\b\/\s*hr\b/i.test(text);
        const isMonthly = /\bper\s*month\b|\bmonthly\b/i.test(text);
        if (isHourly) { min = min * 2080; max = max * 2080; }
        else if (isMonthly) { min = min * 12; max = max * 12; }
        return { min, max, currency: 'USD' };
    }

    function _normEmployment(s) {
        if (!s) return null;
        const norm = s.toLowerCase();
        if (/full[- ]?time/.test(norm)) return 'Full-time';
        if (/part[- ]?time/.test(norm)) return 'Part-time';
        if (/contract/.test(norm)) return 'Contract';
        if (/intern/.test(norm)) return 'Internship';
        return s.trim();
    }

    function _locationFlagsFromAshby(locationType, locationStr, body) {
        // Prefer the explicit Location Type field if present
        if (locationType) {
            const t = locationType.toLowerCase();
            if (/remote/.test(t)) return { isRemote: true, isHybrid: false, isOnsite: false };
            if (/hybrid/.test(t)) return { isRemote: false, isHybrid: true, isOnsite: false };
            if (/on[- ]?site|in[- ]?office|in[- ]?person/.test(t)) return { isRemote: false, isHybrid: false, isOnsite: true };
        }
        return window.QuickApplyJdHelpers.parseLocationFlags(locationStr, body);
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const title = document.querySelector('h1')?.innerText?.trim()
            || H.firstTextOf(['meta[property="og:title"]']);

        // Structured sidebar fields. Each is found by label, so Ashby's
        // hash-suffixed CSS class changes don't break extraction.
        const sidebarLocation = _findSidebarValue('Location');
        const sidebarLocationType = _findSidebarValue('Location Type');
        const sidebarEmployment = _findSidebarValue('Employment Type');
        const sidebarCompensation = _findSidebarValue('Compensation');
        const sidebarDepartment = _findSidebarValue('Department');

        const company = _company();
        const body = _bodyText();
        if (!title && !body) return null;

        const flags = _locationFlagsFromAshby(sidebarLocationType, sidebarLocation, body);
        const employmentType = _normEmployment(sidebarEmployment) || H.parseEmploymentType(body, sidebarLocation);
        const salaryFromSidebar = _parseAshbyCompensation(sidebarCompensation);
        const salaryRange = salaryFromSidebar || H.parseSalary(body);

        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'ashby',
            extractedAt: new Date().toISOString(),
            title: title || null,
            company,
            location: sidebarLocation,
            locationFlags: flags,
            employmentType,
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange,
            descriptionText: body,
            department: sidebarDepartment || null
        };
    }

    window.QuickApplyAshbyJD = { detect, extract, jobKey: _jobKey };
})();
