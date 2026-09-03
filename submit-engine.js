/**
 * QuickApply Submit Engine — advances through multi-step forms and submits.
 * Detects Next/Continue/Submit buttons, validates before advancing, loops until done.
 */
(function () {
    'use strict';

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    const NEXT_SELECTORS = {
        workday:         'button[data-automation-id="pageFooterNextButton"], button[data-automation-id="bottom-navigation-next-button"]',
        greenhouse:      'button[type="submit"]:not([aria-label*="save" i]), input[type="submit"], button.btn--pill:not(.btn--secondary), button.btn--rounded:not(.btn--secondary), button.btn--rectangle:not(.btn--secondary)',
        icims:           'button[title*="Next" i], button[title*="Continue" i], button[title*="Submit" i]',
        ashby:           'button[type="submit"]',
        lever:           '#btn-submit, [data-qa="btn-submit"], button[type="submit"], button',
        smartrecruiters: '[data-test="footer-next"], [data-test="footer-submit"]',
        workable:        'button[type="submit"]',
        rippling:        'button',
        generic:         'button[type="submit"], input[type="submit"], button, [role="button"]'
    };

    const SUBMIT_TEXT_PATTERNS = /\b(submit|apply now|send application|complete application)\b/i;
    const NEXT_TEXT_PATTERNS   = /\b(next|continue|proceed|save and continue|save & continue)\b/i;
    const ALREADY_APPLIED_PATTERNS = [
        /application submitted/i, /you('ve| have) already applied/i,
        /thank you for applying/i, /thanks for applying/i,
        /your application was received/i,
        /successfully submitted/i, /application received/i,
        /application has been submitted/i,
        /we.{0,30}received your application/i,
    ];

    // URL path suffixes that indicate a successful application submission
    const SUCCESS_URL_PATTERNS = [
        /\/thanks\/?(\?|#|$)/i,          // Lever
        /\/thank-you\/?(\?|#|$)/i,
        /\/success\/?(\?|#|$)/i,
        /\/confirmation\/?(\?|#|$)/i,
        /\/submitted\/?(\?|#|$)/i,
    ];

    function detectSubmitSuccess() {
        if (SUCCESS_URL_PATTERNS.some(p => p.test(window.location.href))) return true;
        return ALREADY_APPLIED_PATTERNS.some(p => p.test(document.body.innerText));
    }

    /** True if an hCaptcha widget is present and loaded on this page */
    function detectHCaptcha() {
        return !!(document.querySelector('.h-captcha[data-sitekey]') && typeof window.hcaptcha !== 'undefined');
    }

    /** True if a reCAPTCHA widget is present (invisible badge, enterprise, or v2 checkbox) */
    function detectReCaptcha() {
        return !!(
            document.querySelector('.grecaptcha-badge') ||
            document.querySelector('iframe[src*="recaptcha.net/recaptcha"], iframe[src*="google.com/recaptcha"]')
        );
    }

    /** True if the page is showing an email verification code prompt (new Greenhouse) */
    function detectEmailVerification() {
        const bodyText = document.body.innerText || '';
        return /verification code (was|has been) sent|security code|enter.*\d.character code/i.test(bodyText)
            && /to submit your application|confirm you.re a human/i.test(bodyText);
    }

    /** Poll for success URL — used after hCaptcha submit where the user may need time to solve */
    function waitForSuccessOrTimeout(timeoutMs = 60_000) {
        return new Promise(resolve => {
            const id = setInterval(() => {
                if (detectSubmitSuccess()) { clearInterval(id); resolve(true); }
            }, 400);
            setTimeout(() => { clearInterval(id); resolve(false); }, timeoutMs);
        });
    }

    /** Wait for either DOM settle or URL navigation, whichever comes first */
    function waitForSubmitNavigation(timeoutMs = 8000) {
        const startUrl = window.location.href;
        return Promise.race([
            waitForDOMSettle(500, timeoutMs),
            new Promise(res => {
                const id = setInterval(() => {
                    if (window.location.href !== startUrl) { clearInterval(id); res(); }
                }, 150);
                setTimeout(() => { clearInterval(id); res(); }, timeoutMs);
            })
        ]);
    }

    /** Wait for DOM quiet — no mutations for quietMs ms (or timeoutMs total) */
    function waitForDOMSettle(quietMs = 500, timeoutMs = 8000) {
        return new Promise(resolve => {
            let timer;
            const reset = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
            const done  = () => { observer.disconnect(); resolve(); };
            const observer = new MutationObserver(reset);
            observer.observe(document.body, { childList: true, subtree: true, attributes: false });
            reset();
            // Timeout resolves (not rejects) so the loop continues on slow platforms
            setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
        });
    }

    /** Classify button as 'submit' or 'continue' */
    function getButtonType(button) {
        // SR OneClick: footer buttons use data-test attrs; text lives inside shadow DOM
        // and is not accessible via textContent. Classify by data-test directly.
        const dataTest = button.getAttribute('data-test') || '';
        if (dataTest === 'footer-submit') return 'submit';
        if (dataTest === 'footer-next') return 'continue';

        const text = (
            button.textContent ||
            button.value ||
            button.getAttribute('aria-label') || ''
        ).trim();
        if (SUBMIT_TEXT_PATTERNS.test(text)) return 'submit';
        if (/^\s*apply\s*$/i.test(text)) return 'submit';
        if (button.type === 'submit' && !NEXT_TEXT_PATTERNS.test(text)) return 'submit';
        return 'continue';
    }

    /** Find the visible Next/Continue/Submit button */
    function findNextButton(siteLabel) {
        const selector = NEXT_SELECTORS[siteLabel] || NEXT_SELECTORS.generic;
        const candidates = Array.from(document.querySelectorAll(selector));

        return candidates.find(btn => {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            // getBoundingClientRect() returns zeros in background (inactive) tabs — use computed style instead
            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
            // For generic/lever selectors, require text match to filter candidates
            if (siteLabel === 'generic' || siteLabel === 'lever') {
                // Always accept Lever's explicit submit button by ID/data-qa
                if (btn.id === 'btn-submit' || btn.getAttribute('data-qa') === 'btn-submit') return true;
                return SUBMIT_TEXT_PATTERNS.test(text) || NEXT_TEXT_PATTERNS.test(text);
            }
            // For rippling, filter to Apply/submit buttons only (avoids "Exit to job board")
            if (siteLabel === 'rippling') {
                return SUBMIT_TEXT_PATTERNS.test(text) || /^\s*apply\s*$/i.test(text);
            }
            return true;
        }) || null;
    }

    /** Detect visible validation errors */
    function detectValidationErrors() {
        const selectors = [
            '[aria-invalid="true"]', '.error-message', '.field-error',
            '[class*="error-msg"]', '[role="alert"]', '.validation-error',
            '.helper-text--error',  // new Greenhouse Remix form
        ];
        return selectors
            .flatMap(s => [...document.querySelectorAll(s)])
            .filter(el => {
                if (!(el.textContent || '').trim()) return false;
                // getBoundingClientRect() returns 0x0 in background/inactive tabs,
                // so use computed style instead — it reflects CSS regardless of tab focus.
                const s = window.getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden';
            });
    }

    /** Check if application was already submitted */
    function detectAlreadyApplied() {
        return ALREADY_APPLIED_PATTERNS.some(p => p.test(document.body.innerText));
    }

    /** Highlight validation error elements for user */
    function highlightErrors(errors) {
        for (const el of errors) {
            el.style.outline = '2px solid red';
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 5000);
        }
    }

    /**
     * Run the multi-step fill+submit loop.
     * @param {BaseFiller} filler
     * @param {object} profile
     * @param {string} resumeText
     * @param {string} clientId
     * @param {object} settings - { autoAdvanceSteps, autoSubmit }
     * @param {object} aiInstance - window.QuickApplyAI instance or null
     * @param {Function} notifyUser - shows toast/message
     * @param {number} maxSteps
     */
    async function run(filler, profile, resumeText, clientId, settings, aiInstance, notifyUser, maxSteps = 15) {
        if (window._qaSubmitInProgress) {
            notifyUser('Fill already in progress', 'info');
            return { success: false, reason: 'already-running' };
        }
        window._qaSubmitInProgress = true;

        const filledSelectors = new Set();  // cross-step already-filled guard
        let step = 0;
        let totalFilled = 0;
        let result = { success: false };

        try {
            while (step < maxSteps) {
                step++;

                // 1. Discover + resolve + fill current step
                const rules = await filler.discoverFields();
                const answers = await window.QuickApplyAIResolver.resolveBatch(
                    rules, profile, resumeText, clientId, aiInstance, {}, { forceAI: !!settings.forceAI }, filler
                );
                const _fillResult = await window.QuickApplyFillEngine.fillAll(
                    rules, answers, { filledSelectors, skipFocus: filler?.getQuirks?.().skipFocus ?? false }
                );
                const filledCount = _fillResult?.count ?? _fillResult;
                totalFilled += (typeof filledCount === 'number' ? filledCount : 0);
                await filler.postFill();
                await delay(300);  // let DOM settle after postFill (enables buttons, hides panels)

                // 2. Find next button
                const siteLabel = filler.getSiteLabel();
                const nextBtn = findNextButton(siteLabel);
                if (!nextBtn) {
                    notifyUser(`Step ${step} filled (${filledCount} fields). No Next button found.`, 'info');
                    result = { success: true, step, noMoreSteps: true };
                    break;
                }

                const btnType = getButtonType(nextBtn);

                // 4. Final submit gate
                if (btnType === 'submit') {
                    if (!settings.autoSubmit) {
                        notifyUser('Application ready — click Submit to apply', 'success', true);
                        result = { success: true, step, awaitingSubmit: true };
                        break;
                    }

                    const hasHCaptcha  = detectHCaptcha();
                    const hasCaptcha   = hasHCaptcha || detectReCaptcha();

                    if (hasCaptcha) {
                        // Bring tab to foreground so user can see and solve the CAPTCHA challenge.
                        // Content scripts can't call chrome.tabs.update directly — route via background.
                        notifyUser('Form filled! Solve the CAPTCHA to submit.', 'info');
                        try { chrome.runtime.sendMessage({ type: 'ACTIVATE_CURRENT_TAB' }); } catch (_) {}
                        await delay(400);  // let tab activation propagate before scrolling/clicking
                    }

                    nextBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await delay(300);
                    nextBtn.click();

                    if (hasCaptcha) {
                        // Poll for success URL — user may take up to 60 s to solve the CAPTCHA
                        const succeeded = await waitForSuccessOrTimeout(60_000);
                        if (succeeded) {
                            notifyUser('Application submitted!', 'success');
                            result = { success: true, step, submitted: true };
                        } else {
                            notifyUser('CAPTCHA not solved in time — tab left open, please submit manually', 'warning');
                            result = { success: false, step, submitAttempted: true, keepTabOpen: true, reason: 'CAPTCHA required — tab activated, solve challenge and submit manually' };
                        }
                    } else {
                        await waitForSubmitNavigation(12000);
                        if (detectSubmitSuccess()) {
                            notifyUser('Application submitted!', 'success');
                            result = { success: true, step, submitted: true };
                        } else if (detectEmailVerification()) {
                            notifyUser('Email verification required — check your inbox to complete submission', 'info');
                            try { chrome.runtime.sendMessage({ type: 'ACTIVATE_CURRENT_TAB' }); } catch (_) {}
                            result = { success: false, step, submitAttempted: true, keepTabOpen: true, reason: 'Email verification required — tab left open, enter code from inbox' };
                        } else {
                            const postErrors = detectValidationErrors();
                            const reason = postErrors.length
                                ? `Submit blocked: ${postErrors.length} validation error(s) — check required fields`
                                : 'Submit clicked but no confirmation page — may require resume upload or CAPTCHA';
                            notifyUser(reason, 'warning');
                            result = { success: false, step, submitAttempted: true, reason };
                        }
                    }
                    break;
                }

                // 5. Auto-advance: click Next/Continue
                if (!settings.autoAdvanceSteps) {
                    notifyUser(`Step ${step} filled. Click Next when ready.`, 'info');
                    result = { success: true, step, awaitingNext: true };
                    break;
                }

                await delay(800);  // let form validate
                nextBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await delay(100);
                nextBtn.click();

                // 6. Wait for next step to load
                await waitForSubmitNavigation(8000);

                if (detectSubmitSuccess()) {
                    notifyUser('Application submitted!', 'success');
                    result = { success: true, step, submitted: true };
                    break;
                }
            }

            if (step >= maxSteps && !result.submitted) {
                notifyUser(`Auto-fill stopped: form has more than ${maxSteps} steps`, 'warning');
                result = { success: false, step, maxStepsReached: true };
            }
        } catch (err) {
            console.error('[QuickApply SubmitEngine] error:', err);
            notifyUser('Auto-fill error: ' + err.message, 'error');
            result = { success: false, error: err.message };
        } finally {
            window._qaSubmitInProgress = false;
            result.totalFilled = totalFilled;
        }

        return result;
    }

    window.QuickApplySubmitEngine = { run, waitForDOMSettle, detectValidationErrors };
})();
