# Release Notes

## 2026-06-02 — v3.6.0

### Added — Shift Tracker (Daily Submission Counters)

A new top-level **Shift Tracker** tab in the dashboard sidebar (between Clients and Learning) gives a cross-client view of today's submission progress against per-client targets. The panel is mounted at the top of `<main>` so it's the first thing visible when the tab is active. Built for users running overnight application shifts with concrete daily quotas.

**What's counted:** one unique job filled per client per shift. Re-filling the same job today via "Fill Anyway" does NOT increment the counter (set-semantic). Each successful fill (`summary.filled > 0`) appends to `quickapply_daily_counts[shiftDate][clientId].jobKeys`, with 90-day auto-pruning on every write.

**Shift boundary:** a configurable `shiftCutoffHour` (default 4) means a fill at 2 AM Tuesday counts toward Monday's shift. Matches the overnight-worker mental model where "today" includes the early-morning tail of yesterday's shift.

**Targets:** global `dailyDefaultTarget` (default 5) plus per-client `dailyTarget` override (saved on the client profile). Each shift can additionally be capped via "Mark as done for today" — useful when a client runs out of available jobs before hitting their default target, so the daily denominator stays honest.

**Three rendering surfaces:**

- **Popup state-list** — shift-header strip with "Today (Mon Jun 1) · 12 / 30 · 4 clients left" + colored progress bar. Each client card shows its own `3 / 5` counter + mini-bar with red/yellow/green/capped tiers. Strip auto-hides when the rolled-up target is 0 (so a `dailyDefaultTarget=0` user sees no clutter).
- **Per-client `⋯` menu** on every popup card — *Mark as done for today*, *Undo "done for today"*, *Set daily target…*. Mark-done hidden until the client has at least one fill today.
- **Mini-card chip** — small `N/M today` pill next to the fit verdict on every JD page, color-tiered, with tooltip showing client name + cutoff hour. Reads the active client's entry.
- **Dashboard Shift Tracker panel** — interactive today block (per-row Mark done / Undo / Set target buttons), totals line, collapsible `<details>` history of the last 14 shifts (read-only), and a **Reset today's shift** button that wipes `quickapply_daily_counts[today]` after confirmation.

**Settings:** dashboard Settings modal gains a new "Targets" tab with validated inputs for `dailyDefaultTarget` (0–50) and `shiftCutoffHour` (0–23). The bulk Save Settings button also reads these inputs so edits aren't lost on save.

### Added — Duplicate-Application Detection

A second new index `quickapply_applied_jobs` is keyed by `${clientId}::${jobKey}` and stores `{firstAppliedAt, lastAppliedAt, count, url, platform, title, company}`. JobKey is the stable per-platform identifier from `QuickApplyJdExtractor.extract()` (e.g. `lever:captivateiq:6174a4e6-...`), with a URL fallback when no JD adapter matches.

**Pre-fill check:** `handleFill` bails out *before* touching any DOM if `quickapply_applied_jobs[clientId::jobKey]` exists. The early-return returns a `{duplicate:true, ...}` FILL_REPORT carrying the prior `lastAppliedAt`, `count`, title, and company.

**Three visible feedback surfaces** so the duplicate is noticed regardless of how the fill was triggered:

- **Page toast** — fires for keyboard-shortcut users who never opened the popup ("Already applied to this job on May 28.").
- **Popup inline warning** — yellow banner under the Fill button with the last-applied date + count; Fill button label flips to **Fill Anyway**, so a second click overrides. Dismissible × on the banner. Cleared automatically when the user switches client.
- **Mini-card banner** — yellow "Already applied to this job — Last filled on May 28." inside the shadow-DOM card on the JD page itself.

**Defense in depth:** the dedup index is written from BOTH `content.js` (immediately after `fillAll` returns ≥ 1 filled field) and `background.js` (on `FILL_REPORT` receipt). The dual-write survives MV3 service-worker idle-termination mid-flight, which previously could lose the record.

### Added — Diagnostic Timing Logs

New `[QuickApply Timing]` console logs at every fill-pipeline boundary (popup click → background routing → content receipt → handleFill phases → preFill → discoverFields → AIResolver → fillAll). Surface in DevTools across three consoles (popup, service worker, page). Originally added to diagnose the ~25 second gap between Fill click and visible filling (root cause: a single Gemini batch call for unknown fields); retained in production for ongoing performance visibility.

### Added — Platforms

- **SAP SuccessFactors** — JD adapter + filler (`platforms/successfactors-jd.js`, `platforms/successfactors.js`).
- **UltiPro** — JD adapter + filler (`platforms/ultipro-jd.js`, `platforms/ultipro.js`).

### Verified

