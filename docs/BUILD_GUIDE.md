# QuickApply — File-by-File Build Guide

**Version:** 1.0  
**Date:** 2026-03-06  
**Purpose:** Step-by-step instructions for an AI agent to build every file in the correct order.

---

## Build Order

Files MUST be created in this exact order due to dependency chains:

```
Phase 1 — Foundation (no dependencies)
  1. manifest.json
  2. storage.js
  3. icons/ (generate 3 PNGs)

Phase 2 — Dashboard (depends on: storage.js)
  4. dashboard/dashboard.html
  5. dashboard/dashboard.css
  6. dashboard/dashboard.js

Phase 3 — Core Engine (depends on: storage.js)
  7. field-mapper.js
  8. content.js

Phase 4 — Popup (depends on: storage.js, content.js message protocol)
  9. popup/popup.html
  10. popup/popup.css
  11. popup/popup.js

Phase 5 — Background (depends on: all message types)
  12. background.js

Phase 7 — Intelligence Layer (depends on: content.js, field-mapper.js)
  14. learning-engine.js

Phase 8 — Documentation
  15. README.md
```

---

## Phase 1: Foundation

### File 1: `manifest.json`

**Reference:** ARCHITECTURE.md § 2, DATA_SCHEMA.md § 1.2

```json
{
  "manifest_version": 3,
  "name": "QuickApply – Job Auto-Fill",
  "version": "1.0.0",
  "description": "Auto-fill job application forms for multiple clients with one click.",

  "permissions": [
    "storage",
    "unlimitedStorage",
    "activeTab",
    "scripting"
  ],

  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },

  "background": {
    "service_worker": "background.js"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["storage.js", "field-mapper.js", "content.js"],
      "all_frames": true,
      "run_at": "document_idle"
    }
  ],

  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Key decisions:**
- `"all_frames": true` — enables auto-fill inside iframes
- `"run_at": "document_idle"` — ensures DOM is fully loaded before content script runs
- `storage.js` and `field-mapper.js` are loaded before `content.js` so they're available
- `unlimitedStorage` — required for storing multiple CVs as base64

---

### File 2: `storage.js`

**Reference:** DATA_SCHEMA.md § 1 (full schema), § 1.2 (storage keys)

**Must export these functions** (attached to `window` for content script access):

```
window.QuickApplyStorage = {
  // Client CRUD
  getClients()                    → Promise<ClientProfile[]>
  getClientById(id)               → Promise<ClientProfile | null>
  saveClient(profile)             → Promise<void>          // upsert by id
  deleteClient(id)                → Promise<void>
  
  // Bulk operations
  exportAll()                     → Promise<string>        // JSON string
  importAll(jsonString)           → Promise<{added, updated, skipped, errors}>
  
  // Settings
  getSettings()                   → Promise<AppSettings>
  saveSettings(settings)          → Promise<void>
  
  // Utilities
  generateId()                    → string                 // UUID v4
  getStorageUsage()               → Promise<{used, total}> // bytes
}
```

**Implementation requirements:**

1. All functions use `chrome.storage.local.get()` and `chrome.storage.local.set()`
2. `saveClient()`: if `profile.id` exists, update; else create with new UUID
3. `saveClient()`: auto-compute `fullName = firstName + " " + lastName`
4. `saveClient()`: auto-set `updatedAt = new Date().toISOString()`
5. `saveClient()`: on create, auto-set `createdAt` and assign `avatarColor` from the color rotation
6. `deleteClient()`: also removes the client from the array in storage
7. `exportAll()`: returns `JSON.stringify({ quickapply_clients: [...], quickapply_settings: {...}, quickapply_version: "1.0" })`
8. `importAll()`: validates each profile, reports counts of added/updated/skipped/errored
9. `generateId()`: implement UUID v4 using `crypto.getRandomValues()`
10. All functions must handle errors gracefully — wrap in try/catch, return meaningful error messages

**Default settings:**
```javascript
const DEFAULT_SETTINGS = {
  highlightDuration: 10,
  highlightEnabled: true,
  fillDelay: 50,
  autoExpandSections: true,
  confirmFuzzyMatches: true
};
```

---

### File 3: `icons/` (3 PNG files)

Generate extension icons at 16×16, 48×48, and 128×128 pixels.

**Design:** A stylized "Q" or lightning bolt on a purple (#6C5CE7) circular background. Simple, flat design, recognizable at 16px.

---

## Phase 2: Dashboard

### File 4: `dashboard/dashboard.html`

**Reference:** UI_SPEC.md § 3

**Structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QuickApply Dashboard</title>
  <link rel="stylesheet" href="dashboard.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
  <header><!-- Logo, title, Export/Import buttons --></header>
  
  <main>
    <aside id="client-sidebar">
      <!-- Search box -->
      <!-- Client list (scrollable) -->
      <!-- Add Client button -->
      <!-- Storage info -->
    </aside>
    
    <section id="client-detail">
      <!-- Empty state when no client selected -->
      <!-- Edit form (hidden until client selected) -->
      <!--   Section: Personal Information -->
      <!--   Section: Contact -->
      <!--   Section: Address -->
      <!--   Section: Demographics -->
      <!--   Section: Professional -->
      <!--   Section: Education -->
      <!--   Section: Skills -->
      <!--   Section: Work Preferences -->
      <!--   Section: Resume/CV upload -->
      <!--   Section: Cover Letter upload -->
      <!--   Section: Custom Fields -->
      <!--   Save / Delete buttons -->
    </section>
  </main>
  
  <div id="toast-container"></div>
  
  <script src="../storage.js"></script>
  <script src="dashboard.js"></script>
</body>
</html>
```

