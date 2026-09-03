# QuickApply — UI/UX Specification

**Version:** 2.0  
**Date:** 2026-03-06  
**Design Language:** Glassmorphism Dark — frosted glass panels, smooth gradients, bold typography, fluid micro-animations

---

## 1. Design Philosophy

### 2026 Extension Design Principles
1. **Glassmorphism** — Frosted glass cards with `backdrop-filter: blur()`, semi-transparent backgrounds, subtle luminous borders
2. **Deep Dark Mode** — Rich dark gradients (not flat black), layered depth through opacity
3. **Bold Typography** — Large headings, generous letter-spacing, font-weight contrast
4. **Micro-Animations** — Every interaction has a subtle, fast response (scale, glow, slide)
5. **Smooth Scrolling** — Buttery scroll with momentum, custom thin scrollbars, scroll-snap for sections
6. **Whitespace-Driven** — Generous padding, breathing room, no cramped layouts
7. **Status-Driven Color** — Green/Yellow/Red for instant comprehension, used sparingly

---

## 2. Design Tokens (CSS Custom Properties)

Every component MUST use these tokens. No hardcoded values anywhere.

### 2.1 Color Palette

```css
:root {
  /* === Background Layers (darkest → lightest) === */
  --bg-base:             #0B0D17;          /* Deepest background */
  --bg-surface:          #111425;          /* Main surface / sidebar */
  --bg-elevated:         #1A1D35;          /* Cards, elevated panels */
  --bg-glass:            rgba(30, 33, 58, 0.65);  /* Glassmorphism panels */
  --bg-glass-hover:      rgba(40, 44, 72, 0.75);  /* Glass hover state */
  --bg-input:            rgba(15, 17, 30, 0.8);   /* Input fields */
  --bg-input-focus:      rgba(20, 22, 40, 0.9);   /* Input focused */

  /* === Accent / Brand === */
  --accent-primary:      #7C6AFF;          /* Main purple — buttons, links, focus rings */
  --accent-primary-hover:#6B59E8;          /* Hover state */
  --accent-primary-glow: rgba(124, 106, 255, 0.25); /* Glow/shadow for buttons */
  --accent-gradient:     linear-gradient(135deg, #7C6AFF 0%, #5B8DEF 100%);  /* Purple→Blue gradient */
  --accent-gradient-hover: linear-gradient(135deg, #6B59E8 0%, #4A7CE0 100%);

  /* === Status === */
  --status-success:      #34D399;          /* Filled — green */
  --status-success-bg:   rgba(52, 211, 153, 0.12);
  --status-success-glow: rgba(52, 211, 153, 0.25);
  --status-warning:      #FBBF24;          /* Fuzzy — yellow */
  --status-warning-bg:   rgba(251, 191, 36, 0.12);
  --status-warning-glow: rgba(251, 191, 36, 0.25);
  --status-error:        #F87171;          /* Error — red */
  --status-error-bg:     rgba(248, 113, 113, 0.12);
  --status-error-glow:   rgba(248, 113, 113, 0.25);
  --status-info:         #60A5FA;          /* Info — blue */
  --status-info-bg:      rgba(96, 165, 250, 0.12);

  /* === Text === */
  --text-primary:        #F1F1F6;          /* Headings, primary content */
  --text-secondary:      #9CA3C2;          /* Descriptions, subtitles */
  --text-muted:          #5C6186;          /* Placeholders, disabled */
  --text-on-accent:      #FFFFFF;          /* Text on accent-colored bg */

  /* === Borders === */
  --border-subtle:       rgba(255, 255, 255, 0.06);  /* Card borders */
  --border-default:      rgba(255, 255, 255, 0.10);  /* Input borders */
  --border-focus:        rgba(124, 106, 255, 0.5);   /* Focus ring */
  --border-glass:        rgba(255, 255, 255, 0.08);  /* Glassmorphism edge highlight */

  /* === Avatar Ring Colors (10 colors, auto-assigned per client) === */
  --avatar-1:  #F87171;  /* Red */
  --avatar-2:  #34D399;  /* Green */
  --avatar-3:  #7C6AFF;  /* Purple */
  --avatar-4:  #FBBF24;  /* Yellow */
  --avatar-5:  #60A5FA;  /* Blue */
  --avatar-6:  #F472B6;  /* Pink */
  --avatar-7:  #2DD4BF;  /* Teal */
  --avatar-8:  #C084FC;  /* Lavender */
  --avatar-9:  #FB923C;  /* Orange */
  --avatar-10: #A3E635;  /* Lime */
}
```

### 2.2 Typography

```css
:root {
  --font-family:         'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Sizes */
  --text-2xs:            10px;
  --text-xs:             11px;
  --text-sm:             12px;
  --text-base:           13px;    /* Default body text — slightly smaller for extension compactness */
  --text-md:             14px;
  --text-lg:             16px;
  --text-xl:             18px;
  --text-2xl:            22px;
  --text-3xl:            28px;

  /* Weights */
  --weight-normal:       400;
  --weight-medium:       500;
  --weight-semibold:     600;
  --weight-bold:         700;

  /* Line Heights */
  --leading-tight:       1.2;
  --leading-normal:      1.5;
  --leading-relaxed:     1.7;

  /* Letter Spacing */
  --tracking-tight:      -0.02em; /* Headings */
  --tracking-normal:     0;
  --tracking-wide:       0.04em;  /* Labels, uppercase text */
  --tracking-widest:     0.08em;  /* Small caps */
}
```

