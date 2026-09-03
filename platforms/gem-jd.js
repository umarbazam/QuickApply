/**
 * QuickApply — Gem.com job board JD extractor.
 *
 * Gem hosts the company-branded job page at `jobs.gem.com/<company-slug>/<jobId>`.
 * Every page ships a single `application/ld+json` `JobPosting` payload that
 * carries title, company, location, employment type, remote flag, salary,
 * stable identifier, and the HTML description — so extraction is JSON-LD
 * driven with DOM fallbacks only used if the LD payload is malformed.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)gem\.com$/i;

    function _findJobPostingLd() {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
            try {
                const data = JSON.parse(s.textContent || '{}');
                const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
                for (const node of nodes) {
                    if (node && node['@type'] === 'JobPosting') return node;
                }
            } catch (_) {}
        }
        return null;
    }

    function _stripHtml(html) {
        if (!html) return '';
        // Decode entities + strip tags via a detached element so &nbsp; etc. land as spaces.
        const tmp = document.createElement('div');
        tmp.innerHTML = String(html);
        return (tmp.innerText || tmp.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function _slugFromPath() {
        // /<company>/<opaqueJobId>
        const m = location.pathname.match(/^\/([^\/]+)\/([^\/]+)/);
        return m ? { company: m[1], id: m[2] } : null;
    }

    function _jobKey(ld) {
        const ident = ld?.identifier?.value;
        if (ident && /\S/.test(String(ident))) return `gem:${String(ident).trim()}`;
        const slug = _slugFromPath();
        if (slug) return `gem:${slug.company}:${slug.id}`;
        return `gem:${location.origin}${location.pathname}`;
    }

    function detect() {
        if (HOST_RX.test(location.hostname)) return true;
        // Self-hosted reverse-proxy variants ("careers.<co>.com" pointing at Gem)
        // still embed the Gem JD JSON-LD with `identifier.name` set to the
        // company. Detect on the LD signature so those work too.
        const ld = _findJobPostingLd();
        if (ld && ld.identifier?.name && /\S/.test(String(ld.identifier.value || ''))) {
            // Gem's identifier.value is the URL-safe base64 jobId from the path.
            const slug = _slugFromPath();
            if (slug && String(ld.identifier.value).includes(slug.id.slice(0, 12))) return true;
        }
        return false;
    }

    function _location(ld) {
        const locs = Array.isArray(ld?.jobLocation) ? ld.jobLocation : (ld?.jobLocation ? [ld.jobLocation] : []);
        const parts = [];
        for (const l of locs) {
            const a = l?.address || {};
            const piece = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
            if (piece) parts.push(piece);
        }
        if (parts.length) return parts.join(' | ');
        // applicantLocationRequirements is the "Remote, anywhere in <country>" shape.
        const alr = ld?.applicantLocationRequirements;
        if (alr) {
            const arr = Array.isArray(alr) ? alr : [alr];
            const names = arr.map(x => x?.name).filter(Boolean);
            if (names.length) return names.join(' | ');
        }
        return '';
    }

    function _employmentType(ld) {
        const raw = ld?.employmentType;
        if (!raw) return null;
        const v = (Array.isArray(raw) ? raw[0] : raw).toString().toUpperCase();
        if (v.includes('FULL')) return 'Full-time';
        if (v.includes('PART')) return 'Part-time';
        if (v.includes('CONTRACT') || v.includes('TEMPORARY')) return 'Contract';
        if (v.includes('INTERN'))   return 'Internship';
        return null;
    }

    function _salary(ld) {
        const s = ld?.baseSalary;
        if (!s) return null;
        const v = s.value || {};
        const min = Number(v.minValue ?? v.value);
        const max = Number(v.maxValue ?? v.value);
        if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
        return {
            min: Number.isFinite(min) ? min : (Number.isFinite(max) ? max : null),
            max: Number.isFinite(max) ? max : (Number.isFinite(min) ? min : null),
            currency: s.currency || 'USD'
        };
    }

    function extract() {
        if (!detect()) return null;
        const ld = _findJobPostingLd();
        const H = window.QuickApplyJdHelpers;

        const title = (ld?.title || '').toString().trim()
            || document.title?.trim()
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();

        const company = ld?.hiringOrganization?.name
            || ld?.identifier?.name
            || _slugFromPath()?.company?.split(/[-_]/).map(s => s[0]?.toUpperCase() + s.slice(1)).join(' ')
            || '';

        const location_ = _location(ld);
        const body = _stripHtml(ld?.description || '');
        if (!title && !body) return null;

        const flags = H ? H.parseLocationFlags(location_, body) : null;
        // Gem encodes the remote flag explicitly — trust it over the parsed body.
        const ldRemote = String(ld?.jobLocationType || '').toUpperCase() === 'TELECOMMUTE';
        const locationFlags = flags ? { ...flags, isRemote: flags.isRemote || ldRemote } : (ldRemote ? { isRemote: true, isHybrid: false, isOnsite: false } : null);

        return {
            jobKey: _jobKey(ld),
            url: location.href,
            platform: 'gem',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags,
            employmentType: _employmentType(ld) || (H?.parseEmploymentType?.(body, location_) || null),
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            salaryRange: _salary(ld) || (H?.parseSalary?.(body) || null),
            descriptionText: body.slice(0, 16000)
        };
    }

    window.QuickApplyGemJD = { detect, extract, jobKey: () => _jobKey(_findJobPostingLd()) };
})();
