/**
 * QuickApply — TikTok / ByteDance careers JD extractor.
 *
 * TikTok posts jobs on `lifeattiktok.com/search/<jobId>` (the marketing-styled
 * JD page) and accepts applications on `careers.tiktok.com/resume/<jobId>/apply`.
 * The site is a Next.js App-Router app — no JSON-LD, no `__NEXT_DATA__`; the
 * payload streams via `self.__next_f`. So extraction is DOM-based.
 *
 * Stable hooks:
 *   - <h2> holds the job title (also mirrored in og:title).
 *   - Job-meta rows render as <div><p>Label:</p><p>Value</p></div> with stable
 *     label TEXT ("Location:", "Employment Type:", "Job Code:"). Class names are
 *     Tailwind/CSS-module hashes — never key on them.
 *   - Rich-text blocks carry the stable `.editor-content` class.
 */
(function () {
    'use strict';

    const HOST_RX = /(^|\.)(lifeattiktok\.com|careers\.tiktok\.com)$/i;

    function _jobId() {
        // /search/<id>, /position/<id>, /resume/<id>/apply
        const m = location.pathname.match(/\/(?:search|position|resume)\/(\d+)/);
        return m ? m[1] : null;
    }

    function _jobKey() {
        const id = _jobId();
        return id ? `tiktok:${id}` : `tiktok:${location.pathname}`;
    }

    function detect() {
        if (!HOST_RX.test(location.hostname)) return false;
        // JD detail page only — NOT the /resume/<id>/apply form page (that's
        // the filler's territory). Require a job id in the path and a title h2.
        if (/\/resume\/\d+\/apply/.test(location.pathname)) return false;
        if (!/\/(search|position)\/\d+/.test(location.pathname)) return false;
        return !!document.querySelector('h2');
    }

    // Job-meta rows: <div class="flex gap-1"><p class="font-[700]">Location:</p>
    //                <p class="font-[400]">Seattle</p></div>
    // Find the bold label <p> by its (colon-stripped, case-insensitive) text and
    // return the next sibling <p>'s text.
    function _metaValue(label) {
        const want = label.toLowerCase();
        const ps = document.querySelectorAll('p');
        for (const p of ps) {
            const t = (p.textContent || '').replace(/\s+/g, ' ').trim().replace(/:\s*$/, '').toLowerCase();
            if (t === want) {
                const valEl = p.nextElementSibling;
                const v = valEl ? (valEl.textContent || '').trim() : '';
                if (v) return v;
            }
        }
        return '';
    }

    // JD section headings TikTok renders as standalone <p>/<h*> nodes above
    // their content container. The actual Responsibilities / Qualifications
    // text is NOT inside `.editor-content` (that class wraps only the salary
    // disclosure and company blurbs) — it sits in a sibling container, so we
    // collect both: section-header parents AND every `.editor-content` block.
    const _SECTION_RX = /^(responsibilities|qualifications|preferred qualifications|minimum qualifications|requirements|about( the team| us)?|what you('|’)ll do|who (we are looking for|you are))\s*:?$/i;

    function _bodyText() {
        const blocks = [];
        const seen = new Set();
        const push = (txt) => {
            const t = (txt || '').replace(/​/g, '').replace(/[ \t]+\n/g, '\n').trim();
            if (t && t.length > 40 && !seen.has(t)) { seen.add(t); blocks.push(t); }
        };
        // Section blocks — a header node whose text is a known JD section name;
        // take its parent container's full text (header + body).
        for (const h of document.querySelectorAll('p, h1, h2, h3, h4')) {
            if (h.children.length === 0 && _SECTION_RX.test((h.textContent || '').trim())) {
                push(h.parentElement?.innerText || h.parentElement?.textContent);
            }
        }
        // Rich-text blocks (salary disclosure, company / mission blurbs).
        for (const ec of document.querySelectorAll('.editor-content')) {
            push(ec.innerText || ec.textContent);
        }
        if (blocks.length) return blocks.join('\n\n').slice(0, 9000);
        return window.QuickApplyJdHelpers?.bodyTextNearH1?.() || '';
    }

    function extract() {
        if (!detect()) return null;
        const H = window.QuickApplyJdHelpers;
        const title = document.querySelector('h2')?.textContent?.trim()
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || document.querySelector('h1')?.textContent?.trim();
        const location_ = _metaValue('Location');
        const employmentType = _metaValue('Employment Type');
        const body = _bodyText();
        if (!title && !body) return null;
        const flags = H ? H.parseLocationFlags(location_, body) : null;
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'tiktok',
            extractedAt: new Date().toISOString(),
            title,
            company: 'TikTok',
            location: location_,
            locationFlags: flags,
            employmentType: employmentType || (H?.parseEmploymentType?.(body, location_) || null),
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            // TikTok JDs print "The base salary range for this position ... is
            // $124717 - $243200 annually." — parseSalary picks that up.
            salaryRange: H?.parseSalary?.(body) || null,
            descriptionText: body
        };
    }

    window.QuickApplyTikTokJD = { detect, extract, jobKey: _jobKey };
})();
