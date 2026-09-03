# QuickApply — Chrome Extension

> Auto-fill job application forms across 17 ATS platforms, for multiple client profiles, with one click.

QuickApply is a Manifest V3 Chrome extension that reads a stored client profile and fills a job
application form end to end — standard fields, custom questions, EEO sections, multi-step wizards
and CV upload — while keeping every byte of client data on the user's own machine.

---

## ⚠️ Source-available, not a distribution

This repository is published **for reference and review only**.

The background service worker (`background.js`) is **deliberately not included**. Without it the
extension cannot be loaded via `chrome://extensions` → *Load unpacked*, and the published files will
not run as a working extension. The internal QA harness and product planning documents are withheld
for the same reason.

If you need a working build or access to the complete source, please request written permission —
see [License](#-license).

---

## ✨ Features

- **Multi-client management** — unlimited client profiles with contact, address, education, work
  history, skills and EEO details
- **One-click auto-fill** — pick a client in the popup and the entire form fills in place
- **Batch AI resolution** — every unknown field on a page is answered in a *single* Gemini call
  rather than one call per field
- **Fingerprint cache** — FNV-1a field fingerprints cached per client (L1 memory + L2 storage,
  90-day TTL), so a repeat form fills in under a second with no AI call at all
- **Platform-specific fillers** — dedicated adapters per ATS instead of one brittle generic matcher
- **Job Analyzer** — per-JD Fit Card scoring visa, location, work mode, employment type, plus
  AI-assisted years-of-experience, title, skills and salary matching
- **Batch fill queue** — queue multiple postings and run them in sequence
- **Auto-advance & auto-submit** — optional multi-step driver that clicks Next/Continue, detects
  validation errors, and can submit hands-free
- **CV upload** — locates the true Resume/CV dropzone (not sibling attachment inputs) and uploads
- **Review before submit** — side panel lists exactly what was filled, with per-field confidence
- **Learning engine** — records corrections and platform-specific behaviour to improve later fills
- **100% local** — all data lives in `chrome.storage.local`; no backend, no telemetry
- **Optional AI** — Google Gemini with a user-supplied key; with no key, everything except
  open-ended answers still works

## 🎯 Supported platforms

Each platform ships an application-form filler and a job-description extractor.

| | | | |
|---|---|---|---|
| Workday | Greenhouse | Lever | SmartRecruiters |
| iCIMS | Ashby | Workable | Rippling |
| Breezy | Dayforce | SuccessFactors | UltiPro |
| Eightfold | Teamtailor | Gem | Netflix |
| TikTok | *Generic HTML forms* | | |

Workday support covers Shadow DOM + Polymer 2.x, `data-automation-id` resolution,
button-as-dropdown controls, spinbutton dates and hierarchical multiselects.

## 🏗️ Architecture

```
popup / dashboard  ──▶  background service worker  ──▶  Gemini API
                              │  (withheld)
                              ▼
                        content script
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  field-discoverer      field-mapper           platform filler
  (scan the form)   (identify each field)   (ATS-specific quirks)
        └─────────────────────┼─────────────────────┘
                              ▼
                        ai-resolver
              T1 profile → T2 cache → T3 Gemini batch
                              ▼
                         fill-engine
```

Resolution is tiered: a field is answered from the client profile if possible, then from the
fingerprint cache, and only unresolved fields are batched into one AI request.

## 📁 Project structure

```
QuickApply/
├── manifest.json              # Chrome MV3 manifest
├── content.js                 # Content-script orchestrator
├── storage.js                 # chrome.storage.local wrapper — client CRUD, settings
├── cache.js                   # Fingerprint cache — FNV-1a, L1 memory + L2 storage, 90d TTL
├── field-mapper.js            # Field identification + fuzzy option matching (200+ aliases)
├── field-discoverer.js        # Form scanner — 9-strategy label extraction
├── fill-engine.js             # Per-input-type fill methods + progress tracking
├── ai-resolver.js             # 3-tier resolver — profile, cache, Gemini batch
├── ai-engine.js               # Gemini wrapper — batch and per-field calls
├── submit-engine.js           # Multi-step form driver — auto-advance + auto-submit
├── learning-engine.js         # Corrections, platform learning, field registry
├── cv-parser.js               # PDF/DOCX text extraction via PDF.js
├── jd-extractor.js            # Job-description extraction
├── fit-matcher.js             # Fit scoring against client preferences
├── mini-card.js               # Floating Job-Analyzer card
├── fill-queue.js              # Batch fill queue
├── platform-seeds.json        # Pre-seeded field mappings per ATS
├── platforms/                 # One filler + one JD extractor per ATS
├── popup/                     # Extension popup
├── dashboard/                 # Full-tab client manager
├── lib/                       # Mozilla PDF.js (vendored)
├── icons/
├── test/                      # Browser fixtures
├── tests/                     # Jest unit tests
└── docs/                      # Architecture, data schema, field mappings, release notes
```

> `background.js` (service worker) is withheld — see the notice above.

## 🧪 Tests

```bash
npm install
npm test
```

Unit tests run under Jest with a jsdom environment and a stubbed `chrome` API
(`tests/setup-chrome.js`). Browser fixtures under `test/` are opened directly in Chrome with the
extension loaded.

## 🔒 Privacy & security

- **All data stays local** — client profiles and CVs are stored in `chrome.storage.local`
- **No backend, no server, no telemetry** — nothing is sent anywhere the user did not configure
- **Optional AI only** — Gemini is contacted only when the user supplies an API key; with no key
  there are zero outbound requests
- **No `eval()` and no remote code execution**
- **Single host permission** — `https://generativelanguage.googleapis.com/*`
- **CV text** is included in a Gemini request only when AI is enabled and a key is set

Browser permissions requested: `storage`, `unlimitedStorage`, `activeTab`, `scripting`,
`webNavigation`, `contextMenus`, `tabs`, `debugger`. The `debugger` permission is used to drive
trusted input events on ATS forms that reject synthetic events.

## 🛠️ Tech stack

- Vanilla JavaScript — no framework, no bundler, no build step
- Chrome Extension Manifest V3
- HTML5 + CSS3
- Mozilla PDF.js (vendored) for CV parsing
- Google Gemini API (optional, user-supplied key)
- Jest + jsdom for unit tests

## 📚 Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full technical architecture |
| [`docs/DATA_SCHEMA.md`](docs/DATA_SCHEMA.md) | Client profile and storage schema |
| [`docs/FIELD_MAPPINGS.md`](docs/FIELD_MAPPINGS.md) | Field alias catalogue |
| [`docs/UI_SPEC.md`](docs/UI_SPEC.md) | Popup and dashboard specification |
| [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) | Release history |
| [`CHANGELOG.md`](CHANGELOG.md) | Detailed change log |

## 📄 License

**All Rights Reserved.** Copyright © 2026 Umar Bin Azam.

This repository is made available for viewing only. No permission is granted to copy, modify,
distribute, sublicense or use this software, in whole or in part, without prior written permission.
See [LICENSE](LICENSE) for the full terms.
