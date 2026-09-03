/**
 * QuickApply — iCIMS JD extractor.
 *
 * iCIMS tenants serve JDs at `careers-<company>.icims.com/jobs/<id>/...`. The
 * outer page is typically a WordPress-themed wrapper hosted at the SAME origin;
 * the real JD content is rendered inside an iframe named `icims_content_iframe`.
 * Because the iframe is same-origin AND the extension's content scripts run
 * with `all_frames: true`, each frame has its own QuickApplyIcimsJD instance.
 * That means `detect()` should return true ONLY in the frame that actually
 * contains the JD body — the wrapper frame returns false so the JD-adapter
 * scanner in content.js falls through to the iframe's instance.
 *
 * Primary data source: JSON-LD `JobPosting` (iCIMS embeds a rich one).
 * DOM fallbacks: `.iCIMS_JobContent`, `.iCIMS_JobHeaderField` / `.iCIMS_JobHeaderData`.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)icims\.com$/i;

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        // Run only in the frame that contains the actual JD body. The wrapper
        // page has the iframe element but no JobContent of its own.
        if (!document.querySelector('.iCIMS_JobContent, .iCIMS_JobContainer')) return false;
        return true;
    }

    function _text(sel, root = document) {
        const el = root.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') : null;
    }

    // Build a {label → value} map for iCIMS's labeled header rows. Tenants
    // ship one of two layouts (sometimes both):
    //   a) Classic iCIMS: <.iCIMS_JobHeaderTag>
    //                       <.iCIMS_JobHeaderField>LABEL</>
    //                       <.iCIMS_JobHeaderData>VALUE</>
    //                     </> — used by Adastra-style tenants.
    //   b) Bootstrap-flavored: <.col-xs-* class wrapper>
    //                       <span class="sr-only field-label">LABEL</span>
    //                       <span>VALUE</span>
    //                     </> — used by Pyramid Systems and similar tenants
    //                     that customized the page template. The screen-reader-
    //                     only label is the stable hook here.
    function _headerMap() {
        const map = {};
        // Classic layout
        for (const tag of document.querySelectorAll('.iCIMS_JobHeaderTag')) {
            const label = tag.querySelector('.iCIMS_JobHeaderField')?.textContent?.trim();
            const value = tag.querySelector('.iCIMS_JobHeaderData')?.textContent?.trim();
            if (label && value) map[label.toLowerCase()] = value;
        }
        // Bootstrap-flavored layout. Look for sr-only field-label spans and
        // pair with the next sibling span (or any sibling text node) — VALUE.
        for (const lbl of document.querySelectorAll('span.sr-only.field-label, .sr-only.field-label')) {
            const label = lbl.textContent?.trim();
            if (!label || map[label.toLowerCase()]) continue;
            // Collect text from siblings after the label until end of parent,
            // joining with spaces. Matches the typical <span>VALUE</span> case
            // plus rarer text-node-only cases.
            const parts = [];
            let n = lbl.nextSibling;
            while (n) {
                const t = (n.textContent || '').trim();
                if (t) parts.push(t);
                n = n.nextSibling;
            }
            const value = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (value) map[label.toLowerCase()] = value;
        }
        return map;
    }

    // True if `s` is iCIMS's "no value" sentinel. iCIMS often writes
    // "UNAVAILABLE" into JSON-LD address fields when no real value is set,
    // which produces garbage like "UNAVAILABLE, UNAVAILABLE, US" if we don't
    // filter.
    function _isPlaceholder(s) {
        if (!s) return true;
        const t = String(s).trim().toLowerCase();
        return !t || t === 'unavailable' || t === 'n/a' || t === 'na' || t === '-' || t === '—';
    }

    function _jsonLdPosting() {
        try {
            const lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const ld of lds) {
                const data = JSON.parse(ld.textContent || '{}');
                const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
                for (const node of nodes) {
                    if (!node) continue;
                    if (node['@type'] === 'JobPosting') return node;
                }
            }
        } catch (_) {}
        return null;
    }

    function _company(posting) {
        const fromLd = posting?.hiringOrganization?.name || posting?.employer?.name;
        if (fromLd) return String(fromLd).trim();
        // Adastra-style title: "Data Product Analyst in Markham, ON | Careers at Adastra Head Office (Markham)"
        // Pyramid Systems title: "Senior SQL Database Administrator in | Careers at Remote"
        //   — note "Careers at Remote" reflects the LOCATION (Remote), not the
        //     company. Skip that case and let the JSON-LD path (above) handle
        //     it — every iCIMS tenant we've seen ships hiringOrganization.name.
        const title = document.title || '';
        const atMatch = title.match(/\bCareers at\s+(.+?)(?:\s*\(|$)/i);
        if (atMatch) {
            const cand = atMatch[1].trim();
            if (!/^(remote|onsite|hybrid)$/i.test(cand)) return cand;
        }
        const pipe = title.split(/\s*\|\s*/);
        if (pipe.length >= 2) {
            const tail = pipe[pipe.length - 1].trim();
            if (!/^(Careers at\s+)?(remote|onsite|hybrid)$/i.test(tail)) return tail;
        }
        return '';
    }

    function _locationStr(posting, header) {
        const collect = (a) => [a?.addressLocality, a?.addressRegion, a?.addressCountry]
            .filter(v => !_isPlaceholder(v))
            .map(v => String(v).trim());
        const loc = posting?.jobLocation;
        if (Array.isArray(loc) && loc.length) {
            const parts = collect(loc[0]?.address);
            if (parts.length) return parts.join(', ');
        } else if (loc?.address) {
            const parts = collect(loc.address);
            if (parts.length) return parts.join(', ');
        }
        // Fallback: iCIMS header row labeled "Job Locations" / "Location"
        const fromHeader = header['job locations'] || header['location'] || '';
        if (fromHeader && !_isPlaceholder(fromHeader)) return fromHeader;
        // Last resort: applicantLocationRequirements (used for remote/telecommute roles)
        const alr = posting?.applicantLocationRequirements;
        if (alr) {
            if (Array.isArray(alr)) {
                const names = alr.map(a => a?.name).filter(Boolean);
                if (names.length) return names.join(', ');
            } else if (alr.name) {
                return String(alr.name);
            }
        }
        // jobLocationType:"TELECOMMUTE" on its own means remote — surface that as the location label.
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
        const dom = _text('.iCIMS_JobContent');
        if (dom) return dom.slice(0, 8000);
        return window.QuickApplyJdHelpers?.bodyTextNearH1?.() || '';
    }

    function _jobIdFromPath() {
        // /jobs/<id>/[slug/]job  or  /jobs/<id>/[slug/]login
        const m = location.pathname.match(/\/jobs\/(\d+)/);
        return m ? m[1] : null;
    }

    function _jobKey() {
        // icims:<tenant-host>:<jobId>  (drop trailing /job or /apply differences)
        const id = _jobIdFromPath();
        if (id) return `icims:${location.hostname}:${id}`;
        return `icims:${location.hostname}:${location.pathname}`;
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const posting = _jsonLdPosting();
        const header = _headerMap();
        const title = posting?.title
            || _text('.iCIMS_JobTitle')
            || document.querySelector('h1')?.innerText?.trim();
        const location_ = _locationStr(posting, header);
        const company = _company(posting);
        const body = _bodyText(posting);
        if (!title && !body) return null;
        const employmentType = posting?.employmentType && posting.employmentType !== 'OTHER'
            ? String(posting.employmentType)
            : (header['position type'] || header['employment type'] || H?.parseEmploymentType?.(body, location_) || null);
        // Trust schema.org's jobLocationType FIRST when it's set — it's an
        // authoritative signal iCIMS exposes for remote roles ("TELECOMMUTE").
        // Then layer on the keyword-derived flags from the body/location.
        const flags = H ? H.parseLocationFlags(location_, body) : { isRemote: false, isHybrid: false, isOnsite: false };
        if (posting?.jobLocationType === 'TELECOMMUTE') flags.isRemote = true;
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'icims',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            salaryRange: H?.parseSalary?.(body) || null,
            descriptionText: body
        };
    }

    window.QuickApplyIcimsJD = { detect, extract, jobKey: _jobKey };
})();
