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
function wzmStorageGetLocal(keys, callback) {
    if (!wzmStorageLocal || !wzmStorageLocal.get) {
        if (callback) callback({});
        return;
    }
    try {
        var maybePromise = wzmStorageLocal.get(keys);
        if (maybePromise && typeof maybePromise.then === 'function') {
            if (callback) maybePromise.then(callback).catch(function () { callback({}); });
            return maybePromise;
        }
    } catch (err) {
        // fall through
    }
    try {
        return wzmStorageLocal.get(keys, callback);
    } catch (err) {
        if (callback) callback({});
    }
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
function wzmKeepAlive() {
    if (!wzmRuntime || !wzmRuntime.connect)
        return;
    try {
        let port = wzmRuntime.connect({ name: 'wzm-keepalive' });
        if (port && port.onDisconnect) {
            port.onDisconnect.addListener(() => {
                setTimeout(wzmKeepAlive, 1000);
            });
        }
    } catch (err) {
        // ignore
    }
}
wzmKeepAlive();
let wzmWsGlobal = null;
function wzmWsSendResult(ws, img_id, result, fromAnalysis) {
    let v = ws.reqCallbacks.get(img_id);
    if (v) {
        let url = v.url;
        if (result == 0 && fromAnalysis && v.tryNext) {
            ws.addReq(Object.assign({ img_id, url }, v.tryNext), { sendResponses: v.sendResponses, url });
            return;
        }
        v.sendResponses.forEach(x => x(result));
        ws.reqCallbacks.delete(img_id);
        ws.urlResults.set(url, { result });
    }
}
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
function wzmEnsureWebSocket() {
    if (typeof WebSocket === 'undefined')
        return null;
    if (!settings || !settings.token || !settings.unwanted)
        return null;
    let ws = wzmWsGlobal;
    if (ws && ws.unwanted !== settings.unwanted) {
        try { ws.close(); } catch (err) { /* ignore */ }
        ws = null;
        wzmWsGlobal = null;
    }
    if (!ws || ws.readyState == WebSocket.CLOSING || ws.readyState == WebSocket.CLOSED || (ws.lastMsg && Date.now() - ws.lastMsg > 1000 * 40)) {
        try {
            ws = new WebSocket('wss://wizman.wizmage.com/ws?token=' + settings.token);
        } catch (err) {
            return null;
        }
        ws.img_id = 0;
        ws.openPromise = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.onmessage = x => {
            let d;
            try { d = JSON.parse(x.data); } catch (err) { return; }
            if (d.err == 'bad-user') {
                settings.token = undefined;
                settings.phone = undefined;
                wzmStorageSetLocal({ settings });
                return;
            }
            if (d.img_id)
                wzmWsSendResult(ws, d.img_id, d.result, true);
            ws.lastMsg = Date.now();
        };
        ws.reqCallbacks = new Map();
        ws.urlResults = new Map();
        ws.addReq = (data, callback) => {
            if (!ws.sendQueue) {
                ws.sendQueue = [];
                setTimeout(async () => {
                    let requests = ws.sendQueue;
                    ws.sendQueue = null;
                    try {
                        await ws.openPromise;
                    } catch (err) {
                        requests.forEach(x => wzmWsSendResult(ws, x.img_id, 0));
                        return;
                    }
                    if (ws.readyState == WebSocket.CLOSING || ws.readyState == WebSocket.CLOSED) {
                        requests.forEach(x => wzmWsSendResult(ws, x.img_id, 0));
                        return;
                    }
                    try {
                        ws.send(JSON.stringify({ requests, unwanted: ws.unwanted }));
                    } catch (err) {
                        requests.forEach(x => wzmWsSendResult(ws, x.img_id, 0));
                    }
                }, 100);
            }
            ws.sendQueue.push(data);
            ws.reqCallbacks.set(data.img_id, callback);
            ws.urlResults.set(data.url, { sendResponses: callback.sendResponses, time: Date.now() });
        };
        ws.unwanted = settings.unwanted;
        wzmWsGlobal = ws;
    }
    return ws;
}
function wzmAnalyzeViaWebSocket(imgUrl, callback) {
    if (!imgUrl || !callback) {
        if (callback) callback(0);
        return;
    }
    let ws = wzmEnsureWebSocket();
    if (!ws) {
        callback(0);
        return;
    }
    let img_id = ++ws.img_id, url = imgUrl, b64;
    if (url.startsWith('data:')) {
        let m = /data:image\/\w+;base64,(.+)/.exec(url);
        if (!m) {
            callback(0);
            return;
        }
        b64 = m[1];
        url = 'hash:' + wzmHash64(b64);
    }
    let urlResult = ws.urlResults.get(url);
    if (urlResult && urlResult.sendResponses && Date.now() - urlResult.time < 1000 * 30) {
        urlResult.sendResponses.push(callback);
        return;
    }
    if (urlResult && urlResult.result) {
        callback(urlResult.result);
        return;
    }
    let cb = { sendResponses: [callback], url };
    if (b64)
        cb.tryNext = { b64 };
    ws.addReq({ img_id, url }, cb);
}
function wzmAnalyzeImage(imgUrl, callback) {
    if (!callback)
        callback = function () { };
    if (!imgUrl) {
        callback(0);
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
    wzmSendMessage({ r: "getAnalyzeResponse", imgUrl }, (r) => {
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
let showAll = false, extensionUrl = wzmGetURL(''), urlExtensionUrl = 'url("' + extensionUrl, blankImg = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', urlBlankImg = 'url("' + blankImg + '")', patternCSSUrl = 'url(' + extensionUrl + "pattern.png" + ')', patternLightUrl = extensionUrl + "pattern-light.png", patternLightCSSUrl = 'url(' + patternLightUrl + ')', eyeCSSUrl = 'url(' + extensionUrl + "eye.svg" + ')', undoCSSUrl = 'url(' + extensionUrl + "undo.png" + ')', tagList = ['IMG', 'DIV', 'SPAN', 'A', 'UL', 'LI', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'I', 'STRONG', 'B', 'BIG', 'BUTTON', 'CENTER', 'SECTION', 'TABLE', 'FIGURE', 'ASIDE', 'HEADER', 'VIDEO', 'P', 'ARTICLE', 'PICTURE', 'BA-IMAGE'], tagListCSS = tagList.join(), iframes = [], contentLoaded = false, settings, quotesRegex = /['"]/g;
//keep track of contentLoaded
window.addEventListener('DOMContentLoaded', function () { contentLoaded = true; });
//start by seeing if is active or is paused etc.
let settingsResolved = false;
let settingsApplied = false;
let settingsFallback = setTimeout(function () {
    if (!settingsResolved && document.documentElement)
        AddClass(document.documentElement, 'wizmage-show-html');
}, 1500);
function applySettingsAndStart(s) {
    if (settingsApplied)
        return;
    settingsApplied = true;
    settingsResolved = true;
    clearTimeout(settingsFallback);
    settings = s || {
        paused: false,
        noEye: false,
        blackList: false,
        closeOnClick: false,
        maxSafe: 32,
        alwaysBlock: false
    };
    if (settings.alwaysBlock == null)
        settings.alwaysBlock = false;
    //if is active - go
    if (settings
        && ((!settings.blackList && !settings.excluded && !settings.excludedForTab)
            || (settings.blackList && (settings.excluded || settings.excludedForTab)))
        && !settings.paused && !settings.pausedForTab && location.host != 'mail.google.com') {
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
    wzmStorageGetLocal(['settings', 'allowSafeDomains'], function (data) {
        let s = data && data.settings ? data.settings : null;
        if (s && typeof s === 'object' && !s.allowSafeDomain) {
            let allowSafeDomains = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
            let host = (typeof location !== 'undefined' && location.host) ? location.host.toLowerCase() : '';
            if (host && allowSafeDomains.length) {
                for (let i = 0; i < allowSafeDomains.length; i++) {
                    if (host.indexOf(allowSafeDomains[i]) !== -1) {
                        s.allowSafeDomain = true;
                        break;
                    }
                }
            }
        }
        applySettingsAndStart(s);
    });
}
if (!wzmRuntime || !wzmRuntime.sendMessage || wzmIsSafari) {
    loadSettingsFromStorage();
}
else {
    let responded = false;
    wzmSendMessage({ r: 'getSettings' }, function (s) {
        responded = true;
        applySettingsAndStart(s);
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
    window.wzmShowImages();
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
        settings = s;
        if (settings.alwaysBlock == null)
            settings.alwaysBlock = false;
        if (window.wzmUpdateSettings)
            window.wzmUpdateSettings(settings);
        for (let i = 0, max = iframes.length; i < max; i++) {
            let iframe = iframes[i];
            try {
                if (iframe.contentWindow && iframe.contentWindow.wzmUpdateSettings)
                    iframe.contentWindow.wzmUpdateSettings(settings);
            }
            catch (err) { /*iframe may have been rewritten*/ }
        }
        if (callback) callback(true);
    };
    if (!wzmRuntime || !wzmRuntime.sendMessage || wzmIsSafari) {
        wzmStorageGetLocal(['settings', 'allowSafeDomains'], function (data) {
            let s = data && data.settings ? data.settings : null;
            if (s && typeof s === 'object' && !s.allowSafeDomain) {
                let allowSafeDomains = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
                let host = (typeof location !== 'undefined' && location.host) ? location.host.toLowerCase() : '';
                if (host && allowSafeDomains.length) {
                    for (let i = 0; i < allowSafeDomains.length; i++) {
                        if (host.indexOf(allowSafeDomains[i]) !== -1) {
                            s.allowSafeDomain = true;
                            break;
                        }
                    }
                }
            }
            applySettings(s || {});
        });
        return;
    }
    wzmSendMessage({ r: 'getSettings' }, function (s) {
        applySettings(s);
    });
}
function DoWin(win, winContentLoaded) {
    let _settings = settings, //DoWin is only called after settings is set
    doc = win.document, observers = [], eye = doc.createElement('div'), mouseMoved = false, mouseEvent, mouseOverEl, elList = [], hasStarted = false,
    lastTapShownEl, lastTapEyeEl, longPressMoveThreshold = 10, rehideTapWindow = 1000,
    allowSafeDomain = _settings.alwaysBlock ? !!_settings.allowSafeDomain : false,
    twoFingerTapState = 0, twoFingerTapPossible = false, twoFingerTapMoved = false, twoFingerStartX = 0, twoFingerStartY = 0,
    showSafeImagesForPage = (_settings.alwaysBlock && allowSafeDomain);
    //global show images
    win.wzmShowImages = function () {
        if (hasStarted) {
            doc.removeEventListener('keydown', DocKeyDown);
            doc.removeEventListener('mousemove', DocMouseMove);
            win.removeEventListener('scroll', WindowScroll);
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
            RemoveClass(document.documentElement, 'wizmage-running');
            hasStarted = false;
        }
        else
            AddClass(document.documentElement, 'wizmage-show-html');
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
                        if (el == document.documentElement) {
                            //incase the website is messing with the <html> classes
                            if (el.className.indexOf('wizmage-show-html') == -1)
                                AddClass(el, 'wizmage-show-html');
                            if (el.className.indexOf('wizmage-running') == -1)
                                AddClass(el, 'wizmage-running');
                        }
                        let oldHasLazy = m.oldValue != null && m.oldValue.indexOf('lazy') > -1, newHasLazy = el.className != null && typeof (el.className) == 'string' && el.className.indexOf('lazy') > -1, oldHasImg = el.wzmWizmaged && m.oldValue != null && m.oldValue.indexOf('img') > -1, newHasImg = el.wzmWizmaged && el.className != null && typeof (el.className) == 'string' && el.className.indexOf('img') > -1, addedBG = (!m.oldValue || m.oldValue.indexOf('_bg') == -1) && typeof (el.className) == 'string' && el.className.indexOf('_bg') > -1;
                        if (oldHasLazy != newHasLazy || (!oldHasImg && newHasImg) || addedBG)
                            DoElements(el, true);
                    }
                    else if (m.attributeName == 'style' && el.style.backgroundImage && el.style.backgroundImage.indexOf('url(') > -1) {
                        let oldBgImg, oldBgImgMatch;
                        if (m.oldValue == null || !(oldBgImgMatch = /background(?:-image)?:[^;]*url\(['"]?(.+?)['"]?\)/.exec(m.oldValue)))
                            oldBgImg = '';
                        else
                            oldBgImg = oldBgImgMatch[1];
                        let imgUrlMatch = /url\(['"]?(.+?)['"]?\)/.exec(el.style.backgroundImage);
                        if (imgUrlMatch && oldBgImg != imgUrlMatch[1]) {
                            setTimeout(() => DoElement.call(el), 0); //for sites that change the class just after, like linkedin
                        }
                    }
                    else if (m.attributeName == 'srcset' && el.tagName == 'SOURCE' && el.srcset && m.target.parentElement)
                        DoElement.call(m.target.parentElement);
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
                        else if (el == document.documentElement)
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
    let intervalsStarted = false;
    function Start() {
        if (hasStarted)
            return;
        //when viewing an image (not a webpage). iFrames, or pdfs may not have body/head
        if (!doc.body || !doc.head || !doc.documentElement || (win == top && doc.body.children.length == 1 && !doc.body.children[0].children.length)) {
            ShowImages();
            return;
        }
        //show body
        AddClass(doc.documentElement, 'wizmage-show-html wizmage-running');
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
                div.className = 'wizmage-pattern-bg-img wizmage-light wizmage-shade-' + i;
                doc.body.appendChild(div);
            }
        }
        //observer/loop elements
        setupBody(doc.body);
        UpdateAllowSafeForPage();
        //CheckMousePosition every so often
        if (!intervalsStarted) {
            intervalsStarted = true;
            setInterval(CheckMousePosition, 250);
            setInterval(UpdateElRects, 3000);
        }
        for (let to of [250, 1500, 4500, 7500])
            setTimeout(UpdateElRects, to);
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
        _settings = next;
        if (_settings.alwaysBlock == null)
            _settings.alwaysBlock = false;
        allowSafeDomain = _settings.alwaysBlock ? !!_settings.allowSafeDomain : false;
        UpdateAllowSafeForPage();
    };
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
            else if ((elWidth == 0 || elWidth > _settings.maxSafe) && (elHeight == 0 || elHeight > _settings.maxSafe) //needs to be hidden - we need to catch 0 too, as sometimes images start off as zero
                && !(el.src && (el.src.endsWith('.svg') || el.src.startsWith('data:image/svg+xml')))) {
                let srcForCheck = el.src;
                if (srcForCheck && srcForCheck !== blankImg && el.wzmLastCheckedSrc !== srcForCheck) {
                    el.wzmLastCheckedSrc = srcForCheck;
                    el.wzmBad = false;
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
                imgUrl = el.src;
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
        else if (el.tagName == 'VIDEO') {
            DoHidden(el, true);
            MarkWizmaged(el, true);
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
            let compStyle = getComputedStyle(el), bgimg = compStyle.backgroundImage, width = parseInt(compStyle.width) || el.clientWidth, height = parseInt(compStyle.height) || el.clientHeight; //as per https://developer.mozilla.org/en/docs/Web/API/window.getComputedStyle, getComputedStyle will return the 'used values' for width and height, which is always in px. We also use clientXXX, since sometimes compStyle returns NaN.
            if (bgimg && bgimg != 'none'
                && !el.wzmWizmaged
                && (width == 0 || width > _settings.maxSafe) && (height == 0 || height > _settings.maxSafe) /*we need to catch 0 too, as sometimes elements start off as zero*/
                && bgimg.indexOf('url(') != -1
                && !bgimg.startsWith(urlExtensionUrl)) {
                imgUrl = bgimg;
                if (el.wzmLastCheckedSrc != bgimg) {
                    el.wzmBad = false;
                    el.wzmUnchecked = true;
                    el.wzmAlwaysBlock = false;
                    el.wzmLastCheckedSrc = bgimg;
                    let i = new Image();
                    i.owner = el;
                    i.onload = CheckBgImg;
                    let urlMatch = /\burl\(["']?(.*?)["']?\)/.exec(bgimg);
                    if (urlMatch)
                        i.src = urlMatch[1];
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
            let m = /^url\("?'?(.+?)"?'?\)$/.exec(imgUrl);
            if (m)
                imgUrl = m[1];
            if (imgUrl.startsWith('http') || imgUrl.startsWith('data:')) {
                wzmAnalyzeImage(imgUrl, (r) => {
                    if (isImg(el) && el.src != blankImg && el.src != imgUrl)
                        return;
                    if (r == '1') {
                        DoWizmageBG(el, false);
                        el.wzmBad = true;
                        el.wzmAlwaysBlock = false;
                        el.wzmUnchecked = false;
                        DoWizmageBG(el, true);
                        return;
                    }
                    if (r == '-1') {
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
        if ((el.height <= _settings.maxSafe || el.width <= _settings.maxSafe) && el.owner)
            ShowEl.call(el.owner);
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
            let shade = el.wzmBad ? 5 : (el.wzmUnchecked ? 1 : 7);
            el.wzmShade = shade;
            AddClass(el, 'wizmage-pattern-bg-img wizmage-cls wizmage-shade-' + shade);
            if (el.wzmAlwaysBlock)
                AddClass(el, 'wizmage-always');
            el.wzmTapState = 0;
            el.wzmHasWizmageBG = true;
            MarkWizmaged(el, true);
        }
        else if (!toggle && el.wzmHasWizmageBG) {
            RemoveClass(el, 'wizmage-pattern-bg-img');
            RemoveClass(el, 'wizmage-cls');
            RemoveClass(el, 'wizmage-shade-' + el.wzmShade);
            RemoveClass(el, 'wizmage-always');
            el.wzmHasWizmageBG = false;
            MarkWizmaged(el, false);
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
            AddClass(el, 'wizmage-hide');
            el.wzmHidden = true;
        }
        else if (!toggle && el.wzmHidden) {
            RemoveClass(el, 'wizmage-hide');
            el.wzmHidden = false;
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
            DoHidden(el, true);
            MarkWizmaged(el, true);
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
                            DoElement.call(el);
                            setupEye();
                            DoHoverVisualClearTimer(el, true);
                        };
                    };
                };
                setupEye();
            }
            else
                AddClass(el, 'wizmage-light');
            DoHoverVisualClearTimer(el, true);
            el.wzmHasHoverVisual = true;
        }
        else if (!toggle && el.wzmHasHoverVisual) {
            if (!_settings.noEye)
                eye.style.display = 'none';
            else
                RemoveClass(el, 'wizmage-light');
            DoHoverVisualClearTimer(el, false);
            el.wzmHasHoverVisual = false;
        }
    }
    function ShowEyeCentered(el) {
        if (!el || !el.wzmWizmaged)
            return;
        if (_settings.noEye) {
            AddClass(el, 'wizmage-light');
            return;
        }
        if (lastTapEyeEl && lastTapEyeEl != el) {
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
            RemoveClass(el, 'wizmage-light');
        }
        else if (el.tagName == 'VIDEO') {
            MarkWizmaged(el, false);
        }
        else if (el.tagName == 'PICTURE') {
            for (let i = 0; i < el.children.length; i++) {
                let node = el.children[i];
                if (node.tagName == 'SOURCE')
                    DoImgSrc(node, false);
            }
            MarkWizmaged(el, false);
            RemoveClass(el, 'wizmage-light');
        }
        else {
            DoWizmageBG(el, false);
            RemoveClass(el, 'wizmage-light');
        }
        el.wzmAlwaysBlock = false;
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
    let oldClass = el.className, newClass = el.className.replace(new RegExp('\\b' + n + '\\b'), '');
    if (oldClass != newClass) {
        el.className = newClass;
    }
}
function AddClass(el, c) {
    el.className += ' ' + c;
}