### 2.3 Spacing Scale (8px base)

```css
:root {
  --space-1:   4px;
  --space-2:   8px;
  --space-3:   12px;
  --space-4:   16px;
  --space-5:   20px;
  --space-6:   24px;
  --space-7:   28px;
  --space-8:   32px;
  --space-10:  40px;
  --space-12:  48px;
  --space-16:  64px;
}
```

### 2.4 Border Radius

```css
:root {
  --radius-sm:   6px;
  --radius-md:   10px;
  --radius-lg:   14px;
  --radius-xl:   18px;
  --radius-2xl:  24px;
  --radius-full: 9999px;    /* Pill buttons, avatar circles */
}
```

### 2.5 Shadows & Effects

```css
:root {
  /* Elevation shadows */
  --shadow-sm:     0 2px 8px rgba(0, 0, 0, 0.25);
  --shadow-md:     0 4px 16px rgba(0, 0, 0, 0.35);
  --shadow-lg:     0 8px 32px rgba(0, 0, 0, 0.45);
  --shadow-xl:     0 16px 48px rgba(0, 0, 0, 0.55);

  /* Glow shadows (for buttons, focused elements) */
  --glow-accent:   0 0 20px var(--accent-primary-glow);
  --glow-success:  0 0 16px var(--status-success-glow);
  --glow-warning:  0 0 16px var(--status-warning-glow);
  --glow-error:    0 0 16px var(--status-error-glow);

  /* Glassmorphism */
  --glass-blur:    blur(20px);
  --glass-border:  1px solid var(--border-glass);
  --glass-shadow:  0 8px 32px rgba(0, 0, 0, 0.3);
}
```

### 2.6 Transitions & Animations

```css
:root {
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);      /* Snappy out */
  --ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);   /* Bouncy spring */
  --ease-smooth:   cubic-bezier(0.4, 0, 0.2, 1);        /* Material-like */

  --duration-fast:    120ms;
  --duration-normal:  200ms;
  --duration-slow:    350ms;
  --duration-enter:   400ms;
  --duration-exit:    250ms;
}
```

---

## 3. Popup UI — Detailed Specification

**Dimensions:** 380px wide × 520px max height  
**Overflow:** `overflow-y: auto` with custom scrollbar  
**Border Radius:** `var(--radius-xl)` on body (Chrome rounds popup corners)

### 3.1 Component Hierarchy

```
popup-root
├── popup-header
│   ├── logo-icon (SVG, 22px)
│   ├── logo-text ("QuickApply")
│   └── gear-button (opens dashboard)
│
├── state-empty (shown when 0 clients)
│   ├── empty-illustration (SVG, 120×120)
│   ├── empty-title ("No Clients Yet")
│   ├── empty-subtitle ("Add your first client to get started")
│   └── btn-open-dashboard ("Open Dashboard" — gradient button)
│
├── state-list (shown when ≥1 clients)
│   ├── search-container
│   │   ├── search-icon (magnifier SVG, 14px, muted)
│   │   ├── search-input (placeholder: "Search clients...")
│   │   └── search-clear (× button, visible when input has text)
│   │
│   ├── client-scroll-container (scrollable, max-height: 360px)
│   │   └── client-card (repeated for each client)
│   │       ├── avatar-circle (36px, initials, colored ring)
│   │       ├── client-info
│   │       │   ├── client-name (font: semibold, text-md)
│   │       │   └── client-email (font: normal, text-sm, secondary color)
│   │       └── apply-arrow (→ icon, 20px, muted → accent on hover)
│   │
│   └── list-footer
│       ├── client-count ("8 clients")
│       └── btn-dashboard ("Dashboard →")
│
├── state-filling (transient, shown during auto-fill)
│   ├── filling-spinner (animated ring, 48px)
│   ├── filling-text ("Filling form...")
│   └── filling-progress ("5 / 12 fields")
│
└── state-review (shown after fill completes)
    ├── review-header
    │   ├── btn-back ("← Back")
    │   └── review-title ("Fill Report")
    │
    ├── review-client-badge
    │   ├── avatar-circle (28px)
    │   ├── client-name
    │   └── platform-badge ("Workday" / "Greenhouse" / etc.)
    │
    ├── review-summary-bar
    │   ├── stat-filled ("8 Filled" + green dot)
    │   ├── stat-fuzzy ("2 Fuzzy" + yellow dot)
    │   └── stat-missed ("1 Missed" + red dot)
    │
    ├── review-results-scroll (scrollable, max-height: 260px)
    │   └── review-row (repeated)
    │       ├── status-icon (✅ / ⚠️ / ❌, 16px)
    │       ├── field-label ("First Name")
    │       ├── field-value ("Ali" — truncated with ellipsis if long)
    │       └── confidence-pill (only for fuzzy: "72%" in yellow pill)
    │
    ├── review-actions
    │   ├── btn-edit ("✏️ Edit on Page" — outline button)
    │   ├── btn-refill ("🔄 Re-fill" — outline button)
    │   └── btn-clear ("Clear All" — ghost button, red text)
    │
    └── review-reminder
        └── reminder-text ("⚠️ Review all fields, then submit manually")
```

