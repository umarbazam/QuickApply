# QuickApply — Technical Architecture Document

**Version:** 3.2.0
**Date:** 2026-05-06

---

## 1. System Overview

QuickApply is a Chrome Extension (Manifest V3) with zero backend dependencies. All data is stored locally via `chrome.storage.local`. The extension consists of 5 runtime contexts that communicate via Chrome's message passing API. An optional external dependency on Google Gemini API (user-supplied key) powers batch AI field resolution — all form fields are answered in a single Gemini call for maximum precision.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CHROME BROWSER                               │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │   POPUP      │    │  BACKGROUND       │    │  DASHBOARD        │  │
│  │  (popup/)    │◄──►│  SERVICE WORKER   │    │  (dashboard/)     │  │
│  │              │    │  (background.js)  │    │                   │  │
│  └──────┬───────┘    └────────┬─────────┘    └─────────┬─────────┘  │
│         │                     │                         │            │
│         │    chrome.runtime   │   chrome.tabs           │            │
│         │    .sendMessage()   │   .sendMessage()        │            │
│         │                     │                         │            │
│         │              ┌──────▼─────────┐               │            │
│         │              │ CONTENT SCRIPT  │               │            │
│         └──────────────► (content.js +   │               │            │
│                        │  cache.js +     │               │            │
│                        │  field-discoverer│              │            │
│                        │  fill-engine +  │               │            │
│                        │  ai-resolver +  │               │            │
│                        │  submit-engine +│               │            │
│                        │  platforms/ +   │               │            │
│                        │  field-mapper + │               │            │
│                        │  learning-eng)  │               │            │
│                        └───────┬────────┘               │            │
│                                │                         │            │
│                        ┌───────▼────────┐               │            │
│                        │ JOB PAGE DOM   │               │            │
│                        │ (any portal)   │               │            │
│                        └────────────────┘               │            │
│                                                         │            │
│  ┌──────────────────────────────────────────────────────▼──────────┐ │
│  │                    chrome.storage.local                          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │ │
│  │  │ Client 1 │  │ Client 2 │  │ Client 3 │  │  ...Client N   │  │ │
│  │  │ + CV     │  │ + CV     │  │ + CV     │  │  + CV          │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

Optional: background.js ──► Google Gemini API (user API key required)
```

---

## 2. Runtime Contexts

### 2.1 Background Service Worker (`background.js`)

**Lifecycle:** Runs in the background, activated on events, sleeps when idle (MV3 ephemeral model).

**Responsibilities:**
1. **Message Router** — Receives messages from Popup, routes to Content Script via `chrome.tabs.sendMessage()`
2. **AI Gateway** — Proxies AI requests (`CALL_AI_IDENTIFICATION`, `CALL_AI_NORMALIZATION`, `CALL_AI_CV_ANSWER`, `CALL_AI_CV_OPTION_SELECT`, `CALL_AI_CV_EXTRACT`) from content script / dashboard to Gemini API (content scripts cannot make cross-origin requests to Gemini)
3. **First Install Handler** — `chrome.runtime.onInstalled` → opens Dashboard page
4. **Badge Manager** — Updates the extension icon badge with fill status count

**Loaded scripts:** `storage.js`, `ai-engine.js`

**Startup:** `chrome.runtime.onStartup` evicts expired fingerprint cache entries from `qa_cache_v2` (90-day TTL).

**AI Message Types handled:** `CALL_AI_IDENTIFICATION`, `CALL_AI_NORMALIZATION`, `CALL_AI_CV_ANSWER`, `CALL_AI_CV_OPTION_SELECT`, `CALL_AI_CV_EXTRACT`, `CALL_AI_BATCH` (new — routes `callGeminiBatch` requests)

**Key Events:**
```javascript
chrome.runtime.onInstalled.addListener(details => { ... });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { ... });
```

### 2.2 Popup (`popup/`)

**Lifecycle:** Opens when user clicks extension icon. Destroyed when popup closes.

**Responsibilities:**
1. Load client list from `chrome.storage.local`
2. Display searchable client cards
3. Send `FILL_FORM` message directly to tab's content script (with fallback: inject scripts then retry)
4. Receive `FILL_REPORT` from Content Script → display Review Panel

**Fallback injection order** (when content script not pre-loaded):
```
storage.js → cache.js → field-mapper.js → learning-engine.js →
field-discoverer.js → fill-engine.js → ai-engine.js → ai-resolver.js →
platforms/base-filler.js → platforms/generic.js → [platform fillers] →
submit-engine.js → content.js
```

**State Machine:**
```
IDLE → (click Apply) → FILLING → (report received) → REVIEW
REVIEW → (click Back/Re-fill) → IDLE
REVIEW → (click Clear All) → send CLEAR_FORM → IDLE
```

### 2.3 Network Spy (`network-spy.js`)

**World:** MAIN (runs in page JS context, not isolated world)
**Lifecycle:** `document_start` — runs before any page scripts

**Responsibilities:**
- Monkey-patches `XMLHttpRequest.prototype.open/send` and `window.fetch` to intercept all outbound requests
- Captures `POST`, `PUT`, `PATCH`, `DELETE` requests only; skips static assets, analytics, CAPTCHA services
- Writes captured requests to `window.__qaNetBuf[]` (a synchronous shared buffer accessible from the isolated-world content script)
- Buffer capped at 200 entries (~1.6 MB max)

**Why shared buffer instead of `postMessage`:** `postMessage` is async and is not delivered before the `beforeunload` event fires, causing `networkRequests[]` to be empty in all recordings. The synchronous `window.__qaNetBuf` buffer is drained by `content.js` at each recording step.

### 2.4 Content Script (modular — 18 files)

**Lifecycle:** Injected into every web page matching `<all_urls>`, at `document_idle`, in all frames.

**Load order:**
```
storage.js → cache.js → field-mapper.js → learning-engine.js →
field-discoverer.js → fill-engine.js → ai-engine.js → ai-resolver.js →
platforms/base-filler.js → platforms/generic.js →
platforms/workday.js → platforms/greenhouse.js → platforms/icims.js →
platforms/smartrecruiters.js → platforms/lever.js →
platforms/ashby.js → platforms/workable.js →
submit-engine.js → content.js
```

> **v3.0.7 fix:** `ai-engine.js` is now injected as a content script (was previously only loaded by the background service worker via `importScripts()`). Without this, `window.QuickApplyAI` was always `undefined` in the content script context, silently disabling Tier 3 Gemini batch resolution on every form fill.

Each module is an IIFE that exposes a `window.QuickApply*` global. `content.js` is the orchestrator and has been reduced from ~3500 LOC to ~500 LOC by delegating to the modules.

**Responsibilities:**
1. Listen for `FILL_FORM` message
2. Scan page DOM to discover field rules via `QuickApplyFieldDiscoverer.scan()` (Shadow DOM + iframes)
3. Resolve answers via 3-tier pipeline: Tier 1 (profile direct), Tier 2 (fingerprint cache), Tier 3 (Gemini batch)
4. Fill fields via `QuickApplyFillEngine.fillAll()` with scrollIntoView pacing
5. Run platform-specific pre/post fill hooks via `PlatformFillerFactory`
6. Optionally run `QuickApplySubmitEngine.run()` for multi-step auto-advance + submit
7. Detect user corrections on filled fields → save to Learning Engine
8. Send `FILL_REPORT` + `FILL_PROGRESS` back to Popup/Dashboard
9. Watch for dynamically added fields (MutationObserver for SPA portals)

### 2.5 Dashboard (`dashboard/`)

**Lifecycle:** Full tab opened via `chrome.runtime.getURL('dashboard/dashboard.html')`.

**Responsibilities:**
1. Full CRUD for client profiles
2. CV file upload + auto-parse (extract fields from resume using cv-parser.js)
3. Extract and store CV plain text (`cvText`) for AI-powered open-ended answering
4. Import/Export JSON (clients + settings)
5. Settings (Gemini API key)
6. Smart Suggestions panel (unknown fields seen ≥3 times across forms)
7. **Re-parse CV with AI** button — calls `CALL_AI_CV_EXTRACT` to enrich missing profile fields using Gemini; only overwrites empty fields (safe to re-run)

**Loaded scripts:** `storage.js`, `learning-engine.js`, `cv-parser.js`, `dashboard.js`

**Dashboard Tabs:**
1. **Clients** — CRUD for client profiles + CV upload + AI re-parse
2. **Fill Log** — Last 100 fill sessions, field-level breakdown, clear button
3. **Recordings** — ATS network recordings per session (drained from `window.__qaNetBuf`)
4. **Learning** — View/reset corrections and platform knowledge
5. **Settings** — Gemini API key, default password, import/export, autoAdvanceSteps + autoSubmit toggles
6. **AI Cache** — Cache stats by platform, clear cache per client or all, entry count + hit rate

### 2.6 Storage Layer (`storage.js`)

**Shared utility** imported by Popup, Dashboard, and Background Service Worker.

---

---

## 3. Message Protocol

### 3.1 Content Script ↔ Popup (direct)

| Message | Direction | Payload |
|---|---|---|
| `FILL_FORM` | Popup → Content | `{ profile: ClientProfile, settings: AppSettings }` |
| `FILL_REPORT` | Content → Popup (via chrome.runtime) | `{ results: FillResult[], summary, platform, url, timestamp }` |
| `FILL_PROGRESS` | Content → Dashboard (via chrome.runtime) | `{ filled, total, filledLabels, missingRequiredLabels, required: { filled, total } }` |
| `CLEAR_FORM` | Popup → Content | `{}` |
| `SCROLL_TO_FIELD` | Popup → Content | `{ selector: string }` |
| `GET_PAGE_INFO` | Popup → Content | `{}` |
| `PING` | Popup → Content | health check |

### 3.2 Content Script → Background (AI proxy)

| Message | Direction | Payload |
|---|---|---|
| `CALL_AI_IDENTIFICATION` | Content → Background | `{ label, name, id, placeholder, platform, domain, htmlName }` |
| `CALL_AI_NORMALIZATION` | Content → Background | `{ field, value, options[], questionLabel, profileContext, platform, domain, htmlName }` |
| `CALL_AI_CV_ANSWER` | Content → Background | `{ label, cvText, platform }` |
| `CALL_AI_CV_OPTION_SELECT` | Content → Background | `{ label, options[], cvText, platform, profileContext }` |
| `CALL_AI_CV_EXTRACT` | Dashboard → Background | `{ cvText, existingProfile }` |
| `FILL_REPORT` (badge) | Content → Background | same as above, for badge update |

### 3.3 Message Flow Diagram

```
Popup                  Content Script           Background              Gemini API
  │                         │                       │                      │
  │── FILL_FORM ────────────►│                       │                      │
  │                         │── CALL_AI_IDENT ──────►│── POST /generateContent►│
  │                         │◄─ aiResult ────────────│◄─ response ──────────│
  │                         │── (fill fields) ───────│                      │
  │                         │── CALL_AI_NORMAL ──────►│── POST /generateContent►│
  │                         │◄─ matchedOption ────────│◄─ response ──────────│
  │◄── FILL_REPORT ─────────│                       │                      │
  │── (show review) ────────│                       │                      │
