# QuickApply — Field Mapping Dictionary

**Version:** 1.7
**Date:** 2026-05-06

This document defines the complete mapping between form field identifiers (names, IDs, labels, placeholders, aria-labels) and client profile fields. The auto-fill engine uses this dictionary to identify what data to put in each form field.

---

## How To Read This Document

Each profile field has a list of **aliases** — strings that might appear in a form's `name`, `id`, `label`, `placeholder`, or `aria-label` attributes.

### Best-Match Identification Strategy
The engine utilizes a two-phase "Best Match" approach instead of a simple first-found logic:
1. **Phase 1: Exact Matches**: The system first scans all fields for a 1:1 match against any alias. This prevents substring collisions (e.g., "Company Name" won't match "Name" because it's checked against "Company Name" first).
2. **Phase 2: Partial/Fuzzy Matches**: If no exact match is found, the system looks for substring overlaps. It prioritizes the **longest** matching alias to maximize specificity.
3. **Case-Insensitivity**: All comparisons are performed on cleaned, lower-cased strings with common punctuation removed.

---

## 1. Personal Information

### firstName
```
Aliases: [
  "first_name", "firstname", "fname", "first-name",
  "given_name", "givenname", "given-name", "givenName",
  "first name", "given name", "applicant_first",
  "candidate_first_name", "contact_firstname",
  "name_first", "first"
]
Input Type: text
```

### lastName
```
Aliases: [
  "last_name", "lastname", "lname", "last-name",
  "surname", "family_name", "familyname", "family-name",
  "familyName", "last name", "family name", "surname",
  "applicant_last", "candidate_last_name",
  "contact_lastname", "name_last", "last"
]
Input Type: text
```