- `chrome.storage.local.get('quickapply_daily_counts')` returns the expected shape after a fresh fill on Lever (`captivateiq:6174a4e6-...`); set-semantic verified by re-filling the same job and observing `jobKeys.length` stayed at 1.
- 95-day pruning simulation: injected 95 synthetic shift dates, triggered a fill, post-fill `Object.keys(counts).length` ≤ 91 (today + 90 prior).
- Cross-surface end-to-end: popup card / mini-card chip / dashboard row all reflect the same `submitted / target` after a fill, after Mark-done, after Undo, after Set-target.
- Duplicate-detection live test on `jobs.lever.co`: first fill writes the index, second visit to the same URL shows page toast + popup inline warning + mini-card banner, and "Fill Anyway" successfully re-fills.

### Open follow-ups

- The mini-card chip and popup card counter don't auto-refresh when another surface mutates state (e.g. dashboard Mark-done won't update the live mini-card chip). Both refresh on their next natural render (mini-card on JD event / page reload; popup on next open). Acceptable for v1.
- "Set daily target…" uses `window.prompt`. Matches the spec but a custom inline editor would be friendlier.

## 2026-05-22 — v3.4.1

### Fixed
- **Mini-card no longer blocks ATS footer buttons.** Repositioned from bottom-right to bottom-left and made the host shell `pointer-events:none` (the visible card keeps `pointer-events:auto`). On Workday/Greenhouse/Lever/Ashby/Workable the bottom-right max-z card was sitting directly over "Save and Continue" / "Submit" and silently swallowing clicks.
- **CV upload now lands in Workday's Resume/CV dropzone.** `handleCVUpload` previously skipped the input because Workday's `data-automation-id="file-upload-input-ref"` collapses to just `"ref"` and the formField label is the generic "Upload a file (5MB max)". The matcher now scans up to 8 ancestors for the nearest heading-bearing section so the actual `<h4>Resume/CV</h4>` is folded into the CV-keyword check. Certifications "Attachments" input is correctly skipped (its nearest heading is "Certifications").
- **First Name & Address Line 2 wrongly filled with cached customField values.** Stored customFields such as `{label:"first name", value:"Doe"}` and `{label:"address", value:"123 Main St, Apt 4"}` were beating the canonical Workday alias match via word-boundary substring and token overlap. `matchByCustomFields` now skips customFields whose label/alias shadows a standard `FIELD_MAPPINGS` alias (confidence ≥ 0.6); legitimate non-shadowing customField questions are unaffected.
- **Workday Phone Number now normalized to digits-only.** Existing prefix strip removed `+1 ` but left `(555) 123-4567`, which Workday's validator rejects. Postfill now strips all non-digits (and a leading "1" country-code on 11-digit US numbers), then redispatches `input`/`change`/`blur`.

### Verified
- Live Greenhouse posting (mini-card position): `#quickapply-mini-card-host` rect on left half; `document.elementFromPoint(W-30, H-30)` returns `BODY`.
- Localhost fixture mirroring live Thermo Fisher (wd5) Resume/CV DOM: CV file lands in the Resume/CV input, Certifications "Attachments" stays empty.
- Localhost fixture with full client `customFields` and `forceAI=false`: First Name = "Jane", Last Name = "Doe", Address Line 2 = "Apt 4" (no longer the streetAddress duplicate).
- Phone digit-strip is exercised by the existing workday-platform postFill path; live verification on a Workday tenant is the remaining check.

### Open follow-ups
- One-time cleanup of the active client's stored `customFields` (entries with shadowing labels like `"first name"`, `"first and last name"`, `"address"` carry stale values that the code fix neutralizes but doesn't delete).
- Live verification of the phone digit-strip on a Workday tenant.

## 2026-04-27

### Fixed
- Greenhouse applications embedded inside wrapper pages now receive fill commands through their ATS iframe, including Nextiva links such as `careers-listing?gh_jid=...`.
- Batch fill reports are returned to the popup after the batch path completes, so the review panel shows the real Greenhouse iframe result instead of a stale or unrelated frame report.
- Popup retry injection now targets all frames, matching the manifest content-script behavior for embedded ATS pages.
- Popup-triggered fills now pass the active tab id into the background router and wait for the embedded ATS iframe before filling, which fixes the real popup path for Nextiva wrapper pages.

### Improved
- Dashboard and popup UI updates were applied in the root extension, including button icon polish, grouped header actions, learning filters, and the settings modal tabs.
- The `forceAI` setting remains available in popup and dashboard settings and is still passed into batch AI resolution.

### Verified
- `node --check` passed for changed JavaScript entry points.
- Playwright verified the Nextiva Greenhouse URL on 2026-04-27 with the report returned from `job-boards.greenhouse.io/embed/job_app`: `filled=10`, `error=0`, `total=21`.
- Playwright also verified the popup/background route with `targetTabId` on the same Nextiva URL: `filled=10`, `error=0`, `total=21`.
