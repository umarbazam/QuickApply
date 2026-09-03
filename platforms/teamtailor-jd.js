/**
 * QuickApply — Teamtailor JD extractor.
 *
 * Teamtailor is a multi-tenant career-site ATS. Postings live at
 * `https://{tenant}.teamtailor.com/jobs/{id}-{slug}` but a large share of
 * customers point a custom domain at the same site (e.g. careers.oatly.com),
 * so host matching alone is not enough — detect() also accepts any host that
 * carries Teamtailor's careersite markup markers.
 *
 * Every public posting ships a Schema.org JobPosting JSON-LD, which is the
 * primary source. One wrinkle: Teamtailor HTML-escapes the description
 * *inside* the JSON string ("&lt;p&gt;…"), so decoding it takes two passes —
 * entities first, then tags (see _htmlToText).
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)teamtailor\.com$/i;
    // Job path, with an optional locale prefix (/en-GB/jobs/123-slug).
    const JOB_PATH_RX = /^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/jobs\/(\d+)/;

    /**
     * True on any Teamtailor-served career site, including white-label custom
     * domains. Exported so content.js can resolve the platform on custom hosts
     * that field-mapper's URL-only detection cannot recognise.
     */
    function isTeamtailorSite() {
        if (HOST_RX.test(location.hostname)) return true;
        try {
            if (document.querySelector(
                'link[href*="teamtailor-cdn.com"], script[src*="teamtailor-cdn.com"], ' +
                'link[href*="teamtailor.com"], img[src*="teamtailor-cdn.com"]'
            )) return true;
            // Stimulus controllers on <body> are namespaced "careersite--*" on
            // every Teamtailor career site and nowhere else.
            const ctrl = document.body?.getAttribute('data-controller') || '';
            if (/careersite--/.test(ctrl)) return true;
            // Apply form (turbo-frame or standalone /applications/new page).
            if (document.querySelector('#job-application-form, turbo-frame#application_form')) return true;
        } catch (_) {}
        return false;
    }

    function detect() {
        if (!JOB_PATH_RX.test(location.pathname)) return false;
        return isTeamtailorSite();
    }

    function _jobId() {
        const m = location.pathname.match(JOB_PATH_RX);
        return m ? m[1] : null;
    }

    function _jobKey() {
        const id = _jobId();
        const host = location.hostname.toLowerCase();
        return id ? `teamtailor:${host}:${id}` : `teamtailor:${host}:${location.pathname}`;
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

    /**
     * Turn Teamtailor's double-encoded description into plain text.
     * Pass 1 decodes the HTML entities the JSON string carries, which yields
     * real markup; pass 2 parses that markup and takes its text. DOMParser is
     * used instead of innerHTML so no images or scripts in the JD body fire.
     */
    function _htmlToText(raw) {
        if (!raw) return '';
        const parse = html => {
            // Block-level tags become spaces so words don't run together once
            // the whitespace is collapsed.
            const spaced = String(html).replace(
                /<\/?(?:p|br|div|li|ul|ol|tr|h[1-6]|section|blockquote)[^>]*>/gi, ' '
            );
            const doc = new DOMParser().parseFromString(spaced, 'text/html');
            return doc.body ? (doc.body.textContent || '') : '';
        };
        let text = parse(raw);
        if (/<[a-z][\s\S]*>/i.test(text)) text = parse(text); // still markup → decode again
        return text.replace(/\s+/g, ' ').trim();
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

    /** Teamtailor only emits baseSalary when the employer filled in a salary range. */
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

    /** Location chips rendered next to <h1> — the fallback when LD has no jobLocation. */
    function _locationFromChips() {
        const links = document.querySelectorAll('a[href*="/locations/"]');
        const names = [...links]
            .map(a => (a.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(t => t && t.length < 60 && !/^locations$/i.test(t));
        return names.length ? [...new Set(names)].slice(0, 3).join('; ') : null;
    }

    /**
     * The "Department / Role / Locations / Remote status" fact list beside the
     * <h1>. "Remote status" is the only place Teamtailor states remote/hybrid,
     * and it is not part of the JD body, so it gets folded into the haystack
     * that parseLocationFlags reads.
     */
    function _factsText() {
        const anchor = document.querySelector('a[href*="/departments/"], a[href*="/locations/"]');
        if (!anchor) return '';
        let best = '';
        let node = anchor.parentElement;
        for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
            const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 600) break;
            best = t;
            if (/remote status/i.test(t)) break;
        }
        return best;
    }

    /** Largest rendered JD body block — Teamtailor wraps it in a .prose container. */
    function _bodyFromDom() {
        let best = '';
        document.querySelectorAll('[class*="prose"]').forEach(el => {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > best.length) best = t;
        });
        if (best.length > 400) return best.slice(0, 12000);
        const H = window.QuickApplyJdHelpers;
        return H.bodyTextNearH1(12000);
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const ld = _readJobPostingLd();
        const facts = _factsText();

        const title = ld?.title
            || document.querySelector('h1')?.innerText?.trim()
            || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
            || null;
        const company = ld?.hiringOrganization?.name
            || document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
            || null;

        // The LD description is the whole posting; the DOM fallback covers the
        // handful of tenants that suppress JSON-LD.
        const body = (ld ? _htmlToText(ld.description) : '').slice(0, 12000) || _bodyFromDom();
        if (!title && !body) return null;

        const location_ = _formatLocation(ld?.jobLocation) || _locationFromChips();
        const flags = H.parseLocationFlags(`${location_ || ''} ${facts}`, body);

        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'teamtailor',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType: _normEmployment(ld?.employmentType) || H.parseEmploymentType(`${body} ${facts}`, location_),
            requiredYoE: H.parseYoE(body),
            visaText: H.parseVisaText(body),
            salaryRange: _parseLdSalary(ld?.baseSalary) || H.parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyTeamtailorJD = { detect, extract, jobKey: _jobKey, isTeamtailorSite };
})();
