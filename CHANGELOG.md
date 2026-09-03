# Changelog

All notable changes to QuickApply are documented here. Per-version detail and rationale lives in `docs/ARCHITECTURE.md` § 9 and `docs/PRD.md` § Release History.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows semantic versioning.

## [Unreleased]

### Added — Teamtailor

- **`platforms/teamtailor-jd.js`** — JD extractor for Teamtailor career sites (`{tenant}.teamtailor.com` **and** customer-owned domains such as `careers.oatly.com`, detected from the careersite markup markers). Reads the Schema.org `JobPosting` JSON-LD, double-decoding the description Teamtailor HTML-escapes inside the JSON string; falls back to the rendered `.prose` body. Folds the "Department / Role / Locations / Remote status" fact list into the remote/hybrid detection since that flag never appears in the JD body.
- **`platforms/teamtailor.js`** — Application-form filler. `preFill()` clicks "Apply for this job" and waits for the lazy `<turbo-frame id="application_form">` to load the form (nothing is fillable before that). Aliases the Rails-nested field names (`candidate[first_name]`, `candidate[location][query]`, `candidate[job_applications_attributes][0][cover_letter]`, …), scopes discovery to `#job-application-form` so the footer "Connect" email form is left alone, and repairs question labels polluted by the visually-hidden "Required" marker.
- **Teamtailor address commit** — the "Address" field is a Places-style autocomplete whose hidden `place_id` / `city` / `state` / `zip` / `country` / `lat` / `long` inputs are what the server actually stores. `postFill()` types the profile address, picks the best-matching suggestion, and verifies the hidden inputs were populated (street-level query first, city-level fallback).
- **Teamtailor CV upload wait** — the resume goes through Dropzone to S3 and the form is disabled mid-upload, so `postFill()` waits for every preview to reach `dz-success`/`dz-complete` before driving the address widget. `candidate[consent_given]` is ticked by name on tenants that render it as a mandatory checkbox.
- Registered in `manifest.json`, `jd-extractor.js`, `content.js` (adapter lists + custom-domain platform fallback), `field-mapper.js` `PLATFORM_PATTERNS`, `background.js` ATS-host list, `ai-engine.js` `PLATFORM_STYLE`, `popup/popup.js` injection list, and `platform-seeds.json`.
- **`test-runner/teamtailor-fill.js`** — end-to-end harness: loads the unpacked extension, fills a vendor-host job (no questions) and a custom-domain job (6 screening questions incl. a conditional one), and reports filled fields, the hidden location inputs, and any unanswered mandatory question. Never submits.

### Fixed

- **`field-discoverer.js` — labels starting with a newline were discarded.** `cleanLabel()` took `split('\n')[0]`, which is empty for pretty-printed server-rendered markup, so the field was dropped for having "no label". Every Teamtailor choice/boolean screening question hit this and was silently skipped by the filler. Now takes the first *non-empty* line.
- **Fields revealed by a class toggle are now filled.** The content-script MutationObserver only reacts to added nodes, so conditional questions that are already in the DOM and revealed by removing a wrapper class (Teamtailor `data-question-show-if-*`) were never picked up. `window.QuickApplyRequestRefill(reason)` lets a platform filler request one bounded extra pass (one-shot per page load, waits for the in-flight fill, skips the CV re-upload and the duplicate check).

## [3.7.0] — 2026-07-21

### Added — Batch Fill (Apply Multiple Jobs Hands-Free)

