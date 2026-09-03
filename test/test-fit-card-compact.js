// Self-test runner for pickPrimaryParam — extracted to a file because
// MV3 CSP blocks inline scripts on chrome-extension:// pages.
const out = document.getElementById('out');
function ok(name)  { out.insertAdjacentHTML('beforeend', `<div class="pass">✓ ${name}</div>`); }
function fail(name, why) { out.insertAdjacentHTML('beforeend', `<div class="fail">✗ ${name} — ${why}</div>`); }

async function run() {
    const pick = window.QuickApplyFitCardCompact?.pickPrimaryParam;
    if (!pick) return fail('pickPrimaryParam exposed', 'window.QuickApplyFitCardCompact missing');
    ok('pickPrimaryParam exposed');

    // 1: hard fail wins over everything
    const params1 = [
        { key: 'visa',     kind: 'hard', status: 'pass', score: 100, label: 'Visa' },
        { key: 'location', kind: 'hard', status: 'fail', score: 0,   label: 'Location' },
        { key: 'title',    kind: 'soft', status: 'pass', score: 30,  label: 'Title' }
    ];
    const r1 = pick(params1, { yoe:40,title:25,skills:25,salary:10 });
    if (r1?.key === 'location') ok('hard fail wins'); else fail('hard fail wins', JSON.stringify(r1));

    // 2: manual wins over soft when no hard fail
    const params2 = [
        { key: 'visa',           kind: 'hard', status: 'pass',   score: 100 },
        { key: 'employmentType', kind: 'hard', status: 'manual', score: null },
        { key: 'title',          kind: 'soft', status: 'pass',   score: 30 }
    ];
    const r2 = pick(params2, { yoe:40,title:25,skills:25,salary:10 });
    if (r2?.key === 'employmentType') ok('manual wins over weak soft'); else fail('manual wins', JSON.stringify(r2));

    // 3: when no hard fail and no manual, lowest soft score wins
    const params3 = [
        { key: 'yoe',    kind: 'soft', status: 'pass', score: 75 },
        { key: 'title',  kind: 'soft', status: 'pass', score: 30 },
        { key: 'skills', kind: 'soft', status: 'pass', score: 50 }
    ];
    const r3 = pick(params3, { yoe:40,title:25,skills:25,salary:10 });
    if (r3?.key === 'title') ok('lowest soft score wins'); else fail('lowest soft', JSON.stringify(r3));

    // 4: skipped soft rows are excluded from the lowest-score search
    const params4 = [
        { key: 'salary', kind: 'soft', status: 'skipped', score: null },
        { key: 'title',  kind: 'soft', status: 'pass',    score: 60 }
    ];
    const r4 = pick(params4, { yoe:40,title:25,skills:25,salary:10 });
    if (r4?.key === 'title') ok('skipped excluded'); else fail('skipped excluded', JSON.stringify(r4));

    // 5: tie on score → lowest weight wins (salary 10 < skills 25)
    const params5 = [
        { key: 'skills', kind: 'soft', status: 'pass', score: 40 },
        { key: 'salary', kind: 'soft', status: 'pass', score: 40 }
    ];
    const r5 = pick(params5, { yoe:40,title:25,skills:25,salary:10 });
    if (r5?.key === 'salary') ok('tie → lowest weight'); else fail('tie → lowest weight', JSON.stringify(r5));

    // 6: nothing selectable → returns null (caller falls back to verdict only)
    const params6 = [
        { key: 'visa', kind: 'hard', status: 'pass', score: 100 },
        { key: 'yoe',  kind: 'soft', status: 'skipped', score: null }
    ];
    const r6 = pick(params6, { yoe:40,title:25,skills:25,salary:10 });
    if (r6 === null) ok('all-pass returns null'); else fail('all-pass returns null', JSON.stringify(r6));
}
run();
