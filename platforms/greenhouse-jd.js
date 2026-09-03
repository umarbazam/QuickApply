/**
 * QuickApply — Greenhouse JD extractor.
 * Returns JdObject or null. Pure DOM read; no side effects.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)greenhouse\.io$/i;

    /** True if this page (or its iframe context) looks like a Greenhouse JD. */
    function detect() {
        if (HOST_RX.test(location.hostname)) return true;
        // Embedded iframe on company sites
        if (document.querySelector('#grnhse_app, #grnhse_iframe, [id^="grnhse_"], [data-id="grnhse_app"]')) return true;
        // Wrapper sites that render the JD inline via the Greenhouse API but
        // don't use the standard #grnhse_* markers (e.g. ixl.com). The gh_jid
        // query parameter is the universal Greenhouse job-id token.
        try {
            const params = new URLSearchParams(location.search);
            const ghJid = params.get('gh_jid') || params.get('token');
            if (ghJid && /^\d+$/.test(ghJid)) return true;
        } catch (_) {}
        return false;
    }

    function _text(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const val = el.tagName === 'META' ? el.getAttribute('content') : el.textContent;
        return val ? val.trim().replace(/\s+/g, ' ') : null;
    }

    function _firstTextOf(selectors) {
        for (const s of selectors) {
            const t = _text(s);
            if (t) return t;
        }
        return null;
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
            if (tail && !/greenhouse/i.test(tail)) return tail;
        }
        return '';
    }

    function _companyFromSlug() {
        const m = location.pathname.match(/^\/([^\/]+)(?:\/jobs\/\d+|\/job\/[^\/]+|\/p\/[^\/]+)?/i);
        if (!m) return '';
        const slug = m[1];
        if (!slug || /^(jobs?|careers?|apply)$/i.test(slug)) return '';
        return slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function _cleanDescriptionText(text) {
        let t = (text || '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        const cutMarkers = [
            'Create a Job Alert',
            'Apply for this job * indicates',
            'Autofill with MyGreenhouse',
            'Voluntary Self-Identification'
        ];
        let cutAt = t.length;
        for (const marker of cutMarkers) {
            const idx = t.toLowerCase().indexOf(marker.toLowerCase());
            if (idx > 1000 && idx < cutAt) cutAt = idx;
        }
        return t.slice(0, cutAt).trim();
    }

    function _bodyText() {
        // Direct Greenhouse-hosted pages + common wrapper-site title-block hooks
        const direct = document.querySelector('#content, [data-mapped="content"], #app_body, .app-body, #main_fields, .opening, .job__description, .job-description, .job-description-body, .job-description-content');
        if (direct) {
            const t = _cleanDescriptionText(direct.innerText || direct.textContent || '');
            if (t.length > 200) return t.slice(0, 16000);
        }
        // Wrapper sites: walk up from the title heading. Prefer H1, fall back
        // to H2 / .job-description-title (IXL pattern), then any heading.
        const titleEl = document.querySelector('h1, h2.job-description-title, .job-description-title, h2');
        if (titleEl) {
            let cur = titleEl.parentElement;
            while (cur && cur !== document.body) {
                const txt = _cleanDescriptionText(cur.innerText || '');
                if (txt.length > 500) return txt.slice(0, 16000);
                cur = cur.parentElement;
            }
        }
        // Last resort: <main>/<article>/[role=main]
        const main = document.querySelector('main, article, [role="main"]');
        if (main) {
            const t = _cleanDescriptionText(main.innerText || '');
            if (t) return t.slice(0, 16000);
        }
        return '';
    }

    function _parseLocationFlags(locationStr, body) {
        const haystack = `${locationStr || ''} ${body}`.toLowerCase();
        return {
            isRemote: /\bremote\b/.test(haystack) && !/\bnot\s+remote\b/.test(haystack),
            isHybrid: /\bhybrid\b/.test(haystack),
            isOnsite: /\b(on[- ]?site|in[- ]?office|in[- ]?person)\b/.test(haystack)
        };
    }

    function _parseYoE(text) {
        const m = /(\d{1,2})\s*\+?\s*(?:to\s*(\d{1,2})\s*)?(?:years?|yrs?)\b/i.exec(text || '');
        if (!m) return { min: null, max: null };
        const min = parseInt(m[1], 10);
        const max = m[2] ? parseInt(m[2], 10) : null;
        return { min, max };
    }

    function _parseSalary(text) {
        // Matches "$120,000", "$120k", "$120k - $150k", "$120,000-$150,000"
        const m = /\$\s*([\d,]+)\s*(k)?\s*(?:(?:[-–]|to)\s*\$?\s*([\d,]+)\s*(k)?)?/i.exec(text || '');
        if (!m) return null;
        const toNum = (s, isK) => {
            if (!s) return null;
            const n = parseInt(s.replace(/,/g, ''), 10);
            return isK ? n * 1000 : n;
        };
        const min = toNum(m[1], !!m[2]);
        const max = toNum(m[3], !!m[4]);
        return { min, max: max || min, currency: 'USD' };
    }

    function _parseVisaText(body) {
        const sentences = body.split(/(?<=[.!?])\s+/).filter(s =>
            /\b(sponsor|sponsorship|visa|work auth|h1b|h-1b|opt|stem opt|cpt)\b/i.test(s)
        );
        return sentences.length ? sentences.slice(0, 3).join(' ') : null;
    }

    function _parseEmploymentType(body, loc) {
        const haystack = `${body} ${loc || ''}`.toLowerCase();
        if (/\bfull[- ]?time\b/.test(haystack)) return 'Full-time';
        if (/\bpart[- ]?time\b/.test(haystack)) return 'Part-time';
        const employmentText = haystack
            .replace(/\bcontractors?\b/g, '')
            .replace(/\bcontracts\b/g, '');
        if (/\b(contract|contract[- ]based|contract role|contract position|fixed[- ]term|temporary)\b/.test(employmentText)) return 'Contract';
        if (/\binternship\b|\bintern\b/.test(haystack)) return 'Internship';
        return null;
    }

    function _jobKey() {
        // Prefer the gh_jid (or embed token) so the parent wrapper page, the
        // embedded iframe, and the direct GH page all converge on one cache
        // entry — that's how the cross-frame "iframe wrote a richer body"
        // override actually reaches the popup, which queries from the top frame.
        const params = new URLSearchParams(location.search);
        const ghJid = params.get('gh_jid') || params.get('token');
        if (ghJid && /^\d+$/.test(ghJid)) return `greenhouse:gh_jid:${ghJid}`;

        // Direct GH page paths like /eclipse/jobs/4981191008
        const m = location.pathname.match(/\/jobs\/(\d+)/);
        if (m) return `greenhouse:gh_jid:${m[1]}`;

        // Some wrapper sites (bill.com) load the embed iframe with a
        // `validityToken` (auth blob) instead of `token`. The form's action
        // attribute reliably contains the real numeric token. Read it.
        const action = document.querySelector('form[action*="token="]')?.getAttribute('action');
        if (action) {
            try {
                const a = new URL(action, location.origin);
                const t = a.searchParams.get('token') || a.searchParams.get('gh_jid');
                if (t && /^\d+$/.test(t)) return `greenhouse:gh_jid:${t}`;
            } catch (_) {}
        }

        // Last resort — distinct entries for distinct pages, even if non-portable
        return `greenhouse:${location.origin}${location.pathname}`;
    }

    // Generic page-header phrases that mean "this is a careers landing page,
    // not a single JD". When the parent of an embedded grnhse_iframe matches
    // one of these as its only H1, defer extraction to the iframe — otherwise
    // we'd cache a bogus title + careers-listing body and clobber the iframe's
    // proper JdObject in the cross-frame race.
    const GENERIC_H1_RX = /^(careers?|jobs?|open\s*(roles|positions)|job\s*openings?|opportunit(y|ies)|hiring|join\s+us|work\s+with\s+us)$/i;

    function extract() {
        if (!detect()) return null;

        const isWrapperHost = !HOST_RX.test(location.hostname);

        // Multi-job-listing guard: a careers landing page lists many roles,
        // so its DOM has many "apply" buttons/links AND the H1 is a generic
        // header. Only relevant on WRAPPER hosts — direct greenhouse.io
        // pages always represent a single JD even if they have several
        // apply CTAs (top + bottom + nav).
        if (isWrapperHost) {
            const applyBtns = document.querySelectorAll(
                'button[id*="apply" i], a[id*="apply" i], button[class*="apply" i], a[class*="apply" i]');
            if (applyBtns.length > 8) return null;
        }

        // Wrapper-site guard: if we're NOT on greenhouse.io and the page H1
        // is a generic careers-landing header, defer to the iframe. The
        // iframe's content script extracts under the same gh_jid jobKey.
        if (isWrapperHost) {
            const headlineH1 = document.querySelector('h1')?.innerText?.trim() || '';
            if (GENERIC_H1_RX.test(headlineH1)) return null;
        }

        const title = _firstTextOf([
            'h1.app-title', '.section-header h1',
            'h2.job-description-title', '.job-description-title', '[class*="job-title" i]',
            'h1', 'h2',
            'meta[property="og:title"]'
        ]);
        const location_ = _firstTextOf(['.app-title + .location', '.location', '[class*="location"]']);
        const company = _firstTextOf(['.company-name', 'meta[property="og:site_name"]'])
            || _jsonLdCompany()
            || _companyFromTitle()
            || _companyFromSlug();
        const body = _bodyText();

        if (!title && !body) return null;   // not really a JD page

        // Wrapper page with no real JD body inline (bill.com, etc.) — the JD
        // lives inside the embedded iframe at job-boards.greenhouse.io. Parent
        // would otherwise extract a useless title like "Job" from og:title and
        // beat the iframe's richer response in the chrome.tabs.sendMessage
        // race. Defer to the iframe; both frames share the gh_jid jobKey, so
        // the popup's cache lookup still resolves the iframe's data.
        if (isWrapperHost && (!body || body.length < 400)) return null;

        const flags = _parseLocationFlags(location_, body);
        const employmentType = _parseEmploymentType(body, location_);

        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'greenhouse',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: _parseYoE(body),
            visaText: _parseVisaText(body),
            salaryRange: _parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyGreenhouseJD = { detect, extract, jobKey: _jobKey };
})();