**Requirements:**
- Every input must have a unique `id` matching the profile field name (e.g., `id="firstName"`)
- Every input must have a `<label>` with `for` attribute
- Select elements for: gender, ethnicity, veteranStatus, disabilityStatus, highestEducation, country, state, workAuthorization, willingToRelocate, desiredEmploymentType, remotePreference
- File input for CV with accept=".pdf,.docx"
- All sections collapsible (use `<details>` or custom accordion)

---

### File 5: `dashboard/dashboard.css`

**Reference:** UI_SPEC.md § 1 (design tokens), § 3 (layout)

**Requirements:**
- Implement ALL CSS custom properties from UI_SPEC.md § 1
- Dark theme (--bg-primary as background)
- Sidebar: 280px fixed width, scrollable client list
- Detail panel: fills remaining width
- Form sections: card-style with rounded corners, slight shadow
- Input styling: dark background, light text, purple focus border
- File upload zone: dashed border, hover state, drag-over state
- Responsive: sidebar collapses at < 768px
- Toast component: top-right, slide-in animation
- Scrollbar styling: thin, custom colors
- Animations: section expand/collapse, card hover, button press

---

### File 6: `dashboard/dashboard.js`

**Reference:** DATA_SCHEMA.md § 1 (schema), UI_SPEC.md § 3.3 (interactions)

**Must implement:**

1. **On load:** Call `QuickApplyStorage.getClients()` and render sidebar
2. **Sidebar client cards:** Each shows avatar (initials with color), name, email. Click loads into form.
3. **Search filter:** Real-time filter by name as user types
4. **"Add Client" button:** Creates empty form, generates new ID, focuses firstName
5. **Form loading:** Populate all form fields from selected profile
6. **Form saving:**
   - Collect all field values from DOM
   - Handle file uploads: read as base64 via `FileReader.readAsDataURL()`
   - Strip the `data:...;base64,` prefix before storing
   - Call `QuickApplyStorage.saveClient(profile)`
   - Show success toast
   - Re-render sidebar
7. **Form validation:**
   - firstName, lastName, email required
   - Email format validation
   - CV file size < 5MB
   - Show inline error messages
8. **Delete:** Confirm dialog → `QuickApplyStorage.deleteClient(id)` → select next client
9. **Export:** `QuickApplyStorage.exportAll()` → create Blob → trigger download
10. **Import:** File input → read JSON → `QuickApplyStorage.importAll()` → show results toast
11. **CV preview:** Show filename + size. "✕" to remove. Click to re-upload.
12. **Custom fields:** Dynamic add/remove rows with label, value, aliases inputs
13. **Section collapse:** Expand/collapse with smooth animation
14. **Storage usage:** Display total storage used in sidebar footer

---

## Phase 3: Core Engine

### File 7: `field-mapper.js`

**Reference:** FIELD_MAPPINGS.md (complete dictionary), ARCHITECTURE.md § 4.1 (pipeline)

**This is the most critical file.** Must implement:

```
window.QuickApplyFieldMapper = {
  // Main entry point
  identifyField(element)          → { profileField: string, confidence: number, strategy: string } | null
  
  // Sub-strategies (called by identifyField in order)
  matchByName(element)            → match | null    // priority 1
  matchById(element)              → match | null    // priority 2
  matchByLabel(element)           → match | null    // priority 3
  matchByPlaceholder(element)     → match | null    // priority 4
  matchByAriaLabel(element)       → match | null    // priority 5
  matchByNearbyText(element)      → match | null    // priority 6
  
  // Value helpers
  fuzzyMatchOption(options, targetValue)  → { index, text, confidence }
  getFieldMapping()               → the full dictionary object
  
  // Platform detection
  detectPlatform(url)             → string
}
```

**Implementation requirements:**

1. **FIELD_MAPPINGS dictionary:** Hardcode the complete dictionary from FIELD_MAPPINGS.md.
2. **identifyField(element, customFields):** Run each strategy in order:
   - Match by user-session corrections.
   - Match by `customFields` (profile-specific learned data).
   - Match by exact alias (Best-Match strategy to prevent collisions).
   - Match by fuzzy label (using Smart Fetching text).
3. **matchByCustomFields(element, customFields):**
   - Check if `element.label` (or fetched text) matches learned custom labels.
   - Use fuzzy/substring matching for phrasing variations.

3. **matchByName(element):** Get `element.getAttribute('name')`. Lowercase it. Check if any alias in FIELD_MAPPINGS is a substring of it. Confidence: 1.0 for exact match, 0.8 for substring.

4. **matchById(element):** Same logic but using `element.id`.

5. **matchByLabel(element):** 
   - Find `<label>` whose `for` attribute matches element's `id`
   - OR find `<label>` that is a parent/ancestor of the element
   - Get label's `textContent`, lowercase, trim
   - Check against aliases. Confidence: 0.9

6. **matchByPlaceholder(element):** Get `element.placeholder`. Confidence: 0.8

7. **matchByAriaLabel(element):** Get `element.getAttribute('aria-label')` or find element referenced by `aria-describedby`. Confidence: 0.7

8. **matchByNearbyText(element):**
   - Check parent element's `textContent`
   - Check previous sibling's `textContent` 
   - Check next sibling's `textContent`
   - Confidence: 0.5
   - Only return if the text is short (< 100 chars) to avoid false matches from page content

9. **fuzzyMatchOption(options, targetValue):**
   - For `<select>` dropdowns: given an array of `<option>` text values and a target value from the profile
   - Use the VALUES_MAP from FIELD_MAPPINGS.md
   - Try exact match first (confidence 1.0)
   - Then substring match (confidence 0.7)
   - Then value map lookup (confidence 0.8)
   - Return best match

10. **detectPlatform(url):** Check URL against known domain patterns. Return platform name string.

---

### File 8: `content.js`

**Reference:** ARCHITECTURE.md § 4 (pipeline), DATA_SCHEMA.md § 2 (messages), UI_SPEC.md § 4 (highlights)

**Must implement:**

```
// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'FILL_FORM':    handleFill(message.payload);     break;
    case 'CLEAR_FORM':   handleClear();                   break;
    case 'SCROLL_TO_FIELD': handleScroll(message.payload); break;
    case 'GET_PAGE_INFO': handlePageInfo(sendResponse);    break;
  }
  return true; // async response
});
```

**handleFill(payload) implementation:**

1. `const profile = payload.profile;`
2. `const platform = QuickApplyFieldMapper.detectPlatform(window.location.href);`
3. `const fields = discoverFields(document);` — walk DOM including shadow roots
4. `const results = [];`
5. For each field:
   a. `const match = QuickApplyFieldMapper.identifyField(field);`
   b. If no match → skip
   c. `const value = profile[match.profileField];`
   d. If no value in profile → push `{ status: 'skipped' }` to results
   e. Fill the field based on type:
      - `input[type=text/email/tel/url]` → use `setReactValue()` + `dispatchEvents()`
      - `select` → use `fuzzyMatchOption()` + set selectedIndex + dispatch change
      - `input[type=radio]` → find matching radio in same name group + click
      - `input[type=checkbox]` → set checked + dispatch change
      - `textarea` → set value + dispatch input
      - `[contenteditable]` → set innerText + dispatch input
   f. Apply visual highlight class based on confidence
   g. Push `FillResult` to results array
6. Handle CV upload: find file inputs, use `uploadCV()` from ARCHITECTURE.md § 4.5
7. Send `FILL_REPORT` message back
8. Set up auto-dismiss timer for highlights
9. Store `pendingProfile` for MutationObserver re-fills