### fullName
```
Aliases: [
  "full_name", "fullname", "full-name", "applicant_name",
  "candidate_name", "your_name", "your-name", "full name", "complete name",
  "legal_name", "legalname", "legal name",
  "name"
]
```
Note: The bare `"name"` alias is included to support Lever, which uses a bare `name` attribute for the full name field. Exact match takes priority in the identification pipeline, so it will not collide with compound field names like "Company Name" or "School Name" — those are matched first by longer, more specific aliases.
Input Type: text
Note: Only use if no separate first/last fields found
```

### middleName
```
Aliases: [
  "middle_name", "middlename", "middle-name",
  "middle name", "middle_initial", "middle initial",
  "mname"
]
Input Type: text
```

### preferredName
```
Aliases: [
  "preferred_name", "preferredname", "preferred-name",
  "preferred name", "nickname", "nick_name",
  "display_name", "goes_by"
]
Input Type: text
```

---

## 2. Contact Information

### email
```
Aliases: [
  "email", "e-mail", "email_address", "emailaddress",
  "email-address", "mail", "e_mail",
  "applicant_email", "candidate_email", "contact_email",
  "email address", "primary_email", "work_email",
  "personal_email"
]
Input Type: email, text
```

### phone
```
Aliases: [
  "phone", "telephone", "tel", "mobile", "cell",
  "phone_number", "phonenumber", "phone-number",
  "contact_number", "mobile_number", "cell_phone",
  "telephone_number", "primary_phone", "home_phone",
  "work_phone", "phone number", "contact number",
  "mobile number", "daytime_phone"
]
Input Type: tel, text
```

### alternateEmail
```
Aliases: [
  "alternate_email", "alt_email", "secondary_email",
  "other_email", "additional_email", "backup_email"
]
Input Type: email, text
```

### alternatePhone
```
Aliases: [
  "alternate_phone", "alt_phone", "secondary_phone",
  "other_phone", "additional_phone", "home_phone"
]
Input Type: tel, text
```

---

## 3. Address

### streetAddress
```
Aliases: [
  "street_address", "streetaddress", "street-address",
  "address", "address_line_1", "address1", "addressline1",
  "address-line-1", "street", "street_name",
  "home_address", "mailing_address",
  "street address", "address line 1", "residential_address"
]
Input Type: text
```

### addressLine2
```
Aliases: [
  "address_line_2", "address2", "addressline2",
  "address-line-2", "apt", "suite", "unit",
  "apartment", "address line 2", "street_address_2"
]
Input Type: text
```

### city
```
Aliases: [
  "city", "town", "municipality", "city_name",
  "home_city", "current_city", "location_city"
]
Input Type: text
```

### state
```
Aliases: [
  "state", "province", "region", "state_province",
  "state-province", "state_name", "home_state",
  "state or province", "state/province"
]
Input Type: text, select
```

### zipCode
```
Aliases: [
  "zip", "zipcode", "zip_code", "zip-code",
  "postal_code", "postalcode", "postal-code",
  "postcode", "post_code", "zip code", "postal code"
]
Input Type: text
```

### country
```
Aliases: [
  "country", "nation", "country_name", "home_country",
  "country_of_residence", "country of residence",
  "location_country"
]
Input Type: text, select
```

---

## 4. Demographics (EEO)

### gender
```
Aliases: [
  "gender", "sex", "gender_identity", "gender-identity",
  "gender identity", "biological_sex"
]
Input Type: select, radio
Values Map: {
  "Male": ["male", "m", "man"],
  "Female": ["female", "f", "woman"],
  "Non-binary": ["non-binary", "nonbinary", "non binary", "nb", "genderqueer"],
  "Prefer not to say": ["prefer not", "decline", "not disclosed", "choose not"]
}
```

### ethnicity
```
Aliases: [
  "ethnicity", "race", "ethnic", "ethnic_background",
  "race_ethnicity", "race-ethnicity", "ethnic_group",
  "racial_background", "race/ethnicity",
  "race or ethnicity", "ethnic background"
]
Input Type: select, radio
Values Map: {
  "White": ["white", "caucasian"],
  "Black or African American": ["black", "african american", "african-american"],
  "Hispanic or Latino": ["hispanic", "latino", "latina", "latinx"],
  "Asian": ["asian", "east asian", "south asian", "southeast asian"],
  "Native American or Alaska Native": ["native american", "american indian", "alaska native", "indigenous"],
  "Native Hawaiian or Pacific Islander": ["hawaiian", "pacific islander", "polynesian"],
  "Two or More Races": ["two or more", "multiracial", "mixed race", "multi-racial"],
  "Prefer not to say": ["prefer not", "decline", "not disclosed", "choose not"]
}
```

### veteranStatus
```
Aliases: [
  "veteran", "veteran_status", "veteranstatus",
  "veteran-status", "military-status",
  "military_status", "protected_veteran",
  "veteran status", "military service",
  "military_service", "armed_forces"
]
Input Type: select, radio
Values Map: {
  "I am a veteran": ["yes", "i am a veteran", "i am a protected veteran", "protected veteran", "i served", "active duty", "i have served", "yes veteran"],
  "I am not a veteran": ["no", "i am not a veteran", "i am not a protected veteran", "not a protected veteran", "not a veteran", "non-veteran", "never served", "have not served", "no veteran"],
  "Prefer not to say": ["prefer not", "decline", "not specified", "choose not", "do not wish to self-identify"]
}
```
Note: Matching uses whole-phrase containment (not substring) to prevent "i am not a veteran" from accidentally matching the "I am a veteran" bucket. Negation-aware scoring applies a ×0.3 penalty for polarity mismatch when scoring across the veteran/disability buckets. The "yes" and "no" synonyms handle simple Yes/No dropdowns that do not use full phrases.

### disabilityStatus
```
Aliases: [
  "disability", "disability_status", "disabilitystatus",
  "disabled", "handicap", "disability status",
  "physical_disability", "accommodation"
]
Input Type: select, radio
Values Map: {
  "Yes, I have a disability": ["yes", "yes, i have a disability", "i have a disability", "i am disabled", "yes i have", "i have a physical"],
  "No, I do not have a disability": ["no", "no, i do not", "i do not have a disability", "not disabled", "no disability", "i don't have a disability"],
  "Prefer not to say": ["prefer not", "decline", "not specified", "choose not", "do not wish"]
}
```

---

## 5. Professional Information

### currentJobTitle
```
Aliases: [
  "job_title", "jobtitle", "job-title", "current_title",
  "title", "position", "current_position", "role",
  "current_job_title", "most_recent_title",
  "job title", "current title", "current position",
  "current role", "headline"
]
Input Type: text
```

### currentCompany
```
Aliases: [
  "company", "company_name", "current_company", "employer",
  "current_employer", "organization", "org", "organisation",
  "current_organization", "current company",
  "employer_name", "employer name", "company name"
]
Input Type: text
```
Note: Lever uses the bare `org` attribute for the current company/organization field. `organisation` and `current_organization` cover international spelling variants and some ATS implementations.

### yearsOfExperience
```
Aliases: [
  "years_of_experience", "experience", "years_experience",
  "total_experience", "work_experience", "yoe",
  "years of experience", "total years", "experience_years"
]
Input Type: text, select
```

### linkedIn
```
Aliases: [
  "linkedin", "linked_in", "linkedin_url",
  "linkedin_profile", "linkedin-url",
  "linkedin profile", "linkedin url",
  "social_linkedin"
]
Input Type: url, text
```

### portfolio
```
Aliases: [
  "portfolio", "website", "personal_website",
  "portfolio_url", "web_site", "personal_site",
  "portfolio url", "website url", "personal website",
  "homepage"
]
Input Type: url, text
```

### github
```
Aliases: [
  "github", "github_url", "github_profile",
  "github-url", "github profile", "github url",
  "social_github", "git_hub"
]
Input Type: url, text
```

---

## 6. Education

### highestEducation
```
Aliases: [
  "education", "education_level", "degree",
  "highest_degree", "highest_education",
  "degree_type", "education level", "highest degree",
  "degree type", "level_of_education"
]
Input Type: select
Values Map: {
  "High School": ["high school", "hs", "secondary", "ged"],
  "Associate's": ["associate", "associates", "associate's", "aa", "as"],
  "Bachelor's": ["bachelor", "bachelors", "bachelor's", "ba", "bs", "bsc", "undergraduate"],
  "Master's": ["master", "masters", "master's", "ma", "ms", "msc", "mba", "graduate"],
  "Doctorate": ["doctorate", "doctoral", "phd", "ph.d", "doctor"],
  "Professional": ["professional", "md", "jd", "law degree", "medical degree"]
}
```

### university
```
Aliases: [
  "university", "school", "college", "institution",
  "school_name", "university_name", "college_name",
  "alma_mater", "educational_institution",
  "school name", "university name", "college name",
  // SmartRecruiters
  "schoolname", "school-name", "institutionname", "institution-name",
  "universityname", "university-name"
]
Input Type: text
```

### major
```
Aliases: [
  "major", "field_of_study", "discipline",
  "area_of_study", "concentration", "specialization",
  "field of study", "area of study", "degree_major",
  "course_of_study", "subject",
  // SmartRecruiters
  "study", "studyfield", "study-field", "course"
]
Input Type: text
```

### graduationYear
```
Aliases: [
  "graduation_year", "grad_year", "year_graduated",
  "graduation_date", "completion_year",
  "graduation year", "year of graduation",
  "degree_year", "end_year",
  // SmartRecruiters
  "graduationyear", "enddate", "end-date", "end_date",
  "completiondate", "completion-date"
]
Input Type: text, select
```

### gpa
```
Aliases: [
  "gpa", "grade_point_average", "cgpa",
  "cumulative_gpa", "grade point average",
  "academic_score"
]
Input Type: text
```

---

## 7. Skills & Qualifications

### skills
```
Aliases: [
  "skills", "skill", "key_skills", "technical_skills",
  "core_skills", "competencies", "expertise",
  "skills and abilities", "key skills",
  "technical skills", "relevant_skills"
]
Input Type: text, textarea
Note: Paste comma-separated string
```

### certifications
```
Aliases: [
  "certifications", "certification", "certificates",
  "professional_certifications", "licenses",
  "licenses_certifications", "credentials",
  "certifications and licenses"
]
Input Type: text, textarea
```

### languages
```
Aliases: [
  "spoken_languages", "spoken_language", "language_skills",
  "languages spoken", "language proficiency", "native_language",
  "fluent_in", "language_proficiency", "human_languages",
  "what languages do you speak", "languages you speak"
]
Input Type: text, textarea
```
Note: Bare "languages" and "language" aliases were removed to prevent matching programming-language fields (e.g. "What programming languages do you know?"). Only spoken-language context aliases are used.
```