```

---

## 4. Auto-Fill Engine Architecture

### 4.1 Pipeline (v3.0 — Batch Resolution)

```
┌──────────────┐   ┌────────────────────────────────────────┐   ┌──────────────┐   ┌──────────────┐
│  1. DISCOVER  │──►│  2. RESOLVE (3-tier)                    │──►│  3. FILL      │──►│  4. REPORT   │
│  FieldRules[] │   │  T1: Profile direct (field-mapper)      │   │  FillEngine  │   │  FILL_REPORT │
│  + fingerprints│  │  T2: Fingerprint cache (L1+L2)          │   │  per field   │   │  FILL_PROGRESS│
│               │   │  T3: Gemini batch (all unknowns at once)│   │  type        │   │              │
└──────────────┘   └────────────────────────────────────────┘   └──────────────┘   └──────────────┘
```

**Key architectural shift vs v2.x:** In v2.x, Gemini was called once per unknown field (serial, slow, expensive). In v3.0 all unknown fields are batched into a single Gemini call. This matches Jobright AI's server-side "answer all fields at once" approach, achieving the same precision client-side.

**BLOCKED_HOSTS Guard:** At the very top of the content script IIFE, the hostname is checked against a static `_BLOCKED_HOSTS` Set. If matched, the script returns immediately.

**ProfileField Dedup:** A `_filledProfileFields` Set is created per `handleFill` invocation, preventing EEO radio groups and multi-iframe forms from filling the same semantic field 3–6 times per session.

**Step 1 — Discover (`field-discoverer.js`):**
- `QuickApplyFieldDiscoverer.scan(root, platform)` returns `FieldRule[]`
- Each `FieldRule`: `{ label, type, required, options, element, selector, fingerprint, platform }`
- **Fingerprint:** `FNV-1a(normalized_label|type|sorted_options)` — synchronous, platform-agnostic, same question on any ATS = same fingerprint
- 9-strategy label chain: `label[for]` → `data-automation-id` humanize → previous sibling → `.form-group > label` → wrapping label → XPath (iCIMS `labelText`/`tc_formLabel`/`datasetlabelText`, Workday `tc_formTitle`) → parent label → `aria-label/labelledby` → `placeholder`
- Recursively walks shadow roots and same-origin iframes; visibility via `getBoundingClientRect()` (not `offsetParent` — shadow DOM safe)
- Capped at 500 fields (FIELD_LIMIT)

**Step 2 — Resolve (`ai-resolver.js`, 3 tiers):**

| Tier | Module | Mechanism | Speed |
|------|--------|-----------|-------|
| T1 | `field-mapper.js` | Profile direct match (14 priority levels, corrections, platform learned) | Synchronous |
| T2 | `cache.js` | Fingerprint cache: L1 (in-memory Map) + L2 (`qa_cache_v2` in chrome.storage) | Async, <5ms |
| T3 | `ai-engine.js` | Single Gemini batch call for all remaining unknowns | Async, ~2-5s |

**Cache key:** `clientId + ":" + fingerprint` — per-client isolation prevents data contamination across profiles. TTL: 90 days. Evicted on `chrome.runtime.onStartup`.

**Step 3 — Fill (`fill-engine.js`):**
- `QuickApplyFillEngine.fillAll(rules, answersMap, { filledSelectors, skipFocus, tracker })`
- `scrollIntoView({ behavior: 'smooth', block: 'center' })` + 100ms delay before every field
- 80ms pacing between fields
- Second `change`+`blur` cycle after `keydown/keyup` for Angular/Vue compatibility
- **No `focus` event** — React 15 (Workable/Greenhouse) resets DOM value on `onFocus`
- `composed: element.getRootNode() !== document` on all events for shadow DOM compatibility
- `filledSelectors` Set passed in — cross-step re-fill guard for submit engine

**Step 4 — Report:**
- `ProgressTracker` (in `fill-engine.js`) sends per-field `FILL_PROGRESS` messages via `chrome.runtime.sendMessage`
- Final `FILL_REPORT` sent to Popup with `FillResult[]`

**Step 1 — Identify (legacy path, still active as fallback):** For each element, run identification in priority order:
1. **Correction Check** — Exact match against user-saved corrections by `fieldName`/`fieldSelector`
2. **Correction by profileField** — Re-checks by `profileField` + domain; survives HTML attribute changes
3. **Platform Learned** — Domain-specific mappings with uses≥2, confidence≥0.6
4. **Custom Field** — Profile-specific custom fields (token-overlap matching)
5. **data-automation-id** — Workday primary identifier
6. **data-testid** — SmartRecruiters primary identifier
7. **Name attribute** — 200+ field aliases
8. **ID attribute** — same aliases
9. **Label element** — shadow DOM safe via `getRootNode()`
10. **Placeholder** — alias match
11. **Aria-label** — alias match
12. **Nearby text** — sibling/ancestor scan
13. **Universal Registry** — cached AI discoveries (confidence ≥ 0.6)
14. **Gemini AI** — per-field fallback (used only if batch resolver is unavailable)

### 4.2 Enriched Label Fetching (`getElementContext`)

When standard `<label>` tags are missing, the Content Script uses a multi-strategy label discovery engine. It scans up to 8 ancestors and also checks `aria-labelledby`, `aria-label`, `legend`, and `p` elements. All DOM queries are routed through `element.getRootNode()` for shadow DOM safety, and the entire function is wrapped in a try-catch to prevent errors in hostile DOMs. The resulting `contextLabel` is passed to all downstream matching functions (identifyField, fuzzyMatchOption, AI normalization):

1. **`<label for="id">`** — Standard HTML association
2. **Parent `<label>`** — Element wrapped inside a label
3. **`aria-labelledby`** — Resolves referenced element text via `getRootNode().getElementById()`
4. **`aria-label`** — Direct aria-label attribute on the element
5. **`legend`** — Nearest `<fieldset>` legend text
6. **Preceding sibling scan** — Up to 8 previous siblings, looks for text ending in `?` or `:` or starting with uppercase (question heuristic), also checks `<p>` elements
7. **Ancestor heading/bold** — Searches closest `div/p/section/li` for `h1-h6`, `b`, `strong`, `.label`, `.title`
8. **Ancestor scan (8 levels)** — Walks up to 8 ancestor elements looking for any descriptive text content

### 4.3 Dropdown Semantic Matching (`fuzzyMatchOption`)

Handles the case where form dropdown options differ from profile values in phrasing:

```
Profile value: "Yes" (workAuthorization = authorized to work)
Form question: "Will you now or in the future require employer sponsorship?"
Form options:  ["Yes, I need sponsorship", "No, I do not need sponsorship"]
Correct answer: "No, I do not need sponsorship"
```

**Matching cascade:**
1. Exact match (case-insensitive)
2. VALUES_MAP lookup (EEO fields + workAuthorization + employmentType + remotePreference)
3. **Semantic inversion detection** — Regex detects sponsorship-question phrasing, inverts Yes/No for `workAuthorization`
4. Prefix match — "Yes" matches "Yes, I need..."
5. Token overlap — all target tokens found in option tokens
6. First-word match — last resort for Yes/No options

**Negation-aware scoring (EEO fields):**
- `containsWholePhrase()` helper is used instead of substring match to prevent false positives such as "i am not a veteran" matching the "i am a veteran" synonym bucket.
- For `veteranStatus` and `disabilityStatus`, options that contain negation words ("not", "never", "no") receive a ×0.3 penalty when scored against a positive bucket, and vice versa. This prevents polarity mismatch fills.
- Simple yes/no dropdown aliases ("yes", "no") are included in veteran and disability VALUES_MAP entries to handle portals that present these as a plain Yes/No question.

**Semantic inversion for `workAuthorization`:**
- When the question label contains "require sponsorship", "need sponsorship", or "employer sponsor", the polarity is inverted before matching:
  - Profile value "Yes" (authorized to work) → selects option meaning "No, I do not require sponsorship"
  - Profile value "No" (not authorized) → selects option meaning "Yes, I require sponsorship"
- When the label contains "authorized to work", "eligible to work", or "right to work", no inversion is applied.

**Gemini normalization fallback** (when confidence < 0.8 and API key set):
- Sends the actual question text (`questionLabel`) + candidate value + all option texts to Gemini
- Gemini understands the semantic of the question and picks correctly

### 4.4 Event Dispatch (Framework Compatibility)

`fill-engine.js` `fillText` dispatches a sequence designed to satisfy React 16+, Angular, Vue, and React 15 simultaneously:

```
native setter → _valueTracker.setValue (React 16+) → input → change → keydown(13) → keyup(13) → change → blur
```

**Composed flag:** `{ bubbles: true, composed: element.getRootNode() !== document }` — needed for Workday shadow DOM; harmless on regular documents.

**No `focus` event anywhere in fillText** — React 15 (Workable/Greenhouse) `onFocus` resets DOM value to internal state. The `focus` event is never dispatched in `fillText`.

**Second cycle:** After `keyup`, a second `change` + `blur` cycle fires for Angular/Vue which react on `blur` not `input`.

### 4.5 Platform Filler Classes (`platforms/`)

Each platform extends `BaseFiller` and is registered with `PlatformFillerFactory`:

```
BaseFiller (base-filler.js)
├── GenericFiller        — standard HTML forms
├── WorkdayFiller        — Shadow DOM + data-automation-id + Polymer 2.x binding
├── GreenhouseFiller     — React-Select comboboxes, edu/exp section expand
├── iCIMSFiller          — opaque Question_ IDs, XPath label extraction, save button
├── SmartRecruitersFiller— iframes, collapsed sections, save-on-step
├── LeverFiller          — name/org attr mapping, identity re-fill after CV parse
├── AshbyFiller          — Yes/No button groups, CV loop guard, TipTap contenteditable
├── WorkableFiller       — skipFocus=true (React 15), aria-hidden skip
├── BreezyFiller         — Angular ng-* form detection, honeypot skip, pay-period postFill
└── TeamtailorFiller     — turbo-frame apply overlay, Rails nested names, Places address commit
```

`PlatformFillerFactory.create(platform, profile, settings)` — accepts the resolved platform string from `content.js _getPlatform()`. Never accepts URL directly; platform detection stays private in content.js.

Each filler exposes:
- `preFill()` — expand sections, wait for fields
- `discoverFields()` — platform-specific override of field discoverer
- `postFill()` — post-fill actions (Lever: re-fill identity, SmartRecruiters: save)
- `getNextSelectors()` — CSS selectors for Next/Continue buttons (submit engine)
- `get skipFocus()` — returns `true` on WorkableFiller

### 4.6 Submit Engine (`submit-engine.js`)

`QuickApplySubmitEngine.run(filler, profile, resumeText, clientId, settings, aiInstance, notifyUser)` drives multi-step forms end-to-end:

```
while step < 15:
  1. preFill() — expand sections
  2. discoverFields() — scan current step
  3. resolveBatch() — 3-tier resolution
  4. fillAll() — fill with filledSelectors dedup
  5. detectValidationErrors() — check red fields via getBoundingClientRect()
  6. if errors: pause, notify, break
  7. if autoAdvanceSteps: click Next button
  8. waitForDOMSettle(500ms quiet, 8s max) — wait for page transition
  9. classify button: Next vs Submit
  10. if Submit and autoSubmit: click submit, break
