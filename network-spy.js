/**
 * QuickApply — Network Spy (MAIN world, document_start)
 *
 * Intercepts all XHR and fetch calls and posts captured request data to the
 * window so the content script (isolated world) can record it in the session.
 * Only captures mutating methods (POST/PUT/PATCH) and skips static assets.
 */
(function () {
    'use strict';

    const CAPTURE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

    // Skip static assets, captcha services, and analytics noise
    const SKIP_RE = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|css|js|map)(\?|$)|recaptcha|hcaptcha|captcha|google-analytics|doubleclick|facebook\.net|twitter\.com|segment\.|mixpanel|hotjar|heap\.|newrelic|datadog|sentry\.io|amplitude/i;

    function bodyToString(body) {
        if (body == null) return null;
        if (typeof body === 'string') return body.slice(0, 6000);
        if (body instanceof URLSearchParams) return body.toString().slice(0, 6000);
        if (body instanceof FormData) {
            const parts = [];
            try { body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v.slice(0, 200) : '[file]'}`)); }
            catch (_) {}
            return '[FormData] ' + parts.join(' | ').slice(0, 6000);
        }
        return '[binary]';
    }

    const _MAX_BUF = 200; // cap: ~200 requests × ~8KB each = ~1.6 MB max

    function post(data) {
        // Push synchronously to a shared window buffer instead of postMessage.
        // postMessage is async and may not be delivered before beforeunload fires,
        // causing networkRequests[] to be empty in all recordings.
        try {
            if (!window.__qaNetBuf) window.__qaNetBuf = [];
            if (window.__qaNetBuf.length < _MAX_BUF) window.__qaNetBuf.push(data);
        } catch (_) {}
    }

    // ── XHR ─────────────────────────────────────────────────────────────
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__qa_method = (method || '').toUpperCase();
        this.__qa_url = String(url || '');
        return _xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        const method = this.__qa_method;
        const url = this.__qa_url;
        if (CAPTURE_METHODS.has(method) && !SKIP_RE.test(url)) {
            const bodyStr = bodyToString(body);
            this.addEventListener('loadend', () => {
                let resp = null;
                try { resp = this.responseText ? this.responseText.slice(0, 1500) : null; } catch (_) {}
                post({ method, url, body: bodyStr, status: this.status, responsePreview: resp, ts: Date.now() });
            });
        }
        return _xhrSend.apply(this, arguments);
    };

    // ── Fetch ────────────────────────────────────────────────────────────
    const _origFetch = window.fetch;
    window.fetch = function (resource, init) {
        const url = resource instanceof Request ? resource.url
            : typeof resource === 'string' ? resource : String(resource);
        const method = ((init && init.method) || (resource instanceof Request && resource.method) || 'GET').toUpperCase();

        if (CAPTURE_METHODS.has(method) && !SKIP_RE.test(url)) {
            const bodyStr = bodyToString(init && init.body);
            const p = _origFetch.apply(this, arguments);
            p.then(response => {
                post({ method, url, body: bodyStr, status: response.status, responsePreview: null, ts: Date.now() });
            }).catch(() => {});
            return p;
        }
        return _origFetch.apply(this, arguments);
    };

})();