- **`fill-queue.js`** — Persistent queue module (`quickapply_fill_queue`) with dedup, add/remove/clear, and list operations. Unit-tested (9 assertions in `tests/fill-queue.test.js`).
- **`fill-runner.js`** — Service-worker batch runner: opens hidden tabs in parallel, sends `FILL_FORM`, waits up to 3 minutes for a `FILL_REPORT`, records results in `quickapply_fill_last_batch`. Per-row retry; `pause`/`resume`/`cancel`; tab-set cleanup on cancel or SW eviction. State survives service-worker restarts.
- **Dashboard "Batch Apply" tab** — New fourth-from-left sidebar panel. Paste job URLs into the textarea or right-click links anywhere to add them to the queue. Shows the queue with × remove, **Run** / **Pause** / **Stop** / **Clear** controls, sticky progress bar (`N / M done · K failed`), and a sortable results table (URL · Status · Filled · Errors · Time) with per-row Retry and Open links.
- **Right-click context menu** — "Add to Batch Fill Queue" item appears on any link (unrestricted — works across any job board). Clicking it resolves the URL, auto-converts common JD page URLs to their apply-form equivalents (Workday, Greenhouse, Lever, Ashby etc.), deduplicates, and adds to the queue.
- **Auto-convert JD → apply URLs** — If a queued URL points to a job description page rather than the apply form, the runner converts it before opening the tab so the filler sees the correct form URL from the start.
- **Background wiring** — `background.js` imports `fill-runner.js` and `fill-queue.js` as service-worker modules; handles `BATCH_FILL_*` messages from the dashboard and the `add-to-batch-fill-queue` context-menu event.

### Added — Ceridian Dayforce

- **`platforms/dayforce.js`** — Full filler for `jobs.dayforcehcm.com`. Handles antd `Select` commit-on-mousedown, cascading Country → State postFill, and multi-step navigation.
- **`platforms/dayforce-jd.js`** — DOM-first JD adapter (avoids `__NEXT_DATA__` i18n placeholders) with fallback to Next.js data; emits `quickapply:jd-extracted` for the mini-card.

### Enhanced — Workday

- **School typeahead** filled via `searchBox` + Enter key sequence, covering the Education section on tenants that render school as a live-search input rather than a dropdown.
- **Step-2 section skip + multi-step dedup** — skips already-completed steps on multi-page Workday applications; dedup bypass so returning to step 2 doesn't double-fill.
- **Per-key trusted typing** — each character dispatched as a CDP `Input.dispatchKeyEvent` so React's synthetic key listeners accept the input.
- **Default-answer unfilled eligibility / consent Yes/No** — after the main fill pass a postFill sweep sets any remaining unanswered Yes/No eligibility or consent questions (authorization, sponsorship, non-compete, background check) to their safe default.
- **"How did you hear" hierarchical source** — reliably fills the multi-level dropdown by matching the parent category first, then the child option; opaque hex IDs rejected from the candidate set to prevent false matches.

### Enhanced — Learning Engine

- **Shared write-gate** — a single mutex prevents concurrent correction writes that could interleave and corrupt the learned profile.
- **Post-fill ignore window** — corrections detected within 8 seconds of a fill completing are silently dropped; this prevents in-flight DOM events from being mis-classified as human corrections and poisoning the profile.
- **Auto-purge poisoned profile data** — on extension install/startup a one-time sweep removes any stored profile values that match known-bad patterns (e.g. job titles stored as names) accumulated by earlier versions.
- **Stable label keying** — corrections are keyed by the field's visible label text rather than its DOM id, so opaque or UUID-based field ids don't produce isolated one-off entries that never match the canonical field on the next application.

### Fixed — Greenhouse

- **Redundant re-fills stopped** — `_fillMultiPass` tracks which comboboxes already received a confirmed value and skips them on subsequent passes, reducing a 3-pass fill on a static form to a single effective pass.
- **reCAPTCHA detection** — fill aborts early with a clear report message when Greenhouse's reCAPTCHA challenge is visible, avoiding a false "filled" result on a blocked form.
- **React hydration wait extended to embedded iframes** — the hydration-ready poll now also waits for inner iframes so wrapped Greenhouse postings (playlist.com, etc.) don't begin filling before React has mounted.
- **Success / email-verification patterns** — the success detector now recognises Greenhouse's "Check your email" verification screen and the standard "Application submitted" confirmation, preventing a re-fill attempt on post-submit pages.

### Fixed — Fill Engine & Field Matching

