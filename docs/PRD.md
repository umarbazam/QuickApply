# QuickApply — Product Requirements Document (PRD)

**Version:** 3.2.0
**Date:** 2026-05-06
**Product:** QuickApply Chrome Extension
**Platform:** Chrome (Manifest V3)

---

## 1. Product Vision

A Chrome extension that enables job application agents to manage multiple client profiles and auto-fill job application forms with one click. The agent loads each client's personal details and CV once, then selects a client when on any job portal — the form auto-fills, CV uploads, and the agent reviews before manually submitting.

### 1.1 Problem Statement

Job application agents apply to dozens of jobs daily on behalf of 10+ clients. Each application requires manually typing the same 20+ fields (name, email, phone, ethnicity, education, etc.) and uploading the client's CV. This is:
- **Slow** — 5-10 minutes per form × 50+ applications/day = 4-8 hours of typing
- **Error-prone** — Wrong email, wrong phone number, wrong client's CV attached
- **Tedious** — Copy-pasting between spreadsheets and browser forms

### 1.2 Solution

QuickApply eliminates repetitive data entry:
1. Store client profiles with all application fields + CV
2. One-click auto-fill on any job portal
3. Visual review system before manual submit
4. **Self-Improving Intelligent Engine**: Learns from manual corrections and automatically maps new custom fields.
5. **Universal Field Registry**: Versioned cross-client database for shared field discovery and high-precision mapping.
6. **Platform Seeds**: Pre-loaded field mappings for major ATSs so the first fill is never cold-start.
7. **AI CV Enrichment**: One-click "Re-parse CV with AI" extracts missing profile fields that regex missed.
8. **Proactive Essay Caching**: AI auto-answers custom text questions and caches answers for free reuse.
9. **EEO Safety Net**: Low-confidence EEO fields auto-snap to "Prefer not to say" to avoid wrong answers.
10. **Batch AI Resolution (v3.0)**: All form fields are answered in a single Gemini call — same precision approach as leading competitors, achieved client-side.
11. **Fingerprint Cache (v3.0)**: FNV-1a fingerprinted answers cached per-client for 90 days — identical questions across job postings fill instantly from cache.
12. **Platform Filler Classes (v3.0)**: Dedicated filler per ATS (Workday, Greenhouse, iCIMS, SmartRecruiters, Lever, Ashby, Workable, Generic) — platform-specific pre/post hooks.
13. **Auto-Submit Engine (v3.0)**: Optional hands-free mode auto-advances multi-step forms and submits the final page.
14. Works across Workday (Shadow DOM), Greenhouse, Lever, SmartRecruiters (iframes), Ashby, iCIMS, Workable, LinkedIn, Indeed, and any generic form

### 1.3 Target User

**Primary:** Job application agents/virtual assistants who apply on behalf of multiple clients
**Secondary:** Individual job seekers managing their own profile across portals

---

## 2. User Personas

### Persona 1: "The Agent" (Primary)
- **Name:** Rashid — Freelance VA
- **Context:** Applies to 30-60 jobs/day for 8-12 clients
- **Pain:** Switching between client spreadsheets, copy-pasting, accidentally using wrong client's data
- **Goal:** Fill any form in <10 seconds with zero errors
- **Tech Level:** Moderate — comfortable with browser extensions

### Persona 2: "The Job Seeker" (Secondary)
- **Name:** Sara — Software Engineer
- **Context:** Applying to 5-10 jobs/day for herself
- **Pain:** Re-typing the same info on every portal
- **Goal:** One-click fill for her own profile
- **Tech Level:** High

---

## 3. User Stories & Acceptance Criteria

### Epic 1: Client Profile Management

#### US-1.1: Add a New Client
**As** an agent, **I want to** add a new client profile with all their details, **so that** I can auto-fill forms for them later.

**Acceptance Criteria:**
- [ ] Dashboard page has an "Add Client" button
- [ ] Form includes all fields from the data schema (see Data Schema doc)
- [ ] All text fields accept Unicode characters (international names)
- [ ] Phone field accepts international formats with country codes
- [ ] CV upload accepts PDF and DOCX (max 5MB per file)
- [ ] Uploaded CV is stored in `chrome.storage.local` as base64
- [ ] After save, client appears in the client list immediately
- [ ] Validation: email format, phone format, required fields (firstName, lastName, email)

