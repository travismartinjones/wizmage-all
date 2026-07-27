(function (root) {
    'use strict';

    const CLASS_NAME = 'wizmage-media-starting';
    const FAIL_OPEN_MS = 2000;
    const doc = root && root.document;
    const userAgent = String(root && root.navigator && root.navigator.userAgent || '');
    const pageHost = String(root && root.location && root.location.hostname || '').toLowerCase();
    const referrer = String(doc && doc.referrer || '');
    const isSafari = /\bSafari\//.test(userAgent)
        && !/\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)\//.test(userAgent);
    const isAmazonPage = pageHost === 'amazon.com'
        || pageHost.endsWith('.amazon.com')
        || /^https?:\/\/(?:[^/?#]+\.)?amazon\.com(?::\d+)?(?:[/?#]|$)/i.test(referrer);
    const compatibilityBypass = isSafari && isAmazonPage;
    let failOpenTimer = null;
    let rootObserver = null;

    function setActive(active) {
        const element = doc && doc.documentElement;
        if (!element)
            return false;
        element.classList.toggle(CLASS_NAME, !!active);
        return true;
    }

    function scheduleFailOpen() {
        if (failOpenTimer != null)
            return;
        failOpenTimer = root.setTimeout(function () {
            failOpenTimer = null;
            release();
        }, FAIL_OPEN_MS);
    }

    function cancelFailOpen() {
        if (failOpenTimer == null)
            return;
        root.clearTimeout(failOpenTimer);
        failOpenTimer = null;
    }

    function ensureRootActivation() {
        if (setActive(true) || rootObserver || !doc || typeof root.MutationObserver !== 'function')
            return;
        const observer = new root.MutationObserver(function () {
            if (rootObserver !== observer)
                return;
            if (!setActive(true))
                return;
            observer.disconnect();
            rootObserver = null;
        });
        rootObserver = observer;
        observer.observe(doc, { childList: true, subtree: true });
    }

    function activate() {
        if (compatibilityBypass) {
            release();
            return;
        }
        ensureRootActivation();
        scheduleFailOpen();
    }

    function claim() {
        if (compatibilityBypass) {
            release();
            return;
        }
        ensureRootActivation();
        cancelFailOpen();
    }

    function release() {
        cancelFailOpen();
        if (rootObserver) {
            rootObserver.disconnect();
            rootObserver = null;
        }
        setActive(false);
    }

    const gate = Object.freeze({
        activate,
        claim,
        release,
        isActive: function () {
            const element = doc && doc.documentElement;
            return !!(element && element.classList.contains(CLASS_NAME));
        },
        isCompatibilityBypassed: function () {
            return compatibilityBypass;
        }
    });

    try {
        Object.defineProperty(root, 'WizmageMediaGate', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: gate
        });
    } catch (error) {
        root.WizmageMediaGate = gate;
    }

    try {
        Object.defineProperty(root, 'WizmageSafariCompatibilityBypass', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: compatibilityBypass
        });
    } catch (error) {
        root.WizmageSafariCompatibilityBypass = compatibilityBypass;
    }

    if (compatibilityBypass)
        release();
    else
        activate();
})(globalThis);