```

`filledSelectors` Set initialized once before the loop and passed to every `fillAll` call — prevents re-filling already-filled fields on later steps.

`waitForDOMSettle` uses MutationObserver: resolves after 500ms with no DOM mutations, or after 8s timeout.

### 4.7 AI Gateway

All four AI handler types (`CALL_AI_IDENTIFICATION`, `CALL_AI_NORMALIZATION`, `CALL_AI_CV_ANSWER`, `CALL_AI_CV_OPTION_SELECT`) are wrapped in a `Promise.race` timeout via a shared `runAI()` helper in `background.js`. Field identification and normalization time out at 8 seconds; CV answer and option-select time out at 20 seconds.

**Platform Memory Loader** — Before every AI call, `background.js` calls `loadPlatformMemory(domain, htmlName)` which reads `quickapply_platform_knowledge` from storage and computes:
- `siteMemory` — all successfully-learned fields for this domain (uses≥1, confidence≥0.45, not errored)
- `fieldHistory` — specific history for the field being identified/normalised
- `directHit` — if confidence≥0.6 for this field's normalised key, a `directHit` object is computed and injected as the first line of the `identifyField` prompt, short-circuiting LLM reasoning

**Binary dropdown threshold** — For `CALL_AI_NORMALIZATION`, the confidence threshold for accepting a Gemini result is dynamically lowered from 0.65 to 0.50 when the dropdown has exactly 2 options. A 50% random-guess baseline means even a 0.51 AI response is meaningful information.

**Referral field skip** — Before calling `CALL_AI_CV_ANSWER`, content.js checks if the field label matches `/referr(al|ed)|recruiter.{0,20}name|who referred|referred by/i`. If so, the field is logged as `skipped` (strategy: `referral-skip`) and no AI call is made.

Gemini response handling:
- Response text is passed through a markdown strip step that removes code fences (` ```json ... ``` `) before `JSON.parse()`.
- Text extraction uses a null-chain: `candidates?.[0]?.content?.parts?.[0]?.text` — if any level is missing, returns `null` rather than throwing.
- Error messages include the first 200 characters of the response body for easier debugging.

### 4.8 CV Upload Strategy

The CV is stored as base64 on the profile (`cvData`). During fill:
1. Decode base64 → binary → `File` object
2. Find file input: prefer labeled "resume/cv" input; fallback to first file input
3. Set via `DataTransfer` API
4. Dispatch `change` + `input` events

Additionally, `cvText` (plain text extracted from CV, max 8KB) is stored on the profile at save time, enabling AI-powered open-ended question answering without re-parsing binary data.

### 4.9 Learning Engine

Six features run automatically during and after each form fill:

| Feature | Trigger | Storage Key |
|---|---|---|
| **Correction Memory** | User edits a filled field | `quickapply_corrections` |
| **Resume Integrity** | CV uploaded to profile | `cvHash` on ClientProfile |
| **Platform Learning** | Each successful fill | `quickapply_platform_knowledge` |
| **Smart Suggestions** | Unknown field seen ≥3 times | `quickapply_unknown_fields` |
| **Universal Field Registry** | Any fill ≥0.7 conf OR correction | `quickapply_field_registry` |
| **Fill Log** | Every FILL_REPORT received | `quickapply_fill_log` |

**Thresholds:**
- **Registry confidence increment:** +0.1 per fill — reaches 0.6 activation threshold after ~2 fills.
- **Platform mapping confidence increment:** +0.15 per successful fill — reaches 0.6 after ~2 successes.
- **Platform mapping activation threshold:** 0.6.
- **Confidence floor:** Fields with successCount≥3 have a minimum confidence floor of 0.3, preventing error-decay from zeroing out well-established mappings.
- **Label deduplication:** Registry stores up to 10 labels per field. Near-duplicate labels (Levenshtein similar) are rejected before insertion.

**L7 — Opaque Field Key Fix:**
Greenhouse/iCIMS EEO questions use per-job opaque IDs (`Question_56843325004`, `rcf2044`). Previously, a correction saved for one Greenhouse job never applied to the next — the HTML ID changes per posting. Now when `fieldName` matches `/^(question_\d|rcf\d|input_\d|field_\d)/i`, `contextLabel` (the human-readable question text) is used as the stable dedup key. Corrections now transfer across all job postings on the same platform.

**L8 — Registry Self-Population:**
Every fill with confidence ≥ 0.70 and a known non-custom `profileField` automatically calls `registerField({ fieldName: contextLabel, label: contextLabel, profileField, source: 'form_fill' })`. The system builds field knowledge from successful fills, not just human corrections. After a few fills on a new ATS, the registry covers all common fields without any user action.

**Priority 1b — Correction by profileField:**
After field identification completes, corrections are also looked up by `profileField` + domain. If an HTML attribute (`name`/`id`) changes between visits (common on SPAs), the correction still applies because the lookup is by semantic field name.

**Correction Loop to Platform Knowledge (G1):**
When `saveCorrection` writes to the registry, it also directly updates `platform.fields[normKey].profileField` if a domain entry already exists. This ensures corrections are immediately reflected in platform memory without waiting for the next fill cycle.

**Token Overlap Label Matching:**
For labels longer than 20 characters, field registry lookup uses word-token overlap (≥0.55 threshold) instead of Levenshtein distance. Stop words (what, is, your, are, etc.) are filtered before comparison. This prevents "What is your preferred work location?" and "Preferred work location" from failing to match.

### 4.10 Platform-Specific Adaptations

#### Workday
- Forms use deep Shadow DOM composition. The discovery step recursively traverses all shadow roots.
- Primary field identifier: `data-automation-id` attribute checked on the element and its nearest ancestor.
- Common `data-automation-id` format: `legalNameSection_firstName` — the prefix is stripped and the remainder is matched against aliases.
- Label lookups use `element.getRootNode()` so `getElementById` resolves within the correct shadow root rather than the main document.
- Custom dropdowns use `[role="combobox"]` — discovered and filled via click simulation (click trigger → wait for option list → click matching option).

#### SmartRecruiters
- Form sections are rendered inside `<iframe>` elements. `discoverFields()` scans `iframe.contentDocument` for all iframes on the page.
- Primary field identifier: `data-testid` attribute. `matchByDataTestId()` strips type prefixes (`input-`, `field-`, `form-`, `sr-`) then strips section prefixes (`experience-`, `education-`, `work-`, `job-`) before alias matching.
- Education and experience sections start in a collapsed/empty state. `expandSections()` clicks "Add" buttons before `discoverFields()` runs so the fields are present in the DOM.
- Radio button queries use `element.ownerDocument` rather than the top-level `document` so they work inside iframes.

#### Lever
- Standard HTML with no shadow DOM or iframes — existing strategies work without adaptation.
- Key non-obvious field mappings: `name` attribute → `fullName`, `org` attribute → `currentCompany`.
- URL fields follow the pattern `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`.
- EEO section uses standard `<select>` dropdowns matched via VALUES_MAP.

#### Greenhouse
- Standard server-rendered HTML for base fields; React-Select comboboxes for EEO and custom questions.
- EEO section uses React-Select comboboxes (`role="combobox"`), NOT plain `<select>`. Opened via "Toggle flyout" button which may be a sibling of `parentElement.parentElement`, not inside `.select__control`. `fillField` uses `_nearestParent = _selCtrl || element.parentElement?.parentElement` to find the button.
- Custom dropdown fields return internal numeric IDs (e.g. `"56843325004"`) as `field.value`. Correction listener skips values matching `/^\d{7,}$/` to avoid storing these internal IDs.
- EEO question IDs are opaque per-job (`Question_56843325004`). Corrections use `contextLabel` as the stable dedup key (L7 fix) so corrections survive across different Greenhouse job postings.
- AI fill buttons are appended with `position:fixed` directly to `document.body` to escape parent containers that use `overflow:hidden`.
- Platform seeds include EEO field IDs (`gender`, `veteran_status`, `disability_status`, `race`, `hispanic_ethnicity`) + `candidate-location`, `school--0`, `degree--0`.

#### Ashby
- React SPA at `jobs.ashbyhq.com`. Form renders asynchronously — `waitForFields(6000, 300)` runs.
- Cover letter uses TipTap `contenteditable` div (not a `<textarea>`).
- CV upload guard: `skipCV: true` flag on observer-triggered refills prevents re-upload loops. `handleCVUpload` checks `dataset.quickapplyUploaded` before uploading.
- AI fill icons injected at 1500ms, 3500ms, and 6000ms after `initializeProfile` to catch late-rendered textareas.

#### iCIMS
- Standard HTML, sometimes async SPA. `waitForFields(6000, 300)` runs.
- Field names use dotted format: `applicant.field.firstname`, `applicant.field.email`, `applicant.field.phone1`.
- Custom questions use opaque names like `Question_12345` — identified via `contextLabel` strategy (Strategy 9) which reads the nearby visible label.
- Labels appear in `<th>` elements (table header cells) — `getElementContext` checks `th` and `[class*="field-name"]` ancestors.
- Password fields filled from `profile.defaultPassword` — a per-client field set on each client's own profile (Dashboard → client → Personal Info → Account Password). Clients with no password set skip password fields.

#### Breezy

- Angular SPA at `*.breezy.hr`. Form renders with `ng-*` CSS classes on `<form>`. `preFill()` polls for Angular-rendered form up to 5s.
- Standard fields use `c`-prefix names: `cName`, `cEmail`, `cPhoneNumber`, `cAddress`, `cSalary`, `cCoverLetter`, `cSummary`, `cResume`.
- EEO fields use dotted names (`eeoc.gender`, `eeoc.race`, `eeoc.veteran_status`, `eeoc.disability_status`) OR flat names (`gender`, `race_ethnicity`) depending on employer config — both sets are in `getFieldAliases()`.
- **Honeypot guard:** All forms inject a hidden field `name="hp_7f2b"` / `autocomplete="hp-4f3c9a"`. `discoverFields()` filters these out before any fill path runs.
- **Custom radio label fix:** Angular exposes the first radio option's text (e.g. `"Yes"`, `"Indeed"`) as the group label. `discoverFields()` runs `_findAngularQuestionLabel()` on all `section_\d+_question_\d+` radio groups to recover the real question heading. Also fixes empty-label custom checkboxes.
- **postFill:** Auto-checks `smsConsent` (and any consent checkbox) by `name` attribute since label is always empty. Fills unnamed pay-period select `[Hourly|Weekly|Monthly|Yearly]` → `Yearly` by option-text scan. Defaults `salaryCurrency` select to `"US Dollar ($)"` if not already filled.

#### Workable
- React 15 SPA. Fields: `name="firstname"`, `lastname`, `email`, `phone`, `headline` (→ currentJobTitle), `summary` (→ coverLetter/cvText), `cover_letter`.
- Uses `__reactEventHandlers` for event binding + `_valueTracker` for change detection. **Critical:** never fire `focus` event — React 15 `onFocus` resets DOM value to internal state, undoing the fill.
- Address fields (`city`, `postcode`, `country`) have `aria-hidden="true"` — skipped by `discoverFields`.
- Primary identifier: `data-ui` attribute (e.g. `data-ui="firstname"`) — Strategy 8a `matchByDataUi()`.
- Custom QA fields (e.g. `QA_XXXXXXX`) use AI fill button for open-ended answering.

#### Teamtailor
- Rails + Stimulus + Turbo career site at `{tenant}.teamtailor.com`, frequently served from a customer-owned domain (e.g. `careers.oatly.com`). `field-mapper` matches the vendor host; `content.js _getPlatform()` resolves custom domains from the careersite markers (`teamtailor-cdn.com` assets, `careersite--*` controllers on `<body>`, `#job-application-form`).
- **Form is not on the page at load.** It lives in a lazy `<turbo-frame id="application_form">` that fetches `/jobs/{id}/applications/new` only when "Apply for this job" is clicked. `preFill()` clicks `[data-action*="form-overlay#showFormOverlay"]:not([disabled])` (the duplicate floating button starts disabled) and polls up to 12s for `#job-application-form`. The standalone `/applications/new` URL already contains the form and skips the click.
- Rails-nested field names — `candidate[first_name]`, `candidate[email]`, `candidate[phone]`, `candidate[location][query]`, `candidate[job_applications_attributes][0][cover_letter]`. `matchAgainstAliases()` strips brackets, so `getFieldAliases()` carries the bracket-free forms (`candidatefirst_name`, …).
- **Discovery is scoped to `#job-application-form`** once it is open — career sites also render a "Connect" email form (`name="full_email"`) in the footer.
- **Label repair:** required markers are `<sup>*</sup>` plus a visually-hidden `<span class="sr-only">Required</span>`. `discoverFields()` recomputes each label from its `<label>`/`<legend>` with those nodes removed, and promotes `required` from the question block's `data-question-mandatory`.
- **Screening questions** need no other handling: free-text answers have a real `<label for>`, choice/boolean answers are `<fieldset><legend>` + per-option `<label for>`. Boolean radios post `true`/`false` with `Yes`/`No` labels.
- **Conditional questions** (`data-question-show-if-uuid`) are already in the DOM and revealed by removing a wrapper class — no nodes are added, so the content-script MutationObserver never fires. `postFill()` detects a revealed-but-unanswered mandatory question and calls `window.QuickApplyRequestRefill()` for one bounded extra pass.
- **Address** is a Places-style autocomplete: typing alone leaves `candidate[location][place_id]/[city]/[state]/[country]/[lat]/[long]` empty and the address is dropped server-side. `postFill()` types the profile address char-by-char, scores the `[role="option"]` suggestions against city/state/country, clicks the best one, and confirms `place_id` landed (falls back from street-level to city-level query).
- **CV** goes through Dropzone (`.dz-hidden-input`) to S3; the generic `DataTransfer` upload triggers it. `postFill()` waits for every `.dz-preview` to reach `dz-success`/`dz-complete` before driving the address widget, since Teamtailor disables the form mid-upload.
- `candidate[consent_given]` is a hidden `1` on tenants without GDPR consent and a mandatory checkbox on tenants with it; `postFill()` ticks that one field by name.

