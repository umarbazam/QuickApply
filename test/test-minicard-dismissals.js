// Self-test runner for mini-card dismissals — extracted because MV3 CSP
// blocks inline scripts on chrome-extension:// pages.
const out = document.getElementById('out');
function ok(name)  { out.insertAdjacentHTML('beforeend', `<div class="pass">✓ ${name}</div>`); }
function fail(name, why) { out.insertAdjacentHTML('beforeend', `<div class="fail">✗ ${name} — ${why}</div>`); }

async function run() {
    const m = window.QuickApplyMiniCardDismissals;
    if (!m) return fail('module exposed', 'window.QuickApplyMiniCardDismissals missing');
    ok('module exposed');

    await m.clear('example.com'); // baseline
    if ((await m.isDismissed('example.com')) === false) ok('baseline: not dismissed'); else fail('baseline');

    await m.dismiss('example.com');
    if ((await m.isDismissed('example.com')) === true) ok('dismiss → isDismissed true'); else fail('dismiss writes');

    await m.clear('example.com');
    if ((await m.isDismissed('example.com')) === false) ok('clear undismisses'); else fail('clear');

    // Expiry: write a stale stamp directly, isDismissed must filter it.
    const KEY = 'quickapply_minicard_dismissals';
    const stale = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
    await chrome.storage.local.set({ [KEY]: { 'stale.com': stale } });
    if ((await m.isDismissed('stale.com')) === false) ok('expired stamp ignored'); else fail('TTL not applied');

    // After read, the stale entry should be cleaned out of storage too.
    const after = await chrome.storage.local.get(KEY);
    if (!(after[KEY] || {})['stale.com']) ok('expired stamp cleaned'); else fail('stale cleanup', JSON.stringify(after));
}
run();
