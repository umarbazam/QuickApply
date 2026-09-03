/**
 * QuickApply — SAP SuccessFactors JD extractor.
 *
 * SuccessFactors is the SAP recruiting platform. Career sites are deployed in
 * two flavors:
 *   1) Vendor-hosted: `<tenant>.successfactors.com/careers` or
 *      `careersection.<tenant>.successfactors.com`.
 *   2) White-labeled custom domain: `jobs.<company>.com` (e.g. CMA CGM at
 *      `jobs.cmacgm-group.com`) — proxies an SF career site.
 *
 * Common URL shape for a posting:
 *   /<TenantSlug>/job/<URL-slug>/<jobId>/[?...]
 * where <jobId> is a long numeric string (8+ digits).
 *
 * Primary data source: JSON-LD `JobPosting` (SF career sites emit it for SEO).
 * DOM fallbacks: SF's stable selectors — `[data-careersite-section]`,
 * `[data-component="JobDescription"]`, `.jobdescription`, `#jobReqContent`,
 * plus the `<h1>` near the top.
 */
(function () {
    'use strict';

    // Hosts we know to be SuccessFactors. The vendor-hosted set is exhaustive;
    // white-label custom domains are detected via DOM markers in `_isSfPage()`.
    const SF_HOSTS_RX = /(^|\.)(successfactors\.com|sapsf\.com|sapsfqa\.com)$/i;

    // SF JD URL patterns. Two shapes seen in the wild:
    //   1) /<Tenant>/job/<slug>/<jobId>/   — vendor-hosted + some white-label
    //   2) /job/<slug>/<jobId>/            — Jobs2Web (j2w) white-label sites
    //                                         (careers.spx.com, careers.celestica.com,
    //                                          careers.cmacgm-group.com proxies, etc.)
    const JOB_URL_RX_TENANT  = /^\/[A-Za-z][\w-]*\/job\/[^/]+\/(\d{6,})\/?/;
    const JOB_URL_RX_NOPFX   = /^\/job\/[^/]+\/(\d{6,})\/?/;
    function _matchJobUrl(p) {
        return JOB_URL_RX_TENANT.test(p) || JOB_URL_RX_NOPFX.test(p);
    }

    function _isSfPage() {
        // Vendor-hosted host always counts.
        if (SF_HOSTS_RX.test(location.hostname)) return true;
        // White-label: require URL shape + a DOM/script signature so we don't
        // false-positive on unrelated `jobs.<company>.com` sites.
        if (!_matchJobUrl(location.pathname)) return false;
        // Confirm SF via vendor-origin scripts/styles or distinctive markers.
        // Jobs2Web (j2w) sites load jQuery from `performancemanager*.successfactors.*`
        // and ship `j2w.*` bundles plus `.jobdescription` + [itemprop=description].
        if (document.querySelector(
            'script[src*="successfactors.com" i],' +
            'script[src*="successfactors.eu" i],' +
            'script[src*="performancemanager" i],' +
            'script[src*="/j2w" i],' +
            'link[href*="successfactors.com" i],' +
            'link[href*="successfactors.eu" i],' +
            'meta[name="careersite"],' +
            'meta[property="og:image"][content*="successfactors" i],' +
            '[data-careersite-section],' +
            '[data-careersite-page],' +
            '[data-careersite-propertyid],' +
            '[data-component="JobDescription"],' +
            '[data-automation-id="careersite"]'
        )) return true;
        // Jobs2Web body markup: `.jobdescription` container + [itemprop=description].
        if (document.querySelector('.jobdescription') && document.querySelector('[itemprop="description"]')) return true;
        // Page head sometimes carries SF identifiers in inline JSON.
        const headHtml = document.head?.innerHTML || '';
        if (/careerSiteId|careerSiteCompanyId|sfcareer|SAPSuccessFactors|rmkcdn\.successfactors/i.test(headHtml)) return true;
        return false;
    }

    function detect() { return _isSfPage(); }

    function _text(sel, root = document) {
        const el = root.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') : null;
    }

    function _jsonLdPosting() {
        try {
            const lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const ld of lds) {
                let data;
                try { data = JSON.parse(ld.textContent || '{}'); } catch (_) { continue; }
                const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
                for (const node of nodes) {
                    if (node && node['@type'] === 'JobPosting') return node;
                }
            }
        } catch (_) {}
        return null;
    }

    function _company(posting) {
        const fromLd = posting?.hiringOrganization?.name || posting?.employer?.name;
        if (fromLd) return String(fromLd).trim();
        // Generic placeholders some j2w tenants leave in the title bar
        // (e.g. SPX renders "... | our team"). Treat as no-data so we fall
        // back to the hostname.
        const GENERIC = /^(our\s+team|team|careers|our\s+company|home)$/i;
        // Title shape on j2w: "<JobTitle> Job Details | <Company>".
        const title = document.title || '';
        const pipeIdx = title.lastIndexOf('|');
        if (pipeIdx >= 0) {
            const tail = title.slice(pipeIdx + 1).trim();
            if (tail && !GENERIC.test(tail)) return tail;
        }
        // Tenant slug from URL path: /<Tenant>/job/... (vendor-hosted + some
        // white-label deployments).
        const m = location.pathname.match(/^\/([A-Za-z][\w-]*)\/job\//);
        if (m) {
            return m[1]
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/[_-]+/g, ' ')
                .trim();
        }
        const og = document.querySelector('meta[property="og:site_name"]')?.content?.trim();
        if (og && !GENERIC.test(og)) return og;
        // Last-ditch: hostname brand — careers.spx.com → "SPX".
        // Short (≤4) tokens are typically acronyms; preserve uppercase.
        const host = (location.hostname || '').replace(/^(careers|jobs|recruiting|talent)\./i, '').split('.')[0];
        if (host) return host.length <= 4 ? host.toUpperCase() : host.charAt(0).toUpperCase() + host.slice(1);
        return '';
    }

    function _locationStr(posting) {
        const collect = (a) => [a?.addressLocality, a?.addressRegion, a?.addressCountry]
            .filter(v => v && String(v).trim())
            .map(v => String(v).trim());
        const loc = posting?.jobLocation;
        if (Array.isArray(loc) && loc.length) {
            const parts = collect(loc[0]?.address);
            if (parts.length) return parts.join(', ');
        } else if (loc?.address) {
            const parts = collect(loc.address);
            if (parts.length) return parts.join(', ');
        }
        // DOM fallback — SF surfaces location in several places depending on
        // template:
        //   - Vendor templates: [data-careersite-propertyid="location"], etc.
        //   - Jobs2Web (j2w) white-label: a "Location: <City>, <ST>, <Country>"
        //     line in the page header near the H1.
        const stripLabel = s => (s || '').replace(/^\s*Location\(s?\)?\s*:\s*/i, '').trim();
        const domCandidates = [
            _text('[data-careersite-propertyid="location"]'),
            _text('.location, .jobLocation, [data-automation-id="location"]'),
            _text('[itemprop="jobLocation"]')
        ].map(s => (s || '').trim()).filter(Boolean);
        if (domCandidates.length) return stripLabel(domCandidates[0]);

        // j2w body-text fallback. Two common shapes:
        //   header style:  "Location: Charlotte, North Carolina (NC), US"
        //   footer style:  "Location(s):  United States : Texas : Dallas"  (Scotiabank)
        // The footer style can be deep in the body (idx 7000+), so scan the
        // whole body rather than just the head. Normalize " : " separators
        // (used by some j2w templates) to commas for downstream geo parsers.
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const m = body.match(/Location\(s?\)?\s*:\s*([^\n.]{2,140}?)(?=\s+(?:Company|Date|Req(?:uisition)?|Posted|Department|Job Family|Apply\s*now|Scotiabank is|We use cookies|At\s+\w+,?\s+(?:we|is|every)|©|\.\s)|\s+[A-Z][a-z]+ is a leading)/i);
        if (m) {
            let raw = m[1].trim();
            // Convert " : "-separated geo segments to comma-separated.
            if (/\s+:\s+/.test(raw)) {
                const parts = raw.split(/\s+:\s+/).map(p => p.trim()).filter(Boolean);
                // Reverse so we get "City, State, Country" (template ships
                // broadest → narrowest, e.g. "United States : Texas : Dallas").
                if (parts.length >= 2 && /^(united states|usa|u\.s\.|canada|mexico|united kingdom|uk|india|germany|france|spain|italy)$/i.test(parts[0])) {
                    raw = parts.slice().reverse().join(', ');
                } else {
                    raw = parts.join(', ');
                }
            }
            return raw.replace(/[,\s]+$/, '').trim();
        }
        if (posting?.jobLocationType === 'TELECOMMUTE') return 'Remote';
        return '';
    }

    function _bodyText(posting) {
        // JSON-LD `description` is HTML — strip tags for the plain-text body.
        const html = posting?.description;
        if (html && typeof html === 'string' && html.length > 200) {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const txt = (tmp.innerText || tmp.textContent || '').replace(/\s+\n/g, '\n').trim();
            if (txt) return txt.slice(0, 8000);
        }
        // Order matters: `.jobdescription` is the Jobs2Web body container and
        // contains the full posting (6kB+ on a typical role). Vendor-hosted SF
        // uses [data-component="JobDescription"] / data-careersite-section.
        const dom = _text('.jobdescription')
            || _text('[data-component="JobDescription"]')
            || _text('[data-careersite-section="job-description"]')
            || _text('#jobReqContent')
            || _text('[itemprop="description"]')
            || _text('main') || _text('article');
        if (dom) return dom.slice(0, 8000);
        return window.QuickApplyJdHelpers?.bodyTextNearH1?.() || '';
    }

    function _jobIdFromPath() {
        const m1 = location.pathname.match(JOB_URL_RX_TENANT);
        if (m1) return m1[1];
        const m2 = location.pathname.match(JOB_URL_RX_NOPFX);
        return m2 ? m2[1] : null;
    }

    function _jobKey() {
        const id = _jobIdFromPath();
        if (id) return `successfactors:${location.hostname}:${id}`;
        return `successfactors:${location.hostname}:${location.pathname}`;
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const posting = _jsonLdPosting();
        const title = posting?.title
            || _text('[data-careersite-propertyid="title"]')
            || _text('[data-automation-id="jobTitle"]')
            || document.querySelector('h1')?.innerText?.trim();
        const location_ = _locationStr(posting);
        const company = _company(posting);
        const body = _bodyText(posting);
        if (!title && !body) return null;
        const employmentType = posting?.employmentType && posting.employmentType !== 'OTHER'
            ? String(posting.employmentType)
            : (H?.parseEmploymentType?.(body, location_) || null);
        const flags = H ? H.parseLocationFlags(location_, body) : { isRemote: false, isHybrid: false, isOnsite: false };
        if (posting?.jobLocationType === 'TELECOMMUTE') flags.isRemote = true;
        // SF JSON-LD often ships baseSalary too — honor it before regex-scanning the body.
        let salaryRange = null;
        const bs = posting?.baseSalary;
        if (bs && (bs.value || bs.minValue || bs.maxValue)) {
            const v = bs.value || {};
            const min = Number(v.minValue ?? bs.minValue);
            const max = Number(v.maxValue ?? bs.maxValue);
            const unit = (v.unitText || bs.unitText || '').toString().toLowerCase();
            if (Number.isFinite(min) || Number.isFinite(max)) {
                salaryRange = {
                    min: Number.isFinite(min) ? min : null,
                    max: Number.isFinite(max) ? max : null,
                    currency: bs.currency || 'USD',
                    period: /year|annum/.test(unit) ? 'year' : unit || null
                };
            }
        }
        if (!salaryRange) salaryRange = H?.parseSalary?.(body) || null;
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'successfactors',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            salaryRange,
            descriptionText: body,
            department: posting?.industry || posting?.occupationalCategory || null
        };
    }

    window.QuickApplySuccessFactorsJD = { detect, extract, jobKey: _jobKey };
})();