---

## 5. Security Model

| Concern | Mitigation |
|---|---|
| **Data at rest** | All data in `chrome.storage.local` — encrypted by Chrome at OS level |
| **Data in transit** | Only Gemini API calls (optional, user-controlled API key). No other network requests. |
| **XSS via content script** | Content script runs in isolated world. Cannot access page JS context. |
| **Malicious pages** | Content script only reads/writes form field values. No `eval()`, no `innerHTML` injection. |
| **CV privacy** | CVs stored as base64 in local storage. Never transmitted (cvText sent to Gemini is optional and user-controlled). |
| **Permissions** | Minimal: `storage`, `unlimitedStorage`, `activeTab`, `scripting` |
| **AI calls** | Only to `generativelanguage.googleapis.com`. Requires explicit user API key. |

---

## 6. File Structure & Dependencies

```
Ja/
├── manifest.json              # Extension manifest (MV3, v3.2.0)
├── background.js              # Service worker — message router + AI gateway + cache eviction
├── network-spy.js             # MAIN world XHR/fetch interceptor → window.__qaNetBuf
├── content.js                 # Content script — orchestrator (~500 LOC, delegates to modules)
├── cache.js                   # Fingerprint cache — FNV-1a, L1 memory + L2 chrome.storage, 90d TTL
├── field-discoverer.js        # Form scanner — 9-strategy label extraction, FieldRule[], fingerprints
├── fill-engine.js             # Fill methods — fillText/Select/Radio/Checkbox/Date/Combobox/File
│                              #   + scrollIntoView pacing + ProgressTracker
├── ai-resolver.js             # 3-tier resolver — T1 profile, T2 cache, T3 Gemini batch
├── submit-engine.js           # Multi-step form driver — waitForDOMSettle, validation detection
├── platforms/
│   ├── base-filler.js         # BaseFiller class + PlatformFillerFactory
│   ├── generic.js             # GenericFiller — standard HTML forms
│   ├── workday.js             # WorkdayFiller — Shadow DOM, Polymer 2.x events
│   ├── greenhouse.js          # GreenhouseFiller — React-Select, edu/exp expand
│   ├── icims.js               # iCIMSFiller — opaque Question_ IDs, save button
│   ├── smartrecruiters.js     # SmartRecruitersFiller — iframes, collapsed sections
│   ├── lever.js               # LeverFiller — name/org attr mapping, identity re-fill
│   ├── ashby.js               # AshbyFiller — Yes/No buttons, CV loop guard
│   └── workable.js            # WorkableFiller — skipFocus=true, React 15
├── field-mapper.js            # Field detection + fuzzyMatchOption engine (legacy + T1 for batch)
├── learning-engine.js         # Corrections, platform learning, field registry
├── ai-engine.js               # Gemini wrapper — identifyField, normalizeValue, callGeminiBatch
├── storage.js                 # chrome.storage.local wrapper — client CRUD, settings, import/export
├── cv-parser.js               # PDF/DOCX text extraction via pdf.js + ZIP/XML
├── platform-seeds.json        # Pre-loaded field mappings for 7 ATS platforms (100+ entries)
├── popup/
│   ├── popup.html             # Popup markup — 4 states + autoAdvance/autoSubmit toggles
│   ├── popup.js               # Popup logic — client list, fill trigger, review panel
│   └── popup.css              # Popup styles
├── dashboard/
│   ├── dashboard.html         # Dashboard markup + AI Cache panel
│   ├── dashboard.js           # Dashboard logic — CRUD, CV parse, settings, cache stats
│   └── dashboard.css          # Dashboard styles
├── lib/
│   ├── pdf.min.js             # Mozilla PDF.js — PDF text extraction
│   └── pdf.worker.min.js      # PDF.js worker thread (web_accessible_resource)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test/
│   └── test-form.html         # Local test form for development
└── docs/
    ├── PRD.md
    ├── ARCHITECTURE.md        ← this file
    ├── DATA_SCHEMA.md
    ├── UI_SPEC.md
    ├── FIELD_MAPPINGS.md
    └── BUILD_GUIDE.md
```