- **Empty-label false match** in `fillRadio` / `fillCheckbox` guarded — a field with an empty visible label can no longer match every pattern and be incorrectly filled.
- **Tier bypass correction** — the AI resolver no longer bypasses its tier ordering when a cached result exists; ensures Tier-1 rules still take priority over stale AI answers.
- **AI icon lifecycle** — the spinner icon is correctly removed on both fill-success and fill-error paths, not only on success.
- **Reverse substring guard** — `field-mapper.js` now rejects reverse substring matches when the query string is very short (≤ 3 chars) to avoid spurious alias hits on single-word fields.
- **Positional selector uniqueness** — `field-discoverer.js` anchors positional CSS selectors to the nearest named container so the same index doesn't collide across sections.
- **CDP-trusted fills not learned as corrections** — `content.js` suppresses the post-fill correction-learning pass for any field that was filled via the CDP trusted-input bridge (Workday multi-select, react-select v5), preventing the filler's own synthetic events from being treated as user edits.
- **Progress overlay click-through** — the fill-in-progress overlay is `pointer-events: none` so users can still interact with the page while the fill runs.
- **Sidebar refresh on client edit** — editing a client profile now refreshes the popup's client list and fit card immediately, matching the behaviour already present for client switching.

### Performance

- **Combobox options polling** — instead of a fixed 700 ms wait after opening a combobox, the filler polls every 50 ms (up to 2 s) for the options list to appear, cutting average dropdown fill time on fast pages.
- **Wall-clock timing logs** — `[QuickApply Timing]` entries now include the total elapsed time per application (popup click → FILL_REPORT received) to help diagnose slow Gemini calls or multi-step navigation overhead.

---

## [3.6.0] — 2026-06-02

### Added — Shift Tracker (Daily Submission Counters)

- **New top-level "Shift Tracker" tab** in the dashboard sidebar, between Clients and Learning. Mounts at the top of `<main>` so the daily counter view is always one click away — no longer hidden inside a client's edit form or the Learning panel.
- **Per-shift submission tracking** via a new `quickapply_daily_counts` storage key, scoped by `${shiftDate}::${clientId}` and capped at 90 days of history (auto-pruned on every write). Set-semantic — refilling the same job today does not double-count the counter.
- **Configurable shift day** via new `shiftCutoffHour` setting (default 4 AM). A fill at 2 AM bucketed to "yesterday's shift" matches the overnight-worker mental model.
- **Per-client daily target override** via new `dailyTarget` field on each client profile (`null` = use global `dailyDefaultTarget`, default 5). Editable from the popup `⋯` menu (`Set daily target…`) and from the Shift Tracker dashboard row.
- **"Mark as done for today" cap** in the popup `⋯` menu and dashboard row — caps a client's effective target to their current count for that shift only, so the daily denominator reflects realistic targets when a client runs out of available jobs.
- **Reset today's shift button** on the Shift Tracker dashboard view — wipes `quickapply_daily_counts[today]` after confirmation (past shifts untouched).
- **Three rendering surfaces, single source of truth:**
  - **Popup state-list:** shift-header strip ("Today (Mon Jun 1) · 12 / 30 · 4 clients left") with colored progress bar, plus per-card counter + mini-bar on every client card. Hides automatically when the rolled-up target is 0.
  - **Mini-card:** small "N/M today" chip next to the fit verdict on every JD page, color-tiered (green ≥100% / yellow ≥50% / red / capped gray) with a tooltip showing the client name + cutoff.
  - **Dashboard "Shift Tracker" panel:** interactive today block (Mark done / Undo / Set target buttons per client) + read-only `<details>` history of the last 14 shifts + totals line ("Daily total: X / Y · N clients on target").
- **Targets settings panel** in the dashboard's Settings modal — new "Targets" tab with validated inputs for `dailyDefaultTarget` (0–50) and `shiftCutoffHour` (0–23). Bulk-save button also reads these inputs so edits aren't lost on Save Settings.

### Added — Duplicate-Application Detection

- **New `quickapply_applied_jobs` storage index**, keyed by `${clientId}::${jobKey}` with `{firstAppliedAt, lastAppliedAt, count, url, platform, title, company}`. JobKey is a stable per-platform identifier from `QuickApplyJdExtractor.extract()` (URL fallback when no adapter matches).
- **Defense-in-depth write path** — both `content.js` (immediately after `fillAll`) and `background.js` (on `FILL_REPORT`) upsert the index. Survives MV3 service-worker idle termination mid-fill.
- **Pre-fill duplicate check** in `content.js handleFill` — bails out early with a `duplicate:true` FILL_REPORT before any DOM is touched. Skipped when the popup explicitly sets `payload.skipDuplicateCheck:true`.
- **Three visible feedback surfaces:**
  - **Page toast** ("Already applied to this job on <date>.") — fires regardless of popup state, so keyboard-shortcut users see it too.
  - **Popup inline warning** — yellow banner under the Fill button with the last-applied date + count; the Fill button label flips to "Fill Anyway" so a second click overrides. Dismissible via the × on the warning. Cleared automatically on client switch.
  - **Mini-card banner** — yellow "Already applied to this job — Last filled on <date>" banner inside the shadow-DOM card, visible without opening the popup.

