/**
 * QuickApply — AI Engine (Gemini)
 * Knowledge-based field identification, value normalisation, and CV answering.
 * Every prompt is enriched with platform identity + site-specific learned memory
 * fetched by background.js before each call — no cold-start guessing.
 */
(function () {
    const GEMINI_MODEL = "gemini-3.5-flash";
    const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

    // Platform tone/length guidance injected into CV answer prompts
    const PLATFORM_STYLE = {
        greenhouse:      'conversational and specific, 2–4 sentences',
        lever:           'concise and direct, 2–3 sentences',
        ashby:           'professional but warm, 3–5 sentences',
        workday:         'formal and structured, 2–4 sentences',
        icims:           'professional, 2–3 sentences',
        smartrecruiters: 'concise, 1–3 sentences',
        workable:        'natural and engaging, 2–4 sentences',
        bamboohr:        'friendly and professional, 2–3 sentences',
        taleo:           'formal, 2–3 sentences',
        careerpuck:      'conversational and specific, 2–4 sentences',
        beamery:         'engaging and forward-looking, 2–4 sentences',
        breezy:          'natural and concise, 2–3 sentences',
        pinpoint:        'professional and targeted, 2–4 sentences',
        rippling:        'clear and structured, 2–3 sentences',
        applied:         'thoughtful and evidence-based, 3–5 sentences',
        teamtailor:      'warm and personable, 2–4 sentences',
        generic:         '2–4 sentences, calibrated to the question scope'
    };

    class QuickApplyAI {
        constructor() {
            this.apiKey = null;
        }

        async init() {
            const data = await chrome.storage.local.get('quickapply_settings');
            this.apiKey = data.quickapply_settings?.geminiApiKey;
        }

        // ─────────────────────────────────────────────────────────────────
        // FIELD IDENTIFICATION
        // Determines which profile field an opaque/unknown form field maps to.
        // Uses site-specific memory (previously learned mappings on this domain)
        // as the first signal before falling back to label-text reasoning.
        // ─────────────────────────────────────────────────────────────────
        async identifyField(context) {
            if (!this.apiKey) return null;

            const {
                label = '', name = '', id = '', placeholder = '',
                options = [],
                platform = 'generic', domain = '',
                siteMemory = {}, directHit = null
            } = context;

            // ── Direct hit fast-path: exact match from normalized key lookup ──
            const directHitLine = directHit
                ? `\nDIRECT HIT: This exact field was learned on ${domain} before.\n` +
                  `  profileField="${directHit.profileField}" (${directHit.pct}% confidence, seen ${directHit.n}×).\n` +
                  `  Return this UNLESS the visible label clearly contradicts it.\n`
                : '';

            // ── Format site memory section ──
            const memEntries = Object.entries(siteMemory).slice(0, 20);
            const memorySection = memEntries.length > 0
                ? `\nSITE MEMORY — ${memEntries.length} fields previously learned on ${domain}:\n` +
                  memEntries.map(([k, v]) =>
                      `  "${k}" → ${v.profileField} (${v.pct}% confidence, seen ${v.n}×)`
                  ).join('\n') + '\n'
                : `\nSITE MEMORY: None yet — first time on ${domain || 'this site'}.\n`;

            // ── FIX-1: Include visible options to help identify ambiguous fields ──
            const optionsSection = Array.isArray(options) && options.length > 0
                ? `\nFIELD OPTIONS (${options.length} choices visible on form — use to narrow identification):\n` +
                  options.slice(0, 20).map((o, i) => `  ${i + 1}. "${o}"`).join('\n') + '\n'
                : '';

            const prompt =
`You are a job application form analyzer with accumulated knowledge of specific ATS platforms.

PLATFORM: ${platform.toUpperCase()} | SITE: ${domain}
${directHitLine}${memorySection}
FIELD TO IDENTIFY:
  Label / Question : "${label}"
  HTML name attr   : "${name}"
  HTML id attr     : "${id}"
  Placeholder      : "${placeholder}"
${optionsSection}
AVAILABLE PROFILE FIELDS — grouped by category (pick exactly one, or return custom_*):

PERSONAL: firstName, lastName, middleName, preferredName, fullName, pronouns, gender
CONTACT: email, phone, alternateEmail, alternatePhone
ADDRESS: streetAddress, addressLine2, city, state, zipCode, country
PROFESSIONAL: currentJobTitle, currentCompany, yearsOfExperience, linkedIn, portfolio, github
EDUCATION: highestEducation, university, major, graduationYear, gpa
SKILLS: skills, certifications, languages
PREFERENCES: workAuthorization, liveInUS, willingToRelocate, expectedSalary, noticePeriod,
  desiredStartDate, desiredEmploymentType, remotePreference, currentlyEmployed
EEO: ethnicity, hispanicLatino, sexualOrientation, transgender, veteranStatus, disabilityStatus
LEGAL: driversLicense, backgroundCheckConsent, drugTestConsent, ageEligible,
  securityClearance, nonCompete, heardAboutUs, coverLetter

DECISION LOGIC (apply in order):
1. DIRECT HIT: If shown above → return it immediately unless label clearly contradicts.
2. SITE MEMORY: If HTML name/id matches a learned entry → trust it (confidence 0.95).
3. LABEL TEXT + OPTIONS: Identify from the visible label — most reliable signal.
   Use field options to confirm the type (e.g. "Yes/No" = boolean, "Bachelor/Master/PhD" = highestEducation).
   Ignore opaque IDs like "Question_12345" — use the label instead.
4. NOVEL FIELD: If not covered by the list, return "custom_[short_descriptive_label]" with confidence < 0.5.

Return ONLY valid JSON (no markdown): {"profileField":"string","confidence":0.0-1.0}`;

            try {
                const response = await this.callGemini(prompt);
                const result = JSON.parse(response);
                return result.confidence >= 0.55 ? result : null;
            } catch (e) {
                console.error('[QuickApply AI] Identification failed:', e);
                return null;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // VALUE NORMALISATION
        // Selects the best dropdown/radio option for a known profile field.
        // Enriched with platform identity, site history for this field, and
        // the full candidate profile so it can reason about inverted questions.
        // ─────────────────────────────────────────────────────────────────
        async normalizeValue(field, rawOptions, profileValue, questionLabel, profileContext,
                             platform = 'generic', domain = '', siteMemory = {}, fieldHistory = null) {
            if (!this.apiKey) return null;

            const questionContext = questionLabel
                ? `QUESTION (exact text shown on page): "${questionLabel}"`
                : `PROFILE FIELD TYPE: ${field}`;

            const candidateInfo = profileContext
                ? `\nCANDIDATE PROFILE SUMMARY:\n${profileContext}`
                : '';

            // If we've successfully answered this specific field on this domain before, surface it
            const historySection = fieldHistory
                ? `\nSITE HISTORY — This field was previously handled on ${domain}:\n` +
                  `  Mapped to: ${fieldHistory.profileField} | ` +
                  `Confidence: ${Math.round(fieldHistory.confidence * 100)}% | ` +
                  `Seen: ${fieldHistory.uses}× | Last result: ${fieldHistory.lastStatus}\n` +
                  `  If the question matches the same profile field, apply the same reasoning.\n`
                : '';

            // Surface top site memory entries relevant to this field type
            const relatedMemory = Object.entries(siteMemory)
                .filter(([, v]) => v.profileField === field)
                .slice(0, 5);
            const relatedSection = relatedMemory.length > 0
                ? `\nSITE PATTERN — ${relatedMemory.length} similar field(s) seen on ${domain}:\n` +
                  relatedMemory.map(([k, v]) => `  "${k}" → ${v.profileField} (${v.pct}%)`).join('\n') + '\n'
                : '';

            const prompt =
`You are autonomously filling a ${platform.toUpperCase()} job application dropdown on behalf of a candidate.
You have memory of past fills on this specific site and the candidate's full profile.

SITE: ${domain}
PLATFORM: ${platform.toUpperCase()}
${historySection}${relatedSection}
${questionContext}
CANDIDATE'S STORED VALUE: "${profileValue}"${candidateInfo}

AVAILABLE OPTIONS (select the exact text — copy character-for-character):
${rawOptions.map((o, i) => `${i + 1}. "${o}"`).join('\n')}

SELECTION RULES (apply in order):
1. SITE HISTORY: If we've answered this successfully before → apply the same reasoning direction.
2. QUESTION POLARITY: Read the question carefully — it may be INVERTED from the profile field.
   Sponsorship logic (handle precisely — generic AI fills get this wrong):
     "Are you legally authorized to work in the US?" / "Right to work?" →
       ALWAYS answer YES regardless of workAuthorization value. Anyone applying
       to a US-based job intends to work; answering No filters them out before
       the sponsorship conversation can even start. Authorization here means
       "candidate intends to work in the US", not "has all paperwork done today".
     "Will you require sponsorship now or in the future?" →
       workAuthorization "US Citizen" / "Green Card" / "Permanent Resident" → NO.
       workAuthorization "OPT" / "H1B" / "H-1B" / "F-1" / "TN" / "J-1" / "E-3" / "L-1" / "L-2" / "EAD" / "STEM" → YES (visa transfer/extension/H1B conversion).
       workAuthorization "Require Sponsorship" / "Need Visa" / "Seeking Sponsorship" → YES.
       workAuthorization "Right to Work" alone → YES (ambiguous, safer default).
   Example: "Are you willing to relocate?" + willingToRelocate=Yes → answer "Yes".
3. MEANING MATCH: Pick the option whose meaning best matches the candidate's stored value.
   Wording will differ — match semantics, not exact text.
4. UNCERTAINTY: If genuinely unsure between options, prefer "Prefer not to say" / "N/A" /
   "Decline to answer" over a wrong affirmative. A neutral answer beats an incorrect one.
5. NEVER pick an option that clearly contradicts the candidate's stored value.

Return ONLY valid JSON (no markdown): {"matchedOption":"exact string from options array","confidence":0.0-1.0}`;

            try {
                const response = await this.callGemini(prompt);
                const result = JSON.parse(response);
                // M3 FIX: binary (2-option) dropdowns — lower threshold to 0.50.
                // A random-guess probability of 50% means even a 0.51 AI response is meaningful.
                // The 0.65 threshold was designed for multi-option dropdowns.
                const threshold = rawOptions.length <= 2 ? 0.50 : 0.65;
                return result.confidence >= threshold ? result.matchedOption : null;
            } catch (e) {
                console.error('[QuickApply AI] Normalisation failed:', e);
                return null;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // PERSONAL QUESTION DETECTOR
        // Questions about life outside work need personality inference,
        // not CV extraction.
        // ─────────────────────────────────────────────────────────────────
        _isPersonalQuestion(question) {
            const q = question.toLowerCase();
            // H1 FIX: broadened to include food/hobby/entertainment questions.
            // Previously "What's your favorite junk food?" was answered with career content.
            return /\b(not.{0,10}work|outside.{0,10}work|personal|hobby|hobbies|fun|weekend|free time|life outside|non.work|beyond work|aren.t work|isn.t work|other than work|apart from work|proud of.{0,20}isn|proud.{0,20}outside|something you enjoy|tell us about yourself|who are you|what makes you|what do you do for fun|volunteer|community|passion|interest outside|favorite|favourite|junk.?food|food|snack|eat|drink|music|sport|game|movie|book|tv.?show|song|pet|color|colour|superhero|fictional.{0,15}character|dream|childhood|memory|outside interests|life goals)\b/.test(q);
        }

        // ─────────────────────────────────────────────────────────────────
        // CV-BASED ANSWER GENERATION
        // Generates a human, specific answer to open-ended application questions.
        // Two modes: professional (extract from CV) and personal (infer personality).
        // Platform-aware: tone and length are calibrated per ATS.
        // ─────────────────────────────────────────────────────────────────
        async answerFromCV(questionLabel, cvText, platform = 'generic', profileContext = '') {
            // FIX-5: allow profile context as fallback when no CV is uploaded
            if (!this.apiKey || (!cvText && !profileContext)) return null;

            const isPersonal = this._isPersonalQuestion(questionLabel);
            const styleGuide = PLATFORM_STYLE[platform] || PLATFORM_STYLE.generic;
            const platformNote = `PLATFORM: ${platform.toUpperCase()} — Target style: ${styleGuide}.`;

            // When no CV, use profile context as the knowledge source
            const hasCv = cvText && cvText.trim().length > 50;
            const cvSection = hasCv
                ? `CANDIDATE CV:\n"""\n${cvText.substring(0, 12000)}\n"""\n`
                : `CANDIDATE PROFILE SUMMARY (no CV uploaded — use this structured data only):\n${profileContext}\n`;

            const prompt = isPersonal
                ? `You are ghostwriting a job application answer for a real candidate.
The question is PERSONAL / NON-WORK. Do NOT talk about their job — talk about their life outside work.

${platformNote}
QUESTION: "${questionLabel}"

HOW TO ANSWER:
- Read the candidate data to infer personality, values, and character.
- Pick ONE specific, believable personal interest or life detail to write about.
- Do NOT say: "I enjoy spending time with loved ones", "I like to travel", or generic platitudes.
- Write in first person. Sound like a real human, not a template.
- Do NOT start with: "I am passionate about", "I believe", "As someone who".

${cvSection}
Return ONLY valid JSON: {"answer":"string","confidence":0.0-1.0}
Always return a real answer — this is a ghostwriting task. Confidence = how well the data supported the answer.`

                : `You are ghostwriting a job application answer for a real candidate applying via ${platform.toUpperCase()}.
Write a genuine, specific, human answer based on the candidate data below.

${platformNote}
QUESTION: "${questionLabel}"

RULES:
1. ALWAYS produce a real answer — every professional question is answerable from the data.
2. Be SPECIFIC: name real job titles, companies, technologies, projects, or numbers from the data.
3. Write in FIRST PERSON — never say "the candidate" or reference yourself in third person.
4. Sound like a confident human, not a template or AI output.
5. Do NOT open with: "I am passionate", "I believe", "I am excited", "As a", "Based on my CV".
6. Do NOT open by naming the company or job title first (e.g., "At [Company]," or "As a [Role],").
   Start with an action, impact, or concrete detail instead.
7. LENGTH: match the question scope — ${styleGuide}.

${cvSection}
Return ONLY valid JSON: {"answer":"string","confidence":0.0-1.0}
Confidence ≥ 0.85 means you used real data. This is always answerable — never return empty.`;

            try {
                const response = await this.callGemini(prompt, platform === 'generic' ? 0.15 : 0.1);
                const result = JSON.parse(response);
                if (result.answer && result.answer.trim().length > 10) {
                    return result.answer.trim();
                }
                return null;
            } catch (e) {
                console.error('[QuickApply AI] CV answer failed:', e);
                return null;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CV-BASED OPTION SELECTOR
        // For unknown dropdown/combobox fields with paragraph-length options.
        // Reads the candidate CV and picks the option that best matches their experience.
        // Used for job-specific experience-level selectors (e.g. Greenhouse custom questions
        // like "Scalable Data Architecture" or "AI-Driven Development").
        // ─────────────────────────────────────────────────────────────────
        async selectOptionFromCV(questionLabel, options, cvText, platform = 'generic', profileContext = '') {
            // FIX-5: allow profile context as fallback when no CV is uploaded
            if (!this.apiKey || (!cvText && !profileContext) || !options || options.length === 0) return null;

            const hasCv = cvText && cvText.trim().length > 50;
            const candidateSection = hasCv
                ? `\nCANDIDATE CV:\n"""\n${cvText.substring(0, 8000)}\n"""\n`
                : `\nCANDIDATE PROFILE SUMMARY (no CV uploaded — use structured data only):\n${profileContext}\n`;
            const profileSection = hasCv && profileContext
                ? `\nCANDIDATE PROFILE SUMMARY (structured data — use this to calibrate experience level):\n${profileContext}\n`
                : '';

            const prompt =
`You are filling a dropdown on a job application on behalf of a candidate.
PLATFORM: ${platform.toUpperCase()}
QUESTION: "${questionLabel}"
${profileSection}${candidateSection}
AVAILABLE OPTIONS (select exactly one):
${options.map((o, i) => `${i + 1}. "${o}"`).join('\n')}

TASK: Read the question and candidate data carefully. Select the option that BEST describes the candidate's actual experience or situation.
- Match experience LEVEL from the data to the option that most accurately fits.
- Do NOT over-inflate or under-sell — pick the closest truthful match.
- EXACT COPY REQUIRED: Copy the chosen option text CHARACTER FOR CHARACTER from the numbered list.
  Any difference in spacing, capitalization, or punctuation will break the match.
- If no option is a clear fit, return the most neutral or lowest-commitment option.

Return ONLY valid JSON (no markdown): {"selectedOption":"exact option text from list","confidence":0.0-1.0}`;

            try {
                const response = await this.callGemini(prompt, 0.1);
                const result = JSON.parse(response);
                if (result.selectedOption && options.includes(result.selectedOption) && result.confidence >= 0.4) {
                    return result.selectedOption;
                }
                return null;
            } catch (e) {
                console.error('[QuickApply AI] CV option select failed:', e);
                return null;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // AI CV EXTRACTION (Improvement 1)
        // Sends raw CV text to Gemini and gets back a structured profile JSON.
        // Used by the "Re-parse with AI" button in the dashboard.
        // Only fields with real values are returned — nulls are omitted so the
        // caller can safely merge without overwriting existing profile data.
        // ─────────────────────────────────────────────────────────────────
        async extractFromCV(cvText) {
            if (!this.apiKey || !cvText) return null;

            const prompt =
`You are an expert resume parser. Extract structured profile data from the CV text below.

Return ONLY valid JSON with the fields you can confidently identify. Omit any field you cannot find.
Use null for fields you cannot determine. Do NOT guess or fabricate values.

HUMAN VOICE RULES (apply to all text you write — descriptions, summaries, cover letter):
- Write in natural first-person voice, like a confident professional wrote it themselves.
- Sound authentic and grounded. Use specific facts, real numbers, concrete examples from the CV.
- AVOID these AI-detectable phrases: "I am thrilled", "I am excited to", "I am passionate about",
  "leverage", "spearhead", "synergize", "dynamic", "innovative", "cutting-edge", "results-driven",
  "detail-oriented", "collaborative environment", "seasoned professional", "proven track record",
  "I would be remiss", "delve", "embark", "honed my skills", "pivotal role".
- Use varied sentence lengths. Be direct. No filler phrases.

PROFILE SCHEMA (extract as many as possible):
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phone": "string",
  "city": "string",
  "state": "string",
  "country": "string",
  "zipCode": "string",
  "linkedIn": "string (full URL)",
  "github": "string (full URL)",
  "portfolio": "string (full URL)",
  "currentJobTitle": "string (most recent title)",
  "currentCompany": "string (most recent employer)",
  "yearsOfExperience": "string (e.g. '8' or '8 years')",
  "highestEducation": "string (e.g. 'Bachelor\\'s', 'Master\\'s', 'Doctorate')",
  "university": "string (most recent institution)",
  "major": "string",
  "graduationYear": "string (4-digit year)",
  "gpa": "string",
  "skills": "string (comma-separated list)",
  "certifications": "string (comma-separated list)",
  "languages": "string (comma-separated list)",
  "workExperience": [
    {
      "jobTitle": "string",
      "company": "string",
      "jobType": "string (Full-time | Part-time | Contract | Freelance | Internship)",
      "location": "string (City, State or Remote)",
      "startDate": "string (MM/YYYY)",
      "endDate": "string (MM/YYYY — omit if currentlyWorking)",
      "currentlyWorking": "boolean",
      "description": "string (3-5 sentences in natural first-person voice — key responsibilities, tools used, concrete achievements with numbers where available. No bullet points.)"
    }
  ],
  "educationHistory": [
    {
      "degree": "string (e.g. Bachelor of Science, Master of Arts)",
      "major": "string",
      "school": "string",
      "startDate": "string (MM/YYYY or YYYY)",
      "endDate": "string (MM/YYYY or YYYY — omit if currentlyStudying)",
      "currentlyStudying": "boolean",
      "gpa": "string (omit if not on CV)"
    }
  ],
  "coverLetter": "string (3 paragraphs, general-purpose, works for any job. Para 1: who you are and what you bring. Para 2: your top 2-3 accomplishments with specifics from the CV. Para 3: brief closing. Natural first-person voice — no AI buzzwords. 200-280 words total.)"
}

CV TEXT:
"""
${cvText.substring(0, 14000)}
"""

Return ONLY valid JSON matching the schema above. Omit fields you cannot find with confidence.
Arrays must have at least 1 entry if the data exists in the CV (list ALL jobs and degrees found).`;

            try {
                const response = await this.callGemini(prompt, 0.1);
                const result = JSON.parse(response);
                // Strip null/empty scalar values; keep arrays and booleans as-is
                const cleaned = {};
                for (const [k, v] of Object.entries(result)) {
                    if (Array.isArray(v) && v.length > 0) {
                        cleaned[k] = v;
                    } else if (v && String(v).trim() && v !== 'null') {
                        cleaned[k] = String(v).trim();
                    }
                }
                return Object.keys(cleaned).length > 0 ? cleaned : null;
            } catch (e) {
                console.error('[QuickApply AI] CV extraction failed:', e);
                return null;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // GEMINI API CALLER
        // ─────────────────────────────────────────────────────────────────
        /**
         * Send ALL form fields to Gemini in one call. Returns [{fingerprint, answer}].
         * This is the precision core: answers every field (including custom/essay) at once.
         */
        async callGeminiBatch(fieldRules, profile, resumeText, jobContext = {}) {
            if (!fieldRules || fieldRules.length === 0) return [];

            // Strip binary/large fields — cvData is a base64 PDF (100–500 KB) that would
            // blow the context window. cvText and resumeText are the same data, passed separately.
            const { cvData: _cd, cvText: _ct, cvHash: _ch, ...profileForPrompt } = profile;

            // ── Phone format hint based on applicant's country ────────────────────
            const countryLower = (profile.country || '').toLowerCase();
            const phoneHint = /united kingdom|uk|gb/.test(countryLower) ? '+44 7XXX XXXXXX or 07XXX XXXXXX'
                : /australia|au/.test(countryLower) ? '+61 4XX XXX XXX or 04XX XXX XXX'
                : /canada|ca/.test(countryLower) ? '(XXX) XXX-XXXX'
                : /germany|de/.test(countryLower) ? '+49 XXX XXXXXXXX'
                : /united states|us|usa/.test(countryLower) ? '(XXX) XXX-XXXX'
                : 'international format with + country code';

            // ── "How did you hear about us" default ───────────────────────────────
            const heardAboutUs = profile.heardAboutUs
                ? `use this exact value: "${profile.heardAboutUs}"`
                : 'answer "Online job board"';

            // ── Salary currency hint ───────────────────────────────────────────────
            const currency = profile.salaryCurrency || 'USD';

            // ── Job context section ───────────────────────────────────────────────
            const jobContextBlock = (jobContext.companyName || jobContext.jobTitle || jobContext.jobDescription)
                ? `\nJOB BEING APPLIED FOR:
Company: ${jobContext.companyName || 'Not identified'}
Role: ${jobContext.jobTitle || 'Not identified'}${jobContext.jobDescription ? `\nJob Description (use for tailoring answers):\n${jobContext.jobDescription}` : ''}\n`
                : '';

            // ── Work experience history for AI context ────────────────────────────────
            const workExpBlock = Array.isArray(profile.workExperience) && profile.workExperience.length > 0
                ? '\nWORK EXPERIENCE HISTORY (most recent first):\n' +
                  profile.workExperience.map((e, i) =>
                      `${i+1}. ${e.jobTitle || 'Role'} at ${e.company || 'Company'}` +
                      ` (${e.startDate || '?'} – ${e.currentlyWorking ? 'Present' : (e.endDate || '?')})` +
                      (e.jobType ? ` | ${e.jobType}` : '') +
                      (e.location ? ` | ${e.location}` : '') +
                      (e.description ? `\n   ${e.description.substring(0, 400)}` : '')
                  ).join('\n')
                : '';

            const eduBlock = Array.isArray(profile.educationHistory) && profile.educationHistory.length > 0
                ? '\nEDUCATION HISTORY:\n' +
                  profile.educationHistory.map((e, i) =>
                      `${i+1}. ${e.degree || ''} in ${e.major || ''} – ${e.school || ''}` +
                      ` (${e.startDate || '?'} – ${e.currentlyStudying ? 'Present' : (e.endDate || '?')})` +
                      (e.gpa ? ` | GPA: ${e.gpa}` : '')
                  ).join('\n')
                : '';

            // ── Target job context ────────────────────────────────────────────────────
            const targetBlock = profile.targetJobTitle
                ? `\nTARGET ROLE: ${profile.targetJobTitle}${profile.targetJobFunction ? ` (${profile.targetJobFunction})` : ''}${profile.targetExperienceLevel?.length ? ` | Level: ${profile.targetExperienceLevel.join(', ')}` : ''}\n`
                : '';

            const prompt = `You are filling a job application form on behalf of the applicant.
Answer every field accurately using the profile, resume, and job context provided.

APPLICANT PROFILE:
${JSON.stringify(profileForPrompt, null, 2)}

RESUME TEXT:
${resumeText || '(no resume text available)'}
${targetBlock}${workExpBlock}${eduBlock}${jobContextBlock}
FORM FIELDS TO ANSWER:
${fieldRules.map((r, i) => {
    // Pull surrounding page text so AI understands the full question (helper text,
    // sub-labels, section headings). Strips the field's own value to avoid noise.
    let ctx = '';
    try {
        const container = r.element?.closest?.(
            '[class*="question"], [class*="field"], [class*="form-group"], fieldset, li, tr, .section'
        ) || r.element?.parentElement?.parentElement;
        if (container) {
            ctx = container.textContent?.replace(/\s+/g, ' ').trim().substring(0, 250) || '';
            if (ctx === r.label) ctx = ''; // don't repeat if same as label
        }
    } catch (_) {}
    return `[id ${i + 1}] Label: "${r.label}"
   Type: ${r.type}
   ${r.options?.length ? `Options: ${r.options.join(' | ')}` : 'Free text (no options)'}
   Required: ${r.required}${ctx && ctx !== r.label ? `\n   Context: "${ctx}"` : ''}`;
}).join('\n\n')}

STRICT FORMATTING RULES — follow exactly:
- select/radio: value MUST exactly match one of the listed Options
- checkbox: return an array of matching option strings ["Option A", "Option B"]
- phone number fields: use format ${phoneHint} — match placeholder if visible
- salary/compensation/pay: return a plain integer — no currency symbol, no commas, no "k" (e.g. 85000). If a range is needed: "80000-95000". Currency is ${currency}.
- notice period / when can you start / availability: use profile noticePeriod value if set; otherwise "Immediately" if not currently employed, "1 month" if employed
- "how did you hear" / "referral source" / "how did you find": ${heardAboutUs}
- cover letter / "why [company]?" / "why this role?": write 2–3 tailored paragraphs. Mention ${jobContext.companyName || 'the company'} and ${jobContext.jobTitle || 'the role'} by name. Match specific skills from the resume to the job description requirements.
- essay questions about experience: be specific, include quantified achievements from the resume
- text/textarea (other): concise, professional, first person
- HUMAN VOICE (all text fields): sound like a real professional, not AI. Avoid "I am thrilled/excited/passionate", "leverage", "spearhead", "synergize", "dynamic", "innovative", "cutting-edge", "results-driven", "detail-oriented", "proven track record", "delve", "embark". Use specific facts and natural varied sentence lengths.
- If genuinely unknown and not in profile: return ""
- Answer EVERY field — do not skip any

Return ONLY a valid JSON array — no markdown, no explanation, no code fences:
[{"id":<the [id N] number of the field>,"value":"<answer>"}, ...]
Every object MUST include the exact numeric "id" shown in brackets for the field it answers. Do not renumber, reorder, or omit ids.`;

            const raw = await this.callGemini(prompt, 0.2);

            // Parse and map back to fingerprints
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (_) {
                // Retry with stricter prompt
                const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY the JSON array. No other text whatsoever.';
                try {
                    const raw2 = await this.callGemini(retryPrompt, 0.0);
                    parsed = JSON.parse(raw2);
                } catch (_2) {
                    console.warn('[QuickApply AI] Batch parse failed, falling back to empty:', raw.slice(0, 200));
                    return [];
                }
            }

            if (!Array.isArray(parsed)) return [];

            const _normLabel = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            const _tokens = s => _normLabel(s).split(' ').filter(t => t.length > 3);

            // Track which rules are already claimed so a duplicate/ambiguous label can't
            // overwrite an answer that was correctly placed by id.
            const _claimed = new Set();

            return parsed.map(item => {
                if (!item || typeof item !== 'object') return null;
                let rule = null;

                // 1. Primary: map by the explicit numeric id we sent ([id N], 1-based).
                // Robust against Gemini rephrasing/trimming labels or duplicate labels.
                const idNum = Number(item.id);
                if (Number.isInteger(idNum) && idNum >= 1 && idNum <= fieldRules.length) {
                    const candidate = fieldRules[idNum - 1];
                    if (candidate && !_claimed.has(candidate)) rule = candidate;
                }

                // 2-4. Fallback to label matching only when id is missing/invalid
                // (older prompt cache, or model dropped the id).
                if (!rule && item.label) {
                    // Exact, then normalized-exact, then token overlap ≥ 0.7
                    rule = fieldRules.find(r => r.label === item.label && !_claimed.has(r));
                    if (!rule) {
                        const normTarget = _normLabel(item.label);
                        rule = fieldRules.find(r => _normLabel(r.label) === normTarget && !_claimed.has(r));
                    }
                    if (!rule) {
                        const targetToks = new Set(_tokens(item.label));
                        if (targetToks.size >= 2) {
                            let bestScore = 0;
                            let bestRule = null;
                            for (const r of fieldRules) {
                                if (_claimed.has(r)) continue;
                                const rToks = _tokens(r.label);
                                if (!rToks.length) continue;
                                const overlap = rToks.filter(t => targetToks.has(t)).length;
                                const score = overlap / Math.max(rToks.length, targetToks.size);
                                if (score > bestScore) { bestScore = score; bestRule = r; }
                            }
                            if (bestScore >= 0.7) rule = bestRule;
                        }
                    }
                }

                if (!rule) return null;
                _claimed.add(rule);
                return { fingerprint: rule.fingerprint, answer: item.value };
            }).filter(Boolean);
        }

        async callGemini(prompt, temperature = 0.1) {
            const url = `${API_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`;
            const body = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature
                }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                throw new Error(`Gemini API Error: ${response.status} — ${errorBody.slice(0, 200)}`);
            }

            const data = await response.json();

            // Track token usage (fire-and-forget)
            const usage = data?.usageMetadata;
            if (usage) {
                chrome.storage.local.get('quickapply_ai_usage').then(res => {
                    const cur = res.quickapply_ai_usage || { tokensIn: 0, tokensOut: 0, calls: 0 };
                    cur.tokensIn  = (cur.tokensIn  || 0) + (usage.promptTokenCount     || 0);
                    cur.tokensOut = (cur.tokensOut || 0) + (usage.candidatesTokenCount || 0);
                    cur.calls     = (cur.calls     || 0) + 1;
                    chrome.storage.local.set({ quickapply_ai_usage: cur });
                }).catch(() => {});
            }

            // Guard against empty or malformed response
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Gemini returned empty response');

            // Strip markdown code fences Gemini sometimes wraps JSON in
            return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        }

        // ─────────────────────────────────────────────────────────────────
        // BATCH FORM FILL
        // One AI call for the entire form. Receives all fields with labels,
        // types, and available options. Returns exact values — no fuzzy
        // matching needed, no per-field round trips.
        // ─────────────────────────────────────────────────────────────────
        async batchFillForm(fieldMetas, profile, cvText, profileContext, platform = 'generic') {
            if (!this.apiKey || !fieldMetas || fieldMetas.length === 0) return [];

            const lines = [];
            const add = (k, v) => { if (v && String(v).trim()) lines.push(`${k}: ${String(v).trim()}`); };
            add('Full Name', [profile.firstName, profile.lastName].filter(Boolean).join(' '));
            add('Email', profile.email);
            add('Phone', profile.phone);
            add('Location', [profile.city, profile.state, profile.country].filter(Boolean).join(', '));
            add('Work Authorization', profile.workAuthorization);
            add('Live in US', profile.liveInUS);
            add('Years Experience', profile.yearsExperience);
            add('Current Title', profile.currentTitle || profile.jobTitle);
            add('Current Company', profile.currentCompany);
            add('Desired Salary', profile.desiredSalary);
            add('Remote Preference', profile.remotePreference);
            add('Willing to Relocate', profile.willingToRelocate);
            add('Employment Type', profile.desiredEmploymentType);
            add('LinkedIn', profile.linkedIn);
            add('GitHub', profile.github);
            add('Portfolio', profile.portfolio);
            add('Highest Education', profile.highestEducation);
            add('University', profile.university);
            add('Graduation Year', profile.graduationYear);
            add('Degree', profile.degree);
            add('Gender', profile.gender);
            add('Race/Ethnicity', profile.race);
            add('Veteran Status', profile.veteranStatus);
            add('Disability Status', profile.disabilityStatus);
            if (profileContext) lines.push('---', profileContext.substring(0, 800));

            const cvSection = cvText && cvText.trim().length > 50
                ? `\nCANDIDATE CV:\n"""\n${cvText.substring(0, 4000)}\n"""\n`
                : '';

            const fieldsJson = JSON.stringify(fieldMetas.map(f => {
                const entry = { id: f.id, label: f.label, type: f.type };
                if (f.options && f.options.length > 0) entry.options = f.options;
                if (f.required) entry.required = true;
                return entry;
            }));

            const prompt =
`You are filling a ${platform.toUpperCase()} job application for a candidate. Return exact values.

CANDIDATE:
${lines.join('\n')}
${cvSection}
RULES:
1. select / radio / combobox: "value" must be EXACT text of one listed option (copy character-for-character)
2. checkbox-group: "values" array of exact option texts to check (all that apply)
3. text / textarea: concise accurate content from profile/CV
4. EEO fields (gender, race, disability, veteran): use "Prefer not to say" or equivalent if listed, else ""
5. Work authorization — TWO SEPARATE answers from one profile field:
   "Right to work in US" / "Authorized to work" → ALWAYS YES regardless of
     workAuthorization value. The candidate is applying to a US job; they intend
     to work in the US. No is the dismissal trigger for the recruiter.
   "Will you require visa sponsorship now or in the future?" →
   - "US Citizen" / "Green Card" / "Permanent Resident" → NO sponsorship.
   - "OPT" / "H1B" / "F-1" / "TN" / "J-1" / "E-3" / "L-1" / "L-2" / "EAD" / "STEM" → YES.
   - "Require Sponsorship" / "Need Visa" / "Seeking Sponsorship" → YES.
   - "Right to Work" alone (no other visa info) → YES (ambiguous, safer default).
   NEVER conclude "no sponsorship needed" without an explicit Citizen / Green
   Card / Permanent Resident signal.
6. If unsure: return "value": "" to skip — do NOT guess
7. Return ONLY a JSON array, no markdown, no explanation

FORM FIELDS:
${fieldsJson}

Response format: [{"id":1,"value":"..."},{"id":2,"value":"..."},{"id":3,"values":["..."]}]`;

            try {
                const response = await this.callGemini(prompt, 0.0);
                const results = JSON.parse(response);
                return Array.isArray(results) ? results : [];
            } catch (e) {
                console.error('[QuickApply AI] Batch fill failed:', e);
                return [];
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // FIT-SCORE BATCH (title + skills)
        // Single Gemini call that scores how well a candidate's target
        // roles/skills line up with a JD. Title and skills are batched
        // because they share the same JD context — one call, two scores.
        // ─────────────────────────────────────────────────────────────────
        async fitScoreBatch({ jdText, jdTitle, jdLocation, targetRoles, clientSkills, clientPreferredLocations, candidateYearsOfExperience, locationRadiusMiles, paramsToScore }) {
            if (!this.apiKey) throw new Error('NO_API_KEY');
            if (!Array.isArray(paramsToScore) || paramsToScore.length === 0) {
                throw new Error('NO_PARAMS');
            }

            const wantsTitle = paramsToScore.includes('title');
            const wantsSkills = paramsToScore.includes('skills');
            const wantsYoE = paramsToScore.includes('yoe');
            const wantsLocation = paramsToScore.includes('location');
            const keyDescriptions = [];
            if (wantsTitle) keyDescriptions.push('titleScore (0-100 integer), titleReason (one short sentence)');
            if (wantsSkills) keyDescriptions.push('skillsScore (0-100 integer), skillsReason (one short sentence), missingSkills (string array of skills the candidate lacks vs the JD)');
            if (wantsYoE) keyDescriptions.push('yoeEstimate (integer 0-30: years of experience this JD expects; INFER HARD when the JD has no explicit number — use seniority cues like "Senior" / "Staff" / "Lead" / "Principal" / "Director", scope of ownership, team size led, salary band, and required tech depth; only return null if the JD has ABSOLUTELY no seniority signal), yoeReason (one short sentence explaining how you inferred it), considerAnyway (boolean: when there is a mismatch between the candidate\'s yearsOfExperience and the inferred yoeEstimate, set true ONLY if the CV demonstrates seniority-level skills/scope that compensate — e.g. led a team, founded a company, owned a product end-to-end, deep technical achievements; false otherwise), considerAnywayReason (one short sentence supporting the considerAnyway decision; required when considerAnyway is set)');
            if (wantsLocation) keyDescriptions.push('locationMatch (boolean), locationReason (one short sentence)');

            const radius = Number.isFinite(locationRadiusMiles) && locationRadiusMiles >= 0 ? Math.min(locationRadiusMiles, 500) : 50;
            const locationContext = wantsLocation
                ? `\nJob location: ${JSON.stringify(jdLocation || '')}\nCandidate preferred locations: ${JSON.stringify(clientPreferredLocations || [])}\nUniversal commute radius: ${radius} miles\n\nLocation-match rules — be STRICT, the candidate-preferred locations are authoritative and you must NOT broaden them beyond the explicit radius:\n  * locationMatch = true if the JD location is geographically INSIDE one of the listed candidate locations.\n  * locationMatch = true ALSO if the JD location is within ${radius} straight-line miles of any of the listed candidate locations (use your built-in geographic knowledge to estimate distance between named cities/metros/towns).\n  * Examples assuming the candidate pref is "Silver Spring, Maryland" and radius=${radius}: a JD in "Washington, DC" (~6 mi) → true; "Bethesda, MD" (~5 mi) → true; "Baltimore, MD" (~32 mi) → true if radius>=35; "Richmond, VA" (~108 mi) → false at radius=50; "New York, NY" (~225 mi) → false at any radius<200.\n  * A US state pref (e.g. "California") matches cities within that state plus anything within ${radius} miles of the state border into a neighboring state.\n  * A metro/region pref ("Bay Area") matches cities inside that metro and within ${radius} miles of the metro core.\n  * A country-level pref ("USA", "United States", "Remote - US", "Anywhere in the US") matches any city in that country.\n  * Common abbreviations resolve naturally ("NYC" = "New York", "SF" = "San Francisco", "DC" = "Washington").\n  * "Remote" alone matches a JD that lists Remote / Anywhere — not a specific in-office city in a non-listed region (radius does not apply to Remote).\n  * If the JD lists multiple locations and any one passes (inside a pref OR within ${radius} miles of one), that is a true match.\n  * NEVER assume the candidate would commute farther than ${radius} miles even if the JD is "close" to the country/state. ${radius}-mile rule is the hard ceiling.\n  * In the locationReason, if the radius rule was what tipped it to true, say so explicitly (e.g. "Washington DC is ~6 miles from Silver Spring (within 50-mile radius)").\n`
                : '';

            const prompt = `You score how well a candidate fits a job posting on the requested parameters.
Return JSON with exactly these keys: ${keyDescriptions.join(', ')}.

Job title: ${JSON.stringify(jdTitle || '')}
Candidate target roles: ${JSON.stringify(targetRoles || [])}
Candidate skills: ${JSON.stringify(clientSkills || [])}
Candidate years of experience: ${JSON.stringify(candidateYearsOfExperience ?? null)}
${locationContext}
Job description (truncated):
${String(jdText || '').slice(0, 12000)}

Output JSON only, no markdown, no commentary.`;

            const raw = await this.callGemini(prompt, 0.1);
            return JSON.parse(raw);
        }
    }

    const target = (typeof window !== 'undefined') ? window : self;
    target.QuickApplyAI = new QuickApplyAI();
})();