**External Dependencies:** pdf.js (bundled in `/lib`). Optional: Google Gemini API (user-supplied key).

---

## 7. Performance Targets

| Operation | Target | Approach |
|---|---|---|
| DOM discovery (`field-discoverer.js`) | < 200ms | Single-pass traversal, Shadow DOM recursive |
| Fingerprint cache hit (L1) | < 1ms | In-memory Map lookup |
| Fingerprint cache hit (L2) | < 10ms | chrome.storage.local read |
| T1 profile resolution | < 50ms | Synchronous field-mapper.js |
| T3 Gemini batch (all unknowns) | 2000–5000ms | Single call for all fields vs. N serial calls |
| Field filling (per field) | < 200ms | scrollIntoView + 80ms pacing |
| Total fill time (no AI / cache hit) | < 1000ms | Discovery + T1/T2 + fill |
| Total fill time (with Gemini batch) | < 8000ms | One batch call + fill |
| CV upload | < 300ms | Pre-decoded file, synchronous DataTransfer |
| Popup open | < 100ms | Pre-loaded client list in storage |
| Dashboard load | < 300ms | Vanilla HTML, no framework overhead |

---

## 8. Known Issues & Limitations (as of v3.2.0)

The extension is production-stable across Workday, Greenhouse, Lever, SmartRecruiters, Ashby, iCIMS, Workable, Breezy, Pinpoint, Rippling, Applied, and generic HTML forms.

