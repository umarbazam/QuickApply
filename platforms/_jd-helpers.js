/**
 * QuickApply — Shared parsing helpers for JD extractors.
 * Greenhouse and Workday adapters keep their inlined copies (legacy);
 * new adapters (Ashby, Rippling, Workable, SmartRecruiters) use these.
 */
(function () {
    'use strict';

    function parseLocationFlags(locationStr, body) {
        const haystack = `${locationStr || ''} ${body || ''}`.toLowerCase();
        return {
            isRemote: /\bremote\b/.test(haystack) && !/\bnot\s+remote\b/.test(haystack),
            isHybrid: /\bhybrid\b/.test(haystack),
            isOnsite: /\b(on[- ]?site|in[- ]?office|in[- ]?person)\b/.test(haystack)
        };
    }

    function parseYoE(text) {
        const m = /(\d{1,2})\s*\+?\s*(?:to\s*(\d{1,2})\s*)?(?:years?|yrs?)\b/i.exec(text || '');
        if (!m) return { min: null, max: null };
        const min = parseInt(m[1], 10);
        const max = m[2] ? parseInt(m[2], 10) : null;
        return { min, max };
    }

    function parseSalary(text) {
        // Matches "$120,000", "$120k", "$120k - $150k", "$120,000-$150,000".
        // Iterates ALL dollar amounts and picks the first plausibly-salary-shaped one
        // (≥ $10,000 OR has a 'k' suffix), so ad-hoc small mentions like "$25 gift
        // card" don't get treated as the salary.
        const rx = /\$\s*([\d,]+)\s*(k)?\s*(?:(?:[-–]|to)\s*\$?\s*([\d,]+)\s*(k)?)?/gi;
        const toNum = (s, isK) => {
            if (!s) return null;
            const n = parseInt(s.replace(/,/g, ''), 10);
            return isK ? n * 1000 : n;
        };
        let m;
        while ((m = rx.exec(text || '')) !== null) {
            const min = toNum(m[1], !!m[2]);
            const max = toNum(m[3], !!m[4]);
            if (min == null || min < 10000) continue;       // skip "$25 lunch"
            return { min, max: max || min, currency: 'USD' };
        }
        return null;
    }

    function parseVisaText(body) {
        const sentences = String(body || '').split(/(?<=[.!?])\s+/).filter(s =>
            /\b(sponsor|sponsorship|visa|work auth|h1b|h-1b|opt|stem opt|cpt)\b/i.test(s)
        );
        return sentences.length ? sentences.slice(0, 3).join(' ') : null;
    }

    function parseEmploymentType(body, loc) {
        const haystack = `${body || ''} ${loc || ''}`.toLowerCase();
        if (/\bfull[- ]?time\b/.test(haystack)) return 'Full-time';
        if (/\bpart[- ]?time\b/.test(haystack)) return 'Part-time';
        if (/\bcontract(or)?\b/.test(haystack)) return 'Contract';
        if (/\binternship\b|\bintern\b/.test(haystack)) return 'Internship';
        return null;
    }

    /** Walk up from H1 to find the largest substantial text container. */
    function bodyTextNearH1(maxChars = 8000, minBlock = 500) {
        const h1 = document.querySelector('h1');
        if (!h1) return '';
        let cur = h1.parentElement;
        while (cur && cur !== document.body) {
            const txt = (cur.innerText || '').trim();
            if (txt.length > minBlock) return txt.replace(/\s+/g, ' ').slice(0, maxChars);
            cur = cur.parentElement;
        }
        return '';
    }

    /** First non-empty text from a list of CSS selectors (or meta-content for <meta>). */
    function firstTextOf(selectors) {
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (!el) continue;
            const val = el.tagName === 'META' ? el.getAttribute('content') : el.textContent;
            if (val && val.trim()) return val.trim().replace(/\s+/g, ' ');
        }
        return null;
    }

    window.QuickApplyJdHelpers = {
        parseLocationFlags, parseYoE, parseSalary, parseVisaText,
        parseEmploymentType, bodyTextNearH1, firstTextOf
    };
})();