### 3.2 Pixel-Precise Layout Rules

```
POPUP BODY:
  width: 380px
  background: var(--bg-base)
  padding: 0
  font-family: var(--font-family)

HEADER (popup-header):
  height: 52px
  padding: 0 var(--space-4)
  display: flex
  align-items: center
  justify-content: space-between
  border-bottom: 1px solid var(--border-subtle)
  background: var(--bg-surface)

  logo-icon: 22×22px, fill: var(--accent-primary)
  logo-text: var(--text-lg), var(--weight-bold), var(--text-primary), margin-left: var(--space-2)
  gear-button: 32×32px, border-radius: var(--radius-md), background: transparent
    hover: background: var(--bg-glass-hover)

SEARCH CONTAINER:
  margin: var(--space-3) var(--space-4)
  position: relative

  search-input:
    width: 100%
    height: 40px
    padding: 0 var(--space-4) 0 36px   /* left padding for icon */
    background: var(--bg-input)
    border: 1px solid var(--border-default)
    border-radius: var(--radius-full)
    color: var(--text-primary)
    font-size: var(--text-base)
    outline: none
    transition: border-color var(--duration-normal) var(--ease-smooth),
                background var(--duration-normal) var(--ease-smooth)

    &:focus:
      border-color: var(--border-focus)
      background: var(--bg-input-focus)
      box-shadow: var(--glow-accent)

  search-icon:
    position: absolute
    left: 12px
    top: 50%
    transform: translateY(-50%)
    width: 14px
    color: var(--text-muted)

CLIENT CARD:
  display: flex
  align-items: center
  gap: var(--space-3)
  padding: var(--space-3) var(--space-4)
  margin: 0 var(--space-2)
  border-radius: var(--radius-lg)
  cursor: pointer
  transition: background var(--duration-fast) var(--ease-smooth),
              transform var(--duration-fast) var(--ease-spring)

  &:hover:
    background: var(--bg-glass)
    backdrop-filter: var(--glass-blur)
    transform: translateX(4px)

  &:active:
    transform: translateX(2px) scale(0.99)

  avatar-circle:
    width: 36px
    height: 36px
    border-radius: var(--radius-full)
    background: var(--bg-elevated)
    border: 2px solid var(--avatar-N)   /* N = client index mod 10 */
    display: flex
    align-items: center
    justify-content: center
    font-size: var(--text-sm)
    font-weight: var(--weight-bold)
    color: var(--avatar-N)
    flex-shrink: 0

  client-name:
    font-size: var(--text-md)
    font-weight: var(--weight-semibold)
    color: var(--text-primary)
    white-space: nowrap
    overflow: hidden
    text-overflow: ellipsis
    max-width: 200px

  client-email:
    font-size: var(--text-xs)
    color: var(--text-secondary)
    white-space: nowrap
    overflow: hidden
    text-overflow: ellipsis
    max-width: 200px

  apply-arrow:
    margin-left: auto
    width: 20px
    height: 20px
    color: var(--text-muted)
    flex-shrink: 0
    transition: color var(--duration-fast), transform var(--duration-fast) var(--ease-spring)

    card:hover &:
      color: var(--accent-primary)
      transform: translateX(3px)

CLIENT SCROLL CONTAINER:
  max-height: 360px
  overflow-y: auto
  scroll-behavior: smooth
  padding-bottom: var(--space-2)

  /* Custom scrollbar */
  &::-webkit-scrollbar:
    width: 5px
  &::-webkit-scrollbar-track:
    background: transparent
  &::-webkit-scrollbar-thumb:
    background: var(--border-default)
    border-radius: var(--radius-full)
  &::-webkit-scrollbar-thumb:hover:
    background: var(--text-muted)
```

### 3.3 Review State Layout

