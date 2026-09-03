// Self-test runner for jd-queue. CSP forbids inline scripts on
// chrome-extension:// pages, so this is loaded as an external src.
const out = document.getElementById('out');
function ok(name)  { out.insertAdjacentHTML('beforeend', `<div class="pass">✓ ${name}</div>`); }
function fail(name, why) { out.insertAdjacentHTML('beforeend', `<div class="fail">✗ ${name} — ${why}</div>`); }

async function run() {
    const Q = globalThis.QuickApplyJdQueue;
    if (!Q) return fail('module exposed', 'globalThis.QuickApplyJdQueue missing');
    ok('module exposed');

    await Q.clearQueue();
    if ((await Q.queueCount()) === 0) ok('baseline empty'); else fail('baseline');

    const c1 = await Q.addToQueue('https://example.com/jobs/abc');
    if (c1 === 1) ok('add returns count 1'); else fail('add count', c1);

    const c2 = await Q.addToQueue('https://example.com/jobs/abc');
    if (c2 === 1) ok('dedup same URL'); else fail('dedup', c2);

    const c3 = await Q.addToQueue('HTTPS://EXAMPLE.COM/jobs/abc');
    if (c3 === 1) ok('dedup case-insensitive'); else fail('case dedup', c3);

    const c4 = await Q.addToQueue('https://example.com/jobs/xyz');
    if (c4 === 2) ok('add second URL'); else fail('add 2', c4);

    const list = await Q.listQueue();
    if (list.length === 2 && list.every(it => it.url && it.addedAt)) {
        ok('list shape ok');
    } else {
        fail('list shape', JSON.stringify(list));
    }

    await Q.removeFromQueue('https://example.com/jobs/abc');
    if ((await Q.queueCount()) === 1) ok('remove drops count'); else fail('remove');

    await Q.clearQueue();
    if ((await Q.queueCount()) === 0) ok('clear empties queue'); else fail('clear');
}
run();
