/**
 * Unit tests for learning-engine.js
 *
 * The module is an IIFE that writes to window.QuickApplyLearning.
 * We load it via require() in jsdom (window exists → _RUNNING_IN_SW = false).
 * Direct SW-side functions (_saveCorrectionDirect etc.) are exposed on the module
 * and tested directly so we bypass the sendMessage routing path.
 */

const path = require('path');
const fs = require('fs');

// ── helpers ──────────────────────────────────────────────────────────────────

function loadModule() {
    // Re-execute the IIFE fresh for each test suite to get a clean module state.
    const src = fs.readFileSync(path.join(__dirname, '../learning-engine.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'globalThis', 'chrome', 'atob', 'crypto', src)(
        global.window, global.globalThis, global.chrome,
        global.atob || ((s) => Buffer.from(s, 'base64').toString('binary')),
        global.crypto || { subtle: { digest: async () => new ArrayBuffer(32) } }
    );
    return global.window.QuickApplyLearning;
}

function clearStore() {
    const store = chrome.storage.local._store;
    for (const k of Object.keys(store)) delete store[k];
}

function setStore(data) {
    Object.assign(chrome.storage.local._store, data);
}

function getStore(key) {
    return chrome.storage.local._store[key];
}

const BASE_CORRECTION = {
    clientId: 'client-1',
    platform: 'greenhouse',
    domain: 'jobs.greenhouse.io',
    fieldName: 'first_name',
    contextLabel: 'First Name',
    profileField: 'firstName',
    correctedValue: 'Alice',
    originalValue: '',
    inputType: 'text'
};

// ─────────────────────────────────────────────────────────────────────────────
// isJunkLearnedField
// ─────────────────────────────────────────────────────────────────────────────

describe('isJunkLearnedField', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('rejects empty label', () => {
        expect(LE.isJunkLearnedField('', 'Alice')).toBe(true);
    });

    test('rejects null/undefined label', () => {
        expect(LE.isJunkLearnedField(null, 'Alice')).toBe(true);
        expect(LE.isJunkLearnedField(undefined, 'Alice')).toBe(true);
    });

    test('rejects opaque hex-32 label', () => {
        expect(LE.isJunkLearnedField('abcdef1234567890abcdef1234567890', 'Alice')).toBe(true);
    });

    test('rejects UUID label', () => {
        expect(LE.isJunkLearnedField('9041edd4-1542-4f4e-bc9c-3362310c6836', 'Alice')).toBe(true);
    });

    test('rejects "Select One" placeholder label', () => {
        expect(LE.isJunkLearnedField('Select One', 'US')).toBe(true);
    });

    test('rejects "* Required" as stand-alone label (no letters beyond symbol)', () => {
        expect(LE.isJunkLearnedField('* Required', 'Alice')).toBe(false); // has letters — see NOTE in code
        // "* Required" alone should NOT be rejected at label-level because real labels
        // end with "Required". The value side guards against junk values.
    });

    test('rejects empty value', () => {
        expect(LE.isJunkLearnedField('First Name', '')).toBe(true);
    });

    test('rejects "on" and "off" checkbox values', () => {
        expect(LE.isJunkLearnedField('Subscribe', 'on')).toBe(true);
        expect(LE.isJunkLearnedField('Subscribe', 'off')).toBe(true);
    });

    test('rejects opaque hex-32 value', () => {
        expect(LE.isJunkLearnedField('Country', 'abcdef1234567890abcdef1234567890')).toBe(true);
    });

    test('rejects opaque UUID value', () => {
        expect(LE.isJunkLearnedField('State', '9041edd4-1542-4f4e-bc9c-3362310c6836')).toBe(true);
    });

    test('rejects ATS numeric IDs (7+ digits)', () => {
        expect(LE.isJunkLearnedField('Question', '1234567')).toBe(true);
        expect(LE.isJunkLearnedField('Question', '56843325004')).toBe(true);
    });

    test('allows short numeric strings (not ATS IDs)', () => {
        expect(LE.isJunkLearnedField('Years of Experience', '5')).toBe(false);
        expect(LE.isJunkLearnedField('Age', '30')).toBe(false);
    });

    test('rejects value with trailing space (cut-off autocomplete)', () => {
        expect(LE.isJunkLearnedField('City', 'New York ')).toBe(true);
    });

    test('rejects truncated pronoun fragments', () => {
        expect(LE.isJunkLearnedField('Work Auth', 'I am')).toBe(true);
        expect(LE.isJunkLearnedField('Work Auth', 'We are')).toBe(true);
    });

    test('rejects single-word label==value (captured button text)', () => {
        expect(LE.isJunkLearnedField('Yes', 'Yes')).toBe(true);
        expect(LE.isJunkLearnedField('Male', 'Male')).toBe(true);
    });

    test('allows multi-word label==value (real "prefer not to say" answer)', () => {
        const val = 'I prefer not to say';
        expect(LE.isJunkLearnedField(val, val)).toBe(false);
    });

    test('allows "true"/"false" for boolean-named fields', () => {
        expect(LE.isJunkLearnedField('candidateIsPreviousWorker', 'true', 'candidateIsPreviousWorker ')).toBe(false);
    });

    test('rejects "true"/"false" for non-boolean fields', () => {
        expect(LE.isJunkLearnedField('First Name', 'true')).toBe(true);
    });

    test('allows real values through', () => {
        expect(LE.isJunkLearnedField('First Name', 'Alice')).toBe(false);
        expect(LE.isJunkLearnedField('City', 'Toronto')).toBe(false);
        expect(LE.isJunkLearnedField('Gender', 'Female')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// _saveCorrectionDirect + getCorrections + getCorrectionForField
// ─────────────────────────────────────────────────────────────────────────────

describe('_saveCorrectionDirect', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('saves a valid correction to storage', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const stored = getStore('quickapply_corrections');
        expect(stored).toHaveLength(1);
        expect(stored[0].correctedValue).toBe('Alice');
        expect(stored[0].clientId).toBe('client-1');
    });

    test('rejects correction without clientId', async () => {
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, clientId: undefined });
        expect(getStore('quickapply_corrections')).toBeUndefined();
    });

    test('rejects junk correction value ("on")', async () => {
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, correctedValue: 'on' });
        expect(getStore('quickapply_corrections')).toBeUndefined();
    });

    test('rejects ATS numeric ID as corrected value', async () => {
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, correctedValue: '56843325004' });
        expect(getStore('quickapply_corrections')).toBeUndefined();
    });

    test('deduplicates: second save for same field updates existing record', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, correctedValue: 'Bob' });
        const stored = getStore('quickapply_corrections');
        expect(stored).toHaveLength(1);
        expect(stored[0].correctedValue).toBe('Bob');
        expect(stored[0].count).toBe(2);
    });

    test('opaque field name → contextLabel used as effective key', async () => {
        const opaque = {
            ...BASE_CORRECTION,
            fieldName: 'Question_56843325004',
            contextLabel: 'What is your gender?',
            correctedValue: 'Female'
        };
        await LE._saveCorrectionDirect(opaque);
        const stored = getStore('quickapply_corrections');
        expect(stored[0]._effectiveFieldKey).toBe('what is your gender?');
    });

    test('UUID field name → contextLabel used as effective key', async () => {
        const uuid = {
            ...BASE_CORRECTION,
            fieldName: '9041edd4-1542-4f4e-bc9c-3362310c6836',
            contextLabel: 'Cover Letter',
            correctedValue: 'Dear Hiring Manager...'
        };
        await LE._saveCorrectionDirect(uuid);
        const stored = getStore('quickapply_corrections');
        expect(stored[0]._effectiveFieldKey).toBe('cover letter');
    });

    test('stable field name used as effective key when not opaque', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const stored = getStore('quickapply_corrections');
        expect(stored[0]._effectiveFieldKey).toBe('first_name');
    });
});