#### US-1.2: Edit a Client
**As** an agent, **I want to** edit an existing client's details, **so that** I can keep their profile up to date.

**Acceptance Criteria:**
- [ ] Each client card has an "Edit" button
- [ ] Edit form pre-fills with current data
- [ ] User can replace the CV with a new file
- [ ] Changes persist after save
- [ ] Editing does not affect other clients

#### US-1.3: Delete a Client
**As** an agent, **I want to** delete a client profile, **so that** I can remove clients I no longer work with.

**Acceptance Criteria:**
- [ ] Each client card has a "Delete" button
- [ ] Confirmation dialog: "Delete [Name]? This cannot be undone."
- [ ] Deleting removes all data including stored CV
- [ ] Client disappears from all lists immediately

#### US-1.4: Import/Export Profiles
**As** an agent, **I want to** export all profiles to JSON and import them back, **so that** I can backup data or transfer to another machine.

**Acceptance Criteria:**
- [ ] "Export All" button downloads a `.json` file containing all profiles (including base64 CVs)
- [ ] "Import" button accepts a `.json` file and merges/replaces profiles
- [ ] Import shows a preview of what will be imported before confirming
- [ ] Duplicate detection by email — prompts to overwrite or skip

---

### Epic 2: Auto-Fill

#### US-2.1: Select Client and Fill Form
**As** an agent, **I want to** click the extension icon, select a client, and have the form auto-filled, **so that** I save time on every application.

**Acceptance Criteria:**
- [ ] Popup shows list of all saved clients with avatar (initials) + full name
- [ ] Search/filter box filters clients by name in real-time
- [ ] Clicking "Apply as [Name]" sends profile data to the content script
- [ ] Content script identifies form fields using the 14-strategy detection engine
- [ ] All matching fields are filled with correct values from the selected profile
- [ ] Non-matching fields are left untouched
- [ ] Works on pages with dynamically loaded forms (SPA)

#### US-2.2: CV Auto-Upload
**As** an agent, **I want to** have the client's CV automatically uploaded to the file input, **so that** I don't have to manually browse and select the file.

**Acceptance Criteria:**
- [ ] Content script finds `<input type="file">` elements on the page
- [ ] If multiple file inputs exist, identifies the one for "resume/CV" by label/nearby text
- [ ] Converts stored base64 to a File object with original filename and MIME type
- [ ] Sets the file via `DataTransfer` API
- [ ] Dispatches `change` and `input` events for framework compatibility
- [ ] Works with drag-and-drop upload zones

#### US-2.3: Dropdown & Radio Auto-Fill
**As** an agent, **I want to** have dropdowns and radio buttons filled automatically, **so that** I don't have to manually select options.

**Acceptance Criteria:**
- [ ] `<select>` dropdowns: fuzzy-match option text against profile value
- [ ] Radio buttons: fuzzy-match label text, click the matching option
- [ ] Checkboxes: match by label, set checked state
- [ ] Custom dropdowns (Material UI, etc.): click trigger → wait for options → click match
- [ ] Fuzzy matches are flagged as yellow (low confidence) in the fill report
- [ ] Negation-aware matching for EEO fields (veteran, disability) — "I am not a veteran" selects the correct option even when the form says "I am not a protected veteran" or simply "No"
- [ ] Semantic inversion for work authorization: "Are you authorized to work?" → Yes. "Do you require sponsorship?" → No (when profile says authorized)

---

### Epic 3: Review & Verification

#### US-3.1: Visual Field Highlighting
**As** an agent, **I want to** see which fields were filled on the page, **so that** I can quickly verify correctness.

**Acceptance Criteria:**
- [ ] Green border on successfully filled fields
- [ ] Yellow border on fuzzy-matched fields (low confidence)
- [ ] Red border on unfillable fields (required but no data)
- [ ] Highlights auto-dismiss after 10 seconds
- [ ] "Clear Highlights" button removes them immediately