---

## 8. Work Preferences

### workAuthorization
```
Aliases: [
  // Work authorization
  "work_authorization", "workauthorization", "work-authorization",
  "visa_status", "authorization", "work_permit", "eligibility",
  "work authorization", "authorized to work", "legally authorized",
  "employment_authorization", "employmentauthorization",
  "us_work_authorization", "us_authorization", "us_work_eligibility",
  "authorized_to_work", "authorizedtowork", "authorized-to-work",
  "right_to_work", "righttowork", "right-to-work", "right to work",
  "work_eligibility", "workeligibility", "work-eligibility",
  "legal_authorization", "legalauthorization",
  // Sponsorship (INVERTED — "require sponsorship" = NOT authorized)
  // The inversion logic in fuzzyMatchOption handles the polarity flip automatically
  "sponsorship", "require_sponsorship", "requiresponsorship", "require-sponsorship",
  "requires_sponsorship", "needs_sponsorship", "need_sponsorship",
  "visa_sponsorship", "employer_sponsorship", "sponsorship_required",
  "need_visa_sponsorship", "require_visa_sponsorship",
  "employment_visa", "visa_required"
]
Input Type: select, radio, text

Semantic Inversion Logic:
  When the question label contains "require sponsorship", "need sponsorship", or "employer sponsor":
    profile "Yes" (authorized) → answer "No" (does not require sponsorship)
    profile "No" (not authorized) → answer "Yes" (requires sponsorship)
  When the question label contains "authorized to work", "eligible to work", "right to work":
    No inversion — fill directly.

Values Map: {
  "Yes": ["yes", "authorized", "i am authorized", "legally authorized", "eligible to work",
          "eligible", "no sponsorship needed", "citizen", "permanent resident",
          "green card", "work permit", "will not require", "do not require"],
  "No": ["no", "not authorized", "not eligible", "require sponsorship",
         "need sponsorship", "will need sponsorship", "require employer sponsorship"]
}
```