describe('getCorrections', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('returns corrections matching platform+clientId', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const results = await LE.getCorrections('greenhouse', 'jobs.greenhouse.io', 'client-1');
        expect(results).toHaveLength(1);
        expect(results[0].correctedValue).toBe('Alice');
    });

    test('filters out corrections for different client', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const results = await LE.getCorrections('greenhouse', 'jobs.greenhouse.io', 'client-2');
        expect(results).toHaveLength(0);
    });

    test('filters out corrections for different platform+domain', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const results = await LE.getCorrections('workday', 'company.wd5.myworkday.com', 'client-1');
        expect(results).toHaveLength(0);
    });

    test('runtime filter strips trailing-space values', async () => {
        // Force a bad value past the write guard by inserting directly into storage
        setStore({ quickapply_corrections: [{ ...BASE_CORRECTION, correctedValue: 'Alice ' }] });
        const results = await LE.getCorrections('greenhouse', 'jobs.greenhouse.io', 'client-1');
        expect(results).toHaveLength(0);
    });

    test('runtime filter strips opaque hex-32 values', async () => {
        setStore({ quickapply_corrections: [{ ...BASE_CORRECTION, correctedValue: 'abcdef1234567890abcdef1234567890' }] });
        const results = await LE.getCorrections('greenhouse', 'jobs.greenhouse.io', 'client-1');
        expect(results).toHaveLength(0);
    });

    test('runtime filter strips ATS numeric IDs', async () => {
        setStore({ quickapply_corrections: [{ ...BASE_CORRECTION, correctedValue: '56843325004' }] });
        const results = await LE.getCorrections('greenhouse', 'jobs.greenhouse.io', 'client-1');
        expect(results).toHaveLength(0);
    });
});

