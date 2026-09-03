# QuickApply — Data Schema & Message Protocol

**Version:** 1.7
**Date:** 2026-05-06

---

## 1. Client Profile Schema

This is the complete data model stored in `chrome.storage.local`. Every field listed here MUST be supported in the Dashboard UI and the Auto-Fill engine.

### 1.1 TypeScript Interface (Reference)

```typescript
interface ClientProfile {
  // === Identity ===
  id: string;                    // UUID v4, auto-generated on create
  createdAt: string;             // ISO 8601 timestamp
  updatedAt: string;             // ISO 8601 timestamp
  avatarColor: string;           // Hex color for UI avatar (auto-assigned)

  // === Personal Information ===
  firstName: string;             // Required. e.g. "Ali"
  lastName: string;              // Required. e.g. "Hassan"
  fullName: string;              // Auto-computed: firstName + " " + lastName
  middleName: string;            // Optional
  preferredName: string;         // Optional. Some forms ask for "preferred name"
  
  // === Contact ===
  email: string;                 // Required. Primary email
  phone: string;                 // Required. With country code, e.g. "+1-555-123-4567"
  phoneCountryCode: string;      // Extracted country code, e.g. "+1"
  phoneNumber: string;           // Number without code, e.g. "5551234567"
  alternateEmail: string;        // Optional
  alternatePhone: string;        // Optional

  // === Address ===
  streetAddress: string;         // e.g. "123 Main St, Apt 4B"
  addressLine2: string;          // Unit, Suite, etc.
  city: string;                  // e.g. "New York"
  state: string;                 // e.g. "NY" or "New York"
  zipCode: string;               // e.g. "10001"
  country: string;               // e.g. "United States"

  // === Demographics (EEO) ===
  gender: string;                // "Male", "Female", "Non-binary", "Prefer not to say"
  ethnicity: string;             // "White", "Black or African American", "Hispanic or Latino",
                                 // "Asian", "Native American", "Pacific Islander",
                                 // "Two or More Races", "Prefer not to say"
  veteranStatus: string;         // "I am a veteran", "I am not a veteran",
                                 // "Prefer not to say"
  disabilityStatus: string;      // "Yes, I have a disability", "No",
                                 // "Prefer not to say"

  // === Professional ===
  currentJobTitle: string;       // e.g. "Senior Software Engineer"
  currentCompany: string;        // e.g. "Google"
  yearsOfExperience: string;     // e.g. "5" or "5-10"
  linkedIn: string;              // Full URL: "https://linkedin.com/in/janedoe"
  portfolio: string;             // Website URL
  github: string;                // GitHub URL

  // === Education ===
  highestEducation: string;      // "High School", "Associate's", "Bachelor's",
                                 // "Master's", "Doctorate", "Professional"
  university: string;            // e.g. "MIT"
  major: string;                 // e.g. "Computer Science"
  graduationYear: string;        // e.g. "2020"
  gpa: string;                   // e.g. "3.8"

  // === Skills & Qualifications ===
  skills: string;                // Comma-separated: "JavaScript, Python, React"
  certifications: string;        // Comma-separated
  languages: string;             // Comma-separated: "English, Urdu, Arabic"

  // === Work Preferences ===
  preferredLocations: string[];  // e.g. ["New York, NY", "San Francisco", "Remote"]
  targetRoles: string[];         // e.g. ["Software Engineer", "Backend Engineer"]
  workAuthorization: string;     // "US Citizen", "Green Card", "H1B Visa",
                                 // "EAD", "Require Sponsorship", "OPT"
  willingToRelocate: string;     // "Yes", "No"
  expectedSalary: string;        // e.g. "120000" or "100000-130000"
  salaryCurrency: string;        // e.g. "USD"
  noticePeriod: string;          // e.g. "2 weeks", "1 month", "Immediate"
  desiredEmploymentType: string; // "Full-time", "Part-time", "Contract", "Internship"
  remotePreference: string;      // "Remote", "Hybrid", "On-site", "Flexible"

  // === Custom Fields ===
  customFields: CustomField[];   // User-defined additional fields

  // === CV / Resume ===
  cvFileName: string;            // Original filename, e.g. "Ali_Hassan_Resume.pdf"
  cvMimeType: string;            // "application/pdf" or DOCX MIME
  cvData: string;                // Base64-encoded file content
  cvSize: number;                // File size in bytes (for UI display)
  cvText: string;                // Plain text extracted from CV (max 8000 chars) — used for AI open-ended answering
  cvHash: string;                // SHA-256 hash "sha256-..." for integrity verification
  cvIntegrity: 'verified' | 'unverified'; // Set to 'verified' after hash computation
  cvVerifiedAt: string;          // ISO 8601 timestamp of last verification

  // === Cover Letter (Optional) ===
  coverLetterFileName: string;
  coverLetterMimeType: string;
  coverLetterData: string;
}

interface CustomField {
  label: string;                 // Display label, e.g. "Security Clearance"
  value: string;                 // Value, e.g. "Top Secret"
  aliases: string[];             // Form field names that should match, e.g. ["security_clearance", "clearance_level"]
}
```