| ID | Issue | Impact | Status |
|---|---|---|---|
| B101 | MutationObserver race — stale profile on rapid re-fills | Very low | Backlog |
| B107 | Cross-client `correction-by-profile` bleed — correction for Client A may apply to Client B if they share a platform and profileField | Low | Backlog |
| B123 | `saveClient()` missing required field validation (firstName, lastName, email) | Low — UI doesn't prevent save with empty required fields | Backlog |
| B127 | Popup `sendMessage` response can be `undefined` — no null guard before accessing `.type` | Low — causes console error, not crash | Backlog |
| B-WF | "Illegal invocation" on some Greenhouse jobs (WearFigs) — `dispatchEvents` called on shadow DOM proxy element. Now caught and reported in console but field is left unfilled. | Low | Monitoring |
| B-SR | SmartRecruiters city/country geocomplete resets after fill — address widget clears value on blur | Low | Monitoring |
| — | MutationObserver re-fill capped at 3 cycles, 30s window | Very low — by design | Acceptable |
| — | Shadow DOM + cross-origin iframe nesting not scanned | Very low — rare in practice | Backlog |
| — | BLOCKED_HOSTS list is static — new embed domains require code update | Very low | Backlog |

---

## 8.5 Job Analyzer

The Job Analyzer scores every job posting against a selected client's preferences and surfaces the verdict in the popup before the user clicks Fill. It is a parallel pipeline to the auto-fill engine — extraction and scoring run silently while the user reads the JD; nothing fills until the user explicitly chooses to apply.

### Two-phase pipeline

**Phase A — silent extraction (document_idle, on every JD page load).** The first matching adapter in `jd-extractor.js` runs (`platforms/greenhouse-jd.js` or `platforms/workday-jd.js`). It produces a `JdObject` (see DATA_SCHEMA § 1.8) and persists it to `jd-cache.js` (L1 in-memory Map + L2 `chrome.storage.local`, FNV-1a fingerprint, 7-day TTL, 100-entry LRU). Workday's adapter computes a stable `jobKey` of the form `workday:{tenant}:{jobId}` from the URL — the same key the apply page produces — so cache hits survive the JD → apply navigation.

**Phase B — scored match (popup open, on demand).** When the popup mounts, it sends `GET_FIT_SCORE { clientId }` to the active tab. The content-script handler in `content.js` resolves the cached JD (or re-extracts), loads the client profile + settings, and runs `fit-matcher.js` `scoreWithAi(jd, profile, settings)`. The matcher first scores **hard parameters** (visa, location, work mode, employment type) as pass / fail / manual; if any fail, the verdict short-circuits to `not_a_fit`. Otherwise it scores **soft parameters** (YoE, salary, title, skills) as 0–100 and combines them via `settings.fitWeights` (default `{yoe:40, title:25, skills:25, salary:10}`).

Title and skills get a **single batched Gemini call** (`ai-engine.js#fitScoreBatch`, routed via `background.js#CALL_AI_FIT_SCORE`) when the rules-only score is weak. Results land in `JdObject.fitScores[clientId]`, so re-opening the popup is instant and zero-cost. With no Gemini key configured the matcher gracefully falls back to rules-only output (rows tagged `(rules-only)`).

### Why the matcher lives in the content script