```
REVIEW HEADER:
  display: flex
  align-items: center
  padding: var(--space-3) var(--space-4)
  border-bottom: 1px solid var(--border-subtle)

  btn-back:
    font-size: var(--text-sm)
    color: var(--text-secondary)
    background: none
    border: none
    cursor: pointer
    padding: var(--space-1) var(--space-2)
    border-radius: var(--radius-sm)
    &:hover: color: var(--text-primary), background: var(--bg-glass)

REVIEW CLIENT BADGE:
  display: flex
  align-items: center
  gap: var(--space-3)
  padding: var(--space-3) var(--space-4)
  background: var(--bg-glass)
  backdrop-filter: var(--glass-blur)
  margin: var(--space-3) var(--space-4)
  border-radius: var(--radius-lg)
  border: var(--glass-border)

  platform-badge:
    margin-left: auto
    font-size: var(--text-2xs)
    font-weight: var(--weight-medium)
    letter-spacing: var(--tracking-wide)
    text-transform: uppercase
    color: var(--accent-primary)
    background: rgba(124, 106, 255, 0.12)
    padding: 2px 8px
    border-radius: var(--radius-full)

SUMMARY BAR:
  display: flex
  gap: var(--space-3)
  padding: var(--space-2) var(--space-4)
  margin: 0 var(--space-4)

  stat:
    display: flex
    align-items: center
    gap: var(--space-1)
    font-size: var(--text-xs)
    font-weight: var(--weight-medium)

  stat-dot:
    width: 6px
    height: 6px
    border-radius: var(--radius-full)
    /* color per status */

REVIEW ROW:
  display: flex
  align-items: center
  gap: var(--space-3)
  padding: var(--space-2) var(--space-4)
  border-bottom: 1px solid var(--border-subtle)
  transition: background var(--duration-fast)
  cursor: pointer    /* clicks scroll to field on page */

  &:hover:
    background: var(--bg-glass)

  status-icon: 16px, flex-shrink: 0
  field-label: var(--text-sm), var(--text-secondary), width: 120px, flex-shrink: 0
  field-value: var(--text-sm), var(--text-primary), flex: 1, overflow: ellipsis
  confidence-pill:
    font-size: var(--text-2xs)
    padding: 1px 6px
    border-radius: var(--radius-full)
    background: var(--status-warning-bg)
    color: var(--status-warning)

REVIEW ACTIONS:
  display: flex
  gap: var(--space-2)
  padding: var(--space-3) var(--space-4)

  btn-edit, btn-refill:
    flex: 1
    height: 36px
    font-size: var(--text-sm)
    font-weight: var(--weight-medium)
    border: 1px solid var(--border-default)
    border-radius: var(--radius-md)
    background: transparent
    color: var(--text-primary)
    cursor: pointer
    transition: all var(--duration-normal) var(--ease-smooth)
    &:hover: border-color: var(--accent-primary), color: var(--accent-primary), background: rgba(124,106,255,0.08)

  btn-clear:
    height: 36px
    padding: 0 var(--space-3)
    font-size: var(--text-sm)
    border: none
    background: transparent
    color: var(--status-error)
    cursor: pointer
    &:hover: background: var(--status-error-bg)
    border-radius: var(--radius-md)

REVIEW REMINDER:
  padding: var(--space-2) var(--space-4) var(--space-4)
  text-align: center
  font-size: var(--text-xs)
  color: var(--status-warning)
  opacity: 0.8
```

### 3.4 Filling State (Transient)

```
STATE-FILLING:
  display: flex
  flex-direction: column
  align-items: center
  justify-content: center
  height: 300px
  gap: var(--space-4)

  filling-spinner:
    width: 48px
    height: 48px
    border: 3px solid var(--border-default)
    border-top-color: var(--accent-primary)
    border-radius: var(--radius-full)
    animation: spin 800ms linear infinite

  filling-text:
    font-size: var(--text-lg)
    font-weight: var(--weight-semibold)
    color: var(--text-primary)

  filling-progress:
    font-size: var(--text-sm)
    color: var(--text-secondary)

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

---

## 4. Dashboard UI — Detailed Specification

**Layout:** Full browser tab, minimum 900px wide  
**Structure:** Fixed sidebar (300px) + scrollable main content area  
**Background:** Subtle gradient (`var(--bg-base)` → slightly lighter at bottom-right)

### 4.0 Current Dashboard Polish

The implemented dashboard uses a restrained productivity-tool treatment:

- Header actions are grouped by profile data, learning memory, and diagnostics/settings.
- Buttons may declare `data-icon`; `dashboard.js` injects compact inline SVG icons and preserves them through loading states.
- Long-running dashboard actions use disabled loading states with an inline spinner.
- Settings use a four-tab modal: AI, Password, Fill, and Data.
- Learning tables include a search box, confidence filter, scroll containers, sticky headers, row hover states, confidence/use badges, and richer empty rows.
- Destructive actions use subdued danger styling until hover/focus so the interface is not dominated by red buttons.
- Keyboard focus uses visible focus rings across controls.

### 4.1 Component Hierarchy

```
dashboard-root
├── dashboard-header (sticky, top 0)
│   ├── logo ("🚀 QuickApply Dashboard")
│   └── header-actions
│       ├── btn-import ("📥 Import" — outline)
│       ├── btn-export ("📤 Export" — outline)
│       └── storage-indicator ("12.4 MB used")
│
├── dashboard-body (flex row)
│   ├── sidebar (300px, fixed, full height)
│   │   ├── sidebar-search
│   │   │   ├── search-icon
│   │   │   └── search-input
│   │   │
│   │   ├── client-list (scrollable, flex: 1)
│   │   │   └── sidebar-client-card (repeated)
│   │   │       ├── avatar-circle (40px)
│   │   │       ├── card-info
│   │   │       │   ├── card-name
│   │   │       │   └── card-email
│   │   │       └── card-status (green dot if complete, yellow if partial)
│   │   │
│   │   └── sidebar-footer
│   │       ├── btn-add-client ("+ Add Client" — gradient, full width)
│   │       └── client-count ("8 clients")
│   │
│   └── main-content (flex: 1, scrollable, padded)
│       ├── empty-state (shown when no client selected)
│       │   ├── empty-icon (large, muted)
│       │   └── empty-text ("Select a client or add a new one")
│       │
│       └── client-form (shown when client selected)
│           ├── form-header
│           │   ├── large-avatar (56px)
│           │   ├── client-name-title (text-2xl, editable feel)
│           │   └── last-updated ("Updated 2 hours ago")
│           │
│           ├── form-section (repeated for each section)
│           │   ├── section-header (clickable, expand/collapse)
│           │   │   ├── section-icon (emoji)
│           │   │   ├── section-title
│           │   │   ├── section-completion ("4/6 filled" — in pill)
│           │   │   └── chevron (▼ / ▶, rotates on toggle)
│           │   │
│           │   └── section-body (collapsible with smooth animation)
│           │       └── form-row (repeated)
│           │           ├── form-label
│           │           └── form-input / form-select / form-textarea
│           │
│           ├── section: Resume/CV
│           │   ├── file-dropzone
│           │   │   ├── drop-icon (cloud-upload SVG, 40px)
│           │   │   ├── drop-text ("Drag & drop or click to upload")
│           │   │   ├── drop-hint ("PDF or DOCX, max 5MB")
│           │   │   └── hidden-file-input
│           │   └── current-file-display (if file exists)
│           │       ├── file-icon (📄)
│           │       ├── file-name
│           │       ├── file-size
│           │       └── btn-remove-file (×)
│           │
│           ├── section: Custom Fields
│           │   └── custom-field-row (dynamic, repeatable)
│           │       ├── input-label
│           │       ├── input-value
│           │       ├── input-aliases
│           │       ├── btn-remove-row (×)
│           │       └── btn-add-row ("+ Add Field")
│           │
│           └── form-actions (sticky bottom bar)
│               ├── btn-save ("💾 Save Client" — gradient, primary)
│               ├── btn-duplicate ("📋 Duplicate" — outline)
│               └── btn-delete ("🗑️ Delete" — ghost, red)
│
└── toast-container (fixed, top-right)
    └── toast (slides in from right)
        ├── toast-icon
        ├── toast-message
        └── toast-close (×)