### willingToRelocate
```
Aliases: [
  "relocate", "relocation", "willing_to_relocate",
  "open_to_relocation", "willing to relocate",
  "open to relocation", "can you relocate",
  "relocation_willingness"
]
Input Type: select, radio, checkbox
Values Map: {
  "Yes": ["yes", "true", "willing"],
  "No": ["no", "false", "not willing"]
}
```

### expectedSalary
```
Aliases: [
  "salary", "expected_salary", "desired_salary",
  "salary_expectation", "compensation",
  "salary_range", "pay_expectation",
  "expected salary", "desired salary",
  "salary expectations", "compensation_expectation",
  "target_salary", "minimum_salary"
]
Input Type: text
Note: Enter numeric value only, strip currency symbols
```

### noticePeriod
```
Aliases: [
  "notice_period", "notice", "availability",
  "start_date", "earliest_start_date",
  "when_can_you_start", "notice period",
  "how soon can you start", "available_from",
  "availability_date"
]
Input Type: text, select
```

### desiredEmploymentType
```
Aliases: [
  "employment_type", "job_type", "work_type",
  "position_type", "employment type", "job type",
  "type_of_employment", "desired_job_type",
  "full_time_part_time"
]
Input Type: select, radio, checkbox
Values Map: {
  "Full-time": ["full-time", "fulltime", "full time", "ft"],
  "Part-time": ["part-time", "parttime", "part time", "pt"],
  "Contract": ["contract", "contractor", "freelance"],
  "Internship": ["intern", "internship"],
  "Temporary": ["temporary", "temp"]
}
```

