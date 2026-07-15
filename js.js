(function () {
    'use strict';

    function prepareFilteringRoot() {
        if (document.documentElement)
            document.documentElement.classList.remove('wizmage-show-html');
    }

    function releaseMediaGate() {
        const gate = globalThis.WizmageMediaGate;
        if (gate && typeof gate.release === 'function')
            gate.release();
        if (document.documentElement) {
            document.documentElement.classList.remove('wizmage-media-starting');
            document.documentElement.classList.remove('wizmage-media-authority-pending');
            document.documentElement.classList.add('wizmage-show-html');
        }
    }

    function holdMediaAuthorityGate() {
        if (document.documentElement)
            document.documentElement.classList.add('wizmage-media-authority-pending');
    }

    function releaseMediaAuthorityGate() {
        if (document.documentElement)
            document.documentElement.classList.remove('wizmage-media-authority-pending');
    }

    const Shared = globalThis.WizmageShared;
    const Controller = globalThis.WizmageContentController;
    if (!Shared || !Controller) {
        releaseMediaGate();
        throw new Error('Wizmage runtime dependencies did not load');
    }

    const browserApi = typeof browser !== 'undefined' ? browser : null;
    const chromeApi = typeof chrome !== 'undefined' ? chrome : null;
    const runtime = (chromeApi && chromeApi.runtime) || (browserApi && browserApi.runtime) || null;
    const storage = (chromeApi && chromeApi.storage) || (browserApi && browserApi.storage) || null;
    const extensionDom = (chromeApi && chromeApi.dom) || (browserApi && browserApi.dom) || null;
    const storageLocal = storage && storage.local ? storage.local : null;
    const usePromiseApi = !!browserApi && (!chromeApi || chromeApi === browserApi);
    const ANALYSIS_TIMEOUT_MS = 21000;
    const SETTINGS_FAIL_OPEN_MS = 5000;
    const MAX_ANALYSIS_URL_CHARS = 512 * 1024;
    const MAX_NETWORK_URL_CHARS = 32 * 1024;
    const MAX_PAGE_URL_CHARS = 16 * 1024;
    const MAX_FRAME_ANALYSES = 8;
    const MAX_FRAME_ANALYSIS_REQUESTS = 1024;
    const MAX_FRAME_ANALYSIS_URL_CHARS = 16 * 1024 * 1024;
    const MAX_ANALYSIS_WAITERS = 256;
    const MAX_BACKPRESSURE_RETRIES = 4;

    let controller = null;
    let effectiveSettings = null;
    let hasAuthoritativeSettings = false;
    let manualShow = false;
    let settingsRequestRevision = 0;
    let cancelSettingsRequest = null;
    let pendingAnalyses = 0;
    let outstandingAnalyses = 0;
    let outstandingAnalysisUrlChars = 0;
    let analysisQueue = [];
    const delayedAnalyses = new Set();
    const activeAnalyses = new Set();
    const analysisRequestsByKey = new Map();
    let analysisPumpRunning = false;
    let analysisPumpTimer = null;
    let observedPageUrl = window === top ? String(location.href || '') : '';
    let pageUrlSignalTimer = null;

    function getURL(path) {
        return runtime && runtime.getURL ? runtime.getURL(path) : path;
    }

    function sendMessage(message, callback) {
        callback = typeof callback === 'function' ? callback : function () { };
        if (!runtime || !runtime.sendMessage) {
            callback(undefined);
            return null;
        }
        let completed = false;
        const finish = value => {
            if (completed)
                return;
            completed = true;
            callback(value);
        };
        if (usePromiseApi) {
            try {
                const promise = runtime.sendMessage(message);
                if (promise && typeof promise.then === 'function')
                    promise.then(finish).catch(() => finish(undefined));
                else
                    finish(undefined);
                return promise;
            } catch (err) {
                finish(undefined);
                return null;
            }
        }
        try {
            return runtime.sendMessage(message, response => {
                if (chromeApi && chromeApi.runtime && chromeApi.runtime.lastError) {
                    finish(undefined);
                    return;
                }
                finish(response);
            });
        } catch (err) {
            finish(undefined);
            return null;
        }
    }

    function addRuntimeListener(listener) {
        if (runtime && runtime.onMessage && runtime.onMessage.addListener)
            runtime.onMessage.addListener(listener);
    }

    function storageGet(area, keys, callback) {
        callback = typeof callback === 'function' ? callback : function () { };
        if (!area || !area.get) {
            callback({}, false);
            return;
        }
        let completed = false;
        const finish = (value, ok) => {
            if (completed)
                return;
            completed = true;
            callback(value || {}, ok !== false);
        };
        const callbackResult = value => {
            if (chromeApi && chromeApi.runtime && chromeApi.runtime.lastError) {
                finish({}, false);
                return;
            }
            finish(value, true);
        };
        try {
            // Invoke the API only once. Promise-capable implementations may also
            // call the callback; finish() safely accepts whichever settles first.
            const maybePromise = area.get(keys, callbackResult);
            if (maybePromise && typeof maybePromise.then === 'function')
                maybePromise.then(value => finish(value, true)).catch(() => finish({}, false));
        } catch (err) {
            // Firefox-style promise APIs reject the callback argument before
            // starting an operation, so a promise-form retry is safe here.
            try {
                const promise = area.get(keys);
                if (promise && typeof promise.then === 'function')
                    promise.then(value => finish(value, true)).catch(() => finish({}, false));
                else
                    finish({}, false);
            } catch (retryError) {
                finish({}, false);
            }
        }
    }

    function localDomain() {
        try { return new URL(location.href).hostname.toLowerCase(); } catch (err) { return ''; }
    }

    function getSettingsFromStorage(callback) {
        storageGet(storageLocal, ['settings', 'urlList', 'allowSafeDomains'], (data, ok) => {
            if (!ok) {
                callback(null);
                return;
            }
            const settings = Shared.normalizeSettings(data && data.settings);
            settings.excluded = Shared.urlMatchesList(location.href, data && data.urlList);
            settings.allowSafeDomain = Shared.domainMatchesList(localDomain(), data && data.allowSafeDomains);
            settings.pausedForTab = false;
            settings.excludedForTab = false;
            callback(settings);
        });
    }

    function setIcon(active) {
        if (window === top)
            sendMessage({ r: 'setColorIcon', toggle: !!active });
    }

    function makeEnvironment() {
        return {
            getURL,
            getShadowRoot: function (element) {
                try {
                    if (extensionDom && typeof extensionDom.openOrClosedShadowRoot === 'function')
                        return extensionDom.openOrClosedShadowRoot(element);
                    if (element && element.openOrClosedShadowRoot)
                        return element.openOrClosedShadowRoot;
                    return element && element.shadowRoot ? element.shadowRoot : null;
                } catch (err) {
                    return element && element.shadowRoot ? element.shadowRoot : null;
                }
            },
            sendMessage,
            analyze: analyzeImage,
            onError: function (error, element) {
                try {
                    console.warn('Wizmage skipped an element after an isolated scan error', error, element);
                } catch (err) { /* ignore logging failures */ }
            }
        };
    }

    function analysisSignature(settings) {
        if (!settings)
            return '';
        return [
            settings.blockTarget || 'all',
            settings.serverUrl || ''
        ].join('\u001f');
    }

    function completeAnalysisRequest(request, result) {
        if (!request || request.completed)
            return;
        request.completed = true;
        request.queued = false;
        if (request.retryTimer != null) {
            clearTimeout(request.retryTimer);
            request.retryTimer = null;
        }
        delayedAnalyses.delete(request);
        if (request.key && analysisRequestsByKey.get(request.key) === request)
            analysisRequestsByKey.delete(request.key);
        outstandingAnalyses = Math.max(0, outstandingAnalyses - 1);
        outstandingAnalysisUrlChars = Math.max(0, outstandingAnalysisUrlChars - request.urlLength);
        const waiters = Array.isArray(request.waiters) ? request.waiters : [];
        const normalizedResult = result == null ? -1 : Number(result);
        request.waiters = null;
        request.imageUrl = null;
        request.signature = null;
        request.key = null;
        request.urlLength = 0;
        for (const waiter of waiters) {
            if (!waiter || waiter.completed)
                continue;
            waiter.completed = true;
            const callback = waiter.callback;
            waiter.callback = null;
            try { callback(normalizedResult); }
            catch (err) { /* A controller generation may have been discarded. */ }
        }
    }

    function cancelAnalysisWaiter(request, waiter) {
        if (!request || request.completed || !waiter || waiter.completed)
            return;
        waiter.completed = true;
        waiter.callback = null;
        const index = request.waiters.indexOf(waiter);
        if (index >= 0)
            request.waiters.splice(index, 1);
        if (request.waiters.length)
            return;
        if (request.active && request.cancel)
            request.cancel();
        else {
            completeAnalysisRequest(request, -1);
            pumpAnalysisQueue();
        }
    }

    function makeAnalysisWaiter(request, callback) {
        const waiter = { callback, completed: false };
        request.waiters.push(waiter);
        return () => cancelAnalysisWaiter(request, waiter);
    }

    function enqueueAnalysisRequest(request, delay) {
        if (!request || request.completed)
            return;
        if (delay > 0) {
            delayedAnalyses.add(request);
            request.retryTimer = setTimeout(() => {
                request.retryTimer = null;
                delayedAnalyses.delete(request);
                if (request.completed)
                    return;
                request.queued = true;
                analysisQueue.push(request);
                pumpAnalysisQueue();
            }, delay);
            return;
        }
        request.queued = true;
        analysisQueue.push(request);
        pumpAnalysisQueue();
    }

    function dispatchAnalysisRequest(request) {
        request.queued = false;
        request.active = true;
        activeAnalyses.add(request);
        pendingAnalyses++;
        let finished = false;
        const finish = (result, canceled) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timeout);
            request.active = false;
            request.cancel = null;
            activeAnalyses.delete(request);
            pendingAnalyses = Math.max(0, pendingAnalyses - 1);
            result = result == null ? -1 : Number(result);
            if (!Number.isFinite(result))
                result = -1;
            if (!canceled && result === -2
                && request.backpressureRetries < MAX_BACKPRESSURE_RETRIES
                && request.signature === analysisSignature(effectiveSettings)) {
                request.backpressureRetries++;
                const delay = Math.min(1500, 100 * Math.pow(2, Math.min(4, request.backpressureRetries - 1)));
                enqueueAnalysisRequest(request, delay);
            }
            else {
                completeAnalysisRequest(request, result === -2 ? -1 : result);
            }
            pumpAnalysisQueue();
        };
        const timeout = setTimeout(() => finish(-1), ANALYSIS_TIMEOUT_MS);
        request.cancel = () => finish(-1, true);
        sendMessage({
            r: 'getAnalyzeResponse',
            imgUrl: request.imageUrl,
            pageUrl: String(location.href || '').slice(0, MAX_PAGE_URL_CHARS)
        }, finish);
    }

    function scheduleAnalysisPump() {
        if (analysisPumpTimer != null)
            return;
        analysisPumpTimer = setTimeout(() => {
            analysisPumpTimer = null;
            pumpAnalysisQueue();
        }, 0);
    }

    function pumpAnalysisQueue() {
        if (analysisPumpRunning) {
            scheduleAnalysisPump();
            return;
        }
        analysisPumpRunning = true;
        let processed = 0;
        try {
            while (pendingAnalyses < MAX_FRAME_ANALYSES
                && analysisQueue.length
                && processed < MAX_FRAME_ANALYSES) {
                processed++;
                const request = analysisQueue.shift();
                if (!request || request.completed)
                    continue;
                request.queued = false;
                if (request.signature !== analysisSignature(effectiveSettings)) {
                    completeAnalysisRequest(request, -1);
                    continue;
                }
                dispatchAnalysisRequest(request);
            }
        } finally {
            analysisPumpRunning = false;
        }
        if (pendingAnalyses < MAX_FRAME_ANALYSES && analysisQueue.length)
            scheduleAnalysisPump();
    }

    function cancelAnalysisRequests(signatureToKeep) {
        const keep = [];
        for (const request of analysisQueue) {
            if (request && !request.completed && signatureToKeep && request.signature === signatureToKeep)
                keep.push(request);
            else
                completeAnalysisRequest(request, -1);
        }
        analysisQueue = keep;
        for (const request of Array.from(delayedAnalyses)) {
            if (signatureToKeep && request.signature === signatureToKeep)
                continue;
            completeAnalysisRequest(request, -1);
        }
        for (const request of Array.from(activeAnalyses)) {
            if (signatureToKeep && request.signature === signatureToKeep)
                continue;
            if (request.cancel)
                request.cancel();
        }
        pumpAnalysisQueue();
    }

    function analyzeImage(imageUrl, callback) {
        callback = typeof callback === 'function' ? callback : function () { };
        imageUrl = String(imageUrl || '');
        if (!Shared.isRemoteImageCandidate(imageUrl, MAX_ANALYSIS_URL_CHARS, MAX_NETWORK_URL_CHARS)) {
            callback(-1);
            return;
        }
        if (!effectiveSettings || effectiveSettings.blockTarget === 'all') {
            callback(1);
            return;
        }
        if (!runtime || !runtime.sendMessage) {
            callback(-1);
            return;
        }
        const signature = analysisSignature(effectiveSettings);
        const key = signature + '\u001e' + imageUrl;
        const existingRequest = analysisRequestsByKey.get(key);
        if (existingRequest && !existingRequest.completed) {
            if (existingRequest.waiters.length >= MAX_ANALYSIS_WAITERS) {
                callback(-1);
                return null;
            }
            return makeAnalysisWaiter(existingRequest, callback);
        }
        if (outstandingAnalyses >= MAX_FRAME_ANALYSIS_REQUESTS
            || outstandingAnalysisUrlChars + imageUrl.length > MAX_FRAME_ANALYSIS_URL_CHARS) {
            callback(-1);
            return;
        }
        const request = {
            imageUrl,
            urlLength: imageUrl.length,
            waiters: [],
            signature,
            key,
            backpressureRetries: 0,
            retryTimer: null,
            queued: false,
            active: false,
            completed: false
        };
        analysisRequestsByKey.set(key, request);
        outstandingAnalyses++;
        outstandingAnalysisUrlChars += request.urlLength;
        const cancel = makeAnalysisWaiter(request, callback);
        enqueueAnalysisRequest(request, 0);
        return cancel;
    }

    function applyEffectiveSettings(rawSettings) {
        const previousSignature = analysisSignature(effectiveSettings);
        const next = Shared.normalizeSettings(rawSettings);
        effectiveSettings = next;
        const nextSignature = analysisSignature(next);
        const analysisDecisionChanged = !!previousSignature && previousSignature !== nextSignature;
        const shouldRun = Shared.isFilteringActive(next) && !manualShow;
        if (!shouldRun) {
            if (controller) {
                controller.destroy({ show: true });
                controller = null;
            }
            cancelAnalysisRequests();
            releaseMediaGate();
            setIcon(false);
            return false;
        }
        if (controller) {
            controller.updateSettings(next);
        }
        else {
            prepareFilteringRoot();
            controller = new Controller(window, next, makeEnvironment());
            controller.start();
        }
        if (analysisDecisionChanged)
            cancelAnalysisRequests(nextSignature);
        setIcon(true);
        return true;
    }

    function requestEffectiveSettings(callback, pageUrlHint) {
        const requiresAuthority = !hasAuthoritativeSettings;
        const coldStart = requiresAuthority && !controller && !manualShow;
        const hasWorker = !!(runtime && runtime.sendMessage);
        if (requiresAuthority && hasWorker)
            holdMediaAuthorityGate();
        if (coldStart) {
            const gate = globalThis.WizmageMediaGate;
            if (gate && typeof gate.claim === 'function')
                gate.claim();
            else if (document.documentElement)
                document.documentElement.classList.add('wizmage-media-starting');
            prepareFilteringRoot();
        }
        if (cancelSettingsRequest)
            cancelSettingsRequest();
        const revision = ++settingsRequestRevision;
        let callbackSent = false;
        let workerFinished = !hasWorker;
        let localFinished = false;
        let workerApplied = false;
        let fallbackTimer = null;
        const respond = (ok, active) => {
            if (!callback || callbackSent)
                return;
            callbackSent = true;
            callback(!!ok, !!active);
        };
        const failOpen = () => {
            if (revision !== settingsRequestRevision)
                return;
            if (controller) {
                try { controller.destroy({ show: true }); }
                catch (error) { releaseMediaGate(); }
                controller = null;
            }
            cancelAnalysisRequests();
            effectiveSettings = null;
            hasAuthoritativeSettings = false;
            releaseMediaGate();
            setIcon(false);
            // A delayed worker may still provide authoritative settings. The
            // response channel is completed now so callers can never hang.
            respond(true, false);
        };
        cancelSettingsRequest = () => {
            if (fallbackTimer)
                clearTimeout(fallbackTimer);
            respond(false, false);
        };
        const applyIfCurrent = (settings, authoritative) => {
            if (revision !== settingsRequestRevision
                || !settings
                || typeof settings !== 'object'
                || settings.ok === false)
                return false;
            if (authoritative && fallbackTimer)
                clearTimeout(fallbackTimer);
            let active;
            try {
                active = applyEffectiveSettings(settings);
            } catch (error) {
                try { console.error('Wizmage failed open while applying settings', error); } catch (logError) { /* ignore */ }
                failOpen();
                if (cancelSettingsRequest)
                    cancelSettingsRequest = null;
                return true;
            }
            if (authoritative)
                workerApplied = true;
            if (authoritative) {
                hasAuthoritativeSettings = true;
                releaseMediaAuthorityGate();
            }
            if (authoritative && cancelSettingsRequest)
                cancelSettingsRequest = null;
            if (authoritative)
                respond(true, active);
            return true;
        };
        const preserveKnownState = () => {
            if (fallbackTimer)
                clearTimeout(fallbackTimer);
            if (cancelSettingsRequest)
                cancelSettingsRequest = null;
            respond(true, !!controller);
        };
        const failIfResolved = () => {
            if (revision !== settingsRequestRevision || workerApplied || !workerFinished || !localFinished)
                return;
            if (requiresAuthority)
                failOpen();
            else
                preserveKnownState();
        };
        fallbackTimer = setTimeout(() => {
            if (revision !== settingsRequestRevision || workerApplied)
                return;
            if (requiresAuthority)
                failOpen();
            else
                preserveKnownState();
        }, SETTINGS_FAIL_OPEN_MS);
        if (hasWorker) {
            const message = { r: 'getSettings' };
            if (typeof pageUrlHint === 'string' && pageUrlHint)
                message.pageUrl = pageUrlHint.slice(0, MAX_PAGE_URL_CHARS);
            sendMessage(message, settings => {
                workerFinished = true;
                if (revision !== settingsRequestRevision)
                    return;
                applyIfCurrent(settings, true);
                failIfResolved();
            });
        }
        getSettingsFromStorage(settings => {
            localFinished = true;
            if (revision !== settingsRequestRevision)
                return;
            if (!hasWorker) {
                applyIfCurrent(settings, true);
            }
            else if (coldStart && !workerApplied && settings) {
                // Local storage can start an active cold page before a sleeping
                // MV3 worker wakes. It cannot establish tab-scoped pause or
                // exclusion state, so inactive local settings keep the gate in
                // place and every provisional result retains the authority
                // deadline until the worker reconciles it.
                const provisional = Shared.normalizeSettings(settings);
                if (Shared.isFilteringActive(provisional))
                    applyIfCurrent(provisional, false);
            }
            failIfResolved();
        });
    }

    function showAllImages() {
        if (controller && typeof controller.showCurrentImages === 'function'
            && controller.showCurrentImages()) {
            manualShow = false;
            cancelAnalysisRequests();
            releaseMediaGate();
            setIcon(true);
            return;
        }
        manualShow = true;
        if (controller)
            controller.destroy({ show: true });
        controller = null;
        cancelAnalysisRequests();
        releaseMediaGate();
        setIcon(false);
    }

    function restartFiltering(callback) {
        manualShow = false;
        requestEffectiveSettings((ok, active) => {
            if (callback)
                callback({ ok: !!ok, active: !!active });
        });
    }

    function refreshFiltering(callback, pageUrlHint) {
        manualShow = false;
        requestEffectiveSettings((ok, active) => {
            if (callback)
                callback({ ok: !!ok, active: !!active });
        }, pageUrlHint);
    }

    function signalPageUrlChange() {
        if (window !== top)
            return;
        const pageUrl = String(location.href || '');
        if (!pageUrl || pageUrl === observedPageUrl)
            return;
        observedPageUrl = pageUrl;
        sendMessage({ r: 'pageUrlChanged', url: pageUrl.slice(0, MAX_PAGE_URL_CHARS) });
    }

    function schedulePageUrlCheck() {
        if (pageUrlSignalTimer != null)
            return;
        pageUrlSignalTimer = setTimeout(() => {
            pageUrlSignalTimer = null;
            signalPageUrlChange();
        }, 0);
    }

    function installPageUrlListeners() {
        if (window !== top)
            return;
        window.addEventListener('popstate', schedulePageUrlCheck, true);
        window.addEventListener('hashchange', schedulePageUrlCheck, true);
        window.addEventListener('pageshow', schedulePageUrlCheck, true);
        try {
            if (window.navigation && window.navigation.addEventListener)
                window.navigation.addEventListener('currententrychange', schedulePageUrlCheck);
        } catch (err) { /* Navigation API is optional. */ }
    }

    addRuntimeListener(function (request, sender, sendResponse) {
        if (!request || typeof request.r !== 'string')
            return;
        switch (request.r) {
            case 'showImages':
                showAllImages();
                if (sendResponse) sendResponse({ ok: true });
                return;
            case 'restart':
                restartFiltering(sendResponse);
                return true;
            case 'refreshSettings':
                if (window === top && typeof request.pageUrl === 'string' && request.pageUrl)
                    observedPageUrl = request.pageUrl;
                refreshFiltering(sendResponse, request.pageUrl);
                return true;
            case 'allowSafeForDomain':
                if (controller)
                    controller.setAllowSafeDomain(!!request.toggle);
                if (effectiveSettings)
                    effectiveSettings.allowSafeDomain = !!request.toggle;
                if (sendResponse) sendResponse({ ok: true });
                return;
        }
    });

    try {
        prepareFilteringRoot();
        installPageUrlListeners();
        requestEffectiveSettings();
    } catch (error) {
        releaseMediaGate();
        try { console.error('Wizmage failed open during startup', error); } catch (err) { /* ignore */ }
    }
})();