```

### 4.2 Pixel-Precise Layout Rules

```
DASHBOARD ROOT:
  width: 100vw
  min-height: 100vh
  background: var(--bg-base)
  background-image: radial-gradient(
    ellipse at 80% 20%,
    rgba(124, 106, 255, 0.04) 0%,
    transparent 50%
  );
  font-family: var(--font-family)
  color: var(--text-primary)

DASHBOARD HEADER:
  position: sticky
  top: 0
  z-index: 100
  height: 60px
  padding: 0 var(--space-6)
  display: flex
  align-items: center
  justify-content: space-between
  background: var(--bg-surface)
  border-bottom: 1px solid var(--border-subtle)
  backdrop-filter: blur(12px)

  logo:
    font-size: var(--text-xl)
    font-weight: var(--weight-bold)
    letter-spacing: var(--tracking-tight)
    background: var(--accent-gradient)
    -webkit-background-clip: text
    -webkit-text-fill-color: transparent

  header-actions:
    display: flex
    gap: var(--space-3)
    align-items: center

  storage-indicator:
    font-size: var(--text-xs)
    color: var(--text-muted)
    padding: var(--space-1) var(--space-3)
    background: var(--bg-glass)
    border-radius: var(--radius-full)
    border: var(--glass-border)

SIDEBAR:
  width: 300px
  height: calc(100vh - 60px)
  position: fixed
  left: 0
  top: 60px
  background: var(--bg-surface)
  border-right: 1px solid var(--border-subtle)
  display: flex
  flex-direction: column
  overflow: hidden

  sidebar-search:
    padding: var(--space-4)

    search-input:
      width: 100%
      height: 40px
      padding: 0 var(--space-4) 0 36px
      background: var(--bg-input)
      border: 1px solid var(--border-default)
      border-radius: var(--radius-lg)
      color: var(--text-primary)
      font-size: var(--text-base)
      &:focus: border-color: var(--border-focus), box-shadow: var(--glow-accent)

  client-list:
    flex: 1
    overflow-y: auto
    padding: 0 var(--space-2)
    scroll-behavior: smooth

  sidebar-client-card:
    display: flex
    align-items: center
    gap: var(--space-3)
    padding: var(--space-3)
    margin-bottom: var(--space-1)
    border-radius: var(--radius-lg)
    cursor: pointer
    transition: all var(--duration-normal) var(--ease-smooth)

    &:hover:
      background: var(--bg-glass)
      backdrop-filter: var(--glass-blur)

    &.active:
      background: rgba(124, 106, 255, 0.12)
      border: 1px solid rgba(124, 106, 255, 0.2)

    avatar-circle: 40px (same as popup but larger)

    card-status:
      width: 8px
      height: 8px
      border-radius: var(--radius-full)
      margin-left: auto
      /* green if all required fields filled, yellow if partial */

  sidebar-footer:
    padding: var(--space-4)
    border-top: 1px solid var(--border-subtle)

    btn-add-client:
      width: 100%
      height: 44px
      background: var(--accent-gradient)
      border: none
      border-radius: var(--radius-lg)
      color: var(--text-on-accent)
      font-size: var(--text-md)
      font-weight: var(--weight-semibold)
      cursor: pointer
      transition: all var(--duration-normal) var(--ease-smooth)
      &:hover: background: var(--accent-gradient-hover), box-shadow: var(--glow-accent), transform: translateY(-1px)
      &:active: transform: translateY(0)