### remotePreference
```
Aliases: [
  "remote", "work_location", "work_preference",
  "remote_preference", "workplace_type",
  "work_model", "hybrid", "on_site",
  "remote preference", "preferred work location",
  "work arrangement", "location_preference"
]
Input Type: select, radio
Values Map: {
  "Remote": ["remote", "work from home", "wfh", "fully remote"],
  "Hybrid": ["hybrid", "mix", "flexible"],
  "On-site": ["on-site", "onsite", "in-office", "in office"],
  "Flexible": ["flexible", "any", "no preference"]
}
```

---

## 9. CV / Resume File Input

### Resume/CV File Upload
```
Aliases (for identifying the correct file input): [
  "resume", "cv", "curriculum_vitae",
  "upload_resume", "upload_cv", "attach_resume",
  "resume_upload", "cv_upload",
  "resume/cv", "resume or cv",
  "upload your resume", "attach your resume",
  "drop your resume", "drag your resume"
]
Negative Aliases (NOT a resume input): [
  "cover_letter", "cover letter", "portfolio",
  "photo", "avatar", "profile_picture",
  "transcript", "reference_letter",
  "additional_document", "other_document"
]
```

---

## 10. Profile-Specific Custom Fields

If a form mentions a field not in the base dictionary, QuickApply uses learned custom fields:
1. **Source**: Manual user inputs on previously unknown fields.
2. **Identification**: Match against the learned `label` or `aliases`.
3. **Fuzzy Recognition**: If learned "Expected Salary", matches "What is your target expected salary?" via substring overlap.
4. **Syncing**: Once learned for a client, the field is remembered across all job portals for that specific client.
5. **Shadow guard** (added in 3.4.1): Strict-equality custom matches always win (their original purpose). For the fuzzy paths (word-boundary substring + Jaccard token overlap) the matcher first checks whether the customField's label or any alias *shadows* a standard `FIELD_MAPPINGS` alias (`matchAgainstAliases(...).confidence ≥ 0.6`). If yes, the customField is skipped and the canonical matchers (`matchByDataAutomationId` → `matchByName` → `matchById` → …) handle the field. This prevents stale customFields like `{label:"first name", value:"<lastName>"}` or `{label:"address", value:"<streetAddress>"}` — cached from past sessions or accidentally populated — from overriding the correct standard profile field.

---

## 11. Match Priority Rules

When multiple profile fields could match a single form field, use this priority order (matches the identification pipeline in ARCHITECTURE.md §4.1):

1. **Correction Check** — Exact match against saved corrections by `fieldName`/`fieldSelector` for this domain
2. **Correction by profileField** — Re-check corrections by `profileField` + domain after identification; survives HTML attribute changes
3. **Platform Learned** — Domain-specific mappings with uses≥2 and confidence≥0.6
4. **Custom Field** — Profile-specific custom fields (semantic token-overlap matching)
5. **data-automation-id** — Workday's primary field identifier
6. **data-testid** — SmartRecruiters' primary field identifier
7. **Name attribute** — Exact + substring match against field aliases
8. **ID attribute** — Same alias matching
9. **Label element** — Exact + substring match on `<label>` text (via `getRootNode()` for shadow DOM)
10. **Placeholder** — Alias match on placeholder attribute
11. **Aria-label** — Alias match on aria-label attribute
12. **Nearby text** — Preceding sibling + ancestor text node scan
13. **Universal Registry** — Cached AI discoveries from previous sessions (confidence threshold: 0.6)
14. **Gemini AI** — Field identification via LLM (requires API key)

When a form field could match multiple profile fields (e.g., a field labeled just "Name"):
1. If `firstName` and `lastName` fields exist separately → don't fill "Name"
2. If "Name" is the only name field → fill with `fullName`
3. If "Phone" field exists and a separate "Country Code" → fill both separately
4. If only one "Phone" field → fill with full `phone` (including country code)

---

## 12. Platform-Specific Identifiers

### Workday
Primary identifier: `data-automation-id` attribute. The engine checks the element and nearest ancestor.
Common format: `legalNameSection_firstName` → stripped to `firstName` for alias matching.

