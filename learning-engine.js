/**
 * QuickApply — Learning Engine
 * Features 1–5:
 *   1. Correction Memory
 *   2. Resume Integrity
 *   3. Platform Learning
 *   4. Smart Suggestions
 *   5. Universal Field Registry — upgrade-safe, cross-client field mapping store
 */

(function () {
    'use strict';

    const REGISTRY_VERSION = 1; // Bump only on breaking schema changes

    const STORAGE_KEYS = {
        corrections: 'quickapply_corrections',
        platformKnowledge: 'quickapply_platform_knowledge',
        unknownFields: 'quickapply_unknown_fields',
        fieldRegistry: 'quickapply_field_registry'
    };

    // Environment: true when this module is loaded by background.js via importScripts.
    // Content scripts have `window`; service workers do not. Used by the four write
    // functions below to decide between (a) routing through SW for serialization and
    // (b) doing the storage write directly. Reads stay direct in both contexts.
    const _RUNNING_IN_SW = (typeof window === 'undefined');

    // ── Opaque field-name detection ──
    // ATS platforms use per-job-posting opaque IDs as HTML field names. These ids change
    // with every new posting so they can never dedup or look up a stable correction.
    // For these fields we key on the human-readable contextLabel instead (effectiveKey).
    // Both regexes must stay in sync — any fix here covers all callers via resolveFieldIdentity.
    const _OPAQUE_FIELD_NAME_RE = /^(question_\d|rcf\d|input_\d|field_\d|customfield_\d|ats_\d)/i;
    const _OPAQUE_HEX_RE = /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

    function resolveFieldIdentity(fieldName, contextLabel) {
        const fn = (fieldName || '').trim();
        const isOpaque = _OPAQUE_FIELD_NAME_RE.test(fn) || _OPAQUE_HEX_RE.test(fn);
        const effectiveKey = (isOpaque && contextLabel)
            ? contextLabel.toLowerCase().trim().substring(0, 120)
            : fn;
        return { isOpaque, effectiveKey };
    }

    // ── Safe storage wrappers ──
    // All chrome.storage calls go through these. If the extension was reloaded
    // mid-session the context is invalidated and any direct call throws.
    // These guards silently bail instead of crashing the page.
    async function storageGet(keys) {
        if (!chrome.runtime?.id) return {};
        return chrome.storage.local.get(keys);
    }
    async function storageSet(data) {
        if (!chrome.runtime?.id) return;
        return chrome.storage.local.set(data);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEATURE 1: CORRECTION MEMORY
    // When a human changes a filled field, remember the correction.
    // Next time on the same platform → use correction first.
    // ═══════════════════════════════════════════════════════════════════

    // Single source of truth for correction-value rejection. Called from both the
    // content-side wrapper (so a bad correction never crosses the message boundary)
    // AND the SW-side direct function (defense in depth — message payloads are
    // untrusted, and direct callers via QuickApplyLearning._saveCorrectionDirect
    // would otherwise bypass the wrapper's guards).
    // A platform-internal option id (Workday 32-hex / UUID, Greenhouse EEO id) is
    // never a real answer or a real question label.
    const _OPAQUE_ID = /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

    // NEW-3 FIX: accepts optional fieldContext (fieldName + contextLabel) so the
    // boolean-field exclusion can be applied on the SW side, matching content.js logic.
    function _isBadCorrectionValue(_cv, _fieldCtx) {
        if (_cv === null || _cv === undefined) return true;
        const _cvs = String(_cv);
        if (_cvs.trim() === '') return true;
        if (_cvs === 'on' || _cvs === 'off') return true;        // HTML checkbox/radio default
        // "true"/"false" are valid Workday boolean radio values (candidateIsPreviousWorker etc.)
        // when the field name contains a camelCase boolean indicator. Reject otherwise.
        if (_cvs === 'true' || _cvs === 'false') {
            const _looksBoolean = /(?:Is|Has|Was|Did|Does|Can|Were|Have|Previous|Former|Eligible)[A-Z]/.test(_fieldCtx || '');
            if (!_looksBoolean) return true;
        }
        if (_OPAQUE_ID.test(_cvs.trim())) return true;           // opaque option id (hex/UUID)
        if (/^\d{7,}$/.test(_cvs)) return true;                  // ATS internal numeric ID
        if (/ $/.test(_cvs)) return true;                        // trailing space = cut-off autocomplete
        if (_cvs.length < 80 && /\s(a|an|the|not|in|of|to|is|are|at|for|with|by|from|as|on|about|and|or|but)$/i.test(_cvs)) return true;
        if (/^(I|They|He|She|We) (am|are|was|were|have|had|will|would|can|could|should)$/i.test(_cvs.trim())) return true;
        return false;
    }

    // A label is junk when it's not a real question/field name but captured control
    // or option text: Workday's "* Required" marker, "Select One" placeholder, the
    // prompt "search Box", account-flow controls, or an opaque id.
    function _isJunkLabel(label) {
        const l = String(label || '').trim();
        if (!l) return true;
        if (!/[a-z]/i.test(l)) return true;                      // no letters → not a question
        if (_OPAQUE_ID.test(l)) return true;                     // opaque label
        // NOTE: deliberately NOT rejecting a trailing "Required" here — real ATS
        // field labels often include it (e.g. "First Name Required"), and rejecting
        // it silently dropped legitimate user corrections. The poisoned
        // "<option> Required" entries are already caught by their opaque VALUE.
        if (/^(select one|search\s*box|create account checkbox|accept terms)\b/i.test(l)) return true;
        return false;
    }

    // The single gate every "learn" path (saveCorrection, learnCustomField,
    // registerField) must pass. Rejects junk LABELS and junk VALUES so poisoned
    // entries never get written, regardless of which capture fired. Pass value
    // as undefined for label-only checks (e.g. registerField).
    // fieldContext (optional): space-joined fieldName+contextLabel for boolean detection.
    function isJunkLearnedField(label, value, fieldContext) {
        if (_isJunkLabel(label)) return true;
        if (value !== undefined && _isBadCorrectionValue(value, fieldContext)) return true;
        // NEW-4 FIX: only reject label==value when the shared string has no whitespace.
        // Single-word option texts captured as both label and value ("Male"/"Female",
        // "Yes"/"No" when getElementContext returned button text) are rejected.
        // Multi-word or spaced strings that match are preserved — real question labels
        // that happen to equal their answer ("I prefer not to say" → "I prefer not to say")
        // are valid corrections and should not be discarded.
        if (value != null && String(value).trim() &&
            String(value).trim().toLowerCase() === String(label || '').trim().toLowerCase() &&
            !/\s/.test(String(value).trim())) return true;
        return false;
    }

    async function saveCorrection(correction) {
        if (!correction.clientId) {
            console.error('[Learning] Cannot save correction without clientId');
            return;
        }
        if (!chrome.runtime?.id) return;
        const _saveCtx = (correction.fieldName || '') + ' ' + (correction.contextLabel || '');
        if (isJunkLearnedField(correction.contextLabel || correction.fieldName, correction.correctedValue, _saveCtx)) return;

        if (!_RUNNING_IN_SW) {
            // Content script: route through SW so writes from multiple iframes
            // serialize through a single queue. Drop the write if SW is unreachable
            // (extension reload mid-fill) — re-racing the read-modify-write would
            // be worse than losing one event.
            try {
                return await chrome.runtime.sendMessage({
                    type: 'LEARNING_SAVE_CORRECTION',
                    payload: { correction }
                });
            } catch (e) {
                console.debug('[Learning] SW unreachable, dropping saveCorrection:', e && e.message);
                return;
            }
        }
        return _saveCorrectionDirect(correction);
    }

    async function _saveCorrectionDirect(correction) {
        // Re-validate on SW side (defense in depth — message payloads are untrusted,
        // and direct callers via QuickApplyLearning._saveCorrectionDirect would
        // otherwise bypass the wrapper's guards).
        if (!correction || !correction.clientId) return;
        const _ctx = (correction.fieldName || '') + ' ' + (correction.contextLabel || '');
        if (isJunkLearnedField(correction.contextLabel || correction.fieldName, correction.correctedValue, _ctx)) return;

        const data = await storageGet(STORAGE_KEYS.corrections);
        const corrections = data[STORAGE_KEYS.corrections] || [];

        // C2 FIX: Dedup by clientId + platform + fieldName only (NOT profileField).
        // Previously including profileField meant you couldn't re-correct WHICH profile field
        // an HTML input maps to — the old entry never matched so a duplicate was created,
        // and corrections.find() returned the stale wrong one first.
        //
        // L7 FIX: Greenhouse/iCIMS EEO fields use opaque per-job IDs like "Question_56843325004"
        // or "rcf2044". The same question (e.g. "What is your gender?") has a DIFFERENT ID on
        // every job posting — so corrections saved for one job never apply to the next.
        // When fieldName is opaque, use contextLabel (the human-readable question text) as the
        // dedup key instead — it's stable across all postings on the same platform.
        const { isOpaque: _isOpaqueField, effectiveKey: _effectiveFieldKey } =
            resolveFieldIdentity(correction.fieldName, correction.contextLabel);

        const existingIdx = corrections.findIndex(c =>
            c.clientId === correction.clientId &&
            c.platform === correction.platform &&
            ((c._effectiveFieldKey && c._effectiveFieldKey === _effectiveFieldKey) ||
             (!c._effectiveFieldKey && c.fieldName === _effectiveFieldKey))
        );

        if (existingIdx >= 0) {
            corrections[existingIdx].profileField = correction.profileField;
            corrections[existingIdx].correctedValue = correction.correctedValue;
            corrections[existingIdx].correctedIndex = correction.correctedIndex;
            corrections[existingIdx].count = (corrections[existingIdx].count || 0) + 1;
            corrections[existingIdx].lastUsedAt = new Date().toISOString();
            corrections[existingIdx]._effectiveFieldKey = _effectiveFieldKey;
        } else {
            corrections.push({
                id: generateId(),
                clientId: correction.clientId,
                platform: correction.platform,
                domain: correction.domain,
                fieldSelector: correction.fieldSelector,
                fieldName: correction.fieldName,
                _effectiveFieldKey,
                contextLabel: correction.contextLabel || null,
                profileField: correction.profileField,
                originalValue: correction.originalValue,
                correctedValue: correction.correctedValue,
                correctedIndex: correction.correctedIndex ?? null,
                inputType: correction.inputType || 'text',
                count: 1,
                createdAt: new Date().toISOString(),
                lastUsedAt: new Date().toISOString()
            });
        }

        await storageSet({ [STORAGE_KEYS.corrections]: corrections });

        // L6 FIX: Feed every human correction immediately into the Universal Field Registry.
        // Boost registry confidence to 0.85 so P9a picks it up on the very next fill without AI.
        if (correction.fieldName && correction.profileField) {
            try {
                // Within SW: call the direct register function so this nested write also
                // joins the same queue (the caller is already inside the queue for this
                // saveCorrection call, so registerField → _registerFieldDirect is fine).
                await _registerFieldDirect({
                    // For opaque/UUID field names, key the registry off the stable human
                    // label instead of the per-posting-unique fieldName.
                    fieldName: (_isOpaqueField && correction.contextLabel) ? correction.contextLabel : correction.fieldName,
                    label: correction.contextLabel || correction.fieldName,
                    profileField: correction.profileField,
                    source: 'correction',
                    platform: correction.platform || correction.domain
                });
            } catch (_) { /* registry write failure must not break correction save */ }

            // G1 FIX: Also update platform knowledge so the correction takes effect on
            // the next fill via P2 (platform-learned path).
            if (correction.domain) {
                try {
                    const pkData = await storageGet(STORAGE_KEYS.platformKnowledge);
                    const knowledge = pkData[STORAGE_KEYS.platformKnowledge] || {};
                    if (knowledge[correction.domain] && knowledge[correction.domain].fields) {
                        // L5 FIX: for opaque field names (UUID / question_xxx), use contextLabel
                        // as the normKey so it can match the HTML-attribute-keyed platform entry.
                        // The raw opaque fieldName would never match anything stored by recordFillResult.
                        const _g1Source = (_isOpaqueField && correction.contextLabel)
                            ? correction.contextLabel : correction.fieldName;
                        const normKey = _g1Source.toLowerCase()
                            .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);
                        if (knowledge[correction.domain].fields[normKey]) {
                            knowledge[correction.domain].fields[normKey].profileField = correction.profileField;
                            knowledge[correction.domain].fields[normKey].confidence = Math.max(
                                knowledge[correction.domain].fields[normKey].confidence, 0.75
                            );
                            await storageSet({ [STORAGE_KEYS.platformKnowledge]: knowledge });
                        }
                    }
                } catch (_) {}
            }
        }
    }

    async function getCorrections(platform, domain, clientId) {
        const data = await storageGet(STORAGE_KEYS.corrections);
        const corrections = data[STORAGE_KEYS.corrections] || [];

        return corrections.filter(c => {
            if (c.clientId !== clientId) return false;
            if (c.platform !== platform && c.domain !== domain) return false;
            // NEW-13 FIX: runtime filter now mirrors the full _isBadCorrectionValue gate,
            // not just the subset that purgeBadCorrections removes at startup. Old storage
            // entries with opaque IDs or ATS numeric IDs (saved before the write-guard)
            // are silently dropped on read so they can never be replayed as corrections.
            const _cv = c.correctedValue;
            if (_cv === null || _cv === undefined || String(_cv).trim() === '') return false;
            if (/^on$/i.test(String(_cv).trim())) return false;
            if (_OPAQUE_ID.test(String(_cv).trim())) return false;            // opaque hex/UUID value
            if (/^\d{7,}$/.test(String(_cv).trim())) return false;            // ATS numeric ID
            if (/ $/.test(String(_cv))) return false;                         // trailing-space cutoff
            if (/^(I|They|He|She|We) (am|are|was|were|have|had|will|would|can|could|should)$/i.test(String(_cv).trim())) return false;
            return true;
        });
    }

    // One-time purge of bad corrections that accumulated before save-guard was added.
    // Runs automatically at startup. After the first run it sets a flag and never runs again.
    // Removes: empty correctedValue, "on", truncated "I am" fragments.
    const _PURGE_FLAG = 'quickapply_corrections_purged_v1';
    async function purgeBadCorrections() {
        if (!chrome.runtime?.id) return;
        const flagData = await storageGet(_PURGE_FLAG);
        if (flagData[_PURGE_FLAG]) return; // already done
        const data = await storageGet(STORAGE_KEYS.corrections);
        const all = data[STORAGE_KEYS.corrections] || [];
        const isBad = cv => {
            if (cv === null || cv === undefined || String(cv).trim() === '') return true;
            if (/^on$/i.test(String(cv).trim())) return true;
            if (/^(I|They|He|She|We) (am|are|was|were|have|had|will|would|can|could|should)$/i.test(String(cv).trim())) return true;
            return false;
        };
        const clean = all.filter(c => !isBad(c.correctedValue));
        if (clean.length < all.length) {
            await storageSet({ [STORAGE_KEYS.corrections]: clean });
            console.log(`[Learning] Purged ${all.length - clean.length} bad corrections from storage`);
        }
        await storageSet({ [_PURGE_FLAG]: true });
    }
    // Purge is fired once at browser startup by background.js, not on every
    // content-script module load (which happens per-iframe per-navigation).

    async function getCorrectionForField(platform, domain, fieldName, profileField, clientId, contextLabel) {
        const corrections = await getCorrections(platform, domain, clientId);
        // L8 FIX: also check _effectiveFieldKey for opaque field names (Ashby UUIDs,
        // Greenhouse/iCIMS EEO IDs) — each posting generates a different opaque ID but
        // the stable contextLabel is the key used at save time. The old profileField
        // fallback was too broad: any two fields mapping to the same profile key (e.g.
        // two "email" fields) would collide. It is removed.
        const { effectiveKey: _effKey } = resolveFieldIdentity(fieldName, contextLabel);
        return corrections.find(c =>
            c.fieldName === fieldName ||
            (c._effectiveFieldKey && _effKey && c._effectiveFieldKey === _effKey)
        ) || null;
    }

    async function clearCorrections(platform, domain) {
        if (!platform && !domain) {
            await storageSet({ [STORAGE_KEYS.corrections]: [] });
            return;
        }
        const data = await storageGet(STORAGE_KEYS.corrections);
        // NEW-28 FIX: also clear by domain. getCorrections filters by (platform OR domain),
        // so clearCorrections("greenhouse") left behind entries stored with domain only.
        const corrections = (data[STORAGE_KEYS.corrections] || []).filter(c =>
            (!platform || c.platform !== platform) && (!domain || c.domain !== domain)
        );
        await storageSet({ [STORAGE_KEYS.corrections]: corrections });
    }

    async function getAllCorrections() {
        const data = await storageGet(STORAGE_KEYS.corrections);
        return data[STORAGE_KEYS.corrections] || [];
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEATURE 2: RESUME INTEGRITY VERIFICATION
    // SHA-256 hash on upload, verify before every fill.
    // Magic byte checks for PDF (%PDF) and DOCX (PK/ZIP).
    // ═══════════════════════════════════════════════════════════════════

    async function computeFileHash(base64Data) {
        try {
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return 'sha256-' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.error('[Learning] Hash computation failed:', e);
            return null;
        }
    }

    function checkMagicBytes(base64Data) {
        try {
            const binaryStr = atob(base64Data.substring(0, 20)); // Only need first few bytes
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }

            // PDF: starts with %PDF (0x25 0x50 0x44 0x46)
            if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
                return 'pdf';
            }

            // DOCX/ZIP: starts with PK (0x50 0x4B 0x03 0x04)
            if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
                return 'docx';
            }

            // RTF: starts with {\rtf
            if (bytes[0] === 0x7B && bytes[1] === 0x5C && bytes[2] === 0x72 && bytes[3] === 0x74) {
                return 'rtf';
            }

            return 'unknown';
        } catch (e) {
            return 'error';
        }
    }

    async function verifyFileIntegrity(profile) {
        if (!profile.cvData) {
            return { valid: false, reason: 'no_file' };
        }

        const result = {
            valid: true,
            format: checkMagicBytes(profile.cvData),
            hashMatch: null,
            size: null
        };

        // Check format matches expected MIME type
        if (profile.cvMimeType) {
            const expectedFormat = profile.cvMimeType.includes('pdf') ? 'pdf' : 'docx';
            if (result.format !== expectedFormat && result.format !== 'unknown') {
                result.valid = false;
                result.reason = 'format_mismatch';
            }
        }

        // Verify hash if stored
        if (profile.cvHash) {
            const currentHash = await computeFileHash(profile.cvData);
            result.hashMatch = currentHash === profile.cvHash;
            if (!result.hashMatch) {
                result.valid = false;
                result.reason = 'hash_mismatch';
            }
        }

        // Basic size check (base64 is ~33% larger than original)
        if (profile.cvSize) {
            const expectedBase64Len = Math.ceil(profile.cvSize / 3) * 4;
            const tolerance = 100; // allow small variance
            const actualLen = profile.cvData.length;
            if (Math.abs(actualLen - expectedBase64Len) > tolerance) {
                result.valid = false;
                result.reason = 'size_mismatch';
            }
        }

        result.size = profile.cvData.length;
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEATURE 3: PLATFORM LEARNING
    // After each fill, record field mappings per domain.
    // Build a per-platform dictionary over time.
    // ═══════════════════════════════════════════════════════════════════

    async function recordFillResult(domain, fieldMappings) {
        if (!chrome.runtime?.id) return;
        if (!_RUNNING_IN_SW) {
            try {
                return await chrome.runtime.sendMessage({
                    type: 'LEARNING_RECORD_FILL',
                    payload: { domain, fieldMappings }
                });
            } catch (_) { return; }
        }
        return _recordFillResultDirect(domain, fieldMappings);
    }

    async function _recordFillResultDirect(domain, fieldMappings) {
        if (!domain) return;
        const data = await storageGet(STORAGE_KEYS.platformKnowledge);
        const knowledge = data[STORAGE_KEYS.platformKnowledge] || {};

        if (!knowledge[domain]) {
            knowledge[domain] = {
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                fillCount: 0,
                fields: {},
                totalFieldsDiscovered: 0,
                successRate: 0
            };
        }

        const platform = knowledge[domain];
        platform.lastSeen = new Date().toISOString();
        platform.fillCount++;

        let successes = 0;
        let total = 0;

        for (const mapping of (fieldMappings || [])) {
            const rawKey = mapping.htmlName || mapping.fieldSelector || mapping.fieldName;
            if (!rawKey) continue;
            const key = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);

            total++;

            if (!platform.fields[key]) {
                platform.fields[key] = {
                    profileField: mapping.profileField,
                    confidence: mapping.confidence || 0.5,
                    uses: 0,
                    successCount: 0,
                    lastStatus: mapping.status,
                    firstSeenAt: new Date().toISOString()
                };
                platform.totalFieldsDiscovered++;
            }

            if (platform.fields[key].successCount === undefined) {
                platform.fields[key].successCount = 0;
            }

            platform.fields[key].uses++;
            platform.fields[key].lastStatus = mapping.status;
            platform.fields[key].lastSeenAt = new Date().toISOString();

            if (mapping.status === 'filled') {
                platform.fields[key].confidence = Math.min(1.0,
                    platform.fields[key].confidence + 0.15
                );
                platform.fields[key].successCount++;
                successes++;
            } else if (mapping.status === 'error') {
                const decayed = platform.fields[key].confidence * 0.88;
                const floor = (platform.fields[key].successCount || 0) >= 3 ? 0.3 : 0.1;
                platform.fields[key].confidence = Math.max(floor, decayed);
            }
        }

        // NEW-1/14 FIX: use rolling average instead of overwriting with the current
        // fill's rate. A single partial fill no longer wipes out historical signal.
        // Guard: if total === 0 (all mappings had no rawKey), don't update at all —
        // writing 0 on an empty batch would destroy a previously-good rate.
        if (total > 0) {
            const _sessionRate = successes / total;
            platform.successRate = platform.fillCount <= 1
                ? _sessionRate
                : 0.8 * (platform.successRate || 0) + 0.2 * _sessionRate;
        }

        await storageSet({ [STORAGE_KEYS.platformKnowledge]: knowledge });
    }

    async function getPlatformKnowledge(domain) {
        const data = await storageGet(STORAGE_KEYS.platformKnowledge);
        const knowledge = data[STORAGE_KEYS.platformKnowledge] || {};
        return knowledge[domain] || null;
    }

    async function getPlatformMappings(domain) {
        const platform = await getPlatformKnowledge(domain);
        if (!platform) return {};

        // Return learned mappings — trust after 1 use with initial confidence (BUG-09 FIX)
        const result = {};
        for (const [key, field] of Object.entries(platform.fields)) {
            if (field.uses >= 1 && field.confidence >= 0.5) {
                result[key] = field.profileField;
            }
        }
        return result;
    }

    async function getAllPlatformKnowledge() {
        const data = await storageGet(STORAGE_KEYS.platformKnowledge);
        return data[STORAGE_KEYS.platformKnowledge] || {};
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEATURE 4: SMART SUGGESTIONS
    // Track unmatched fields across platforms. When a pattern appears
    // ≥ 3 times, suggest adding it as a custom field.
    // ═══════════════════════════════════════════════════════════════════

    async function logUnknownField(fieldInfo) {
        if (!chrome.runtime?.id) return;
        if (!fieldInfo) return;
        if (!_RUNNING_IN_SW) {
            try {
                return await chrome.runtime.sendMessage({
                    type: 'LEARNING_LOG_UNKNOWN',
                    payload: { fieldInfo }
                });
            } catch (_) { return; }
        }
        return _logUnknownFieldDirect(fieldInfo);
    }

    async function _logUnknownFieldDirect(fieldInfo) {
        if (!fieldInfo) return;
        const data = await storageGet(STORAGE_KEYS.unknownFields);
        const unknowns = data[STORAGE_KEYS.unknownFields] || [];

        const normalized = (fieldInfo.fieldName || fieldInfo.label || '').toLowerCase().trim();
        if (!normalized || normalized.length < 2) return;
        // L3 FIX: apply the same junk gate as saveCorrection / registerField.
        // Without this, opaque IDs and placeholder labels ("Select One", "* Required")
        // pollute the suggestions panel with noise that can never become a valid custom field.
        if (isJunkLearnedField(normalized)) return;

        const existing = unknowns.find(u =>
            u.patterns.some(p => p === normalized || levenshteinSimilar(p, normalized))
        );

        if (existing) {
            existing.count++;
            existing.lastSeen = new Date().toISOString();
            if (!existing.patterns.includes(normalized)) {
                existing.patterns.push(normalized);
            }
            if (fieldInfo.platform && !existing.platforms.includes(fieldInfo.platform)) {
                existing.platforms.push(fieldInfo.platform);
            }
        } else {
            unknowns.push({
                id: generateId(),
                patterns: [normalized],
                suggestedLabel: formatLabel(normalized),
                platforms: fieldInfo.platform ? [fieldInfo.platform] : [],
                count: 1,
                dismissed: false,
                addedAsCustomField: false,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            });
        }

        await storageSet({ [STORAGE_KEYS.unknownFields]: unknowns });
    }

    async function _saveCustomFieldDirect({ clientId, label, value, fieldName } = {}) {
        if (!clientId) return;
        if (isJunkLearnedField(label, value)) return;
        const data = await storageGet('quickapply_clients');
        const clients = data['quickapply_clients'] || [];
        const clientIdx = clients.findIndex(c => c.id === clientId);
        if (clientIdx === -1) return;
        const client = clients[clientIdx];
        if (!client.customFields) client.customFields = [];
        const existingIdx = client.customFields.findIndex(cf =>
            cf.label === label || (fieldName && cf.aliases && cf.aliases.includes(fieldName))
        );
        if (existingIdx >= 0) {
            client.customFields[existingIdx].value = value;
            if (fieldName && !client.customFields[existingIdx].aliases.includes(fieldName)) {
                client.customFields[existingIdx].aliases.push(fieldName);
            }
        } else {
            client.customFields.push({ label, value, aliases: fieldName ? [fieldName] : [] });
        }
        await storageSet({ quickapply_clients: clients });
    }

    async function getSuggestions(minCount = 3) {
        const data = await storageGet(STORAGE_KEYS.unknownFields);
        const unknowns = data[STORAGE_KEYS.unknownFields] || [];

        return unknowns.filter(u =>
            u.count >= minCount && !u.dismissed && !u.addedAsCustomField
        );
    }

    async function dismissSuggestion(id) {
        if (!chrome.runtime?.id) return; // NEW-27 FIX: guard against invalidated context
        const data = await storageGet(STORAGE_KEYS.unknownFields);
        const unknowns = data[STORAGE_KEYS.unknownFields] || [];
        const item = unknowns.find(u => u.id === id);
        if (item) item.dismissed = true;
        await storageSet({ [STORAGE_KEYS.unknownFields]: unknowns });
    }

    async function promoteSuggestion(id, label) {
        if (!chrome.runtime?.id) return null; // NEW-27 FIX
        const data = await storageGet(STORAGE_KEYS.unknownFields);
        const unknowns = data[STORAGE_KEYS.unknownFields] || [];
        const item = unknowns.find(u => u.id === id);
        if (item) {
            item.addedAsCustomField = true;
            item.promotedLabel = label || item.suggestedLabel;
        }
        await storageSet({ [STORAGE_KEYS.unknownFields]: unknowns });
        return item;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function generateId() {
        return 'lrn_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    }

    function formatLabel(str) {
        return str
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
    }

    // Simple Levenshtein-based similarity check (threshold: ≤ 3 edits)
    function levenshteinSimilar(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') return false;
        if (Math.abs(a.length - b.length) > 3) return false;

        const matrix = [];
        for (let i = 0; i <= a.length; i++) {
            matrix[i] = [i];
            for (let j = 1; j <= b.length; j++) {
                if (i === 0) {
                    matrix[i][j] = j;
                } else {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j - 1] + cost
                    );
                }
            }
        }
        return matrix[a.length][b.length] <= 3;
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEATURE 5: UNIVERSAL FIELD REGISTRY
    // A versioned, upgrade-safe store of field label → profileField mappings.
    // Data lives in chrome.storage.local (user data), not in code.
    // Extension updates never touch user data → mappings survive upgrades.
    // All clients share this registry. Each mapping entry tracks:
    //   - Unique ID, schema version (for future migration)
    //   - Field label(s) and normalized key
    //   - Which profile field it maps to
    //   - Source (cv_parse | form_fill | manual | correction)
    //   - Platform(s) where it was seen
    //   - Usage count and confidence
    //   - Created/updated timestamps
    // ═══════════════════════════════════════════════════════════════════

    async function getFieldRegistry() {
        const data = await storageGet(STORAGE_KEYS.fieldRegistry);
        const registry = data[STORAGE_KEYS.fieldRegistry] || { version: REGISTRY_VERSION, fields: {} };

        // Schema migration: if stored version is older, migrate
        if ((registry.version || 0) < REGISTRY_VERSION) {
            registry.version = REGISTRY_VERSION;
            await storageSet({ [STORAGE_KEYS.fieldRegistry]: registry });
        }

        return registry;
    }

    async function saveFieldRegistry(registry) {
        registry.version = REGISTRY_VERSION;
        registry.lastUpdated = new Date().toISOString();
        await storageSet({ [STORAGE_KEYS.fieldRegistry]: registry });
    }

    /**
     * Record a discovered field mapping.
     * Called from CV parser, form filler, or correction handler.
     * @param {Object} mapping
     * @param {string} mapping.label     – The field label as displayed (e.g., "Years of Experience")
     * @param {string} mapping.fieldName – Technical field identifier (e.g., "yearsOfExperience")
     * @param {string} mapping.profileField – Profile field it maps to (e.g., "yearsOfExperience")
     * @param {string} mapping.source    – "cv_parse" | "form_fill" | "manual" | "correction"
     * @param {string} [mapping.platform] – Domain where it was found
     */
    async function registerField(mapping) {
        if (!chrome.runtime?.id) return;
        if (!mapping || (!mapping.fieldName && !mapping.label)) return;
        if (!_RUNNING_IN_SW) {
            try {
                return await chrome.runtime.sendMessage({
                    type: 'LEARNING_REGISTER_FIELD',
                    payload: { mapping }
                });
            } catch (_) { return; }
        }
        return _registerFieldDirect(mapping);
    }

    async function _registerFieldDirect(mapping) {
        if (!mapping || (!mapping.fieldName && !mapping.label)) return;
        // Don't register junk question labels (opaque ids, "Select One", "* Required",
        // account-flow controls) — they pollute the registry and can never match a
        // real field. Use whichever of label/fieldName is the human-facing one.
        if (isJunkLearnedField(mapping.label || mapping.fieldName, undefined)) return;

        const registry = await getFieldRegistry();
        const key = normalizeFieldKey(mapping.fieldName || mapping.label);
        if (!key) return;

        if (registry.fields[key]) {
            const entry = registry.fields[key];
            entry.uses++;
            entry.lastSeen = new Date().toISOString();
            entry.confidence = Math.min(1.0, entry.confidence + 0.1);

            // C1 FIX: human correction overrides AI mapping; boost confidence above lookup threshold
            if (mapping.source === 'correction' && mapping.profileField) {
                entry.profileField = mapping.profileField;
                entry.confidence = Math.max(entry.confidence, 0.85);
            }

            // G3 FIX: cap labels at 10; skip near-duplicates
            if (mapping.label && !entry.labels.includes(mapping.label) && entry.labels.length < 10) {
                const isNearDup = entry.labels.some(l => levenshteinSimilar(
                    l.toLowerCase().trim(), mapping.label.toLowerCase().trim()
                ));
                if (!isNearDup) {
                    entry.labels.push(mapping.label);
                }
            }

            if (mapping.platform && !entry.platforms.includes(mapping.platform)) {
                entry.platforms.push(mapping.platform);
            }

            if (mapping.source && !entry.sources.includes(mapping.source)) {
                entry.sources.push(mapping.source);
            }
        } else {
            const startConfidence = (mapping.source === 'correction') ? 0.85
                : (mapping.source === 'gemini-ai') ? 0.65
                : (mapping.source === 'form_fill_fuzzy') ? 0.35
                : 0.5;
            registry.fields[key] = {
                id: generateId(),
                schemaVersion: REGISTRY_VERSION,
                key,
                labels: mapping.label ? [mapping.label] : [],
                profileField: mapping.profileField || mapping.fieldName,
                sources: mapping.source ? [mapping.source] : [],
                platforms: mapping.platform ? [mapping.platform] : [],
                uses: 1,
                confidence: startConfidence,
                createdAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            };
        }

        await saveFieldRegistry(registry);
    }

    /**
     * Called by the CV parser when fields are extracted from a resume.
     * Records every discovered field in the universal registry.
     */
    async function recordDiscoveredFields(fields) {
        if (!fields || typeof fields !== 'object') return;

        for (const [fieldName, value] of Object.entries(fields)) {
            if (!value) continue;
            await registerField({
                fieldName,
                label: formatLabel(fieldName),
                profileField: fieldName,
                source: 'cv_parse'
            });
        }
    }

    /**
     * Look up a profile field from the registry by field name or label.
     * Returns the profile field if found with sufficient confidence, or null.
     */
    async function lookupField(fieldName) {
        if (!fieldName) return null;
        const registry = await getFieldRegistry();
        const key = normalizeFieldKey(fieldName);
        if (!key) return null; // guard against empty string input

        const entry = registry.fields[key];
        // BUG-09 FIX: lower threshold for all sources — platform seeds and first real fills
        // should be trusted after 1 use. Old threshold (uses≥2, conf≥0.6) silenced the registry
        // for the first 2 applications per field per platform.
        if (entry && entry.uses >= 1 && entry.confidence >= 0.5) {
            return {
                profileField: entry.profileField,
                confidence: entry.confidence,
                labels: entry.labels,
                sources: entry.sources
            };
        }

        // H3 FIX: Fuzzy match against all stored labels.
        // For short strings (≤ 20 chars): Levenshtein ≤ 3 edits (good for field names like "fname").
        // For long strings (> 20 chars, i.e. sentence labels): token overlap — Levenshtein fails
        // on questions like "What is your current job title?" vs "current job title" (distance ~30).
        // Token overlap: score = matching_words / max_word_count; threshold 0.55.
        const STOP_WORDS = new Set(['what', 'is', 'your', 'are', 'you', 'do', 'the', 'a', 'an',
            'have', 'has', 'been', 'with', 'for', 'of', 'in', 'to', 'at', 'by', 'or', 'and']);
        function tokenOverlap(a, b) {
            const wordsA = a.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
            const wordsB = b.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
            if (wordsA.length === 0 || wordsB.length === 0) return 0;
            const setA = new Set(wordsA);
            const matches = wordsB.filter(w => setA.has(w)).length;
            return matches / Math.max(wordsA.length, wordsB.length);
        }
        function labelsMatch(stored, input) {
            const s = stored.toLowerCase().trim();
            const i = input.toLowerCase().trim();
            if (s === i) return true;
            if (s.length > 20 || i.length > 20) return tokenOverlap(s, i) >= 0.55;
            return levenshteinSimilar(s, i);
        }
        const normalizedInput = fieldName.toLowerCase().trim();
        let fuzzyBest = null, fuzzyBestConf = 0;
        for (const [, ent] of Object.entries(registry.fields)) {
            if (ent.uses >= 1 && ent.confidence >= 0.5) {
                const match = ent.labels.some(l => labelsMatch(l, normalizedInput));
                if (match && ent.confidence > fuzzyBestConf) {
                    fuzzyBestConf = ent.confidence;
                    fuzzyBest = ent;
                }
            }
        }
        if (fuzzyBest) {
            return {
                profileField: fuzzyBest.profileField,
                confidence: fuzzyBest.confidence * 0.9, // slight penalty for fuzzy label match
                labels: fuzzyBest.labels,
                sources: fuzzyBest.sources
            };
        }

        return null;
    }

    /**
     * Get all registry entries — used by dashboard for display.
     */
    async function getAllRegistryFields() {
        const registry = await getFieldRegistry();
        return Object.values(registry.fields).sort((a, b) => b.uses - a.uses);
    }

    /**
     * Export the registry as a portable JSON object.
     * Can be imported into another installation — universal and client-independent.
     */
    async function exportRegistry() {
        const registry = await getFieldRegistry();
        return {
            exportVersion: REGISTRY_VERSION,
            exportedAt: new Date().toISOString(),
            fieldCount: Object.keys(registry.fields).length,
            fields: registry.fields
        };
    }

    /**
     * Import a previously exported registry.
     * Merges with existing data — never overwrites, only supplements.
     */
    async function importRegistry(exportedData) {
        if (!exportedData || !exportedData.fields) return { imported: 0 };

        const registry = await getFieldRegistry();
        let imported = 0;

        for (const [key, entry] of Object.entries(exportedData.fields)) {
            if (registry.fields[key]) {
                // Merge: add new labels, platforms, sources
                const existing = registry.fields[key];
                for (const l of (entry.labels || [])) {
                    if (!existing.labels.includes(l)) existing.labels.push(l);
                }
                for (const p of (entry.platforms || [])) {
                    if (!existing.platforms.includes(p)) existing.platforms.push(p);
                }
                for (const s of (entry.sources || [])) {
                    if (!existing.sources.includes(s)) existing.sources.push(s);
                }
                existing.uses += entry.uses || 0;
                existing.confidence = Math.max(existing.confidence, entry.confidence || 0);
                imported++;
            } else {
                // L7 FIX: run every NEW entry through the junk gate before importing.
                // A corrupt or malicious export file could otherwise bypass all write guards
                // that registerField / saveCorrection apply. Merges of existing keys are safe
                // (the key already passed the gate when it was first registered).
                const _importLabel = (entry.labels && entry.labels[0]) || key;
                if (isJunkLearnedField(_importLabel)) continue;
                // Add new entry
                registry.fields[key] = { ...entry, schemaVersion: REGISTRY_VERSION };
                imported++;
            }
        }

        await saveFieldRegistry(registry);
        return { imported };
    }

    function normalizeFieldKey(str) {
        // Cap at 80 chars — matches recordFillResult and background.js loadPlatformMemory
        // so keys are consistent across all three storage codepaths.
        return (str || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 80);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PLATFORM SEEDS (Improvement 3)
    // Pre-populate the universal field registry with known-good mappings
    // for stable ATSs so the first fill never starts from zero.
    // Seeds have confidence 0.75 — lower than learned corrections so they
    // are always overridden when the user corrects a field.
    // ═══════════════════════════════════════════════════════════════════

    const SEEDS_FLAG_KEY = 'quickapply_seeds_loaded_v1';

    async function loadPlatformSeeds() {
        // Run only once per install — check flag first
        const flagData = await storageGet([SEEDS_FLAG_KEY]);
        if (flagData[SEEDS_FLAG_KEY]) return;

        try {
            const seedsUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
                ? chrome.runtime.getURL('platform-seeds.json')
                : null;
            if (!seedsUrl) return;

            const resp = await fetch(seedsUrl);
            if (!resp.ok) return;
            const seeds = await resp.json();
            if (!Array.isArray(seeds)) return;

            const registry = await getFieldRegistry();
            for (const seed of seeds) {
                if (!seed.fieldName || !seed.profileField || !seed.platform) continue;
                const key = normalizeFieldKey(seed.fieldName);
                if (!key) continue;
                // Never overwrite a learned entry — seeds are lowest priority
                if (registry.fields[key]) continue;
                // NEW-6 FIX: run seeds through the junk gate so a corrupt seeds file
                // cannot write opaque IDs or placeholder labels into the registry.
                if (isJunkLearnedField(seed.label || seed.fieldName)) continue;
                registry.fields[key] = {
                    profileField: seed.profileField,
                    labels: seed.label ? [seed.label] : [],
                    platforms: [seed.platform],
                    sources: ['seed'],
                    // NEW-7 FIX: uses: 1 (not 0) so lookupField's `uses >= 1` threshold
                    // is immediately satisfied and seeds are visible on the very first fill.
                    uses: 1,
                    confidence: seed.confidence || 0.75,
                    lastSeen: new Date().toISOString(),
                    schemaVersion: REGISTRY_VERSION
                };
            }
            await saveFieldRegistry(registry);
            // Mark as loaded so this never re-runs unless the flag is cleared
            await storageSet({ [SEEDS_FLAG_KEY]: true });
        } catch (e) {
            console.warn('[QuickApply] Platform seeds load failed:', e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════

    const QuickApplyLearning = {
        // Feature 1: Corrections
        saveCorrection,
        getCorrections,
        getCorrectionForField,
        clearCorrections,
        getAllCorrections,
        purgeBadCorrections,
        isJunkLearnedField,   // shared write-gate: reject junk labels/values before learning

        // Internal: SW-side direct write functions. Content scripts MUST NOT call these
        // — they bypass the cross-iframe serialization queue. Exposed only so
        // background.js (which imports this module) can reach them after dequeueing.
        resolveFieldIdentity,
        _saveCorrectionDirect,
        _recordFillResultDirect,
        _registerFieldDirect,
        _logUnknownFieldDirect,
        _saveCustomFieldDirect,

        // Feature 2: Resume Integrity
        computeFileHash,
        checkMagicBytes,
        verifyFileIntegrity,

        // Feature 3: Platform Learning
        recordFillResult,
        getPlatformKnowledge,
        getPlatformMappings,
        getAllPlatformKnowledge,

        // Feature 4: Suggestions
        logUnknownField,
        getSuggestions,
        dismissSuggestion,
        promoteSuggestion,

        // Feature 5: Universal Field Registry
        registerField,
        recordDiscoveredFields,
        lookupField,
        getAllRegistryFields,
        exportRegistry,
        importRegistry,
        getFieldRegistry,

        // Feature 6: Platform Seeds
        loadPlatformSeeds
    };

    if (typeof window !== 'undefined') window.QuickApplyLearning = QuickApplyLearning;
    if (typeof globalThis !== 'undefined') globalThis.QuickApplyLearning = QuickApplyLearning;

})();
