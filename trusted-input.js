/**
 * QuickApply — trusted-input bridge.
 *
 * Some widgets gate on `event.isTrusted === true`:
 *   - modern Greenhouse react-select v5 — renders its option menu ONLY in
 *     response to a trusted pointer event, so synthetic `mousedown` + `click`
 *     opens the visual control but leaves `[role=option]` empty.
 *   - Workday's multi-select — fires the chip-add callback only for trusted clicks.
 *   - Workday's date spinbutton — same gate on key commits.
 *
 * Content scripts (and the page) can never make `isTrusted` true from JS. The
 * only browser-side path is Chrome DevTools Protocol via `chrome.debugger`,
 * which `background.js` owns. This file is the content-script bridge: it
 * exposes `window.QuickApplyTrustedInput` so any platform filler can request
 * a real, browser-originated click or text-insert at viewport coordinates.
 *
 * Tradeoffs: while the debugger is attached Chrome shows a yellow "browser
 * is being controlled by automated test software" bar (no way to suppress).
 * The user opted in to this in exchange for reliable react-select fill.
 */
(function () {
    'use strict';

    let _availability = null; // null = unknown, true/false = cached probe result

    function _send(msg) {
        return new Promise((resolve) => {
            try {
                const p = chrome.runtime.sendMessage(msg);
                if (p && typeof p.then === 'function') {
                    p.then(resolve).catch(() => resolve(null));
                } else {
                    // Some Chrome versions still take the callback form.
                    chrome.runtime.sendMessage(msg, (resp) => {
                        void chrome.runtime.lastError; // suppress
                        resolve(resp || null);
                    });
                }
            } catch (_) { resolve(null); }
        });
    }

    function _viewportCenter(el) {
        const r = el.getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            // Clamped to the viewport — CDP rejects negative coords.
            valid: r.width > 0 && r.height > 0
                && r.left + r.width / 2 >= 0
                && r.top + r.height / 2 >= 0
                && r.left + r.width / 2 <= (window.innerWidth || 99999)
                && r.top + r.height / 2 <= (window.innerHeight || 99999)
        };
    }

    /** Cheap one-shot capability probe — true iff background can attach the debugger. */
    async function available() {
        if (_availability !== null) return _availability;
        const resp = await _send({ type: 'TRUSTED_PING' });
        _availability = !!resp?.ok;
        return _availability;
    }

    /**
     * Click an element with a TRUSTED browser-side mouse event. Scrolls the
     * element into view first so its viewport coords are inside the window.
     * Returns false if the background couldn't dispatch (debugger attach
     * failed, no tab, etc.) — callers should fall back to a synthetic click.
     */
    async function click(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
        // Allow scroll to settle so getBoundingClientRect reflects the new position.
        await new Promise(r => setTimeout(r, 80));
        const pos = _viewportCenter(el);
        if (!pos.valid) return false;
        const resp = await _send({ type: 'TRUSTED_CLICK', x: pos.x, y: pos.y });
        return !!resp?.ok;
    }

    /** Trusted click at explicit viewport coordinates. */
    async function clickAt(x, y) {
        const resp = await _send({
            type: 'TRUSTED_CLICK',
            x: Math.round(x), y: Math.round(y)
        });
        return !!resp?.ok;
    }

    /**
     * Insert text via a TRUSTED input event (CDP Input.insertText). react-
     * select treats this as user typing and re-renders the filtered option
     * list. The currently-focused element receives the text — caller MUST
     * ensure the right input is focused first (typically by calling click()
     * on the input or its control immediately before).
     */
    async function type(text) {
        if (!text) return false;
        const resp = await _send({ type: 'TRUSTED_TYPE', text: String(text) });
        return !!resp?.ok;
    }

    /**
     * Type via per-key TRUSTED keyDown/keyUp events (CDP Input.dispatchKeyEvent),
     * with optional trailing Enter. Needed for widgets whose search filter only
     * fires on real key events (Workday's hierarchical "How did you hear" prompt) —
     * Input.insertText alone leaves the list unfiltered. Focus the input first.
     */
    async function typeKeys(text, enter) {
        if (!text && !enter) return false;
        const resp = await _send({ type: 'TRUSTED_KEYS', text: String(text || ''), enter: !!enter });
        return !!resp?.ok;
    }

    /** Explicitly release the debugger attachment for this tab. */
    async function detach() {
        await _send({ type: 'TRUSTED_DETACH' });
    }

    window.QuickApplyTrustedInput = { available, click, clickAt, type, typeKeys, detach };
})();
