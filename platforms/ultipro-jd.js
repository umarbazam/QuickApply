/**
 * QuickApply — UKG Pro Recruiting (UltiPro) JD extractor.
 *
 * Live structure verified 2026-05-31 against
 *   recruiting2.ultipro.com/<tenant>/JobBoard/<boardUuid>/OpportunityDetail
 *
 * Key observations:
 *   - No JSON-LD. No data-automation-id. Knockout.js framework
 *     (`data-bind` attributes everywhere); content is rendered into
 *     `.opportunity-render-view` after `with: opportunity` binding evaluates.
 *   - Title: `<h1>` plain text; `document.title` is "<Title> | <Company>
 *     Career Opportunities".
 *   - Location: `ul.opportunity-sidebar` in the right column. Renders
 *     "Showing N locations" then a list of location names.
 *   - Posting metadata block: "Job Category: <X>", "Requisition Number: <Y>",
 *     "Posted: <date>", "Full-Time"/"Part-Time", "Hybrid"/"Remote"/"On-site",
 *     "Salary Range: $X to $Y".
 *   - Description: `<h3>Description</h3>` followed by the description body
 *     inside the same `.col-md-18` column.
 *
 * Detection: hostname `recruiting<N>.ultipro.com` + path `/OpportunityDetail`.
 */
