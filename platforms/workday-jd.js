/**
 * QuickApply - Workday JD extractor.
 * Same jobKey on JD page and apply page (parsed from the URL job ID).
 */
(function () {
    'use strict';

    const HOST_RX = /\.myworkdayjobs\.com$/i;

    function detect() {
        return HOST_RX.test(location.hostname);
    }

    function _pathSite(parts) {
        const jobIdx = parts.findIndex(p => /^job$/i.test(p));
        if (jobIdx > 0) return parts[jobIdx - 1];
        return parts.find(p => !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(p)) || 'unknown';
    }

    /** workday:{hostTenant}:{site}:{jobId}, avoiding collisions across locale-prefixed Workday URLs. */
    function _jobKey() {
        const parts = location.pathname.split('/').filter(Boolean);
        const hostTenant = location.hostname.split('.')[0] || 'unknown';
        const site = _pathSite(parts);
        // Find the slug containing the job ID - last non-empty segment that contains an underscore.
        let slug = '';
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].includes('_')) { slug = parts[i]; break; }
        }
        const id = slug ? slug.split('_').pop() : '';
        if (!id) return `workday:${hostTenant}:${site}:${location.pathname}`;
        return `workday:${hostTenant}:${site}:${id}`;
    }

    function _text(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const val = el.tagName === 'META' ? el.getAttribute('content') : (el.innerText || el.textContent);
        return val ? val.trim().replace(/\s+/g, ' ') : null;
    }

    function _bodyText() {
        const el = document.querySelector('[data-automation-id="jobPostingDescription"]');
        const raw = el ? (el.innerText || el.textContent || '') :
                         (_text('meta[property="og:description"], meta[name="description"]') || '');
        return raw.replace(/\s+/g, ' ').trim().slice(0, 20000);
    }

    function _cleanWorkdayDetail(raw, labelRx) {
        if (!raw) return null;
        return raw.replace(labelRx, '').trim().replace(/\s+/g, ' ') || null;
    }

    function _jobRelevantText(text) {
        const body = String(text || '');
        const cutoff = body.search(/\b(Additional Compensation|Robust Benefits|Benefits Offered|Important Notice)\b/i);
        return cutoff >= 0 ? body.slice(0, cutoff) : body;
    }

    function _parseLocationFlags(loc, body) {
        const modeText = _jobRelevantText(body)
            .replace(/\bonsite\s+(?:and\s+[a-z]+\s+)?teams?\b/gi, ' ')
            .replace(/\bonsite\s+(?:and\s+operations|team\s+members|property|positions?)\b/gi, ' ')
            .replace(/\bonsite\s+housing\b/gi, ' ');
        const h = `${loc || ''} ${modeText}`.toLowerCase();
        return {
            isRemote: /\bremote\b/.test(h) && !/\bnot\s+remote\b/.test(h),
            isHybrid: /\bhybrid\b/.test(h),
            isOnsite: /\b(on[- ]?site|in[- ]?office|in[- ]?person)\b/.test(h)
        };
    }

    function _parseYoE(text) {
        const scoped = _jobRelevantText(text);
        const chunks = scoped.split(/(?<=[.!?;])\s+|\n+/);
        const matches = [];
        const rx = /\b(\d{1,2})\s*(?:\+|(?:-|\u2013|to)\s*(\d{1,2}))?\s*(?:years?|yrs?)\b/ig;

        for (const chunk of chunks) {
            if (!/\b(experience|qualification|requirement|required|preferred|minimum|min\.?|at least)\b/i.test(chunk)) continue;
            if (/\b(years?\s+of\s+service|years?\s+thereafter|after\s+\d{1,2}\s+(?:and|or)\s+\d{1,2}\s+years?)\b/i.test(chunk)) continue;

            let m;
            while ((m = rx.exec(chunk))) {
                matches.push({ min: parseInt(m[1], 10), max: m[2] ? parseInt(m[2], 10) : null });
            }
        }

        if (!matches.length) return { min: null, max: null };
        return matches.reduce((best, cur) => cur.min > best.min ? cur : best);
    }

    function _parseSalary(text) {
        const body = String(text || '');
        const chunks = body.split(/(?<=[.!?;])\s+|\n+/);
        const moneyRx = /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\b(?!\s*(?:billion|million|bn|m)\b)(?:\s*(?:-|\u2013|to)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b(?!\s*(?:billion|million|bn|m)\b))?/i;
        const salaryContextRx = /\b(salary|pay|compensation|base|wage|hourly|annual|annually|range)\b/i;
        const toNum = (s, isK) => {
            if (!s) return null;
            const n = Number(String(s).replace(/,/g, ''));
            if (!Number.isFinite(n)) return null;
            return Math.round(isK ? n * 1000 : n);
        };

        for (const chunk of chunks) {
            if (!salaryContextRx.test(chunk)) continue;
            const m = moneyRx.exec(chunk);
            if (!m) continue;
            const min = toNum(m[1], !!m[2]);
            const max = toNum(m[3], !!m[4]);
            if (min == null) continue;
            return { min, max: max !== null ? max : min, currency: 'USD' };
        }

        return null;
    }

    function _parseVisaText(body) {
        const sentences = body.split(/(?<=[.!?])\s+/).filter(s =>
            /\b(sponsor|sponsorship|visa|work auth|h1b|h-1b|opt|stem opt|cpt)\b/i.test(s));
        return sentences.length ? sentences.slice(0, 3).join(' ') : null;
    }

    function _parseEmploymentType() {
        // Workday exposes a structured time-type field.
        const t = _cleanWorkdayDetail(_text('[data-automation-id="time"]'), /^time\s*type\s*/i) ||
                  _text('[data-automation-id="jobFamily"]');
        if (!t) return null;
        const norm = t.toLowerCase();
        if (/full[- ]?time/.test(norm)) return 'Full-time';
        if (/part[- ]?time/.test(norm)) return 'Part-time';
        if (/contract/.test(norm)) return 'Contract';
        if (/intern/.test(norm)) return 'Internship';
        return t;
    }

    function extract() {
        if (!detect()) return null;
        // Careers landing pages list many roles - refuse to extract a single JD.
        const applyBtns = document.querySelectorAll(
            'button[id*="apply" i], a[id*="apply" i], button[class*="apply" i], a[class*="apply" i]');
        if (applyBtns.length > 4) return null;
        const title = _text('[data-automation-id="jobPostingHeader"]') ||
                      _text('h1') ||
                      _text('meta[property="og:title"], meta[name="title"]') ||
                      document.title ||
                      null;
        const loc = _cleanWorkdayDetail(_text('[data-automation-id="locations"]'), /^locations?\s*/i);
        const body = _bodyText();
        const flags = _parseLocationFlags(loc, body);

        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'workday',
            extractedAt: new Date().toISOString(),
            title,
            company: null,
            location: loc,
            locationFlags: flags,
            employmentType: _parseEmploymentType(),
            requiredYoE: _parseYoE(body),
            visaText: _parseVisaText(body),
            salaryRange: _parseSalary(body),
            descriptionText: body
        };
    }

    window.QuickApplyWorkdayJD = { detect, extract, jobKey: _jobKey };
})();