Three custom widget families that don't match the base discoverer's selector set — `platforms/workday.js` synthesises FieldRules for them in `discoverWorkdayControls()` and fills them in `postFill()`:

1. **Button-as-dropdown** — `button[aria-haspopup="listbox"]` inside a `[data-automation-id^="formField-"]` container (State, Degree, Phone Type, Compensation, Veteran Status, Disability). Opens via `_workdayRealClick` (pointer/mouse sequence), selects the inner `[data-automation-id="promptLeafNode"]` (Workday's real click target — the `role="option"` wrapper doesn't fire the handler).
2. **Spinbutton dates** — triplet of `role="spinbutton"` elements inside `[data-automation-id="dateInputWrapper"]`. Filled by focusing Month, firing per-digit keydown+keypress+input+keyup, with a native-value-setter + `aria-valuenow` fallback. MM/DD/YYYY and MM/YYYY both supported.
3. **Hierarchical multiselects** — `<input>` inside `[data-automation-id="multiSelectContainer"]` (How Did You Hear About Us, Country Phone Code, Skills, Field of Study). Opens via `multiselectInputContainer` wrapper (not the input itself), picks a direct leaf if the target matches, otherwise scores root categories by token overlap + `WORKDAY_SOURCE_HINTS` (e.g. `linkedin → [website, job board, social media]`) and drills into the best match. Only drills into sub-options that are themselves categories (`data-uxi-multiselectlistitem-type="1"` or have a caret icon) to avoid wrongly selecting leaves.

Repeatable sections (Work Experience, Education, Languages, Websites) auto-expand in `preFill` via `expandRepeatingSections` — skip heuristic keys on a Delete button or `<h5>` header.

Platform-specific alias extensions (`WorkdayFiller.getFieldAliases`):
- `legalname--firstname/lastname`, `emailaddress`, `phonenumber`, `addressline1`, `postalcode`, `countryregion` (→ state), `jobtitle`, `companyname`, `schoolname`, `fieldofstudy`, `gradeaverage`, `linkedinaccount`.
- Full-phrase aliases for opaque hex-ID custom questions (step 3 on most tenants): "legally authorized to work", "require sponsorship or other support", "desired compensation", "anticipated eligibility time for employment".

Verified tenants (v3.1.0): `roberthalf.wd1`, `veritiv.wd5`, `adobe.wd5`.

### SmartRecruiters
Primary identifier: `data-testid` attribute.
Format: `input-firstName` → strip `input-` prefix → `firstName`
Section fields: `experience-title` → strip `experience-` → `title` → currentJobTitle
Education/experience sections are collapsed by default — extension clicks "Add" buttons first.

### Lever
Standard HTML. No special identifiers needed.
Key non-obvious fields: `name` → fullName, `org` → currentCompany
URL fields: `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`

### Greenhouse
Standard server-rendered HTML. No special identifiers needed.
EEO section uses radio buttons (not select) — matched via VALUES_MAP fuzzy scoring.
Custom dropdowns return internal numeric IDs via `field.value` — corrections use `field.options[selectedIndex].text` instead.

### Ashby
React SPA at `jobs.ashbyhq.com`. Standard HTML field names (firstName, lastName, etc.).
Cover letter/open-ended questions use TipTap `contenteditable` div — filled as text input.

### iCIMS
Dotted field names: `applicant.field.firstname`, `applicant.field.email`, `applicant.field.phone1`.
Custom question fields use opaque names like `Question_12345` — identified by `contextLabel` (nearby visible label text).
Labels often appear in `<th>` table header cells.

### Workable
Primary identifier: `data-ui` attribute (e.g. `data-ui="firstname"`, `data-ui="lastname"`).
Standard fields: `name="firstname"`, `lastname`, `email`, `phone`, `headline` (→ currentJobTitle), `summary` (→ coverLetter).
Custom QA fields: `QA_XXXXXXX` — open-ended, answered via AI fill button with CV context.
Skip: `city`, `postcode`, `country` have `aria-hidden="true"` (managed by autocomplete).