**discoverFields(root) implementation:**
- See ARCHITECTURE.md § 4.2 for the exact recursive shadow DOM traversal code

**setReactValue(element, value) implementation:**
- See ARCHITECTURE.md § 4.3 for the React-specific setter code

**dispatchEvents(element) implementation:**
- See ARCHITECTURE.md § 4.3 for the event dispatch sequence

**uploadCV(fileInput, cvData, cvFileName) implementation:**
- See ARCHITECTURE.md § 4.5 for the complete implementation

**MutationObserver setup:**
- See ARCHITECTURE.md § 4.6 for the observer code

**handleClear() implementation:**
1. Find all elements with quickapply highlight classes
2. For each: reset value to empty, remove highlight classes
3. Send `CLEAR_REPORT` with count of cleared fields

**handleScroll(payload) implementation:**
1. `document.querySelector(payload.selector).scrollIntoView({ behavior: 'smooth', block: 'center' })`
2. Focus the element

**Visual highlight CSS injection:**
- On first message received, inject the CSS from UI_SPEC.md § 4.1 into the page as a `<style>` element

---

## Phase 4: Popup

### File 9: `popup/popup.html`

**Reference:** UI_SPEC.md § 2

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QuickApply</title>
  <link rel="stylesheet" href="popup.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
  <div id="popup-root">
    <!-- Header -->
    <header id="popup-header">
      <span class="logo">🚀 QuickApply</span>
      <button id="btn-settings" aria-label="Open Dashboard">⚙️</button>
    </header>
    
    <!-- State: Empty -->
    <div id="state-empty" class="hidden">
      <p>No clients yet.</p>
      <button id="btn-open-dashboard">Open Dashboard</button>
    </div>
    
    <!-- State: Client List -->
    <div id="state-list">
      <div id="search-container">
        <input type="text" id="search-input" placeholder="🔍 Search clients..." />
      </div>
      <div id="client-list"></div>
    </div>
    
    <!-- State: Review -->
    <div id="state-review" class="hidden">
      <button id="btn-back" aria-label="Back">◀ Back</button>
      <div id="review-client-info"></div>
      <div id="review-results"></div>
      <div id="review-summary"></div>
      <div id="review-actions">
        <button id="btn-edit">✏️ Edit</button>
        <button id="btn-refill">🔄 Re-fill</button>
        <button id="btn-clear">❌ Clear</button>
      </div>
      <p class="reminder">⚠️ Please review all fields before submitting manually</p>
    </div>
    
    <!-- Footer -->
    <footer id="popup-footer">
      <button id="btn-dashboard">📊 Dashboard</button>
    </footer>
  </div>
  
  <script src="../storage.js"></script>
  <script src="popup.js"></script>
</body>
</html>
```

---

### File 10: `popup/popup.css`

**Reference:** UI_SPEC.md § 1 (tokens), § 2 (layout, 400×500px)

**Requirements:**
- `body`: 400px wide, 500px max-height, overflow-y auto
- Dark theme matching dashboard colors
- Client cards: 64px tall, flex row, avatar circle + text + arrow
- Hover effects on cards: lighten background, scale arrow
- Search input: full width, left icon, dark background
- Review table: alternating row shading, status icons
- Summary bar: flex row with counts
- Action buttons: flex row, equal width, themed colors
- Transitions: all interactive elements have smooth transitions
- Hidden class: `display: none`

---

### File 11: `popup/popup.js`

**Reference:** UI_SPEC.md § 2.4 (interactions), DATA_SCHEMA.md § 2 (messages)

**Must implement:**

1. **On load:**
   - Load clients from storage
   - If no clients → show empty state
   - Else → render client list

2. **renderClientList(clients):**
   - For each client, create a card with avatar (initials + color), name, email, apply arrow
   - Attach click handler to each card

3. **Search filtering:**
   - On input, filter clients by name (case-insensitive contains)
   - Re-render filtered list

4. **Client click (Apply):**
   - Get active tab via `chrome.tabs.query({ active: true, currentWindow: true })`
   - Send `FILL_FORM` message to background: `chrome.runtime.sendMessage({ type: 'FILL_FORM', payload: { clientId, profile } })`
   - Show loading state on the card

5. **Receive FILL_REPORT:**
   - Listen via `chrome.runtime.onMessage.addListener`
   - Switch to Review state
   - Render results table with status icons
   - Render summary bar (filled/fuzzy/error counts)

6. **Review actions:**
   - "Edit" → send `SCROLL_TO_FIELD` with first error/fuzzy field's selector
   - "Re-fill" → switch back to Client List state
   - "Clear" → send `CLEAR_FORM` → switch back to Client List

7. **Dashboard button:** `chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') })`

