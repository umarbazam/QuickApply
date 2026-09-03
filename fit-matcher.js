/**
 * QuickApply — FitMatcher: scores a JdObject against a client profile.
 * This file: hard parameters. Soft params + overall score added in Task 7.
 */
(function () {
    'use strict';

    // ── Helpers ──────────────────────────────────────────────────────
    const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    const LOCATION_ALIASES = {
        'nyc': 'new york',
        'new york city': 'new york',
        'sf': 'san francisco',
        'la': 'los angeles',
        'dc': 'washington',
        'bay area': 'san francisco'
    };
    function _canonLoc(s) {
        const n = _norm(s);
        return LOCATION_ALIASES[n] || n;
    }

    // ── US locality recognition ──────────────────────────────────────
    // "United States" / "USA" / "Nationwide" in preferredLocations should
    // match any US city or state in a JD — otherwise NYC, San Francisco,
    // Austin etc. fail against a candidate explicitly open to "United
    // States". Build a single source of truth: the country aliases that
    // count as US-anywhere, and the city/state tokens we recognise.
    const US_COUNTRY_ALIASES = new Set([
        'united states', 'usa', 'u s a', 'us', 'u s', 'america',
        'united states of america', 'us nationwide', 'nationwide',
        'anywhere in us', 'anywhere in usa', 'us remote', 'remote us',
        'remote united states', 'remote usa',
        'any where in us', 'any where in usa'
    ]);
    const US_STATE_NAMES = [
        'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
        'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
        'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
        'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
        'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
        'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
        'virginia','washington','west virginia','wisconsin','wyoming','district of columbia',
        'washington dc','puerto rico'
    ];
    const US_STATE_ABBREVS = [
        'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky',
        'la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd',
        'oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc','pr'
    ];
    // Major US cities (top metros + every city that's appeared in JDs we
    // process). Add freely as we encounter more — false positives here are
    // limited to legitimately-US cities, and false negatives just fall back
    // to AI verification.
    const US_MAJOR_CITIES = [
        'new york','san francisco','los angeles','chicago','houston','phoenix','philadelphia',
        'san antonio','san diego','dallas','san jose','austin','jacksonville','fort worth',
        'columbus','indianapolis','charlotte','seattle','denver','washington','boston',
        'el paso','nashville','detroit','oklahoma city','portland','las vegas','memphis',
        'louisville','baltimore','milwaukee','albuquerque','tucson','fresno','sacramento',
        'kansas city','mesa','atlanta','omaha','colorado springs','raleigh','miami','oakland',
        'minneapolis','tulsa','arlington','tampa','new orleans','wichita','cleveland',
        'bakersfield','aurora','anaheim','honolulu','santa ana','riverside','corpus christi',
        'lexington','stockton','henderson','saint paul','st louis','cincinnati','pittsburgh',
        'greensboro','anchorage','plano','lincoln','orlando','irvine','newark','toledo',
        'durham','chula vista','fort wayne','jersey city','st petersburg','laredo',
        'madison','chandler','buffalo','lubbock','scottsdale','reno','glendale','gilbert',
        'winston salem','north las vegas','norfolk','chesapeake','garland','irving',
        'hialeah','fremont','boise','richmond','baton rouge','spokane','des moines',
        'tacoma','san bernardino','modesto','fontana','santa clarita','birmingham',
        'oxnard','fayetteville','moreno valley','rochester','glendale','huntington beach',
        'salt lake city','grand rapids','amarillo','yonkers','aurora','montgomery',
        'akron','little rock','huntsville','augusta','port st lucie','grand prairie',
        'columbus','tallahassee','overland park','tempe','mckinney','mobile','cape coral',
        'shreveport','frisco','knoxville','worcester','brownsville','vancouver',
        'fort lauderdale','sioux falls','ontario','chattanooga','providence','newport news',
        'rancho cucamonga','santa rosa','peoria','oceanside','elk grove','salem',
        'pembroke pines','eugene','garden grove','cary','fort collins','corona',
        'springfield','jackson','alexandria','hayward','clarksville','lakewood',
        'lancaster','salinas','palmdale','hollywood','springfield','macon','kansas city',
        'sunnyvale','pomona','killeen','escondido','pasadena','naperville','bellevue',
        'joliet','murfreesboro','midland','rockford','paterson','savannah','bridgeport',
        'torrance','mcallen','syracuse','surprise','denton','roseville','thornton',
        'miramar','pasadena','mesquite','olathe','dayton','carrollton','waco','orange',
        'fullerton','charleston','west valley city','visalia','hampton','gainesville',
        'warren','coral springs','cedar rapids','round rock','sterling heights',
        'kent','columbia','santa clara','new haven','stamford','concord','elizabeth',
        'thousand oaks','lafayette','simi valley','topeka','norman','fairfield','athens',
        'hartford','victorville','berkeley','ann arbor','allentown','richardson',
        'odessa','arvada','cambridge','sugar land','beaumont','lansing','evansville',
        'rochester','independence','fargo','wilmington','provo','antioch','wilmington',
        'manchester','vallejo','las cruces','springfield','clearwater','san leandro',
        'el monte','high point','clovis','tyler','college station','meridian','west jordan',
        'pearland','dearborn','livonia','green bay'
    ];
    const US_TOKENS = new Set([
        ...US_STATE_NAMES,
        ...US_STATE_ABBREVS,
        ...US_MAJOR_CITIES
    ]);
    const US_TEXT_TOKENS = new Set([
        ...US_STATE_NAMES,
        ...US_MAJOR_CITIES
    ]);
    function _isUsCountryPref(p) {
        const n = _norm(p);
        if (US_COUNTRY_ALIASES.has(n)) return true;
        // Recognise variants like "general united states", "anywhere in the US",
        // "remote (united states)" — the candidate clearly accepts the whole
        // country. Match the country phrase as a substring of the pref.
        return /\bunited states\b|\busa\b|\bus nationwide\b|\bnationwide\b|\banywhere\b.*\b(us|usa|united states)\b/.test(n);
    }
    function _isUsToken(tok) {
        const n = _norm(tok);
        if (!n) return false;
        if (US_TOKENS.has(n)) return true;
        // "san francisco ca" / "new york ny" — strip trailing state abbrev
        const m = n.match(/^(.+?)\s+([a-z]{2})$/);
        if (m) {
            if (US_STATE_ABBREVS.includes(m[2])) return true;
            if (US_TOKENS.has(m[1])) return true;
        }
        return false;
    }
    function _containsUsToken(text) {
        const n = _norm(text);
        if (!n) return false;
        if (_isUsToken(n)) return true;
        return Array.from(US_TEXT_TOKENS).some(tok => new RegExp(`\\b${tok}\\b`, 'i').test(n));
    }
    // The JD may name only the country ("USA - Remote", "United States",
    // "US") with no city/state. US_TOKENS/US_TEXT_TOKENS deliberately omit the
    // bare country word, so those checks miss it — recognise it explicitly so a
    // candidate open to "Remote USA"/"United States" matches a country-only JD.
    function _isUsCountryLoc(text) {
        const n = _norm(text);
        if (!n) return false;
        return /\b(usa|us|u s a|united states|united states of america|america)\b/.test(n);
    }

    // ── Visa ─────────────────────────────────────────────────────────
    const VISA_REFUSAL = /\b(no sponsorship|not able to sponsor|cannot sponsor|do not sponsor|not offer sponsorship|without sponsorship|must be authorized to work (?:in [^.]*)?without sponsorship)\b/i;
    const VISA_OFFER = /\b(sponsorship (?:is )?available|we sponsor|will sponsor|able to sponsor|visa sponsorship)\b/i;

    function scoreVisa(jd, profile) {
        const auth = profile.workAuthorization || '';
        if (auth !== 'Require Sponsorship') {
            return { key: 'visa', label: 'Visa', kind: 'hard', status: 'pass', score: 100,
                     reason: `Auth: ${auth || 'No sponsorship needed'}`, aiUsed: false };
        }
        const text = jd.visaText || '';
        if (VISA_REFUSAL.test(text)) {
            return { key: 'visa', label: 'Visa', kind: 'hard', status: 'fail', score: 0,
                     reason: 'JD explicitly does not offer sponsorship', aiUsed: false };
        }
        if (VISA_OFFER.test(text)) {
            return { key: 'visa', label: 'Visa', kind: 'hard', status: 'pass', score: 100,
                     reason: 'JD offers sponsorship', aiUsed: false };
        }
        return { key: 'visa', label: 'Visa', kind: 'hard', status: 'manual', score: null,
                 reason: 'JD does not mention sponsorship — verify manually', aiUsed: false };
    }

    // ── Location ─────────────────────────────────────────────────────
    function scoreLocation(jd, profile) {
        const rawPrefs = Array.isArray(profile.preferredLocations)
            ? profile.preferredLocations
            : String(profile.preferredLocations || '').split(',');
        const prefs = rawPrefs.map(p => String(p || '').trim()).filter(Boolean);
        if (prefs.length === 0) {
            return { key: 'location', label: 'Location', kind: 'hard', status: 'pass', score: 100,
                     reason: 'No location preferences set', aiUsed: false };
        }
        // Treat any pref containing "remote" as a remote preference, not just
        // the bare word — "Remote USA", "Remote (US)", "Open to remote" all
        // signal the candidate accepts a remote JD.
        const wantsRemote = prefs.some(p => /\bremote\b/i.test(p.trim()));
        const flags = jd.locationFlags || {};
        if (wantsRemote && flags.isRemote) {
            return { key: 'location', label: 'Location', kind: 'hard', status: 'pass', score: 100,
                     reason: 'Remote ✓', aiUsed: false };
        }
        // JD didn't expose a location AND no remote/hybrid/onsite flag — we can't
        // compare against nothing. Mark manual instead of failing the whole verdict.
        const jdLoc = _canonLoc(jd.location || '');
        if (!jdLoc && !flags.isRemote && !flags.isHybrid && !flags.isOnsite) {
            return { key: 'location', label: 'Location', kind: 'hard', status: 'manual', score: null,
                     reason: 'JD does not list a location — verify manually', aiUsed: false };
        }
        // Split the RAW jd.location on punctuation/conjunctions BEFORE canonicalizing
        // each piece — _canonLoc strips commas, so splitting jdLoc would yield one
        // glued token like "glendale ca usa" that no per-token check can recognize.
        const jdTokens = String(jd.location || '').split(/[\/,;]|\bor\b|\band\b/i).map(_canonLoc).filter(Boolean);
        // Country-level US match: if the candidate accepts "United States" /
        // "USA" / "Nationwide" anywhere in their preferences, recognise any
        // US state/city/abbrev in the JD as a match. Otherwise NYC, SF,
        // Austin, etc. fail against a candidate who's explicitly open to the
        // whole country.
        if (prefs.some(_isUsCountryPref) && (jdTokens.some(_isUsToken) || _containsUsToken(jd.location || '') || _isUsCountryLoc(jd.location || ''))) {
            const _usPref = prefs.find(_isUsCountryPref);
            return { key: 'location', label: 'Location', kind: 'hard', status: 'pass', score: 100,
                     reason: `${jd.location} is in the US — matches "${_usPref}"`, aiUsed: false };
        }
        for (const p of prefs) {
            const cp = _canonLoc(p);
            if (!cp) continue;
            for (const tok of jdTokens) {
                if (tok && (tok.includes(cp) || cp.includes(tok))) {
                    return { key: 'location', label: 'Location', kind: 'hard', status: 'pass', score: 100,
                             reason: `Matches "${p}"`, aiUsed: false };
                }
            }
        }
        // Rules couldn't find a match. Mark for AI confirmation — humans
        // (and Gemini) handle "Bay Area ↔ San Jose", "Remote (US) ↔ Austin",
        // "EMEA ↔ Berlin" etc. far better than substring matching.
        return { key: 'location', label: 'Location', kind: 'hard', status: 'fail', score: 0,
                 reason: `Wants ${prefs.join(', ')}; JD lists ${jd.location || 'unspecified'}`,
                 aiUsed: false, _needsAi: true };
    }

    // ── Work mode ────────────────────────────────────────────────────
    // remotePreference is a comma-joined list of accepted modes:
    // "Remote", "Hybrid", "On-site", "Flexible". Multiple modes mean the
    // candidate is open to any of them. "Flexible" alone (or anywhere in
    // the list) means accept any JD mode.
    function _normMode(s) {
        const n = String(s || '').trim().toLowerCase();
        if (/flex/.test(n)) return 'flexible';
        if (/remote/.test(n)) return 'remote';
        if (/hybrid/.test(n)) return 'hybrid';
        if (/on[- ]?site|in[- ]?office|in[- ]?person/.test(n)) return 'on-site';
        return n;
    }
    function scoreWorkMode(jd, profile) {
        const accepted = String(profile.remotePreference || '')
            .split(',').map(_normMode).filter(Boolean);
        if (!accepted.length) {
            return { key: 'workMode', label: 'Work mode', kind: 'hard', status: 'pass', score: 100,
                     reason: 'No preference', aiUsed: false };
        }
        if (accepted.includes('flexible')) {
            return { key: 'workMode', label: 'Work mode', kind: 'hard', status: 'pass', score: 100,
                     reason: 'Flexible — any mode', aiUsed: false };
        }
        const f = jd.locationFlags || {};
        const jdMode = f.isRemote ? 'remote' : f.isHybrid ? 'hybrid' : f.isOnsite ? 'on-site' : null;
        if (!jdMode) {
            return { key: 'workMode', label: 'Work mode', kind: 'hard', status: 'pass', score: 100,
                     reason: 'JD does not specify mode', aiUsed: false };
        }
        if (accepted.includes(jdMode)) {
            const display = jdMode === 'on-site' ? 'On-site' : jdMode[0].toUpperCase() + jdMode.slice(1);
            return { key: 'workMode', label: 'Work mode', kind: 'hard', status: 'pass', score: 100,
                     reason: `${display} ✓`, aiUsed: false };
        }
        const wantLabels = accepted.map(m => m === 'on-site' ? 'On-site' : m[0].toUpperCase() + m.slice(1));
        const jdLabel = jdMode === 'on-site' ? 'On-site' : jdMode[0].toUpperCase() + jdMode.slice(1);
        return { key: 'workMode', label: 'Work mode', kind: 'hard', status: 'fail', score: 0,
                 reason: `Wants ${wantLabels.join('/')}; JD is ${jdLabel}`, aiUsed: false };
    }

    // ── Employment type ──────────────────────────────────────────────
    const EMP_SYNONYMS = {
        'full-time': ['full-time', 'fulltime', 'full time', 'permanent', 'regular'],
        'part-time': ['part-time', 'parttime', 'part time'],
        'contract':  ['contract', 'contractor', 'consulting', 'temp'],
        'internship':['internship', 'intern', 'co-op']
    };
    function _canonEmp(s) {
        const n = _norm(s);
        for (const [canon, aliases] of Object.entries(EMP_SYNONYMS)) {
            if (aliases.some(a => n.includes(a))) return canon;
        }
        return n;
    }
    function scoreEmploymentType(jd, profile) {
        // Prefer Section 1's multi-select (targetJobType array). Fall back to
        // Section 8's single desiredEmploymentType for backward compat.
        let accepted = Array.isArray(profile.targetJobType)
            ? profile.targetJobType.filter(Boolean)
            : [];
        if (!accepted.length && profile.desiredEmploymentType) {
            accepted = [profile.desiredEmploymentType];
        }
        if (!accepted.length) {
            return { key: 'employmentType', label: 'Employment', kind: 'hard', status: 'pass', score: 100,
                     reason: 'No preference', aiUsed: false };
        }
        if (!jd.employmentType) {
            return { key: 'employmentType', label: 'Employment', kind: 'hard', status: 'manual', score: null,
                     reason: 'JD does not list employment type — verify manually', aiUsed: false };
        }
        const jdCanon = _canonEmp(jd.employmentType);
        if (accepted.some(a => _canonEmp(a) === jdCanon)) {
            return { key: 'employmentType', label: 'Employment', kind: 'hard', status: 'pass', score: 100,
                     reason: `${jd.employmentType} ✓`, aiUsed: false };
        }
        return { key: 'employmentType', label: 'Employment', kind: 'hard', status: 'fail', score: 0,
                 reason: `Wants ${accepted.join('/')}; JD is ${jd.employmentType}`, aiUsed: false };
    }

    // ── Experience Level ─────────────────────────────────────────────
    // Section 1 targetExperienceLevel is a multi-select with values like
    // "Intern/New Grad", "Entry Level 1-3 yrs", "Mid Level 3-5 yrs",
    // "Senior Level 5+ yrs", "Lead/Staff", "Director/Executive".
    // We infer the JD's level from title keywords first (most reliable)
    // and fall back to requiredYoE.min when the title is generic.
    function _normLevel(s) {
        const n = String(s || '').toLowerCase();
        if (/intern|new\s*grad/.test(n)) return 'intern';
        if (/entry/.test(n)) return 'entry';
        if (/mid/.test(n)) return 'mid';
        if (/senior/.test(n)) return 'senior';
        if (/lead|staff|principal/.test(n)) return 'lead';
        if (/director|exec|vp|chief|head\s+of/.test(n)) return 'director';
        return null;
    }
    function _inferJdLevel(jd) {
        const title = String(jd.title || '').toLowerCase();
        if (/\b(intern|internship)\b/.test(title)) return 'intern';
        if (/\b(junior|jr\.?|entry[- ]level|associate)\b/.test(title)) return 'entry';
        if (/\b(senior|sr\.?)\b/.test(title)) return 'senior';
        if (/\b(staff|principal)\b/.test(title)) return 'lead';
        if (/\b(lead|tech\s*lead)\b/.test(title)) return 'lead';
        if (/\b(director|head\s+of|vp|vice\s*president|chief|cto|cfo|ceo)\b/.test(title)) return 'director';
        const min = jd.requiredYoE?.min;
        if (min == null) return null;
        if (min < 1) return 'intern';
        if (min < 3) return 'entry';
        if (min < 5) return 'mid';
        if (min < 8) return 'senior';
        return 'lead';
    }
    const LEVEL_LABEL = { intern: 'Intern/New Grad', entry: 'Entry Level', mid: 'Mid Level',
                          senior: 'Senior Level', lead: 'Lead/Staff', director: 'Director/Executive' };
    // YoE band that qualifies a candidate for each level (inverse of _inferJdLevel
    // fallback). Used to soften a label-only mismatch when the candidate's actual
    // YoE lands inside the JD's level band — the candidate is qualified, just
    // labelled differently.
    const LEVEL_YOE_RANGE = {
        intern:   { min: 0,  max: 1 },
        entry:    { min: 1,  max: 3 },
        mid:      { min: 3,  max: 5 },
        senior:   { min: 5,  max: 8 },
        lead:     { min: 8,  max: 13 },
        director: { min: 12, max: 99 }
    };
    function _yoeQualifiesForLevel(yoe, level) {
        const r = LEVEL_YOE_RANGE[level];
        if (!r || yoe == null || Number.isNaN(yoe)) return false;
        return yoe >= r.min && yoe < r.max;
    }
    function scoreExperienceLevel(jd, profile) {
        const accepted = Array.isArray(profile.targetExperienceLevel)
            ? profile.targetExperienceLevel.map(_normLevel).filter(Boolean)
            : [];
        if (!accepted.length) {
            return { key: 'experienceLevel', label: 'Experience level', kind: 'hard', status: 'pass', score: 100,
                     reason: 'No preference', aiUsed: false };
        }
        const jdLevel = _inferJdLevel(jd);
        if (!jdLevel) {
            return { key: 'experienceLevel', label: 'Experience level', kind: 'hard', status: 'manual', score: null,
                     reason: 'JD does not state seniority — verify manually', aiUsed: false };
        }
        if (accepted.includes(jdLevel)) {
            return { key: 'experienceLevel', label: 'Experience level', kind: 'hard', status: 'pass', score: 100,
                     reason: `${LEVEL_LABEL[jdLevel]} ✓`, aiUsed: false };
        }
        // Label mismatch — soften to 'manual' if the candidate's YoE actually
        // qualifies for the JD's level band. Many "Senior X" postings are open
        // to a 5-yr Mid candidate; the label difference is cosmetic when YoE
        // lines up. We don't auto-pass because the user may genuinely prefer to
        // skip these (e.g. avoiding the Senior management overhead).
        const wantLabels = accepted.map(l => LEVEL_LABEL[l] || l);
        const haveYoE = parseInt(profile.yearsOfExperience, 10);
        if (_yoeQualifiesForLevel(haveYoE, jdLevel)) {
            return { key: 'experienceLevel', label: 'Experience level', kind: 'hard', status: 'manual', score: null,
                     reason: `Wants ${wantLabels.join('/')}; JD is ${LEVEL_LABEL[jdLevel]} — but ${haveYoE} yrs YoE qualifies for ${LEVEL_LABEL[jdLevel]}. Verify.`,
                     aiUsed: false };
        }
        return { key: 'experienceLevel', label: 'Experience level', kind: 'hard', status: 'fail', score: 0,
                 reason: `Wants ${wantLabels.join('/')}; JD is ${LEVEL_LABEL[jdLevel] || jdLevel}`, aiUsed: false };
    }

    // ── Master ───────────────────────────────────────────────────────
    function scoreHard(jd, profile) {
        const params = [
            scoreVisa(jd, profile),
            scoreLocation(jd, profile),
            scoreWorkMode(jd, profile),
            scoreEmploymentType(jd, profile),
            scoreExperienceLevel(jd, profile)
        ];
        const hardFailReasons = params.filter(p => p.status === 'fail').map(p => p.reason);
        return { params, passed: hardFailReasons.length === 0, hardFailReasons };
    }

    // ── YoE ──────────────────────────────────────────────────────────
    function scoreYoE(jd, profile) {
        const need = jd.requiredYoE?.min;
        if (need == null) {
            return { key: 'yoe', label: 'Years of experience', kind: 'soft', status: 'skipped',
                     score: null, reason: 'JD does not state required YoE', aiUsed: false };
        }
        const have = parseInt(profile.yearsOfExperience, 10);
        if (Number.isNaN(have)) {
            return { key: 'yoe', label: 'Years of experience', kind: 'soft', status: 'skipped',
                     score: null, reason: 'Profile YoE not set', aiUsed: false };
        }
        let score = 0;
        if (have >= need) score = 100;
        else if (need - have === 1) score = 75;
        else if (need - have === 2) score = 50;
        else score = 25;
        return { key: 'yoe', label: 'Years of experience', kind: 'soft', status: 'pass',
                 score, reason: `Need ${need}+, have ${have}`, aiUsed: false };
    }

    // ── Salary ───────────────────────────────────────────────────────
    function _parseClientSalary(s) {
        if (!s) return null;
        const m = /(\d[\d,]*)\s*(?:(?:[-–]|to)\s*(\d[\d,]*))?/.exec(String(s));
        if (!m) return null;
        const min = parseInt(m[1].replace(/,/g, ''), 10);
        const max = m[2] ? parseInt(m[2].replace(/,/g, ''), 10) : min;
        return { min, max };
    }
    function scoreSalary(jd, profile) {
        if (!jd.salaryRange) {
            return { key: 'salary', label: 'Salary', kind: 'soft', status: 'skipped', score: null,
                     reason: 'Not listed in JD', aiUsed: false };
        }
        const want = _parseClientSalary(profile.expectedSalary);
        if (!want) {
            return { key: 'salary', label: 'Salary', kind: 'soft', status: 'skipped', score: null,
                     reason: 'Profile expected salary not set', aiUsed: false };
        }
        const jdMin = jd.salaryRange.min, jdMax = jd.salaryRange.max ?? jdMin;
        if (jdMax < want.min) {
            return { key: 'salary', label: 'Salary', kind: 'soft', status: 'pass', score: 50,
                     reason: `JD ≤ $${jdMax}; want ≥ $${want.min}`, aiUsed: false };
        }
        if (jdMin > want.max) {
            return { key: 'salary', label: 'Salary', kind: 'soft', status: 'pass', score: 100,
                     reason: `JD ≥ $${jdMin}; above target`, aiUsed: false };
        }
        return { key: 'salary', label: 'Salary', kind: 'soft', status: 'pass', score: 100,
                 reason: `JD overlaps target range`, aiUsed: false };
    }

    // ── Title (rules-only fuzzy) ─────────────────────────────────────
    function _stripCommon(s) {
        return _norm(s).replace(/\b(senior|sr|junior|jr|lead|principal|staff|i{1,3}|iv|v|engineer|developer|specialist)\b/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function scoreTitleRules(jd, profile) {
        const targets = (profile.targetRoles || []).filter(Boolean);
        if (!targets.length) {
            return { key: 'title', label: 'Title', kind: 'soft', status: 'skipped', score: null,
                     reason: 'No target roles set', aiUsed: false };
        }
        const jdTitle = _norm(jd.title || '');
        if (!jdTitle) {
            return { key: 'title', label: 'Title', kind: 'soft', status: 'skipped', score: null,
                     reason: 'JD title missing', aiUsed: false };
        }
        for (const t of targets) {
            const tn = _norm(t);
            if (jdTitle.includes(tn) || tn.includes(jdTitle)) {
                return { key: 'title', label: 'Title', kind: 'soft', status: 'pass', score: 100,
                         reason: `"${jd.title}" matches "${t}"`, aiUsed: false };
            }
        }
        const jdStripped = _stripCommon(jd.title);
        for (const t of targets) {
            const ts = _stripCommon(t);
            if (ts && jdStripped.includes(ts)) {
                return { key: 'title', label: 'Title', kind: 'soft', status: 'pass', score: 75,
                         reason: `"${jd.title}" ≈ "${t}" (stripped match)`, aiUsed: false };
            }
        }
        return { key: 'title', label: 'Title', kind: 'soft', status: 'pass', score: 30,
                 reason: `"${jd.title}" — no strong overlap with targets`, aiUsed: false, _needsAi: true };
    }

    // ── Skills (rules-only overlap) ──────────────────────────────────
    function _escapeRx(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function scoreSkillsRules(jd, profile) {
        const skills = String(profile.skills || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!skills.length) {
            return { key: 'skills', label: 'Skills', kind: 'soft', status: 'skipped', score: null,
                     reason: 'Profile skills empty', aiUsed: false };
        }
        const body = (jd.descriptionText || '').toLowerCase();
        if (body.length < 200) {
            return { key: 'skills', label: 'Skills', kind: 'soft', status: 'manual', score: null,
                     reason: 'JD too brief to evaluate skills', aiUsed: false };
        }
        let hit = 0;
        const matched = [];
        for (const s of skills) {
            const rx = new RegExp(`\\b${_escapeRx(s.toLowerCase())}\\b`, 'i');
            if (rx.test(body)) { hit++; matched.push(s); }
        }
        const ratio = hit / skills.length;
        return { key: 'skills', label: 'Skills', kind: 'soft', status: 'pass',
                 score: Math.round(ratio * 100),
                 reason: `${hit} of ${skills.length} skills mentioned`,
                 aiUsed: false, _needsAi: ratio < 0.5 };
    }

    // ── Overall + verdict ────────────────────────────────────────────
    const DEFAULT_WEIGHTS = { yoe: 40, title: 25, skills: 25, salary: 10 };

    function _verdict(overallPct, hardFailed) {
        if (hardFailed) return 'not_a_fit';
        if (overallPct >= 80) return 'strong';
        if (overallPct >= 60) return 'good';
        if (overallPct >= 40) return 'weak';
        return 'poor';
    }

    function score(jd, profile, settings = {}) {
        const weights = settings.fitWeights || DEFAULT_WEIGHTS;
        const hard = scoreHard(jd, profile);
        const soft = [
            scoreYoE(jd, profile),
            scoreSalary(jd, profile),
            scoreTitleRules(jd, profile),
            scoreSkillsRules(jd, profile)
        ];
        const allParams = [...hard.params, ...soft];

        let overallPct = 0;
        if (hard.passed) {
            let totalWeight = 0, weightedSum = 0;
            for (const p of soft) {
                if (p.status === 'skipped' || p.status === 'manual' || p.score == null) continue;
                const w = weights[p.key] || 0;
                totalWeight += w;
                weightedSum += w * p.score;
            }
            overallPct = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
        }

        return {
            verdict: _verdict(overallPct, !hard.passed),
            overallPct: hard.passed ? overallPct : 0,
            hardFailReasons: hard.hardFailReasons,
            parameters: allParams,
            computedAt: new Date().toISOString()
        };
    }

    // ── AI fallback for weak title/skills ────────────────────────────
    function _recompute(fit, settings) {
        const weights = (settings && settings.fitWeights) || DEFAULT_WEIGHTS;
        // Hard fails ignored by the user (p.ignored=true, set by the mini-card's
        // Ignore button) don't trigger the auto-fail — the user has explicitly
        // accepted that this hard parameter shouldn't block. Soft ignored params
        // just don't count in the weighted average.
        const soft = fit.parameters.filter(p => p.kind === 'soft');
        const hardFailed = fit.parameters.some(p => p.kind === 'hard' && p.status === 'fail' && !p.ignored);
        let overallPct = 0;
        if (!hardFailed) {
            let totalWeight = 0, weightedSum = 0;
            for (const p of soft) {
                if (p.ignored) continue; // user dismissed this param
                if (p.status === 'skipped' || p.status === 'manual' || p.score == null) continue;
                const w = weights[p.key] || 0;
                totalWeight += w;
                weightedSum += w * p.score;
            }
            overallPct = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
        }
        fit.overallPct = hardFailed ? 0 : overallPct;
        fit.verdict = _verdict(overallPct, hardFailed);
        return fit;
    }

    function _applyAiResultToParam(param, aiScore, aiReason) {
        if (!param) return;
        if (typeof aiScore === 'number') {
            param.score = Math.max(0, Math.min(100, Math.round(aiScore)));
        }
        if (aiReason) param.reason = String(aiReason);
        param.aiUsed = true;
        delete param._needsAi;
    }

    function _scoreYoEFromEstimate(estimate, profile) {
        const have = parseInt(profile.yearsOfExperience, 10);
        if (Number.isNaN(have) || estimate == null) return null;
        const need = Math.max(0, Math.min(30, Math.round(estimate)));
        let score = 0;
        if (have >= need) score = 100;
        else if (need - have === 1) score = 75;
        else if (need - have === 2) score = 50;
        else score = 25;
        return { need, have, score };
    }

    function _normList(v) {
        const arr = Array.isArray(v) ? v : String(v || '').split(',');
        return arr.map(s => String(s || '').trim().toLowerCase()).filter(Boolean).sort();
    }

    function _profileFitKey(profile) {
        return JSON.stringify({
            roles: _normList(profile.targetRoles),
            skills: _normList(profile.skills),
            locations: _normList(profile.preferredLocations),
            yoe: String(profile.yearsOfExperience || '').trim(),
            salary: String(profile.expectedSalary || '').trim(),
            auth: String(profile.workAuthorization || '').trim(),
            workMode: String(profile.remotePreference || '').trim(),
            jobType: _normList(Array.isArray(profile.targetJobType) && profile.targetJobType.length
                ? profile.targetJobType
                : profile.desiredEmploymentType),
            level: _normList(profile.targetExperienceLevel)
        });
    }

    async function scoreWithAi(jd, profile, settings = {}) {
        const base = score(jd, profile, settings);
        const titleParam = base.parameters.find(p => p.key === 'title');
        const skillsParam = base.parameters.find(p => p.key === 'skills');
        const yoeParam = base.parameters.find(p => p.key === 'yoe');
        const locationParam = base.parameters.find(p => p.key === 'location');

        // YoE wants AI when JD didn't state required years AND profile has YoE set.
        const haveProfileYoE = !Number.isNaN(parseInt(profile.yearsOfExperience, 10));
        const yoeNeedsAi = !!(yoeParam && yoeParam.status === 'skipped' &&
                              /JD does not state/i.test(yoeParam.reason || '') &&
                              haveProfileYoE);

        // Location wants AI when rules couldn't find a match AND we have a JD
        // location to compare against (manual = no JD data → AI can't help).
        const locationNeedsAi = !!(locationParam?._needsAi);

        const wantsAi = !!(titleParam?._needsAi || skillsParam?._needsAi || yoeNeedsAi || locationNeedsAi);
        if (!wantsAi) return base;

        const clientId = profile.id;
        const profileFitKey = _profileFitKey(profile);

        // Cache hit: reuse prior AI verdict, no new call.
        const cachedRaw = clientId && jd.fitScores ? jd.fitScores[clientId] : null;
        const cached = cachedRaw && cachedRaw._profileFitKey === profileFitKey ? cachedRaw : null;
        if (cached) {
            if (titleParam && cached.titleScore != null) {
                _applyAiResultToParam(titleParam, cached.titleScore, cached.titleReason);
            }
            if (skillsParam && cached.skillsScore != null) {
                _applyAiResultToParam(skillsParam, cached.skillsScore, cached.skillsReason);
                if (Array.isArray(cached.missingSkills)) skillsParam.missingSkills = cached.missingSkills;
            }
            if (yoeParam && yoeNeedsAi && typeof cached.yoeEstimate === 'number') {
                const v = _scoreYoEFromEstimate(cached.yoeEstimate, profile);
                if (v) {
                    yoeParam.status = 'pass';
                    yoeParam.score = v.score;
                    yoeParam.reason = `${cached.yoeReason || `Estimated ${v.need}+ years`} · have ${v.have}`;
                    yoeParam.aiUsed = true;
                }
            }
            // Replay cached AI "consider anyway" hint so the mini-card can
            // surface its blue suggestion even on a cache-hit re-open.
            if (typeof cached.considerAnyway === 'boolean') {
                base.considerAnyway = cached.considerAnyway;
                base.considerAnywayReason = cached.considerAnywayReason || '';
            }
            // Stale-cache guard: cached.locationMatch was written under an older
            // looser prompt that sometimes hallucinated broader regions from a
            // narrow state list, OR under a different jdLocationRadiusMiles
            // setting. Only honor cached location verdicts stamped with the
            // current prompt version AND the current radius.
            const currentRadius = Number.isFinite(settings?.jdLocationRadiusMiles) ? settings.jdLocationRadiusMiles : 50;
            const cachedLocationFresh = cached._locationPromptV === 2 && cached._locationRadiusUsed === currentRadius;
            if (locationParam && locationNeedsAi && cachedLocationFresh) {
                if (cached.locationMatch === true) {
                    locationParam.status = 'pass';
                    locationParam.score = 100;
                    locationParam.reason = cached.locationReason || 'AI-confirmed match';
                    locationParam.aiUsed = true;
                } else if (cached.locationMatch === false) {
                    locationParam.reason = cached.locationReason || locationParam.reason;
                    locationParam.aiUsed = true;
                }
                delete locationParam._needsAi;
            }

            // If anything still needs AI (location with stale cache, or any param
            // not present in cache), fall through to the live call below.
            const stillNeeds = (titleParam?._needsAi)
                || (skillsParam?._needsAi)
                || (yoeNeedsAi && (typeof cached.yoeEstimate !== 'number'))
                || (locationParam?._needsAi);
            if (!stillNeeds) return _recompute(base, settings);
        }

        const paramsToScore = [];
        if (titleParam?._needsAi) paramsToScore.push('title');
        if (skillsParam?._needsAi) paramsToScore.push('skills');
        if (yoeNeedsAi) paramsToScore.push('yoe');
        if (locationNeedsAi) paramsToScore.push('location');

        let resp = null;
        try {
            resp = await chrome.runtime.sendMessage({
                type: 'CALL_AI_FIT_SCORE',
                payload: {
                    jdText: jd.descriptionText,
                    jdTitle: jd.title,
                    jdLocation: jd.location || null,
                    targetRoles: profile.targetRoles || [],
                    clientSkills: String(profile.skills || '').split(',').map(s => s.trim()).filter(Boolean),
                    clientPreferredLocations: profile.preferredLocations || [],
                    candidateYearsOfExperience: Number.isFinite(parseInt(profile.yearsOfExperience, 10)) ? parseInt(profile.yearsOfExperience, 10) : null,
                    locationRadiusMiles: Number.isFinite(settings?.jdLocationRadiusMiles) ? settings.jdLocationRadiusMiles : 50,
                    paramsToScore
                }
            });
        } catch (_) { /* messaging failure → fall through to rules-only */ }

        if (!resp || !resp.ok || !resp.result) {
            if (titleParam?._needsAi) { delete titleParam._needsAi; titleParam.reason += ' (rules-only)'; }
            if (skillsParam?._needsAi) { delete skillsParam._needsAi; skillsParam.reason += ' (rules-only)'; }
            if (locationParam?._needsAi) { delete locationParam._needsAi; locationParam.reason += ' (rules-only)'; }
            return _recompute(base, settings);
        }

        const r = resp.result;
        if (titleParam && typeof r.titleScore === 'number') {
            _applyAiResultToParam(titleParam, r.titleScore, r.titleReason);
        } else if (titleParam?._needsAi) {
            delete titleParam._needsAi; titleParam.reason += ' (rules-only)';
        }
        if (skillsParam && typeof r.skillsScore === 'number') {
            _applyAiResultToParam(skillsParam, r.skillsScore, r.skillsReason);
            if (Array.isArray(r.missingSkills)) skillsParam.missingSkills = r.missingSkills;
        } else if (skillsParam?._needsAi) {
            delete skillsParam._needsAi; skillsParam.reason += ' (rules-only)';
        }
        if (yoeParam && yoeNeedsAi && typeof r.yoeEstimate === 'number') {
            const v = _scoreYoEFromEstimate(r.yoeEstimate, profile);
            if (v) {
                yoeParam.status = 'pass';
                yoeParam.score = v.score;
                yoeParam.reason = `${r.yoeReason || `Estimated ${v.need}+ years`} · have ${v.have}`;
                yoeParam.aiUsed = true;
            }
        }
        // AI consider-anyway: surfaced on the fit object so the mini-card can
        // render the blue "AI suggests: consider applying / skip" hint when
        // there's a client-target ↔ JD seniority mismatch worth surfacing.
        if (typeof r.considerAnyway === 'boolean') {
            base.considerAnyway = r.considerAnyway;
            base.considerAnywayReason = r.considerAnywayReason || '';
        }
        if (locationParam && locationNeedsAi) {
            if (r.locationMatch === true) {
                locationParam.status = 'pass';
                locationParam.score = 100;
                locationParam.reason = r.locationReason || 'AI-confirmed match';
                locationParam.aiUsed = true;
            } else if (r.locationMatch === false) {
                // AI confirmed the rules-only fail; surface its reasoning
                locationParam.reason = r.locationReason || locationParam.reason;
                locationParam.aiUsed = true;
            }
            delete locationParam._needsAi;
        }

        // Persist into JdCache.fitScores so re-opens are instant.
        if (clientId && window.QuickApplyJdCache?.putFitScores && jd.jobKey) {
            try {
                await window.QuickApplyJdCache.putFitScores(jd.jobKey, clientId, {
                    _profileFitKey: profileFitKey,
                    titleScore: r.titleScore ?? null,
                    titleReason: r.titleReason ?? null,
                    skillsScore: r.skillsScore ?? null,
                    skillsReason: r.skillsReason ?? null,
                    missingSkills: Array.isArray(r.missingSkills) ? r.missingSkills : [],
                    yoeEstimate: typeof r.yoeEstimate === 'number' ? r.yoeEstimate : null,
                    yoeReason: r.yoeReason ?? null,
                    locationMatch: typeof r.locationMatch === 'boolean' ? r.locationMatch : null,
                    locationReason: r.locationReason ?? null,
                    _locationPromptV: 2,
                    _locationRadiusUsed: Number.isFinite(settings?.jdLocationRadiusMiles) ? settings.jdLocationRadiusMiles : 50,
                    considerAnyway: typeof r.considerAnyway === 'boolean' ? r.considerAnyway : null,
                    considerAnywayReason: r.considerAnywayReason ?? null
                });
            } catch (_) {}
        }

        return _recompute(base, settings);
    }

    window.QuickApplyFitMatcher = { score, scoreWithAi, scoreHard, scoreVisa, scoreLocation,
                                    scoreWorkMode, scoreEmploymentType, scoreExperienceLevel,
                                    scoreYoE, scoreSalary, scoreTitleRules, scoreSkillsRules };
})();