MAIN CONTENT:
  margin-left: 300px
  padding: var(--space-8) var(--space-10)
  min-height: calc(100vh - 60px)
  overflow-y: auto
  scroll-behavior: smooth
  max-width: 800px

FORM HEADER:
  display: flex
  align-items: center
  gap: var(--space-5)
  margin-bottom: var(--space-8)

  large-avatar:
    width: 56px
    height: 56px
    border-radius: var(--radius-full)
    /* same style as popup avatar but bigger */

  client-name-title:
    font-size: var(--text-2xl)
    font-weight: var(--weight-bold)
    letter-spacing: var(--tracking-tight)

  last-updated:
    font-size: var(--text-xs)
    color: var(--text-muted)

FORM SECTION:
  background: var(--bg-glass)
  backdrop-filter: var(--glass-blur)
  border: var(--glass-border)
  border-radius: var(--radius-xl)
  margin-bottom: var(--space-5)
  overflow: hidden
  box-shadow: var(--shadow-sm)
  transition: box-shadow var(--duration-normal)

  &:hover:
    box-shadow: var(--shadow-md)

  section-header:
    display: flex
    align-items: center
    gap: var(--space-3)
    padding: var(--space-4) var(--space-5)
    cursor: pointer
    user-select: none
    transition: background var(--duration-fast)

    &:hover: background: var(--bg-glass-hover)

    section-icon: font-size: var(--text-lg)
    section-title: font-size: var(--text-md), font-weight: var(--weight-semibold)

    section-completion:
      margin-left: auto
      font-size: var(--text-2xs)
      color: var(--text-muted)
      background: var(--bg-input)
      padding: 2px 8px
      border-radius: var(--radius-full)

    chevron:
      width: 16px
      color: var(--text-muted)
      transition: transform var(--duration-normal) var(--ease-spring)
      &.open: transform: rotate(180deg)

  section-body:
    padding: 0 var(--space-5) var(--space-5)
    display: grid
    grid-template-columns: 1fr 1fr     /* 2-column grid for fields */
    gap: var(--space-4)
    /* Collapse animation: max-height + opacity */
    overflow: hidden
    transition: max-height var(--duration-slow) var(--ease-out),
                opacity var(--duration-normal) var(--ease-smooth),
                padding var(--duration-slow) var(--ease-out)
    &.collapsed:
      max-height: 0
      opacity: 0
      padding-top: 0
      padding-bottom: 0

FORM ROW (inside section-body grid):
  display: flex
  flex-direction: column
  gap: var(--space-1)

  &.full-width:
    grid-column: 1 / -1

  form-label:
    font-size: var(--text-xs)
    font-weight: var(--weight-medium)
    color: var(--text-secondary)
    letter-spacing: var(--tracking-wide)
    text-transform: uppercase

  form-input, form-select:
    height: 40px
    padding: 0 var(--space-3)
    background: var(--bg-input)
    border: 1px solid var(--border-default)
    border-radius: var(--radius-md)
    color: var(--text-primary)
    font-size: var(--text-base)
    font-family: var(--font-family)
    outline: none
    transition: border-color var(--duration-normal), box-shadow var(--duration-normal), background var(--duration-normal)

    &:focus:
      border-color: var(--border-focus)
      background: var(--bg-input-focus)
      box-shadow: 0 0 0 3px var(--accent-primary-glow)

    &::placeholder:
      color: var(--text-muted)

  form-textarea:
    min-height: 80px
    padding: var(--space-3)
    resize: vertical
    /* Same styles as form-input */

  form-select:
    appearance: none
    background-image: url('data:image/svg+xml,...chevron-svg...')
    background-repeat: no-repeat
    background-position: right 12px center
    background-size: 12px
    padding-right: 32px

FILE DROPZONE:
  grid-column: 1 / -1
  border: 2px dashed var(--border-default)
  border-radius: var(--radius-xl)
  padding: var(--space-8)
  display: flex
  flex-direction: column
  align-items: center
  gap: var(--space-3)
  cursor: pointer
  transition: all var(--duration-normal) var(--ease-smooth)

  &:hover:
    border-color: var(--accent-primary)
    background: rgba(124, 106, 255, 0.04)

  &.drag-over:
    border-color: var(--accent-primary)
    background: rgba(124, 106, 255, 0.08)
    border-style: solid
    box-shadow: var(--glow-accent)

  drop-icon:
    width: 40px
    height: 40px
    color: var(--text-muted)

  drop-text:
    font-size: var(--text-md)
    font-weight: var(--weight-medium)
    color: var(--text-primary)

  drop-hint:
    font-size: var(--text-xs)
    color: var(--text-muted)

CURRENT FILE DISPLAY:
  grid-column: 1 / -1
  display: flex
  align-items: center
  gap: var(--space-3)
  padding: var(--space-3) var(--space-4)
  background: var(--bg-elevated)
  border-radius: var(--radius-lg)
  border: 1px solid var(--border-subtle)

  file-icon: 20px, color: var(--accent-primary)
  file-name: var(--text-sm), var(--weight-medium), var(--text-primary)
  file-size: var(--text-xs), var(--text-muted)
  btn-remove: margin-left: auto, 24x24, border-radius: var(--radius-sm)
    color: var(--text-muted), &:hover: color: var(--status-error), background: var(--status-error-bg)