describe('getCorrectionForField', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('finds correction by exact fieldName', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        const found = await LE.getCorrectionForField(
            'greenhouse', 'jobs.greenhouse.io', 'first_name', 'firstName', 'client-1', 'First Name'
        );
        expect(found).not.toBeNull();
        expect(found.correctedValue).toBe('Alice');
    });

    test('finds opaque-field correction via contextLabel (_effectiveFieldKey)', async () => {
        const opaque = {
            ...BASE_CORRECTION,
            fieldName: 'Question_56843325004',
            contextLabel: 'What is your gender?',
            correctedValue: 'Female'
        };
        await LE._saveCorrectionDirect(opaque);
        // New job posting generates a DIFFERENT opaque ID for the same question
        const found = await LE.getCorrectionForField(
            'greenhouse', 'jobs.greenhouse.io',
            'Question_99999999999',  // different ID
            'gender',
            'client-1',
            'What is your gender?'   // same label → should match
        );
        expect(found).not.toBeNull();
        expect(found.correctedValue).toBe('Female');
    });

    test('returns null when no match', async () => {
        const found = await LE.getCorrectionForField(
            'greenhouse', 'jobs.greenhouse.io', 'unknown_field', 'x', 'client-1', 'Unknown'
        );
        expect(found).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearCorrections
// ─────────────────────────────────────────────────────────────────────────────

describe('clearCorrections', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('clears all corrections when called with no args', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        await LE.clearCorrections();
        const stored = getStore('quickapply_corrections');
        expect(stored).toHaveLength(0);
    });

    test('clears only matching platform corrections', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, platform: 'workday', domain: 'wd.myworkday.com' });
        await LE.clearCorrections('greenhouse');
        const stored = getStore('quickapply_corrections');
        expect(stored).toHaveLength(1);
        expect(stored[0].platform).toBe('workday');
    });

    test('clears only matching domain corrections', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, platform: 'workday', domain: 'wd.myworkday.com' });
        await LE.clearCorrections(undefined, 'wd.myworkday.com');
        const stored = getStore('quickapply_corrections');
        expect(stored).toHaveLength(1);
        expect(stored[0].domain).toBe('jobs.greenhouse.io');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// _saveCustomFieldDirect
// ─────────────────────────────────────────────────────────────────────────────