### Added — Diagnostic Timing Logs

- New `[QuickApply Timing]` console logs at every fill-pipeline boundary (popup → background → content → handleFill phases → fillAll). Helped diagnose the ~25 s gap between Fill click and visible filling on slow Gemini calls; remain in production for ongoing performance visibility.

### Added — Platforms

- **SAP SuccessFactors** — JD adapter + filler (`platforms/successfactors-jd.js`, `platforms/successfactors.js`).
- **UltiPro** — JD adapter + filler (`platforms/ultipro-jd.js`, `platforms/ultipro.js`).

## [3.4.1] — 2026-05-22

### Fixed — Workday filler & mini-card UX

- **Mini-card no longer blocks ATS footer buttons.** `mini-card.js` host moved from `right:16px;bottom:16px` to `left:16px;bottom:16px` and the host shell is now `pointer-events:none` (the visible `.card` re-enables `pointer-events:auto` so its own controls remain interactive). Every major ATS right-aligns its primary "Save and Continue" / "Submit" — at max z-index, the previous bottom-right card swallowed those clicks on Workday and silently no-op'd the action. Verified on a live Greenhouse posting: `elementFromPoint` at the page's bottom-right corner now returns the page body, not the card host.
- **CV upload now finds Workday's Resume/CV dropzone.** `content.js handleCVUpload` skipped the input on Thermo Fisher (and other wd5 tenants) because the file input carries `data-automation-id="file-upload-input-ref"` — which `getElementContext` collapses to just `"ref"` — and the immediate formField label is the generic "Upload a file (5MB max)". The actual "Resume/CV" label is an `<h4>` ~8 ancestors up. The matcher now walks up to 8 ancestors, finds the nearest heading-bearing section (`h1-h6,legend,[role=heading],…SectionTitle/PanelTitle`), and folds that heading text into the CV-keyword check. Verified on a fixture replicating the live DOM: CV lands in the Resume/CV input, NOT in the sibling Certifications "Attachments" input (which is correctly scoped to its own "Certifications" heading and therefore skipped).
- **Stale customFields can no longer override standard profile fields.** `field-mapper.js matchByCustomFields` runs ahead of `matchByDataAutomationId`/`matchByName`, so a stored customField like `{label:"first name", value:"Doe"}` or `{label:"first and last name", value:"Doe"}` (cached from past sessions and pointing at the wrong half of the name) was beating the canonical Workday alias match via word-boundary substring and Jaccard token overlap. The matcher now skips any customField whose label or alias *shadows* a standard `FIELD_MAPPINGS` alias (`matchAgainstAliases(...).confidence ≥ 0.6`) — strict-equality custom matches still win, so legitimate questions ("Will you need visa sponsorship?", etc.) are unaffected; only shadowing entries on names/email/phone/address defer to the canonical matchers. Side-effect fix for the long-running `addressLine2` duplication bug, whose cause was the same shadow (`{label:"address", value:"123 Main St, Apt 4"}`).
- **Workday Phone Number digit-strip extended.** The existing `platforms/workday.js` postFill stripped a leading `+digits` country-code prefix but left `(555) 123-4567` formatting, which Workday's strict validator rejects with "Enter a valid format for Phone Number." Sanitization now normalizes the input to digits-only (`5551234567`) and additionally strips a leading "1" country code on 11-digit US numbers, then redispatches `input`/`change`/`blur` so Workday re-validates.

### Tooling — Isolated test harness