FORM ACTIONS (sticky bar):
  position: sticky
  bottom: 0
  background: var(--bg-surface)
  border-top: 1px solid var(--border-subtle)
  padding: var(--space-4)
  display: flex
  gap: var(--space-3)
  backdrop-filter: blur(12px)
  margin: var(--space-8) calc(-1 * var(--space-10)) 0
  padding: var(--space-4) var(--space-10)

  btn-save:
    flex: 1
    height: 44px
    background: var(--accent-gradient)
    border: none
    border-radius: var(--radius-lg)
    color: var(--text-on-accent)
    font-size: var(--text-md)
    font-weight: var(--weight-semibold)
    cursor: pointer
    transition: all var(--duration-normal) var(--ease-smooth)
    &:hover: box-shadow: var(--glow-accent), transform: translateY(-1px)
    &:active: transform: translateY(0)

  btn-duplicate:
    height: 44px
    padding: 0 var(--space-5)
    border: 1px solid var(--border-default)
    border-radius: var(--radius-lg)
    background: transparent
    color: var(--text-primary)
    font-size: var(--text-sm)
    cursor: pointer
    &:hover: border-color: var(--accent-primary), color: var(--accent-primary)

  btn-delete:
    height: 44px
    padding: 0 var(--space-5)
    border: none
    border-radius: var(--radius-lg)
    background: transparent
    color: var(--status-error)
    font-size: var(--text-sm)
    cursor: pointer
    &:hover: background: var(--status-error-bg)
```

### 4.3 Form Sections — Field Grouping

| # | Section | Icon | Fields | Grid Layout |
|---|---|---|---|---|
| 1 | Personal Info | 👤 | firstName, lastName, middleName, preferredName | 2-col |
| 2 | Contact | 📞 | email, phone, alternateEmail, alternatePhone | 2-col |
| 3 | Address | 📍 | streetAddress (full), addressLine2 (full), city, state, zipCode, country | 2-col, first 2 full-width |
| 4 | Demographics | 🌍 | gender, ethnicity, veteranStatus, disabilityStatus | 2-col (all selects) |
| 5 | Professional | 💼 | currentJobTitle, currentCompany, yearsOfExperience, linkedIn, portfolio, github | 2-col |
| 6 | Education | 🎓 | highestEducation, university, major, graduationYear, gpa | 2-col |
| 7 | Skills | 🔧 | skills (textarea, full), certifications (full), languages (full) | 1-col all |
| 8 | Work Preferences | ⚙️ | workAuthorization, willingToRelocate, expectedSalary, salaryCurrency, noticePeriod, desiredEmploymentType, remotePreference | 2-col |
| 9 | Resume / CV | 📄 | File dropzone + current file | 1-col |
| 10 | Cover Letter | ✉️ | File dropzone + current file | 1-col |
| 11 | Custom Fields | ➕ | Dynamic rows (label + value + aliases + remove button) | 1-col |

**Default state:** Sections 1-3 expanded, all others collapsed.

---

### 4.2 Intelligence Indicators (New)

Fields filled via **Smart Fetching** or **Custom Learning** receive extra visual cues:
- **Smart Sparkle**: A small CSS-animated sparkle icon (`::after` pseudo-element) appears in the top-right corner of the field.
- **Micro-Glow**: A soft `box-shadow` pulses while the highlight is active.

```css
@keyframes sparkle {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}

.quickapply-ai-sparkle::after {
  content: '✨';
  position: absolute;
  top: -8px;
  right: -8px;
  font-size: 14px;
  animation: sparkle 1.5s ease-in-out infinite;
  pointer-events: none;
}
```

---

## 5. On-Page Visual Highlights (Content Script Injected)

### 5.1 Complete CSS to Inject

```css
/* ===== QuickApply On-Page Highlights ===== */

