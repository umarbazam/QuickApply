/**
 * Chrome extension API stubs for Jest (jsdom environment).
 * Provides a simple in-memory chrome.storage.local mock.
 */

const _store = {};

global.chrome = {
    runtime: {
        id: 'test-extension-id',
        sendMessage: jest.fn().mockResolvedValue({ ok: true })
    },
    storage: {
        local: {
            _store,
            // Chrome MV3 supports BOTH promise and callback styles on these
            // methods. Mirror that: always return a promise, and additionally
            // invoke the callback when one is supplied. storage.js uses the
            // callback form; other modules await the promise.
            get: jest.fn((keys, cb) => {
                let result;
                if (!keys) {
                    result = { ..._store };
                } else if (typeof keys === 'string') {
                    result = { [keys]: _store[keys] };
                } else if (Array.isArray(keys)) {
                    result = {};
                    for (const k of keys) result[k] = _store[k];
                } else {
                    result = {};
                    for (const k of Object.keys(keys)) result[k] = _store[k] !== undefined ? _store[k] : keys[k];
                }
                if (typeof cb === 'function') cb(result);
                return Promise.resolve(result);
            }),
            set: jest.fn((data, cb) => {
                Object.assign(_store, data);
                if (typeof cb === 'function') cb();
                return Promise.resolve();
            }),
            remove: jest.fn((keys, cb) => {
                const ks = Array.isArray(keys) ? keys : [keys];
                for (const k of ks) delete _store[k];
                if (typeof cb === 'function') cb();
                return Promise.resolve();
            }),
            clear: jest.fn((cb) => {
                for (const k of Object.keys(_store)) delete _store[k];
                if (typeof cb === 'function') cb();
                return Promise.resolve();
            })
        }
    }
};