- **`test-runner/wd-verify-launcher.js`** — separate `--remote-debugging-port=9223` Chrome instance with its own user-data-dir. `chrome.runtime.reload()` on a `--load-extension` browser was found to put extension pages into `ERR_BLOCKED_BY_CLIENT` and could close the controlling window; the isolation pattern lets us pick up code edits via a fresh relaunch without disturbing live sessions in the primary browser.
- **`test-runner/cv-fixture.html` + `serve-fixture.js`** — localhost http://:8899 fixture that replicates Workday's Resume/CV dropzone DOM (`file-upload-input-ref` under a generic formField label, with `<h4>Resume/CV</h4>` at the 8th ancestor) AND a sibling Certifications "Attachments" input, plus Workday-shaped Legal Name and Address inputs. Used to reproduce + verify the CV-upload and customField-shadowing fixes without any ATS login.
- **`test-runner/wd-*.js`** — CDP step scripts (`wd-inspect.js`, `wd-fill.js`, `wd-next.js`, `wd-signin.js`, etc.) that connect to the launcher's persistent context for inspect/fill/Save&Continue steps. Each connects, acts, and exits without closing the browser; the launcher owns lifetime.

## [3.3.0] — 2026-05-11

### Added — Compact Fit Card mode

- **`fitCardMode` setting** (`detailed` | `compact`) — compact mode surfaces a single most-relevant row instead of the 8-row breakdown. Picker priority: first hard fail → first manual → lowest-scoring soft row, with tie-break on lowest soft-weight. Returns null (verdict-only) when no row scores below 75.
- **`[Show details]` toggle** — inline button on the compact popup expands to the full 8 rows per popup-open without changing the saved setting.
- **Dashboard select** under Job Analyzer → "Fit Card Mode" persists the choice in `settings.fitCardMode`.

### Added — Floating Mini-Card overlay

- **`mini-card.js` content script** injects a Shadow-DOM-isolated `<div>` bottom-right on every JD page (top-frame, http(s) only). Listens for a new `quickapply:jd-extracted` `CustomEvent` from `jd-extractor.js`, scores against the active client via the in-frame FitMatcher, renders verdict + worst row.
- **Click body to expand inline** — the full 8-row breakdown shows in the card; click again to collapse.
- **Per-host dismissal** with 7-day TTL stored under `quickapply_minicard_dismissals: { [host]: timestampMs }`. Module: `mini-card-dismissals.js`.
- **Master toggle** `showMiniCard` (default true) in Dashboard → Settings → Job Analyzer.
- **Red reject pills** under `Not a fit` verdict surface each failing hard parameter (Visa, Location, Work mode, Employment, Experience level) as a small red pill with the full reason on hover.

### Added — Keyboard shortcuts