.quickapply-filled {
  outline: 2px solid #34D399 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.12),
              0 0 16px rgba(52, 211, 153, 0.15) !important;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.quickapply-fuzzy {
  outline: 2px solid #FBBF24 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.12),
              0 0 16px rgba(251, 191, 36, 0.15) !important;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.quickapply-error {
  outline: 2px solid #F87171 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.12),
              0 0 16px rgba(248, 113, 113, 0.15) !important;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* Pulsing entrance animation */
.quickapply-filled,
.quickapply-fuzzy,
.quickapply-error {
  animation: quickapply-pulse 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
}

@keyframes quickapply-pulse {
  0%   { outline-offset: 0px; opacity: 0.5; }
  50%  { outline-offset: 4px; opacity: 1; }
  100% { outline-offset: 2px; opacity: 1; }
}

/* Dismiss animation — triggered after highlightDuration */
.quickapply-dismiss {
  animation: quickapply-fadeout 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards !important;
}

@keyframes quickapply-fadeout {
  to {
    outline-color: transparent !important;
    box-shadow: none !important;
  }
}
```

---

## 6. Toast Notifications

```css
.quickapply-toast-container {
  position: fixed;
  top: var(--space-5);
  right: var(--space-5);
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  pointer-events: none;
}

.quickapply-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  background: var(--bg-glass);
  backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  min-width: 260px;
  max-width: 380px;
  animation: toast-in var(--duration-enter) var(--ease-spring);
}

.quickapply-toast.leaving {
  animation: toast-out var(--duration-exit) var(--ease-smooth) forwards;
}

.quickapply-toast--success { border-left: 3px solid var(--status-success); }
.quickapply-toast--error   { border-left: 3px solid var(--status-error); }
.quickapply-toast--info    { border-left: 3px solid var(--status-info); }
.quickapply-toast--warning { border-left: 3px solid var(--status-warning); }

.quickapply-toast-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.quickapply-toast-close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  opacity: 0.5;
  cursor: pointer;
  transition: opacity var(--duration-fast);
}
.quickapply-toast-close:hover { opacity: 1; }

@keyframes toast-in {
  from { transform: translateX(100%) scale(0.95); opacity: 0; }
  to   { transform: translateX(0) scale(1); opacity: 1; }
}

@keyframes toast-out {
  to { transform: translateX(100%) scale(0.95); opacity: 0; }
}
```

---

## 7. Custom Scrollbar (Global)

```css
/* Applied to all scrollable containers in the extension */
::-webkit-scrollbar {
  width: 5px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* Hide scrollbar until hover on container */
.scroll-container {
  scrollbar-gutter: stable;
}
.scroll-container::-webkit-scrollbar-thumb {
  background: transparent;
  transition: background 0.2s;
}
.scroll-container:hover::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
}
```

---

## 8. Button Styles Reference

### 8.1 Button Variants

| Variant | Background | Border | Text | Hover | Use Case |
|---|---|---|---|---|---|
| **Primary (Gradient)** | `var(--accent-gradient)` | none | white | glow + lift -1px | Save, Add Client, main CTA |
| **Outline** | transparent | `var(--border-default)` | `var(--text-primary)` | border → accent, text → accent | Edit, Re-fill, Import, Export |
| **Ghost** | transparent | none | `var(--text-secondary)` | bg → subtle glass | Back, Settings, secondary actions |
| **Danger Ghost** | transparent | none | `var(--status-error)` | bg → error-bg | Delete, Clear All |
| **Icon** | transparent | none | `var(--text-muted)` | bg → glass | Gear, Close, Remove |

### 8.2 Button Sizes

| Size | Height | Padding (H) | Font Size | Radius |
|---|---|---|---|---|
| **sm** | 28px | 10px | text-xs | radius-sm |
| **md** | 36px | 14px | text-sm | radius-md |
| **lg** | 44px | 20px | text-md | radius-lg |

### 8.3 Common Button CSS

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: none;
  cursor: pointer;
  font-family: var(--font-family);
  font-weight: var(--weight-medium);
  transition: all var(--duration-normal) var(--ease-smooth);
  white-space: nowrap;
  user-select: none;
}

.btn:active {
  transform: scale(0.98);
}

.btn:disabled {
  opacity: 0.4;
  pointer-events: none;
}

.btn-primary {
  background: var(--accent-gradient);
  color: var(--text-on-accent);
  border: none;
}
.btn-primary:hover {
  background: var(--accent-gradient-hover);
  box-shadow: var(--glow-accent);
  transform: translateY(-1px);
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-primary);
}
.btn-outline:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  background: rgba(124, 106, 255, 0.06);
}

.btn-ghost {
  background: transparent;
  border: none;
  color: var(--text-secondary);
}
.btn-ghost:hover {
  background: var(--bg-glass);
  color: var(--text-primary);
}

.btn-danger {
  background: transparent;
  border: none;
  color: var(--status-error);
}
.btn-danger:hover {
  background: var(--status-error-bg);
}
```

---

## 9. Accessibility

| Rule | Implementation |
|---|---|
| **Focus visible** | All focusable elements: `outline: 2px solid var(--accent-primary)`, `outline-offset: 2px` |
| **Tab order** | Logical: Header → Search → Client list → Form sections top-to-bottom → Actions |
| **ARIA labels** | Every button, icon-only button, and interactive element has `aria-label` |
| **`<label for>`** | Every form input has a `<label>` with matching `for` attribute, never floating labels without corresponding input |
| **Contrast** | All text on `--bg-base` or `--bg-surface` meets WCAG 2.1 AA (4.5:1 for text-primary, 3:1 for text-secondary) |
| **Reduced motion** | `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }` |
| **Screen reader** | Live regions: `aria-live="polite"` on toast container and fill progress |
| **Keyboard shortcuts** | Popup: `↑↓` to navigate clients, `Enter` to apply, `Esc` to close. Dashboard: standard form navigation. |

---

## 10. Responsive Behavior

| Breakpoint | Dashboard Change | Popup |
|---|---|---|
| ≥ 1200px | Sidebar 300px, main content max-width 800px | Fixed 380×520 |
| 900–1199px | Sidebar 260px, main content fills rest | Fixed 380×520 |
| < 900px | Sidebar collapses to 60px (icon-only avatars), expands on hover. Form sections single-column. | Fixed 380×520 |
| < 600px | Full-screen mobile layout (unlikely for dashboard, but handled) | Fixed 380×520 |