```json
{
  "quickapply_clients": "ClientProfile[]",
  "quickapply_settings": "AppSettings",
  "quickapply_version": "1.5.0",
  "quickapply_field_registry": "FieldRegistry",
  "quickapply_corrections": "CorrectionEntry[]",
  "quickapply_platform_knowledge": "{ [domain: string]: PlatformKnowledge }",
  "quickapply_unknown_fields": "UnknownField[]",
  "quickapply_fill_log": "FillLogEntry[]"
}
```

### 1.6 Platform Knowledge Schema
```typescript
interface PlatformKnowledge {
  fillCount: number;                      // Total fills on this domain
  fields: {
    [normKey: string]: {
      profileField: string;               // Mapped profile field key
      confidence: number;                 // 0.0–1.0, increments +0.15/success
      uses: number;                       // Total times used
      successCount: number;               // Successful fills (no error status)
      lastStatus: 'filled' | 'fuzzy' | 'error' | 'skipped';
    }
  }
}
```

### 1.7 Fill Log Schema
```typescript
interface FillLogEntry {
  timestamp: string;                      // ISO 8601
  url: string;
  platform: string;
  clientId: string | null;
  clientName: string | null;
  summary: {
    filled: number;
    fuzzy: number;
    skipped: number;
    error: number;
    notFound: number;
  };
  fields: {
    field: string;
    status: string;
    value: string | null;
    confidence: number | null;
    strategy: string | null;
    error: string | null;
  }[];
}
```
Fill log is capped at the last 100 entries. Duplicate FILL_REPORT events (same timestamp + clientId) are deduplicated before append.
```

### 1.4 Universal Field Registry Schema
```typescript
interface FieldRegistry {
  version: number;
  lastUpdated: string;
  fields: {
    [fieldLabel: string]: {
      profileField: string;
      confidence: number;
      usageCount: number;
      sources: string[];     // e.g. ["cv_discovery", "form_fill", "correction"]
      platforms: string[];   // Observed domains
    }
  }
}
```

### 1.5 Corrections Database Schema
```typescript
interface CorrectionEntry {
  platform: string;          // Detected platform (e.g. "Workday")
  domain: string;            // Domain (e.g. "workday.com")
  fieldSelector: string;     // Stable CSS selector
  fieldName: string;         // name or id attribute
  profileField: string;      // Mapped field (internal key or custom_*)
  originalValue: any;
  correctedValue: any;
  correctedIndex?: number;   // For <select> elements
  timestamp: string;
}
```

### 1.3 AppSettings Schema

```typescript
interface AppSettings {
  highlightDuration: number;     // Seconds to show highlights (default: 10)
  highlightEnabled: boolean;     // Whether to show visual highlights (default: true)
  fillDelay: number;             // Milliseconds between filling each field (default: 50)
  autoExpandSections: boolean;   // Try to expand collapsed form sections (default: true)
  confirmFuzzyMatches: boolean;  // Flag fuzzy matches in review (default: true)
  geminiApiKey: string;          // Google AI Studio API key (optional, default: '')
  // Job Analyzer
  showFitVerdict: boolean;       // Show "Strong fit / Weak fit" line in popup (default: true)
  showFitBreakdown: boolean;     // Show per-parameter rows in popup (default: true)
  fitWeights: {                  // Soft-param weights, must sum to 100
    yoe: number;                 // default 40
    title: number;               // default 25
    skills: number;              // default 25
    salary: number;              // default 10
  };
}
```

### 1.8 JD Cache Schema (Job Analyzer)

```typescript
interface JdObject {
  jobKey: string;                // Stable key, e.g. "greenhouse:companyId:jobId" or "workday:tenant:R-12345"
  url: string;
  platform: 'greenhouse' | 'workday';
  extractedAt: string;           // ISO timestamp
  title: string | null;
  company: string | null;
  location: string | null;
  locationFlags: { isRemote: boolean; isHybrid: boolean; isOnsite: boolean };
  employmentType: string | null; // "Full-time" | "Contract" | "Internship" | …
  requiredYoE: { min: number | null; max: number | null };
  visaText: string | null;       // Excerpted JD text discussing sponsorship
  salaryRange: { min: number | null; max: number | null; currency: string } | null;
  descriptionText: string;
  fitScores?: {                  // Per-client AI verdicts; reused across popup re-opens
    [clientId: string]: {
      titleScore?: number;
      titleReason?: string;
      skillsScore?: number;
      skillsReason?: string;
      missingSkills?: string[];
      scoredAt: string;
    }
  };
}
```

Storage key: `quickapply_jd_cache: { [jobKey]: JdObject }`. TTL 7 days, LRU cap 100.

---

## 2. Message Protocol

### 2.1 Base Message Format

Every message follows this structure:

```typescript
interface Message {
  type: MessageType;
  payload?: any;
  timestamp: number;             // Date.now() when sent
}

