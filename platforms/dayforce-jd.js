/**
 * QuickApply — Ceridian Dayforce JD extractor.
 *
 * Dayforce candidate portals are Next.js apps at jobs.dayforcehcm.com/<lang>/<tenant>/
 * CANDIDATEPORTAL/jobs/<id>. There is NO JSON-LD, but Next.js embeds the page data in
 * <script id="__NEXT_DATA__">…props.pageProps…</script> — the authoritative source.
 * DOM fallbacks: h1.ant-typography (title), span.ant-typography-secondary (location),
 * the "Job Description" H2 section (body).
 */
(function () {
    'use strict';

    const HOST_RX = /dayforcehcm\.com$/i;

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        // JD detail page only (…/jobs/<id> and …/jobs/<id>/...), not the bare portal home.
        if (!/\/CANDIDATEPORTAL\/jobs\/\d+/i.test(location.pathname)) return false;
        // Don't fire the JD card on the application form itself.
        if (/\/apply\//i.test(location.pathname)) return false;
        return true;
    }

    function _nextData() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return null;
            return JSON.parse(el.textContent || '{}');
        } catch (_) { return null; }
    }

    // Deep-search the Next.js pageProps for the first object that looks like a job
    // posting (has a title-ish + description-ish field). Shapes vary by Dayforce
    // version, so match on key names rather than a fixed path.
    function _findPosting(root) {
        const seen = new Set();
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node);
            const keys = Object.keys(node);
            const hasTitle = keys.find(k => /^(title|jobTitle|name|postingTitle)$/i.test(k) && typeof node[k] === 'string');
            const hasDesc = keys.find(k => /(description|jobDescription|details|body)/i.test(k) && typeof node[k] === 'string' && node[k].length > 120);
            if (hasTitle && hasDesc) return node;
            for (const k of keys) { const v = node[k]; if (v && typeof v === 'object') stack.push(v); }
        }
        return null;
    }

    function _strip(html) {
        if (!html || typeof html !== 'string') return '';
        if (!/[<>]/.test(html)) return html.replace(/\s+/g, ' ').trim();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return (tmp.innerText || tmp.textContent || '').replace(/\s+\n/g, '\n').trim();
    }

    function _text(sel) {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    // Location from the secondary-typography address span (e.g. "340 College St,
    // Toronto, ON M5T 3A9, Canada") — collapse to "Toronto, ON, Canada"-ish.
    function _domLocation() {
        const spans = Array.from(document.querySelectorAll('span.ant-typography-secondary, .ant-typography-secondary'));
        for (const s of spans) {
            const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && /,/.test(t) && /[A-Za-z]/.test(t) && t.length < 120) return t;
        }
        return '';
    }

    // Body from the "Job Description" section heading's container, falling back to helper.
    function _domBody() {
        const h2s = Array.from(document.querySelectorAll('h2, h3'));
        const jd = h2s.find(h => /job description|description/i.test(h.textContent || ''));
        if (jd) {
            const container = jd.parentElement;
            const txt = (container?.innerText || '').replace(/\s+\n/g, '\n').trim();
            if (txt && txt.length > 150) return txt.slice(0, 8000);
        }
        return (window.QuickApplyJdHelpers?.bodyTextNearH1?.() || '').slice(0, 8000);
    }

    function _jobId() { const m = location.pathname.match(/\/jobs\/(\d+)/); return m ? m[1] : null; }
    function _tenant() { const m = location.pathname.match(/\/([^/]+)\/CANDIDATEPORTAL\//i); return m ? m[1] : location.hostname; }
    function _jobKey() {
        const id = _jobId();
        return id ? `dayforce:${_tenant()}:${id}` : `dayforce:${location.hostname}:${location.pathname}`;
    }

    // i18n/template placeholders that leak out of __NEXT_DATA__ (Spanish/French field
    // labels: Nombre=Name, Pais=Country, Titre=Title…). Reject these so they never
    // become the title/location.
    const PLACEHOLDER_RX = /^(nombre|país|pais|titre|titulo|título|ville|ort|land|stadt|name|title|country|city|state|province|location)$/i;
    const _ok = v => typeof v === 'string' && v.trim() && !PLACEHOLDER_RX.test(v.trim());

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const nd = _nextData();
        const posting = nd ? _findPosting(nd.props?.pageProps || nd.props || nd) : null;

        // DOM-FIRST: the rendered page is authoritative. __NEXT_DATA__ is a fallback
        // only — its deep structure also holds i18n label objects that look like
        // postings (title:"Nombre"), so trusting it first produced bogus cards.
        const domTitle = _text('h1.ant-typography') || _text('h1');
        const ndTitle = posting && (posting.title || posting.jobTitle || posting.postingTitle || posting.name);
        const title = (_ok(domTitle) && domTitle)
            || (_ok(ndTitle) && ndTitle)
            || ((document.title.split('|')[0] || '').trim());

        const domLoc = _domLocation();
        let ndLoc = '';
        if (posting) {
            ndLoc = posting.location || posting.jobLocation || posting.city
                || [posting.city, posting.state || posting.province, posting.country].filter(Boolean).join(', ');
            if (ndLoc && typeof ndLoc === 'object') ndLoc = ndLoc.name || ndLoc.displayName || '';
        }
        const location_ = (_ok(domLoc) && domLoc) || (_ok(ndLoc) && ndLoc) || '';

        const company = (posting && [posting.companyName, posting.company, posting.organizationName,
                posting.clientName, posting.legalEntityName].find(_ok))
            || (() => { const t = document.title.split('|'); return t.length > 1 && _ok(t[1]) && !/dayforce/i.test(t[1]) ? t[1].trim() : ''; })();

        const domBody = _domBody();
        const descRaw = posting && (posting.description || posting.jobDescription || posting.details || posting.body);
        const body = (domBody && domBody.length > 200 ? domBody : null) || (descRaw && _strip(descRaw)) || domBody;

        if (!title && !body) return null;
        const flags = H ? H.parseLocationFlags(location_, body) : { isRemote: false, isHybrid: false, isOnsite: false };

        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'dayforce',
            extractedAt: new Date().toISOString(),
            title: title || '',
            company: company || '',
            location: location_ || '',
            locationFlags: flags,
            employmentType: (posting && (posting.employmentType || posting.jobType))
                || H?.parseEmploymentType?.(body, location_) || null,
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            salaryRange: H?.parseSalary?.(body) || null,
            descriptionText: body || ''
        };
    }

    window.QuickApplyDayforceJD = { detect, extract, jobKey: _jobKey };
})();