8. **Settings button:** Same as Dashboard

---

## Phase 5: Background

### File 12: `background.js`

**Reference:** ARCHITECTURE.md § 2.1, DATA_SCHEMA.md § 2.1 (messages)

**Must implement:**

1. **onInstalled:**
   ```javascript
   chrome.runtime.onInstalled.addListener((details) => {
     if (details.reason === 'install') {
       chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
     }
   });
   ```

2. **Message router:**
   ```javascript
   chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
     // Messages FROM popup → forward to content script in active tab
     if (message.type === 'FILL_FORM' || message.type === 'CLEAR_FORM' || message.type === 'SCROLL_TO_FIELD' || message.type === 'GET_PAGE_INFO') {
       chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
         if (tabs[0]) {
           chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
             sendResponse(response);
           });
         }
       });
       return true; // async
     }
     
     // Messages FROM content script → forward to popup
     // (These are typically sent directly, background just relays)
   });
   ```

3. **Badge updates:**
   - On receiving FILL_REPORT, update badge: `chrome.action.setBadgeText({ text: filledCount.toString() })`
   - Set badge color based on status: green if all filled, yellow if fuzzy, red if errors

---

---

## Phase 7: Intelligence Layer

### File 14: `learning-engine.js`

**Reference:** ARCHITECTURE.md § 4.4, DATA_SCHEMA.md § 1.4

**Must implement:**
```javascript
window.QuickApplyLearning = {
  saveCorrection(correction)      → Promise<void>
  getCorrections(domain)          → Promise<CorrectionEntry[]>
  registerField(fieldPattern)     → Promise<void> // Universal Registry
  learnCustomField(...)           → Promise<void> // Profile Update
}
```

**Implementation requirements:**
1. **Universal Registry**: Maintain a `quickapply_registry` in `storage.local` that aggregates learned field patterns cross-client.
2. **Correction Lock**: Prioritize session-level manual corrections during auto-fill to ensure user fixes are never overwritten.
3. **Smart Fetching Interface**: Provide hooks for `content.js` to trigger "learning" when a new custom field is discovered via nearby text.

A local HTML page that simulates a job application form with diverse field types:

**Must include:**
- Text inputs with various `name`/`id` patterns (first_name, fname, firstName)
- Email and phone inputs
- `<select>` dropdowns for gender, ethnicity, education level, country, state
- Radio buttons for veteran status, disability, willing to relocate
- Checkboxes for employment type
- `<textarea>` for skills
- `<input type="file">` for resume upload
- A second `<input type="file">` for cover letter (should NOT be auto-filled with CV)
- A `<label>` connected input and an input with only `aria-label`
- An input with only `placeholder` for identification
- A custom dropdown (div-based, not `<select>`) for work authorization
- Some unrelated fields (e.g., "Referral code") that should NOT be filled
- A "Submit" button (to verify it's never auto-clicked)
- Styled to look like a real job portal form

---

## Phase 7: Documentation

### File 14: `README.md`

Standard README with:
- Project name, description, screenshot placeholder
- Installation: Load in Chrome dev mode
- Usage: Add clients → open job page → click extension → select client → review → submit
- File structure overview
- Development guide
- License (MIT)

---

## Verification Checklist

After all files are built, verify:

- [ ] Extension loads in Chrome without errors (`chrome://extensions` → Load Unpacked)
- [ ] Dashboard opens on first install
- [ ] Can add a client with all fields + CV
- [ ] Client appears in popup list
- [ ] Can search/filter clients in popup
- [ ] Clicking a client fills the test form correctly
- [ ] Text inputs, selects, radios, checkboxes all filled
- [ ] CV uploaded to file input
- [ ] Visual highlights appear (green, yellow, red)
- [ ] Review panel shows correct results
- [ ] "Edit" scrolls to flagged field
- [ ] "Re-fill" allows switching clients
- [ ] "Clear" resets the form
- [ ] Form submit button is never auto-clicked
- [ ] Can edit and delete clients in dashboard
- [ ] Export/Import works
- [ ] No console errors
- [ ] Works in iframes (test with nested iframe form)