- **`Alt+Shift+F`** — fill the active client's profile on the current page (reuses the popup's `FILL_FORM` path).
- **`Alt+Shift+J`** — toggle the floating mini-card overlay (in-memory; doesn't override per-host dismissal).
- **`Alt+Shift+R`** — evict this JD's cache, re-extract from DOM, refresh the mini-card.
- `manifest.json` `commands` block + `background.js` `chrome.commands.onCommand` listener route each to the active tab as a typed message; `content.js` adds `FILL_FROM_SHORTCUT`, `TOGGLE_MINI_CARD`, `REFRESH_JD` handlers.

### Added — JD Analyzer Queue (bulk batch triage)

- **Right-click context menu** on `https://applyall.com/*` adds the link URL to a queue stored at `quickapply_jd_queue: [{ url, addedAt }]`. Case-insensitive dedup at add-time. Extension icon shows a red badge with the queue count, mirrored via `chrome.storage.onChanged`.
- **Popup queue section** between the Fit Card and Fill button — shows the queue with × per-row remove, Run analysis (sends `RUN_BATCH` to background), and Clear buttons. Hidden when empty.
- **`jd-batch-runner.js`** — service-worker module that opens up to **10 hidden background tabs in parallel** (`chrome.tabs.create({ active: false })`), each polling the existing `GET_FIT_SCORE` handler every 500ms until response or budget. **10s first-attempt settle, 5s retry** on failure (one retry, then mark `failed`). Results stream into `quickapply_jd_last_batch` so the dashboard renders row-by-row.
- **Active client locked at run-start** — switching the active client mid-batch keeps the batch scoring against the original. Dashboard banner ("Results were for X · Re-run for current client") if the active client changed since the batch started.
- **Dashboard JD Analyzer sidebar tab** — fourth tab next to Clients/Learning/Recordings. Paste-list textarea (whitespace-separated URLs, deduped on add), queue list with × buttons, Run/Stop/Clear queue buttons, sticky progress bar (`N / M scored · K failed`). Sortable results table: **Title · Company · Verdict · Fit % · Top reason** with filter chips (`All`, `Strong + Good`, `Failed`) and a `Clear results` button. Per-row `Open` and `Retry` actions. Polls `quickapply_jd_last_batch` every 1s while panel is visible AND batch is running.
- **Snappy cancellation** — `Stop` button closes all in-flight tabs immediately (tracked in `_activeTabIds` Set); remaining unscored rows marked `cancelled`.
- **Service-worker resilience** — on SW startup `_cleanupOrphanJdTabs` closes any tabs still pointing at pending/running rows from a prior batch and marks those rows `failed: 'sw_evicted'`.
- **URL-hash deep link** `#jd-analyzer` auto-activates the panel when the background opens the dashboard tab after Run.

### Fixed — Job Analyzer

- **Experience-level label mismatch no longer kills good fits.** When the JD's inferred seniority differs from the client's `targetExperienceLevel` preference BUT the client's `yearsOfExperience` falls in the YoE band that defines the JD's level (e.g. JD = Senior at 5+ yrs, client wants Mid but has 6 yrs), the row is now `status: 'manual'` (⚠) instead of hard `fail`. The verdict goes through normal soft-param scoring instead of being forced to `not_a_fit`. Hard fail still triggers when YoE doesn't fall in the JD's level band (genuinely under- or overqualified).
- **CSP-compliant test fixtures** — `test/test-fit-card-compact.html`, `test-minicard-dismissals.html`, `test-jd-queue.html` now load their runners from external `.js` files. MV3 forbids inline `<script>` blocks on `chrome-extension://` pages, so the previous inline runners silently never executed.
- **Popup init guard** — `popup.js` only fires its `DOMContentLoaded` initializer when `#client-list` exists, so test fixtures that `<script src="../popup/popup.js">` can exercise `pickPrimaryParam` in isolation without crashing on missing popup-only elements.

### Tooling

- `jd-queue.js` — shared storage module exposed via `globalThis.QuickApplyJdQueue` so it works in popup (`<script src>`), dashboard (`<script src>`), and service worker (`importScripts`).
- `test/test-jd-queue.html` + `.js` — 9-assertion self-test for queue dedup, list shape, remove, clear, persistence.
- `test/test-fit-card-compact.html` + `.js` — 6-assertion self-test for `pickPrimaryParam` priority (hard fail → manual → lowest soft) and tie-break on weight.
- `test/test-minicard-dismissals.html` + `.js` — 5-assertion self-test for `isDismissed`/`dismiss`/`clear` + 7-day TTL eviction.

### Permissions

- Added `contextMenus` to `manifest.json` `permissions` (right-click integration on applyall.com).

---

## [3.2.0] — 2026-05-06

### Added — Job Analyzer / Fit Card

- **Per-JD scoring** against the selected client across hard parameters (visa, location, work mode, employment type) and soft parameters (years-of-experience, title, skills, salary). Hard fail short-circuits to *not_a_fit*; soft params produce a weighted overall % with bands `strong ≥ 80`, `good ≥ 60`, `weak ≥ 40`, `poor`, `not_a_fit`.
- **Visa & Location** support a third `manual` state — fired when the client requires sponsorship (visa) or has location preferences (location) and the JD is silent. Yellow dot in the UI; the verdict is not failed on a missing signal.
- **Batched Gemini fit-score** for fuzzy title + skills + (optional) YoE estimation when the JD doesn't state required years. Single API call per `(jobKey, clientId)`, results cached inside the `JdObject`. Graceful fallback to rules-only when no Gemini key is configured.
- **Popup Fit Card**: verdict + per-parameter rows above the Fill button when a client is pinned, in the existing Ink & Paper palette.
- **Dashboard Job Analyzer settings tab**: display toggles (verdict / breakdown) and advanced soft-param weights with sum-to-100 validation.
- **JD cache** (`jd-cache.js`): L1 in-memory + L2 `chrome.storage.local`, FNV-1a fingerprint, 7-day TTL, 100-entry LRU.
- **Profile fields**: `preferredLocations: string[]` and `targetRoles: string[]` in the Work Preferences section.

### Added — JD platform coverage

- **Greenhouse** (`platforms/greenhouse-jd.js`) — direct + iframe-embedded wrapper sites. Cross-frame `gh_jid` jobKey unifies parent + iframe + direct extractions on one cache entry.
- **Workday** (`platforms/workday-jd.js`) — stable cross-page `jobKey` `workday:{tenant}:{jobId}` so the JD page populates the cache and the apply page reads from it.
- **Ashby** (`platforms/ashby-jd.js`), **Rippling** (`platforms/rippling-jd.js`), **Workable** (`platforms/workable-jd.js`), **SmartRecruiters** (`platforms/smartrecruiters-jd.js`).
- **Shared parsers** (`platforms/_jd-helpers.js`) — location flags, YoE, salary (with $10K minimum to reject ad-hoc small mentions), visa text, employment type, body-walk-up.

### Fixed

- **Workday Self-Identify `Date*`** now fills today's `MM/DD/YYYY` instead of whatever the AI guessed (date-of-birth or random profile date). Label predicate matches `Date*` / `Today's Date` / `Signature Date` / `Date Signed` / `Date of Signature`, with a negative-context guard that rejects Birth/Graduation/Start/Hire/End/Expir/Valid/Anniversary.
- **Greenhouse wrapper sites** (playlist.com, hourglasscosmetics.com): `_bodyText()` walks up from `<h1>` and falls back to `<main>`/`<article>` when Greenhouse-direct selectors don't match. Wrapper-vs-iframe extraction race resolved by a `GENERIC_H1_RX` parent-skip guard plus richer-only cache writes.
- **Multi-frame `chrome.tabs.sendMessage` race**: `GET_FIT_SCORE` handlers now stay silent when their frame has no JD, so sibling frames with data win the response slot rather than getting drowned by a wrapper parent's null.
- **Title-mutation re-extract**: the `<title>` MutationObserver now calls `extract()` directly instead of `maybeExtract()`, so URL-dedup doesn't defeat re-extraction when the iframe's `<h1>` renders late.
- **Rippling title parsing**: split on whitespace-bounded ` | ` / ` – ` / ` - ` only, so titles like `Marketing Coordinator (Full-Time) | CallRevu` are no longer broken at the inner hyphen.

### Tooling

- `test-runner/run-job-analyzer-tests.js` — loads the unpacked extension, restores backup, walks 9 scenarios and reports frame inspection + Fit Card snapshot + fill summary per scenario.
- `test-runner/fill-workday-trimble-flow.js` — full Trimble Workday application flow with step-by-step fill + Self-Identify Date assertion.
- `test/test-job-analyzer.html` — deterministic unit tests for `JdCache` and `FitMatcher` hard / soft params.

---

## [3.1.0] — 2026-04-24

### Added — Workday filler overhaul

- **Button-as-dropdown** discovery + filler for `button[aria-haspopup="listbox"]` widgets (State, Degree, Phone Type, Compensation, EEO selects).
- **Spinbutton dates** filler for `dateInputWrapper`'s `role="spinbutton"` triplets, with synthetic per-digit keystroke sequence + native value-setter fallback.
- **Hierarchical multiselect** filler for the search-input multiselects (How Did You Hear, Country Phone Code, Skills, Field of Study) with token-overlap scoring + `WORKDAY_SOURCE_HINTS`.
- **Repeatable section auto-expand** in `preFill` — clicks every `[data-automation-id="add-button"]` so Work Experience / Education / Languages sub-fields exist before discovery.
- **Opaque hex-ID custom questions** matched by full-phrase aliases in `WorkdayFiller.getFieldAliases()` ("legally authorized to work", "require sponsorship or other support", "desired compensation", etc.).
- **Shadow-DOM-aware** discovery via `_queryAllDeep`.

Verified end-to-end on Robert Half (`roberthalf.wd1`), Veritiv (`veritiv.wd5`), and Adobe (`adobe.wd5`) tenants.

---

## [3.0.x and earlier]

See `docs/PRD.md` § Release History for the full pre-3.1 timeline.