type MessageType =
  | 'FILL_FORM'                    // Popup→Content: start fill
  | 'FILL_REPORT'                  // Content→Popup+Background: results
  | 'CLEAR_FORM'                   // Popup→Content: clear fills
  | 'CLEAR_REPORT'                 // Content→Popup: clear result
  | 'SCROLL_TO_FIELD'              // Popup→Content: scroll to selector
  | 'GET_PAGE_INFO'                // Popup→Content: page metadata
  | 'PAGE_INFO'                    // Content→Popup: page metadata response
  | 'PING'                         // Popup→Content: health check
  | 'CALL_AI_IDENTIFICATION'       // Content→Background: identify field via Gemini
  | 'CALL_AI_NORMALIZATION'        // Content→Background: normalize dropdown value via Gemini (includes questionLabel)
  | 'CALL_AI_CV_ANSWER'            // Content→Background: answer open-ended question from CV text
  | 'CALL_AI_CV_OPTION_SELECT';    // Content→Background: select best dropdown option from CV context
```

### 2.2 Message Payloads

#### FILL_FORM (Popup → Background → Content)
```typescript
{
  type: 'FILL_FORM',
  payload: {
    clientId: string,
    profile: ClientProfile       // Full profile data
  }
}
```

#### FILL_REPORT (Content → Background → Popup)
```typescript
{
  type: 'FILL_REPORT',
  payload: {
    clientId: string,
    totalFields: number,         // Total form fields found on page
    results: FillResult[],
    cvStatus: 'uploaded' | 'not_found' | 'error' | 'no_cv',
    platform: string,            // Detected platform name
    durationMs: number           // Total time taken
  }
}
```

#### FillResult Object
```typescript
interface FillResult {
  profileField: string;          // Key from ClientProfile, e.g. "firstName"
  fieldLabel: string;            // Human label, e.g. "First Name"
  value: string;                 // Value that was set
  status: 'filled' | 'fuzzy' | 'not_found' | 'skipped' | 'error';
  confidence: number;            // 0.0 to 1.0 — how confident the match is
  strategy: string;              // Which detection strategy matched
  elementSelector: string;       // CSS selector for the element (for scroll-to)
  errorMessage?: string;         // If status is 'error'
}
```

#### CLEAR_FORM (Popup → Background → Content)
```typescript
{
  type: 'CLEAR_FORM',
  payload: {}
}
```

#### CLEAR_REPORT (Content → Background → Popup)
```typescript
{
  type: 'CLEAR_REPORT',
  payload: {
    clearedCount: number
  }
}
```

#### SCROLL_TO_FIELD (Popup → Background → Content)
```typescript
{
  type: 'SCROLL_TO_FIELD',
  payload: {
    selector: string             // CSS selector from FillResult.elementSelector
  }
}
```

#### GET_PAGE_INFO (Popup → Background → Content)
```typescript
{
  type: 'GET_PAGE_INFO',
  payload: {}
}
```

#### PAGE_INFO (Content → Background → Popup)
```typescript
{
  type: 'PAGE_INFO',
  payload: {
    url: string,
    title: string,
    platform: string,
    formCount: number,
    fieldCount: number,
    hasFileInput: boolean
  }
}
```

---

## 3. Fill Status Codes

| Status | Meaning | UI Color | Action |
|---|---|---|---|
| `filled` | Field matched and value set successfully | 🟢 Green | None needed |
| `fuzzy` | Field matched with low confidence (≤ 0.7) | 🟡 Yellow | User should verify |
| `not_found` | Profile has data but no matching field on page | ⬜ Gray | Informational |
| `skipped` | Field found but no data in profile for it | 🔴 Red | User manually fills |
| `error` | Fill attempted but failed (e.g., readonly field) | 🔴 Red | User manually fills |

---

## 4. Confidence Scoring

The detection engine assigns a confidence score (0.0–1.0) to each field match:

| Score Range | Meaning | Example |
|---|---|---|
| 1.0 | **Exact Match** or **Correction** | Exact string match on alias or manual correction |
| 0.9 | High-confidence platform mapping | Platform-specific learned field |
| 0.8 | Fuzzy match on label/placeholder | `Expected Salary` learned vs `What is your expected salary?` |
| 0.7 | Significant keyword/Context match | `aria-label` or restrictive local text fetching |
| 0.5–0.6 | Partial fuzzy/Generic match | Parent contains keyword |
| < 0.3 | Very low confidence, skipped | Not filled |

**Logic Priority:**
1. **Precise Correction**: Manual session-level lock.
2. **Client Custom Field**: Profile-specific learned questions.
3. **Universal Exact Match**: Highest priority aliases (Best Match strategy).
4. **Platform Learned**: Domain-specific mappings.
5. **Partial/Fuzzy**: Substring and nearby text discovery.

**Threshold:** Only matches with confidence ≥ 0.3 are used. Matches < 0.3 are reported as `not_found`.

---

## 5. Validation Rules

### 5.1 Profile Validation (Dashboard)

| Field | Rule |
|---|---|
| `firstName` | Required, 1-100 chars, Unicode allowed |
| `lastName` | Required, 1-100 chars, Unicode allowed |
| `email` | Required, valid email format (RFC 5322) |
| `phone` | Optional, if provided: valid international format |
| `cvData` | Optional, if provided: PDF or DOCX, max 5MB |
| `linkedIn` | Optional, if provided: valid URL starting with `https://linkedin.com` or `https://www.linkedin.com` |
| `expectedSalary` | Optional, numeric or range format (e.g., "120000" or "100000-130000") |
| `email` uniqueness | Warn if another client has the same email (but allow) |

### 5.2 Import Validation

| Rule | Action |
|---|---|
| Valid JSON | Reject with error message if invalid |
| Has `quickapply_clients` key | Reject if missing |
| Each profile has `id`, `firstName`, `lastName`, `email` | Skip invalid profiles, report count |
| Schema version mismatch | Run migration if possible, reject if too old |

---

## 6. Storage Limits & Strategy

| Metric | Value |
|---|---|
| `chrome.storage.local` default limit | 10 MB |
| With `unlimitedStorage` permission | Unlimited |
| Average CV size (PDF) | 200KB–2MB |
| Average profile size (without CV) | ~2KB |
| 10 clients with CVs | ~5–15 MB |
| 50 clients with CVs | ~25–75 MB |
| **Recommendation** | Use `unlimitedStorage` permission |

### 6.1 Storage Optimization

- CVs are stored as base64 (33% larger than binary). This is unavoidable with `chrome.storage.local`.
- Consider compressing large CVs client-side before base64 encoding (future optimization).
- Dashboard shows storage usage per client and total.
