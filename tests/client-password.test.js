/**
 * Per-client account password (profile.defaultPassword).
 *
 * Replaces the old single global settings.defaultPassword shared by every
 * client. Each client profile now carries its own password; a client with
 * none set simply skips password fields during fill.
 */

const path = require('path');
const fs   = require('fs');

function loadStorage() {
    const src = fs.readFileSync(path.join(__dirname, '../storage.js'), 'utf8');
    new Function('globalThis', 'chrome', 'window', src)(global.globalThis, global.chrome, undefined);
    return global.globalThis.QuickApplyStorage;
}

function clearStore() {
    const s = chrome.storage.local._store;
    for (const k of Object.keys(s)) delete s[k];
}

describe('per-client account password', () => {
    let S;
    beforeAll(() => { S = loadStorage(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    it('persists a password on the client profile', async () => {
        await S.saveClient({ firstName: 'Alice', lastName: 'A', email: 'a@x.com', defaultPassword: 'AlicePw1!' });
        const [saved] = await S.getClients();
        expect(saved.defaultPassword).toBe('AlicePw1!');
    });

    it('keeps each client password isolated from the others', async () => {
        const a = await S.saveClient({ firstName: 'Alice', email: 'a@x.com', defaultPassword: 'AlicePw1!' });
        const b = await S.saveClient({ firstName: 'Bob',   email: 'b@x.com', defaultPassword: 'BobPw2!'   });

        expect((await S.getClientById(a.id)).defaultPassword).toBe('AlicePw1!');
        expect((await S.getClientById(b.id)).defaultPassword).toBe('BobPw2!');
    });

    it('updating one client does not touch another', async () => {
        const a = await S.saveClient({ firstName: 'Alice', email: 'a@x.com', defaultPassword: 'AlicePw1!' });
        const b = await S.saveClient({ firstName: 'Bob',   email: 'b@x.com', defaultPassword: 'BobPw2!'   });

        await S.saveClient({ ...a, defaultPassword: 'AliceRotated9!' });

        expect((await S.getClientById(a.id)).defaultPassword).toBe('AliceRotated9!');
        expect((await S.getClientById(b.id)).defaultPassword).toBe('BobPw2!');
    });

    it('leaves defaultPassword undefined on a profile that never set one', async () => {
        // Pre-existing clients are not seeded — they start with no password.
        const c = await S.saveClient({ firstName: 'Carol', email: 'c@x.com' });
        expect((await S.getClientById(c.id)).defaultPassword).toBeUndefined();
    });

    it('survives the legacy-profile migration path', async () => {
        // _migrateProfile backfills array fields; it must not drop the password.
        chrome.storage.local._store['quickapply_clients'] = [
            { id: 'legacy-1', firstName: 'Dan', email: 'd@x.com', defaultPassword: 'DanPw3!' }
        ];
        const [migrated] = await S.getClients();
        expect(migrated.defaultPassword).toBe('DanPw3!');
        expect(Array.isArray(migrated.preferredLocations)).toBe(true);
    });

    it('no longer writes a global password into settings', async () => {
        await S.saveClient({ firstName: 'Alice', email: 'a@x.com', defaultPassword: 'AlicePw1!' });
        const settings = await S.getSettings();
        expect(settings.defaultPassword).toBeUndefined();
    });
});
