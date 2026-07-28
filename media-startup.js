(function (root) {
    'use strict';

    const CLASS_NAME = 'wizmage-media-starting';
    const SAFARI_CLASS_NAME = 'wizmage-safari-media-starting';
    const VIDEO_FRAME_BLOCKED_CLASS = 'wizmage-video-frame-blocked';
    const FAIL_OPEN_MS = 2000;
    const SAFARI_FAIL_OPEN_MS = 10000;
    const doc = root && root.document;
    const userAgent = String(root && root.navigator && root.navigator.userAgent || '');
    const isSafari = /\bSafari\//.test(userAgent)
        && !/\b(?:HeadlessChrome|Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)\//.test(userAgent);
    // WebKit compatibility is browser-wide, never page-specific. Any Safari
    // page can create the same renderer state.
    const safariLayoutSafe = isSafari;
    const guardVideosAtStartup = isSafari;
    let isEmbeddedFrame = false;
    try { isEmbeddedFrame = !!(root && root.top && root !== root.top); }
    catch (error) { isEmbeddedFrame = true; }
    let failOpenTimer = null;
    let rootObserver = null;
    let videoObserver = null;
    const guardedVideos = new Set();
    const blockedVideos = new Set();
    const settledVideos = new WeakSet();
    const userActivationExpires = new WeakMap();

    function isVideo(element) {
        return String(element && element.tagName || '').toUpperCase() === 'VIDEO';
    }

    function isVideoBlocked(video) {
        return !!(video && video.getAttribute
            && (video.getAttribute('data-wzm-locked') === '1'
                || video.getAttribute('data-wzm-safari-locked') === '1'));
    }

    function pauseVideo(video) {
        if (!guardVideosAtStartup || !isVideo(video))
            return;
        guardedVideos.add(video);
        try { video.pause(); } catch (error) { /* detached or protected media */ }
    }

    function guardVideo(video) {
        if (!isVideo(video))
            return;
        if (settledVideos.has(video) && !isVideoBlocked(video))
            return;
        pauseVideo(video);
    }

    function guardVideoTree(node) {
        if (!node || node.nodeType !== 1)
            return;
        guardVideo(node);
        if (!node.querySelectorAll)
            return;
        let videos;
        try { videos = node.querySelectorAll('video'); } catch (error) { return; }
        for (const video of videos)
            guardVideo(video);
    }

    function updateEmbeddedVideoPresentation() {
        if (!isEmbeddedFrame)
            return;
        const element = doc && doc.documentElement;
        if (!element)
            return;
        for (const video of Array.from(blockedVideos)) {
            if (!video || !video.isConnected)
                blockedVideos.delete(video);
        }
        element.classList.toggle(VIDEO_FRAME_BLOCKED_CLASS, blockedVideos.size > 0);
    }

    function forgetVideoTree(node) {
        if (!node || node.nodeType !== 1)
            return;
        if (isVideo(node)) {
            guardedVideos.delete(node);
            blockedVideos.delete(node);
        }
        if (!node.querySelectorAll)
            return;
        let videos;
        try { videos = node.querySelectorAll('video'); } catch (error) { return; }
        for (const video of videos) {
            guardedVideos.delete(video);
            blockedVideos.delete(video);
        }
        updateEmbeddedVideoPresentation();
    }

    function releaseVideoIfAllowed(video) {
        if (!video || isVideoBlocked(video))
            return false;
        guardedVideos.delete(video);
        // Do not synthesize playback after filtering. The page may retry its own
        // autoplay after the startup gate releases, or the user may press play.
        return true;
    }

    function resumeAllowedVideos() {
        for (const video of Array.from(guardedVideos)) {
            if (!video || !video.isConnected) {
                guardedVideos.delete(video);
                continue;
            }
            if (!isVideoBlocked(video))
                releaseVideoIfAllowed(video);
        }
    }

    function settleVideo(video, blocked) {
        if (!guardVideosAtStartup || !isVideo(video))
            return;
        settledVideos.add(video);
        if (blocked)
            blockedVideos.add(video);
        else
            blockedVideos.delete(video);
        updateEmbeddedVideoPresentation();
        if (blocked) {
            pauseVideo(video);
            return;
        }
        const element = doc && doc.documentElement;
        const gateClass = safariLayoutSafe ? SAFARI_CLASS_NAME : CLASS_NAME;
        const gateActive = !!(element && element.classList.contains(gateClass));
        if (!gateActive)
            releaseVideoIfAllowed(video);
    }

    function startVideoGuard() {
        if (!guardVideosAtStartup || !doc)
            return;
        try {
            const authorizeVideoFromEvent = function (event) {
                const path = event && typeof event.composedPath === 'function'
                    ? event.composedPath() : [event && event.target];
                for (const candidate of path) {
                    if (!isVideo(candidate))
                        continue;
                    userActivationExpires.set(candidate, Date.now() + 1500);
                    break;
                }
            };
            doc.addEventListener('pointerdown', authorizeVideoFromEvent, true);
            doc.addEventListener('keydown', authorizeVideoFromEvent, true);
            doc.addEventListener('play', function (event) {
                const video = event && event.target;
                if (!isVideo(video))
                    return;
                const userActivated = (userActivationExpires.get(video) || 0) >= Date.now();
                userActivationExpires.delete(video);
                if (isVideoBlocked(video) || !settledVideos.has(video)
                    || (guardedVideos.has(video) && !userActivated))
                    pauseVideo(video);
            }, true);
        } catch (error) { /* inaccessible document */ }
        guardVideoTree(doc.documentElement);
        if (typeof root.MutationObserver !== 'function')
            return;
        videoObserver = new root.MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes || [])
                    guardVideoTree(node);
                for (const node of mutation.removedNodes || [])
                    forgetVideoTree(node);
            }
        });
        try {
            videoObserver.observe(doc, { childList: true, subtree: true });
        } catch (error) {
            videoObserver = null;
        }
    }

    function setActive(active) {
        const element = doc && doc.documentElement;
        if (!element)
            return false;
        const className = safariLayoutSafe ? SAFARI_CLASS_NAME : CLASS_NAME;
        element.classList.toggle(className, !!active);
        if (!active) {
            element.classList.toggle(CLASS_NAME, false);
            element.classList.toggle(SAFARI_CLASS_NAME, false);
        }
        return true;
    }

    function scheduleFailOpen() {
        if (failOpenTimer != null)
            return;
        failOpenTimer = root.setTimeout(function () {
            failOpenTimer = null;
            release();
        }, safariLayoutSafe ? SAFARI_FAIL_OPEN_MS : FAIL_OPEN_MS);
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
        if (guardVideosAtStartup)
            resumeAllowedVideos();
    }

    const gate = Object.freeze({
        activate,
        claim,
        release,
        isActive: function () {
            const element = doc && doc.documentElement;
            return !!(element && (element.classList.contains(CLASS_NAME)
                || element.classList.contains(SAFARI_CLASS_NAME)));
        },
        usesSafariLayoutSafeMode: function () {
            return safariLayoutSafe;
        },
        guardVideo,
        settleVideo
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
        Object.defineProperty(root, 'WizmageSafariLayoutSafe', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: safariLayoutSafe
        });
    } catch (error) {
        root.WizmageSafariLayoutSafe = safariLayoutSafe;
    }

    startVideoGuard();
    activate();
})(globalThis);