`fit-matcher.js`, `jd-cache.js`, and `jd-extractor.js` are registered only as content scripts (manifest § `content_scripts`), so the popup cannot call them directly. The content-script handler owns L1 cache and AI-call coordination in one place; the popup is a pure renderer that consumes a serialized `FitResult` over the message boundary. This also keeps the popup unaware of platform adapters, which keeps the surface decoupled.

### File map

```
jd-cache.js            L1+L2 cache for JdObjects, putFitScores() writes through to L2
jd-extractor.js        Adapter walker, document_idle hook, SPA-navigation watcher
fit-matcher.js         scoreHard / scoreYoE / scoreSalary / scoreTitleRules /
                       scoreSkillsRules / score / scoreWithAi / DEFAULT_WEIGHTS
platforms/greenhouse-jd.js  Greenhouse JD extractor (covers iframe-embedded boards)
platforms/workday-jd.js     Workday JD extractor with cross-page jobKey
ai-engine.js           QuickApplyAI.fitScoreBatch — single call, batched title+skills
background.js          CALL_AI_FIT_SCORE handler, envelope { ok, result | error }
popup/popup.js         renderFitCard() — sends GET_FIT_SCORE, renders FitResult
popup/popup.html       <section id="fit-card"> slot inside state-default
popup/popup.css        .fit-card / .fit-row in the existing Ink & Paper palette
dashboard/dashboard.html  Job Analyzer settings tab
storage.js             showFitVerdict, showFitBreakdown, fitWeights in DEFAULT_SETTINGS
test/test-job-analyzer.html  JdCache + FitMatcher self-tests (hard + soft + AI verdict)
```

---

## 9. Changelog

### v3.2.0 — 2026-05-06

**Job Analyzer + multi-platform JD coverage.**

Adds the Fit Card feature (per-JD scoring against client preferences) and broadens JD-extraction coverage to four ATSes beyond Greenhouse + Workday. See § 8.5 Job Analyzer for the architecture and DATA_SCHEMA § 1.8 for the JdObject schema.

*New JD adapters*
- `platforms/ashby-jd.js` — `jobs.ashbyhq.com`. H1 + `.ashby-job-posting-right-pane`, og:description fallback, UUID-based jobKey.
- `platforms/rippling-jd.js` — `ats.rippling.com`. og:title parsed as `Title | Company` (whitespace-bounded splitter so `(Full-Time)` survives), `.ATS_htmlPreview` body.
- `platforms/workable-jd.js` — `apply.workable.com`. Structured `[data-ui="..."]` hooks for title/location/type, joined description+requirements+benefits.
- `platforms/smartrecruiters-jd.js` — `jobs.smartrecruiters.com`. Microdata via `[itemprop="title|description|employmentType|address"]`.
- `platforms/_jd-helpers.js` — shared parsers (`parseLocationFlags`, `parseYoE`, `parseSalary` with $10K minimum threshold, `parseVisaText`, `parseEmploymentType`, `bodyTextNearH1`, `firstTextOf`).

*Job Analyzer feature (Tasks 1–11)*
- New `jd-cache.js` (L1 in-memory + L2 `chrome.storage.local`, FNV-1a fingerprints, 7-day TTL, 100-entry LRU).
- New `jd-extractor.js` orchestrator + content.js hook that runs each adapter on `document_idle` and on title-mutation.
- New `fit-matcher.js` with hard params (visa, location, work mode, employment) and soft params (YoE, salary, title, skills) plus weighted overall score and verdict.
- AI fallback in `ai-engine.js#fitScoreBatch` for fuzzy title/skills with a YoE-estimate path when the JD is silent on required years.
- Popup Fit Card slot (`popup/popup.html`, `popup/popup.css`, `popup/popup.js`) — verdict + per-parameter rows above the Fill button.
- Dashboard "Job Analyzer" settings tab — display toggles + soft-param weights with sum-to-100 validation.

*Workday Self-Identify Date* (`platforms/workday.js`)
- New `_isTodayDateLabel()` predicate: matches `Date*`, `Today's Date`, `Signature Date`, `Date Signed`, `Date of Signature`. Negative-context guard rejects `Birth/Graduation/Start/Hire/End/Expir/Issue/Valid/Anniversary` so DOB-style date triplets keep their AI value.
- `fillWorkdayDate` overrides AI-resolved value with today's `MM/DD/YYYY` when the label matches.
- `postFill` no longer skips today-date triplets when the AI returned no answer — fills today regardless.

*Greenhouse extractor robustness*
- `_bodyText()` walks up from `<h1>` and falls back to `<main>`/`<article>` so wrapper sites without Greenhouse-direct selectors (playlist.com, hourglasscosmetics.com) still produce a body.
- `_jobKey()` prefers the `gh_jid` / `token` query param so wrapper page + iframe + direct GH page all converge on one cache entry.
- New `GENERIC_H1_RX` guard skips parent extraction on wrapper sites whose H1 is a generic careers-landing header (Careers/Jobs/Open Roles/etc.) — defers to the iframe so the cache isn't clobbered with thin parent data.
- All adapters now expose `jobKey()` so the GET_FIT_SCORE cache-fallback probe can resolve cache without a full extraction.

*Multi-frame race fixes*
- `jd-extractor` only writes to cache when the new extraction is actually richer than what's cached (more body, OR title-it-didn't-have, OR equal-or-more body with matching titles). Apply-page-vs-JD-page case still preserved.
- `content.js` GET_FIT_SCORE handler now stays silent when its frame has no JD data, so sibling frames with data win the `chrome.tabs.sendMessage` response slot rather than getting drowned by a wrapper parent's null.
- Title `MutationObserver` calls `extract()` directly instead of `maybeExtract()` so the URL-dedup doesn't defeat re-extraction when the iframe's H1 renders late.

*Profile additions* (DATA_SCHEMA § 1.1)
- `preferredLocations: string[]` and `targetRoles: string[]` — comma-separated textareas in the dashboard's Work Preferences section, used by the Fit Card matcher.

*Test runner* (new files)
- `test-runner/run-job-analyzer-tests.js` — loads the unpacked extension, restores backup, walks 9 scenarios (Greenhouse direct + embedded, Workday, Ashby, Rippling, Workable, SmartRecruiters, Hourglass, Kapitus). Reports frame inspection, Fit Card snapshot, fill summary.
- `test-runner/fill-workday-trimble-flow.js` — end-to-end Workday application flow with step-by-step fill + Self-Identify Date assertion.
- `test/test-job-analyzer.html` — unit tests for JdCache + FitMatcher hard/soft params.

### v3.1.0 — 2026-04-24

**Workday filler overhaul (Robert Half, Veritiv, Adobe tenants verified end-to-end):**

The stock filler only handled standard `<input>`/`<select>`/`<textarea>` on Workday and silently failed on everything else. `platforms/workday.js` now covers the three custom widget families that every modern Workday form uses.

*Discovery (`discoverWorkdayControls`)*
- **Button-as-dropdown** (State, Degree, Phone Type, Compensation, all EEO answers): synthesises a `type:'combobox'`, `_workdayKind:'buttonDropdown'` rule per `button[aria-haspopup="listbox"]` inside a `[data-automation-id^="formField-"]` container.
- **Date triplet** (`dateInputWrapper` with three `role="spinbutton"`): synthesises a `type:'date'`, `_workdayKind:'dateTriplet'` rule, captures the month/day/year refs plus container ID so the spinbuttons can be re-resolved after virtualised re-render.
- **Hierarchical multiselect** (How Did You Hear About Us, Country Phone Code, Skills, Field of Study): synthesises a `type:'combobox'`, `_workdayKind:'multiSelect'` rule. The search input is matched via `input:not([type="hidden"])` — Workday's input has no explicit type attribute and `input[type="text"]` misses it.
- Shadow-DOM-aware via `_queryAllDeep()` — walks shadow roots recursively on tenants that wrap the form in one.
- Selectors run through `CSS.escape()` to tolerate colons/dots in automation-ids.