#### US-3.2: Review Panel
**As** an agent, **I want to** see a summary of all filled values in the popup, **so that** I can review before submitting.

**Acceptance Criteria:**
- [ ] Popup switches to Review Mode after fill completes
- [ ] Table shows: Field Name | Value Filled | Status (✅/⚠️/❌)
- [ ] "Edit on Page" scrolls to and focuses the first flagged field
- [ ] "Re-fill" allows switching to a different client
- [ ] "Clear All" resets all filled values on the page

#### US-2.4: Intelligence & Learning
**As** an agent, **I want** the extension to learn from my manual corrections, **so that** it gets smarter over time and across different forms.

**Acceptance Criteria:**
- [ ] **Correction Memory**: Manually editing a filled field saves the mapping to a local corrections database.
- [ ] **Custom Field Discovery**: If an unknown field is filled by the user, the system "fetches" the nearby question text and learns it as a new Custom Field for that client.
- [ ] **Smart Label Fetching**: Uses sibling/ancestor scanning to find question text in complex DOM structures where standard labels are missing.
- [ ] **Fuzzy Custom Recognition**: Recognizes variations in question phrasing (e.g., "What is your salary?" vs "Expected Salary").
- [ ] **Cross-Form Syncing**: Learned custom fields for Client A are automatically recognized on other forms for Client A.
- [ ] **Universal Registry**: High-confidence patterns are fed into a versioned Universal Field Registry to benefit all clients.
- [ ] **"Don't Overwrite" Policy**: Never overwrites fields that were already filled by the user or pre-filled by the form, unless a specific manual correction is being applied.
- [ ] **Best-Match Strategy**: Prioritizes exact matches and corrections to prevent collisions (e.g., ensuring "Company Name" doesn't match "Full Name").
- [ ] **Priority 1b Correction**: After field identification, corrections are re-checked by `profileField` + domain — corrections survive HTML attribute/ID changes between visits
- [ ] **Fast Learning**: Platform knowledge activates after 2 successful fills (confidence 0.6 threshold). Universal registry activates after 2 fills.
- [ ] **Shadow DOM Support**: All label lookups and field queries use `element.getRootNode()` — works in Workday shadow DOM
- [ ] **Iframe Support**: `discoverFields()` scans iframe `contentDocument` for SmartRecruiters

---

## 4. Feature Priority Matrix

| ID | Feature | Priority | Effort | Dependency |
|---|---|---|---|---|
| F1 | Client CRUD (Dashboard) | P0 | M | None |
| F2 | CV Upload & Storage | P0 | M | F1 |
| F3 | Popup Client Selector | P0 | S | F1 |
| F4 | Core Auto-Fill Engine | P0 | L | F1, F3 |
| F5 | Field Mapping Dictionary | P0 | M | F4 |
| F6 | CV Auto-Upload | P0 | M | F2, F4 |
| F7 | Visual Highlights | P1 | S | F4 |
| F8 | Review Panel | P1 | M | F4 |
| F9 | Platform-Specific Adapters | P1 | L | F4 |
| F10 | Shadow DOM Traversal | P1 | S | F4 |
| F11 | Iframe Support | P1 | S | F4 |
| F12 | Import/Export Profiles | P2 | S | F1 |
| F13 | Custom Dropdown Handling | P2 | M | F4 |
| F14 | MutationObserver (SPA) | P1 | M | F4 |
| F15 | Workday Shadow DOM Adapter | P1 | S | F4 |
| F16 | SmartRecruiters Iframe Adapter | P1 | S | F4 |
| F17 | Lever/Greenhouse Platform Support | P1 | S | F4 |
| F18 | Negation-aware EEO Matching | P1 | M | F5 |
| F19 | Work Auth Semantic Inversion | P1 | S | F5 |
| F20 | Self-Learning Field Registry | P1 | L | F4 |
| F21 | Batch AI Resolution | P0 | L | F4, F22 |
| F22 | Fingerprint Cache | P0 | M | None |
| F23 | Platform Filler Classes | P0 | L | F4 |
| F24 | Auto-Submit Engine | P1 | L | F4, F23 |
| F25 | Progress Overlay | P1 | S | F4 |

**Legend:** P0 = Must-have, P1 = Should-have, P2 = Nice-to-have | S = Small, M = Medium, L = Large

---

## 5. User Flows

### Flow 1: First-Time Setup
```
Install Extension → Dashboard opens automatically → Add first client →
Fill all fields → Upload CV → Save → See client in list → Add more clients
```

### Flow 2: Applying for a Job
```
Open job portal → Navigate to application form → Click extension icon →
See client list → Search/Select client → Click "Apply as [Name]" →
Form auto-fills + CV uploads → See green/yellow/red highlights on page →
Review Panel shows in popup → Verify all fields → Manually click Submit
```

### Flow 3: Handling Errors
```
Auto-fill runs → Some fields not found (red) → Some fuzzy-matched (yellow) →
Click "Edit on Page" → Scrolls to first issue → Manually fix → Submit
```

### Flow 4: Switching Clients on Same Form
```
Applied as Client A → Realize wrong client → Click extension → Click "Re-fill" →
Select Client B → Form clears and re-fills with Client B's data → Review → Submit
```

### Flow 5: Hands-Free Auto-Submit (v3.0)
```
Enable "Auto-advance" + "Auto-submit" toggles in popup settings →
Open job application → Click "Fill & Submit" →
Engine fills step 1 → clicks Next → fills step 2 → ... → submits →
Dashboard shows FILL_PROGRESS chips in real-time →
Toast notification: "Application submitted"
```

---

## 6. Non-Functional Requirements

| Requirement | Target |
|---|---|
| **Performance** | Auto-fill completes in < 2 seconds on any page |
| **Storage** | Support 50+ clients with CVs (use `unlimitedStorage`) |
| **Compatibility** | Chrome 110+ (Manifest V3). Tested on Workday, Greenhouse, Lever, SmartRecruiters, LinkedIn, Indeed |
| **Privacy** | All data stored locally in `chrome.storage.local`. Zero network requests. No analytics. No telemetry. |
| **Security** | No data sent to any server. CVs stored as base64 locally. No `eval()` or inline scripts. |
| **Accessibility** | Dashboard UI keyboard-navigable. ARIA labels on all interactive elements. |
| **Reliability** | Graceful degradation: if a field can't be filled, skip it silently and report in review |
| **Size** | Extension package < 500KB (excluding stored user data) |

---

## 7. Success Metrics

| Metric | Target |
|---|---|
| Fields filled per application | > 95% average (v3.0 target, up from 80%) |
| Time to fill one form (cache hit) | < 3 seconds |
| Time to fill one form (Gemini batch) | < 10 seconds |
| CV upload success rate | > 95% on standard file inputs |
| Repeat-visit fill time | < 1 second (fingerprint cache) |
| Zero incorrect submissions | Fill report flags all fuzzy matches |

---

## 8. Out of Scope (V1–V2)

- ~~Auto-submit~~ — **added in v3.0 as opt-in** (off by default; requires explicit enable)
- Cloud sync / server-side storage
- AI-powered resume customization per job
- Cover letter generation
- Job tracking / application history
- Multi-browser support (Firefox, Edge)

---

## 9. Release Plan

### V1.0 (MVP)
~~All P0 features + Visual Highlights + Review Panel~~ — **SHIPPED**

### V1.1
~~Platform-specific adapters for top 5 portals + Import/Export~~ — **SHIPPED** (Workday, Greenhouse, Lever, SmartRecruiters)

### V2.0 (Current)
Self-learning field registry, negation-aware EEO matching, semantic inversion for work authorization, AI-powered open-ended question answering using CV context, active client UX (popup remembers last-used client, one-click re-fill)

### V2.5 (Current)
Platform support for Ashby, iCIMS, and Workable. Autonomous AI fill overhaul: platform memory loader (directHit fast-path), binary dropdown threshold (0.50), referral field skip, BLOCKED_HOSTS CAPTCHA guard, per-session profileField dedup (prevents 3–6× fills), MutationObserver guard extended to 30s + capped at 3 refills. Correction quality: select stores display text not internal ID, checkbox stores Yes/No not "on", CAPTCHA/security fields never stored. Learning engine: correction→platform direct update, confidence floor for established fields, label deduplication, token overlap matching. Fill log (last 100 sessions) stored for debugging.

### V2.9 (Current stable — v1.9.x)
- **network-spy.js**: MAIN world XHR/fetch interceptor captures all ATS API calls into `window.__qaNetBuf` shared buffer (synchronous, survives `beforeunload`)
- **Platform Seeds**: `platform-seeds.json` pre-loads 100+ field mappings for Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, Workable — no cold-start
- **Dashboard Recordings Tab**: Session recordings with network requests, fill results, field maps
- **Self-Learning overhaul (L7/L8)**: Corrections survive opaque per-job IDs; fills self-register into Universal Registry
- **Combobox toggle fix**: Greenhouse EEO React-Select "Toggle flyout" button detection
- **EEO pre-fill**: Low-confidence EEO fields snap to "Prefer not to say"

### V3.2.0 (2026-05-06) — Job Analyzer + multi-platform JD coverage

**New feature: Job Analyzer / Fit Card.** Every JD page silently extracts a `JdObject` into the new `quickapply_jd_cache` (FNV-1a fingerprint, 7-day TTL, 100-entry LRU). When the popup opens, the matcher scores the JD against the selected client across:

- **Hard parameters** (pass / fail / manual): visa sponsorship, location, work mode, employment type. A single hard fail short-circuits the verdict to *not_a_fit*. Visa is the only hard param with a `manual` state, fired when the client requires sponsorship and the JD is silent on it; location matches that pattern when the JD has no location data and no remote/hybrid/onsite flag.
- **Soft parameters** (0–100 scored, weighted): years-of-experience (default 40%), title (25%), skills (25%), salary (10%). Title and skills run a rules-only pass first (substring + stripped fuzzy / word-boundary skill matching); when rules are weak, a single batched Gemini call resolves both via `ai-engine.js#fitScoreBatch`. The same call also estimates required YoE when the JD doesn't state it. Results cache per `(jobKey, clientId)` inside `JdObject.fitScores` so popup re-opens are instant.
- **Verdict bands**: `strong ≥ 80%`, `good ≥ 60%`, `weak ≥ 40%`, `poor`, `not_a_fit`.

Configurable in the dashboard's new **Job Analyzer** settings tab — display toggles for verdict and breakdown, plus advanced soft-param weights with sum-to-100 validation. With no Gemini key configured, the matcher falls back to rules-only output and tags rows `(rules-only)`; no errors thrown.

**JD platform coverage.** Six host families now extract `JdObject`s:

- `platforms/greenhouse-jd.js` — direct (`job-boards.greenhouse.io`) + embedded (`#grnhse_iframe` on wrapper sites). Cross-frame `gh_jid` jobKey unifies parent + iframe + direct extractions in one cache entry.
- `platforms/workday-jd.js` — `*.myworkdayjobs.com`. Stable cross-page `jobKey` of the form `workday:{tenant}:{jobId}` so the JD page populates the cache and the apply page reads from it.
- `platforms/ashby-jd.js`, `platforms/rippling-jd.js`, `platforms/workable-jd.js`, `platforms/smartrecruiters-jd.js` — new adapters built on shared `_jd-helpers.js` parsers.

**Workday Self-Identify Date* fix.** `_isTodayDateLabel()` pattern-matches `Date*` / `Today's Date` / `Signature Date` / `Date Signed` / `Date of Signature` (with negative-context guard rejecting Birth/Graduation/Start/Hire/End/Expir/Valid/Anniversary). `fillWorkdayDate` overrides whatever the AI returned with today's `MM/DD/YYYY` when the label matches, and `postFill` no longer skips today-date triplets when the AI gave no answer.

**Profile additions.** Two array fields in DATA_SCHEMA: `preferredLocations: string[]` and `targetRoles: string[]`. Comma-separated textareas in the dashboard's Work Preferences section.

**Verified end-to-end** via `test-runner/run-job-analyzer-tests.js` across all 9 scenarios: Greenhouse direct (Eclipse, Kapitus), Greenhouse embedded (Playlist, Hourglass), Workday Trimble, Ashby FirstMate, Rippling CallRevu, Workable McLane Global, SmartRecruiters NBCUniversal.

### V3.1.0 (2026-04-24) — Workday filler overhaul

**Across Robert Half (`roberthalf.wd1`), Veritiv (`veritiv.wd5`), and Adobe (`adobe.wd5`)** — three Workday widget families that previously fell through the base discoverer are now discovered and filled by `platforms/workday.js`.

- **Button-as-dropdown** (State, Degree, Phone Type, Compensation, EEO selects): `discoverWorkdayControls` synthesises a FieldRule per `button[aria-haspopup="listbox"]`; `fillWorkdayButtonDropdown` opens via a full pointer/mouse sequence (`_workdayRealClick`), clicks the inner `promptLeafNode` — the `role="option"` wrapper doesn't fire Workday's handler.
- **Spinbutton dates** (`dateInputWrapper` with three `role="spinbutton"` children): `fillWorkdayDate` clears existing values with synthetic Backspace, waits 180 ms for Workday's debounce, fires per-digit keydown+keypress+input+keyup, and falls back to the native value setter + `aria-valuenow` mutation when synthetic keys don't commit. Both MM/DD/YYYY and MM/YYYY formats.
- **Hierarchical multiselects** (How Did You Hear, Country Phone Code, Skills, Field of Study): opens via `[data-automation-id="multiselectInputContainer"]` wrapper (not the inner `<input>`, which ignores the click), picks a direct leaf match when present, otherwise scores root categories by token overlap plus `WORKDAY_SOURCE_HINTS` (e.g. `linkedin → [website, job board, social media, social]`) and drills into the best branch. Only drills into sub-options that are themselves categories to avoid wrongly selecting leaves.
- **Repeatable sections** (Work Experience, Education, Languages, Websites): `expandRepeatingSections` auto-clicks every `[data-automation-id="add-button"]` in `preFill`. Skip heuristic keys on an entry's Delete button or `<h5>` header — not on any `id*="--"` child (Workday IDs commonly use `--`).
- **Opaque hex-ID custom questions** (step 3 on most tenants, e.g. `formField-848aff10073b1001…`): full-phrase aliases in `WorkdayFiller.getFieldAliases()` — "legally authorized to work", "require sponsorship or other support", "desired compensation", "anticipated eligibility time for employment" — match via `matchByContextLabel` on the legend text.
- **Shadow-DOM-aware** discovery via `_queryAllDeep` for tenants that wrap the form in a shadow root.

Wiring: `content.js` stashes `filler._lastAnswers`/`_lastRules` before calling `postFill()`; `fill-engine.fillAll` skips rules tagged with `_workdayKind` (counts filled if an answer exists) so the generic path doesn't clobber Workday widgets; `discoverFields` dedup prefers the rule with `_workdayKind` on selector collision; `getNextSelectors` now matches `pageFooterSubmitButton`, `submitApplication`, `saveForLaterButton`.

Known limitation: Workday tenants that strictly enforce `event.isTrusted` for spinbutton commits may still fail dates — current synthetic+native fallback is best-effort; a fully reliable fix would require the `chrome.debugger` permission and CDP `Input.dispatchKeyEvent`.

### V3.0.4 (2026-04-03)
- **Fix**: `workAuthorization` VALUES_MAP — added 'requires sponsorship', 'renewal/sponsorship', 'authorized for any employer' synonyms so Mixpanel/Greenhouse dropdown options match correctly
- **Fix**: `heardAboutUs` VALUES_MAP — LinkedIn now matches "Found on Job Board (e.g. LinkedIn...)" and recruiter/event variants; broader platform-name synonyms
- **Fix**: `state` VALUES_MAP added — full US state names (e.g. "Texas") now map to 2-letter abbreviations (e.g. "TX") for Greenhouse/Shopmonkey state dropdowns
- **Fix**: SPA recording save — intercept `history.pushState`/`replaceState`/`popstate` so Ashby and other React Router SPAs save the recording on submission (previously `beforeunload` never fired → recordings missing for 2 of 3 Ashby jobs)
- **Fix**: `workAuthorization` DOM context fallback — when `getElementContext` returns undefined, walk up 6 parent elements to find question label so the YES/NO semantic transform fires on Greenhouse radio/select fields

### V3.0.3 (2026-04-03)
- **Fix (critical)**: `workAuthorization` fills now correctly answer Yes/No questions on Greenhouse, Ashby, and all other platforms — the semantic transform (visa type → "Yes"/"No") was previously restricted to `<input type="text">` only, so radio buttons received "US Citizen" / "H1B Visa" etc. which never matched "Yes"/"No" options (43 Greenhouse errors per recording batch). Now applies to all field types when the question label contains authorization/sponsorship keywords.
- **Fix (critical)**: Radio-fill semantic inversion guarded — if the upstream transform already converted the value to "Yes"/"No", the radio code no longer double-inverts it back (prevented correct "No" for US Citizens on sponsorship questions from being flipped to "Yes").
- **Fix**: `_isBadCorrectionValue` now blocks boolean strings `"true"`/`"false"` — Workday was filling `workAuthorization` with literal `"false"` at conf=1.0 (10 times per form) because a boolean checkbox value was accidentally saved as a correction.
- **Fix**: `_isBadCorrectionValue` now blocks random alphanumeric tokens (mixed-case + digit, no spaces, 8–25 chars) — catches corrupted corrections like `"Nofyz4tKbT"` that were being applied to Greenhouse applications.

### V3.0.2 (2026-04-03)
- **Fix**: Ashby Yes/No button groups now detected — CSS selector was `[class*="yesNo"]` but Ashby CSS modules output lowercase `_yesno_*`, so work auth / sponsorship / eligibility buttons were never clicked
- **Fix**: Radio group question labels now extracted from `<fieldset>` context — previously `groupRadios` used the first option's label text as the group label, so questions like "Are you legally authorized?" were misidentified and skipped
- **Fix**: Ashby combined `Name*` field (`_systemfield_name`) now re-asserted after CV parse with `firstName + lastName`
- **Fix**: CV parse re-assertion timeout extended from 5 s → 10 s; added deferred second re-assertion at +3 s to catch late ATS overwrites of email/name/phone

### V3.0.1 (2026-04-03)
- **Fix**: Progress overlay (bottom-right fill summary) no longer auto-dismisses after 6 seconds — stays visible until user clicks Dismiss or ×

### V3.0 (superseded by v3.1.0 — see entry above)
**Goal: Match and exceed Jobright AI precision**

- **Batch AI Resolution**: All form fields answered in a single Gemini call (vs. N serial calls) — the #1 precision improvement
- **Fingerprint Cache**: FNV-1a field fingerprints cached per-client (90-day TTL, L1 memory + L2 chrome.storage) — cache hit = zero Gemini cost
- **Modular Architecture**: `content.js` reduced from ~3500 LOC to ~500 LOC by extracting `cache.js`, `field-discoverer.js`, `fill-engine.js`, `ai-resolver.js`, `submit-engine.js`, `platforms/`
- **Platform Filler Classes**: 8 dedicated fillers (BaseFiller + Generic, Workday, Greenhouse, iCIMS, SmartRecruiters, Lever, Ashby, Workable) — each with platform-specific `preFill`/`postFill`/`discoverFields`
- **Enhanced Event Dispatch**: Second `change`+`blur` cycle for Angular/Vue; `composed: isInShadow` for Workday; `scrollIntoView` before every fill; `focus` never dispatched (React 15 guard)
- **Auto-Submit Engine**: Optional hands-free multi-step form driver with validation error detection (off by default)
- **Progress Overlay**: Real-time fill progress shadow DOM island with per-field chip indicators

### V4.0 (Planned)
- Custom field mapping UI visible in dashboard
- Application history log with outcome tracking
- Bulk fill across multiple tabs
- Cross-client correction sharing (with privacy controls)
- SmartRecruiters, Beamery full platform recording + seed expansion
