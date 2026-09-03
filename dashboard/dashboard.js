/**
 * QuickApply Dashboard — Client Management UI
 * Reference: DATA_SCHEMA.md § 1, UI_SPEC.md § 4, BUILD_GUIDE.md Phase 2
 */

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────
    let currentClientId = null;
    let clients = [];
    let workExperienceEntries = [];
    let educationEntries = [];
    const learningTables = {
        corrections: [],
        platformKnowledge: [],
        registry: []
    };

    // ─── All form field IDs matching the profile schema ────────────
    const FORM_FIELDS = [
        'firstName', 'lastName', 'middleName', 'preferredName',
        'email', 'phone', 'defaultPassword',
        'linkedIn', 'portfolio', 'github',
        'streetAddress', 'city', 'state', 'zipCode', 'country',
        'gender', 'pronouns', 'ethnicity', 'hispanicLatino', 'sexualOrientation',
        'veteranStatus', 'disabilityStatus',
        'currentJobTitle', 'currentCompany', 'yearsOfExperience',
        'highestEducation', 'university', 'major', 'graduationYear', 'gpa',
        'skills', 'certifications', 'languages',
        'workAuthorization', 'willingToRelocate', 'expectedSalary', 'salaryCurrency',
        'noticePeriod', 'desiredEmploymentType', 'remotePreference', 'desiredStartDate',
        'driversLicense', 'backgroundCheckConsent', 'drugTestConsent', 'ageEligible',
        'securityClearance', 'nonCompete', 'heardAboutUs', 'coverLetter',
        'targetJobTitle', 'targetJobFunction'
    ];

    // Section → fields mapping for completion tracking
    const SECTION_FIELDS = {
        jobprefs:    ['targetJobTitle', 'targetJobFunction'],
        personal:    ['firstName', 'lastName', 'email', 'phone', 'defaultPassword'],
        online:      ['linkedIn', 'github', 'portfolio'],
        address:     ['streetAddress', 'city', 'state', 'zipCode', 'country'],
        experience:  [],  // dynamic — tracked separately
        education:   [],  // dynamic — tracked separately
        skills:      ['skills', 'certifications', 'languages'],
        // preferredLocations and targetRoles are intentionally excluded: they are arrays and
        // updateAllCompletions uses a plain truthy check (client[f]), where [] is truthy,
        // so including them would falsely mark the section complete on every profile.
        workprefs:   ['workAuthorization', 'expectedSalary', 'noticePeriod', 'desiredEmploymentType', 'remotePreference'],
        eeo:         ['gender', 'veteranStatus', 'disabilityStatus'],
        appdefaults: ['heardAboutUs', 'coverLetter']
    };

    const _REC_KEY = 'quickapply_session_recordings';

    // ─── DOM References ───────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ─── Initialize ───────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        await loadClients();
        await loadSettings();
        renderSidebar();
        bindEvents();
        updateStorageIndicator();
        loadSuggestions();
        loadDailyTargets();
    }

    // ─── Load & Render Clients ────────────────────────────────────────

    async function loadClients() {
        clients = await QuickApplyStorage.getClients();
    }

    function renderSidebar(filter = '') {
        const list = $('#client-list');
        const filtered = filter
            ? clients.filter(c => c.fullName?.toLowerCase().includes(filter.toLowerCase()))
            : clients;

        list.innerHTML = '';

        filtered.forEach((client) => {
            const card = document.createElement('div');
            card.className = 'sidebar-card' + (client.id === currentClientId ? ' active' : '');
            card.setAttribute('data-id', client.id);

            const initials = getInitials(client.firstName, client.lastName);
            const color = client.avatarColor || '#7C6AFF';
            const status = getClientStatus(client);

            card.innerHTML = `
        <div class="avatar" style="color: ${color}; border-color: ${color};">
          ${initials}
        </div>
        <div class="card-info">
          <div class="card-name">${escapeHtml(client.fullName || 'Unnamed')}</div>
          <div class="card-email">${escapeHtml(client.email || 'No email')}</div>
        </div>
        <div class="card-status ${status}"></div>
      `;

            card.addEventListener('click', () => selectClient(client.id));
            list.appendChild(card);
        });

        $('#client-count').textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;
    }

    function getInitials(first, last) {
        const f = (first || '').charAt(0).toUpperCase();
        const l = (last || '').charAt(0).toUpperCase();
        return f + l || '??';
    }

    function getClientStatus(client) {
        const required = ['firstName', 'lastName', 'email'];
        const allRequired = required.every(f => client[f]);
        if (!allRequired) return 'empty';
        const filled = FORM_FIELDS.filter(f => client[f]).length;
        return filled > 15 ? 'complete' : 'partial';
    }

    // ─── Multi-entry: Work Experience ─────────────────────────────
    function renderWorkExperience() {
        const list = $('#work-experience-list');
        if (!list) return;
        list.innerHTML = '';
        if (workExperienceEntries.length === 0) {
            workExperienceEntries = [{}];
        }
        workExperienceEntries.forEach((entry, idx) => list.appendChild(createExperienceEntry(entry, idx)));
        $('#experience-completion').textContent = workExperienceEntries.filter(e => e.jobTitle).length + ' entries';
    }

    function createExperienceEntry(entry, idx) {
        const div = document.createElement('div');
        div.className = 'multi-entry';
        div.dataset.idx = idx;
        div.innerHTML = `
      <div class="multi-entry-header">
        <span class="multi-entry-title">Experience ${idx + 1}</span>
        <button type="button" class="btn-remove-entry">Remove</button>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Job Title</label><input type="text" class="form-input exp-field" data-field="jobTitle" value="${escapeHtml(entry.jobTitle||'')}" placeholder="e.g. Senior Software Engineer"></div>
        <div class="form-row"><label class="form-label">Company</label><input type="text" class="form-input exp-field" data-field="company" value="${escapeHtml(entry.company||'')}" placeholder="e.g. Google"></div>
        <div class="form-row"><label class="form-label">Job Type</label><select class="form-select exp-field" data-field="jobType"><option value="">Select</option><option ${entry.jobType==='Full-time'?'selected':''}>Full-time</option><option ${entry.jobType==='Part-time'?'selected':''}>Part-time</option><option ${entry.jobType==='Contract'?'selected':''}>Contract</option><option ${entry.jobType==='Internship'?'selected':''}>Internship</option></select></div>
        <div class="form-row"><label class="form-label">Location</label><input type="text" class="form-input exp-field" data-field="location" value="${escapeHtml(entry.location||'')}" placeholder="e.g. New York, NY or Remote"></div>
        <div class="form-row"><label class="form-label">Start Date</label><input type="text" class="form-input exp-field" data-field="startDate" value="${escapeHtml(entry.startDate||'')}" placeholder="e.g. Jan 2022"></div>
        <div class="form-row"><label class="form-label">End Date</label><input type="text" class="form-input exp-field" data-field="endDate" value="${escapeHtml(entry.currentlyWorking?'':entry.endDate||'')}" placeholder="e.g. Mar 2024" ${entry.currentlyWorking?'disabled':''}></div>
      </div>
      <div class="form-row" style="margin-top:4px">
        <label class="checkbox-option" style="border:none;padding:0"><input type="checkbox" class="exp-field" data-field="currentlyWorking" ${entry.currentlyWorking?'checked':''}> &nbsp;I currently work here</label>
      </div>
      <div class="form-row full-width" style="margin-top:8px">
        <label class="form-label">Experience Summary</label>
        <textarea class="form-textarea exp-field" data-field="description" placeholder="Key responsibilities and achievements...">${escapeHtml(entry.description||'')}</textarea>
      </div>`;
        div.querySelector('.btn-remove-entry').addEventListener('click', () => { workExperienceEntries.splice(idx, 1); renderWorkExperience(); });
        const cwCheck = div.querySelector('[data-field="currentlyWorking"]');
        const endInput = div.querySelector('[data-field="endDate"]');
        cwCheck.addEventListener('change', () => { endInput.disabled = cwCheck.checked; if(cwCheck.checked) endInput.value=''; syncExperience(); });
        div.querySelectorAll('.exp-field').forEach(el => el.addEventListener('input', syncExperience));
        div.querySelectorAll('.exp-field').forEach(el => el.addEventListener('change', syncExperience));
        return div;
    }

    function syncExperience() {
        const list = $('#work-experience-list');
        if (!list) return;
        workExperienceEntries = Array.from(list.querySelectorAll('.multi-entry')).map(div => ({
            jobTitle: div.querySelector('[data-field="jobTitle"]')?.value?.trim()||'',
            company: div.querySelector('[data-field="company"]')?.value?.trim()||'',
            jobType: div.querySelector('[data-field="jobType"]')?.value||'',
            location: div.querySelector('[data-field="location"]')?.value?.trim()||'',
            startDate: div.querySelector('[data-field="startDate"]')?.value?.trim()||'',
            endDate: div.querySelector('[data-field="endDate"]')?.value?.trim()||'',
            currentlyWorking: div.querySelector('[data-field="currentlyWorking"]')?.checked||false,
            description: div.querySelector('[data-field="description"]')?.value?.trim()||''
        }));
    }

    // ─── Multi-entry: Education ────────────────────────────────────
    function renderEducationHistory() {
        const list = $('#education-list');
        if (!list) return;
        list.innerHTML = '';
        if (educationEntries.length === 0) {
            educationEntries = [{}];
        }
        educationEntries.forEach((entry, idx) => list.appendChild(createEducationEntry(entry, idx)));
        $('#education-completion').textContent = educationEntries.filter(e => e.school).length + ' entries';
    }

    function createEducationEntry(entry, idx) {
        const div = document.createElement('div');
        div.className = 'multi-entry';
        div.dataset.idx = idx;
        const degrees = ['','High School','Associate\'s','Bachelor\'s','Master\'s','Doctorate','Professional','Other'];
        div.innerHTML = `
      <div class="multi-entry-header">
        <span class="multi-entry-title">Education ${idx + 1}</span>
        <button type="button" class="btn-remove-entry">Remove</button>
      </div>
      <div class="form-grid">
        <div class="form-row full-width"><label class="form-label">School / University</label><input type="text" class="form-input edu-field" data-field="school" value="${escapeHtml(entry.school||'')}" placeholder="e.g. MIT"></div>
        <div class="form-row"><label class="form-label">Degree Type</label><select class="form-select edu-field" data-field="degree">${degrees.map(d=>`<option ${entry.degree===d?'selected':''}>${d}</option>`).join('')}</select></div>
        <div class="form-row"><label class="form-label">Major / Field of Study</label><input type="text" class="form-input edu-field" data-field="major" value="${escapeHtml(entry.major||'')}" placeholder="e.g. Computer Science"></div>
        <div class="form-row"><label class="form-label">GPA</label><input type="text" class="form-input edu-field" data-field="gpa" value="${escapeHtml(entry.gpa||'')}" placeholder="e.g. 3.8"></div>
        <div class="form-row"><label class="form-label">Start Date</label><input type="text" class="form-input edu-field" data-field="startDate" value="${escapeHtml(entry.startDate||'')}" placeholder="e.g. Sep 2018"></div>
        <div class="form-row"><label class="form-label">End Date</label><input type="text" class="form-input edu-field" data-field="endDate" value="${escapeHtml(entry.currentlyStudying?'':entry.endDate||'')}" placeholder="e.g. Jun 2022" ${entry.currentlyStudying?'disabled':''}></div>
      </div>
      <div class="form-row" style="margin-top:4px">
        <label class="checkbox-option" style="border:none;padding:0"><input type="checkbox" class="edu-field" data-field="currentlyStudying" ${entry.currentlyStudying?'checked':''}> &nbsp;I currently study here</label>
      </div>`;
        div.querySelector('.btn-remove-entry').addEventListener('click', () => { educationEntries.splice(idx, 1); renderEducationHistory(); });
        const csCheck = div.querySelector('[data-field="currentlyStudying"]');
        const endInput = div.querySelector('[data-field="endDate"]');
        csCheck.addEventListener('change', () => { endInput.disabled = csCheck.checked; if(csCheck.checked) endInput.value=''; syncEducation(); });
        div.querySelectorAll('.edu-field').forEach(el => el.addEventListener('input', syncEducation));
        div.querySelectorAll('.edu-field').forEach(el => el.addEventListener('change', syncEducation));
        return div;
    }

    function syncEducation() {
        const list = $('#education-list');
        if (!list) return;
        educationEntries = Array.from(list.querySelectorAll('.multi-entry')).map(div => ({
            school: div.querySelector('[data-field="school"]')?.value?.trim()||'',
            degree: div.querySelector('[data-field="degree"]')?.value||'',
            major: div.querySelector('[data-field="major"]')?.value?.trim()||'',
            gpa: div.querySelector('[data-field="gpa"]')?.value?.trim()||'',
            startDate: div.querySelector('[data-field="startDate"]')?.value?.trim()||'',
            endDate: div.querySelector('[data-field="endDate"]')?.value?.trim()||'',
            currentlyStudying: div.querySelector('[data-field="currentlyStudying"]')?.checked||false
        }));
    }

    // ─── Select Client ───────────────────────────────────────────────

    function selectClient(id) {
        currentClientId = id;
        const client = clients.find(c => c.id === id);
        if (!client) return;

        // Show form, hide empty + hide suggestions banner (only relevant when no client selected)
        $('#empty-state').style.display = 'none';
        $('#client-form').style.display = 'block';
        const _sb = $('#suggestions-banner');
        if (_sb) _sb.style.display = 'none';

        // Populate form fields
        FORM_FIELDS.forEach(field => {
            const el = $(`#${field}`);
            if (!el) return;
            el.value = client[field] || '';
        });

        // Populate array fields (comma-separated textareas)
        $('#preferredLocations').value = (client.preferredLocations || []).join(', ');
        $('#targetRoles').value = (client.targetRoles || []).join(', ');

        // Remote preference: comma-separated multi-value (Remote, Hybrid, On-site, Flexible)
        const rp = (client.remotePreference || '').split(',').map(s => s.trim()).filter(Boolean);
        document.querySelectorAll('.js-remote-pref').forEach(cb => {
            cb.checked = rp.includes(cb.value);
        });

        // Hidden ID
        $('#clientId').value = client.id;

        // Update header
        const initials = getInitials(client.firstName, client.lastName);
        const color = client.avatarColor || '#7C6AFF';
        $('#form-avatar').style.borderColor = color;
        $('#form-avatar').style.color = color;
        $('#form-avatar-text').textContent = initials;
        $('#form-client-name').textContent = client.fullName || 'New Client';

        if (client.updatedAt) {
            const ago = timeAgo(new Date(client.updatedAt));
            $('#form-last-updated').textContent = `Updated ${ago}`;
        } else {
            $('#form-last-updated').textContent = '';
        }

        // CV display
        if (client.cvFileName) {
            $('#cv-dropzone').style.display = 'none';
            $('#cv-current').style.display = 'flex';
            $('#cv-filename').textContent = client.cvFileName;
            $('#cv-filesize').textContent = client.cvSize ? QuickApplyStorage.formatBytes(client.cvSize) : '';
            showIntegrityBadge(client);

            // If cvData exists but cvText is missing (old profile), silently re-extract in background
            if (client.cvData && !client.cvText && typeof QuickApplyCVParser !== 'undefined') {
                (async () => {
                    try {
                        const blob = await fetch(`data:${client.cvMimeType || 'application/pdf'};base64,${client.cvData}`).then(r => r.blob());
                        const file = new File([blob], client.cvFileName, { type: client.cvMimeType });
                        const parsed = await QuickApplyCVParser.parseFile(file);
                        if (parsed.success && parsed.rawText) {
                            client.cvText = parsed.rawText.substring(0, 12000);
                            await QuickApplyStorage.saveClient(client);
                            showToast('CV text extracted for AI fill', 'success');
                        }
                    } catch (e) { /* silent */ }
                })();
            }
        } else {
            $('#cv-dropzone').style.display = 'flex';
            $('#cv-current').style.display = 'none';
            $('#cv-parse-overlay').style.display = 'none';
            const badge = $('#cv-integrity');
            if (badge) { badge.textContent = ''; badge.className = 'cv-integrity-badge'; }
        }

        // Cover letter display
        if (client.coverLetterFileName) {
            $('#cl-dropzone').style.display = 'none';
            $('#cl-current').style.display = 'flex';
            $('#cl-filename').textContent = client.coverLetterFileName;
            $('#cl-filesize').textContent = '';
        } else {
            $('#cl-dropzone').style.display = 'flex';
            $('#cl-current').style.display = 'none';
        }

        // Update sidebar active state
        $$('.sidebar-card').forEach(card => {
            card.classList.toggle('active', card.dataset.id === id);
        });

        // Multi-entry sections
        workExperienceEntries = Array.isArray(client.workExperience) ? client.workExperience : [];
        educationEntries = Array.isArray(client.educationHistory) ? client.educationHistory : [];
        renderWorkExperience();
        renderEducationHistory();

        // Job preferences checkboxes
        $$('input[name="targetJobType"]').forEach(cb => { cb.checked = (client.targetJobType || []).includes(cb.value); });
        $$('input[name="targetExperienceLevel"]').forEach(cb => { cb.checked = (client.targetExperienceLevel || []).includes(cb.value); });

        // Update completion counters
        updateAllCompletions(client);

        // Scroll to top
        $('.main-content').scrollTop = 0;

        // Load application history (D4)
        loadAppliedJobs(client.id);
        loadDailyTargets();
    }

    // ─── New Client ───────────────────────────────────────────────────

    function newClient() {
        const id = QuickApplyStorage.generateId();
        currentClientId = id;

        // Show form, hide empty + hide suggestions banner
        $('#empty-state').style.display = 'none';
        $('#client-form').style.display = 'block';
        const _sb2 = $('#suggestions-banner');
        if (_sb2) _sb2.style.display = 'none';

        // Clear all fields
        FORM_FIELDS.forEach(field => {
            const el = $(`#${field}`);
            if (el) el.value = '';
        });

        // Clear array fields
        $('#preferredLocations').value = '';
        $('#targetRoles').value = '';
        // Clear remote-preference checkboxes
        document.querySelectorAll('.js-remote-pref').forEach(cb => { cb.checked = false; });

        $('#clientId').value = id;
        $('#form-avatar').style.borderColor = '#7C6AFF';
        $('#form-avatar').style.color = '#7C6AFF';
        $('#form-avatar-text').textContent = '??';
        $('#form-client-name').textContent = 'New Client';
        $('#form-last-updated').textContent = '';

        // Reset multi-entry sections
        workExperienceEntries = [{}];
        educationEntries = [{}];
        renderWorkExperience();
        renderEducationHistory();
        $$('input[name="targetJobType"]').forEach(cb => cb.checked = false);
        $$('input[name="targetExperienceLevel"]').forEach(cb => cb.checked = false);

        // Reset file displays
        $('#cv-dropzone').style.display = 'flex';
        $('#cv-current').style.display = 'none';
        $('#cl-dropzone').style.display = 'flex';
        $('#cl-current').style.display = 'none';

        // Reset completions
        Object.keys(SECTION_FIELDS).forEach(section => {
            const el = $(`#${section}-completion`);
            if (el) el.textContent = `0/${SECTION_FIELDS[section].length}`;
        });

        // Deselect sidebar
        $$('.sidebar-card').forEach(card => card.classList.remove('active'));

        // Focus first field
        setTimeout(() => $('#firstName')?.focus(), 100);
    }

    // ─── Save Client ──────────────────────────────────────────────────

    async function saveClient() {
        // Validate
        const firstName = $('#firstName').value.trim();
        const lastName = $('#lastName').value.trim();
        const email = $('#email').value.trim();

        if (!firstName) { showToast('First name is required', 'error'); $('#firstName').focus(); return; }
        if (!lastName) { showToast('Last name is required', 'error'); $('#lastName').focus(); return; }
        if (!email) { showToast('Email is required', 'error'); $('#email').focus(); return; }
        if (email && !isValidEmail(email)) { showToast('Invalid email format', 'error'); $('#email').focus(); return; }

        // Collect form data
        const profile = { id: $('#clientId').value };

        FORM_FIELDS.forEach(field => {
            const el = $(`#${field}`);
            if (el) profile[field] = el.value.trim();
        });

        // Remote preference: checkbox group → comma-joined string. Saved as
        // a single string so existing auto-fill / AI prompts that expect a
        // string don't break; the matcher splits it back into a list.
        const checkedRemote = Array.from(document.querySelectorAll('.js-remote-pref:checked')).map(cb => cb.value);
        profile.remotePreference = checkedRemote.join(', ');

        // Collect array fields (comma-separated textareas)
        profile.preferredLocations = $('#preferredLocations').value
            .split(',').map(s => s.trim()).filter(Boolean);
        profile.targetRoles = $('#targetRoles').value
            .split(',').map(s => s.trim()).filter(Boolean);

        // Collect multi-entry arrays
        syncExperience();
        syncEducation();
        profile.workExperience = workExperienceEntries.filter(e => e.jobTitle || e.company);
        profile.educationHistory = educationEntries.filter(e => e.school || e.degree);

        // Auto-sync flat fields from arrays (backward compat with field-mapper.js aliases)
        const firstExp = profile.workExperience[0];
        if (firstExp) {
            if (!profile.currentJobTitle && firstExp.jobTitle) profile.currentJobTitle = firstExp.jobTitle;
            if (!profile.currentCompany && firstExp.company) profile.currentCompany = firstExp.company;
        }
        const firstEdu = profile.educationHistory[0];
        if (firstEdu) {
            if (!profile.university && firstEdu.school) profile.university = firstEdu.school;
            if (!profile.highestEducation && firstEdu.degree) profile.highestEducation = firstEdu.degree;
            if (!profile.major && firstEdu.major) profile.major = firstEdu.major;
            if (!profile.gpa && firstEdu.gpa) profile.gpa = firstEdu.gpa;
            if (!profile.graduationYear && firstEdu.endDate && !firstEdu.currentlyStudying) {
                const yr = firstEdu.endDate.match(/\d{4}/);
                if (yr) profile.graduationYear = yr[0];
            }
        }

        // Job preferences
        profile.targetJobTitle = $('#targetJobTitle')?.value?.trim() || '';
        profile.targetJobFunction = $('#targetJobFunction')?.value?.trim() || '';
        profile.targetJobType = Array.from($$('input[name="targetJobType"]:checked')).map(el => el.value);
        profile.targetExperienceLevel = Array.from($$('input[name="targetExperienceLevel"]:checked')).map(el => el.value);

        // Preserve existing file data
        const existing = clients.find(c => c.id === profile.id);
        if (existing) {
            if (existing.cvData && !existing._cvRemoved) {
                profile.cvData = existing.cvData;
                profile.cvFileName = existing.cvFileName;
                profile.cvMimeType = existing.cvMimeType;
                profile.cvSize = existing.cvSize;
                profile.cvText = existing.cvText; // Preserve extracted CV text
            }
            if (existing.coverLetterData && !profile._clRemoved) {
                profile.coverLetterData = existing.coverLetterData;
                profile.coverLetterFileName = existing.coverLetterFileName;
                profile.coverLetterMimeType = existing.coverLetterMimeType;
            }
            profile.avatarColor = existing.avatarColor;
        }

        // Handle new file uploads
        const cvFile = $('#cvFile').files[0];
        if (cvFile) {
            if (cvFile.size > 5 * 1024 * 1024) {
                showToast('CV file must be under 5MB', 'error');
                return;
            }
            const fileData = await readFileAsBase64(cvFile);
            profile.cvData = fileData;
            profile.cvFileName = cvFile.name;
            profile.cvMimeType = cvFile.type;
            profile.cvSize = cvFile.size;

            // INTELLIGENCE: Compute integrity hash
            if (typeof QuickApplyLearning !== 'undefined') {
                try {
                    profile.cvHash = await QuickApplyLearning.computeFileHash(fileData);
                    profile.cvIntegrity = 'verified';
                    profile.cvVerifiedAt = new Date().toISOString();
                } catch (e) { /* hash computation failed, skip */ }
            }

            // Extract CV text for AI-powered open-ended question answering
            if (typeof QuickApplyCVParser !== 'undefined') {
                try {
                    const parsed = await QuickApplyCVParser.parseFile(cvFile);
                    if (parsed.success && parsed.rawText) {
                        profile.cvText = parsed.rawText.substring(0, 12000);
                    }
                } catch (e) { /* CV text extraction failed, skip */ }
            }
        }

        const clFile = $('#clFile').files[0];
        if (clFile) {
            if (clFile.size > 5 * 1024 * 1024) {
                showToast('Cover letter must be under 5MB', 'error');
                return;
            }
            const fileData = await readFileAsBase64(clFile);
            profile.coverLetterData = fileData;
            profile.coverLetterFileName = clFile.name;
            profile.coverLetterMimeType = clFile.type;
        }

        try {
            await QuickApplyStorage.saveClient(profile);
            await loadClients();
            renderSidebar();
            selectClient(profile.id);
            updateStorageIndicator();
            showToast(`${profile.firstName} ${profile.lastName} saved!`, 'success');

            // Reset file inputs
            $('#cvFile').value = '';
            $('#clFile').value = '';
        } catch (err) {
            showToast('Failed to save: ' + err.message, 'error');
        }
    }

    // ─── Delete Client ────────────────────────────────────────────────

    function showDeleteModal() {
        const client = clients.find(c => c.id === currentClientId);
        if (!client) return;
        $('#delete-modal-text').textContent = `Delete "${client.fullName}"? This cannot be undone.`;
        $('#delete-modal').style.display = 'flex';
    }

    async function confirmDelete() {
        if (!currentClientId) return;

        try {
            await QuickApplyStorage.deleteClient(currentClientId);
            await loadClients();
            renderSidebar();
            currentClientId = null;

            // Show empty state or select next
            if (clients.length > 0) {
                selectClient(clients[0].id);
            } else {
                $('#client-form').style.display = 'none';
                $('#empty-state').style.display = 'flex';
                // Restore suggestions banner — only visible on the empty/home state
                loadSuggestions();
            }

            updateStorageIndicator();
            showToast('Client deleted', 'info');
        } catch (err) {
            showToast('Failed to delete: ' + err.message, 'error');
        }

        $('#delete-modal').style.display = 'none';
    }

    // ─── Duplicate Client ─────────────────────────────────────────────

    async function duplicateClient() {
        const client = clients.find(c => c.id === currentClientId);
        if (!client) return;

        const copy = { ...client };
        copy.id = QuickApplyStorage.generateId();
        copy.lastName = client.lastName + ' (Copy)';
        copy.fullName = (client.firstName + ' ' + copy.lastName).trim();
        copy.email = '';  // Must change email to avoid duplication

        try {
            await QuickApplyStorage.saveClient(copy);
            await loadClients();
            renderSidebar();
            selectClient(copy.id);
            showToast('Client duplicated — update the email!', 'info');
        } catch (err) {
            showToast('Failed to duplicate: ' + err.message, 'error');
        }
    }

    // ─── Re-parse CV with AI (Improvement 1) ─────────────────────────

    async function reparseClientCV() {
        const client = clients.find(c => c.id === currentClientId);
        if (!client) { showToast('No client selected', 'error'); return; }

        if (!client.cvText) {
            showToast('No CV text found — upload a CV first', 'error');
            return;
        }

        const settings = await QuickApplyStorage.getSettings();
        if (!settings.geminiApiKey) {
            showToast('Gemini API key not set — add it in Settings', 'error');
            return;
        }

        const btn = $('#btn-reparse-cv');
        setButtonLoading(btn, true, 'Parsing...');

        try {
            const extracted = await chrome.runtime.sendMessage({
                type: 'CALL_AI_CV_EXTRACT',
                payload: { cvText: client.cvText }
            });

            if (!extracted) {
                showToast('AI extraction returned no data', 'error');
                return;
            }

            // Merge: only fill in fields that are currently empty
            let filled = 0;

            // ── Work experience array ──────────────────────────────────────
            if (Array.isArray(extracted.workExperience) && extracted.workExperience.length > 0 &&
                (!client.workExperience || client.workExperience.length === 0)) {
                client.workExperience = extracted.workExperience;
                workExperienceEntries = extracted.workExperience;
                renderWorkExperience();
                filled += extracted.workExperience.length;
            }
            delete extracted.workExperience;

            // ── Education array ────────────────────────────────────────────
            if (Array.isArray(extracted.educationHistory) && extracted.educationHistory.length > 0 &&
                (!client.educationHistory || client.educationHistory.length === 0)) {
                client.educationHistory = extracted.educationHistory;
                educationEntries = extracted.educationHistory;
                renderEducationHistory();
                filled += extracted.educationHistory.length;
            }
            delete extracted.educationHistory;

            // ── Cover letter ───────────────────────────────────────────────
            if (extracted.coverLetter && !client.coverLetter) {
                client.coverLetter = extracted.coverLetter;
                const clEl = $('#coverLetter');
                if (clEl) clEl.value = extracted.coverLetter;
                filled++;
            }
            delete extracted.coverLetter;

            // ── Flat scalar fields ─────────────────────────────────────────
            for (const [key, val] of Object.entries(extracted)) {
                if (val && !client[key]) {
                    client[key] = val;
                    const el = $(`#${key}`);
                    if (el) el.value = val;
                    filled++;
                }
            }

            if (filled === 0) {
                showToast('No new fields found — profile already complete', 'info');
                return;
            }

            // Update fullName if first/last changed
            if (!client.fullName && client.firstName && client.lastName) {
                client.fullName = `${client.firstName} ${client.lastName}`.trim();
                const el = $('#fullName');
                if (el) el.value = client.fullName;
            }

            client.updatedAt = new Date().toISOString();
            await QuickApplyStorage.saveClient(client);
            await loadClients();
            renderSidebar();
            showToast(`AI filled ${filled} new field${filled !== 1 ? 's' : ''}`, 'success');
        } catch (err) {
            showToast('Re-parse failed: ' + err.message, 'error');
        } finally {
            setButtonLoading(btn, false);
        }
    }

    // ─── Import / Export ──────────────────────────────────────────────

    async function exportProfiles() {
        try {
            const json = await QuickApplyStorage.exportAll();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `quickapply_export_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Profiles exported!', 'success');
        } catch (err) {
            showToast('Export failed: ' + err.message, 'error');
        }
    }

    function showImportModal() {
        $('#import-modal').style.display = 'flex';
        $('#import-file-input').value = '';
    }

    async function confirmImport() {
        const file = $('#import-file-input').files[0];
        if (!file) {
            showToast('Please select a file', 'error');
            return;
        }

        try {
            const text = await file.text();
            const result = await QuickApplyStorage.importAll(text);

            await loadClients();
            renderSidebar();
            updateStorageIndicator();

            if (clients.length > 0 && !currentClientId) {
                selectClient(clients[0].id);
            }

            const msg = `Import: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`;
            showToast(msg, result.errors.length > 0 ? 'error' : 'success');
        } catch (err) {
            showToast('Import failed: ' + err.message, 'error');
        }

        $('#import-modal').style.display = 'none';
    }

    // ─── File Handling ────────────────────────────────────────────────

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Strip data:...;base64, prefix
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function setupDropzone(dropzoneId, fileInputId, onFileSelected) {
        const dropzone = $(`#${dropzoneId}`);
        const fileInput = $(`#${fileInputId}`);

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
        });

        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                if (onFileSelected) onFileSelected(e.dataTransfer.files[0]);
            }
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files[0] && onFileSelected) onFileSelected(fileInput.files[0]);
        });
    }

    // ─── Section Collapse ─────────────────────────────────────────────

    function setupSections() {
        $$('.section-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.closest('.form-section');
                const isCollapsed = section.classList.contains('collapsed');
                section.classList.toggle('collapsed');
                header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
            });
        });
    }

    // ─── Completion Counters ──────────────────────────────────────────

    function updateAllCompletions(client) {
        Object.entries(SECTION_FIELDS).forEach(([section, fields]) => {
            const filled = fields.filter(f => client[f]).length;
            const el = $(`#${section}-completion`);
            if (el) el.textContent = `${filled}/${fields.length}`;
        });

        // Resume status
        const resumeEl = $('#resume-completion');
        if (resumeEl) resumeEl.textContent = client.cvFileName ? '✓' : '';
        const clEl = $('#coverletter-completion');
        if (clEl) clEl.textContent = client.coverLetterFileName ? '✓' : '';
    }

    function updateCompletionsFromForm() {
        Object.entries(SECTION_FIELDS).forEach(([section, fields]) => {
            const filled = fields.filter(f => {
                const el = $(`#${f}`);
                return el && el.value.trim();
            }).length;
            const el = $(`#${section}-completion`);
            if (el) el.textContent = `${filled}/${fields.length}`;
        });
    }

    // ─── Live Header Update ───────────────────────────────────────────

    function setupLiveHeaderUpdate() {
        ['firstName', 'lastName'].forEach(id => {
            const el = $(`#${id}`);
            if (el) {
                el.addEventListener('input', () => {
                    const first = $('#firstName').value.trim();
                    const last = $('#lastName').value.trim();
                    const full = (first + ' ' + last).trim() || 'New Client';
                    $('#form-client-name').textContent = full;
                    $('#form-avatar-text').textContent = getInitials(first, last);
                });
            }
        });

        // Update completions on any input
        FORM_FIELDS.forEach(field => {
            const el = $(`#${field}`);
            if (el) {
                el.addEventListener('input', updateCompletionsFromForm);
                el.addEventListener('change', updateCompletionsFromForm);
            }
        });

        // Array fields are not in FORM_FIELDS, so wire them explicitly
        ['preferredLocations', 'targetRoles'].forEach(id => {
            const el = $(`#${id}`);
            if (el) {
                el.addEventListener('input', updateCompletionsFromForm);
                el.addEventListener('change', updateCompletionsFromForm);
            }
        });
    }

    // ─── Storage Indicator ────────────────────────────────────────────

    async function updateStorageIndicator() {
        const usage = await QuickApplyStorage.getStorageUsage();
        $('#storage-indicator').textContent = `${usage.formatted} used`;
    }

    // ─── Toast ────────────────────────────────────────────────────────

    function showToast(message, type = 'info') {
        const container = $('#toast-container');

        // Limit concurrent toasts to 3 — remove oldest if over limit
        const existing = container.querySelectorAll('.toast');
        if (existing.length >= 3) existing[0].remove();

        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        toast.textContent = message;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('leaving');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ─── Utilities ────────────────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function timeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
        return Math.floor(seconds / 86400) + ' days ago';
    }

    const BUTTON_ICON_PATHS = {
        upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
        download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/>',
        plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
        refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M3 19v-6h6"/><path d="M21 5v6h-6"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><rect x="2" y="2" width="13" height="13" rx="2"/>',
        eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
        'file-down': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
        'database-import': '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M18 15v6"/><path d="m15 18 3-3 3 3"/>',
        'database-export': '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M18 15v6"/><path d="m15 18 3 3 3-3"/>'
    };

    const BUTTON_ICON_BY_ID = {
        'btn-full-backup': 'download',
        'btn-full-restore': 'upload',
        'btn-export-log': 'file-down'
    };

    const BUTTON_LABEL_BY_ID = {
        'btn-full-backup': 'Full Backup',
        'btn-full-restore': 'Full Restore'
    };

    function renderButtonIcons(root = document) {
        root.querySelectorAll('.btn').forEach(button => {
            const icon = button.dataset.icon || BUTTON_ICON_BY_ID[button.id];
            if (!icon || !BUTTON_ICON_PATHS[icon] || button.querySelector('.btn-icon-svg') || button.querySelector('svg')) return;
            if (BUTTON_LABEL_BY_ID[button.id]) button.textContent = BUTTON_LABEL_BY_ID[button.id];
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            svg.classList.add('btn-icon-svg');
            svg.innerHTML = BUTTON_ICON_PATHS[icon];
            button.prepend(svg);
        });
    }

    function setButtonLoading(button, isLoading, label = 'Working...') {
        if (!button) return;
        if (isLoading) {
            if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');
            button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
            return;
        }
        button.disabled = false;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }
    }

    function setupSettingsTabs() {
        $$('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const key = tab.dataset.settingsTab;
                $$('.settings-tab').forEach(t => {
                    const active = t === tab;
                    t.classList.toggle('active', active);
                    t.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                $$('.settings-panel').forEach(panel => {
                    const active = panel.dataset.settingsPanel === key;
                    panel.classList.toggle('active', active);
                    panel.hidden = !active;
                });
            });
        });
    }

    function setupLearningFilters() {
        $('#learning-search')?.addEventListener('input', loadLearningPanel);
        $('#learning-confidence-filter')?.addEventListener('change', loadLearningPanel);
    }

    function getLearningFilters() {
        return {
            query: ($('#learning-search')?.value || '').trim().toLowerCase(),
            confidence: $('#learning-confidence-filter')?.value || 'all'
        };
    }

    function matchesLearningFilter(values, confidence = 1) {
        const filters = getLearningFilters();
        const textMatch = !filters.query || values.some(value =>
            String(value || '').toLowerCase().includes(filters.query)
        );
        if (!textMatch) return false;
        if (filters.confidence === 'trusted') return confidence >= 0.6;
        if (filters.confidence === 'low') return confidence < 0.6;
        return true;
    }

    function learningEmptyRow(colspan, title, detail) {
        return `<tr class="learn-empty-row"><td colspan="${colspan}"><div class="learn-empty"><span class="learn-empty-icon" aria-hidden="true"></span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div></td></tr>`;
    }

    function confidenceBadge(confidence) {
        const trusted = confidence >= 0.6;
        const cls = trusted ? 'learn-badge-trusted' : 'learn-badge-low';
        return `<span class="learn-badge ${cls}">${(confidence * 100).toFixed(0)}%</span>`;
    }

    // ─── Bind All Events ─────────────────────────────────────────────

    function bindEvents() {
        _bindJdAnalyzerControls();
        _bindBatchApplyControls();
        // Deep-link to the JD Analyzer panel when:
        //   1. URL hash is #jd-analyzer (first-time open from background)
        //   2. background set quickapply_open_jd_analyzer in storage (Retry,
        //      Re-run, or re-using an already-open dashboard tab — hash is no
        //      longer reliable in the reuse case)
        //
        // Defer the actual switch to the next macrotask so init's later steps
        // (loadSuggestions, renderInitialState, etc.) can't override the panel
        // back to the default Clients view. The switch wins the race because
        // it runs AFTER everything bindEvents was supposed to set up.
        function _switchToJdAnalyzer() {
            try { showSidebarTab('jd-analyzer'); } catch (_) {}
        }
        if (location.hash === '#jd-analyzer') {
            setTimeout(_switchToJdAnalyzer, 0);
        } else {
            chrome.storage.local.get('quickapply_open_jd_analyzer').then(r => {
                if (r.quickapply_open_jd_analyzer) {
                    chrome.storage.local.remove('quickapply_open_jd_analyzer');
                    _switchToJdAnalyzer();
                }
            }).catch(() => {});
        }
        // Also listen for the flag being set AFTER initial load, so a Retry
        // click from inside the dashboard brings it to the JD Analyzer view
        // even when the tab is already open.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.quickapply_open_jd_analyzer?.newValue) {
                chrome.storage.local.remove('quickapply_open_jd_analyzer');
                _switchToJdAnalyzer();
            }
        });

        renderButtonIcons();
        setupSettingsTabs();
        setupLearningFilters();

        // Sidebar search
        $('#sidebar-search').addEventListener('input', (e) => renderSidebar(e.target.value));

        // Global Settings modal (D2)
        $('#btn-open-settings')?.addEventListener('click', () => {
            $('#settings-modal').style.display = 'flex';
        });
        $('#settings-cancel')?.addEventListener('click', () => {
            $('#settings-modal').style.display = 'none';
        });
        $('#settings-modal')?.addEventListener('click', (e) => {
            if (e.target === $('#settings-modal')) $('#settings-modal').style.display = 'none';
        });
        $('#btn-save-settings').addEventListener('click', async () => {
            await saveSettings();
            $('#settings-modal').style.display = 'none';
            showToast('Settings saved!', 'success');
        });
        $('#btn-toggle-password')?.addEventListener('click', () => {
            const input = $('#defaultPassword');
            const button = document.getElementById('btn-toggle-password');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
            if (button) {
                button.textContent = input.type === 'password' ? 'Show' : 'Hide';
                renderButtonIcons(button.parentElement || document);
            }
        });
        $('#dailyDefaultTarget')?.addEventListener('change', async (ev) => {
            const v = Number(ev.target.value);
            if (!Number.isInteger(v) || v < 0 || v > 50) {
                ev.target.value = 5;
                await QuickApplyStorage.saveSettings({ dailyDefaultTarget: 5 });
                return;
            }
            await QuickApplyStorage.saveSettings({ dailyDefaultTarget: v });
        });
        $('#shiftCutoffHour')?.addEventListener('change', async (ev) => {
            const v = Number(ev.target.value);
            if (!Number.isInteger(v) || v < 0 || v > 23) {
                ev.target.value = 4;
                await QuickApplyStorage.saveSettings({ shiftCutoffHour: 4 });
                return;
            }
            await QuickApplyStorage.saveSettings({ shiftCutoffHour: v });
        });

        // Sidebar tabs (D3)
        $('#tab-clients')?.addEventListener('click', () => showSidebarTab('clients'));
        $('#tab-shift-tracker')?.addEventListener('click', () => showSidebarTab('shift-tracker'));
        $('#tab-learning')?.addEventListener('click', () => showSidebarTab('learning'));
        $('#tab-recordings')?.addEventListener('click', () => showSidebarTab('recordings'));
        $('#tab-jd-analyzer')?.addEventListener('click', () => showSidebarTab('jd-analyzer'));
        $('#tab-batch-apply')?.addEventListener('click', () => showSidebarTab('batch-apply'));

        // Add client
        $('#btn-add-client').addEventListener('click', newClient);

        // Save
        $('#btn-save').addEventListener('click', saveClient);

        // Delete
        $('#btn-delete').addEventListener('click', showDeleteModal);
        $('#delete-confirm').addEventListener('click', confirmDelete);
        $('#delete-cancel').addEventListener('click', () => { $('#delete-modal').style.display = 'none'; });

        // Duplicate
        $('#btn-duplicate').addEventListener('click', duplicateClient);

        // Re-parse CV with AI (Improvement 1)
        $('#btn-reparse-cv').addEventListener('click', reparseClientCV);

        // Full Backup / Restore
        $('#btn-full-backup').addEventListener('click', exportFullBackup);
        $('#btn-full-restore').addEventListener('click', () => $('#full-restore-input').click());
        $('#full-restore-input').addEventListener('change', e => { if (e.target.files[0]) importFullBackup(e.target.files[0]); });

        // Export / Import
        $('#btn-export').addEventListener('click', exportProfiles);
        $('#btn-import').addEventListener('click', showImportModal);
        $('#import-confirm').addEventListener('click', confirmImport);
        $('#import-cancel').addEventListener('click', () => { $('#import-modal').style.display = 'none'; });

        // Learning Memory Export / Import
        $('#btn-export-learning')?.addEventListener('click', exportLearningMemory);
        $('#btn-import-learning')?.addEventListener('click', () => $('#import-learning-input').click());
        $('#import-learning-input')?.addEventListener('change', e => { if (e.target.files[0]) importLearningMemory(e.target.files[0]); });
        $('#btn-flush-learning')?.addEventListener('click', flushLearningData);
        $('#btn-export-log')?.addEventListener('click', exportFillLog);
        $('#btn-clear-log')?.addEventListener('click', clearFillLog);
        $('#btn-clear-corrections')?.addEventListener('click', clearCorrections);
        $('#btn-clear-platform-knowledge')?.addEventListener('click', clearPlatformKnowledge);
        $('#btn-clear-registry')?.addEventListener('click', clearRegistry);
        $('#btn-reset-job-counters')?.addEventListener('click', resetJobCounters);
        $('#btn-reset-shift')?.addEventListener('click', _resetTodayShift);
        $('#btn-clear-log-modal')?.addEventListener('click', clearFillLog);
        $('#btn-clear-corrections-modal')?.addEventListener('click', clearCorrections);
        $('#btn-clear-platform-knowledge-modal')?.addEventListener('click', clearPlatformKnowledge);
        $('#btn-clear-registry-modal')?.addEventListener('click', clearRegistry);
        $('#btn-reset-job-counters-modal')?.addEventListener('click', resetJobCounters);

        // AI Cache panel
        $('#btn-clear-ai-cache')?.addEventListener('click', async () => {
            await chrome.storage.local.remove('qa_cache_v2');
            loadCacheStats();
            showToast('AI cache cleared', 'success');
        });
        $('#btn-export-cache')?.addEventListener('click', async () => {
            const res = await chrome.storage.local.get('qa_cache_v2');
            const blob = new Blob([JSON.stringify(res.qa_cache_v2 || {}, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'qa_cache_export.json'; a.click();
            URL.revokeObjectURL(url);
        });
        loadCacheStats();

        // File dropzones
        setupDropzone('cv-dropzone', 'cvFile', (file) => {
            if (file.size > 5 * 1024 * 1024) {
                showToast('File too large (max 5MB)', 'error');
                return;
            }
            // Show file info immediately
            $('#cv-dropzone').style.display = 'none';
            $('#cv-current').style.display = 'flex';
            $('#cv-filename').textContent = file.name;
            $('#cv-filesize').textContent = QuickApplyStorage.formatBytes(file.size);

            // INTELLIGENCE: Auto-parse CV to pre-fill form
            parseCVAndFillForm(file);
        });

        setupDropzone('cl-dropzone', 'clFile', (file) => {
            if (file.size > 5 * 1024 * 1024) {
                showToast('File too large (max 5MB)', 'error');
                return;
            }
            $('#cl-dropzone').style.display = 'none';
            $('#cl-current').style.display = 'flex';
            $('#cl-filename').textContent = file.name;
            $('#cl-filesize').textContent = QuickApplyStorage.formatBytes(file.size);
        });

        // Remove files
        $('#cv-remove').addEventListener('click', () => {
            const client = clients.find(c => c.id === currentClientId);
            if (client) {
                client.cvData = null;
                client.cvFileName = null;
                client.cvMimeType = null;
                client.cvSize = null;
                client._cvRemoved = true;
            }
            $('#cv-dropzone').style.display = 'flex';
            $('#cv-current').style.display = 'none';
            $('#cvFile').value = '';
        });

        $('#cl-remove').addEventListener('click', () => {
            const client = clients.find(c => c.id === currentClientId);
            if (client) {
                client.coverLetterData = null;
                client.coverLetterFileName = null;
                client.coverLetterMimeType = null;
                client._clRemoved = true;
            }
            $('#cl-dropzone').style.display = 'flex';
            $('#cl-current').style.display = 'none';
            $('#clFile').value = '';
        });

        // Close modals on overlay click
        $$('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.style.display = 'none';
            });
        });

        // Add experience / education entry buttons
        const btnAddExp = $('#btn-add-experience');
        if (btnAddExp) btnAddExp.addEventListener('click', () => { workExperienceEntries.push({}); renderWorkExperience(); });
        const btnAddEdu = $('#btn-add-education');
        if (btnAddEdu) btnAddEdu.addEventListener('click', () => { educationEntries.push({}); renderEducationHistory(); });

        // Sections
        setupSections();

        // Live header update
        setupLiveHeaderUpdate();
    }

    // ─── INTELLIGENCE: CV Auto-Parse ──────────────────────────────────

    async function parseCVAndFillForm(file) {
        if (typeof QuickApplyCVParser === 'undefined') {
            showToast('CV parser not loaded — try reloading the dashboard', 'error');
            return;
        }

        const overlay = $('#cv-parse-overlay');
        const saveBtn = $('#btn-save');
        if (overlay) overlay.style.display = 'flex';
        setButtonLoading(saveBtn, true, 'Parsing CV...');

        try {
            const result = await QuickApplyCVParser.parseFile(file);

            if (overlay) overlay.style.display = 'none';

            if (!result.success || result.extractedCount === 0) {
                showToast('Could not extract data from CV', 'info');
                return;
            }

            // Map parsed fields to form field IDs
            const fieldMap = {
                firstName: 'firstName',
                lastName: 'lastName',
                email: 'email',
                phone: 'phone',
                linkedIn: 'linkedIn',
                github: 'github',
                portfolio: 'portfolio',
                highestEducation: 'highestEducation',
                university: 'university',
                major: 'major',
                graduationYear: 'graduationYear',
                gpa: 'gpa',
                skills: 'skills',
                currentJobTitle: 'currentJobTitle',
                currentCompany: 'currentCompany',
                yearsOfExperience: 'yearsOfExperience',
                city: 'city',
                state: 'state',
                zipCode: 'zipCode',
                streetAddress: 'streetAddress',
                certifications: 'certifications',
                languages: 'languages'
            };

            let filled = 0;

            for (const [parsedKey, formId] of Object.entries(fieldMap)) {
                const value = result.fields[parsedKey];
                if (!value) continue;

                const el = $(`#${formId}`);
                if (!el) continue;

                // Only fill empty fields — don't overwrite existing data
                if (el.value && el.value.trim()) continue;

                el.value = String(value);
                el.classList.add('cv-parsed');
                filled++;

                // Remove the glow after 8 seconds
                setTimeout(() => el.classList.remove('cv-parsed'), 8000);
            }

            if (filled > 0) {
                showToast(`✨ Extracted ${filled} fields from CV — review & save`, 'success');
                updateCompletionsFromForm();

                // Update header with parsed name
                const first = $('#firstName').value.trim();
                const last = $('#lastName').value.trim();
                if (first || last) {
                    const full = (first + ' ' + last).trim();
                    $('#form-client-name').textContent = full || 'New Client';
                    $('#form-avatar-text').textContent = getInitials(first, last);
                }
            } else {
                showToast('CV parsed but no new fields to fill', 'info');
            }

        } catch (err) {
            if (overlay) overlay.style.display = 'none';
            showToast('CV parsing failed: ' + err.message, 'error');
        } finally {
            setButtonLoading(saveBtn, false);
        }
    }

    // ─── INTELLIGENCE: Integrity Badge ────────────────────────────────

    async function showIntegrityBadge(client) {
        const badge = $('#cv-integrity');
        if (!badge || typeof QuickApplyLearning === 'undefined') return;

        if (!client.cvData || !client.cvHash) {
            badge.textContent = '';
            badge.className = 'cv-integrity-badge';
            return;
        }

        try {
            const result = await QuickApplyLearning.verifyFileIntegrity(client);
            if (result.valid) {
                badge.textContent = '✅ Verified';
                badge.className = 'cv-integrity-badge verified';
            } else {
                badge.textContent = '❌ Corrupted';
                badge.className = 'cv-integrity-badge corrupted';
                badge.title = `Integrity check failed: ${result.reason}`;
            }
        } catch (e) {
            badge.textContent = '';
            badge.className = 'cv-integrity-badge';
        }
    }

    // ─── INTELLIGENCE: Learned Q&A Panel ──────────────────────────────
    // Shows custom fields (question → answer pairs) that were taught via
    // the in-page "?" hint badge. Users can edit or delete any entry.

    async function loadSuggestions() {
        // Collect all customFields across all clients
        const allQA = [];
        for (const client of clients) {
            if (!Array.isArray(client.customFields)) continue;
            for (const cf of client.customFields) {
                if (!cf.label) continue;
                allQA.push({
                    clientId: client.id,
                    clientName: client.fullName || client.firstName || 'Unknown',
                    clientInitials: getInitials(client.firstName, client.lastName),
                    avatarColor: client.avatarColor || '#E63B2E',
                    question: cf.label,
                    answer: cf.value || '',
                    aliases: cf.aliases || []
                });
            }
        }
        renderLearnedQA(allQA);
    }

    function renderLearnedQA(qaList) {
        const banner = $('#suggestions-banner');
        const list = $('#suggestions-list');
        const count = $('#suggestions-count');
        if (!banner || !list) return;

        if (!qaList || qaList.length === 0) {
            banner.style.display = 'none';
            return;
        }

        banner.style.display = 'block';
        count.textContent = `${qaList.length} learned`;

        list.innerHTML = '';

        qaList.forEach((qa, idx) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <div class="suggestion-info">
                    <div class="suggestion-label qa-question">${escapeHtml(qa.question)}</div>
                    <div class="suggestion-meta">
                        <span class="qa-client-pill" style="color:${qa.avatarColor}">${escapeHtml(qa.clientName)}</span>
                        <span class="qa-answer-preview">${qa.answer ? `→ "${escapeHtml(qa.answer.slice(0, 60))}${qa.answer.length > 60 ? '…' : ''}"` : '<em>no answer saved</em>'}</span>
                    </div>
                </div>
                <div class="suggestion-actions">
                    <button class="btn btn-ghost btn-sm" data-action="edit" data-idx="${idx}" title="Edit answer">Edit</button>
                    <button class="btn btn-danger btn-sm" data-action="remove" data-idx="${idx}" title="Remove">×</button>
                </div>
            `;

            item.querySelector('[data-action="edit"]').addEventListener('click', () => {
                showQAEditInline(item, qa, idx);
            });

            item.querySelector('[data-action="remove"]').addEventListener('click', async () => {
                await removeLearnedQA(qa.clientId, qa.question);
                await loadClients();
                await loadSuggestions();
                showToast('Learned answer removed', 'info');
            });

            list.appendChild(item);
        });
    }

    function showQAEditInline(item, qa, idx) {
        // Replace the item content with an inline edit form
        const origHTML = item.innerHTML;
        item.innerHTML = `
            <div class="suggestion-info" style="flex:1">
                <div class="qa-edit-question">${escapeHtml(qa.question)}</div>
                <input type="text" class="form-input qa-edit-input" value="${escapeHtml(qa.answer)}" placeholder="Type the correct answer…" style="margin-top:6px;font-size:12px;height:32px">
            </div>
            <div class="suggestion-actions">
                <button class="btn btn-ghost btn-sm qa-edit-cancel">Cancel</button>
                <button class="btn btn-primary btn-sm qa-edit-save">Save</button>
            </div>
        `;
        const input = item.querySelector('.qa-edit-input');
        input.focus();
        input.select();

        item.querySelector('.qa-edit-cancel').addEventListener('click', () => {
            item.innerHTML = origHTML;
            bindSuggestionEvents(item, qa, idx);
        });

        item.querySelector('.qa-edit-save').addEventListener('click', async () => {
            const newAnswer = input.value.trim();
            await updateLearnedQA(qa.clientId, qa.question, newAnswer);
            await loadClients();
            await loadSuggestions();
            showToast('Answer updated', 'success');
        });
    }

    function bindSuggestionEvents(item, qa, idx) {
        item.querySelector('[data-action="edit"]')?.addEventListener('click', () => showQAEditInline(item, qa, idx));
        item.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
            await removeLearnedQA(qa.clientId, qa.question);
            await loadClients();
            await loadSuggestions();
            showToast('Learned answer removed', 'info');
        });
    }

    async function updateLearnedQA(clientId, question, newAnswer) {
        try {
            const data = await chrome.storage.local.get('quickapply_clients');
            const allClients = data.quickapply_clients || [];
            const clientIdx = allClients.findIndex(c => c.id === clientId);
            if (clientIdx === -1) return;
            const cf = allClients[clientIdx].customFields?.find(f => f.label === question);
            if (cf) cf.value = newAnswer;
            await chrome.storage.local.set({ quickapply_clients: allClients });
        } catch (e) { console.error('[Dashboard] updateLearnedQA failed:', e); }
    }

    async function removeLearnedQA(clientId, question) {
        try {
            const data = await chrome.storage.local.get('quickapply_clients');
            const allClients = data.quickapply_clients || [];
            const clientIdx = allClients.findIndex(c => c.id === clientId);
            if (clientIdx === -1) return;
            const client = allClients[clientIdx];
            if (Array.isArray(client.customFields)) {
                client.customFields = client.customFields.filter(f => f.label !== question);
            }
            await chrome.storage.local.set({ quickapply_clients: allClients });
        } catch (e) { console.error('[Dashboard] removeLearnedQA failed:', e); }
    }

    async function loadSettings() {
        if (typeof QuickApplyStorage !== 'undefined') {
            const settings = await QuickApplyStorage.getSettings();
            if (settings.geminiApiKey) {
                const input = document.getElementById('geminiApiKey');
                if (input) input.value = settings.geminiApiKey;
            }
            // Load fill behaviour toggles
            const adv = document.getElementById('dashAutoAdvanceSteps');
            const sub = document.getElementById('dashAutoSubmit');
            const force = document.getElementById('dashForceAI');
            if (adv) adv.checked = settings.autoAdvanceSteps !== false;
            if (sub) sub.checked = !!settings.autoSubmit;
            if (force) force.checked = !!settings.forceAI;

            // Load Job Analyzer toggles + weights
            const showVerdict = document.getElementById('settingShowFitVerdict');
            const showBreakdown = document.getElementById('settingShowFitBreakdown');
            if (showVerdict) showVerdict.checked = settings.showFitVerdict !== false;
            if (showBreakdown) showBreakdown.checked = settings.showFitBreakdown !== false;
            const fitMode = document.getElementById('settingFitCardMode');
            if (fitMode) fitMode.value = settings.fitCardMode === 'compact' ? 'compact' : 'detailed';
            const showMini = document.getElementById('settingShowMiniCard');
            if (showMini) showMini.checked = settings.showMiniCard !== false;
            const w = settings.fitWeights || { yoe: 40, title: 25, skills: 25, salary: 10 };
            const wYoE = document.getElementById('weightYoE');
            const wTitle = document.getElementById('weightTitle');
            const wSkills = document.getElementById('weightSkills');
            const wSalary = document.getElementById('weightSalary');
            if (wYoE) wYoE.value = w.yoe ?? 40;
            if (wTitle) wTitle.value = w.title ?? 25;
            if (wSkills) wSkills.value = w.skills ?? 25;
            if (wSalary) wSalary.value = w.salary ?? 10;
            const warn = document.getElementById('weightSumWarn');
            if (warn) warn.textContent = '';
            // Universal location-radius (miles) — JDs within this distance of any
            // candidate-preferred location still pass the Location parameter.
            const radius = document.getElementById('settingLocationRadiusMiles');
            if (radius) radius.value = Number.isFinite(settings.jdLocationRadiusMiles) ? settings.jdLocationRadiusMiles : 50;
            const dailyDefaultTargetEl = $('#dailyDefaultTarget');
            if (dailyDefaultTargetEl) dailyDefaultTargetEl.value = Number(settings.dailyDefaultTarget ?? 5);
            const shiftCutoffEl = $('#shiftCutoffHour');
            if (shiftCutoffEl) shiftCutoffEl.value = Number(settings.shiftCutoffHour ?? 4);
        }
    }

    async function loadCacheStats() {
        const statsEl = document.getElementById('cache-stats');
        const byPlatformEl = document.getElementById('cache-by-platform');
        if (!statsEl) return;
        try {
            const res = await chrome.storage.local.get('qa_cache_v2');
            const store = res.qa_cache_v2 || {};
            const entries = Object.values(store);
            const byPlatform = {};
            for (const e of entries) {
                const p = e.platform || 'unknown';
                byPlatform[p] = (byPlatform[p] || 0) + 1;
            }
            statsEl.textContent = `${entries.length} cached answers`;
            if (byPlatformEl) {
                byPlatformEl.innerHTML = Object.entries(byPlatform)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, n]) => `<span class="badge" style="background:var(--surface2,#f0f0f0);padding:2px 8px;border-radius:12px;font-size:12px;">${p}: ${n}</span>`)
                    .join('');
            }
        } catch (_) {
            if (statsEl) statsEl.textContent = 'Cache unavailable';
        }
    }

    async function saveSettings() {
        if (typeof QuickApplyStorage !== 'undefined') {
            const settings = await QuickApplyStorage.getSettings();
            const apiInput = document.getElementById('geminiApiKey');
            if (apiInput) settings.geminiApiKey = apiInput.value.trim();
            // Save fill behaviour toggles
            const adv = document.getElementById('dashAutoAdvanceSteps');
            const sub = document.getElementById('dashAutoSubmit');
            const force = document.getElementById('dashForceAI');
            if (adv) settings.autoAdvanceSteps = adv.checked;
            if (sub) settings.autoSubmit = sub.checked;
            if (force) settings.forceAI = force.checked;

            // Job Analyzer settings — validate weights sum to 100 before saving
            const wYoE = document.getElementById('weightYoE');
            const wTitle = document.getElementById('weightTitle');
            const wSkills = document.getElementById('weightSkills');
            const wSalary = document.getElementById('weightSalary');
            const warn = document.getElementById('weightSumWarn');
            if (wYoE && wTitle && wSkills && wSalary) {
                const yoe    = parseInt(wYoE.value, 10)    || 0;
                const title  = parseInt(wTitle.value, 10)  || 0;
                const skills = parseInt(wSkills.value, 10) || 0;
                const salary = parseInt(wSalary.value, 10) || 0;
                const sum = yoe + title + skills + salary;
                if (sum !== 100) {
                    if (warn) warn.textContent = `Weights must sum to 100 (currently ${sum}). Save aborted.`;
                    return;
                }
                if (warn) warn.textContent = '';
                settings.fitWeights = { yoe, title, skills, salary };
            }
            const showVerdict = document.getElementById('settingShowFitVerdict');
            const showBreakdown = document.getElementById('settingShowFitBreakdown');
            if (showVerdict) settings.showFitVerdict = showVerdict.checked;
            if (showBreakdown) settings.showFitBreakdown = showBreakdown.checked;
            const fitMode = document.getElementById('settingFitCardMode');
            if (fitMode) settings.fitCardMode = fitMode.value === 'compact' ? 'compact' : 'detailed';
            const showMini = document.getElementById('settingShowMiniCard');
            if (showMini) settings.showMiniCard = showMini.checked;
            // Universal location-radius. Clamp into a sane range and reject NaN.
            const radius = document.getElementById('settingLocationRadiusMiles');
            if (radius) {
                const n = parseInt(radius.value, 10);
                settings.jdLocationRadiusMiles = Number.isFinite(n) && n >= 0 ? Math.min(n, 500) : 50;
            }

            const dailyTargetEl = document.getElementById('dailyDefaultTarget');
            if (dailyTargetEl) {
                const n = parseInt(dailyTargetEl.value, 10);
                settings.dailyDefaultTarget = Number.isInteger(n) && n >= 0 && n <= 50 ? n : 5;
            }
            const cutoffHourEl = document.getElementById('shiftCutoffHour');
            if (cutoffHourEl) {
                const n = parseInt(cutoffHourEl.value, 10);
                settings.shiftCutoffHour = Number.isInteger(n) && n >= 0 && n <= 23 ? n : 4;
            }

            await QuickApplyStorage.saveSettings(settings);
        }
    }

    // ─── Learning Memory Flush ────────────────────────────────────────

    async function flushLearningData() {
        const confirmed = confirm(
            'Flush all learning data?\n\nThis will delete:\n• All field corrections\n• Platform knowledge\n• Field registry\n• Unknown field log\n\nThis cannot be undone. Export Memory first if you want a backup.'
        );
        if (!confirmed) return;
        const LEARNING_KEYS = [
            'quickapply_corrections',
            'quickapply_platform_knowledge',
            'quickapply_field_registry',
            'quickapply_unknown_fields'
        ];
        await new Promise((resolve, reject) => {
            chrome.storage.local.remove(LEARNING_KEYS, () => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve();
            });
        });
        showToast('Learning data flushed. Starting fresh.', 'success');
    }

    // ─── Full Backup / Full Restore ──────────────────────────────────

    const FULL_BACKUP_KEYS = [
        'quickapply_clients',
        'quickapply_settings',
        'quickapply_corrections',
        'quickapply_platform_knowledge',
        'quickapply_field_registry',
        'quickapply_unknown_fields',
        'quickapply_fill_log',
        'quickapply_session_recordings',
        'qa_cache_v2',
        'quickapply_job_counters',
    ];

    async function exportFullBackup() {
        try {
            const data = await chrome.storage.local.get(FULL_BACKUP_KEYS);
            const manifest = chrome.runtime.getManifest();
            const exportData = {
                _type: 'quickapply_full_backup',
                _version: 2,
                _extensionVersion: manifest.version,
                _exportedAt: new Date().toISOString(),
                ...data
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `quickapply-full-backup-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Full backup saved!', 'success');
        } catch (e) { showToast('Backup failed: ' + e.message, 'error'); }
    }

    async function importFullBackup(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data._type !== 'quickapply_full_backup') {
                showToast('Not a full backup file.', 'error');
                return;
            }
            if (!confirm(`Restore full backup from ${data._exportedAt ? data._exportedAt.slice(0,10) : 'unknown date'}?\n\nThis overwrites ALL current data — clients, corrections, recordings, everything. Cannot be undone.`)) return;
            const toRestore = {};
            for (const key of FULL_BACKUP_KEYS) {
                if (data[key] !== undefined) toRestore[key] = data[key];
            }
            await chrome.storage.local.set(toRestore);
            showToast('Backup restored! Reloading…', 'success');
            setTimeout(() => window.location.reload(), 1200);
        } catch (e) { showToast('Restore failed: ' + e.message, 'error'); }
    }

    // ─── Learning Memory Export ───────────────────────────────────────

    async function exportLearningMemory() {
        const LEARNING_KEYS = [
            'quickapply_corrections',
            'quickapply_platform_knowledge',
            'quickapply_field_registry',
            'quickapply_unknown_fields'
        ];
        const data = await chrome.storage.local.get(LEARNING_KEYS);
        const exportData = {
            _type: 'quickapply_learning_memory',
            _version: 1,
            _exportedAt: new Date().toISOString(),
            ...data
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quickapply-learning-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Learning memory exported!', 'success');
    }

    // ─── Data Management (Flush Controls) ────────────────────────────

    async function clearFillLog() {
        try {
            const data = await chrome.storage.local.get('quickapply_fill_log');
            const count = (data.quickapply_fill_log || []).length;
            if (count === 0) {
                showToast('Fill log is already empty.', 'info');
                return;
            }
            const confirmed = confirm(`This will delete all ${count} fill log entries. This cannot be undone.`);
            if (!confirmed) return;
            await chrome.storage.local.set({ quickapply_fill_log: [] });
            showToast('Fill log cleared.', 'success');
            if (typeof currentClientId !== 'undefined' && currentClientId) {
                loadAppliedJobs(currentClientId);
            }
        } catch (e) {
            showToast('Failed to clear fill log: ' + e.message, 'error');
        }
    }

    async function clearCorrections() {
        if (!confirm('Delete all saved corrections? This cannot be undone.')) return;
        try {
            await chrome.storage.local.remove('quickapply_corrections');
            showToast('Corrections cleared.', 'success');
            loadLearningPanel();
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function clearPlatformKnowledge() {
        if (!confirm('Delete all platform knowledge? This cannot be undone.')) return;
        try {
            await chrome.storage.local.remove('quickapply_platform_knowledge');
            showToast('Platform knowledge cleared.', 'success');
            loadLearningPanel();
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function clearRegistry() {
        if (!confirm('Delete universal field registry? This cannot be undone.')) return;
        try {
            await chrome.storage.local.remove('quickapply_field_registry');
            showToast('Field registry cleared.', 'success');
            loadLearningPanel();
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function resetJobCounters() {
        if (!confirm('Reset all job application counters for all clients? This cannot be undone.')) return;
        try {
            await chrome.storage.local.remove('quickapply_job_counters');
            showToast('Job counters reset.', 'success');
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    // ─── Fill Log Export ──────────────────────────────────────────────
    // Downloads a JSON log of all fill sessions (last 100).
    // Useful for debugging incorrect fills and sharing with support.

    async function exportFillLog() {
        const data = await chrome.storage.local.get('quickapply_fill_log');
        const log = data.quickapply_fill_log || [];
        if (log.length === 0) {
            showToast('No fill sessions logged yet. Fill a form first.', 'info');
            return;
        }
        const exportData = {
            _type: 'quickapply_fill_log',
            _version: 1,
            _exportedAt: new Date().toISOString(),
            _entryCount: log.length,
            log
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quickapply-fill-log-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Fill log exported — ${log.length} session${log.length !== 1 ? 's' : ''}.`, 'success');
    }

    // ─── Learning Memory Import ───────────────────────────────────────

    async function importLearningMemory(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data._type !== 'quickapply_learning_memory') {
                showToast('Invalid learning memory file', 'error');
                return;
            }
            const LEARNING_KEYS = [
                'quickapply_corrections',
                'quickapply_platform_knowledge',
                'quickapply_field_registry',
                'quickapply_unknown_fields'
            ];
            const toSave = {};
            LEARNING_KEYS.forEach(k => { if (data[k] !== undefined) toSave[k] = data[k]; });
            await new Promise((resolve, reject) => {
                chrome.storage.local.set(toSave, () => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
            showToast('Learning memory imported successfully!', 'success');
        } catch (e) {
            showToast('Failed to import: ' + e.message, 'error');
        }
    }

    // ─── Sidebar Tabs (D3) ────────────────────────────────────────────

    function showSidebarTab(tab) {
        $('#tab-clients')?.classList.toggle('active', tab === 'clients');
        $('#tab-shift-tracker')?.classList.toggle('active', tab === 'shift-tracker');
        $('#tab-learning')?.classList.toggle('active', tab === 'learning');
        $('#tab-recordings')?.classList.toggle('active', tab === 'recordings');
        $('#tab-jd-analyzer')?.classList.toggle('active', tab === 'jd-analyzer');
        $('#tab-batch-apply')?.classList.toggle('active', tab === 'batch-apply');

        const recPanel = $('#recordings-panel');
        if (recPanel) recPanel.style.display = 'none';
        const shiftPanel = $('#shift-tracker-panel');
        if (shiftPanel) shiftPanel.style.display = 'none';

        if (tab === 'shift-tracker') {
            $('#jd-analyzer-panel').style.display = 'none';
            $('#empty-state').style.display = 'none';
            $('#client-form').style.display = 'none';
            const _sb = $('#suggestions-banner');
            if (_sb) _sb.style.display = 'none';
            $('#learning-panel').style.display = 'none';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'none';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'none';
            if (shiftPanel) shiftPanel.style.display = 'block';
            loadDailyTargets();
        } else if (tab === 'learning') {
            $('#jd-analyzer-panel').style.display = 'none';
            $('#empty-state').style.display = 'none';
            $('#client-form').style.display = 'none';
            const _sb = $('#suggestions-banner');
            if (_sb) _sb.style.display = 'none';
            $('#learning-panel').style.display = 'block';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'block';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'none';
            loadLearningPanel();
            loadCacheStats();
        } else if (tab === 'recordings') {
            $('#jd-analyzer-panel').style.display = 'none';
            $('#empty-state').style.display = 'none';
            $('#client-form').style.display = 'none';
            const _sb = $('#suggestions-banner');
            if (_sb) _sb.style.display = 'none';
            $('#learning-panel').style.display = 'none';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'none';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'none';
            if (recPanel) recPanel.style.display = 'block';
            loadRecordingsPanel();
        } else if (tab === 'jd-analyzer') {
            $('#empty-state').style.display = 'none';
            $('#client-form').style.display = 'none';
            const _sb = $('#suggestions-banner');
            if (_sb) _sb.style.display = 'none';
            $('#learning-panel').style.display = 'none';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'none';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'none';
            $('#jd-analyzer-panel').style.display = 'block';
            renderJdAnalyzerPanel();
        } else if (tab === 'batch-apply') {
            $('#jd-analyzer-panel').style.display = 'none';
            $('#empty-state').style.display = 'none';
            $('#client-form').style.display = 'none';
            const _sb = $('#suggestions-banner');
            if (_sb) _sb.style.display = 'none';
            $('#learning-panel').style.display = 'none';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'none';
            if (shiftPanel) shiftPanel.style.display = 'none';
            if (recPanel) recPanel.style.display = 'none';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'block';
            renderBatchApplyPanel();
        } else {
            $('#jd-analyzer-panel').style.display = 'none';
            $('#learning-panel').style.display = 'none';
            const _cp = $('#ai-cache-panel');
            if (_cp) _cp.style.display = 'none';
            const _bap = $('#batch-apply-panel');
            if (_bap) _bap.style.display = 'none';
            if (currentClientId && clients.find(c => c.id === currentClientId)) {
                $('#client-form').style.display = 'block';
            } else {
                $('#empty-state').style.display = 'flex';
                loadSuggestions();
            }
        }
    }

    async function loadLearningPanel() {
        // ── Corrections ─────────────────────────────────────────────
        try {
            const corrData = await chrome.storage.local.get('quickapply_corrections');
            const corrections = corrData.quickapply_corrections || [];
            const corrBody = $('#corr-tbody');
            $('#corr-count').textContent = corrections.length;
            if (corrections.length === 0) {
                corrBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No corrections yet — fill a form and correct any wrong values.</td></tr>';
            } else {
                // Sort by platform then fieldName
                const sorted = corrections.slice().sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || (a.fieldName || '').localeCompare(b.fieldName || ''));
                const visible = sorted.filter(c => matchesLearningFilter([
                    c.platform,
                    c.contextLabel,
                    c.fieldName,
                    c._effectiveFieldKey,
                    c.profileField,
                    c.correctedValue ?? c.value
                ], c.confidence ?? 1));
                if (visible.length === 0) {
                    corrBody.innerHTML = learningEmptyRow(5, 'No matching corrections', 'Try a different search or confidence filter.');
                } else {
                    corrBody.innerHTML = visible.map(c => {
                    const rawValue = c.correctedValue ?? c.value ?? '';
                    const fieldLabel = c.contextLabel || c.fieldName || c._effectiveFieldKey || '—';
                    const val = String(rawValue).length > 40 ? escapeHtml(String(rawValue).slice(0, 40)) + '…' : escapeHtml(String(rawValue));
                    const uses = c.count != null ? `${c.count}x` : (c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : '1x');
                    return `<tr>
                        <td>${escapeHtml(c.platform || '—')}</td>
                        <td style="font-family:monospace;font-size:12px;">${escapeHtml(fieldLabel)}</td>
                        <td>${escapeHtml(c.profileField || '—')}</td>
                        <td title="${escapeHtml(String(rawValue))}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${val}</td>
                        <td class="conf-cell">${uses}</td>
                    </tr>`;
                    }).join('');
                }
            }
        } catch (e) { console.error('[Dashboard] loadLearningPanel Corrections failed:', e); }

        // ── Platform Knowledge ──────────────────────────────────────
        try {
            const pkData = await chrome.storage.local.get('quickapply_platform_knowledge');
            const pk = pkData.quickapply_platform_knowledge || {};
            const pkBody = $('#pk-tbody');
            const rows = [];
            for (const [domain, domainData] of Object.entries(pk)) {
                if (!domainData || typeof domainData !== 'object') continue;
                // Platform Knowledge stores per-domain metadata at the top level;
                // actual field mappings live inside domainData.fields.
                const fieldMap = domainData.fields || {};
                for (const [fieldName, entry] of Object.entries(fieldMap)) {
                    if (!entry || !entry.profileField) continue;
                    rows.push({ domain, fieldName, profileField: entry.profileField,
                        confidence: entry.confidence || 0, uses: entry.successCount || 0 });
                }
            }
            rows.sort((a, b) => b.confidence - a.confidence);
            $('#pk-count').textContent = rows.length;
            const visibleRows = rows.filter(r => matchesLearningFilter([
                r.domain,
                r.fieldName,
                r.profileField,
                r.uses
            ], r.confidence));
            if (rows.length === 0) {
                pkBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No platform knowledge yet — fill some forms first.</td></tr>';
            } else {
                if (visibleRows.length === 0) {
                    pkBody.innerHTML = learningEmptyRow(5, 'No matching platform knowledge', 'Try a different search or confidence filter.');
                } else {
                    pkBody.innerHTML = visibleRows.map(r => `
                    <tr>
                        <td>${escapeHtml(r.domain)}</td>
                        <td style="font-family:monospace;font-size:12px;">${escapeHtml(r.fieldName)}</td>
                        <td>${escapeHtml(r.profileField)}</td>
                        <td class="conf-cell">${confidenceBadge(r.confidence)}</td>
                        <td>${r.uses}</td>
                    </tr>`).join('');
                }
            }
        } catch (e) { console.error('[Dashboard] loadLearningPanel PK failed:', e); }

        // ── Field Registry ──────────────────────────────────────────
        try {
            const regData = await chrome.storage.local.get('quickapply_field_registry');
            const reg = regData.quickapply_field_registry || {};
            const regBody = $('#reg-tbody');
            const regRows = [];
            // Field Registry is stored as { version, lastUpdated, fields: { key: entry } }.
            // Iterate reg.fields, not reg, to skip the version/lastUpdated metadata properties.
            const regFields = reg.fields || {};
            for (const [key, entry] of Object.entries(regFields)) {
                if (!entry || !entry.profileField) continue;
                regRows.push({ key, profileField: entry.profileField,
                    source: (entry.sources && entry.sources[0]) || 'unknown', confidence: entry.confidence || 0 });
            }
            regRows.sort((a, b) => b.confidence - a.confidence);
            $('#reg-count').textContent = regRows.length;
            const visibleRegRows = regRows.filter(r => matchesLearningFilter([
                r.key,
                r.profileField,
                r.source
            ], r.confidence));
            if (regRows.length === 0) {
                regBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No registry entries yet.</td></tr>';
            } else {
                if (visibleRegRows.length === 0) {
                    regBody.innerHTML = learningEmptyRow(4, 'No matching registry entries', 'Try a different search or confidence filter.');
                } else {
                    regBody.innerHTML = visibleRegRows.map(r => `
                    <tr>
                        <td style="font-family:monospace;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.key)}">${escapeHtml(r.key)}</td>
                        <td>${escapeHtml(r.profileField)}</td>
                        <td><span class="source-badge source-${escapeHtml(r.source.replace(/[^a-z-]/g,''))}">${escapeHtml(r.source)}</span></td>
                        <td class="conf-cell">${confidenceBadge(r.confidence)}</td>
                    </tr>`).join('');
                }
            }
        } catch (e) { console.error('[Dashboard] loadLearningPanel Registry failed:', e); }

        // ── Fill Session History ────────────────────────────────────
        try {
            const fsData = await chrome.storage.local.get('quickapply_fill_log');
            const log = (fsData.quickapply_fill_log || []).slice().reverse();
            const fsList = $('#fs-list');
            const fsEmpty = $('#fs-empty');
            $('#fs-count').textContent = log.length;
            if (log.length === 0) {
                if (fsEmpty) fsEmpty.style.display = 'block';
                Array.from(fsList.querySelectorAll('.job-entry')).forEach(el => el.remove());
            } else {
                if (fsEmpty) fsEmpty.style.display = 'none';
                Array.from(fsList.querySelectorAll('.job-entry')).forEach(el => el.remove());
                log.forEach(entry => {
                    const s = entry.summary || {};
                    const filled = (s.filled || 0) + (s.fuzzy || 0);
                    const total = s.total || 0;
                    const pct = total ? Math.round(filled / total * 100) : 0;
                    const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
                    const urlShort = (entry.url || '').replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/');
                    const div = document.createElement('div');
                    div.className = 'job-entry';
                    div.innerHTML = `
                        <div class="job-entry-top">
                            <span class="job-platform">${escapeHtml(entry.platform || 'unknown')}</span>
                            ${entry.clientName ? `<span class="job-client">${escapeHtml(entry.clientName)}</span>` : ''}
                            <span class="job-ts">${ts}</span>
                        </div>
                        <div class="job-entry-url" title="${escapeHtml(entry.url || '')}">${escapeHtml(urlShort)}</div>
                        <div class="job-entry-stats">
                            <span class="stat-filled">${filled} filled</span>
                            <span class="stat-sep">/</span>
                            <span class="stat-total">${total} fields</span>
                            ${s.error > 0 ? `<span class="stat-error">${s.error} errors</span>` : ''}
                            <span class="stat-pct">${pct}%</span>
                        </div>`;
                    fsList.appendChild(div);
                });
            }
        } catch (e) { console.error('[Dashboard] loadLearningPanel FS failed:', e); }
    }

    // ─── Application History per Client (D4) ─────────────────────────

    async function loadAppliedJobs(clientId) {
        const list = $('#applied-jobs-list');
        const empty = $('#applied-jobs-empty');
        const counter = $('#applied-jobs-count');
        if (!list) return;

        try {
            const data = await chrome.storage.local.get('quickapply_fill_log');
            const log = data.quickapply_fill_log || [];
            const entries = log.filter(e => e.clientId === clientId).reverse();

            if (counter) counter.textContent = entries.length || '';
            if (entries.length === 0) {
                if (empty) empty.style.display = 'block';
                Array.from(list.querySelectorAll('.job-entry')).forEach(el => el.remove());
                return;
            }
            if (empty) empty.style.display = 'none';
            Array.from(list.querySelectorAll('.job-entry')).forEach(el => el.remove());

            entries.forEach(entry => {
                const s = entry.summary || {};
                const filled = (s.filled || 0) + (s.fuzzy || 0);
                const total = s.total || 0;
                const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
                const urlShort = (entry.url || '').replace(/^https?:\/\//, '').split('/').slice(0, 4).join('/');

                const div = document.createElement('div');
                div.className = 'job-entry';
                div.innerHTML = `
                    <div class="job-entry-top">
                        <span class="job-platform">${escapeHtml(entry.platform || 'unknown')}</span>
                        <span class="job-ts">${ts}</span>
                    </div>
                    <div class="job-entry-url" title="${escapeHtml(entry.url || '')}">${escapeHtml(urlShort)}</div>
                    <div class="job-entry-stats">
                        <span class="stat-filled">${filled} filled</span>
                        <span class="stat-sep">/</span>
                        <span class="stat-total">${total} fields</span>
                        ${s.error > 0 ? `<span class="stat-error">${s.error} errors</span>` : ''}
                    </div>`;
                list.appendChild(div);
            });
        } catch (e) { console.error('[Dashboard] loadAppliedJobs failed:', e); }
    }

    // ─── Daily Targets section (spec 2026-06-01) ─────────────────────

    function _tierFor(pct) {
        if (pct >= 100) return 'green';
        if (pct >= 50)  return 'yellow';
        return 'red';
    }

    function _shiftDateLabel(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric'
        });
    }

    async function _resetTodayShift() {
        const ok = window.confirm("Reset today's shift?\n\nThis clears every client's submission count and capped target for the current shift date. Past shifts are not affected.");
        if (!ok) return;
        try {
            const settings = await QuickApplyStorage.getSettings();
            const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
            const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
            const counts = await QuickApplyStorage.getDailyCounts();
            if (counts[today]) {
                delete counts[today];
                await QuickApplyStorage.setDailyCounts(counts);
            }
        } catch (e) {
            console.error('[Dashboard] _resetTodayShift failed:', e);
        }
        loadDailyTargets();
    }

    async function loadDailyTargets() {
        const emptyEl = $('#daily-targets-empty');
        const todayEl = $('#daily-targets-today');
        const todayRows = $('#daily-targets-today-rows');
        const todayTotals = $('#daily-targets-today-totals');
        const todayTitle = $('#daily-targets-today-title');
        const summaryEl = $('#daily-targets-summary');
        const historyEl = $('#daily-targets-history');
        const historyBody = $('#daily-targets-history-body');
        if (!todayRows || !todayTotals) return;

        try {
            const [settings, clients, counts] = await Promise.all([
                QuickApplyStorage.getSettings(),
                QuickApplyStorage.getClients(),
                QuickApplyStorage.getDailyCounts()
            ]);
            const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
            const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
            const day = counts[today] || {};

            const activeClients = clients.filter(c => c && c.id);
            if (activeClients.length === 0) {
                emptyEl.style.display = 'block';
                todayEl.hidden = true;
                historyEl.hidden = true;
                if (summaryEl) summaryEl.textContent = '';
                return;
            }
            emptyEl.style.display = 'none';
            todayEl.hidden = false;
            todayTitle.textContent = `Today (${_shiftDateLabel(today)})`;
            todayRows.innerHTML = '';
            let submitted = 0;
            let target = 0;
            let onTarget = 0;
            for (const client of activeClients) {
                const entry = day[client.id];
                const t = QuickApplyStorage.getEffectiveTarget(client, entry, settings);
                const s = entry ? entry.jobKeys.length : 0;
                if (t > 0) {
                    submitted += s; target += t;
                    if (s >= t) onTarget += 1;
                }
                const capped = !!(entry && entry.cappedTarget != null);
                const pct = t > 0 ? Math.min(100, Math.round((s / t) * 100)) : 0;
                const tier = capped ? 'capped' : _tierFor(pct);
                const name = escapeHtml(client.fullName || `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Unnamed');
                const row = document.createElement('div');
                row.className = 'daily-targets-row';
                row.innerHTML = `
                    <div class="daily-targets-row__name">${name}</div>
                    <div class="daily-targets-row__count">${s} / ${t}${capped ? ' ✓' : ''}</div>
                    <div class="daily-targets-row__bar"><div class="daily-targets-row__bar-fill" data-tier="${tier}" style="width:${pct}%;"></div></div>
                    <div class="daily-targets-row__actions">
                        ${capped
                            ? `<button class="daily-targets-row__action" data-action="undo-done" data-client-id="${escapeHtml(client.id)}">Undo done</button>`
                            : (s > 0 ? `<button class="daily-targets-row__action" data-action="mark-done" data-client-id="${escapeHtml(client.id)}">Mark done</button>` : '')}
                        <button class="daily-targets-row__action" data-action="set-target" data-client-id="${escapeHtml(client.id)}">Set target</button>
                    </div>`;
                todayRows.appendChild(row);
            }
            todayTotals.textContent = `Daily total: ${submitted} / ${target} · ${onTarget} client${onTarget === 1 ? '' : 's'} on target`;
            if (summaryEl) summaryEl.textContent = `${submitted} / ${target}`;

            const allDates = Object.keys(counts).filter(d => d !== today).sort().reverse().slice(0, 14);
            if (allDates.length === 0) {
                historyEl.hidden = true;
            } else {
                historyEl.hidden = false;
                historyBody.innerHTML = '';
                for (const date of allDates) {
                    const dayCounts = counts[date] || {};
                    const block = document.createElement('div');
                    block.className = 'daily-targets-block';
                    let html = `<h4 class="daily-targets-block-title">${_shiftDateLabel(date)}</h4><div class="daily-targets-rows">`;
                    let dSubmitted = 0; let dTarget = 0;
                    for (const client of activeClients) {
                        const entry = dayCounts[client.id];
                        const t = QuickApplyStorage.getEffectiveTarget(client, entry, settings);
                        const s = entry ? entry.jobKeys.length : 0;
                        if (t === 0 && s === 0) continue;
                        if (t > 0) { dSubmitted += s; dTarget += t; }
                        const capped = !!(entry && entry.cappedTarget != null);
                        const pct = t > 0 ? Math.min(100, Math.round((s / t) * 100)) : 0;
                        const tier = capped ? 'capped' : _tierFor(pct);
                        const name = escapeHtml(client.fullName || `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Unnamed');
                        html += `<div class="daily-targets-row">
                            <div class="daily-targets-row__name">${name}</div>
                            <div class="daily-targets-row__count">${s} / ${t}${capped ? ' ✓' : ''}</div>
                            <div class="daily-targets-row__bar"><div class="daily-targets-row__bar-fill" data-tier="${tier}" style="width:${pct}%;"></div></div>
                            <div class="daily-targets-row__actions"></div>
                        </div>`;
                    }
                    html += `</div><div class="daily-targets-totals">Daily total: ${dSubmitted} / ${dTarget}</div>`;
                    block.innerHTML = html;
                    historyBody.appendChild(block);
                }
            }
        } catch (e) {
            console.error('[Dashboard] loadDailyTargets failed:', e);
        }
    }

    // ─── Session Recordings Panel ─────────────────────────────────────

    async function loadRecordingsPanel() {
        const list = $('#rec-list');
        const empty = $('#rec-empty');
        const summary = $('#rec-summary');
        if (!list) return;

        const data = await chrome.storage.local.get(_REC_KEY);
        const recordings = (data[_REC_KEY] || []).slice().reverse();

        if (summary) summary.textContent = `${recordings.length} recording${recordings.length !== 1 ? 's' : ''} stored`;

        Array.from(list.querySelectorAll('.rec-card')).forEach(el => el.remove());

        if (recordings.length === 0) {
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';

        recordings.forEach((rec, idx) => {
            const card = document.createElement('div');
            card.className = 'rec-card';
            card.style.cssText = 'border:1px solid var(--color-border,#e5e7eb);border-radius:8px;padding:14px 16px;cursor:pointer;';

            const totalFields = rec.steps.reduce((s, st) => s + (st.fieldsPresent || []).length, 0);
            const totalFilled = rec.steps.reduce((s, st) => s + (st.fieldsFilled || []).filter(f => f.status === 'filled' || f.status === 'fuzzy').length, 0);
            const totalNet = rec.steps.reduce((s, st) => s + (st.networkRequests || []).length, 0);
            const outcomeColor = rec.outcome === 'submitted' ? '#16a34a' : rec.outcome === 'abandoned' ? '#9ca3af' : '#f59e0b';

            card.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                    <div>
                        <div style="font-weight:600;font-size:14px;">${escapeHtml(rec.jobTitle || rec.url || 'Unknown Job')}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escapeHtml(rec.company || '')} · ${escapeHtml(rec.platform || '')} · ${rec.startedAt ? new Date(rec.startedAt).toLocaleString() : ''}</div>
                        <div style="font-size:12px;color:var(--text-muted);">${escapeHtml((rec.clientName || ''))} · ${rec.steps.length} step${rec.steps.length !== 1 ? 's' : ''} · ${totalFilled}/${totalFields} fields filled · ${totalNet} network req${totalNet !== 1 ? 's' : ''}</div>
                    </div>
                    <span style="font-size:11px;font-weight:600;color:${outcomeColor};white-space:nowrap;">${(rec.outcome || 'in_progress').toUpperCase()}</span>
                </div>
                <div class="rec-detail" id="rec-detail-${idx}" style="display:none;margin-top:12px;"></div>`;

            card.querySelector('.rec-card > div').addEventListener('click', () => {
                const detail = card.querySelector('.rec-detail');
                if (detail.style.display === 'none') {
                    detail.style.display = 'block';
                    renderRecordingDetail(detail, rec);
                } else {
                    detail.style.display = 'none';
                }
            });

            list.appendChild(card);
        });

        $('#btn-export-recordings')?.addEventListener('click', exportRecordings);
        $('#btn-clear-recordings')?.addEventListener('click', clearRecordings);
    }

    function renderRecordingDetail(container, rec) {
        const steps = rec.steps || [];
        container.innerHTML = steps.map((step, si) => {
            const filledRows = (step.fieldsFilled || []).map(f =>
                `<tr><td style="font-family:monospace;font-size:11px;">${escapeHtml(f.fieldName||'—')}</td><td>${escapeHtml(f.profileField||'—')}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(String(f.value||''))}">${escapeHtml(String(f.value||'').slice(0,60))}</td><td>${escapeHtml(f.status||'')}</td><td>${escapeHtml(f.strategy||'')}</td></tr>`
            ).join('');

            const presentRows = (step.fieldsPresent || []).map(f =>
                `<tr><td style="font-family:monospace;font-size:11px;">${escapeHtml(f.id||f.name||'—')}</td><td>${escapeHtml(f.name||'—')}</td><td>${escapeHtml(f.type||'')}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(f.label||'')}">${escapeHtml((f.label||'').slice(0,50))}</td><td>${f.required?'✓':''}</td><td style="font-family:monospace;font-size:10px;">${escapeHtml(f.automationId||'')}</td></tr>`
            ).join('');

            const netRows = (step.networkRequests || []).map(n =>
                `<tr><td style="font-weight:600;">${escapeHtml(n.method||'')}</td><td style="font-family:monospace;font-size:10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(n.url||'')}">${escapeHtml((n.url||'').slice(0,80))}</td><td>${n.status||'—'}</td><td style="font-family:monospace;font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(n.body||'')}">${escapeHtml((n.body||'').slice(0,80))}</td></tr>`
            ).join('');

            const navInfo = step.nextClicked
                ? `<div style="margin-top:6px;font-size:11px;color:#16a34a;">▶ "${escapeHtml(step.nextButtonText||'')}" clicked at ${step.nextClickedAt ? new Date(step.nextClickedAt).toLocaleTimeString() : '?'}</div>`
                : '';

            return `<div style="margin-bottom:16px;">
                <div style="font-weight:600;font-size:13px;margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--color-border,#e5e7eb);">
                    Step ${si + 1}${step.stepLabel ? ' — ' + escapeHtml(step.stepLabel) : ''} &nbsp;
                    <span style="font-size:11px;font-weight:400;color:var(--text-muted);">${step.fieldsPresent ? step.fieldsPresent.length : 0} fields present · ${step.fieldsFilled ? step.fieldsFilled.length : 0} filled · ${step.networkRequests ? step.networkRequests.length : 0} network</span>
                </div>
                ${step.fieldsFilled && step.fieldsFilled.length > 0 ? `
                <div style="margin-bottom:8px;">
                  <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--text-muted);">FILLED</div>
                  <div style="overflow-x:auto;"><table class="learn-table"><thead><tr><th>Field Name</th><th>Profile Field</th><th>Value</th><th>Status</th><th>Strategy</th></tr></thead><tbody>${filledRows}</tbody></table></div>
                </div>` : ''}
                ${step.fieldsPresent && step.fieldsPresent.length > 0 ? `
                <details style="margin-bottom:8px;">
                  <summary style="font-size:11px;font-weight:600;color:var(--text-muted);cursor:pointer;">ALL FIELDS PRESENT (${step.fieldsPresent.length})</summary>
                  <div style="overflow-x:auto;margin-top:4px;"><table class="learn-table"><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Label</th><th>Req</th><th>data-automation-id</th></tr></thead><tbody>${presentRows}</tbody></table></div>
                </details>` : ''}
                ${step.networkRequests && step.networkRequests.length > 0 ? `
                <details style="margin-bottom:8px;">
                  <summary style="font-size:11px;font-weight:600;color:var(--text-muted);cursor:pointer;">NETWORK REQUESTS (${step.networkRequests.length})</summary>
                  <div style="overflow-x:auto;margin-top:4px;"><table class="learn-table"><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Body</th></tr></thead><tbody>${netRows}</tbody></table></div>
                </details>` : ''}
                ${navInfo}
            </div>`;
        }).join('') || '<p class="hint">No steps recorded.</p>';
    }

    async function exportRecordings() {
        const data = await chrome.storage.local.get(_REC_KEY);
        const recordings = data[_REC_KEY] || [];
        if (recordings.length === 0) { showToast('No recordings yet.', 'info'); return; }
        const blob = new Blob([JSON.stringify({ _type: 'quickapply_session_recordings', _exportedAt: new Date().toISOString(), count: recordings.length, recordings }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quickapply-recordings-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Exported ${recordings.length} recording${recordings.length !== 1 ? 's' : ''}.`, 'success');
    }

    async function clearRecordings() {
        if (!confirm('Delete all session recordings? This cannot be undone.')) return;
        await chrome.storage.local.remove(_REC_KEY);
        showToast('Recordings cleared.', 'success');
        const list = $('#rec-list');
        const empty = $('#rec-empty');
        const summary = $('#rec-summary');
        if (list) Array.from(list.querySelectorAll('.rec-card')).forEach(el => el.remove());
        if (empty) empty.style.display = 'block';
        if (summary) summary.textContent = '0 recordings stored';
    }

    // ═══════════════════════════════════════════════════════════════════
    // JD ANALYZER PANEL
    // ═══════════════════════════════════════════════════════════════════
    let _jdResultsFilter = 'all';
    // Default to the order URLs were added to the queue. The runner writes
    // batch.results in queue order, so an "original" sort = no sort at all —
    // just leave rows in their array order. User can still click a column
    // header to override.
    let _jdResultsSort = { col: 'original', dir: 'asc' };
    let _jdPollTimer = null;

    async function renderJdAnalyzerPanel() {
        await renderJdQueueList();
        await renderJdResultsTable();
        await updateJdActiveClientLine();
        startJdPolling();
    }

    function _clientDisplayName(profile) {
        if (!profile) return '';
        return profile.fullName
            || profile.identity?.fullName
            || profile.identity?.legalName
            || [profile.firstName, profile.lastName].filter(Boolean).join(' ')
            || profile.email
            || '';
    }

    async function updateJdActiveClientLine() {
        const el = document.getElementById('jd-analyzer-active-client');
        if (!el) return;
        try {
            const r = await chrome.storage.local.get('activeClientId');
            el.classList.remove('has-client');
            if (!r.activeClientId) {
                el.textContent = 'Matching client: No active client selected';
                el.title = '';
                return;
            }
            const profile = await QuickApplyStorage.getClientById(r.activeClientId);
            const name = _clientDisplayName(profile) || '(unnamed)';
            el.textContent = profile ? `Matching client: ${name}` : 'Matching client: Active client not found';
            el.title = profile ? `JD matches will run against ${name}` : `Missing client ID: ${r.activeClientId}`;
            el.classList.toggle('has-client', Boolean(profile));
        } catch (_) {
            el.classList.remove('has-client');
            el.textContent = 'Matching client: No active client selected';
            el.title = '';
        }
    }

    async function renderJdQueueList() {
        const list = document.getElementById('jd-queue-dash-list');
        const status = document.getElementById('jd-queue-status');
        if (!list) return;
        let items = [];
        try { items = (await globalThis.QuickApplyJdQueue?.listQueue()) || []; } catch (_) { items = []; }
        list.innerHTML = '';
        if (status) status.textContent = items.length ? `${items.length} URL${items.length === 1 ? '' : 's'} queued` : '';
        for (const it of items) {
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.className = 'jd-queue-url';
            span.textContent = it.url;
            span.title = it.url;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'jd-queue-remove';
            btn.textContent = '×';
            btn.addEventListener('click', async () => {
                try { await globalThis.QuickApplyJdQueue.removeFromQueue(it.url); } catch (_) {}
                renderJdQueueList();
            });
            li.append(span, btn);
            list.appendChild(li);
        }
    }

    function _bindJdAnalyzerControls() {
        document.getElementById('btn-jd-paste-add')?.addEventListener('click', async () => {
            const ta = document.getElementById('jd-paste-input');
            if (!ta) return;
            const raw = ta.value || '';
            const urls = raw.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
            let added = 0;
            for (const u of urls) {
                try { const before = await globalThis.QuickApplyJdQueue.queueCount();
                      await globalThis.QuickApplyJdQueue.addToQueue(u);
                      const after = await globalThis.QuickApplyJdQueue.queueCount();
                      if (after > before) added++;
                } catch (_) {}
            }
            ta.value = '';
            const status = document.getElementById('jd-queue-status');
            if (status) status.textContent = `${added} added (${urls.length - added} duplicates)`;
            renderJdQueueList();
        });

        document.getElementById('btn-jd-clear-queue')?.addEventListener('click', async () => {
            try { await globalThis.QuickApplyJdQueue.clearQueue(); } catch (_) {}
            renderJdQueueList();
        });

        document.getElementById('btn-jd-run')?.addEventListener('click', async () => {
            const count = await globalThis.QuickApplyJdQueue.queueCount();
            if (!count) { showToast?.('Queue is empty', 'info'); return; }
            try { await chrome.runtime.sendMessage({ type: 'RUN_BATCH' }); } catch (_) {}
        });

        document.getElementById('btn-jd-stop')?.addEventListener('click', async () => {
            try { await chrome.runtime.sendMessage({ type: 'CANCEL_BATCH' }); } catch (_) {}
        });

        document.getElementById('btn-jd-clear-results')?.addEventListener('click', async () => {
            const r = await chrome.storage.local.get('quickapply_jd_last_batch');
            const batch = r.quickapply_jd_last_batch;
            if (batch && !batch.finishedAt) {
                // A run is in progress — cancel it first so the runner doesn't
                // resurrect the storage key after we delete it.
                try { await chrome.runtime.sendMessage({ type: 'CANCEL_BATCH' }); } catch (_) {}
            }
            try { await chrome.storage.local.remove('quickapply_jd_last_batch'); } catch (_) {}
            await renderJdResultsTable();
        });

        document.querySelectorAll('#jd-results-filters .filter-chip').forEach(b => {
            b.addEventListener('click', () => {
                _jdResultsFilter = b.getAttribute('data-filter');
                document.querySelectorAll('#jd-results-filters .filter-chip').forEach(x => x.classList.toggle('active', x === b));
                renderJdResultsTable();
            });
        });

        document.querySelectorAll('#jd-results-table th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-sort');
                // Three-state cycle per column: asc → desc → original (queue order)
                if (_jdResultsSort.col === col) {
                    if (_jdResultsSort.dir === 'asc') _jdResultsSort = { col, dir: 'desc' };
                    else if (_jdResultsSort.dir === 'desc') _jdResultsSort = { col: 'original', dir: 'asc' };
                    else _jdResultsSort = { col, dir: 'asc' };
                } else {
                    _jdResultsSort = { col, dir: col === 'pct' ? 'desc' : 'asc' };
                }
                renderJdResultsTable();
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // BATCH APPLY PANEL
    // ═══════════════════════════════════════════════════════════════════

    let _batchPollTimer = null;

    function _stopBatchPolling() {
        if (_batchPollTimer) { clearInterval(_batchPollTimer); _batchPollTimer = null; }
    }

    function _startBatchPolling() {
        if (_batchPollTimer) return;
        _batchPollTimer = setInterval(async () => {
            const visible = $('#batch-apply-panel')?.style.display !== 'none';
            if (!visible) { _stopBatchPolling(); return; }
            await _renderBatchMonitor();
            const r = await chrome.storage.local.get('quickapply_fill_last_batch');
            const b = r.quickapply_fill_last_batch;
            if (b && (b.status === 'done' || b.status === 'cancelled' || b.status === 'paused')) {
                _stopBatchPolling();
            }
        }, 1000);
    }

    async function renderBatchApplyPanel() {
        await _renderBatchBuilderClients();
        const r = await chrome.storage.local.get('quickapply_fill_last_batch');
        const batch = r.quickapply_fill_last_batch;
        if (batch && batch.status !== 'done' && batch.status !== 'cancelled') {
            _showBatchMonitor();
            await _renderBatchMonitor();
            _startBatchPolling();
        } else if (batch && (batch.status === 'done' || batch.status === 'cancelled')) {
            _showBatchMonitor();
            await _renderBatchMonitor();
        } else {
            // No active/completed batch — but check if there are queued items waiting to run.
            // If so, show the monitor so the user can see and start them.
            const qr = await chrome.storage.local.get('quickapply_fill_queue');
            const queue = Array.isArray(qr.quickapply_fill_queue) ? qr.quickapply_fill_queue : [];
            if (queue.length > 0) {
                _showBatchMonitor();
                await _renderBatchMonitor();
            } else {
                _showBatchBuilder();
            }
        }
    }

    function _showBatchBuilder() {
        _stopBatchPolling();
        $('#batch-builder').style.display = 'block';
        $('#batch-monitor').style.display = 'none';
    }

    function _showBatchMonitor() {
        $('#batch-builder').style.display = 'none';
        $('#batch-monitor').style.display = 'block';
    }

    async function _renderBatchBuilderClients() {
        const list = $('#batch-client-list');
        if (!list) return;
        list.innerHTML = '';
        for (const client of clients) {
            const div = document.createElement('div');
            div.className = 'batch-client-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = client.id;
            cb.dataset.name = client.fullName || `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Unnamed';
            cb.addEventListener('change', _updateBatchQueueButton);
            const label = document.createElement('span');
            label.textContent = cb.dataset.name;
            div.append(cb, label);
            div.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; _updateBatchQueueButton(); } });
            list.appendChild(div);
        }
    }

    function _updateBatchQueueButton() {
        const btn = $('#batch-queue-btn');
        if (!btn) return;
        const selectedClients = Array.from($('#batch-client-list')?.querySelectorAll('input[type="checkbox"]:checked') || []);
        const urls = _parseBatchUrls();
        const n = selectedClients.length;
        const m = urls.length;
        const total = n * m;
        btn.textContent = `Queue ${n} client${n !== 1 ? 's' : ''} × ${m} job${m !== 1 ? 's' : ''} = ${total} pair${total !== 1 ? 's' : ''}`;
        btn.disabled = total === 0;
    }

    function _parseBatchUrls() {
        const raw = $('#batch-url-input')?.value || '';
        return raw.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
    }

    async function _renderBatchMonitor() {
        const r = await chrome.storage.local.get('quickapply_fill_last_batch');
        const batch = r.quickapply_fill_last_batch;
        if (!batch) {
            // No batch started yet — render the queued items as pending and show Run button.
            const qr = await chrome.storage.local.get('quickapply_fill_queue');
            const queue = Array.isArray(qr.quickapply_fill_queue) ? qr.quickapply_fill_queue : [];
            if (!queue.length) return;
            const statusLine = $('#batch-status-line');
            if (statusLine) statusLine.textContent = `Ready — ${queue.length} pair${queue.length !== 1 ? 's' : ''} queued`;
            const runBtn = $('#batch-run-btn');
            if (runBtn) { runBtn.disabled = false; }
            _showEl('#batch-run-btn',    true);
            _showEl('#batch-pause-btn',  false);
            _showEl('#batch-resume-btn', false);
            _showEl('#batch-cancel-btn', false);
            _showEl('#batch-new-btn',    false);
            const tbody = $('#batch-results-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            queue.forEach(row => {
                const tr = document.createElement('tr');
                const urlShort = (row.jobUrl || '').replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/');
                tr.innerHTML = `
                    <td>${escapeHtml(row.clientName || row.clientId || '')}</td>
                    <td class="batch-url-cell" title="${escapeHtml(row.jobUrl || '')}">${escapeHtml(urlShort)}</td>
                    <td><span class="batch-status-pill pending">pending</span></td>
                    <td>—</td>
                    <td>—</td>
                    <td></td>`;
                tbody.appendChild(tr);
            });
            return;
        }

        const results = batch.results || [];
        const done   = results.filter(r => r.status === 'done').length;
        const filled = results.filter(r => r.status === 'filled').length;
        const total  = results.length;
        const running = batch.status;

        const statusLine = $('#batch-status-line');
        if (statusLine) {
            const completedLabel = filled > 0
                ? `${done} submitted, ${filled} filled-only`
                : `${done} submitted`;
            if (running === 'running') statusLine.textContent = `Running — ${completedLabel} / ${total}`;
            else if (running === 'paused') statusLine.textContent = `Paused — ${completedLabel} / ${total}`;
            else if (running === 'done') statusLine.textContent = `Complete — ${completedLabel} / ${total}`;
            else if (running === 'cancelled') statusLine.textContent = `Cancelled — ${completedLabel} / ${total}`;
            else statusLine.textContent = `${completedLabel} / ${total}`;
        }

        const isRunning   = running === 'running';
        const isPaused    = running === 'paused';
        const isTerminal  = running === 'done' || running === 'cancelled';
        const runBtn = $('#batch-run-btn');
        if (runBtn) runBtn.disabled = false;
        _showEl('#batch-run-btn',    !isRunning && !isTerminal && !isPaused);
        _showEl('#batch-pause-btn',  isRunning);
        _showEl('#batch-resume-btn', isPaused);
        _showEl('#batch-cancel-btn', !isTerminal);
        _showEl('#batch-new-btn',    isTerminal);

        const tbody = $('#batch-results-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        results.forEach((row, idx) => {
            const tr = document.createElement('tr');
            const urlShort = (row.jobUrl || '').replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/');
            const statusLabel = { done: 'submitted', filled: 'filled only', submit_error: 'submit failed', failed: 'failed', cancelled: 'cancelled', paused: 'paused', running: 'running', pending: 'pending' }[row.status] || row.status;
            const statusPill = `<span class="batch-status-pill ${escapeHtml(row.status)}">${escapeHtml(statusLabel)}</span>`;
            const fields = row.summary
                ? `${(row.summary.filled || 0) + (row.summary.fuzzy || 0)} filled`
                : '—';
            const duration = (row.startedAt && row.finishedAt)
                ? `${Math.round((row.finishedAt - row.startedAt) / 1000)}s`
                : (row.status === 'running' ? '…' : '—');
            const retryBtn = (row.status === 'failed' || row.status === 'submit_error' || row.status === 'filled')
                ? `<button type="button" class="btn btn-ghost btn-sm" data-retry="${idx}">Retry</button>`
                : '';
            const tooltip = row.error ? ` title="${escapeHtml(row.error)}"` : '';
            tr.innerHTML = `
                <td>${escapeHtml(row.clientName || row.clientId)}</td>
                <td class="batch-url-cell" title="${escapeHtml(row.jobUrl || '')}">${escapeHtml(urlShort)}</td>
                <td${tooltip}>${statusPill}</td>
                <td>${fields}</td>
                <td>${duration}</td>
                <td>${retryBtn}</td>`;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('[data-retry]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.dataset.retry, 10);
                btn.disabled = true;
                btn.textContent = '…';
                await chrome.runtime.sendMessage({ type: 'RETRY_FILL_ROW', payload: { index: idx } });
                await _renderBatchMonitor();
                _startBatchPolling();
            });
        });
    }

    function _showEl(sel, visible) {
        const el = $(sel);
        if (el) el.style.display = visible ? '' : 'none';
    }

    function _batchSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function _bindBatchApplyControls() {
        $('#batch-select-all')?.addEventListener('click', () => {
            $('#batch-client-list')?.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
            _updateBatchQueueButton();
        });
        $('#batch-clear-sel')?.addEventListener('click', () => {
            $('#batch-client-list')?.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
            _updateBatchQueueButton();
        });

        $('#batch-url-input')?.addEventListener('input', _updateBatchQueueButton);

        $('#batch-queue-btn')?.addEventListener('click', async () => {
            const selectedClients = Array.from(
                $('#batch-client-list')?.querySelectorAll('input[type="checkbox"]:checked') || []
            ).map(cb => ({ id: cb.value, name: cb.dataset.name }));
            const urls = _parseBatchUrls();
            if (!selectedClients.length || !urls.length) return;

            const pairs = [];
            for (const client of selectedClients) {
                for (const url of urls) {
                    pairs.push({ clientId: client.id, clientName: client.name, jobUrl: url });
                }
            }

            const r = await chrome.runtime.sendMessage({ type: 'QUEUE_FILL_PAIRS', payload: { pairs } });
            if (!r?.ok) { showToast('Failed to queue pairs', 'error'); return; }
            showToast(`Queued ${pairs.length} pairs`, 'success');
            _showBatchMonitor();
            await _renderBatchMonitor();
        });

        $('#batch-run-btn')?.addEventListener('click', async () => {
            const concurrency = parseInt($('#batch-concurrency')?.value || '1', 10);
            const runBtn = $('#batch-run-btn');
            if (runBtn) runBtn.disabled = true;
            chrome.runtime.sendMessage({ type: 'RUN_FILL_BATCH', payload: { concurrency } });
            await _batchSleep(300);
            await _renderBatchMonitor();
            _startBatchPolling();
        });

        $('#batch-pause-btn')?.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ type: 'PAUSE_FILL_BATCH' });
            await _renderBatchMonitor();
        });

        $('#batch-resume-btn')?.addEventListener('click', async () => {
            chrome.runtime.sendMessage({ type: 'RESUME_FILL_BATCH' });
            await _batchSleep(300);
            await _renderBatchMonitor();
            _startBatchPolling();
        });

        $('#batch-cancel-btn')?.addEventListener('click', async () => {
            if (!confirm('Cancel this batch? All pending entries will be marked cancelled.')) return;
            await chrome.runtime.sendMessage({ type: 'CANCEL_FILL_BATCH' });
            _stopBatchPolling();
            await _renderBatchMonitor();
        });

        $('#batch-new-btn')?.addEventListener('click', async () => {
            await chrome.storage.local.remove('quickapply_fill_last_batch');
            await chrome.storage.local.remove('quickapply_fill_queue');
            _showBatchBuilder();
            await _renderBatchBuilderClients();
            _updateBatchQueueButton();
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const panelVisible = $('#batch-apply-panel')?.style.display !== 'none';
            if (!panelVisible) return;
            if (changes.quickapply_fill_last_batch) {
                _renderBatchMonitor();
            }
        });
    }

    async function renderJdResultsTable() {
        const tbl = document.getElementById('jd-results-table');
        const tbody = document.getElementById('jd-results-tbody');
        const empty = document.getElementById('jd-results-empty');
        const banner = document.getElementById('jd-results-banner');
        if (!tbl || !tbody || !empty) return;

        const r = await chrome.storage.local.get('quickapply_jd_last_batch');
        const batch = r.quickapply_jd_last_batch;

        if (!batch || !batch.results || !batch.results.length) {
            tbl.style.display = 'none';
            empty.style.display = '';
            if (banner) banner.classList.add('hidden');
            return;
        }

        if (banner) {
            const cur = await chrome.storage.local.get('activeClientId');
            if (batch.clientId && cur.activeClientId && batch.clientId !== cur.activeClientId) {
                const prev = await QuickApplyStorage.getClientById(batch.clientId).catch(() => null);
                banner.innerHTML = '';
                const span = document.createElement('span');
                span.textContent = `Results were for ${_clientDisplayName(prev) || 'a different client'}.`;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-secondary btn-sm';
                btn.textContent = 'Re-run for current client';
                btn.addEventListener('click', async () => {
                    for (const row of batch.results) {
                        try { await globalThis.QuickApplyJdQueue.addToQueue(row.url); } catch (_) {}
                    }
                    try { await chrome.runtime.sendMessage({ type: 'RUN_BATCH' }); } catch (_) {}
                });
                banner.append(span, btn);
                banner.classList.remove('hidden');
            } else {
                banner.classList.add('hidden');
            }
        }

        empty.style.display = 'none';
        tbl.style.display = '';

        // Capture original index BEFORE filtering so the "original" sort
        // preserves the queue order even after a filter chip narrows the rows.
        let rows = batch.results.map((r, i) => ({ ...r, _origIdx: i }));
        if (_jdResultsFilter === 'good') {
            rows = rows.filter(r => r.fit && (r.fit.verdict === 'strong' || r.fit.verdict === 'good'));
        } else if (_jdResultsFilter === 'failed') {
            rows = rows.filter(r => r.status === 'failed' || r.status === 'cancelled');
        }

        if (_jdResultsSort.col !== 'original') {
            const cmp = (a, b) => {
                const dir = _jdResultsSort.dir === 'asc' ? 1 : -1;
                const av = _rowSortValue(a, _jdResultsSort.col);
                const bv = _rowSortValue(b, _jdResultsSort.col);
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                return av < bv ? -dir : av > bv ? dir : 0;
            };
            rows.sort(cmp);
        }
        // else: leave in original (queue) order — already in batch.results sequence.

        tbody.innerHTML = '';
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            tbody.appendChild(_rowToTr(row, row._origIdx));
        }

        const total = batch.results.length;
        const done = batch.results.filter(r => ['scored','failed','cancelled'].includes(r.status)).length;
        const failed = batch.results.filter(r => r.status === 'failed').length;
        const prog = document.getElementById('jd-progress');
        const fill = document.getElementById('jd-progress-fill');
        const txt = document.getElementById('jd-progress-text');
        const stopBtn = document.getElementById('btn-jd-stop');
        const isRunning = !batch.finishedAt;
        if (prog && fill && txt) {
            if (total > 0 && (isRunning || done < total)) {
                prog.classList.remove('hidden');
                fill.style.width = `${Math.round(done / total * 100)}%`;
                txt.textContent = `${done} / ${total} scored${failed ? ` · ${failed} failed` : ''}`;
            } else {
                prog.classList.add('hidden');
            }
        }
        if (stopBtn) stopBtn.classList.toggle('hidden', !isRunning);
    }

    function _rowSortValue(row, col) {
        switch (col) {
            case 'title':   return row.jdMeta?.title?.toLowerCase() || '';
            case 'company': return row.jdMeta?.company?.toLowerCase() || '';
            case 'verdict': {
                const order = { strong:5, good:4, weak:3, poor:2, not_a_fit:1 };
                return row.fit ? (order[row.fit.verdict] || 0) : 0;
            }
            case 'pct':     return row.fit?.overallPct ?? null;
            default:        return null;
        }
    }

    function _rowToTr(row, idx) {
        const tr = document.createElement('tr');
        if (row.status === 'failed' || row.status === 'cancelled') tr.classList.add('jd-row-failed');

        const tdNum = document.createElement('td');
        tdNum.style.textAlign = 'right';
        tdNum.style.color = 'var(--color-text-secondary)';
        tdNum.textContent = (idx + 1) + '.';

        const tdTitle = document.createElement('td');
        tdTitle.className = 'jd-result-title';
        if (row.status === 'scored' && row.jdMeta?.title) {
            tdTitle.textContent = row.jdMeta.title;
        } else if (row.status === 'failed') {
            tdTitle.innerHTML = `<span class="jd-verdict-failed">Couldn't analyze</span>`;
        } else if (row.status === 'cancelled') {
            tdTitle.innerHTML = `<span class="jd-verdict-failed">Cancelled</span>`;
        } else {
            tdTitle.textContent = row.url;
        }
        tdTitle.title = row.url;

        const tdCo = document.createElement('td');
        tdCo.textContent = row.jdMeta?.company || '';

        const tdVer = document.createElement('td');
        if (row.fit?.verdict) {
            const labels = { strong:'Strong fit', good:'Good fit', weak:'Weak fit', poor:'Poor fit', not_a_fit:'Not a fit' };
            tdVer.innerHTML = `<span class="jd-verdict-${row.fit.verdict}">${labels[row.fit.verdict] || row.fit.verdict}</span>`;
        } else if (row.status === 'failed' || row.status === 'cancelled') {
            tdVer.innerHTML = `<span class="jd-verdict-failed">${row.reason || row.status}</span>`;
        } else {
            tdVer.textContent = row.status || '';
        }

        const tdPct = document.createElement('td');
        tdPct.className = 'jd-pct';
        tdPct.textContent = row.fit ? `${row.fit.overallPct ?? '—'}%` : '—';

        const tdReason = document.createElement('td');
        tdReason.className = 'jd-result-reason';
        if (row.fit?.parameters) {
            const fail = row.fit.parameters.find(p => p.kind === 'hard' && p.status === 'fail');
            const manual = row.fit.parameters.find(p => p.status === 'manual');
            const weakest = row.fit.parameters.filter(p => p.kind === 'soft' && typeof p.score === 'number')
                .sort((a, b) => (a.score || 0) - (b.score || 0))[0];
            const surface = fail || manual || weakest;
            tdReason.textContent = surface ? `${surface.label}: ${surface.reason || ''}` : '';
            tdReason.title = surface?.reason || '';
        }

        const tdActions = document.createElement('td');
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'jd-row-action';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', () => chrome.tabs.create({ url: row.url, active: true }));
        tdActions.appendChild(openBtn);

        if (row.url && row.status !== 'pending' && row.status !== 'running') {
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'jd-row-action';
            retryBtn.textContent = row.status === 'scored' ? 'Recheck' : 'Retry';
            retryBtn.style.marginLeft = '4px';
            retryBtn.addEventListener('click', async () => {
                // RETRY_ROW updates this single row in the existing batch
                // instead of triggering a fresh RUN_BATCH (which would
                // overwrite quickapply_jd_last_batch and wipe the other
                // scored rows). The other previously-scored rows stay
                // visible during and after the retry.
                retryBtn.disabled = true;
                retryBtn.textContent = row.status === 'scored' ? 'Checking…' : 'Retrying…';
                try {
                    await chrome.runtime.sendMessage({
                        type: 'RETRY_ROW',
                        payload: { url: row.url }
                    });
                } catch (_) {}
                // Polling loop will pick up the storage update and re-render
                // this row. If polling stopped (batch finished), restart it
                // briefly so the retry result actually shows.
                if (typeof startJdPolling === 'function') startJdPolling();
            });
            tdActions.appendChild(retryBtn);
        }

        tr.append(tdNum, tdTitle, tdCo, tdVer, tdPct, tdReason, tdActions);
        return tr;
    }

    function startJdPolling() {
        if (_jdPollTimer) return;
        _jdPollTimer = setInterval(async () => {
            const visible = document.getElementById('jd-analyzer-panel')?.style.display !== 'none';
            if (!visible) { stopJdPolling(); return; }
            await renderJdResultsTable();
            const r = await chrome.storage.local.get('quickapply_jd_last_batch');
            if (r.quickapply_jd_last_batch?.finishedAt) {
                stopJdPolling();
                await renderJdResultsTable();
            }
        }, 1000);
    }
    function stopJdPolling() {
        if (_jdPollTimer) { clearInterval(_jdPollTimer); _jdPollTimer = null; }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const panelVisible = document.getElementById('jd-analyzer-panel')?.style.display !== 'none';
        if (!panelVisible) return;
        if (changes.quickapply_jd_queue) {
            renderJdQueueList();
        }
        if (changes.activeClientId || changes.quickapply_clients) {
            updateJdActiveClientLine();
            renderJdResultsTable();
        }
        if (changes.quickapply_jd_last_batch) {
            // Picks up RETRY_ROW updates even after batch.finishedAt is set
            // (polling has stopped). Cheap because renderJdResultsTable just
            // re-reads storage and redraws DOM rows.
            renderJdResultsTable();
        }
    });

    // ─── Daily Targets action buttons (delegated) ─────────────────────
    document.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('.daily-targets-row__action');
        if (!btn) return;
        const clientId = btn.dataset.clientId;
        const action = btn.dataset.action;
        const settings = await QuickApplyStorage.getSettings();
        if (action === 'mark-done') {
            const counts = await QuickApplyStorage.getDailyCounts();
            const cutoff = Number.isInteger(settings.shiftCutoffHour) ? settings.shiftCutoffHour : 4;
            const today = QuickApplyStorage.shiftDateOf(Date.now(), cutoff);
            const entry = counts[today]?.[clientId];
            await QuickApplyStorage.setCappedTarget({
                clientId,
                value: entry ? entry.jobKeys.length : 0,
                settings
            });
        } else if (action === 'undo-done') {
            await QuickApplyStorage.setCappedTarget({ clientId, value: null, settings });
        } else if (action === 'set-target') {
            const clients = await QuickApplyStorage.getClients();
            const client = clients.find(c => c.id === clientId);
            if (!client) return;
            const cur = QuickApplyStorage.getEffectiveTarget(client, null, settings);
            const input = window.prompt('Daily target (0–50). Blank = clear override.', String(cur));
            if (input === null) return;
            const trimmed = String(input).trim();
            let nextVal;
            if (trimmed === '') nextVal = null;
            else {
                const n = Number(trimmed);
                if (!Number.isInteger(n) || n < 0 || n > 50) return;
                nextVal = n;
            }
            client.dailyTarget = nextVal;
            await QuickApplyStorage.saveClient(client);
        }
        loadDailyTargets();
    });

})();
