(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // TikTok / ByteDance careers application form (lifeattiktok.com/resume/
    // <jobId>/apply). It's a custom React form built on ByteDance's "atsx"
    // component library — form rows are `.atsx-form-item`, labels are
    // `<label for="...">`. Field ids are meaningful and stable:
    //   name, email                 — Basic Information
    //   education[N].school         — School name   (N = 1-based entry index)
    //   education[N].fieldOfStudy
    //   education[N].degree         — custom atsx dropdown ("Please choose")
    //   workExperience[N].*         — Work Experience entries
    // Repeatable sections (Work Experience, Education, Internship, Project)
    // render with entry [1] already present plus an `.addMore-add` "Add" span
    // to append more — so, unlike Workday, we do NOT auto-expand in preFill
    // (that would only append empty entries).

    class TikTokFiller extends window.QuickApplyBaseFiller {
        getSiteLabel() { return 'tiktok'; }

        async preFill() {
            // The form streams in after hydration (Next.js App Router). Wait
            // for the Basic Information inputs OR an atsx form row to appear.
            const start = Date.now();
            while (Date.now() - start < 8000) {
                if (document.querySelector('#name, #email, .atsx-form-item, [id^="education["]')) break;
                await delay(300);
            }
            // Let the custom-component tree finish mounting its dropdowns /
            // phone widget before discovery scans.
            await delay(400);
        }

        async discoverFields() {
            const rules = await super.discoverFields();
            // TikTok repeatable-section ids look like `education[1].school`.
            // Re-fingerprint them off the visible label PLUS the section name
            // and entry index, so (a) the answer cache survives a reload and
            // (b) entry [1] and entry [2] never collapse onto one fingerprint.
            for (const rule of rules) {
                const id = rule.element?.id || '';
                const m = id.match(/^([A-Za-z]+)\[(\d+)\]\.(\w+)$/);
                if (m && rule.label) {
                    const keyed = `${rule.label} | ${m[1]} ${m[2]}`;
                    rule.fingerprint = window.QuickApplyCache.makeFingerprint(
                        keyed, rule.type, rule.options
                    );
                }
            }
            return rules;
        }

        // TikTok's repeatable-section ids (`education[1].school`) collide with
        // the generic mapper: field-mapper.js `matchAgainstAliases` strips
        // brackets (`education[1].school` → `education1.school`) then does a
        // LONGEST-substring match — and a global "education"-prefixed alias
        // (9 chars) outranks a short `.school` hint, so School name wrongly
        // resolves to `degree`. The reliable fix is exact-match aliases in the
        // post-cleaning form (`educationN.school`): those hit Phase 1 of the
        // matcher at confidence 1.0, before any substring scoring. We enumerate
        // entries 1-6 — far more than any candidate fills in practice.
        getFieldAliases() {
            const idx = [1, 2, 3, 4, 5, 6];
            const forEach = (suffix) => idx.map(n => `education${n}.${suffix}`);
            const work = (suffix) => idx.map(n => `workexperience${n}.${suffix}`);
            return {
                university: forEach('school'),
                major: forEach('fieldofstudy'),
                degree: forEach('degree'),
                gpa: [...forEach('gpa'), ...forEach('grade')],
                currentCompany: work('company'),
                currentJobTitle: [...work('jobtitle'), ...work('title'), ...work('position')]
            };
        }

        async postFill() {
            await super.postFill?.();
            // TikTok's phone widget is a country-code selector + a separate
            // number input. The generic filler binds to the country picker
            // (which exposes the "+1" string as its value), so the number
            // input — which has no id/name — stays empty. Find the number
            // input by structure: it's an <input type="tel"> or numeric text
            // input that lives next to a "+1"-displaying element, and fill it
            // with profile.phone stripped of any leading country code.
            const profile = this._lastProfile;
            const phone = String(profile?.phone || '').trim();
            if (!phone) return;
            const stripped = phone.replace(/^\+\d{1,3}[\s\-.]*/, '').replace(/\D/g, '');
            if (!stripped) return;

            const setNative = (el, v) => {
                const proto = window.HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            // Strategy 1: input[type="tel"] with no id (the number input proper).
            const tels = Array.from(document.querySelectorAll('input[type="tel"]'))
                .filter(el => {
                    if (!el.offsetParent) return false;
                    if (el.value && /\d{4,}/.test(el.value)) return false;  // already filled
                    return true;
                });
            for (const el of tels) {
                setNative(el, stripped);
            }

            // Strategy 2: the form-item labeled "Mobile" / "Phone" may render
            // the number as a text input AFTER a country chip. Find the form
            // item whose label matches, then the input that's NOT the country
            // selector. Only run if Strategy 1 didn't hit anything.
            if (!tels.length) {
                const labels = Array.from(document.querySelectorAll('label'));
                for (const lbl of labels) {
                    if (!/^\s*(mobile|phone)\b/i.test(lbl.textContent || '')) continue;
                    const item = lbl.closest('.atsx-form-item, .atsx-form-item-control, [class*="form-item"]');
                    if (!item) continue;
                    const candidates = Array.from(item.querySelectorAll('input'))
                        .filter(el => el.offsetParent
                            && (el.type === 'text' || el.type === 'tel' || !el.type)
                            && !el.readOnly
                            && !el.disabled
                            // skip the country-code chip (its value starts with +)
                            && !/^\+/.test(el.value || ''));
                    // Pick the LAST candidate — the country chip comes first.
                    const target = candidates[candidates.length - 1];
                    if (target && (!target.value || !/\d{4,}/.test(target.value))) {
                        setNative(target, stripped);
                    }
                }
            }
        }

        getNextSelectors() {
            // The form's primary action is a single "Submit" button. Also
            // accept Next/Continue for any multi-step variant.
            return 'button[type="submit"], button[class*="submit" i], button[class*="next" i]';
        }
    }

    window.QuickApplyFillerFactory.register('tiktok', TikTokFiller);
    window.QuickApplyTikTokFiller = TikTokFiller;
})();
