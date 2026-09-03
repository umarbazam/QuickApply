/**
 * QuickApply — CV/Resume Parser (Production Grade)
 * Feature 5: Extract profile data from uploaded PDF/DOCX resumes.
 * Client-side only — no network requests.
 *
 * Uses Mozilla pdf.js for reliable PDF text extraction.
 *
 * Architecture:
 *   1. Text Extraction  — pdf.js (PDF) or ZIP/XML (DOCX)
 *   2. Line Assembly     — position-aware reconstruction with Y-coordinate grouping
 *   3. Section Detection — classifies resume into labeled sections
 *   4. Field Extraction  — multi-strategy regex per field with scoring
 *   5. Entry-based Education/Job parsing — finds individual entries, parses each, picks best
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZE PDF.JS WORKER
    // ═══════════════════════════════════════════════════════════════════

    function initPdfJs() {
        if (typeof pdfjsLib === 'undefined') return false;
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
            } else {
                pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    const hasPdfJs = initPdfJs();

    // ═══════════════════════════════════════════════════════════════════
    // MAIN ENTRY
    // ═══════════════════════════════════════════════════════════════════

    async function parseFile(file) {
        if (!file) throw new Error('No file provided');

        const arrayBuffer = await file.arrayBuffer();
        let rawText = '';

        const ext = file.name.split('.').pop().toLowerCase();
        const mime = file.type || '';

        if (ext === 'pdf' || mime.includes('pdf')) {
            rawText = await extractTextFromPDF(arrayBuffer);
        } else if (ext === 'docx' || mime.includes('wordprocessingml') || mime.includes('openxmlformats')) {
            rawText = await extractTextFromDOCX(arrayBuffer);
        } else if (ext === 'txt' || mime.includes('text/plain')) {
            rawText = new TextDecoder().decode(arrayBuffer);
        } else {
            try { rawText = await extractTextFromPDF(arrayBuffer); }
            catch { rawText = new TextDecoder().decode(arrayBuffer); }
        }

        if (!rawText || rawText.trim().length < 10) {
            return {
                success: false, fields: {}, rawText: '', extractedCount: 0,
                error: 'Could not extract text from file. The file may be scanned/image-based or corrupted.'
            };
        }

        rawText = normalizeText(rawText);
        const fields = extractAllFields(rawText);

        // Notify Universal Field Registry about discovered fields
        if (typeof QuickApplyLearning !== 'undefined' && QuickApplyLearning.recordDiscoveredFields) {
            try { QuickApplyLearning.recordDiscoveredFields(fields); } catch (e) { /* ignore */ }
        }

        return {
            success: true, fields, rawText,
            extractedCount: Object.values(fields).filter(v => v).length,
            textLength: rawText.length
        };
    }

    function normalizeText(text) {
        return text
            .replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ')
            .replace(/\u00a0/g, ' ')
            .replace(/\u2022|\u25cf|\u25cb|\u25aa|\u25ab/g, '•')
            .replace(/\u2013/g, '–').replace(/\u2014/g, '—')
            .replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"')
            .replace(/\ufeff/g, '').replace(/[ ]{4,}/g, '   ').trim();
    }

    // ═══════════════════════════════════════════════════════════════════
    // PDF TEXT EXTRACTION — pdf.js primary
    // ═══════════════════════════════════════════════════════════════════

    async function extractTextFromPDF(arrayBuffer) {
        if (hasPdfJs || typeof pdfjsLib !== 'undefined') {
            try {
                const result = await extractWithPdfJs(arrayBuffer);
                if (result && result.trim().length > 20) return result;
            } catch (e) {
                console.warn('[QuickApply] pdf.js extraction failed:', e.message);
            }
        }
        return extractPDFTextBasic(arrayBuffer);
    }

    async function extractWithPdfJs(arrayBuffer) {
        const pdf = await pdfjsLib.getDocument({
            data: arrayBuffer, useSystemFonts: true,
            disableFontFace: true, useWorkerFetch: false
        }).promise;

        const allPages = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });

            if (!textContent.items || textContent.items.length === 0) continue;

            const Y_TOLERANCE = 3;
            const lineGroups = new Map();

            for (const item of textContent.items) {
                if (!item.str || item.str.trim().length === 0) continue;

                const tx = item.transform;
                const x = tx[4];
                const y = viewport.height - tx[5];

                let foundKey = null;
                for (const [key] of lineGroups) {
                    if (Math.abs(key - y) <= Y_TOLERANCE) { foundKey = key; break; }
                }

                if (foundKey !== null) {
                    lineGroups.get(foundKey).push({ x, text: item.str, width: item.width || 0 });
                } else {
                    lineGroups.set(y, [{ x, text: item.str, width: item.width || 0 }]);
                }
            }

            const sortedLines = [...lineGroups.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, items]) => {
                    items.sort((a, b) => a.x - b.x);
                    let lineText = '';
                    for (let i = 0; i < items.length; i++) {
                        if (i > 0) {
                            const gap = items[i].x - (items[i - 1].x + items[i - 1].width);
                            if (gap > 30) lineText += '   ';
                            else if (gap > 3) lineText += ' ';
                        }
                        lineText += items[i].text;
                    }
                    return lineText.trim();
                })
                .filter(line => line.length > 0);

            allPages.push(sortedLines.join('\n'));
        }

        return allPages.join('\n\n');
    }

    function extractPDFTextBasic(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        // Use TextDecoder for performance — avoids O(n) string concat of the old char loop
        let rawStr;
        try {
            rawStr = new TextDecoder('latin1').decode(bytes);
        } catch (e) {
            // Fallback for very old environments
            let s = '';
            for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            rawStr = s;
        }

        let text = '';
        const btEtRegex = /BT\s([\s\S]*?)ET/g;
        let btMatch;
        while ((btMatch = btEtRegex.exec(rawStr)) !== null) {
            const block = btMatch[1];
            const tjRegex = /\(([^)]*)\)\s*Tj/g;
            let tjMatch;
            while ((tjMatch = tjRegex.exec(block)) !== null) text += decodePDFStr(tjMatch[1]) + ' ';
            const tjArrRegex = /\[(.*?)\]\s*TJ/gi;
            let tjArrMatch;
            while ((tjArrMatch = tjArrRegex.exec(block)) !== null) {
                const sp = /\(([^)]*)\)/g; let sm;
                while ((sm = sp.exec(tjArrMatch[1])) !== null) text += decodePDFStr(sm[1]);
                text += ' ';
            }
            text += '\n';
        }

        if (text.trim().length < 50) {
            const runs = rawStr.match(/[\x20-\x7E]{12,}/g) || [];
            text = runs.filter(r => !/obj|endobj|\/Type|\/Font|stream|\/Length|\/Filter|xref|trailer/.test(r)).join('\n');
        }
        return text.trim();
    }

    function decodePDFStr(s) {
        return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
            .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
    }

    // ═══════════════════════════════════════════════════════════════════
    // DOCX TEXT EXTRACTION
    // ═══════════════════════════════════════════════════════════════════

    async function extractTextFromDOCX(arrayBuffer) {
        try {
            const files = await unzipBasic(arrayBuffer);
            const docXml = files['word/document.xml'] || files['word\\document.xml'];
            if (!docXml) throw new Error('No document.xml');
            const xmlText = new TextDecoder().decode(docXml);
            return xmlText
                .replace(/<w:p\b[^>]*\/>/g, '\n').replace(/<w:p\b[^>]*>/g, '\n')
                .replace(/<\/w:p>/g, '').replace(/<w:tab[^>]*\/>/g, '\t')
                .replace(/<w:br[^>]*\/>/g, '\n').replace(/<w:cr[^>]*\/>/g, '\n')
                .replace(/<w:sym[^>]*w:char="([^"]+)"[^>]*\/>/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
                .replace(/\n{3,}/g, '\n\n').trim();
        } catch (e) { return ''; }
    }

    async function unzipBasic(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const files = {}; let offset = 0;
        while (offset + 30 < bytes.length) {
            if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4B ||
                bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) break;
            const view = new DataView(arrayBuffer, offset);
            const comp = view.getUint16(8, true);
            const compSize = view.getUint32(18, true);
            const fnLen = view.getUint16(26, true);
            const exLen = view.getUint16(28, true);
            const fn = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + fnLen));
            const ds = offset + 30 + fnLen + exLen;
            if (ds + compSize > bytes.length) break;
            const data = bytes.slice(ds, ds + compSize);
            if (fn.endsWith('.xml') || fn.endsWith('.rels')) {
                if (comp === 0) files[fn] = data;
                else if (comp === 8) { try { files[fn] = await deflate(data); } catch { files[fn] = data; } }
            }
            offset = ds + compSize;
        }
        return files;
    }

    async function deflate(data) {
        if (typeof DecompressionStream === 'undefined') return data;
        const ds = new DecompressionStream('raw');
        const w = ds.writable.getWriter(); const r = ds.readable.getReader();
        w.write(data); w.close();
        const chunks = []; while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(total); let p = 0;
        for (const c of chunks) { result.set(c, p); p += c.length; }
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // SECTION DETECTION
    // ═══════════════════════════════════════════════════════════════════

    const SECTION_PATTERNS = {
        contact: /^(?:contact(?:\s+(?:info(?:rmation)?|details?))?|personal\s+(?:info(?:rmation)?|details?))\s*[:\-–—]?\s*$/i,
        summary: /^(?:summary|profile|objective|about(?:\s+me)?|(?:professional|career|executive)\s+(?:summary|objective|profile)|personal\s+statement)\s*[:\-–—]?\s*$/i,
        experience: /^(?:(?:work(?:ing)?|professional|relevant|career)\s+)?(?:experience|history|employment(?:\s+history)?)\s*[:\-–—]?\s*$/i,
        education: /^(?:education(?:al)?(?:\s+(?:background|history|qualifications?))?|academic\s+(?:background|history|qualifications?)|qualifications?)\s*[:\-–—]?\s*$/i,
        skills: /^(?:(?:technical\s+|core\s+|key\s+|relevant\s+)?skills?|(?:core\s+)?competenc(?:ies|y)|proficienc(?:ies|y)|technologies|tech(?:nical)?\s+stack|tools?\s*(?:&|and)?\s*tech(?:nologies)?|areas?\s+of\s+expertise)\s*[:\-–—]?\s*$/i,
        certifications: /^(?:(?:professional\s+)?certifications?|licenses?\s*(?:&|and)?\s*certifications?|credentials?|professional\s+development)\s*[:\-–—]?\s*$/i,
        projects: /^(?:(?:personal|key|selected|notable|relevant)\s+)?projects?\s*[:\-–—]?\s*$/i,
        languages: /^(?:languages?(?:\s+(?:skills?|proficiency|known|spoken))?|spoken\s+languages?)\s*[:\-–—]?\s*$/i,
        awards: /^(?:awards?(?:\s*(?:&|and)?\s*honors?)?|honors?|achievements?|accomplishments?)\s*[:\-–—]?\s*$/i,
        interests: /^(?:interests?|hobbies|activities|extracurricular(?:\s+activities)?)\s*[:\-–—]?\s*$/i,
        references: /^(?:references?|referees?)\s*[:\-–—]?\s*$/i,
        publications: /^(?:publications?|research|papers?)\s*[:\-–—]?\s*$/i,
        volunteer: /^(?:volunteer(?:ing)?(?:\s+experience)?|community\s+(?:service|involvement))\s*[:\-–—]?\s*$/i
    };

    function splitSections(text) {
        const lines = text.split('\n');
        const sections = { _header: [] };
        let cur = '_header';

        for (const line of lines) {
            const t = line.trim();
            if (!t) { (sections[cur] || []).push(line); continue; }

            let matched = false;
            for (const [name, re] of Object.entries(SECTION_PATTERNS)) {
                if (re.test(t)) { cur = name; sections[cur] = sections[cur] || []; matched = true; break; }
            }

            if (!matched && t.length >= 3 && t.length <= 45) {
                const isCaps = t === t.toUpperCase() && /[A-Z]/.test(t);
                const isTitle = /^[A-Z][a-z]/.test(t) && t.split(/\s+/).length <= 4 && !/\d/.test(t);
                if (isCaps || isTitle) {
                    const cleaned = t.toLowerCase().replace(/[:\-–—|]/g, '').trim();
                    for (const [name, re] of Object.entries(SECTION_PATTERNS)) {
                        if (re.test(cleaned) || re.test(cleaned + ':')) {
                            cur = name; sections[cur] = sections[cur] || []; matched = true; break;
                        }
                    }
                }
            }

            if (!matched) { sections[cur] = sections[cur] || []; sections[cur].push(line); }
        }

        const result = {};
        for (const [k, v] of Object.entries(sections)) result[k] = Array.isArray(v) ? v.join('\n').trim() : v;
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // FIELD EXTRACTION ORCHESTRATOR
    // ═══════════════════════════════════════════════════════════════════

    function extractAllFields(rawText) {
        const sections = splitSections(rawText);
        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const headerText = sections._header || '';
        const topBlock = lines.slice(0, Math.min(lines.length, 15)).join('\n');
        const contactSource = [headerText, sections.contact || ''].join('\n');

        const result = {};

        const name = extractName(lines, topBlock);
        if (name.firstName) result.firstName = name.firstName;
        if (name.lastName) result.lastName = name.lastName;
        result.email = extractEmail(contactSource, rawText);
        result.phone = extractPhone(contactSource, rawText);
        Object.assign(result, extractLinks(rawText));
        Object.assign(result, extractAddress(contactSource, topBlock));
        Object.assign(result, extractEducation(sections.education, rawText));
        result.skills = extractSkills(sections.skills, rawText);
        Object.assign(result, extractProfessional(sections.experience, rawText));
        result.certifications = extractCertifications(sections.certifications, rawText);
        result.languages = extractLanguages(sections.languages, rawText);

        for (const [k, v] of Object.entries(result)) {
            if (!v || (typeof v === 'string' && !v.trim())) delete result[k];
        }

        return result;
    }

    // ─── NAME ────────────────────────────────────────────────────────────

    function extractName(lines, topBlock) {
        const candidates = [];

        // Strategy A: Labeled
        const labeled = topBlock.match(/(?:full\s*name|name|applicant|candidate)\s*[:\-–—|]\s*([A-Za-z][A-Za-z.\-'\s]{2,40})/i);
        if (labeled) candidates.push({ text: labeled[1].trim(), score: 12 });

        // Strategy B: First name-like lines
        for (let i = 0; i < Math.min(lines.length, 8); i++) {
            const line = lines[i];
            if (line.includes('@') || /https?:|www\./i.test(line)) continue;
            if (/\d{3}/.test(line)) continue;
            if (/^(resume|curriculum|cv|cover|letter|phone|email|address|objective|summary|profile|page)/i.test(line)) continue;
            if (line.length > 50 || line.length < 3) continue;

            const words = line.split(/\s+/).filter(w => w.length >= 1);
            if (words.length < 2 || words.length > 5) continue;
            if (!words.every(w => /^[A-Za-z'.,-]+$/.test(w))) continue;

            let score = 8 - i;
            if (words.every(w => /^[A-Z]/.test(w))) score += 4;
            if (line === line.toUpperCase() && /[A-Z]/.test(line)) score += 3;
            if (words.length === 2 || words.length === 3) score += 2;

            const lower = line.toLowerCase();
            for (const re of Object.values(SECTION_PATTERNS)) { if (re.test(lower)) { score -= 10; break; } }

            if (score > 0) {
                candidates.push({
                    text: (line === line.toUpperCase()) ? titleCase(line.trim()) : line.trim(),
                    score
                });
            }
        }

        // Strategy C: From email prefix
        if (candidates.length === 0) {
            const em = topBlock.match(/([a-zA-Z0-9._%+-]+)@/);
            if (em) {
                const parts = em[1].split(/[._\-+]/);
                if (parts.length >= 2 && parts[0].length > 1 && parts[parts.length - 1].length > 1) {
                    candidates.push({ text: `${titleCase(parts[0])} ${titleCase(parts[parts.length - 1])}`, score: 1 });
                }
            }
        }

        if (candidates.length === 0) return {};
        candidates.sort((a, b) => b.score - a.score);
        const words = candidates[0].text.split(/\s+/);
        return { firstName: words[0], lastName: words.slice(1).join(' ') };
    }

    function titleCase(str) {
        // Only lowercase words that are ALL-CAPS (screaming case from PDF headers).
        // Preserve already-mixed-case words (McDonald, O'Brien, etc.).
        return str.replace(/\b\S+\b/g, word =>
            word === word.toUpperCase() && word.length > 1
                ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                : word
        );
    }

    // ─── EMAIL ───────────────────────────────────────────────────────────

    function extractEmail(contactText, fullText) {
        const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const all = [];
        let m;
        while ((m = emailRe.exec(contactText)) !== null) all.push(m[0].toLowerCase());
        if (all.length === 0) { emailRe.lastIndex = 0; while ((m = emailRe.exec(fullText)) !== null) all.push(m[0].toLowerCase()); }
        if (all.length === 0) return null;
        if (all.length === 1) return all[0];
        const personal = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'protonmail.com', 'live.com', 'mail.com'];
        return all.find(e => personal.some(d => e.endsWith('@' + d))) || all[0];
    }

    // ─── PHONE ───────────────────────────────────────────────────────────

    function extractPhone(contactText, fullText) {
        const labeled = [
            /(?:phone|tel(?:ephone)?|cell|mobile|contact\s*(?:no|number)?)\s*[:\-–—|#]\s*(\+?[\d\s.\-()+]{7,20})/i,
            /(?:ph|mob)\s*[:\-–—|]\s*(\+?[\d\s.\-()+]{7,20})/i
        ];
        for (const text of [contactText, fullText]) {
            for (const pat of labeled) {
                const m = text.match(pat);
                if (m) { const d = m[1].trim().replace(/\D/g, ''); if (d.length >= 7 && d.length <= 15) return m[1].trim(); }
            }
        }
        const patterns = [
            /\+1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
            /\(?[2-9]\d{2}\)[-.\s]?\d{3}[-.\s]?\d{4}/,
            /\+\d{1,3}[-.\s]?\d{2,5}[-.\s]?\d{4,8}/,
            /\d{3}[-.\s]\d{3}[-.\s]\d{4}/,
            /\+\d{1,3}\s\(\d{2,4}\)\s\d{3,4}[-.\s]?\d{4}/
        ];
        for (const text of [contactText, fullText]) {
            for (const pat of patterns) {
                const m = text.match(pat);
                if (m) { const d = m[0].replace(/\D/g, ''); if (d.length >= 7 && d.length <= 15) return m[0].trim(); }
            }
        }
        return null;
    }

    // ─── LINKS ───────────────────────────────────────────────────────────

    function extractLinks(text) {
        const result = {};
        const li = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_\-]+)\/?/i);
        if (li) result.linkedIn = `https://linkedin.com/in/${li[1]}`;
        const gh = text.match(/(?:https?:\/\/)?github\.com\/([a-zA-Z0-9_\-]+)\/?/i);
        if (gh && !['topics', 'settings', 'features', 'login', 'signup', 'about'].includes(gh[1])) result.github = `https://github.com/${gh[1]}`;
        const urls = text.match(/https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}[^\s,)'"<>]*/gi) || [];
        const exclude = ['linkedin.com', 'github.com', 'indeed.com', 'glassdoor.com', 'google.com', 'fonts.googleapis.com', 'w3.org', 'facebook.com', 'twitter.com', 'instagram.com'];
        const p = urls.find(u => !exclude.some(d => u.includes(d)));
        if (p) result.portfolio = p;
        else { const lbl = text.match(/(?:portfolio|website|personal\s+site|blog)\s*[:\-–—|]\s*(https?:\/\/[^\s,]+)/i); if (lbl) result.portfolio = lbl[1]; }
        return result;
    }

    // ─── ADDRESS ─────────────────────────────────────────────────────────

    const US_STATES = {
        'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
        'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
        'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
        'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
        'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri',
        'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
        'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
        'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
        'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
        'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'
    };

    function extractAddress(contactText, topBlock) {
        const text = contactText + '\n' + topBlock;
        const result = {};
        const csz = text.match(/([A-Z][a-zA-Z\s.]{1,25}),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?/);
        if (csz && US_STATES[csz[2]]) { result.city = csz[1].trim(); result.state = US_STATES[csz[2]]; if (csz[3]) result.zipCode = csz[3]; }
        if (!result.city) {
            for (const [name] of Object.entries(US_STATES)) {
                const m = text.match(new RegExp(`([A-Z][a-zA-Z\\s]{1,25}),\\s*${name}\\b`, 'i'));
                if (m) { result.city = m[1].trim(); result.state = name; break; }
            }
        }
        if (!result.city) {
            const lbl = text.match(/(?:location|city|address|based\s+in)\s*[:\-–—|]\s*([^\n]{3,60})/i);
            if (lbl) { const pts = lbl[1].split(',').map(s => s.trim()); if (pts.length >= 2) { result.city = pts[0]; result.state = pts[1]; } else result.city = lbl[1]; }
        }
        const st = text.match(/(\d{1,5}\s+(?:[A-Za-z]+\s+){1,4}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Dr(?:ive)?|Rd|Road|Ln|Lane|Way|Ct|Court|Circle|Pl(?:ace)?|Pkwy)\b[^,\n]*)/i);
        if (st) result.streetAddress = st[1].trim();
        const countries = { 'united states': 'United States', 'usa': 'United States', 'canada': 'Canada', 'united kingdom': 'United Kingdom', 'uk': 'United Kingdom', 'australia': 'Australia', 'india': 'India', 'pakistan': 'Pakistan', 'germany': 'Germany' };
        const lt = text.toLowerCase();
        for (const [k, v] of Object.entries(countries)) { if (lt.includes(k)) { result.country = v; break; } }
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // EDUCATION — Entry-based structured parsing
    // ═══════════════════════════════════════════════════════════════════

    const DEGREE_HIERARCHY = [
        { level: 5, value: 'Doctorate', re: /\b(?:ph\.?d\.?|doctorate|doctor\s+of\s+(?:philosophy|education|business)|d\.?phil|ed\.?d)\b/i },
        { level: 4, value: "Master's", re: /\b(?:master'?s?|m\.?s\.?c?\.?|m\.?a\.?|m\.?b\.?a\.?|m\.?eng\.?|m\.?tech\.?|m\.?phil\.?|m\.?ed\.?|master\s+of\s+\w+)\b/i },
        { level: 3, value: "Bachelor's", re: /\b(?:bachelor'?s?|b\.?s\.?c?\.?|b\.?a\.?|b\.?eng\.?|b\.?tech\.?|b\.?b\.?a\.?|b\.?com\.?|b\.?ed\.?|bachelor\s+of\s+\w+)\b/i },
        { level: 2, value: "Associate's", re: /\b(?:associate'?s?|a\.?s\.?|a\.?a\.?|a\.?a\.?s\.?|associate\s+(?:of|in)\s+\w+)\b/i },
        { level: 1, value: 'High School', re: /\b(?:high\s+school|diploma|ged|secondary\s+school|h\.?s\.?d\.?)\b/i }
    ];

    const UNI_RE = [
        /(?:University|College|Institute|School|Academy)\s+of\s+(?:the\s+)?[A-Z][A-Za-z\s,]{2,40}/,
        /[A-Z][A-Za-z\s.]{2,30}\s+(?:University|College|Institute|Polytechnic|Academy)\b/,
        /\b(?:MIT|Stanford|Harvard|Yale|Princeton|Berkeley|UCLA|NYU|CMU|Caltech|Georgia\s+Tech|Oxford|Cambridge|IIT(?:\s+[A-Z][a-z]+)?|LUMS|NUST|FAST|COMSATS|PIEAS|GIKI|NED|UET|BITS|NIT|IIIT)\b/
    ];

    function extractEducation(sectionText, fullText) {
        const text = sectionText || fullText;
        if (!text || text.length < 10) return {};

        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // ── Step 1: Split into individual education entries ──
        // Boundary = line containing a degree keyword OR a university name
        const entries = [];
        let cur = [];

        for (const line of lines) {
            const hasDegree = DEGREE_HIERARCHY.some(d => d.re.test(line));
            const hasUni = UNI_RE.some(p => p.test(line));
            const hasYear = /\b(?:19|20)\d{2}\b/.test(line) && /[-–—]/.test(line);

            // New entry if this line has a degree or university marker and we already have content
            if ((hasDegree || hasUni) && cur.length > 0) {
                entries.push(cur.join('\n'));
                cur = [line];
            } else {
                cur.push(line);
            }
        }
        if (cur.length > 0) entries.push(cur.join('\n'));
        if (entries.length === 0) entries.push(lines.join('\n'));

        // ── Step 2: Parse each entry ──
        const parsed = entries.map(parseOneEducation);

        // ── Step 3: Pick highest degree, then fill gaps from other entries ──
        parsed.sort((a, b) => (b._level || 0) - (a._level || 0));
        const best = parsed[0] || {};

        const result = {};
        if (best.degree) result.highestEducation = best.degree;
        if (best.university) result.university = best.university;
        if (best.major) result.major = best.major;
        if (best.gpa) result.gpa = best.gpa;
        if (best.year) result.graduationYear = best.year;

        // Fill gaps from other entries
        for (const entry of parsed) {
            if (!result.university && entry.university) result.university = entry.university;
            if (!result.major && entry.major) result.major = entry.major;
            if (!result.gpa && entry.gpa) result.gpa = entry.gpa;
            if (!result.graduationYear && entry.year) result.graduationYear = entry.year;
        }

        return result;
    }

    function parseOneEducation(text) {
        const e = { _level: 0 };

        // Degree
        for (const { level, value, re } of DEGREE_HIERARCHY) {
            if (re.test(text)) { e.degree = value; e._level = level; break; }
        }

        // University
        for (const re of UNI_RE) {
            const m = text.match(re);
            if (m && m[0].length > 2 && m[0].length < 60) { e.university = m[0].trim(); break; }
        }
        if (!e.university) {
            const lbl = text.match(/(?:university|school|college|institution)\s*[:\-–—|]\s*([A-Z][^\n]{3,50})/i);
            if (lbl) e.university = lbl[1].trim();
        }

        // Major — ordered by specificity
        const majorPats = [
            /(?:major|concentration|specialization|field\s+of\s+study|discipline|stream|program|course)\s*[:\-–—|]\s*([A-Za-z][A-Za-z\s&,/]{2,45})/i,
            /(?:degree|bachelor'?s?|master'?s?|b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|m\.?b\.?a\.?|ph\.?d|associate'?s?|doctor)\s*(?:of\s+\w+\s+)?(?:in|of)\s+([A-Za-z][A-Za-z\s&,/]{2,45}?)(?:\s*[,;()\n–\-]|$)/i,
            /^([A-Z][A-Za-z\s&/]{3,35})\s*[,–—-]\s*(?:B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|M\.?B\.?A|Ph\.?D|Associate)/im
        ];
        for (const pat of majorPats) {
            const m = text.match(pat);
            if (m && m[1].trim().length > 2) {
                const major = m[1].trim().replace(/\s*(?:from|at|in)\s*$/i, '').replace(/[,;.\-]+$/, '');
                if (major.length > 2 && major.length < 50 && !/university|college|institute|school|academy/i.test(major)) { e.major = major; break; }
            }
        }

        // GPA
        const gpaPats = [
            /(?:GPA|CGPA|CPI|Grade\s+Point(?:\s+Average)?|Cumulative\s+GPA)\s*[:\-–—|]?\s*(\d\.\d{1,2})\s*(?:\/\s*\d(?:\.\d)?)?/i,
            /(\d\.\d{1,2})\s*\/\s*(?:4\.0|10\.0?)/i,
            /(?:GPA|CGPA)\s*(?:of\s+)?(\d\.\d{1,2})/i
        ];
        for (const pat of gpaPats) {
            const m = text.match(pat);
            if (m && m[1]) { const g = parseFloat(m[1]); if (g > 0 && g <= 10) { e.gpa = m[1]; break; } }
        }

        // Graduation Year
        const yrExplicit = text.match(/(?:graduat(?:ed?|ion)|class\s+of|expected|anticipated|completed|conferred)\s*[:\-–—|]?\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+)?(20[0-3]\d|19[89]\d)/i);
        if (yrExplicit) { e.year = yrExplicit[1]; }
        else {
            const range = text.match(/(19[89]\d|20[0-3]\d)\s*[-–—]\s*(20[0-3]\d)/);
            if (range) { e.year = range[2]; }
            else {
                const present = text.match(/(20[0-3]\d)\s*[-–—]\s*(?:present|current|ongoing|now|expected)/i);
                if (present) { e.year = present[1]; }
                else {
                    const single = text.match(/(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+)?(20[0-3]\d|19[89]\d)/);
                    if (single) { const y = parseInt(single[1]); if (y >= 1980 && y <= 2035) e.year = single[1]; }
                }
            }
        }

        return e;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PROFESSIONAL EXPERIENCE — Entry-based structured parsing
    // ═══════════════════════════════════════════════════════════════════

    const JOB_TITLE_RE = /\b(?:engineer|developer|architect|designer|manager|analyst|scientist|consultant|administrator|coordinator|director|lead|head|chief|officer|specialist|associate|intern|assistant|technician|strategist|planner|advisor|operator|executive|programmer|tester|qa|devops|sre|founder|co[-\s]?founder|president|vice\s*president|vp|cto|ceo|cfo|coo|supervisor|trainer|recruiter|accountant|auditor|nurse|physician|teacher|professor|researcher|editor|writer|marketing|sales|support|representative|full[\s-]?stack|front[\s-]?end|back[\s-]?end|data|product|project|program|scrum|agile|cloud|security|network|system|database|mobile|web|ui|ux|graphic|visual|creative)\b/i;

    const DATE_RANGE_RE = /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\s,]*)?(\d{4})\s*[-–—]\s*(?:((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\s,]*)?(\d{4})|(present|current|now|ongoing))\b/i;

    const YEAR_RANGE_RE = /\b(\d{4})\s*[-–—]\s*(\d{4}|present|current|now|ongoing)\b/i;

    function extractProfessional(sectionText, fullText) {
        const text = sectionText || fullText;
        if (!text || text.length < 10) return {};

        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // ── Step 1: Split into individual job entries ──
        // Boundary = a line containing a date range, or a line with a job title keyword
        // that isn't a bullet point
        const entries = [];
        let cur = [];

        for (const line of lines) {
            const hasDate = DATE_RANGE_RE.test(line) || YEAR_RANGE_RE.test(line);
            const hasTitle = JOB_TITLE_RE.test(line) && !/^[•●▪▸►\-*]/.test(line) && line.length < 100;

            // New entry if we detect a date range or title line and current entry has content
            if ((hasDate || hasTitle) && cur.length > 1) {
                entries.push([...cur]);
                cur = [line];
            } else {
                cur.push(line);
            }
        }
        if (cur.length > 0) entries.push([...cur]);
        if (entries.length === 0) entries.push(lines);

        // ── Step 2: Parse each job entry ──
        const parsedJobs = entries.map(parseOneJob).filter(j => j.title || j.company);

        // ── Step 3: Sort by recency (most recent first) ──
        parsedJobs.sort((a, b) => {
            if (a.isCurrent && !b.isCurrent) return -1;
            if (!a.isCurrent && b.isCurrent) return 1;
            return (b.endYear || 0) - (a.endYear || 0);
        });

        const result = {};
        const mostRecent = parsedJobs[0];
        if (mostRecent) {
            if (mostRecent.title) result.currentJobTitle = mostRecent.title;
            if (mostRecent.company) result.currentCompany = mostRecent.company;
        }

        // Years of experience
        const expMatch = text.match(/(\d{1,2})\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:experience|exp)/i);
        if (expMatch) {
            result.yearsOfExperience = expMatch[1];
        } else if (parsedJobs.length > 0) {
            let earliest = 3000;
            for (const j of parsedJobs) { if (j.startYear && j.startYear < earliest) earliest = j.startYear; }
            if (earliest < 3000) {
                const years = new Date().getFullYear() - earliest;
                if (years > 0 && years < 60) result.yearsOfExperience = String(years);
            }
        }

        return result;
    }

    function parseOneJob(entryLines) {
        const job = {};
        const text = entryLines.join('\n');

        // ── Dates ──
        const dateMatch = text.match(DATE_RANGE_RE) || text.match(YEAR_RANGE_RE);
        if (dateMatch) {
            // Extract start year
            const allYears = text.match(/\d{4}/g);
            if (allYears && allYears.length > 0) {
                job.startYear = parseInt(allYears[0]);
                if (allYears.length > 1) job.endYear = parseInt(allYears[allYears.length - 1]);
            }
            if (/present|current|now|ongoing/i.test(text)) {
                job.endYear = new Date().getFullYear();
                job.isCurrent = true;
            }
        }

        // ── Title and Company ──
        for (let i = 0; i < Math.min(entryLines.length, 6); i++) {
            const line = entryLines[i];
            if (/^[•●▪▸►\-*]/.test(line)) continue;
            if (line.length > 120 || line.length < 3) continue;

            // Remove date portions for cleaner analysis
            let cleaned = line
                .replace(DATE_RANGE_RE, '').replace(YEAR_RANGE_RE, '')
                .replace(/\b\d{4}\b/g, '').replace(/^\s*[,|–—\-]\s*/, '')
                .replace(/\s*[,|–—\-]\s*$/, '').trim();

            if (!cleaned || cleaned.length < 3) continue;

            if (JOB_TITLE_RE.test(cleaned) && !job.title) {
                // Try splitting "Title | Company" / "Title at Company" / "Title, Company"
                const splits = [
                    /^(.+?)\s*[|–—]\s*(.+)$/,
                    /^(.+?)\s+at\s+(.+)$/i,
                    /^(.+?)\s+@\s+(.+)$/,
                    /^(.+?),\s+(.+)$/
                ];

                let matched = false;
                for (const sp of splits) {
                    const sm = cleaned.match(sp);
                    if (sm) {
                        const p1 = sm[1].trim(), p2 = sm[2].trim();
                        if (JOB_TITLE_RE.test(p1)) { job.title = p1; job.company = p2; }
                        else if (JOB_TITLE_RE.test(p2)) { job.company = p1; job.title = p2; }
                        else { job.title = p1; job.company = p2; }
                        matched = true; break;
                    }
                }

                if (!matched) {
                    job.title = cleaned;
                    // Check next line for company
                    if (i + 1 < entryLines.length) {
                        const nextCleaned = entryLines[i + 1].trim()
                            .replace(DATE_RANGE_RE, '').replace(YEAR_RANGE_RE, '').replace(/\b\d{4}\b/g, '').trim();
                        if (nextCleaned.length > 1 && nextCleaned.length < 60 &&
                            !/^[•●▪▸►\-*]/.test(nextCleaned) && !JOB_TITLE_RE.test(nextCleaned)) {
                            job.company = nextCleaned.replace(/[,|–—].*$/, '').trim();
                        }
                    }
                }
                break;
            }

            // First non-bullet line without title keyword — might be "Company" then title next
            if (i === 0 && !job.title && cleaned.length < 60) {
                const titleIdx = entryLines.findIndex((l, idx) => idx > 0 && JOB_TITLE_RE.test(l) && !/^[•●▪▸►\-*]/.test(l));
                if (titleIdx > 0) {
                    job.company = cleaned;
                    job.title = entryLines[titleIdx]
                        .replace(DATE_RANGE_RE, '').replace(YEAR_RANGE_RE, '')
                        .replace(/\b\d{4}\b/g, '').trim();
                } else {
                    job.title = cleaned;
                }
                break;
            }
        }

        // Clean up
        if (job.title) job.title = job.title.replace(/^\s*[–—\-|]\s*/, '').replace(/\s*[–—\-|]\s*$/, '').replace(/,?\s*$/, '').substring(0, 60).trim();
        if (job.company) job.company = job.company.replace(/^\s*[–—\-|]\s*/, '').replace(/\s*[–—\-|]\s*$/, '').replace(/,?\s*$/, '').substring(0, 60).trim();

        return job;
    }

    // ─── SKILLS ──────────────────────────────────────────────────────────

    function extractSkills(sectionText, fullText) {
        let text = sectionText || '';
        if (text.length < 10) {
            const fb = fullText.match(/(?:skills|technical\s+skills|core\s+competencies|technologies|tech(?:nical)?\s+stack)\s*[:\-–—|]\s*([\s\S]{10,600}?)(?=\n\n|\n[A-Z]{3,}|\n[A-Z][a-z]+\s*[:\-–—]|$)/i);
            if (fb) text = fb[1];
        }
        if (!text || text.length < 5) return null;

        let skills = text
            .replace(/^[\s•●▪▸►◦▹\-*|→⁃·]+/gm, '').replace(/^\d+[.)]\s*/gm, '')
            .replace(/\b(?:proficient|skilled|experienced|familiar|competent|advanced|intermediate|basic|beginner|expert)\s*(?:in|with|at)?\s*/gi, '')
            .replace(/\n/g, ', ').replace(/\s*[|/]\s*/g, ', ')
            .replace(/,\s*,/g, ',').replace(/,\s*$/g, '').replace(/\s{2,}/g, ' ').trim();

        const items = skills.split(',').map(s => s.trim()).filter(s => s.length > 0 && s.length < 60);
        const seen = new Set();
        const unique = items.filter(i => { const k = i.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        return unique.join(', ').substring(0, 600) || null;
    }

    // ─── CERTIFICATIONS ──────────────────────────────────────────────────

    function extractCertifications(sectionText, fullText) {
        let text = sectionText || '';
        if (text.length < 5) { const fb = fullText.match(/(?:certifications?|licenses?|credentials?)\s*[:\-–—|]?\s*([\s\S]{5,400}?)(?=\n\n|\n[A-Z]{3,}|$)/i); if (fb) text = fb[1]; }
        if (!text || text.length < 5) return null;
        return text.replace(/^[\s•●▪▸►\-*]+/gm, '').replace(/^\d+[.)]\s*/gm, '').split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 120).join(', ') || null;
    }

    // ─── LANGUAGES ───────────────────────────────────────────────────────

    function extractLanguages(sectionText, fullText) {
        let text = sectionText || '';
        if (text.length < 3) { const fb = fullText.match(/(?:languages?\s*(?:spoken|known|proficiency)?|spoken\s+languages?)\s*[:\-–—|]\s*([\s\S]{3,200}?)(?=\n\n|\n[A-Z]{3,}|$)/i); if (fb) text = fb[1]; }
        if (!text || text.length < 3) return null;
        return text.replace(/^[\s•●▪▸►\-*]+/gm, '').replace(/\((?:native|fluent|proficient|intermediate|basic|conversational|beginner|advanced|mother\s*tongue|working\s*proficiency|bi[-\s]?lingual)[^)]*\)/gi, '').replace(/[-–—]\s*(?:native|fluent|proficient|intermediate|basic|conversational|beginner|advanced|mother\s*tongue|working\s*proficiency)/gi, '').replace(/\n/g, ', ').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim() || null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════

    window.QuickApplyCVParser = {
        parseFile,
        extractTextFromPDF,
        extractTextFromDOCX,
        extractAllFields,
        splitSections,
        extractName: (text) => extractName(text.split('\n').map(l => l.trim()).filter(l => l), text),
        extractEmail: (text) => extractEmail(text, text),
        extractPhone: (text) => extractPhone(text, text),
        extractLinks,
        extractAddress: (text) => extractAddress(text, text),
        extractEducation: (text) => extractEducation(text, text),
        extractSkills: (text) => extractSkills(text, text),
        extractProfessional: (text) => extractProfessional(text, text),
        extractCertifications: (text) => extractCertifications(text, text),
        extractLanguages: (text) => extractLanguages(text, text),
        hasPdfJs: () => hasPdfJs || typeof pdfjsLib !== 'undefined'
    };

})();
