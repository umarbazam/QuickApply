const path = require('path');
const fs   = require('fs');

function loadModule() {
    const src = fs.readFileSync(path.join(__dirname, '../fill-queue.js'), 'utf8');
    new Function('globalThis', 'chrome', src)(global.globalThis, global.chrome);
    return global.globalThis.QuickApplyFillQueue;
}

function clearStore() {
    const s = chrome.storage.local._store;
    for (const k of Object.keys(s)) delete s[k];
}

function getStore(key) {
    return chrome.storage.local._store[key];
}

describe('QuickApplyFillQueue', () => {
    let Q;
    beforeAll(() => { Q = loadModule(); });
    beforeEach(() => { clearStore(); jest.clearAllMocks(); });

    describe('addPairs', () => {
        it('adds valid pairs to empty storage', async () => {
            const count = await Q.addPairs([
                { clientId: 'c1', clientName: 'Alice', jobUrl: 'https://example.com/job/1' },
                { clientId: 'c2', clientName: 'Bob',   jobUrl: 'https://example.com/job/2' }
            ]);
            expect(count).toBe(2);
            const stored = getStore('quickapply_fill_queue');
            expect(stored).toHaveLength(2);
            expect(stored[0]).toMatchObject({ clientId: 'c1', clientName: 'Alice', jobUrl: 'https://example.com/job/1' });
            expect(typeof stored[0].addedAt).toBe('number');
        });

        it('skips entries with missing clientId', async () => {
            const count = await Q.addPairs([{ jobUrl: 'https://example.com/job/1' }]);
            expect(count).toBe(0);
        });

        it('skips entries with missing jobUrl', async () => {
            const count = await Q.addPairs([{ clientId: 'c1', clientName: 'Alice' }]);
            expect(count).toBe(0);
        });

        it('appends to existing queue', async () => {
            await Q.addPairs([{ clientId: 'c1', clientName: 'Alice', jobUrl: 'https://a.com' }]);
            await Q.addPairs([{ clientId: 'c2', clientName: 'Bob',   jobUrl: 'https://b.com' }]);
            const list = getStore('quickapply_fill_queue');
            expect(list).toHaveLength(2);
        });

        it('defaults clientName to empty string when omitted', async () => {
            await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            const list = getStore('quickapply_fill_queue');
            expect(list[0].clientName).toBe('');
        });

        it('does not add duplicate (clientId+jobUrl) pairs', async () => {
            await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            const count = await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            expect(count).toBe(1);
            const list = getStore('quickapply_fill_queue');
            expect(list).toHaveLength(1);
        });
    });

    describe('addPair', () => {
        it('adds a single pair', async () => {
            const count = await Q.addPair('c1', 'Alice', 'https://example.com/job/1');
            expect(count).toBe(1);
        });

        it('returns current length when clientId missing', async () => {
            const count = await Q.addPair('', 'Alice', 'https://example.com/job/1');
            expect(count).toBe(0);
        });

        it('returns current length when jobUrl missing', async () => {
            const count = await Q.addPair('c1', 'Alice', '');
            expect(count).toBe(0);
        });
    });

    describe('listQueue', () => {
        it('returns empty array when storage is empty', async () => {
            const list = await Q.listQueue();
            expect(list).toEqual([]);
        });

        it('returns stored pairs', async () => {
            await Q.addPairs([{ clientId: 'c1', clientName: 'Alice', jobUrl: 'https://a.com' }]);
            const list = await Q.listQueue();
            expect(list).toHaveLength(1);
            expect(list[0].clientId).toBe('c1');
        });
    });

    describe('queueCount', () => {
        it('returns 0 for empty queue', async () => {
            expect(await Q.queueCount()).toBe(0);
        });

        it('returns correct count after adds', async () => {
            await Q.addPairs([
                { clientId: 'c1', jobUrl: 'https://a.com' },
                { clientId: 'c2', jobUrl: 'https://b.com' }
            ]);
            expect(await Q.queueCount()).toBe(2);
        });
    });

    describe('clearQueue', () => {
        it('empties the queue', async () => {
            await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            await Q.clearQueue();
            expect(await Q.queueCount()).toBe(0);
            expect(getStore('quickapply_fill_queue')).toEqual([]);
        });
    });

    describe('removeAtIndex', () => {
        it('removes the entry at the given index', async () => {
            await Q.addPairs([
                { clientId: 'c1', jobUrl: 'https://a.com' },
                { clientId: 'c2', jobUrl: 'https://b.com' },
                { clientId: 'c3', jobUrl: 'https://c.com' }
            ]);
            const remaining = await Q.removeAtIndex(1);
            expect(remaining).toBe(2);
            const list = getStore('quickapply_fill_queue');
            expect(list[0].clientId).toBe('c1');
            expect(list[1].clientId).toBe('c3');
        });

        it('returns current length for out-of-bounds index', async () => {
            await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            const remaining = await Q.removeAtIndex(99);
            expect(remaining).toBe(1);
        });

        it('returns current length for negative index', async () => {
            await Q.addPairs([{ clientId: 'c1', jobUrl: 'https://a.com' }]);
            const remaining = await Q.removeAtIndex(-1);
            expect(remaining).toBe(1);
        });
    });
});