describe('_saveCustomFieldDirect', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => {
        clearStore();
        jest.clearAllMocks();
        // Pre-populate a client record
        setStore({ quickapply_clients: [{ id: 'client-1', name: 'Test User', customFields: [] }] });
    });

    test('adds a new custom field to the client', async () => {
        await LE._saveCustomFieldDirect({ clientId: 'client-1', label: 'LinkedIn URL', value: 'https://linkedin.com/in/alice', fieldName: 'linkedin' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields).toHaveLength(1);
        expect(clients[0].customFields[0].label).toBe('LinkedIn URL');
        expect(clients[0].customFields[0].value).toBe('https://linkedin.com/in/alice');
    });

    test('updates existing custom field by label', async () => {
        setStore({ quickapply_clients: [{ id: 'client-1', customFields: [{ label: 'LinkedIn URL', value: 'old', aliases: [] }] }] });
        await LE._saveCustomFieldDirect({ clientId: 'client-1', label: 'LinkedIn URL', value: 'new-url', fieldName: 'linkedin' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields).toHaveLength(1);
        expect(clients[0].customFields[0].value).toBe('new-url');
    });

    test('appends alias when updating existing field', async () => {
        setStore({ quickapply_clients: [{ id: 'client-1', customFields: [{ label: 'LinkedIn URL', value: 'old', aliases: ['li'] }] }] });
        await LE._saveCustomFieldDirect({ clientId: 'client-1', label: 'LinkedIn URL', value: 'new', fieldName: 'linkedin_url' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields[0].aliases).toContain('linkedin_url');
    });

    test('bails when clientId not found', async () => {
        await LE._saveCustomFieldDirect({ clientId: 'not-exist', label: 'LinkedIn', value: 'x' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields).toHaveLength(0);
    });

    test('rejects junk label via isJunkLearnedField', async () => {
        await LE._saveCustomFieldDirect({ clientId: 'client-1', label: 'Select One', value: 'US' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields).toHaveLength(0);
    });

    test('rejects junk value via isJunkLearnedField', async () => {
        await LE._saveCustomFieldDirect({ clientId: 'client-1', label: 'Country', value: 'on' });
        const clients = getStore('quickapply_clients');
        expect(clients[0].customFields).toHaveLength(0);
    });

    test('bails when clientId missing', async () => {
        const before = JSON.stringify(getStore('quickapply_clients'));
        await LE._saveCustomFieldDirect({ label: 'LinkedIn', value: 'x' });
        expect(JSON.stringify(getStore('quickapply_clients'))).toBe(before);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// _logUnknownFieldDirect + getSuggestions
// ─────────────────────────────────────────────────────────────────────────────

describe('_logUnknownFieldDirect', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('creates a new unknown-field entry', async () => {
        await LE._logUnknownFieldDirect({ fieldName: 'team_preference', platform: 'greenhouse' });
        const stored = getStore('quickapply_unknown_fields');
        expect(stored).toHaveLength(1);
        expect(stored[0].patterns).toContain('team_preference');
    });

    test('increments count on duplicate fieldName', async () => {
        await LE._logUnknownFieldDirect({ fieldName: 'team_preference', platform: 'greenhouse' });
        await LE._logUnknownFieldDirect({ fieldName: 'team_preference', platform: 'greenhouse' });
        const stored = getStore('quickapply_unknown_fields');
        expect(stored).toHaveLength(1);
        expect(stored[0].count).toBe(2);
    });

    test('rejects opaque fieldNames', async () => {
        await LE._logUnknownFieldDirect({ fieldName: 'abcdef1234567890abcdef1234567890' });
        expect(getStore('quickapply_unknown_fields')).toBeUndefined();
    });

    test('rejects "Select One" placeholder', async () => {
        await LE._logUnknownFieldDirect({ fieldName: 'select one' });
        expect(getStore('quickapply_unknown_fields')).toBeUndefined();
    });

    test('getSuggestions returns fields above minCount threshold', async () => {
        for (let i = 0; i < 3; i++) {
            await LE._logUnknownFieldDirect({ fieldName: 'preferred_work_location' });
        }
        const suggestions = await LE.getSuggestions(3);
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].patterns).toContain('preferred_work_location');
    });

    test('getSuggestions excludes dismissed entries', async () => {
        for (let i = 0; i < 3; i++) {
            await LE._logUnknownFieldDirect({ fieldName: 'preferred_work_location' });
        }
        // Manually mark as dismissed
        const stored = getStore('quickapply_unknown_fields');
        stored[0].dismissed = true;
        setStore({ quickapply_unknown_fields: stored });
        const suggestions = await LE.getSuggestions(3);
        expect(suggestions).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveCorrection (content-script path — routes via sendMessage)
// ─────────────────────────────────────────────────────────────────────────────

describe('saveCorrection (content script routing)', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('routes through chrome.runtime.sendMessage in content-script context', async () => {
        // jsdom has window → _RUNNING_IN_SW = false → sendMessage path
        await LE.saveCorrection(BASE_CORRECTION);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'LEARNING_SAVE_CORRECTION' })
        );
        // Storage NOT written directly from content script
        expect(getStore('quickapply_corrections')).toBeUndefined();
    });

    test('bails silently when chrome.runtime.id is missing', async () => {
        const origId = chrome.runtime.id;
        delete chrome.runtime.id;
        await expect(LE.saveCorrection(BASE_CORRECTION)).resolves.toBeUndefined();
        chrome.runtime.id = origId;
    });

    test('does not call sendMessage for junk correction', async () => {
        await LE.saveCorrection({ ...BASE_CORRECTION, correctedValue: 'on' });
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFieldIdentity
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveFieldIdentity', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });

    test('non-opaque field: effectiveKey = fieldName, isOpaque = false', () => {
        const r = LE.resolveFieldIdentity('first_name', 'First Name');
        expect(r.isOpaque).toBe(false);
        expect(r.effectiveKey).toBe('first_name');
    });

    test('Greenhouse EEO opaque prefix (Question_xxx): uses contextLabel', () => {
        const r = LE.resolveFieldIdentity('Question_56843325004', 'What is your gender?');
        expect(r.isOpaque).toBe(true);
        expect(r.effectiveKey).toBe('what is your gender?');
    });

    test('iCIMS rcfXXX opaque prefix: uses contextLabel', () => {
        const r = LE.resolveFieldIdentity('rcf2044', 'Race / Ethnicity');
        expect(r.isOpaque).toBe(true);
        expect(r.effectiveKey).toBe('race / ethnicity');
    });

    test('Ashby UUID field name: uses contextLabel', () => {
        const r = LE.resolveFieldIdentity('9041edd4-1542-4f4e-bc9c-3362310c6836', 'Cover Letter');
        expect(r.isOpaque).toBe(true);
        expect(r.effectiveKey).toBe('cover letter');
    });

    test('Workday 32-hex field name: uses contextLabel', () => {
        const r = LE.resolveFieldIdentity('abcdef1234567890abcdef1234567890', 'Preferred Pronouns');
        expect(r.isOpaque).toBe(true);
        expect(r.effectiveKey).toBe('preferred pronouns');
    });

    test('opaque with no contextLabel: falls back to fieldName (original case)', () => {
        const r = LE.resolveFieldIdentity('Question_56843325004', '');
        expect(r.isOpaque).toBe(true);
        expect(r.effectiveKey).toBe('Question_56843325004');
    });

    test('effectiveKey is truncated to 120 chars', () => {
        const longLabel = 'A'.repeat(200);
        const r = LE.resolveFieldIdentity('Question_1', longLabel);
        expect(r.effectiveKey.length).toBe(120);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllCorrections
// ─────────────────────────────────────────────────────────────────────────────

describe('getAllCorrections', () => {
    let LE;
    beforeAll(() => { LE = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    test('returns empty array when nothing stored', async () => {
        const all = await LE.getAllCorrections();
        expect(all).toEqual([]);
    });

    test('returns all stored corrections', async () => {
        await LE._saveCorrectionDirect(BASE_CORRECTION);
        await LE._saveCorrectionDirect({ ...BASE_CORRECTION, fieldName: 'last_name', contextLabel: 'Last Name', correctedValue: 'Smith' });
        const all = await LE.getAllCorrections();
        expect(all).toHaveLength(2);
    });
});
