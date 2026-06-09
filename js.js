//global variables
var wzmBrowser = typeof browser !== 'undefined' ? browser : null;
var wzmChrome = typeof chrome !== 'undefined' ? chrome : null;
var wzmRuntime = (wzmChrome && wzmChrome.runtime) || (wzmBrowser && wzmBrowser.runtime) || null;
var wzmUsePromiseApi = !!wzmBrowser && (!wzmChrome || wzmChrome === wzmBrowser);
var wzmStorageLocal = (wzmChrome && wzmChrome.storage && wzmChrome.storage.local) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.local) || null;
var wzmUserAgent = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
var wzmIsSafari = /Safari/i.test(wzmUserAgent) && !/(Chrome|Chromium|Edg|OPR|Brave)/i.test(wzmUserAgent);
var wzmIsIOS = /iP(hone|ad|od)/i.test(wzmUserAgent) || (wzmUserAgent.indexOf('Mac') > -1 && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
function wzmSendMessage(message, callback) {
    if (!wzmRuntime || !wzmRuntime.sendMessage) {
        if (callback) callback();
        return;
    }
    if (wzmUsePromiseApi) {
        try {
            var p = wzmRuntime.sendMessage(message);
            if (callback) p.then(callback).catch(function () { callback(); });
            return p;
        }
        catch (err) {
            if (callback) callback();
            return;
        }
    }
    try {
        return wzmRuntime.sendMessage(message, callback);
    }
    catch (err) {
        if (callback) callback();
    }
}
function wzmAddRuntimeListener(listener) {
    if (wzmRuntime && wzmRuntime.onMessage && wzmRuntime.onMessage.addListener) {
        wzmRuntime.onMessage.addListener(listener);
    }
}
function wzmGetURL(path) {
    return (wzmRuntime && wzmRuntime.getURL) ? wzmRuntime.getURL(path) : path;
}
function wzmStorageGet(area, keys, callback) {
    if (!area || !area.get) {
        if (callback) callback({});
        return;
    }
    try {
        var maybePromise = area.get(keys);
        if (maybePromise && typeof maybePromise.then === 'function') {
            if (callback) maybePromise.then(callback).catch(function () { callback({}); });
            return maybePromise;
        }
    } catch (err) {
        // fall through
    }
    try {
        return area.get(keys, callback);
    } catch (err) {
        if (callback) callback({});
    }
}
function wzmStorageGetLocal(keys, callback) {
    return wzmStorageGet(wzmStorageLocal, keys, callback);
}
function wzmStorageSetLocal(items) {
    if (!wzmStorageLocal || !wzmStorageLocal.set)
        return;
    try {
        var maybePromise = wzmStorageLocal.set(items);
        if (maybePromise && typeof maybePromise.then === 'function')
            return maybePromise;
    } catch (err) {
        // fall through
    }
    try {
        return wzmStorageLocal.set(items);
    } catch (err) {
        // ignore
    }
}
function wzmShouldKeepAlive() {
    return !wzmIsSafari && !wzmIsIOS && !!wzmRuntime && !!wzmRuntime.connect;
}
function wzmKeepAlive() {
    if (!wzmShouldKeepAlive())
        return;
    try {
        let port = wzmRuntime.connect({ name: 'wzm-keepalive' });
        if (port && port.onDisconnect) {
            port.onDisconnect.addListener(() => {
                if (wzmShouldKeepAlive())
                    setTimeout(wzmKeepAlive, 1000);
            });
        }
    } catch (err) {
        // ignore
    }
}
wzmKeepAlive();
const WZM_DEFAULT_SERVER_URL = 'wss://aiserver.wizmage.com:5002/ws';
let wzmWsGlobal = null;
let wzmWsReqId = 0;
let wzmWsQueue = null;
let wzmWsFlushTimer = null;
const wzmWsCache = new Map();
const wzmWsPending = new Map();
function wzmHash64(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = (h1 ^ ch) * 16777619;
        h1 |= 0;
        h2 = (h2 ^ ch) * 16777619;
        h2 |= 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function wzmMapAnalyzeResult(result, blockTarget) {
    if (result === -1) return -1;
    if (blockTarget === 'men') return (result === 1 || result === 3) ? 1 : 0;
    if (blockTarget === 'women') return (result === 2 || result === 3) ? 1 : 0;
    if (blockTarget === 'people') return (result !== 0) ? 1 : 0;
    return 1;
}
function wzmEnsureWebSocket() {
    if (typeof WebSocket === 'undefined')
        return null;
    if (!settings)
        return null;
    let serverUrl = settings.serverUrl || WZM_DEFAULT_SERVER_URL;
    let ws = wzmWsGlobal;
    if (ws && ws.url !== serverUrl) {
        try { ws.close(); } catch (err) { /* ignore */ }
        ws = null;
        wzmWsGlobal = null;
    }
    if (!ws || ws.readyState == WebSocket.CLOSING || ws.readyState == WebSocket.CLOSED || (ws.lastMsg && Date.now() - ws.lastMsg > 1000 * 40)) {
        try {
            ws = new WebSocket(serverUrl);
        } catch (err) {
            return null;
        }
        ws.url = serverUrl;
        ws.openPromise = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.onmessage = ev => {
            let d;
            try { d = JSON.parse(ev.data); } catch (err) { return; }
            if (d.pong) return;
            if (!Array.isArray(d.results)) return;
            for (let r of d.results) {
                let req = ws.pendingReqs.get(r.id);
                if (!req) continue;
                ws.pendingReqs.delete(r.id);
                let result = typeof r.result === 'number' ? r.result : -1;
                wzmWsCache.set(req.cacheKey, result);
                let waiters = wzmWsPending.get(req.cacheKey);
                wzmWsPending.delete(req.cacheKey);
                if (waiters) {
                    for (let waiter of waiters)
                        waiter.callback(wzmMapAnalyzeResult(result, waiter.blockTarget));
                }
            }
            ws.lastMsg = Date.now();
        };
        ws.onclose = () => {
            for (let req of ws.pendingReqs.values()) {
                let waiters = wzmWsPending.get(req.cacheKey);
                wzmWsPending.delete(req.cacheKey);
                if (waiters) {
                    for (let waiter of waiters)
                        waiter.callback(-1);
                }
            }
            ws.pendingReqs.clear();
        };
        ws.pendingReqs = new Map();
        wzmWsGlobal = ws;
    }
    return ws;
}
function wzmQueueAnalyzeRequest(req) {
    if (!wzmWsQueue) wzmWsQueue = [];
    wzmWsQueue.push(req);
    if (wzmWsQueue.length >= 32)
        wzmFlushAnalyzeQueue();
    else if (!wzmWsFlushTimer)
        wzmWsFlushTimer = setTimeout(wzmFlushAnalyzeQueue, 50);
}
async function wzmFlushAnalyzeQueue() {
    if (wzmWsFlushTimer) {
        clearTimeout(wzmWsFlushTimer);
        wzmWsFlushTimer = null;
    }
    let queue = wzmWsQueue;
    wzmWsQueue = null;
    if (!queue || !queue.length) return;
    let ws = wzmEnsureWebSocket();
    if (!ws) {
        wzmFailAnalyzeRequests(queue);
        return;
    }
    try { await ws.openPromise; } catch (err) { wzmFailAnalyzeRequests(queue); return; }
    if (ws.readyState !== WebSocket.OPEN) {
        wzmFailAnalyzeRequests(queue);
        return;
    }
    try {
        ws.send(JSON.stringify({ requests: queue.map(q => ({ id: q.id, url: q.url, pageUrl: q.pageUrl })) }));
    } catch (err) {
        wzmFailAnalyzeRequests(queue);
        return;
    }
    for (let req of queue)
        ws.pendingReqs.set(req.id, req);
}
function wzmFailAnalyzeRequests(queue) {
    for (let req of queue) {
        let waiters = wzmWsPending.get(req.cacheKey);
        wzmWsPending.delete(req.cacheKey);
        if (waiters) {
            for (let waiter of waiters)
                waiter.callback(-1);
        }
    }
}
function wzmAnalyzeViaWebSocket(imgUrl, callback) {
    if (!imgUrl || !callback) {
        if (callback) callback(-1);
        return;
    }
    let blockTarget = (settings && settings.blockTarget) || 'all';
    if (blockTarget === 'all') {
        callback(1);
        return;
    }
    let cacheKey = imgUrl.startsWith('data:') ? ('data:' + wzmHash64(imgUrl)) : imgUrl;
    if (wzmWsCache.has(cacheKey)) {
        callback(wzmMapAnalyzeResult(wzmWsCache.get(cacheKey), blockTarget));
        return;
    }
    let waiters = wzmWsPending.get(cacheKey);
    if (waiters) {
        waiters.push({ callback, blockTarget });
        return;
    }
    wzmWsPending.set(cacheKey, [{ callback, blockTarget }]);
    wzmQueueAnalyzeRequest({ id: ++wzmWsReqId, url: imgUrl, pageUrl: location.href, cacheKey });
}
function wzmAnalyzeImage(imgUrl, callback) {
    if (!callback)
        callback = function () { };
    if (!imgUrl) {
        callback(-1);
        return;
    }
    if (settings && (!settings.blockTarget || settings.blockTarget === 'all')) {
        callback(1);
        return;
    }
    if (wzmIsSafari || !wzmRuntime || !wzmRuntime.sendMessage) {
        wzmAnalyzeViaWebSocket(imgUrl, callback);
        return;
    }
    let responded = false;
    let timer = setTimeout(function () {
        if (responded)
            return;
        responded = true;
        wzmAnalyzeViaWebSocket(imgUrl, callback);
    }, 1200);
    wzmSendMessage({ r: "getAnalyzeResponse", imgUrl, pageUrl: location.href }, (r) => {
        if (responded)
            return;
        responded = true;
        clearTimeout(timer);
        if (r == undefined || r == null)
            wzmAnalyzeViaWebSocket(imgUrl, callback);
        else
            callback(r);
    });
}
let showAll = false, extensionUrl = wzmGetURL(''), blankImg = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', urlBlankImg = 'url("' + blankImg + '")', eyeCSSUrl = 'url(' + extensionUrl + "eye.svg" + ')', undoCSSUrl = 'url(' + extensionUrl + "undo.png" + ')', tagList = ['IMG', 'DIV', 'SPAN', 'A', 'UL', 'LI', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'I', 'STRONG', 'B', 'BIG', 'BUTTON', 'CENTER', 'SECTION', 'TABLE', 'FIGURE', 'ASIDE', 'HEADER', 'VIDEO', 'P', 'ARTICLE', 'PICTURE', 'BA-IMAGE'], tagListCSS = tagList.join(), iframes = [], contentLoaded = false, settings, quotesRegex = /['"]/g;
function wzmApplyPatternAssetVars(doc) {
    if (!doc || !doc.documentElement || !doc.documentElement.style)
        return;
    let style = doc.documentElement.style;
    for (let i = 0; i < 8; i++) {
        style.setProperty('--wzm-pattern-' + i, 'url("' + wzmGetURL('pattern' + i + '.png') + '")');
        style.setProperty('--wzm-pattern-light-' + i, 'url("' + wzmGetURL('pattern-light' + i + '.png') + '")');
    }
}
//keep track of contentLoaded
window.addEventListener('DOMContentLoaded', function () { contentLoaded = true; });
//start by seeing if is active or is paused etc.
let settingsResolved = false;
let settingsApplied = false;
let settingsFallback = setTimeout(function () {
    if (!settingsResolved && document.documentElement)
        AddClass(document.documentElement, 'wizmage-show-html');
}, 1500);
function wzmDefaultSettings() {
    return {
        paused: false,
        noEye: false,
        noPattern: false,
        blackList: false,
        closeOnClick: false,
        maxSafe: 32,
        alwaysBlock: false,
        blockTarget: 'all'
    };
}
function wzmLegacyUnwantedToBlockTarget(unwanted) {
    let value = (unwanted || '').toLowerCase().trim();
    if (!value)
        return 'all';
    if (value == 'women' || value == 'woman' || value == 'a woman' || value == 'female' || value == 'females')
        return 'women';
    if (value == 'men' || value == 'man' || value == 'a man' || value == 'male' || value == 'males')
        return 'men';
    if (value == 'people' || value == 'person' || value == 'a person' || value == 'crowd' || value == 'a crowd' || value == 'crowd of people')
        return 'people';
    return 'all';
}
function wzmNormalizeSettings(s) {
    s = Object.assign(wzmDefaultSettings(), (s && typeof s === 'object') ? s : {});
    if (!s.blockTarget)
        s.blockTarget = wzmLegacyUnwantedToBlockTarget(s.unwanted);
    if (['all', 'men', 'women', 'people'].indexOf(s.blockTarget) === -1)
        s.blockTarget = 'all';
    s.maxSafe = +s.maxSafe || 32;
    if (s.maxSafe < 1 || s.maxSafe > 1000)
        s.maxSafe = 32;
    return s;
}
function wzmLocalDomain() {
    return (typeof location !== 'undefined' && location.host) ? location.host.toLowerCase() : '';
}
function wzmUrlMatchesList(url, list) {
    let lowerUrl = (url || '').toLowerCase();
    for (let i = 0; i < list.length; i++) {
        let entry = (list[i] || '').toLowerCase();
        if (entry && lowerUrl.indexOf(entry) != -1)
            return true;
    }
    return false;
}
function wzmDomainMatchesList(domain, list) {
    domain = (domain || '').toLowerCase();
    for (let i = 0; i < list.length; i++) {
        let entry = (list[i] || '').toLowerCase();
        if (entry && domain.indexOf(entry) !== -1)
            return true;
    }
    return false;
}
function wzmGetEffectiveSettingsFromStorage(callback) {
    wzmStorageGetLocal(['settings', 'urlList', 'allowSafeDomains'], function (data) {
        let s = wzmNormalizeSettings(data && data.settings);
        let urlList = (data && Array.isArray(data.urlList)) ? data.urlList : [];
        let allowSafeDomains = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
        let domain = wzmLocalDomain();
        s.excluded = wzmUrlMatchesList(location.href, urlList);
        s.allowSafeDomain = wzmDomainMatchesList(domain, allowSafeDomains);
        s.pausedForTab = false;
        s.excludedForTab = false;
        if (callback)
            callback(s);
    });
}
function applySettingsAndStart(s) {
    if (settingsApplied)
        return;
    settingsApplied = true;
    settingsResolved = true;
    clearTimeout(settingsFallback);
    settings = wzmNormalizeSettings(s);
    //if is active - go
    if (settings
        && ((!settings.blackList && !settings.excluded && !settings.excludedForTab)
            || (settings.blackList && (settings.excluded || settings.excludedForTab)))
        && !settings.paused && !settings.pausedForTab) {
        //change icon
        wzmSendMessage({ r: 'setColorIcon', toggle: true });
        //do main window
        DoWin(window, contentLoaded);
    }
    else {
        if (!document.documentElement)
            return;
        AddClass(document.documentElement, 'wizmage-show-html');
        let observer = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                let m = mutations[i];
                if (m.type == 'attributes') {
                    let el = m.target;
                    if (el == document.documentElement && m.attributeName == 'class') {
                        if (el.className.indexOf('wizmage-show-html') == -1)
                            AddClass(el, 'wizmage-show-html');
                    }
                }
                else if (m.addedNodes != null && m.addedNodes.length > 0) {
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        let el = m.addedNodes[j];
                        if (el == document.documentElement)
                            AddClass(el, 'wizmage-show-html wizmage-running');
                    }
                }
            }
        });
        observer.observe(document.documentElement, { attributes: true });
        observer.observe(document, { subtree: true, childList: true });
    }
}
function loadSettingsFromStorage() {
    wzmGetEffectiveSettingsFromStorage(applySettingsAndStart);
}
if (!wzmRuntime || !wzmRuntime.sendMessage || wzmIsSafari) {
    loadSettingsFromStorage();
}
else {
    let responded = false;
    wzmSendMessage({ r: 'getSettings' }, function (s) {
        responded = true;
        if (s && typeof s === 'object')
            applySettingsAndStart(s);
        else
            loadSettingsFromStorage();
    });
    setTimeout(function () {
        if (!responded)
            loadSettingsFromStorage();
    }, 800);
}
//catch 'Show Images' option from browser actions
wzmAddRuntimeListener(function (request, sender, sendResponse) {
    if (request.r == 'showImages')
        ShowImages();
    else if (request.r == 'restart') {
        let ok = false;
        try {
            ok = RestartImages();
        } catch (err) { }
        if (sendResponse)
            sendResponse({ ok: !!ok });
        return;
    }
    else if (request.r == 'refreshSettings') {
        RefreshSettings(function (ok) {
            if (sendResponse)
                sendResponse({ ok: !!ok });
        });
        return true;
    }
    else if (request.r == 'allowSafeForDomain') {
        let ok = false;
        try {
            if (window.wzmSetAllowSafeDomain) {
                window.wzmSetAllowSafeDomain(!!request.toggle);
                ok = true;
            }
        } catch (err) { }
        if (sendResponse)
            sendResponse({ ok: !!ok });
        return;
    }
});
function isImg(el) { return el.tagName == 'IMG'; }
function ShowImages() {
    if (showAll)
        return;
    showAll = true;
    if (window == top)
        wzmSendMessage({ r: 'setColorIcon', toggle: false });
    if (window.wzmShowImages)
        window.wzmShowImages();
    else if (document.documentElement)
        AddClass(document.documentElement, 'wizmage-show-html');
    for (let i = 0, max = iframes.length; i < max; i++) {
        let iframe = iframes[i];
        try {
            if (iframe.contentWindow && iframe.contentWindow.wzmShowImages)
                iframe.contentWindow.wzmShowImages();
        }
        catch (err) { /*iframe may have been rewritten*/ }
    }
}
function RestartImages() {
    if (window == top)
        wzmSendMessage({ r: 'setColorIcon', toggle: true });
    let restarted = false;
    if (window.wzmRestart) {
        window.wzmRestart();
        restarted = true;
    }
    for (let i = 0, max = iframes.length; i < max; i++) {
        let iframe = iframes[i];
        try {
            if (iframe.contentWindow && iframe.contentWindow.wzmRestart) {
                iframe.contentWindow.wzmRestart();
                restarted = true;
            }
        }
        catch (err) { /*iframe may have been rewritten*/ }
    }
    return restarted;
}
function RefreshSettings(callback) {
    let applySettings = function (s) {
        if (!s || typeof s !== 'object') {
            if (callback) callback(false);
            return;
        }
        let updated = false;
        settings = wzmNormalizeSettings(s);
        if (window.wzmUpdateSettings) {
            window.wzmUpdateSettings(settings);
            updated = true;
        }
        for (let i = 0, max = iframes.length; i < max; i++) {
            let iframe = iframes[i];
            try {
                if (iframe.contentWindow && iframe.contentWindow.wzmUpdateSettings) {
                    iframe.contentWindow.wzmUpdateSettings(settings);
                    updated = true;
                }
            }
            catch (err) { /*iframe may have been rewritten*/ }
        }
        if (callback) callback(updated);
    };
    if (!wzmRuntime || !wzmRuntime.sendMessage || wzmIsSafari) {
        wzmGetEffectiveSettingsFromStorage(applySettings);
        return;
    }
    let responded = false;
    wzmSendMessage({ r: 'getSettings' }, function (s) {
        responded = true;
        if (s && typeof s === 'object')
            applySettings(s);
        else
            wzmGetEffectiveSettingsFromStorage(applySettings);
    });
    setTimeout(function () {
        if (!responded)
            wzmGetEffectiveSettingsFromStorage(applySettings);
    }, 400);
}
function DoWin(win, winContentLoaded) {
    let _settings = settings, //DoWin is only called after settings is set
    doc = win.document, observers = [], eye = doc.createElement('div'), mouseMoved = false, mouseEvent, mouseOverEl, elList = [], hasStarted = false,
    lastTapShownEl, lastTapEyeEl, longPressMoveThreshold = 10, rehideTapWindow = 1000,
    allowSafeDomain = _settings.alwaysBlock ? !!_settings.allowSafeDomain : false,
    twoFingerTapState = 0, twoFingerTapPossible = false, twoFingerTapMoved = false, twoFingerStartX = 0, twoFingerStartY = 0,
    showSafeImagesForPage = (_settings.alwaysBlock && allowSafeDomain),
    lifecycleRescanIX = 0, intervalsStarted = false;
    //global show images
    win.wzmShowImages = function () {
        if (hasStarted) {
            doc.removeEventListener('keydown', DocKeyDown);
            doc.removeEventListener('mousemove', DocMouseMove);
            doc.removeEventListener('visibilitychange', DocVisibilityChange);
            win.removeEventListener('scroll', WindowScroll);
            win.removeEventListener('focus', WindowFocus);
            win.removeEventListener('pageshow', WindowPageShow);
            if (wzmIsIOS) {
                doc.removeEventListener('touchstart', DocTouchStart, true);
                doc.removeEventListener('touchmove', DocTouchMove, true);
                doc.removeEventListener('touchend', DocTouchEnd, true);
                doc.removeEventListener('touchcancel', DocTouchCancel, true);
            }
            for (let i = 0, max = elList.length; i < max; i++)
                ShowEl.call(elList[i]);
            win.removeEventListener('DOMContentLoaded', Start);
            if (mouseOverEl) {
                DoHover(mouseOverEl, false);
                mouseOverEl = undefined;
            }
            for (let i = 0, bodyChildren = doc.body.children; i < bodyChildren.length; i++) //for some reason, sometimes the eye is removed before
                if (bodyChildren[i] == eye)
                    doc.body.removeChild(eye);
            for (let obs of observers)
                obs.disconnect();
            observers.length = 0;
            RemoveClass(doc.documentElement, 'wizmage-running');
            hasStarted = false;
        }
        else
            AddClass(doc.documentElement, 'wizmage-show-html');
    };
    win.wzmRestart = function () {
        if (hasStarted)
            return;
        showAll = false;
        if (!doc.body || !doc.head || !doc.documentElement)
            return;
        for (let i = 0, max = elList.length; i < max; i++) {
            let el = elList[i];
            if (!el)
                continue;
            el.wzmAllowSrc = null;
            el.wzmChecking = false;
            el.wzmTapState = 0;
            el.wzmLastShownAt = 0;
            el.wzmConsumeClickUntil = 0;
        }
        Start();
    };
    //start, or register start
    if (winContentLoaded)
        Start();
    else
        win.addEventListener('DOMContentLoaded', Start);
    function DocKeyDown(e) {
        if (e.altKey && e.keyCode == 80 && !_settings.paused) { //ALT-p
            _settings.paused = true;
            wzmSendMessage({ r: 'pause', toggle: true });
            ShowImages();
        }
        else if (mouseOverEl && e.altKey) {
            if (e.keyCode == 65 && mouseOverEl.wzmWizmaged) { //ALT-a
                ShowEl.call(mouseOverEl);
                eye.style.display = 'none';
            }
            else if (e.keyCode == 90 && !mouseOverEl.wzmWizmaged) { //ALT-z
                mouseOverEl.wzmAllowSrc = null;
                DoElement.call(mouseOverEl);
                eye.style.display = 'none';
            }
        }
    }
    function DocMouseMove(e) { mouseEvent = e; mouseMoved = true; }
    let windowScrollIX = 0;
    function WindowScroll() {
        let _windowScrollIX = ++windowScrollIX;
        if (mouseOverEl)
            DoHoverVisual(mouseOverEl, false);
        setTimeout(function () {
            if (_windowScrollIX != windowScrollIX)
                return;
            windowScrollIX = 0; //Signal no pending scroll callbacks. CheckMousePosition doesn't run during scroll to avoid showing eye in wrong place.
            mouseMoved = true;
            UpdateElRects();
            CheckMousePosition();
            if (lastTapEyeEl && lastTapEyeEl.wzmTapState === 1)
                ShowEyeCentered(lastTapEyeEl);
        }, 200);
    }
    function WindowFocus() {
        ScheduleLifecycleRescan();
    }
    function WindowPageShow() {
        ScheduleLifecycleRescan();
    }
    function DocVisibilityChange() {
        if (!doc.hidden)
            ScheduleLifecycleRescan();
    }
    function ScheduleLifecycleRescan() {
        if (showAll || !hasStarted)
            return;
        let thisRescanIX = ++lifecycleRescanIX;
        for (let to of [0, 75, 250, 750, 1500]) {
            setTimeout(function () {
                if (thisRescanIX != lifecycleRescanIX)
                    return;
                RecoverLifecycleImages();
            }, to);
        }
    }
    function RecoverLifecycleImages() {
        if (showAll || !hasStarted || !doc.body || !doc.documentElement)
            return;
        AddClassOnce(doc.documentElement, 'wizmage-running');
        wzmApplyPatternAssetVars(doc);
        RehideBlockedElements();
        RescanElements();
        UpdateElRects();
        AddClassOnce(doc.documentElement, 'wizmage-show-html');
    }
    //keep track of which image-element mouse if over
    function mouseEntered(e) {
        DoHover(this, true, e);
        e.stopPropagation();
    }
    function mouseLeft(e) {
        DoHover(this, false, e);
    }
    //body can be either body, or a shadow root
    function setupBody(body) {
        let isShadow = body != doc.body;
        if (isShadow) {
            let linkEl = doc.createElement('link');
            linkEl.rel = 'stylesheet';
            linkEl.href = extensionUrl + 'css.css';
            body.prepend(linkEl);
            body.wzmShadowSetup = true;
        }
        //do elements
        DoElements(body, false);
        //mutation observer
        let observer = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                let m = mutations[i], el = m.target;
                if (m.type == 'attributes') {
                    if (m.attributeName == 'class') {
                        if (el == doc.documentElement) {
                            //incase the website is messing with the <html> classes
                            if (!HasClass(el, 'wizmage-show-html'))
                                AddClass(el, 'wizmage-show-html');
                            if (!HasClass(el, 'wizmage-running'))
                                AddClass(el, 'wizmage-running');
                        }
                        let className = GetClassName(el), oldHasLazy = m.oldValue != null && m.oldValue.indexOf('lazy') > -1, newHasLazy = className.indexOf('lazy') > -1, oldHasImg = el.wzmWizmaged && m.oldValue != null && m.oldValue.indexOf('img') > -1, newHasImg = el.wzmWizmaged && className.indexOf('img') > -1, addedBG = (!m.oldValue || m.oldValue.indexOf('_bg') == -1) && className.indexOf('_bg') > -1;
                        if (oldHasLazy != newHasLazy || (!oldHasImg && newHasImg) || addedBG)
                            DoElements(el, true);
                    }
                    else if (m.attributeName == 'style') {
                        let oldStyleUrl = ExtractCssUrl(m.oldValue || '');
                        let newStyleUrl = ExtractCssUrl(el.getAttribute('style') || '');
                        if (newStyleUrl && oldStyleUrl != newStyleUrl) {
                            setTimeout(() => DoElement.call(el), 0); //for sites that change the class just after, like linkedin
                        }
                    }
                    else if (m.attributeName == 'srcset' && el.tagName == 'SOURCE' && el.srcset && m.target.parentElement)
                        DoElement.call(m.target.parentElement);
                    else if ((m.attributeName == 'src' || m.attributeName == 'srcset' || m.attributeName == 'sizes') && isImg(el))
                        setTimeout(() => DoElement.call(el), 0);
                    else if (m.attributeName.indexOf('lazy') > -1)
                        DoElements(el, true);
                }
                else if (m.addedNodes != null && m.addedNodes.length > 0) {
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        let el = m.addedNodes[j];
                        if (!el.tagName) //eg text nodes
                            continue;
                        if (el.tagName == 'IFRAME')
                            DoIframe(el);
                        else if (el == doc.documentElement)
                            AddClass(el, 'wizmage-show-html wizmage-running');
                        else if (el.tagName == 'SOURCE') {
                            if (!showAll)
                                DoImgSrc(el, true);
                        }
                        else
                            DoElements(el, true);
                    }
                }
            }
        });
        observer.observe(isShadow ? body : doc, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
        observers.push(observer);
    }
    //process all elements with background-image, and observe mutations for new ones
    function Start() {
        if (hasStarted)
            return;
        //when viewing an image (not a webpage). iFrames, or pdfs may not have body/head
        if (!doc.body || !doc.head || !doc.documentElement || (win == top && doc.body.children.length == 1 && !doc.body.children[0].children.length)) {
            ShowImages();
            return;
        }
        wzmApplyPatternAssetVars(doc);
        //Keep the document hidden until the first synchronous scan has applied blockers.
        AddClassOnce(doc.documentElement, 'wizmage-running');
        //create eye
        eye.style.display = 'none';
        eye.style.width = eye.style.height = '16px';
        eye.style.position = wzmIsIOS ? 'absolute' : 'fixed';
        eye.style.zIndex = '100000000';
        eye.style.cursor = 'pointer';
        eye.style.padding = '0';
        eye.style.margin = '0';
        eye.style.opacity = '.5';
        doc.body.appendChild(eye);
        if (wzmIsIOS)
            eye.style.pointerEvents = 'none';
        //create temporary div, to eager load background img light for noEye to avoid flicker
        if (_settings.noEye) {
            for (let i = 0; i < 8; i++) {
                let div = doc.createElement('div');
                div.style.opacity = div.style.width = div.style.height = '0';
                div.className = 'wizmage-pattern-bg-img wizmage-cls wizmage-light wizmage-shade-' + i;
                doc.body.appendChild(div);
            }
        }
        //observer/loop elements
        setupBody(doc.body);
        UpdateAllowSafeForPage();
        AddClassOnce(doc.documentElement, 'wizmage-show-html');
        //CheckMousePosition every so often
        if (!intervalsStarted) {
            intervalsStarted = true;
            setInterval(CheckMousePosition, 250);
            setInterval(UpdateElRects, 3000);
        }
        for (let to of [250, 1500, 4500, 7500]) {
            setTimeout(UpdateElRects, to);
            setTimeout(RescanElements, to);
        }
        //ALT-a, ALT-z
        doc.addEventListener('keydown', DocKeyDown);
        //notice when mouse has moved (skip on iOS to avoid hover flicker)
        if (!wzmIsIOS) {
            doc.addEventListener('mousemove', DocMouseMove);
        } else {
            doc.addEventListener('touchstart', DocTouchStart, { capture: true, passive: false });
            doc.addEventListener('touchmove', DocTouchMove, { capture: true, passive: false });
            doc.addEventListener('touchend', DocTouchEnd, { capture: true, passive: false });
            doc.addEventListener('touchcancel', DocTouchCancel, { capture: true, passive: false });
        }
        win.addEventListener('scroll', WindowScroll);
        doc.addEventListener('visibilitychange', DocVisibilityChange);
        win.addEventListener('focus', WindowFocus);
        win.addEventListener('pageshow', WindowPageShow);
        //empty iframes
        let iframes = doc.getElementsByTagName('iframe');
        for (let i = 0, max = iframes.length; i < max; i++) {
            DoIframe(iframes[i]);
        }
        hasStarted = true;
    }
    win.wzmSetAllowSafeDomain = function (toggle) {
        if (!_settings.alwaysBlock)
            return;
        allowSafeDomain = !!toggle;
        UpdateAllowSafeForPage();
    };
    win.wzmUpdateSettings = function (next) {
        if (!next || typeof next !== 'object')
            return;
        let oldBlockTarget = _settings.blockTarget;
        let oldMaxSafe = _settings.maxSafe;
        let oldAlwaysBlock = !!_settings.alwaysBlock;
        _settings = wzmNormalizeSettings(next);
        allowSafeDomain = _settings.alwaysBlock ? !!_settings.allowSafeDomain : false;
        if (oldBlockTarget !== _settings.blockTarget || oldMaxSafe !== _settings.maxSafe || oldAlwaysBlock !== !!_settings.alwaysBlock) {
            ReprocessBlockedImages();
            RescanElements();
        }
        UpdateAllowSafeForPage();
    };
    function ReprocessBlockedImages() {
        if (showAll || !elList.length)
            return;
        let copy = elList.slice();
        for (let el of copy) {
            if (!el || !el.wzmBeenBlocked)
                continue;
            el.wzmLastCheckedSrc = null;
            el.wzmChecking = false;
            el.wzmBad = false;
            el.wzmUnchecked = true;
            el.wzmAlwaysBlock = false;
            ShowEl.call(el);
            el.wzmAllowSrc = null;
            DoElement.call(el);
        }
    }
    function RescanElements() {
        if (showAll || !hasStarted || !doc.body)
            return;
        DoElements(doc.body, false);
    }
    function DoElements(el, includeEl) {
        if (includeEl && tagList.indexOf(el.tagName) > -1)
            DoElement.call(el);
        let all = el.querySelectorAll(tagListCSS);
        for (let i = 0, max = all.length; i < max; i++)
            DoElement.call(all[i]);
    }
    function DoIframe(iframe) {
        if ((iframe.src && iframe.src != "about:blank" && iframe.src.substr(0, 11) != 'javascript:') || !iframe.contentWindow)
            return;
        let _win = iframe.contentWindow;
        let pollNum = 0, pollID = setInterval(function () {
            try {
                var _doc = _win.document;
            } //may cause access error, if is from other domain
            catch (err) {
                clearInterval(pollID);
                return;
            }
            if (_doc && _doc.body) {
                clearInterval(pollID);
                if (_doc.head) {
                    let linkEl = _doc.createElement('link');
                    linkEl.rel = 'stylesheet';
                    linkEl.href = extensionUrl + 'css.css';
                    _doc.head.appendChild(linkEl);
                    iframes.push(iframe);
                    DoWin(_win, true);
                }
            }
            if (++pollNum == 500)
                clearInterval(pollID);
        }, 10);
    }
    function DocTouchStart(e) {
        if (!wzmIsIOS)
            return;
        if (e.touches && e.touches.length >= 3) {
            RehideAll();
            twoFingerTapPossible = false;
            twoFingerTapMoved = false;
            twoFingerTapState = 0;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.touches && e.touches.length === 2) {
            twoFingerTapPossible = true;
            twoFingerTapMoved = false;
            let t1 = e.touches[0], t2 = e.touches[1];
            twoFingerStartX = (t1.clientX + t2.clientX) / 2;
            twoFingerStartY = (t1.clientY + t2.clientY) / 2;
        } else {
            twoFingerTapPossible = false;
        }
    }
    function DocTouchMove(e) {
        if (!twoFingerTapPossible)
            return;
        if (!e.touches || e.touches.length !== 2) {
            twoFingerTapPossible = false;
            return;
        }
        let t1 = e.touches[0], t2 = e.touches[1];
        let x = (t1.clientX + t2.clientX) / 2;
        let y = (t1.clientY + t2.clientY) / 2;
        let dx = Math.abs(x - twoFingerStartX);
        let dy = Math.abs(y - twoFingerStartY);
        if (dx + dy > longPressMoveThreshold)
            twoFingerTapMoved = true;
    }
    function DocTouchEnd(e) {
        if (!twoFingerTapPossible)
            return;
        if (e.touches && e.touches.length > 0)
            return;
        if (!twoFingerTapMoved) {
            if (twoFingerTapState === 0) {
                ShowEyeAt(twoFingerStartX, twoFingerStartY, true);
                twoFingerTapState = 1;
            }
            else if (twoFingerTapState === 1) {
                ShowSafeImagesForPage();
                twoFingerTapState = 2;
                if (eye)
                    eye.style.display = 'none';
            }
            e.preventDefault();
            e.stopPropagation();
        }
        twoFingerTapPossible = false;
        twoFingerTapMoved = false;
    }
    function DocTouchCancel() {
        twoFingerTapPossible = false;
        twoFingerTapMoved = false;
    }
    function IsSafeRenderedSize(width, height) {
        return width > 0 && height > 0 && (width <= _settings.maxSafe || height <= _settings.maxSafe);
    }
    function SizeNeedsBlocking(width, height) {
        return (width == 0 || width > _settings.maxSafe) && (height == 0 || height > _settings.maxSafe);
    }
    function GetAttr(el, name) {
        return el && el.getAttribute ? (el.getAttribute(name) || '') : '';
    }
    function GetProfileImageClues(el, imgUrl) {
        let parts = [imgUrl || ''], node = el;
        for (let i = 0; node && node != doc.body && node != doc.documentElement && i < 5; i++, node = node.parentElement) {
            parts.push(
                node.tagName || '',
                node.id || '',
                GetClassName(node),
                GetAttr(node, 'alt'),
                GetAttr(node, 'title'),
                GetAttr(node, 'aria-label'),
                GetAttr(node, 'role'),
                GetAttr(node, 'data-testid'),
                GetAttr(node, 'data-test'),
                GetAttr(node, 'data-locator'),
                GetAttr(node, 'src')
            );
        }
        return parts.join(' ');
    }
    function IsLikelyProfileImage(el, imgUrl) {
        let clues = GetProfileImageClues(el, imgUrl).toLowerCase();
        return /\b(avatar|profile|portrait|headshot|recruiter|assistant|agent|chatbot|chatbox)\b|ai[\s_-]*recruit/.test(clues);
    }
    function ImageNeedsBlocking(el, width, height, imgUrl) {
        return SizeNeedsBlocking(width, height) || IsLikelyProfileImage(el, imgUrl);
    }
    function CssLengthToPx(value, base) {
        value = (value || '').trim().toLowerCase();
        if (!value || value == 'auto' || value == 'cover' || value == 'contain')
            return null;
        let num = parseFloat(value);
        if (!isFinite(num) || num <= 0)
            return null;
        if (value.endsWith('%'))
            return base > 0 ? base * num / 100 : null;
        if (value.endsWith('px') || /^[\d.]+$/.test(value))
            return num;
        return null;
    }
    function IsSafeBackgroundSize(compStyle, width, height) {
        let backgroundSize = (compStyle.backgroundSize || '').split(',')[0].trim();
        if (!backgroundSize)
            return false;
        let parts = backgroundSize.split(/\s+/);
        let bgWidth = CssLengthToPx(parts[0], width);
        let bgHeight = parts.length > 1 ? CssLengthToPx(parts[1], height) : null;
        return (bgWidth != null && bgWidth <= _settings.maxSafe) || (bgHeight != null && bgHeight <= _settings.maxSafe);
    }
    function ExtractCssUrl(value) {
        let match = /\burl\(\s*(['"]?)(.*?)\1\s*\)/.exec(value || '');
        return match ? match[2].trim() : '';
    }
    function ResolveImageUrl(url) {
        if (!url)
            return '';
        if (url.startsWith('http') || url.startsWith('data:'))
            return url;
        try {
            return new URL(url, win.location.href).href;
        } catch (err) {
            return url;
        }
    }
    function GetStyleBackgroundImage(style) {
        let bgimg = style && style.backgroundImage;
        if (bgimg && bgimg != 'none' && ExtractCssUrl(bgimg))
            return bgimg;
        return '';
    }
    function GetInlineCustomPropertyImage(el) {
        if (!el || !el.style)
            return '';
        for (let i = 0; i < el.style.length; i++) {
            let prop = el.style[i];
            if (prop && prop.indexOf('--') === 0 && prop.toLowerCase().indexOf('background') !== -1) {
                let value = el.style.getPropertyValue(prop);
                if (ExtractCssUrl(value))
                    return value;
            }
        }
        return '';
    }
    function GetElementBackground(el, compStyle) {
        let bgimg = GetStyleBackgroundImage(compStyle);
        if (bgimg)
            return { image: bgimg, style: compStyle };
        for (let pseudo of ['::before', '::after']) {
            try {
                let pseudoStyle = getComputedStyle(el, pseudo);
                bgimg = GetStyleBackgroundImage(pseudoStyle);
                if (bgimg)
                    return { image: bgimg, style: pseudoStyle };
            } catch (err) { /* ignore pseudo-element style failures */ }
        }
        bgimg = GetInlineCustomPropertyImage(el);
        if (bgimg)
            return { image: bgimg, style: compStyle };
        return null;
    }
    function SafeControlLimit() {
        return _settings.maxSafe + Math.min(8, Math.max(3, Math.ceil(_settings.maxSafe / 3)));
    }
    function IsFormControl(el) {
        return /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    }
    function IsInteractiveElement(el) {
        if (!el || !el.tagName)
            return false;
        if (IsFormControl(el) || el.tagName == 'A')
            return true;
        let role = (el.getAttribute('role') || '').toLowerCase();
        if (/^(button|checkbox|switch|menuitem|tab|link|option)$/.test(role))
            return true;
        let control = el.closest('button,a[href],input,select,textarea,[role="button"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="tab"],[role="link"],[aria-label],[aria-labelledby]');
        return !!control && control != doc.body && control != doc.documentElement;
    }
    function IsSafeControlBackground(el, width, height) {
        if (!el || !el.tagName)
            return false;
        let limit = SafeControlLimit();
        if (IsFormControl(el))
            return (width > 0 && width <= limit) || (height > 0 && height <= limit);
        return width > 0 && height > 0 && width <= limit && height <= limit && IsInteractiveElement(el);
    }
    function DoElement() {
        if (showAll)
            return;
        let el = this, imgUrl;
        if (isImg(el)) {
            //attach load event - needed 1) as we need to catch it after it is switched for the blankImg, 2) in case the img gets changed to something else later
            DoLoadEventListener(el, true);
            //see if not yet loaded
            if (!el.complete) {
                //hide, to avoid flash until load event is handled
                MarkWizmaged(el, true);
                DoHidden(el, true);
                return;
            }
            let elWidth = el.width, elHeight = el.height;
            if ((el.src == blankImg && !el.srcset) || (el.wzmAllowSrc && el.src == el.wzmAllowSrc.src && el.srcset == el.wzmAllowSrc.srcset)) { //was successfully replaced
                DoHidden(el, false);
            }
            else {
                let srcForCheck = el.currentSrc || el.src;
                if (ImageNeedsBlocking(el, elWidth, elHeight, srcForCheck) //needs to be hidden - we need to catch 0 too, as sometimes images start off as zero
                    && !(el.src && (el.src.endsWith('.svg') || el.src.startsWith('data:image/svg+xml')))) {
                    if (srcForCheck && srcForCheck !== blankImg && el.wzmLastCheckedSrc !== srcForCheck) {
                        el.wzmLastCheckedSrc = srcForCheck;
                        el.wzmBad = false;
                        el.wzmChecking = false;
                        el.wzmUnchecked = true;
                        el.wzmAlwaysBlock = false;
                    }
                    DoMouseEventListeners(el, true);
                    if (!el.wzmHasTitleSetup) {
                        if (!el.title)
                            if (el.alt)
                                el.title = el.alt;
                            else {
                                el.src.match(/([-\w]+)(\.[\w]+)?$/i);
                                el.title = RegExp.$1;
                            }
                        el.wzmHasTitleSetup = true;
                    }
                    imgUrl = srcForCheck;
                    DoHidden(el, true);
                    DoImgSrc(el, true);
                    DoWizmageBG(el, true);
                    el.src = blankImg;
                }
                else { //small image
                    MarkWizmaged(el, false); //maybe !el.complete initially
                    DoHidden(el, false);
                }
            }
        }
        else if (el.tagName == 'VIDEO') {
            BlockVideoAsMatchedFilter(el);
        }
        else if (el.tagName == 'PICTURE') {
            for (let i = 0; i < el.children.length; i++) {
                let child = el.children[i];
                if (child.tagName == 'SOURCE')
                    DoImgSrc(child, true);
            }
            MarkWizmaged(el, true);
        }
        else {
            let compStyle = getComputedStyle(el), bg = GetElementBackground(el, compStyle), bgimg = bg ? bg.image : '', bgUrl = ResolveImageUrl(ExtractCssUrl(bgimg)), width = parseInt(compStyle.width) || el.clientWidth, height = parseInt(compStyle.height) || el.clientHeight; //as per https://developer.mozilla.org/en/docs/Web/API/window.getComputedStyle, getComputedStyle will return the 'used values' for width and height, which is always in px. We also use clientXXX, since sometimes compStyle returns NaN.
            let likelyProfileImage = IsLikelyProfileImage(el, bgUrl);
            if (bgUrl
                && !el.wzmWizmaged
                && (SizeNeedsBlocking(width, height) || likelyProfileImage) /*we need to catch 0 too, as sometimes elements start off as zero*/
                && (likelyProfileImage || !IsSafeBackgroundSize(bg.style, width, height))
                && (likelyProfileImage || !IsSafeControlBackground(el, width, height))
                && !bgUrl.startsWith(extensionUrl)) {
                imgUrl = bgUrl;
                if (el.wzmLastCheckedSrc != bgUrl) {
                    el.wzmBad = false;
                    el.wzmChecking = false;
                    el.wzmUnchecked = true;
                    el.wzmAlwaysBlock = false;
                    el.wzmLastCheckedSrc = bgUrl;
                    let i = new Image();
                    i.owner = el;
                    i.wzmLikelyProfileImage = likelyProfileImage;
                    i.onload = CheckBgImg;
                    i.src = bgUrl;
                }
                DoWizmageBG(el, true);
                DoMouseEventListeners(el, true);
            }
            if (el.shadowRoot && !el.shadowRoot.wzmShadowSetup) {
                setupBody(el.shadowRoot);
            }
        }
        if (imgUrl) {
            imgUrl = imgUrl.trim();
            imgUrl = ResolveImageUrl(ExtractCssUrl(imgUrl) || imgUrl);
            if (imgUrl.startsWith('http') || imgUrl.startsWith('data:')) {
                SetChecking(el, true);
                wzmAnalyzeImage(imgUrl, (r) => {
                    if (isImg(el) && el.src != blankImg && el.src != imgUrl)
                        return;
                    r = Number(r);
                    el.wzmChecking = false;
                    if (r === 1) {
                        DoWizmageBG(el, false);
                        el.wzmBad = true;
                        el.wzmAlwaysBlock = false;
                        el.wzmUnchecked = false;
                        DoWizmageBG(el, true);
                        return;
                    }
                    if (r === 0) {
                        if (_settings.alwaysBlock && !showSafeImagesForPage) {
                            DoWizmageBG(el, false);
                            el.wzmBad = false;
                            el.wzmUnchecked = false;
                            el.wzmAlwaysBlock = true;
                            DoWizmageBG(el, true);
                            return;
                        }
                        el.wzmBad = false;
                        el.wzmUnchecked = false;
                        el.wzmAlwaysBlock = false;
                        ShowEl.call(el);
                        return;
                    }
                    DoWizmageBG(el, false);
                    el.wzmBad = false;
                    el.wzmAlwaysBlock = false;
                    el.wzmUnchecked = true;
                    DoWizmageBG(el, true);
                });
            }
        }
    }
    function CheckBgImg() {
        let el = this;
        if (el.owner) {
            let compStyle = getComputedStyle(el.owner);
            let width = parseInt(compStyle.width) || el.owner.clientWidth;
            let height = parseInt(compStyle.height) || el.owner.clientHeight;
            if (!el.wzmLikelyProfileImage && (IsSafeRenderedSize(el.width, el.height) || IsSafeControlBackground(el.owner, width, height)))
                ShowEl.call(el.owner);
        }
        this.onload = null;
    }
    ;
    function MarkWizmaged(el, toggle) {
        if (toggle) {
            if (el.wzmUnchecked === undefined)
                el.wzmUnchecked = true;
            el.wzmWizmaged = true;
            el.wzmBeenBlocked = true;
            if (elList.indexOf(el) == -1) {
                elList.push(el);
                el.wzmRect = el.getBoundingClientRect();
            }
        }
        else
            el.wzmWizmaged = false;
    }
    function DoWizmageBG(el, toggle) {
        if (toggle && !el.wzmHasWizmageBG) {
            let shade = el.wzmBad ? 5 : (el.wzmChecking ? 2 : (el.wzmUnchecked ? 1 : 7));
            el.wzmShade = shade;
            ApplyWizmageBGAttrs(el, shade);
            AddClass(el, 'wizmage-pattern-bg-img wizmage-cls wizmage-shade-' + shade);
            if (el.wzmChecking)
                AddClass(el, 'wizmage-checking');
            if (el.wzmAlwaysBlock)
                AddClass(el, 'wizmage-always');
            el.wzmTapState = 0;
            el.wzmHasWizmageBG = true;
            MarkWizmaged(el, true);
        }
        else if (!toggle && el.wzmHasWizmageBG) {
            ClearWizmageBGAttrs(el);
            RemoveClass(el, 'wizmage-pattern-bg-img');
            RemoveClass(el, 'wizmage-cls');
            RemoveClass(el, 'wizmage-shade-' + el.wzmShade);
            RemoveClass(el, 'wizmage-always');
            RemoveClass(el, 'wizmage-checking');
            el.wzmHasWizmageBG = false;
            MarkWizmaged(el, false);
        }
        else if (toggle && el.wzmHasWizmageBG) {
            ApplyWizmageBGAttrs(el, el.wzmShade);
        }
        else if (!toggle) {
            ClearWizmageBGAttrs(el);
        }
    }
    function SetChecking(el, toggle) {
        if (el.wzmChecking === toggle)
            return;
        el.wzmChecking = toggle;
        if (el.wzmHasWizmageBG) {
            DoWizmageBG(el, false);
            DoWizmageBG(el, true);
        }
    }
    //for IMG,SOURCE
    function DoImgSrc(el, toggle) {
        if (toggle) {
            if (!el.style.width && !el.style.height) {
                el.style.width = el.width + 'px';
                el.style.height = el.height + 'px';
                el.wzmSetSize = true;
            }
            if (el.tagName != 'SOURCE') {
                el.oldsrc = el.src;
                el.src = '';
            }
            el.oldsrcset = el.srcset;
            el.srcset = '';
        }
        else {
            if (el.tagName != 'SOURCE' && el.oldsrc != undefined) //may be undefined if img was hidden and never loaded
                el.src = el.oldsrc || '';
            if (el.oldsrcset != undefined)
                el.srcset = el.oldsrcset || '';
            if (el.wzmSetSize) {
                el.style.width = el.style.height = null;
                el.wzmSetSize = false;
            }
        }
    }
    function DoHidden(el, toggle) {
        if (toggle && !el.wzmHidden) {
            SetWzmAttr(el, 'data-wzm-hide', '1');
            AddClass(el, 'wizmage-hide');
            el.wzmHidden = true;
        }
        else if (!toggle && el.wzmHidden) {
            RemoveWzmAttr(el, 'data-wzm-hide');
            RemoveClass(el, 'wizmage-hide');
            el.wzmHidden = false;
        }
        else if (toggle) {
            SetWzmAttr(el, 'data-wzm-hide', '1');
        }
        else {
            RemoveWzmAttr(el, 'data-wzm-hide');
        }
    }
    function AddClassOnce(el, c) {
        if (!HasClass(el, c))
            AddClass(el, c);
    }
    function HasClass(el, c) {
        return (' ' + GetClassName(el) + ' ').indexOf(' ' + c + ' ') > -1;
    }
    function GetClassName(el) {
        return typeof el.className == 'string' ? el.className : '';
    }
    function SetWzmAttr(el, name, value) {
        if (el && el.setAttribute && el.getAttribute(name) !== value)
            el.setAttribute(name, value);
    }
    function RemoveWzmAttr(el, name) {
        if (el && el.removeAttribute && el.hasAttribute(name))
            el.removeAttribute(name);
    }
    function ApplyWizmageBGAttrs(el, shade) {
        if (!el)
            return;
        SetWzmAttr(el, 'data-wzm-pattern-bg-img', '1');
        SetWzmAttr(el, 'data-wzm-shade', String(shade != null ? shade : (el.wzmShade || 0)));
        if (el.wzmChecking)
            SetWzmAttr(el, 'data-wzm-checking', '1');
        else
            RemoveWzmAttr(el, 'data-wzm-checking');
        if (el.wzmAlwaysBlock)
            SetWzmAttr(el, 'data-wzm-always', '1');
        else
            RemoveWzmAttr(el, 'data-wzm-always');
    }
    function ClearWizmageBGAttrs(el) {
        RemoveWzmAttr(el, 'data-wzm-pattern-bg-img');
        RemoveWzmAttr(el, 'data-wzm-shade');
        RemoveWzmAttr(el, 'data-wzm-checking');
        RemoveWzmAttr(el, 'data-wzm-always');
    }
    function HasWizmageBGApplied(el) {
        return HasClass(el, 'wizmage-pattern-bg-img') || (el && el.getAttribute && el.getAttribute('data-wzm-pattern-bg-img') == '1');
    }
    function HasWizmageLockApplied(el) {
        return HasClass(el, 'wizmage-locked') || (el && el.getAttribute && el.getAttribute('data-wzm-locked') == '1');
    }
    function BlockVideoAsMatchedFilter(el) {
        if (!el)
            return;
        let rect = el.getBoundingClientRect();
        if (!el.wzmSetVideoSize && !el.style.width && !el.style.height && rect.width > 0 && rect.height > 0) {
            el.style.width = rect.width + 'px';
            el.style.height = rect.height + 'px';
            el.wzmSetVideoSize = true;
        }
        DoHidden(el, false);
        let alreadyBlocked = el.wzmHasWizmageBG && el.wzmBad === true && !el.wzmChecking && !el.wzmUnchecked && !el.wzmAlwaysBlock;
        if (!alreadyBlocked) {
            if (el.wzmHasWizmageBG)
                DoWizmageBG(el, false);
            el.wzmBad = true;
            el.wzmChecking = false;
            el.wzmUnchecked = false;
            el.wzmAlwaysBlock = false;
            DoWizmageBG(el, true);
        }
        else {
            ApplyWizmageBGAttrs(el, el.wzmShade);
        }
        SetWzmAttr(el, 'data-wzm-locked', '1');
        if (!el.wzmVideoLockClassApplied) {
            AddClassOnce(el, 'wizmage-locked');
            el.wzmVideoLockClassApplied = true;
        }
        DoMouseEventListeners(el, true);
    }
    function UnlockVideo(el) {
        RemoveWzmAttr(el, 'data-wzm-locked');
        RemoveClass(el, 'wizmage-locked');
        el.wzmVideoLockClassApplied = false;
        DoWizmageBG(el, false);
        RemoveClass(el, 'wizmage-light');
        if (el.wzmSetVideoSize) {
            el.style.width = el.style.height = null;
            el.wzmSetVideoSize = false;
        }
    }
    function RehideEl(el) {
        if (!el || !el.wzmBeenBlocked)
            return;
        let preserveSrc = function (node) {
            let prevSrc = node.oldsrc, prevSrcSet = node.oldsrcset;
            DoImgSrc(node, true);
            if (prevSrc !== undefined && prevSrc !== blankImg)
                node.oldsrc = prevSrc;
            if (prevSrcSet !== undefined)
                node.oldsrcset = prevSrcSet;
        };
        if (isImg(el)) {
            DoHidden(el, true);
            preserveSrc(el);
            DoWizmageBG(el, true);
            el.src = blankImg;
            el.wzmAllowSrc = null;
        }
        else if (el.tagName == 'VIDEO') {
            BlockVideoAsMatchedFilter(el);
        }
        else if (el.tagName == 'PICTURE') {
            for (let i = 0; i < el.children.length; i++) {
                let child = el.children[i];
                if (child.tagName == 'SOURCE')
                    preserveSrc(child);
            }
            MarkWizmaged(el, true);
        }
        else {
            DoWizmageBG(el, true);
        }
        el.wzmTapState = 0;
        el.wzmLongPressShown = false;
    }
    function ShouldRemainBlocked(el) {
        return !!(el && el.wzmBeenBlocked && (el.wzmBad || el.wzmChecking || el.wzmUnchecked || el.wzmAlwaysBlock));
    }
    function RepairBlockedClasses(el) {
        if (!ShouldRemainBlocked(el))
            return;
        if (el.wzmHidden)
            SetWzmAttr(el, 'data-wzm-hide', '1');
        if (el.wzmHasWizmageBG)
            ApplyWizmageBGAttrs(el, el.wzmShade);
        if (el.tagName == 'VIDEO' && el.wzmWizmaged)
            SetWzmAttr(el, 'data-wzm-locked', '1');
    }
    function RehideBlockedElements() {
        if (!elList.length)
            return;
        let copy = elList.slice();
        for (let el of copy) {
            if (!ShouldRemainBlocked(el))
                continue;
            RepairBlockedClasses(el);
            if (isImg(el)) {
                if (!el.wzmAllowSrc && (el.src != blankImg || el.srcset))
                    RehideEl(el);
            }
            else if (el.tagName == 'VIDEO') {
                if (!HasWizmageLockApplied(el) || !HasWizmageBGApplied(el))
                    BlockVideoAsMatchedFilter(el);
            }
            else if (!el.wzmWizmaged || (el.wzmHasWizmageBG && !HasWizmageBGApplied(el))) {
                RehideEl(el);
            }
        }
    }
    function RehideAll() {
        if (showAll || !elList.length)
            return;
        for (let el of elList)
            RehideEl(el);
        if (eye)
            eye.style.display = 'none';
        lastTapShownEl = null;
        lastTapEyeEl = null;
    }
    function DoMouseEventListeners(el, toggle) {
        if (toggle && !el.wzmHasMouseEventListeners) {
            el.addEventListener('mouseover', mouseEntered);
            el.addEventListener('mouseout', mouseLeft);
            el.wzmHasMouseEventListeners = true;
            DoTouchEventListeners(el, true);
        }
        else if (!toggle && el.wzmHasMouseEventListeners) {
            el.removeEventListener('mouseover', mouseEntered);
            el.removeEventListener('mouseout', mouseLeft);
            el.wzmHasMouseEventListeners = false;
            DoTouchEventListeners(el, false);
        }
    }
    function DoTouchEventListeners(el, toggle) {
        if (!wzmIsIOS)
            return;
        if (toggle && !el.wzmHasTouchEventListeners) {
            el.wzmTouchStartHandler = function (e) {
                let now = Date.now();
                let allowRehideTap = !el.wzmWizmaged && el.wzmLastShownAt && (now - el.wzmLastShownAt < rehideTapWindow);
                if (showAll || (!el.wzmWizmaged && !allowRehideTap))
                    return;
                if (e.touches && e.touches.length > 1)
                    return;
                el.wzmConsumeClickUntil = 0;
                el.wzmTouchStartedBlocked = true;
                el.wzmTapMoved = false;
                let touch = e.touches && e.touches[0];
                if (touch) {
                    el.wzmTouchStartX = touch.clientX;
                    el.wzmTouchStartY = touch.clientY;
                }
            };
            el.wzmTouchMoveHandler = function (e) {
                if (!el.wzmTouchStartedBlocked)
                    return;
                let touch = e.touches && e.touches[0];
                if (!touch)
                    return;
                let dx = Math.abs(touch.clientX - (el.wzmTouchStartX || 0));
                let dy = Math.abs(touch.clientY - (el.wzmTouchStartY || 0));
                if (dx + dy > longPressMoveThreshold)
                    el.wzmTapMoved = true;
            };
            el.wzmTouchEndHandler = function (e) {
                if (el.wzmTouchStartedBlocked && !el.wzmTapMoved) {
                    let now = Date.now();
                    let state = el.wzmTapState || 0;
                    let consumed = false;
                    if (state === 0) {
                        ShowEyeCentered(el);
                        el.wzmTapState = 1;
                        consumed = true;
                    }
                    else if (state === 1) {
                        ShowEl.call(el);
                        el.wzmTapState = 2;
                        lastTapShownEl = el;
                        el.wzmLastShownAt = now;
                        if (eye)
                            eye.style.display = 'none';
                        consumed = true;
                    }
                    else if (state === 2) {
                        if (el.wzmLastShownAt && (now - el.wzmLastShownAt < rehideTapWindow)) {
                            RehideEl(el);
                            el.wzmLastShownAt = 0;
                            lastTapShownEl = null;
                            consumed = true;
                        }
                    }
                    if (consumed) {
                        el.wzmConsumeClickUntil = now + 600;
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
                el.wzmTouchStartedBlocked = false;
                el.wzmTapMoved = false;
            };
            el.wzmTouchCancelHandler = function () {
                el.wzmTouchStartedBlocked = false;
                el.wzmTapMoved = false;
            };
            el.wzmClickCaptureHandler = function (e) {
                if (el.wzmWizmaged || el.wzmHidden) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (el.wzmConsumeClickUntil && Date.now() < el.wzmConsumeClickUntil) {
                    e.preventDefault();
                    e.stopPropagation();
                    el.wzmConsumeClickUntil = 0;
                }
            };
            el.wzmContextMenuHandler = function (e) {
                if (el.wzmWizmaged || (el.wzmConsumeClickUntil && Date.now() < el.wzmConsumeClickUntil)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };
            el.addEventListener('touchstart', el.wzmTouchStartHandler, { capture: true, passive: false });
            el.addEventListener('touchmove', el.wzmTouchMoveHandler, { capture: true, passive: false });
            el.addEventListener('touchend', el.wzmTouchEndHandler, { capture: true, passive: false });
            el.addEventListener('touchcancel', el.wzmTouchCancelHandler, { capture: true, passive: false });
            el.addEventListener('click', el.wzmClickCaptureHandler, true);
            el.addEventListener('contextmenu', el.wzmContextMenuHandler, true);
            el.wzmHasTouchEventListeners = true;
        }
        else if (!toggle && el.wzmHasTouchEventListeners) {
            el.removeEventListener('touchstart', el.wzmTouchStartHandler, true);
            el.removeEventListener('touchmove', el.wzmTouchMoveHandler, true);
            el.removeEventListener('touchend', el.wzmTouchEndHandler, true);
            el.removeEventListener('touchcancel', el.wzmTouchCancelHandler, true);
            el.removeEventListener('click', el.wzmClickCaptureHandler, true);
            el.removeEventListener('contextmenu', el.wzmContextMenuHandler, true);
            el.wzmTouchStartHandler = null;
            el.wzmTouchMoveHandler = null;
            el.wzmTouchEndHandler = null;
            el.wzmTouchCancelHandler = null;
            el.wzmClickCaptureHandler = null;
            el.wzmContextMenuHandler = null;
            el.wzmHasTouchEventListeners = false;
        }
    }
    function DoLoadEventListener(el, toggle) {
        if (toggle && !el.wzmHasLoadEventListener) {
            el.addEventListener('load', DoElement);
            el.wzmHasLoadEventListener = true;
        }
        else if (!toggle && el.wzmHasLoadEventListener) {
            el.removeEventListener('load', DoElement);
            el.wzmHasLoadEventListener = false;
        }
    }
    function DoHover(el, toggle, evt) {
        let coords = el.wzmRect;
        if (toggle && !el.wzmHasHover) {
            if (mouseOverEl && mouseOverEl != el)
                DoHover(mouseOverEl, false);
            mouseOverEl = el;
            DoHoverVisual(el, true, coords);
            el.wzmHasHover = true;
        }
        else if (!toggle && el.wzmHasHover && (!evt || !coords || !IsMouseIn(evt, coords))) {
            DoHoverVisual(el, false, coords);
            el.wzmHasHover = false;
            if (el == mouseOverEl)
                mouseOverEl = undefined;
        }
    }
    function DoHoverVisual(el, toggle, coords) {
        if (wzmIsIOS)
            return;
        if (toggle && !el.wzmHasHoverVisual && el.wzmWizmaged) {
            if (!_settings.noEye) {
                //eye
                if (!eye.parentElement) //page js may have removed it
                    doc.body.appendChild(eye);
                PositionEye(el, coords);
                eye.style.display = 'block';
                eye.style.backgroundColor = el.tagName == 'VIDEO' ? '#fff' : '';
                let setupEye = function () {
                    eye.style.backgroundImage = eyeCSSUrl;
                    eye.onclick = function (e) {
                        if (e && (e.ctrlKey || e.shiftKey)) {
                            e.stopPropagation();
                            ShowSafeImagesForPage();
                            DoHoverVisualClearTimer(el, true);
                            return;
                        }
                        e.stopPropagation();
                        ShowEl.call(el);
                        eye.style.backgroundImage = undoCSSUrl;
                        DoHoverVisualClearTimer(el, true);
                        eye.onclick = function (e) {
                            e.stopPropagation();
                            RehideEl(el);
                            setupEye();
                            DoHoverVisualClearTimer(el, true);
                        };
                    };
                };
                setupEye();
            }
            else {
                SetWzmAttr(el, 'data-wzm-light', '1');
                AddClass(el, 'wizmage-light');
            }
            DoHoverVisualClearTimer(el, true);
            el.wzmHasHoverVisual = true;
        }
        else if (!toggle && el.wzmHasHoverVisual) {
            if (!_settings.noEye)
                eye.style.display = 'none';
            else {
                RemoveWzmAttr(el, 'data-wzm-light');
                RemoveClass(el, 'wizmage-light');
            }
            DoHoverVisualClearTimer(el, false);
            el.wzmHasHoverVisual = false;
        }
    }
    function ShowEyeCentered(el) {
        if (!el || !el.wzmWizmaged)
            return;
        if (_settings.noEye) {
            SetWzmAttr(el, 'data-wzm-light', '1');
            AddClass(el, 'wizmage-light');
            return;
        }
        if (lastTapEyeEl && lastTapEyeEl != el) {
            RemoveWzmAttr(lastTapEyeEl, 'data-wzm-light');
            RemoveClass(lastTapEyeEl, 'wizmage-light');
            lastTapEyeEl.wzmTapState = 0;
            lastTapEyeEl.wzmLastShownAt = 0;
            lastTapEyeEl.wzmConsumeClickUntil = 0;
            if (eye)
                eye.style.display = 'none';
        }
        lastTapEyeEl = el;
        let rect = el.getBoundingClientRect();
        if (!eye.parentElement)
            doc.body.appendChild(eye);
        let scrollX = wzmIsIOS ? (win.pageXOffset || doc.documentElement.scrollLeft || doc.body.scrollLeft || 0) : 0;
        let scrollY = wzmIsIOS ? (win.pageYOffset || doc.documentElement.scrollTop || doc.body.scrollTop || 0) : 0;
        let size = 32;
        eye.style.width = eye.style.height = size + 'px';
        eye.style.left = (rect.left + scrollX + rect.width / 2 - size / 2) + 'px';
        eye.style.top = (rect.top + scrollY + rect.height / 2 - size / 2) + 'px';
        eye.style.display = 'block';
        eye.style.opacity = '.6';
        eye.style.cursor = 'default';
        eye.style.pointerEvents = 'none';
        eye.style.filter = 'none';
        eye.style.backgroundColor = el.tagName == 'VIDEO' ? '#fff' : '';
        eye.style.backgroundImage = eyeCSSUrl;
    }
    function ShowEyeAt(x, y, isGreen) {
        if (!eye.parentElement)
            doc.body.appendChild(eye);
        let scrollX = wzmIsIOS ? (win.pageXOffset || doc.documentElement.scrollLeft || doc.body.scrollLeft || 0) : 0;
        let scrollY = wzmIsIOS ? (win.pageYOffset || doc.documentElement.scrollTop || doc.body.scrollTop || 0) : 0;
        let size = 32;
        eye.style.width = eye.style.height = size + 'px';
        eye.style.left = (x + scrollX - size / 2) + 'px';
        eye.style.top = (y + scrollY - size / 2) + 'px';
        eye.style.display = 'block';
        eye.style.opacity = '.7';
        eye.style.cursor = 'default';
        eye.style.pointerEvents = 'none';
        eye.style.backgroundColor = '';
        eye.style.backgroundImage = eyeCSSUrl;
        eye.style.filter = isGreen ? 'hue-rotate(90deg) saturate(3) brightness(1.2)' : 'none';
        lastTapEyeEl = null;
    }
    function ShowSafeImagesForPage() {
        if (!_settings.alwaysBlock) {
            showSafeImagesForPage = false;
            return;
        }
        showSafeImagesForPage = true;
        for (let el of elList) {
            if (el && el.wzmWizmaged && el.wzmBad === false && el.wzmUnchecked === false)
                ShowEl.call(el);
        }
    }
    function RehideSafeImagesForPage() {
        if (!_settings.alwaysBlock) {
            showSafeImagesForPage = false;
            return;
        }
        showSafeImagesForPage = false;
        for (let el of elList) {
            if (el && el.wzmBeenBlocked && el.wzmBad === false && el.wzmUnchecked === false)
                RehideEl(el);
        }
    }
    function UpdateAllowSafeForPage() {
        if (!_settings.alwaysBlock) {
            showSafeImagesForPage = false;
            return;
        }
        let next = !!allowSafeDomain;
        if (next && !showSafeImagesForPage)
            ShowSafeImagesForPage();
        else if (!next && showSafeImagesForPage)
            RehideSafeImagesForPage();
    }
    function DoHoverVisualClearTimer(el, toggle) {
        if (toggle) {
            DoHoverVisualClearTimer(el, false);
            el.wzmClearHoverVisualTimer = setTimeout(function () { DoHoverVisual(el, false); }, 2500);
        }
        else if (!toggle && el.wzmClearHoverVisualTimer) {
            clearTimeout(el.wzmClearHoverVisualTimer);
            el.wzmClearHoverVisualTimer = undefined;
        }
    }
    function PositionEye(el, coords) {
        if (!coords)
            return;
        let scrollX = wzmIsIOS ? (win.pageXOffset || doc.documentElement.scrollLeft || doc.body.scrollLeft || 0) : 0;
        let scrollY = wzmIsIOS ? (win.pageYOffset || doc.documentElement.scrollTop || doc.body.scrollTop || 0) : 0;
        eye.style.top = ((coords.top < 0 ? 0 : coords.top) + scrollY) + 'px';
        let left = coords.right;
        if (left > doc.documentElement.clientWidth)
            left = doc.documentElement.clientWidth;
        eye.style.left = (left + scrollX - 16) + 'px';
    }
    function UpdateElRects() {
        for (let el of elList) {
            if (el.wzmBeenBlocked)
                el.wzmRect = el.getBoundingClientRect();
        }
    }
    function CheckMousePosition() {
        if (wzmIsIOS)
            return;
        if (!mouseMoved || !mouseEvent || !contentLoaded || showAll || windowScrollIX > 0)
            return;
        mouseMoved = false;
        //see if needs to defocus current
        if (mouseOverEl) {
            let coords = mouseOverEl.wzmRect;
            if (!coords || !IsMouseIn(mouseEvent, coords))
                DoHover(mouseOverEl, false);
            else if (mouseOverEl.wzmWizmaged) {
                if (!mouseOverEl.wzmHasHoverVisual)
                    DoHoverVisual(mouseOverEl, true, coords);
                else {
                    DoHoverVisualClearTimer(mouseOverEl, true);
                    PositionEye(mouseOverEl, coords);
                }
            }
        }
        //find element under mouse
        let foundEl = mouseOverEl, found = false, foundSize = (foundEl && foundEl.wzmRect) ? foundEl.wzmRect.width * foundEl.wzmRect.height : undefined;
        for (let el of elList) {
            if (el == foundEl || !el.wzmBeenBlocked)
                continue;
            let rect = el.wzmRect;
            if (rect && IsMouseIn(mouseEvent, rect)) {
                //If not foundEl yet, use this. Else if foundEl has not got wzmBG, then if ours does, use it. Else if foundEl is bigger, use this.
                let useThis = false;
                if (!foundEl)
                    useThis = true;
                else if (!foundEl.wzmWizmaged && el.wzmWizmaged) {
                    useThis = true;
                }
                else if ((!foundSize || (foundSize > rect.width * rect.height)) && foundEl.wzmWizmaged == el.wzmWizmaged)
                    useThis = true;
                if (useThis) {
                    foundEl = el;
                    foundSize = rect.width * rect.height;
                    found = true;
                }
            }
        }
        if (found && foundEl && foundEl != mouseOverEl) {
            DoHover(foundEl, true);
        }
    }
    function IsMouseIn(mouseEvt, coords) {
        return mouseEvt.x >= coords.left && mouseEvt.x < coords.right && mouseEvt.y >= coords.top && mouseEvt.y < coords.bottom;
    }
    function ShowEl() {
        //mustn't trigger the observer here to call DoElement on this
        let el = this;
        DoHidden(el, false);
        if (isImg(el)) {
            DoImgSrc(el, false);
            el.wzmAllowSrc = { src: el.src, srcset: el.srcset };
            DoWizmageBG(el, false);
            RemoveWzmAttr(el, 'data-wzm-light');
            RemoveClass(el, 'wizmage-light');
        }
        else if (el.tagName == 'VIDEO') {
            UnlockVideo(el);
        }
        else if (el.tagName == 'PICTURE') {
            for (let i = 0; i < el.children.length; i++) {
                let node = el.children[i];
                if (node.tagName == 'SOURCE')
                    DoImgSrc(node, false);
            }
            MarkWizmaged(el, false);
            RemoveWzmAttr(el, 'data-wzm-light');
            RemoveClass(el, 'wizmage-light');
        }
        else {
            DoWizmageBG(el, false);
            RemoveWzmAttr(el, 'data-wzm-light');
            RemoveClass(el, 'wizmage-light');
        }
        el.wzmAlwaysBlock = false;
        el.wzmChecking = false;
        el.wzmUnchecked = false;
        if (el.wzmCheckTimeout) {
            clearTimeout(el.wzmCheckTimeout);
            el.wzmCheckTimeout = undefined;
        }
        if (showAll) {
            DoMouseEventListeners(el, false);
        }
    }
}
function RemoveClass(el, n) {
    let names = (n || '').split(/\s+/).filter(Boolean);
    if (el.classList && names.length) {
        el.classList.remove(...names);
        return;
    }
    let oldClass = el.className, newClass = el.className.replace(new RegExp('\\b' + n + '\\b'), '');
    if (oldClass != newClass) {
        el.className = newClass;
    }
}
function AddClass(el, c) {
    let names = (c || '').split(/\s+/).filter(Boolean);
    if (el.classList && names.length) {
        el.classList.add(...names);
        return;
    }
    el.className += ' ' + c;
}
