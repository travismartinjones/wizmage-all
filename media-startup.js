(function (root) {
    'use strict';

    const CLASS_NAME = 'wizmage-media-starting';
    const FAIL_OPEN_MS = 2000;
    const doc = root && root.document;
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
        ensureRootActivation();
        scheduleFailOpen();
    }

    function claim() {
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

    activate();
})(globalThis);