*Filling (`postFill` routes by `_workdayKind`)*
- `fillWorkdayButtonDropdown`: Calls `_dismissAllPickers()` first to clear stale listboxes, tracks which listboxes existed before the open click so it only matches the NEW one, dispatches a full pointer/mouse sequence via `_workdayRealClick()` (Workday's `promptLeafNode` listens for `mousedown`, not `click`), then clicks the inner `promptLeafNode`/`promptOption` — the wrapper `role="option"` node doesn't fire the selection handler.
- `fillWorkdayMultiSelect`: Opens via the `multiselectInputContainer` wrapper, never the inner `<input>` (clicking the input doesn't open the picker). Picks a leaf directly when present; otherwise scores root categories by token overlap with the target plus a `WORKDAY_SOURCE_HINTS` map (e.g. `linkedin → [website, job board, social media]`) so it drills into the right branch on tenants whose taxonomy differs (Adobe has LinkedIn under "Job Board"; Veritiv has Facebook under "Social Media"). Only drills into sub-options that are themselves categories (`data-uxi-multiselectlistitem-type="1"` or have a caret-right icon) — otherwise the fallback would wrongly SELECT random leaves. Dismisses the picker between value iterations so the next open click reliably toggles ON (not OFF).
- `fillWorkdayDate`: Scrolls the wrapper into view, clears existing values with Backspace, waits 180 ms for Workday's spinbutton debounce to settle, then fires per-digit keydown+keypress+input+keyup. Falls back to a native-value-setter + `aria-valuenow` mutation when synthetic keys don't commit.
- Repeatable sections (Work Experience, Education, Languages, Websites) are auto-expanded in `preFill` via `expandRepeatingSections` — skip heuristic keys on a Delete button or `<h5>` header (NOT any inner `id*="--"` — Workday IDs commonly contain `--` and would false-positive the skip).

*Field-mapper aliases*
- Added Workday-specific stems in `WorkdayFiller.getFieldAliases()`: `legalname--firstname/lastname`, `emailaddress`, `phonenumber`, `addressline1`, `postalcode`, `countryregion` (→ state), `jobtitle`, `companyname`, `schoolname`, `fieldofstudy`, `gradeaverage`, `linkedinaccount`.
- Full-phrase aliases for opaque hex-ID custom questions on step 3 (e.g. `formField-848aff10073b1001…`) so `matchByContextLabel` catches "legally authorized to work", "require sponsorship or other support", "desired compensation", "anticipated eligibility time for employment".

*Wiring*
- `content.js` now stashes `filler._lastAnswers` and `_lastRules` on the filler before calling `postFill()` in the batch path. `fill-engine.fillAll` skips any rule with `_workdayKind` set (counts it as filled when an answer exists) so the generic combobox/date path doesn't clobber the widget before postFill can fill it correctly.
- `discoverFields()` dedup now prefers the rule that has `_workdayKind` on collision — otherwise a stray base-discoverer rule would drop the flag and fall back to the generic (no-op) path.
- `getNextSelectors()` now also matches `pageFooterSubmitButton`, `submitApplication`, and `saveForLaterButton` so the Review-page advance works.

*Known limitation (documented in-file)*
- On tenants that strictly enforce `event.isTrusted` for spinbutton commits, the synthetic-key path + native-value fallback may still fail. Bulletproof fix would require the `chrome.debugger` permission and CDP `Input.dispatchKeyEvent` — deferred. Current fallback never reports false success: if commit fails, Workday's own "field required" error surfaces on Next.

### v3.0.7 — 2026-04-20

**Critical Fix — Gemini T3 batch was silently disabled on all forms:**
- `ai-engine.js` was only loaded by the background service worker (`importScripts()`), not injected as a content script. `window.QuickApplyAI` was always `undefined` in content script context, so `_aiInstance` was always `null` and the Tier 3 Gemini batch call never ran. All custom/essay questions fell through to `skipped`. Fixed by adding `ai-engine.js` to the `content_scripts` js array in `manifest.json`, between `fill-engine.js` and `ai-resolver.js`.

**Greenhouse Fixes:**
- `_ghGetComboLabel`: Compound `aria-labelledby` values (space-separated IDs, e.g. `"field-label required-label"`) now split and resolved individually — `document.getElementById()` previously failed silently on compound strings.
- `_ghFillCombo`: Each combobox call now generates a unique fingerprint (`_gh_pf_<id|name|random>`). Previously all postFill combobox calls shared `_gh_postfill`, causing the fill-engine's dedup guard to skip subsequent comboboxes in the same pass.
- Country normalization: Profile `country` values like `"US"`, `"USA"`, `"uk"` are now normalized to full names (`"United States"`, `"United Kingdom"`) before passing to `_ghFillCombo`. React-Select option matching requires the full name.
- `CONFLICT_PAT` narrowed: Removed over-broad `anyone.*employ` and `know.*anyone.*at` patterns which matched unrelated questions. Replaced with precise relative/family-at-company patterns.

**Breezy Fixes (7 bugs):**
- Honeypot field (`hp_7f2b` / `autocomplete=hp-4f3c9a`) now filtered in `discoverFields` — filling it silently flags the application as a bot.
- `race_ethnicity` added to ethnicity aliases (some employers use this flat name instead of `eeoc.race`).
- Custom radio label fix no longer gated on `OPTION_LIKE_RX` — the regex missed values like `"Indeed"` on source-discovery radio groups; now always attempts recovery for all `section_\d+_question_\d+` radio groups.
- Custom checkboxes with empty labels now also get label recovery via `_findAngularQuestionLabel`.
- `smsConsent` checkbox now auto-checked by `name` fallback — label is always empty so text-only `CONSENT_RX` never fired.
- Unnamed pay-period select (`[Hourly|Weekly|Monthly|Yearly]`) now set to `Yearly` in `postFill` via option-text scan.
- `salaryCurrency` select now defaulted to `"US Dollar ($)"` in `postFill` when not already filled by T1.

**Ashby Fixes:**
- `_ashbyRetryUnfilledRequired`: The retry pass now initializes and passes a live `_retryAI` instance (from `window.QuickApplyAI`) to `resolveBatch`. Previously it always passed `null`, so Gemini was never called during retry even after the manifest fix.
- EEO combobox opener: Now tries `window.QuickApplyFillEngine.fillCombobox()` first (React-compatible, uses `setNativeValue` + `InputEvent`). Falls back to the previous `MouseEvent('mousedown')` approach only if `fillCombobox` is unavailable or fails. `MouseEvent` does not trigger React's synthetic event system reliably.

**AI Engine:**
- Token-overlap label matching: Added a 70% token-overlap fallback in `callGeminiBatch` response parser. When Gemini paraphrases a field label in its response, exact-match and normalized-exact-match both fail. The overlap fallback now correctly maps the AI answer back to the original field rule.

### v3.0.6 — 2026-04-17

- Batch Gemini T3 resolution via single `callGeminiBatch` call for all unknown fields
- `ai-resolver.js` 3-tier pipeline (T1 profile / T2 fingerprint cache / T3 Gemini batch)
- Greenhouse postFill: Yes/No combobox pass for EEO, legal auth, sponsorship questions
- Ashby postFill: `_ashbyRetryUnfilledRequired` retry pass for unfilled required fields
- Rippling and Breezy platform fillers added
