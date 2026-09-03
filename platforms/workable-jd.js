/**
 * QuickApply — Workable JD extractor.
 * Handles two layouts that share the workable.com host:
 *   - Apply pages (apply.workable.com / {org}.workable.com): [data-ui="job-title"],
 *     job-location, job-type, job-description/requirements/benefits.
 *   - Job-board view (jobs.workable.com/view/{id}/...): [data-ui="overview-title"],
 *     overview-location, overview-employment-type, job-breakdown-*-parsed-html.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)workable\.com$/i;

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        return !!document.querySelector('[data-ui="job-title"], [data-ui="overview-title"]');
    }

    function _stripAtPrefix(s) {
        return s ? s.replace(/^\s*at\s+/i, '').trim() : s;
    }

    function _text(sel) {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') : null;
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
        const parts = cleaned.split(/\s+[-–|]\s+/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            const tail = parts[parts.length - 1];
            if (tail && !/workable/i.test(tail)) return tail;
        }
        const atMatch = cleaned.match(/\bat\s+(.+?)(?:\s*[-–|]|$)/i);
        if (atMatch) return atMatch[1].trim();
        return '';
    }

    function _companyFromSlug() {
        const m = location.pathname.match(/^\/([^\/]+)\/j\/[^\/]+/);
        if (!m) return '';
        return m[1]
            .split(/[-_]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function _bodyText() {
        const parts = [
            'job-description', 'job-requirements', 'job-benefits',
            'job-breakdown-description-parsed-html',
            'job-breakdown-requirements-parsed-html',
            'job-breakdown-benefits-parsed-html'
        ]
            .map(k => _text(`[data-ui="${k}"]`))
            .filter(Boolean);
        if (parts.length) return parts.join('\n\n').slice(0, 8000);
        return window.QuickApplyJdHelpers.bodyTextNearH1();
    }

    function _jobKey() {
        // /{org}/j/{jobId}/  → workable:{org}:{jobId}
        const m = location.pathname.match(/^\/([^\/]+)\/j\/([^\/]+)/);
        if (m) return `workable:${m[1]}:${m[2]}`;
        // /view/{jobId}/...  → workable:view:{jobId} (jobs.workable.com board)
        const v = location.pathname.match(/^\/view\/([^\/]+)/);
        if (v) return `workable:view:${v[1]}`;
        return `workable:${location.pathname}`;
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const title = _text('[data-ui="job-title"]')
            || _text('[data-ui="overview-title"]')
            || document.querySelector('h1')?.innerText?.trim();
        const workplace = _text('[data-ui="job-workplace"]') || _text('[data-ui="overview-workplace"]');
        const location_ = _text('[data-ui="job-location"]')
            || _text('[data-ui="overview-location"]')
            || workplace;
        const company = _text('[data-ui="header-logo"]')
            || _jsonLdCompany()
            || _stripAtPrefix(_text('[data-ui="overview-company"]'))
            || document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
            || _companyFromTitle()
            || _companyFromSlug();
        const employmentType = _text('[data-ui="job-type"]')
            || _text('[data-ui="overview-employment-type"]')
            || H.parseEmploymentType(_bodyText(), location_);
        const body = _bodyText();
        if (!title && !body) return null;
        // Include workplace ("Remote"/"Hybrid") in the flags haystack — on the board
        // layout it lives in a separate field from the geographic location.
        const flags = H.parseLocationFlags(`${location_ || ''} ${workplace || ''}`, body);
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'workable',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyWorkableJD = { detect, extract, jobKey: _jobKey };
})();
