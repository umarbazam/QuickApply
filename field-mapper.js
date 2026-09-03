/**
 * QuickApply — Field Mapper
 * Multi-strategy field identification engine.
 * Reference: FIELD_MAPPINGS.md, ARCHITECTURE.md § 4.1
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // FIELD MAPPINGS DICTIONARY — from FIELD_MAPPINGS.md
    // ═══════════════════════════════════════════════════════════════════

    const FIELD_MAPPINGS = {
        firstName: {
            aliases: [
                'first_name', 'firstname', 'fname', 'first-name', 'given_name', 'givenname',
                'given-name', 'name_first', 'applicant_first_name', 'candidate_first_name',
                'legal_first_name', 'legalfirstname', 'first name', 'given name',
                'name[first]', 'user[first_name]',
                // Workday
                'legalnamessection_firstname', 'legalnamesection_firstname', 'firstname',
                'legal-name-section--first-name', 'preferrednamessection_firstname',
                // SmartRecruiters
                'input-firstname', 'sr-firstname',
                // iCIMS
                'applicant.field.firstname', 'applicant.field.first_name',
                'field.firstname', 'candidate.firstname',
                // French (Workable FR, etc.)
                'prénom', 'prenom', 'first name (prénom)'
            ],
            inputTypes: ['text']
        },
        lastName: {
            aliases: [
                'last_name', 'lastname', 'lname', 'last-name', 'surname', 'family_name',
                'familyname', 'family-name', 'name_last', 'applicant_last_name',
                'candidate_last_name', 'legal_last_name', 'legallastname', 'last name',
                'family name', 'name[last]', 'user[last_name]',
                // Workday
                'legalnamessection_lastname', 'legalnamesection_lastname',
                'legal-name-section--last-name', 'preferrednamessection_lastname',
                // SmartRecruiters
                'input-lastname', 'sr-lastname',
                // iCIMS
                'applicant.field.lastname', 'applicant.field.last_name',
                'field.lastname', 'candidate.lastname',
                // French
                'nom', 'nom de famille', 'last name (nom)'
            ],
            inputTypes: ['text']
        },
        middleName: {
            aliases: [
                'middle_name', 'middlename', 'mname', 'middle-name', 'middle_initial',
                'middle name', 'name[middle]'
            ],
            inputTypes: ['text']
        },
        preferredName: {
            aliases: [
                'preferred_name', 'preferredname', 'preferred-name', 'nickname',
                'preferred name', 'known_as', 'goes_by'
            ],
            inputTypes: ['text']
        },
        fullName: {
            aliases: [
                'full_name', 'fullname', 'full-name', 'applicant_name',
                'candidate_name', 'your_name', 'your-name', 'full name', 'complete name',
                'legal_name', 'legalname', 'legal name',
                // Lever uses bare "name" for the full name field
                'name'
            ],
            inputTypes: ['text']
        },
        email: {
            aliases: [
                'email', 'e-mail', 'email_address', 'emailaddress', 'email-address',
                'applicant_email', 'candidate_email', 'work_email', 'personal_email',
                'contact_email', 'user_email', 'email address', 'e-mail address',
                'user[email]', 'mail',
                // Many platforms use "username" for the email login field
                'username', 'user_name', 'login', 'login_email', 'sign_in_email',
                'account_email', 'account email', 'signin email',
                // iCIMS
                'applicant.field.email', 'applicant.field.username', 'field.email',
                'candidate.email',
                // French
                'courriel', 'adresse e-mail', 'adresse email', 'adresse courriel'
            ],
            inputTypes: ['email', 'text']
        },
        // Confirm-email: same value as email but needs its own profileField to bypass
        // the _filledProfileFields dedup which would otherwise skip the second email input.
        confirmEmail: {
            aliases: [
                'confirm_email', 'confirmemail', 'confirm-email', 'email_confirm',
                'email_confirmation', 'emailconfirmation', 'confirm email',
                'confirm your email', 'confirm_your_email', 'verify email',
                'verify_email', 'email_verify', 're-enter email', 'reenter_email',
                'repeat_email', 'email_again', 'reenter email', 'enter email again'
            ],
            inputTypes: ['email', 'text']
        },
        phone: {
            aliases: [
                'phone', 'phone_number', 'phonenumber', 'phone-number', 'telephone',
                'tel', 'mobile', 'mobile_number', 'cell', 'cellphone', 'cell_phone',
                'contact_phone', 'primary_phone', 'phone number', 'mobile number',
                'contact number', 'user[phone]',
                // iCIMS
                'applicant.field.phone1', 'applicant.field.phone', 'applicant.field.homephone',
                'applicant.field.mobilephone', 'field.phone1', 'candidate.phone',
                // French
                'téléphone', 'telephone', 'numéro de téléphone', 'numero de telephone'
            ],
            inputTypes: ['tel', 'text']
        },
        alternatePhone: {
            aliases: [
                'alt_phone', 'alternate_phone', 'secondary_phone', 'other_phone',
                'home_phone', 'work_phone', 'alternate phone'
            ],
            inputTypes: ['tel', 'text']
        },
        alternateEmail: {
            aliases: [
                'alt_email', 'alternate_email', 'secondary_email', 'other_email',
                'alternate email'
            ],
            inputTypes: ['email', 'text']
        },
        streetAddress: {
            aliases: [
                'street_address', 'streetaddress', 'street-address', 'address', 'address1',
                'address_line_1', 'addressline1', 'address-line-1', 'street', 'street_name',
                'mailing_address', 'home_address', 'street address', 'address line 1'
            ],
            inputTypes: ['text']
        },
        addressLine2: {
            aliases: [
                'address_line_2', 'addressline2', 'address-line-2', 'address2', 'apt',
                'suite', 'unit', 'apartment', 'address line 2'
            ],
            inputTypes: ['text']
        },
        city: {
            aliases: [
                'city', 'city_name', 'town', 'locality', 'municipality',
                'address_city', 'home_city'
            ],
            inputTypes: ['text']
        },
        state: {
            aliases: [
                'state', 'state_name', 'province', 'region', 'state_province',
                'address_state', 'home_state', 'state/province'
            ],
            inputTypes: ['text']
        },
        zipCode: {
            aliases: [
                'zip', 'zipcode', 'zip_code', 'zip-code', 'postal_code', 'postalcode',
                'postal-code', 'postcode', 'post_code', 'address_zip', 'zip code',
                'postal code'
            ],
            inputTypes: ['text']
        },
        country: {
            aliases: [
                'country', 'country_name', 'nation', 'address_country', 'home_country',
                'country_code'
            ],
            inputTypes: ['text']
        },
        gender: {
            aliases: [
                'gender', 'sex', 'gender_identity', 'genderidentity', 'gender-identity',
                'how_would_you_describe_your_gender', 'describe_your_gender',
                'gender_identification', 'gender identification', 'gender identity',
                'selfidentifygender', 'self_identify_gender', 'gender_self_id'
            ],
            inputTypes: ['select']
        },
        ethnicity: {
            aliases: [
                'ethnicity', 'race', 'race_ethnicity', 'raceethnicity', 'race-ethnicity',
                'ethnic_background', 'eeo_race', 'race/ethnicity', 'race / ethnicity',
                'racial_background', 'racial_ethnic_background', 'racialethnicbackground',
                'racial_ethnic', 'racial_identity', 'racial identity',
                'racial/ethnic background', 'ethnic background', 'racial background',
                'identify_your_race', 'please_identify_your_race', 'race_identification',
                'identify your race', 'please identify your race',
                'eeo_ethnicity', 'eeo_race_ethnicity'
            ],
            inputTypes: ['select']
        },
        hispanicLatino: {
            aliases: [
                'hispanic', 'hispanic_latino', 'hispanicolatino', 'hispanic-latino',
                'hispanic_or_latino', 'are_you_hispanic', 'are_you_hispanic_or_latino',
                'hispanic_origin', 'latinx', 'latino', 'latina',
                'are you hispanic', 'are you hispanic/latino', 'hispanic/latino',
                'hispanic_latino_origin', 'eeo_hispanic', 'hispanic_ethnicity'
            ],
            inputTypes: ['select', 'radio']
        },
        sexualOrientation: {
            aliases: [
                'sexual_orientation', 'sexualorientation', 'sexual-orientation',
                'sexuality', 'lgbtq', 'lgbtq_identity', 'sexual_identity',
                'sexual orientation', 'sexual identity',
                'how_would_you_describe_your_sexual_orientation',
                'describe_your_sexual_orientation', 'eeo_sexual_orientation',
                'sexual_preference'
            ],
            inputTypes: ['select', 'radio']
        },
        transgender: {
            aliases: [
                'transgender', 'trans', 'identify_as_transgender', 'transgender_identity',
                'do_you_identify_as_transgender', 'transgender_status',
                'do you identify as transgender', 'identify as transgender',
                'gender_transition', 'trans_identity', 'eeo_transgender'
            ],
            inputTypes: ['select', 'radio']
        },
        pronouns: {
            aliases: [
                'pronouns', 'preferred_pronouns', 'pronoun', 'your_pronouns',
                'what_are_your_pronouns', 'pronoun_preference', 'gender_pronouns',
                'preferred pronouns', 'your pronouns',
                // Exact label texts from forms (after ? removal)
                'what are your pronouns',
                'what are your preferred pronouns',
                'please share your pronouns',
                'share your pronouns',
                'your preferred pronouns',
                'personal pronouns',
                'how would you like to be addressed',
                'pronoun_selection', 'pronoun_identity', 'eeo_pronouns',
                'pronoun_self_id', 'gender_pronoun'
            ],
            inputTypes: ['text', 'select']
        },
        veteranStatus: {
            aliases: [
                'veteran', 'veteran_status', 'veteranstatus', 'veteran-status',
                'military_status', 'military_service', 'protected_veteran',
                'veteran status', 'military status'
            ],
            inputTypes: ['select']
        },
        disabilityStatus: {
            aliases: [
                'disability', 'disability_status', 'disabilitystatus', 'disability-status',
                'handicap', 'disabled', 'disability status'
            ],
            inputTypes: ['select']
        },
        currentJobTitle: {
            aliases: [
                'job_title', 'jobtitle', 'job-title', 'current_title', 'title',
                'position', 'current_position', 'current_job_title', 'headline',
                'job title', 'current title'
            ],
            inputTypes: ['text']
        },
        currentCompany: {
            aliases: [
                'company', 'company_name', 'current_company', 'employer',
                'current_employer', 'current company', 'employer_name',
                'employer name', 'company name',
                // Lever uses "org" for the current company/organization field
                'org', 'organization', 'organisation', 'current_organization'
            ],
            inputTypes: ['text']
        },
        yearsOfExperience: {
            aliases: [
                'experience', 'years_experience', 'yearsofexperience', 'years-of-experience',
                'total_experience', 'work_experience', 'years of experience'
            ],
            inputTypes: ['text', 'number']
        },
        linkedIn: {
            aliases: [
                'linkedin', 'linkedin_url', 'linkedinurl', 'linkedin-url',
                'linkedin_profile', 'linkedin url', 'linkedin profile'
            ],
            inputTypes: ['url', 'text']
        },
        portfolio: {
            aliases: [
                'portfolio', 'website', 'personal_website', 'portfolio_url',
                'personal_site', 'portfolio url', 'personal website'
            ],
            inputTypes: ['url', 'text']
        },
        github: {
            aliases: [
                'github', 'github_url', 'githuburl', 'github-url',
                'github_profile', 'github url', 'github profile'
            ],
            inputTypes: ['url', 'text']
        },
        highestEducation: {
            aliases: [
                'education', 'education_level', 'degree', 'highest_degree',
                'degree_level', 'highest_education', 'education level', 'degree level'
            ],
            inputTypes: ['select', 'text']
        },
        university: {
            aliases: [
                'university', 'school', 'college', 'institution', 'school_name',
                'university_name', 'alma_mater', 'school name',
                // SmartRecruiters education section
                'schoolname', 'school-name', 'institutionname', 'institution-name',
                'universityname', 'university-name'
            ],
            inputTypes: ['text']
        },
        major: {
            aliases: [
                'major', 'field_of_study', 'fieldofstudy', 'field-of-study',
                'concentration', 'discipline', 'area_of_study', 'field of study',
                // SmartRecruiters
                'study', 'studyfield', 'study-field', 'subject', 'course'
            ],
            inputTypes: ['text']
        },
        graduationYear: {
            aliases: [
                'graduation_year', 'gradyear', 'grad_year', 'graduation-year',
                'year_graduated', 'completion_year', 'graduation year',
                // SmartRecruiters (concatenated, no separator)
                'graduationyear', 'enddate', 'end-date', 'end_date',
                'completiondate', 'completion-date'
            ],
            inputTypes: ['text', 'number']
        },
        gpa: {
            aliases: ['gpa', 'grade_point_average', 'cgpa', 'grade'],
            inputTypes: ['text', 'number']
        },
        skills: {
            aliases: [
                'skills', 'skill_set', 'key_skills', 'core_skills',
                'technical_skills', 'competencies', 'key skills'
            ],
            inputTypes: ['text', 'textarea']
        },
        certifications: {
            aliases: [
                'certifications', 'certification', 'certificates', 'certs',
                'professional_certifications', 'licenses'
            ],
            inputTypes: ['text', 'textarea']
        },
        languages: {
            // H2 FIX: tightened to spoken/human languages only. A bare "languages" or
            // "language" label on Lever/Greenhouse asks for spoken languages (English, French),
            // NOT programming languages. Removed the generic single-word aliases so a bare
            // "Languages" label falls through to AI context detection instead of mapping to
            // the programming-languages value from CV parse.
            aliases: [
                'spoken_languages', 'spoken_language', 'language_skills',
                'languages spoken', 'language proficiency', 'native_language',
                'fluent_in', 'language_proficiency', 'human_languages',
                'what languages do you speak', 'languages you speak'
            ],
            inputTypes: ['text']
        },
        workAuthorization: {
            aliases: [
                // Work authorization names
                'work_authorization', 'workauthorization', 'work-authorization',
                'visa_status', 'authorization', 'work_permit', 'eligibility',
                'work authorization', 'authorized to work', 'legally authorized',
                'employment_authorization', 'employmentauthorization',
                'us_work_authorization', 'us_authorization', 'us_work_eligibility',
                'authorized_to_work', 'authorizedtowork', 'authorized-to-work',
                'right_to_work', 'righttowork', 'right-to-work', 'right to work',
                'work_eligibility', 'workeligibility', 'work-eligibility',
                'legal_authorization', 'legalauthorization',
                // "Legal right to work" phrasing
                'legal_right_to_work', 'legalrighttowork', 'legal-right-to-work',
                'do_you_have_the_legal_right', 'legal_right', 'legally_eligible',
                'legally_permitted_to_work', 'permitted_to_work',
                'right_to_work_in', 'legal_right_to_work_in',
                'authorized_to_work_in', 'authorization_to_work',
                // "Work permit / visa support" phrasing — INVERTED (needing permit = not authorized)
                'work_permit', 'work_permit_required', 'require_work_permit',
                'visa_support', 'require_visa_support', 'additional_right_to_work',
                'right_to_work_support', 'right_to_work_assistance',
                'do_you_require_a_work_permit', 'require_additional_right_to_work',
                // Sponsorship names — these are INVERTED (requiring sponsorship = NOT authorized)
                // The inversion logic in fuzzyMatchOption handles the flip automatically
                'sponsorship', 'require_sponsorship', 'requiresponsorship', 'require-sponsorship',
                'requires_sponsorship', 'requiressponsorship',
                'needs_sponsorship', 'needssponsorship', 'need_sponsorship',
                'visa_sponsorship', 'visasponsorship', 'visa-sponsorship',
                'employer_sponsorship', 'employersponsorship',
                'sponsorship_required', 'sponsorshiprequired',
                'need_visa_sponsorship', 'require_visa_sponsorship',
                'employment_visa', 'visarequired', 'visa_required',
                // Full label text variants — matched by matchByContextLabel for higher confidence
                'will you now or in the future require visa sponsorship',
                'will you require visa sponsorship',
                'do you require visa sponsorship',
                'do you now or in the future require visa sponsorship',
                'do you now, or in the future, require visa sponsorship',
                'do you now or will you at any time in the future require sponsorship',
                'do you now or will you at any time require sponsorship',
                'will you at any time require sponsorship',
                'do you need visa sponsorship',
                'do you need employer sponsorship',
                'are you eligible to work in the united states',
                'are you currently eligible to work in the united states',
                'are you authorized to work in the united states',
                'are you currently authorized to work in the united states',
                'are you legally authorized to work in the us',
                'are you legally authorized to work in the united states',
                // Immigration case phrasing (Greenhouse custom questions)
                'commence immigration case',
                'commence an immigration case',
                'sponsor an immigration case',
                'need us to commence an immigration',
                'will you need us to commence',
                'need to commence an immigration'
            ],
            inputTypes: ['select', 'radio', 'text']
        },
        liveInUS: {
            aliases: [
                'live_in_us', 'liveintheUS', 'live_in_the_us', 'currently_live_in_us',
                'reside_in_us', 'us_resident', 'us_based', 'us_residency',
                'do_you_currently_live_in_the_us',
                // Exact label text (after ? removal by matchByContextLabel)
                'do you currently live in the u.s.',
                'do you currently live in the us',
                'do you live in the u.s.',
                'do you live in the us',
                'are you currently located in the u.s.',
                'are you currently located in the us',
                'are you based in the u.s.',
                'are you based in the us',
                'do you currently reside in the u.s.',
                'do you currently reside in the us',
                'are you a u.s. resident',
                'are you a us resident',
                'currently located in the united states',
                'currently reside in the united states',
                'live in the united states',
                'residing_in_us', 'live_in_united_states', 'living_in_us'
                // NOTE: removed us_location/located_in_us/in_the_us — these caused substring
                // false-positives on generic "Location:*" textarea fields (matched liveInUS)
            ],
            inputTypes: ['select', 'radio']
        },
        willingToRelocate: {
            aliases: [
                'relocate', 'willing_to_relocate', 'relocation', 'open_to_relocation',
                'willing to relocate', 'open to relocation',
                // Full-label variants — Greenhouse city-specific questions
                'do you currently live in',
                'plan to relocate',
                'currently live or plan to relocate',
                'willing to commute or relocate',
                'able to relocate'
            ],
            inputTypes: ['select']
        },
        expectedSalary: {
            aliases: [
                'salary', 'expected_salary', 'salary_expectation', 'desired_salary',
                'compensation', 'pay', 'salary_range', 'expected salary',
                'desired compensation', 'salary expectation'
            ],
            inputTypes: ['text', 'number']
        },
        noticePeriod: {
            aliases: [
                'notice_period', 'noticeperiod', 'notice-period', 'availability',
                'notice period', 'when can you start'
            ],
            inputTypes: ['text']
        },
        desiredEmploymentType: {
            aliases: [
                'employment_type', 'employmenttype', 'employment-type', 'job_type',
                'work_type', 'employment type', 'job type', 'type of employment'
            ],
            inputTypes: ['select']
        },
        remotePreference: {
            aliases: [
                'remote', 'remote_preference', 'work_location', 'workplace_type',
                'onsite_remote', 'remote preference', 'work arrangement', 'remote/onsite'
            ],
            inputTypes: ['select']
        },
        coverLetter: {
            aliases: [
                'cover_letter', 'coverletter', 'cover-letter', 'cover_letter_text',
                'cover_note', 'covernote', 'letter_of_interest', 'motivation_letter',
                'application_letter', 'covering_letter', 'cover letter', 'covering letter',
                'why_apply', 'why_are_you_applying', 'additional_information',
                // Workable uses "summary" as the main text field (bio/cover letter)
                'summary', 'profile_summary', 'professional_summary', 'personal_statement',
                // French
                'lettre de motivation', 'lettre_de_motivation', 'lettre motivation'
            ],
            inputTypes: ['textarea', 'text']
        },
        desiredStartDate: {
            aliases: [
                'start_date', 'startdate', 'start-date', 'available_start_date',
                'earliest_start_date', 'availability_date', 'available_from',
                'when_can_you_start', 'whencanyoustart', 'desired_start_date',
                'start date', 'when can you start', 'date available', 'available date',
                'available_to_start', 'potential_start_date',
                // Ashby OpenAI uses "When can you start a new role?" — longer phrasing
                // wasn't being substring-matched by the shorter alias. Add the
                // common longer variants explicitly.
                'when can you start a new role', 'when can you start a new job',
                'when can you start a new position', 'when can you start a role',
                'when are you available to start', 'when are you available',
                'earliest you can start', 'how soon can you start',
                'when would you like to start', 'when would you be able to start',
            ],
            inputTypes: ['text', 'date']
        },
        currentlyEmployed: {
            aliases: [
                'currently_employed', 'currentlyemployed', 'currently-employed',
                'are_you_employed', 'are_you_currently_employed', 'employment_status',
                'currently employed', 'are you currently employed', 'current employment',
                'are_you_working', 'present_employment', 'current_employment_status'
            ],
            inputTypes: ['select', 'radio']
        },
        driversLicense: {
            aliases: [
                'drivers_license', 'driverslicense', 'drivers-license',
                'driver_license', 'driver_s_license', 'driving_license',
                'valid_drivers_license', 'valid_driving_license', 'drivers license',
                'driver license', 'driving licence', 'valid license', 'license',
                'have_a_valid_license', 'hold_a_valid_license'
            ],
            inputTypes: ['select', 'radio']
        },
        backgroundCheckConsent: {
            aliases: [
                'background_check', 'backgroundcheck', 'background-check',
                'background_check_consent', 'consent_background_check',
                'agree_background_check', 'background screening', 'background check',
                'criminal_background', 'criminal background check', 'bgcheck',
                'agree_to_background', 'consent_to_background'
            ],
            inputTypes: ['select', 'radio', 'checkbox']
        },
        drugTestConsent: {
            aliases: [
                'drug_test', 'drugtest', 'drug-test', 'drug_screening',
                'drug_test_consent', 'consent_drug_test', 'drug screening',
                'drug test', 'agree_to_drug_test', 'pre_employment_drug'
            ],
            inputTypes: ['select', 'radio', 'checkbox']
        },
        ageEligible: {
            aliases: [
                'age_eligible', 'ageeligible', 'age-eligible', 'age_18', 'over_18',
                'eighteen_or_older', 'legal_age', 'minimum_age', 'are_you_18',
                'are_you_over_18', 'legally_old_enough', '18 or older',
                'are you 18 years of age', 'are you at least 18', 'legal working age'
            ],
            inputTypes: ['select', 'radio']
        },
        heardAboutUs: {
            aliases: [
                'how_did_you_hear', 'howdidyouhear', 'heard_about_us', 'heardaboutus',
                'referral_source', 'referralsource', 'application_source', 'applicationsource',
                'how_did_you_find', 'how_found', 'source', 'lead_source',
                'how did you hear', 'how did you find', 'referral source', 'source of referral',
                'where_did_you_hear', 'where did you hear about', 'where did you first hear',
                'where you first learned about', 'first learned about this role',
                'please let us know where you first', 'let us know where you',
                'how did you learn about', 'where did you learn about', 'job_source'
            ],
            inputTypes: ['select', 'text']
        },
        securityClearance: {
            aliases: [
                'security_clearance', 'securityclearance', 'security-clearance',
                'clearance_level', 'clearance', 'has_clearance', 'clearance_type',
                'security clearance', 'clearance level', 'government clearance',
                'active_clearance', 'active security clearance'
            ],
            inputTypes: ['select', 'radio', 'text']
        },
        nonCompete: {
            aliases: [
                'non_compete', 'noncompete', 'non-compete', 'non_competition',
                'non_compete_agreement', 'restrictive_covenant',
                'subject_to_non_compete', 'have_a_non_compete',
                'non compete', 'non-compete agreement', 'conflict of interest',
                'conflict_of_interest', 'nda_restrictions', 'employment_restrictions'
            ],
            inputTypes: ['select', 'radio']
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // EEO VALUE MAPS — for fuzzy matching select options
    // ═══════════════════════════════════════════════════════════════════

    const VALUES_MAP = {
        gender: {
            // Profile stores "Male"/"Female"/"Non-binary"/"Transgender"/"Prefer not to say"
            // Form options vary: "Man"/"Woman"/"Non-binary/Non-conforming"/"I don't wish to answer" etc.
            'Male': ['male', 'm', 'man', 'he/him', 'he', 'him'],
            'Female': ['female', 'f', 'woman', 'she/her', 'she', 'her'],
            'Non-binary': ['non-binary', 'nonbinary', 'nb', 'they/them', 'other', 'non-binary/non-conforming',
                'non conforming', 'nonconforming', 'genderqueer', 'gender fluid', 'genderfluid',
                'gender non-conforming', 'gender nonconforming'],
            'Transgender': ['transgender', 'trans', 'i identify as transgender', 'i am transgender'],
            'Prefer not to say': ['prefer not', 'decline', 'not specified', 'choose not',
                'not listed', "i don't wish", "i don't wish to answer", 'do not wish',
                'prefer to self-describe', 'self-describe', 'another gender', 'not disclosed']
        },
        ethnicity: {
            // Exact Greenhouse option texts included as synonyms for precise matching
            'White': ['white', 'caucasian', 'european'],
            'Black or African American': ['black', 'african american', 'african-american',
                'black or african american'],
            'Hispanic or Latino': ['hispanic', 'latino', 'latina', 'latinx', 'spanish',
                'hispanic/latinx', 'hispanic/latino', 'hispanic or latino'],
            'Asian': ['asian', 'east asian', 'south asian', 'southeast asian',
                'asian or asian american', 'asian american'],
            'Native American or Alaska Native': ['native american', 'alaska native', 'indigenous',
                'american indian', 'american indian or alaskan native', 'alaskan native'],
            'Native Hawaiian or Pacific Islander': ['native hawaiian', 'pacific islander', 'hawaiian',
                'native hawaiian or other pacific islander', 'native hawaiian or pacific islander'],
            'Two or More Races': ['two or more', 'multiracial', 'mixed', 'bi-racial', 'two or more races'],
            'Prefer not to say': ['prefer not', 'decline', 'not specified', 'choose not',
                "i don't wish", 'do not wish']
        },
        veteranStatus: {
            // Covers Greenhouse: "I identify as one or more...", "I am an active duty service member"
            'I am a veteran': ['i am a veteran', 'i am a protected veteran', 'protected veteran',
                'i served', 'active duty', 'i am an active duty', 'active duty service member',
                'i am an active duty service member', 'one or more classifications',
                'i identify as one or more', 'i have served', 'yes veteran', 'yes', 'oui'],
            'I am not a veteran': ['i am not a veteran', 'i am not a protected veteran', 'no, i am not a veteran', 'no i am not a veteran', 'i do not identify as a veteran',
                'not a protected veteran', 'not a veteran', 'non-veteran', 'never served',
                'have not served', 'no veteran', 'no', 'non'],
            'Prefer not to say': ['prefer not', 'decline', 'not specified', 'choose not',
                'do not wish to self-identify', "i don't wish", "i don't wish to answer",
                'do not wish']
        },
        disabilityStatus: {
            'Yes, I have a disability': ['yes, i have a disability', 'i have a disability', 'i am disabled', 'yes i have', 'i have a physical', 'yes', 'oui'],
            'No, I do not have a disability': ['no, i do not', 'i do not have a disability', 'not disabled', 'no disability', 'i don\'t have a disability', 'no', 'non'],
            'Prefer not to say': ['prefer not', 'decline', 'not specified', 'choose not', 'do not wish']
        },
        willingToRelocate: {
            'Yes': ['yes', 'oui', 'willing', 'open to relocation', 'will relocate', 'i am willing', 'i would relocate'],
            'No': ['no', 'non', 'not willing', 'cannot relocate', 'prefer not', 'unable to relocate']
        },
        highestEducation: {
            'High School': ['high school', 'secondary', 'ged', 'diploma'],
            "Associate's": ["associate", "associate's", "associates", 'aa', 'as', '2-year'],
            "Bachelor's": ["bachelor", "bachelor's", "bachelors", 'ba', 'bs', 'bsc', '4-year'],
            "Master's": ["master", "master's", "masters", 'ma', 'ms', 'msc', 'mba'],
            'Doctorate': ['doctorate', 'doctoral', 'phd', 'ph.d', 'doctor'],
            'Professional': ['professional', 'jd', 'md', 'dds']
        },
        workAuthorization: {
            // These are the "authorized / does NOT need sponsorship" statuses
            'Yes': ['yes', 'oui', 'authorized', 'i am authorized', 'legally authorized', 'eligible to work',
                'eligible', 'no sponsorship needed', 'no sponsorship', 'citizen', 'permanent resident',
                'green card', 'work permit', 'will not require', 'do not require', 'not require sponsorship',
                'authorized for any employer', 'authorized to work', 'any employer',
                // Specific US visa/status types that mean the holder IS work-authorized
                'ead', 'opt', 'cpt', 'h1b', 'h-1b', 'tn visa', 'o-1', 'l-1', 'l1', 'e-3',
                'us citizen', 'greencard'],
            'No': ['no', 'non', 'not authorized', 'not legally authorized', 'not eligible',
                'require sponsorship', 'need sponsorship', 'will need sponsorship',
                'requires sponsorship', 'requires renewal', 'renewal/sponsorship', 'renewal sponsorship',
                'need work authorization', 'require employer sponsorship', 'yes sponsorship',
                'h1-b', 'opt sponsorship', 'tn sponsorship']
        },
        state: {
            // US state full name → abbreviation (Shopmonkey/Greenhouse state dropdowns use 2-letter codes)
            'AL':['alabama'],'AK':['alaska'],'AZ':['arizona'],'AR':['arkansas'],
            'CA':['california'],'CO':['colorado'],'CT':['connecticut'],'DE':['delaware'],
            'FL':['florida'],'GA':['georgia'],'HI':['hawaii'],'ID':['idaho'],
            'IL':['illinois'],'IN':['indiana'],'IA':['iowa'],'KS':['kansas'],
            'KY':['kentucky'],'LA':['louisiana'],'ME':['maine'],'MD':['maryland'],
            'MA':['massachusetts'],'MI':['michigan'],'MN':['minnesota'],'MS':['mississippi'],
            'MO':['missouri'],'MT':['montana'],'NE':['nebraska'],'NV':['nevada'],
            'NH':['new hampshire'],'NJ':['new jersey'],'NM':['new mexico'],'NY':['new york'],
            'NC':['north carolina'],'ND':['north dakota'],'OH':['ohio'],'OK':['oklahoma'],
            'OR':['oregon'],'PA':['pennsylvania'],'RI':['rhode island'],'SC':['south carolina'],
            'SD':['south dakota'],'TN':['tennessee'],'TX':['texas'],'UT':['utah'],
            'VT':['vermont'],'VA':['virginia'],'WA':['washington'],'WV':['west virginia'],
            'WI':['wisconsin'],'WY':['wyoming'],'DC':['district of columbia','washington dc']
        },
        desiredEmploymentType: {
            'Full-time': ['full-time', 'fulltime', 'full time', 'permanent', 'regular full', 'ft'],
            'Part-time': ['part-time', 'parttime', 'part time', 'pt'],
            'Contract': ['contract', 'contractor', 'freelance', 'consulting', 'independent'],
            'Temporary': ['temporary', 'temp', 'seasonal', 'short-term'],
            'Internship': ['intern', 'internship', 'co-op', 'coop', 'placement']
        },
        remotePreference: {
            'Remote': ['remote', 'fully remote', 'work from home', 'wfh', 'telecommute', 'home based'],
            'On-site': ['onsite', 'on-site', 'in-office', 'in office', 'on site', 'office only', 'in person'],
            'Hybrid': ['hybrid', 'flexible', 'mixed', 'partial remote', 'blended']
        },
        pronouns: {
            // Maps stored value to common select option text on forms
            'He/Him':   ['he/him', 'he / him', 'he', 'him', 'he/him/his'],
            'She/Her':  ['she/her', 'she / her', 'she', 'her', 'she/her/hers'],
            'They/Them': ['they/them', 'they / them', 'they', 'them', 'they/them/theirs'],
            'Prefer not to say': ['prefer not', 'decline', 'choose not', 'not specified',
                "i don't wish", 'do not wish', 'prefer to self-describe', 'not listed']
        },
        hispanicLatino: {
            'Yes': ['yes', 'oui', 'hispanic', 'latino', 'latina', 'latinx', 'i am hispanic', 'i identify as hispanic', 'hispanic or latino'],
            'No': ['no', 'non', 'not hispanic', 'not latino', 'i am not hispanic', 'non-hispanic'],
            'Prefer not to say': ['prefer not', 'decline', 'choose not', 'not specified']
        },
        sexualOrientation: {
            'Heterosexual': ['heterosexual', 'straight', 'i am straight', 'i am heterosexual'],
            'Gay': ['gay', 'homosexual', 'i am gay'],
            'Lesbian': ['lesbian', 'i am lesbian'],
            'Bisexual': ['bisexual', 'bi', 'i am bisexual'],
            'Other': ['other', 'queer', 'pansexual', 'asexual', 'different identity'],
            'Prefer not to say': ['prefer not', 'decline', 'choose not', 'not specified', 'do not wish']
        },
        transgender: {
            'Yes': ['yes', 'oui', 'i identify as transgender', 'i am transgender', 'trans', 'i am trans'],
            'No': ['no', 'non', 'i do not identify as transgender', 'i am not transgender', 'cisgender', 'cis'],
            'Prefer not to say': ['prefer not', 'decline', 'choose not', 'not specified', 'do not wish']
        },
        liveInUS: {
            'Yes': ['yes', 'oui', 'i live in the us', 'i currently live in the us', 'yes i live', 'residing in the us', 'us resident', 'i am in the us', 'i am based in the us'],
            'No': ['no', 'non', 'i do not live in the us', 'i am not in the us', 'outside the us', 'not in the us', 'not based in the us']
        },
        currentlyEmployed: {
            'Yes': ['yes', 'oui', 'employed', 'currently employed', 'i am employed', 'i am currently employed'],
            'No': ['no', 'non', 'unemployed', 'not currently employed', 'i am not employed', 'not employed', 'between jobs']
        },
        driversLicense: {
            'Yes': ['yes', 'oui', 'i have a license', 'valid license', 'licensed', 'i hold a valid', 'i have a valid'],
            'No': ['no', 'non', 'i do not have', 'no license', 'i do not hold', 'unlicensed']
        },
        backgroundCheckConsent: {
            'Yes': ['yes', 'oui', 'i consent', 'i agree', 'agree', 'i authorize', 'authorize', 'i accept', 'accept'],
            'No': ['no', 'non', 'i do not consent', 'i disagree', 'disagree', 'decline', 'i do not agree']
        },
        drugTestConsent: {
            'Yes': ['yes', 'oui', 'i consent', 'i agree', 'agree', 'i authorize', 'authorize', 'i accept', 'accept'],
            'No': ['no', 'non', 'i do not consent', 'i disagree', 'disagree', 'decline', 'i do not agree']
        },
        ageEligible: {
            'Yes': ['yes', 'oui', 'i am 18', 'i am over 18', '18 or older', 'over 18', 'of legal age', 'i am of legal age', 'at least 18'],
            'No': ['no', 'non', 'i am not 18', 'under 18', 'below 18']
        },
        securityClearance: {
            'None': ['none', 'no clearance', 'no', 'i do not have', 'do not have', 'not applicable', 'n/a'],
            'Confidential': ['confidential'],
            'Secret': ['secret'],
            'Top Secret': ['top secret', 'ts', 'ts/sci', 'top secret/sci']
        },
        nonCompete: {
            'Yes': ['yes', 'oui', 'i am subject', 'i have a non-compete', 'have non-compete', 'subject to'],
            'No': ['no', 'non', 'i am not subject', 'no non-compete', 'not subject to', 'not applicable', 'none']
        },
        heardAboutUs: {
            // Note: "Found on Job Board (e.g. LinkedIn, Indeed, Handshake)" on Greenhouse
            // matches LinkedIn via the 'linkedin' token in the option text itself (fuzzy Phase 2).
            'LinkedIn': ['linkedin', 'linked in', 'linkedin / social media', 'linkedin job board'],
            'Job Board': ['job board', 'found on job board', 'job site', 'job portal', 'job listing'],
            'Indeed': ['indeed'],
            'Glassdoor': ['glassdoor'],
            'Referral': ['referral', 'referred', 'employee referral', 'referral from employee',
                'referred by', 'friend', 'colleague', 'word of mouth'],
            'Company Website': ['company website', 'website', 'direct', 'careers page', 'career page',
                'career site', 'our website'],
            'Recruiter': ['recruiter', 'recruiter contacted', 'headhunter', 'recruiter reached out',
                'staffing agency', 'recruiting firm'],
            'Google': ['google', 'search engine', 'online search'],
            'Social Media': ['social media', 'facebook', 'twitter', 'instagram', 'x.com'],
            'Event': ['career fair', 'hiring event', 'in person event', 'conference', 'meetup'],
            'Other': ['other']
        }
    };

    // Platform detection patterns
    const PLATFORM_PATTERNS = {
        workday: /myworkdayjobs\.com|workday\.com/i,
        gem: /(^|\.)jobs\.gem\.com/i,
        greenhouse: /greenhouse\.io|boards\.greenhouse/i,
        lever: /lever\.co|jobs\.lever/i,
        icims: /icims\.com/i,
        linkedin: /linkedin\.com/i,
        indeed: /indeed\.com|indeedassessments/i,
        bamboohr: /bamboohr\.com/i,
        smartrecruiters: /smartrecruiters\.com/i,
        taleo: /taleo\.net/i,
        // SuccessFactors: vendor-hosted (*.successfactors.com, *.sapsf.com) plus
        // common white-label custom-domain shape — /<Tenant>/job/<slug>/<jobId>/.
        // The white-label half also requires a DOM signature; field-mapper only
        // looks at the URL, so the JD adapter's detect() (markup-aware) is the
        // authoritative gate for white-label sites.
        successfactors: /successfactors\.com|sapsf\.com|\/[A-Za-z][\w-]*\/job\/[^/]+\/\d{6,}\/?/i,
        workable: /workable\.com/i,
        ashby: /ashbyhq\.com/i,
        careerpuck: /careerpuck\.com/i,
        beamery: /beamery\.com/i,
        breezy: /breezy\.hr|app\.breezy\.hr/i,
        pinpoint: /pinpointhq\.com/i,
        rippling: /rippling\.com/i,
        applied:        /beapplied\.com/i,
        personio:       /personio\.com|jobs\.personio\.com/i,
        jobvite:        /jobvite\.com/i,
        recruitee:      /recruitee\.com/i,
        fountain:       /fountain\.com|get\.fountain\.com/i,
        jazz:           /applytojob\.com|jazzhr\.com/i,
        oracle:         /oraclecloud\.com\/hcm|fa-[a-z0-9]+-saasfaprod|oracle\.com\/careers/i,
        netflix:        /jobs\.netflix\.net/i,
        tiktok:         /lifeattiktok\.com|careers\.tiktok\.com/i,
        // UKG Pro Recruiting (UltiPro). Career pages live on numbered
        // `recruiting<N>.ultipro.com` subdomains. The `signin.ultipro.com`
        // login flow is intentionally excluded — we don't auto-fill the
        // login form.
        ultipro:        /(^|\/\/)recruiting\d*\.ultipro\.com/i,
        // Ceridian Dayforce candidate portal — jobs.dayforcehcm.com/.../CANDIDATEPORTAL/...
        dayforce:       /dayforcehcm\.com|\/CANDIDATEPORTAL\//i,
        // Eightfold.ai ML-powered ATS — multi-tenant, <company>.eightfold.ai/careers/...
        eightfold:      /\.eightfold\.ai\b/i,
        // Teamtailor career sites — {tenant}.teamtailor.com/jobs/{id}-{slug}.
        // Many customers front the same site with a custom domain; those are
        // resolved by the markup-aware fallback in content.js _getPlatform().
        teamtailor:     /(^|\/\/|\.)teamtailor\.com/i
    };

    // ═══════════════════════════════════════════════════════════════════
    // FIELD IDENTIFICATION — 6 strategies in priority order
    // ═══════════════════════════════════════════════════════════════════

    // ── Token overlap helper ────────────────────────────────────────────
    // Computes Jaccard similarity on meaningful tokens (stop-words filtered).
    // Used by matchByCustomFields for semantic label matching.
    function tokenOverlap(a, b) {
        const STOP = new Set(['do', 'you', 'will', 'need', 'require', 'the', 'a', 'an', 'is',
            'are', 'your', 'have', 'to', 'for', 'of', 'in', 'on', 'at', 'be', 'can', 'i',
            'we', 'they', 'he', 'she', 'it', 'this', 'that', 'with', 'and', 'or', 'not',
            'what', 'how', 'if', 'my', 'us', 'any', 'all', 'has', 'was', 'but', 'so', 'please']);
        const tok = str => new Set(str.toLowerCase().split(/\W+/).filter(t => t.length > 1 && !STOP.has(t)));
        const tokA = tok(a);
        const tokB = tok(b);
        if (!tokA.size || !tokB.size) return 0;
        const intersection = [...tokA].filter(t => tokB.has(t)).length;
        const union = new Set([...tokA, ...tokB]).size;
        return intersection / union;
    }

    /**
     * Main entry: identify which profile field an input element maps to.
     * @param {HTMLElement} element
     * @param {Array} [customFields] – Optional profile-specific custom fields
     * @param {string} [contextLabel] – Enriched label text from content script (getElementContext)
     * @returns {{ profileField: string, confidence: number, strategy: string, isCustom: boolean } | null}
     */
    function identifyField(element, customFields = [], contextLabel = '', filler = null) {
        _currentFiller = filler;
        const strategies = [
            { fn: (el) => matchByCustomFields(el, customFields, contextLabel), name: 'custom-field' },
            { fn: matchByDataAutomationId, name: 'data-automation-id' }, // Workday
            { fn: matchByDataUi, name: 'data-ui' },                      // Workable
            { fn: matchByDataTestId, name: 'data-testid' },              // SmartRecruiters
            { fn: matchByName, name: 'name' },
            { fn: matchById, name: 'id' },
            { fn: matchByLabel, name: 'label' },
            { fn: matchByPlaceholder, name: 'placeholder' },
            { fn: matchByAriaLabel, name: 'aria-label' },
            // iCIMS and other platforms with opaque field names (e.g. "Question_12345"):
            // use the enriched context label computed by getElementContext() in content.js,
            // which walks up 8 ancestors looking for visible label text.
            { fn: (el) => matchByContextLabel(el, contextLabel), name: 'context-label' },
            { fn: matchByNearbyText, name: 'nearby-text' }
        ];

        for (const strategy of strategies) {
            const result = strategy.fn(element);
            if (result && result.confidence >= 0.3) {
                _currentFiller = null;
                return { ...result, strategy: strategy.name };
            }
        }

        _currentFiller = null;
        return null;
    }

    /**
     * Match an element against profile-specific custom fields.
     * @param {HTMLElement} element
     * @param {Array} customFields
     * @param {string} contextLabel – enriched label from content.js getElementContext()
     */
    function matchByCustomFields(element, customFields, contextLabel = '') {
        if (!customFields || !customFields.length) return null;

        const name = (element.getAttribute('name') || '').toLowerCase();
        const id = (element.id || '').toLowerCase();
        const labelResult = matchByLabel(element);
        // Use enriched contextLabel from content script if available (more thorough DOM search)
        const labelText = (labelResult?.labelText || contextLabel || '').toLowerCase();

        for (const cf of customFields) {
            const aliases = cf.aliases || [];
            const labelNorm = (cf.label || '').toLowerCase();

            // Defensive: skip customFields whose label/alias is itself (or contains
            // a substring of) a standard FIELD_MAPPINGS alias — e.g. label "first
            // name", "first and last name", "address", "phone ✱". Their value is
            // often a stale cache that would override the correct standard profile
            // field via the fuzzy / token-overlap matches below, before
            // matchByDataAutomationId / matchByName get a turn. We use the same
            // confidence machinery the standard matchers use (PHASE 1 exact = 1.0,
            // PHASE 2 substring = 0.6/0.75) and skip whenever a customField shadows
            // a known field at >=0.6 — strict legitimate customField matches
            // (true questions not covered by FIELD_MAPPINGS) won't trip this.
            const shadowsStandard = (() => {
                if (labelNorm) {
                    const m = matchAgainstAliases(labelNorm);
                    if (m && m.confidence >= 0.6) return true;
                }
                for (const a of aliases) {
                    const am = matchAgainstAliases(String(a).toLowerCase());
                    if (am && am.confidence >= 0.6) return true;
                }
                return false;
            })();
            if (shadowsStandard) continue;

            // 1. Strict/Alias match
            let isMatch = (name && (name === labelNorm || aliases.includes(name))) ||
                (id && (id === labelNorm || aliases.includes(id))) ||
                (labelText && (labelText === labelNorm || aliases.includes(labelText)));

            // 2. Word-boundary substring match
            // (e.g., "Expected Salary" matches "What is your expected salary?")
            // Word boundary prevents "salary" from matching "salary_bonus" or "base_salary_info"
            if (!isMatch && labelText && labelNorm.length > 3) {
                const escaped = labelNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const wbRe = new RegExp(`(?:^|[\\s,;:])${escaped}(?:[\\s,;:?]|$)`, 'i');
                if (wbRe.test(labelText)) {
                    isMatch = true;
                }
            }

            // 3. Semantic token overlap — handles rephrased questions
            // (e.g., "Do you require visa sponsorship?" matches custom label "Will you need visa sponsorship?")
            if (!isMatch && labelText && labelNorm.length > 3) {
                if (tokenOverlap(labelText, labelNorm) >= 0.5) {
                    isMatch = true;
                }
            }

            if (isMatch) {
                const exactOrSubstring = labelText === labelNorm || labelText.includes(labelNorm) || labelNorm.includes(labelText);
                return {
                    profileField: `custom_${cf.label}`,
                    confidence: exactOrSubstring ? 1.0 : 0.75,
                    isCustom: true,
                    customValue: cf.value,
                    customLabel: cf.label
                };
            }
        }
        return null;
    }


    // Strategy 1: match by name attribute
    function matchByName(element) {
        const name = element.getAttribute('name');
        if (!name) return null;
        return matchAgainstAliases(name.toLowerCase());
    }

    // Strategy 2: match by id attribute
    function matchById(element) {
        const id = element.id;
        if (!id) return null;
        return matchAgainstAliases(id.toLowerCase());
    }

    // Strategy 3: match by associated <label>
    function matchByLabel(element) {
        let labelText = '';

        // Use the element's root node (handles shadow DOM — Workday, etc.)
        const root = element.getRootNode ? element.getRootNode() : document;

        // Find by "for" attribute — search within shadow root, not document
        if (element.id) {
            const label = root.querySelector(`label[for="${CSS.escape(element.id)}"]`);
            if (label) labelText = label.textContent.trim();
        }

        // Find by parent <label>
        if (!labelText) {
            const parentLabel = element.closest('label');
            if (parentLabel) labelText = parentLabel.textContent.trim();
        }

        // Find by aria-labelledby within same root
        if (!labelText) {
            const labelledBy = element.getAttribute('aria-labelledby');
            if (labelledBy) {
                labelText = labelledBy.split(' ')
                    .map(id => root.querySelector(`#${CSS.escape(id)}`))
                    .filter(Boolean)
                    .map(el => el.textContent.trim())
                    .join(' ').trim();
            }
        }

        if (!labelText) return null;

        const result = matchAgainstAliases(labelText.toLowerCase());
        if (result) {
            result.confidence = Math.min(result.confidence, 0.9);
            result.labelText = labelText;
        } else {
            return { labelText }; // Return labelText even if no alias match found
        }
        return result;
    }


    // Strategy 4: match by placeholder
    function matchByPlaceholder(element) {
        const placeholder = element.getAttribute('placeholder');
        if (!placeholder) return null;
        const result = matchAgainstAliases(placeholder.toLowerCase());
        if (result) result.confidence = Math.min(result.confidence, 0.8);
        return result;
    }

    // Strategy 5: match by aria-label
    function matchByAriaLabel(element) {
        const ariaLabel = element.getAttribute('aria-label');
        if (!ariaLabel) return null;
        const result = matchAgainstAliases(ariaLabel.toLowerCase());
        if (result) result.confidence = Math.min(result.confidence, 0.7);
        return result;
    }

    // Strategy 9: match by enriched context label (from content.js getElementContext)
    // This is the primary signal for iCIMS ("Question_12345" fields) and any platform
    // where the visible question text is the only reliable field identifier.
    // contextLabel is passed in from content.js after a deep DOM ancestor walk.
    function matchByContextLabel(element, contextLabel) {
        if (!contextLabel || contextLabel.length < 3) return null;
        // Strip annotation characters (asterisks = required, colons, question marks)
        const cleaned = contextLabel.replace(/[*?:]/g, '').trim();
        if (!cleaned || cleaned.length < 3) return null;
        const result = matchAgainstAliases(cleaned.toLowerCase());
        if (result) {
            // Cap below direct attribute strategies; context label can contain extra text
            result.confidence = Math.min(result.confidence, 0.85);
        }
        return result;
    }

    // Strategy 6: match by nearby text
    function matchByNearbyText(element) {
        const textsToCheck = [];

        // Previous sibling text
        if (element.previousElementSibling) {
            const text = element.previousElementSibling.textContent.trim();
            if (text.length < 100) textsToCheck.push(text);
        }

        // Parent direct text (not children's text)
        const parent = element.parentElement;
        if (parent) {
            for (const node of parent.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent.trim();
                    if (text.length > 2 && text.length < 100) textsToCheck.push(text);
                }
            }
        }

        for (const text of textsToCheck) {
            const result = matchAgainstAliases(text.toLowerCase());
            if (result) {
                result.confidence = Math.min(result.confidence, 0.5);
                return result;
            }
        }

        return null;
    }

    // Strategy 7: Workday — data-automation-id attribute
    // Workday uses this as the primary field identifier, e.g. "legalNameSection_firstName"
    function matchByDataAutomationId(element) {
        // Check element itself or nearest ancestor with the attribute
        let automationId = element.getAttribute('data-automation-id');
        if (!automationId) {
            const ancestor = element.closest('[data-automation-id]');
            automationId = ancestor ? ancestor.getAttribute('data-automation-id') : null;
        }
        if (!automationId) return null;

        // Normalise: strip section prefix (e.g. "legalNameSection_firstName" → "firstName")
        const raw = automationId.toLowerCase();
        const afterUnderscore = raw.includes('_') ? raw.split('_').pop() : raw;
        const afterDash = raw.includes('--') ? raw.split('--').pop() : afterUnderscore;

        return matchAgainstAliases(afterDash) || matchAgainstAliases(raw);
    }

    // Strategy 8a: Workable — data-ui attribute
    // Workable uses e.g. data-ui="firstname", data-ui="cover_letter"
    function matchByDataUi(element) {
        let dataUi = element.getAttribute('data-ui');
        if (!dataUi) {
            const ancestor = element.closest('[data-ui]');
            dataUi = ancestor ? ancestor.getAttribute('data-ui') : null;
        }
        if (!dataUi) return null;
        return matchAgainstAliases(dataUi.toLowerCase());
    }

    // Strategy 8: SmartRecruiters — data-testid attribute
    // SR uses e.g. data-testid="input-firstName", data-testid="experience-title"
    function matchByDataTestId(element) {
        let testId = element.getAttribute('data-testid');
        if (!testId) {
            const ancestor = element.closest('[data-testid]');
            testId = ancestor ? ancestor.getAttribute('data-testid') : null;
        }
        if (!testId) return null;

        // Strip field-type prefixes AND section prefixes in order.
        // Section prefixes are stripped so "experience-title" → "title" → currentJobTitle
        // and "education-school" → "school" → university.
        let cleaned = testId.toLowerCase()
            .replace(/^(input|field|form|sr)[-_]/i, '')          // type prefix
            .replace(/^(experience|education|work|job|school)[-_]/i, ''); // section prefix

        return matchAgainstAliases(cleaned) ||
               matchAgainstAliases(testId.toLowerCase().replace(/^(input|field|form|sr)[-_]/i, '')) ||
               matchAgainstAliases(testId.toLowerCase());
    }

    // ─── Core matching logic ──────────────────────────────────────────

    // Module-level filler context — set by identifyField, read by matchAgainstAliases.
    // Safe because JS is single-threaded; no concurrent identifyField calls possible.
    let _currentFiller = null;

    function matchAgainstAliases(input) {
        // Remove common punctuation and trim
        const cleaned = input
            .replace(/[\[\](){}]/g, '')
            .replace(/[*:]/g, '')
            .toLowerCase()
            .trim();

        if (!cleaned) return null;

        // Per-platform alias extensions (set by identifyField via _currentFiller)
        const _extraAliases = _currentFiller?.getFieldAliases?.() ?? {};

        // PHASE 1: EXACT MATCHES (Highest Priority)
        // We check every field for an exact match before trying any partial matches
        for (const [field, config] of Object.entries(FIELD_MAPPINGS)) {
            // Exact match on field key (internal name)
            if (cleaned === field.toLowerCase()) {
                return { profileField: field, confidence: 1.0 };
            }

            // Exact match on any alias (global + platform-specific)
            const allAliases = [...config.aliases, ...(_extraAliases[field] ?? [])];
            for (const alias of allAliases) {
                if (cleaned === alias) {
                    return { profileField: field, confidence: 1.0 };
                }
            }
        }

        // PHASE 2: SUBSTRING MATCHES (Only if no exact match found)
        // Minimum alias length of 5 prevents short tokens like 'name', 'mail', 'id'
        // from creating false cross-matches (e.g. 'username' matching 'fullName' via 'name').
        const MIN_SUBSTRING_ALIAS_LEN = 5;
        let bestMatch = null;
        let bestMatchLength = 0;

        for (const [field, config] of Object.entries(FIELD_MAPPINGS)) {
            const allAliases2 = [...config.aliases, ...(_extraAliases[field] ?? [])];
            for (const alias of allAliases2) {
                if (alias.length < MIN_SUBSTRING_ALIAS_LEN) continue; // skip short aliases
                // Check if alias is a whole word or significant part of input
                // Or if input is part of a longer alias.
                // The reverse direction (alias.includes(cleaned)) needs the SAME
                // min-length guard on `cleaned` — otherwise a 1-2 char field name
                // ("q", "s") is a substring of some long alias and mis-maps at 0.8.
                if (cleaned.includes(alias) ||
                    (cleaned.length >= MIN_SUBSTRING_ALIAS_LEN && alias.includes(cleaned))) {
                    // We prioritize LONGER alias matches to be more specific
                    // e.g. "company_name" is a better match for "company_name_field" than just "name"
                    if (alias.length > bestMatchLength) {
                        bestMatchLength = alias.length;
                        // M1 FIX: when alias appears as a complete word/segment in the input
                        // (e.g. "email" in "candidate_email"), confidence is 0.75 not 0.6.
                        // This avoids yellow-badge on high-frequency unambiguous fields like email.
                        const isWholeSegment = new RegExp(`(^|[_\\-\\[\\]])${alias}([_\\-\\[\\]]|$)`).test(cleaned);
                        const confidence = alias.length >= cleaned.length ? 0.8 : (isWholeSegment ? 0.75 : 0.6);
                        // Expose which alias matched and where — lets callers (e.g. a
                        // platform-scoped override in content.js) tell "the label's
                        // actual topic is X" apart from "X is one incidental word deep
                        // inside an unrelated multi-clause sentence" on long custom
                        // question labels. Purely additive metadata; doesn't affect
                        // confidence or which match wins here.
                        bestMatch = { profileField: field, confidence, alias, aliasIndex: cleaned.indexOf(alias) };
                    }
                }
            }
        }

        return bestMatch;
    }

    // ═══════════════════════════════════════════════════════════════════
    // FUZZY OPTION MATCHING — for <select> and custom dropdowns
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Find the best matching option from a list for a given target value.
     * @param {Array<{text: string, value: string, index: number}>} options
     * @param {string} targetValue
     * @param {string} fieldName — optional, for VALUES_MAP lookup
     * @param {string} [questionLabel] – The actual question text from the page (e.g. "Do you require sponsorship?")
     * @returns {{ index: number, text: string, confidence: number } | null}
     */
    // ── Per-field semantic inversion patterns ──────────────────────────
    // Some form questions are phrased OPPOSITE to the profile field's polarity.
    // This dictionary maps profileField → {positive} trigger patterns (questions
    // that invert the meaning) and (non-inversion) patterns (keep polarity).
    // On a match, the effective answer is flipped.
    const FIELD_INVERSIONS = {
        workAuthorization: {
            // "Do you REQUIRE sponsorship?" → profile Yes (authorized) → answer No
            invert: /require.{0,25}sponsor|need.{0,25}sponsor|sponsor.{0,25}require|will.{0,15}need.{0,15}visa|need.{0,15}work.{0,15}visa|visa sponsor|employer sponsor|commence.{0,20}immigr|sponsor.{0,20}immigr|immigr.{0,20}case/i,
            noInvert: /authorized.{0,20}work|legally authorized|eligible to work|right to work|work permit|currently authorized/i
        },
        willingToRelocate: {
            // "Are you UNWILLING to relocate?" → profile Yes (willing) → answer No
            invert: /unwilling|not willing|unable to relocate|cannot relocate|prefer not to move/i,
            noInvert: /willing|open to|will relocate|can relocate|would you relocate/i
        },
        currentlyEmployed: {
            // "Are you currently UNEMPLOYED?" → profile Yes (employed) → answer No
            invert: /currently unemployed|not currently employed|are you unemployed|are you out of work/i,
            noInvert: /currently employed|are you employed|currently working|do you have a job/i
        },
        nonCompete: {
            // "Are you FREE of non-compete obligations?" → profile Yes (has non-compete) → answer No
            invert: /free from|not subject|free of non-compete|no non-compete agreement/i,
            noInvert: /non-compete|noncompete|restrictive covenant|subject to/i
        }
    };

    // French → English normalization map for option text and profile values
    const FRENCH_NORM = { 'oui': 'yes', 'non': 'no' };

    function fuzzyMatchOption(options, targetValue, fieldName, questionLabel, filler) {
        if (!targetValue || !Array.isArray(options) || !options.length) return null;

        // Normalize French profile values so "oui"/"non" work as "yes"/"no"
        const rawTarget = targetValue.toLowerCase().trim();
        const target = FRENCH_NORM[rawTarget] || rawTarget;
        const question = (questionLabel || '').toLowerCase();

        // ── 0. Semantic inversion detection — covers multiple fields ──
        // Detects when the form question is phrased opposite to the profile value polarity.
        // No AI needed: pure regex on the question text. Handles workAuthorization,
        // willingToRelocate, currentlyEmployed, nonCompete and more.
        if (fieldName && question && FIELD_INVERSIONS[fieldName]) {
            const inv = FIELD_INVERSIONS[fieldName];
            const isInverted = inv.invert.test(question) && !inv.noInvert.test(question);

            if (isInverted) {
                let profileYes = ['yes', 'true', '1', 'authorized', 'willing', 'employed', 'have'].includes(target);
                let profileNo  = ['no', 'false', '0', 'not authorized', 'unwilling', 'unemployed', 'none'].includes(target);

                // workAuthorization stores human-readable status ("US Citizen", "Green Card", "H1B Visa")
                // not just "yes"/"no" — resolve these to polarity explicitly before inverting.
                if (fieldName === 'workAuthorization' && !profileYes && !profileNo) {
                    const noSponsorStatuses  = ['us citizen', 'green card', 'ead', 'opt', 'citizen', 'permanent resident', 'work permit', 'authorized', 'not require', 'will not require'];
                    const needsSponsorStatuses = ['require sponsorship', 'h1b', 'h-1b', 'needs sponsorship', 'need sponsorship', 'visa required'];
                    profileYes = noSponsorStatuses.some(s => target.includes(s));
                    profileNo  = needsSponsorStatuses.some(s => target.includes(s));
                }

                const invertedTarget = profileYes ? 'no' : profileNo ? 'yes' : null;
                if (invertedTarget) {
                    // Score all options: best match for the inverted target
                    let bestOpt = null, bestLen = -1;
                    for (const opt of options) {
                        const optText = opt.text.toLowerCase().trim();
                        if (optText === invertedTarget || optText.startsWith(invertedTarget + ' ') || optText.startsWith(invertedTarget + ',')) {
                            if (optText.length > bestLen) { bestLen = optText.length; bestOpt = opt; }
                        }
                    }
                    if (bestOpt) return { index: bestOpt.index, text: bestOpt.text, confidence: 0.88 };
                }
            }
        }

        // ── 1. Exact match (case-insensitive) — score ALL, pick best if tie ──
        // Also strips phone dial code suffixes (e.g. "United States +1" → "United States")
        // so country dropdowns that append dial codes still match profile values exactly.
        const _stripDialCode = t => t.replace(/\s+\+\d+$/, '');
        for (const opt of options) {
            const optText = opt.text.toLowerCase().trim();
            const optVal  = opt.value.toLowerCase().trim();
            if (optText === target || optVal === target ||
                _stripDialCode(optText) === target || _stripDialCode(optVal) === target) {
                return { index: opt.index, text: opt.text, confidence: 1.0 };
            }
        }

        // ── 2. VALUES_MAP lookup — negation-aware, full-option scoring ──
        // Scores EVERY available option against the matched canonical bucket.
        // Negation polarity mismatch = score zeroed out (hard rejection).
        const _platformValueOverrides = filler?.getValueOverrides?.() ?? {};
        const _effectiveMap = _platformValueOverrides[fieldName]
            ? { ...VALUES_MAP[fieldName], ..._platformValueOverrides[fieldName] }
            : VALUES_MAP[fieldName];
        if (fieldName && _effectiveMap) {
            const map = _effectiveMap;
            const NEGATION = /\b(not|no|never|don't|dont|cannot|can't|cant|without|non)\b/i;
            const targetNegated = NEGATION.test(target);

            let bestOpt = null;
            let bestScore = -1;
            let matchedCanonical = null;

            // Whole-phrase boundary check — prevents substring false positives
            const containsWholePhrase = (text, phrase) => {
                if (text === phrase) return true;
                const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp('(?:^|[\\s,])' + esc + '(?:[\\s,]|$)').test(text);
            };

            for (const [canonical, synonyms] of Object.entries(map)) {
                const isTargetMatch =
                    canonical.toLowerCase() === target ||
                    synonyms.some(s => target === s || containsWholePhrase(target, s));
                if (!isTargetMatch) continue;
                matchedCanonical = canonical;

                for (const opt of options) {
                    const optText = opt.text.toLowerCase().trim();
                    let score = 0;

                    if (optText === canonical.toLowerCase())           score = 1.0;
                    else if (synonyms.some(s => optText === s))        score = 0.95;
                    else if (synonyms.some(s => containsWholePhrase(optText, s))) score = 0.80;
                    else if (synonyms.some(s => optText.includes(s))) score = 0.70;
                    else if (optText.includes(canonical.toLowerCase())) score = 0.60;

                    if (score === 0) continue;

                    // Hard-reject definitive negation polarity mismatches
                    // (e.g., "I am a veteran" option for target "I am NOT a veteran")
                    const optNegated = NEGATION.test(optText);
                    if (targetNegated !== optNegated) {
                        // Only reject when the polarity difference is unambiguous
                        // (both sides must have real content, not just "yes"/"no")
                        if (optText.length > 8 || target.length > 6) {
                            score = 0; // Hard reject
                        } else {
                            score *= 0.4; // Soft penalty for short yes/no answers
                        }
                    }

                    if (score > bestScore) { bestScore = score; bestOpt = opt; }
                }
            }

            if (bestOpt && bestScore > 0.25) {
                return {
                    index: bestOpt.index,
                    text: bestOpt.text,
                    confidence: Math.min(0.92, 0.52 + bestScore * 0.4)
                };
            }
        }

        // ── 3. Prefix / substring match ──
        let prefixBest = null, prefixConf = 0;
        for (const opt of options) {
            const optText = opt.text.toLowerCase().trim();

            // Option starts with the target (e.g. "yes" in "yes, I am authorized")
            if (optText.startsWith(target) && target.length > 1) {
                const ratio = target.length / Math.max(optText.length, 1);
                const conf = Math.max(0.65, Math.min(ratio, 0.78));
                if (conf > prefixConf) { prefixConf = conf; prefixBest = opt; }
                continue;
            }

            // Target starts with the option (shorter option at start of longer target)
            if (target.startsWith(optText) && optText.length > 1) {
                const ratio = optText.length / Math.max(target.length, 1);
                if (ratio > 0.5) {
                    const conf = Math.min(ratio, 0.72);
                    if (conf > prefixConf) { prefixConf = conf; prefixBest = opt; }
                }
                continue;
            }

            // General substring with sufficient length ratio
            if (optText.length > 0 && (optText.includes(target) || target.includes(optText))) {
                const overlap = Math.min(target.length, optText.length) / Math.max(target.length, optText.length, 1);
                if (overlap > 0.5) {
                    const conf = Math.min(overlap, 0.72);
                    if (conf > prefixConf) { prefixConf = conf; prefixBest = opt; }
                }
            }
        }
        if (prefixBest) return { index: prefixBest.index, text: prefixBest.text, confidence: prefixConf };

        // ── 4. Token overlap — handles verbose option text vs concise profile value ──
        // e.g., profile "Remote" matches option "Fully Remote / Work From Home"
        // Threshold lowered to 0.5 (was 0.8) for single-token profile values.
        const STOP_WORDS = new Set(['i', 'a', 'an', 'the', 'is', 'are', 'do', 'you', 'to', 'or', 'of', 'in', 'on', 'at', 'be', 'and', 'it', 'my', 'we', 'not']);
        const targetTokens = target.split(/\W+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
        if (targetTokens.length > 0) {
            let tokBestScore = 0;
            let tokBestOpt = null;
            for (const opt of options) {
                const optTokenSet = new Set(opt.text.toLowerCase().split(/\W+/).filter(t => t.length > 1 && !STOP_WORDS.has(t)));
                const matched = targetTokens.filter(t => optTokenSet.has(t)).length;
                const score = matched / targetTokens.length;
                if (score > tokBestScore) { tokBestScore = score; tokBestOpt = opt; }
            }
            if (tokBestOpt && tokBestScore >= 0.5) {
                return { index: tokBestOpt.index, text: tokBestOpt.text, confidence: Math.min(0.78, 0.42 + tokBestScore * 0.36) };
            }
        }

        // ── 5. First-word match — only for unambiguous short triggers (yes/no/male/female) ──
        const firstWord = target.split(/\W+/)[0];
        const SHORT_TRIGGERS = new Set(['yes', 'no', 'oui', 'non', 'male', 'female', 'remote', 'hybrid', 'full', 'part', 'none', 'other']);
        if (firstWord && (firstWord.length > 3 || SHORT_TRIGGERS.has(firstWord))) {
            for (const opt of options) {
                const optFirstWord = (opt.text.toLowerCase().split(/\W+/)[0] || '');
                if (optFirstWord === firstWord) {
                    // Higher confidence for longer first words (more specific)
                    const conf = firstWord.length > 4 ? 0.65 : 0.58;
                    return { index: opt.index, text: opt.text, confidence: conf };
                }
            }
        }

        // ── 6. Safe neutral fallback ──
        // When ALL matching strategies fail, prefer a "Prefer not to say" / "N/A" / "Decline"
        // option over leaving the field blank or guessing wrong — especially critical for
        // sensitive EEO questions where a wrong affirmative answer is harmful.
        // Returns very low confidence (0.22) → red highlight + hint badge, but no bad answer.
        const NEUTRAL_RX = /prefer not|decline|choose not|not specified|n\/a|not applicable|do not wish|i don.t wish|no answer/i;
        for (const opt of options) {
            // Skip blank placeholders
            if (!opt.value || opt.value === '--' || opt.value === '-' || opt.text.trim() === '') continue;
            if (NEUTRAL_RX.test(opt.text)) {
                return { index: opt.index, text: opt.text, confidence: 0.22 };
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PLATFORM DETECTION
    // ═══════════════════════════════════════════════════════════════════

    // Platforms that should resolve to an existing filler class
    const PLATFORM_ALIASES = {
        oracle:        'generic',   // Oracle HCM — no dedicated filler yet, generic is best effort
    };

    function detectPlatform(url) {
        for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
            if (pattern.test(url)) return PLATFORM_ALIASES[platform] || platform;
        }
        return 'generic';
    }

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════

    const QuickApplyFieldMapper = {
        identifyField,
        matchByName,
        matchById,
        matchByLabel,
        matchByPlaceholder,
        matchByAriaLabel,
        matchByNearbyText,
        fuzzyMatchOption,
        detectPlatform,
        getFieldMappings: () => FIELD_MAPPINGS,
        getValuesMap: () => VALUES_MAP
    };

    if (typeof window !== 'undefined') {
        window.QuickApplyFieldMapper = QuickApplyFieldMapper;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.QuickApplyFieldMapper = QuickApplyFieldMapper;
    }

})();