(function () {
    'use strict';

    const HOST_RX = /^recruiting\d*\.ultipro\.com$/i;
    const PATH_RX = /\/OpportunityDetail/i;
    // Knockout's `with: opportunity` binding evaluates after document_idle on
    // most loads, so a single content-script-time extract() captures the title
    // and description (rendered early) but misses the right-column sidebar
    // (`ul.opportunity-sidebar`) that carries Posted / Salary / Locations.
    // Re-trigger JdExtractor once when the sidebar hydrates so the cache-merge
    // pass fills in those fields. Bounded to a single retry per page load.
    let _retryScheduled = false;
    function _scheduleHydrationRetry() {
        if (_retryScheduled) return;
        _retryScheduled = true;
        const start = Date.now();
        const poll = setInterval(() => {
            const ul = document.querySelector('ul.opportunity-sidebar');
            const hasMeta = ul && /Salary Range|Full[- ]Time|Part[- ]Time|Locations|Posted:/i.test(ul.innerText || '');
            const timedOut = Date.now() - start > 8000;
            if (hasMeta || timedOut) {
                clearInterval(poll);
                if (hasMeta) {
                    try { window.QuickApplyJdExtractor?.extract?.(); } catch (_) {}
                }
            }
        }, 400);
    }

    function detect() {
        return HOST_RX.test(location.hostname) && PATH_RX.test(location.pathname);
    }

    function _clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

    function _text(sel, root = document) {
        const el = root.querySelector(sel);
        return el ? _clean(el.innerText || el.textContent) : null;
    }

    function _opportunityId() {
        try {
            const u = new URL(location.href);
            return u.searchParams.get('opportunityId') || null;
        } catch (_) { return null; }
    }

    function _tenant() {
        const m = location.pathname.match(/^\/([A-Za-z0-9_-]+)\/JobBoard\//);
        return m ? m[1] : '';
    }

    function _company() {
        // Title shape: "<JobTitle> | <Company> Career Opportunities"
        const t = document.title || '';
        const m = t.match(/\|\s*(.+?)(?:\s+Career Opportunities)?$/i);
        if (m) {
            return m[1].replace(/\s+Career Opportunities\s*$/i, '').trim();
        }
        // Fallback: <ukg-application-header> or document language pack often
        // exposes the company name as the page brand.
        const brand = _text('[data-bind*="text: brand"], .navbar-brand, header [aria-label]');
        return brand || '';
    }

    function _locationStr() {
        // Right-column sidebar `ul.opportunity-sidebar.list-unstyled` has one
        // <li> per metadata row (Posted / Full-Time / Hybrid / Salary Range /
        // Locations). The Locations <li> contains:
        //   <h3 class="sr-only">Locations</h3>
        //   <div class="sr-only">Showing N location(s)</div>
        //   <div>Schaumburg Office Hoffman Estates, IL 60192, USA</div>
        //   <div>IL Hoffman Estate Office...</div>   ← duplicated address detail
        //   <a>+0 more locations</a><a>less locations</a>
        // We want the first non-sr-only DIV after the heading; if multiple
        // visible DIVs exist (multi-location postings), join them with ' / '.
        // Primary: parse the "Locations" <li> in the sidebar. Try several
        // heading text variants — UltiPro localizes the heading label.
        const LOC_HEAD_RX = /^locations?$/i;
        const heads = [...document.querySelectorAll('ul.opportunity-sidebar h3, ul.opportunity-sidebar h4, h3.sr-only, h3, h4')];
        const locHead = heads.find(h => LOC_HEAD_RX.test(_clean(h.innerText)));
        if (locHead) {
            // Siblings of the h3 inside its direct parent — the first non-sr-only
            // DIV is the clean address. Multi-location postings will surface
            // several visible DIVs; we de-dup and pick the shortest (cleanest).
            const parent = locHead.parentElement;
            if (parent) {
                const visible = [...parent.children]
                    .filter(c => c !== locHead && !c.classList.contains('sr-only') && c.tagName !== 'A')
                    .map(c => _clean(c.innerText))
                    .filter(t => t && !/^showing\s+\d+\s+locations?$/i.test(t));
                if (visible.length) {
                    // UltiPro renders the same physical location in two forms
                    // (concise + verbose with building name + street). We pull
                    // the cleanest "City, ST ZIP, Country" tail out of the
                    // verbose form so downstream geo logic gets a parseable
                    // address regardless of which form KO chose to render.
                    const seen = new Set();
                    const uniq = [];
                    for (const v of visible) {
                        const key = v.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (!seen.has(key)) { seen.add(key); uniq.push(v); }
                    }
                    // Try the shortest entry first — usually the cleanest.
                    uniq.sort((a, b) => a.length - b.length);
                    for (const candidate of uniq) {
                        // Extract trailing "City, ST ZIP, Country" tail.
                        const m = candidate.match(/([A-Z][A-Za-z. -]+,\s*[A-Z]{2,3}\s*[0-9A-Z -]*,\s*[A-Z]{2,})\s*$/);
                        if (m) return m[1].trim();
                    }
                    return uniq[0];
                }
            }
            // Last-ditch fallback: take the LI's text and strip the boilerplate.
            const li = locHead.closest('li');
            if (li) {
                return _clean(li.innerText)
                    .replace(/^locations?\s+/i, '')
                    .replace(/showing\s+\d+\s+locations?\s+/i, '')
                    .replace(/\s*\+\d+\s+more\s+locations.*/i, '')
                    .trim();
            }
        }
        return '';
    }

    function _descriptionText() {
        // Primary: KO binds the body to `<p data-bind="html: Description">`.
        // Verified live: this node holds the full posting text (~4kB on a
        // typical role). Matching on the data-bind value is far more stable
        // than the deeply-nested grid path.
        const p = document.querySelector('p[data-bind*="html: Description" i], [data-bind*="html: Description" i]');
        if (p) {
            const t = _clean(p.innerText || p.textContent);
            if (t.length > 80) return t.slice(0, 8000);
        }
        // Fallback: main column text minus the metadata prefix.
        const col = document.querySelector('#opportunityDetailView .col-md-18') || document.querySelector('.col-md-18');
        if (col) {
            let t = _clean(col.innerText);
            // Strip the "Job Details Description " prefix UltiPro renders before
            // the body proper, so downstream consumers don't see boilerplate.
            t = t.replace(/^(Job Details\s+)?Description\s+/i, '');
            if (t.length > 80) return t.slice(0, 8000);
        }
        return window.QuickApplyJdHelpers?.bodyTextNearH1?.() || '';
    }

    function _postingMeta() {
        // The right-column `ul.opportunity-sidebar` carries Posted / employment
        // type / location-flag / Salary Range as discrete <li> rows. The Job
        // Category and Requisition Number are rendered in the page header
        // above the column grid. We try the sidebar LIs first because they're
        // present even on partially-rendered pages, then layer in the header
        // metadata from `#opportunityDetailView` (or any wider container).
        const out = { fullBody: '' };
        const sidebarText = _clean(document.querySelector('ul.opportunity-sidebar')?.innerText || '');
        const wideRoot = document.querySelector('#opportunityDetailView')
            || document.querySelector('.opportunity-render-view')
            || document.querySelector('main')
            || document.body;
        const wideText = _clean(wideRoot.innerText);
        out.fullBody = [sidebarText, wideText].filter(Boolean).join(' ');
        const body = out.fullBody;
        const m1 = body.match(/Job Category:\s*([^\n|]+?)(?=\s+(?:Requisition Number|Posted|Full-Time|Part-Time|Salary Range|Apply)|$)/i);
        if (m1) out.department = m1[1].trim();
        const m2 = body.match(/Requisition Number:\s*([A-Za-z0-9-]+)/i);
        if (m2) out.requisitionNumber = m2[1].trim();
        const m3 = body.match(/Posted:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
        if (m3) out.postedAt = m3[1].trim();
        return out;
    }

    function _employmentType(body) {
        const M = body.match(/\b(Full[\s-]?Time|Part[\s-]?Time|Contract|Temporary|Intern(?:ship)?|Seasonal|Per\s*Diem)\b/i);
        if (M) {
            const v = M[1].toLowerCase().replace(/\s|-/g, '');
            if (v.includes('full')) return 'FULL_TIME';
            if (v.includes('part')) return 'PART_TIME';
            if (v.includes('contract')) return 'CONTRACTOR';
            if (v.includes('temp')) return 'TEMPORARY';
            if (v.includes('intern')) return 'INTERN';
            return M[1];
        }
        return null;
    }

    function _jobKey() {
        const tenant = _tenant();
        const id = _opportunityId();
        if (id) return `ultipro:${tenant || location.hostname}:${id}`;
        return `ultipro:${location.hostname}:${location.pathname}`;
    }

    function extract() {
        if (!detect()) return null;
        // First call schedules a hydration-time retry; subsequent calls (from
        // the retry itself) are no-ops thanks to the module-level flag.
        _scheduleHydrationRetry();
        const H = window.QuickApplyJdHelpers;
        const title = _text('h1') || (document.title || '').split('|')[0].trim();
        const location_ = _locationStr();
        const company = _company();
        const meta = _postingMeta();
        const body = _descriptionText() || meta.fullBody || '';
        if (!title && !body) return null;
        const employmentType = _employmentType(meta.fullBody || body);
        const flags = H ? H.parseLocationFlags(location_, meta.fullBody + ' ' + body)
                        : { isRemote: false, isHybrid: false, isOnsite: false };
        // UltiPro often surfaces "Hybrid" / "Remote" / "On-site" as a standalone
        // line in the posting meta — pick those up explicitly.
        if (/\bHybrid\b/i.test(meta.fullBody)) flags.isHybrid = true;
        if (/\bRemote\b/i.test(meta.fullBody)) flags.isRemote = true;
        if (/\bOn-?site\b/i.test(meta.fullBody)) flags.isOnsite = true;
        return {
            jobKey: _jobKey(),
            url: location.href,
            platform: 'ultipro',
            extractedAt: new Date().toISOString(),
            title,
            company,
            location: location_,
            locationFlags: flags,
            employmentType,
            requiredYoE: H?.parseYoE?.(body) || null,
            visaText: H?.parseVisaText?.(body) || null,
            salaryRange: H?.parseSalary?.(meta.fullBody + ' ' + body) || null,
            descriptionText: body,
            department: meta.department || null,
            requisitionNumber: meta.requisitionNumber || null
        };
    }

    window.QuickApplyUltiProJD = { detect, extract, jobKey: _jobKey };
})();
