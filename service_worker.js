const wzmChrome = (typeof chrome !== 'undefined') ? chrome : (typeof browser !== 'undefined' ? browser : null);
if (typeof chrome === 'undefined' && wzmChrome) {
    globalThis.chrome = wzmChrome;
}

const storageLocal = wzmChrome && wzmChrome.storage ? wzmChrome.storage.local : null;
const storageSession = (wzmChrome && wzmChrome.storage && wzmChrome.storage.session) ? wzmChrome.storage.session : storageLocal;

const swLogKey = 'wzmSwLog';
function recordSwLog(event, detail) {
    try {
        storageSet(storageLocal, {
            [swLogKey]: {
                ts: Date.now(),
                event,
                detail: detail || null
            }
        });
    } catch (err) {
        // Ignore logging failures.
    }
}

try {
    recordSwLog('start', { ua: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '' });
} catch (err) {
    // ignore
}

if (typeof self !== 'undefined' && self.addEventListener) {
    self.addEventListener('error', (e) => {
        recordSwLog('error', {
            message: e && e.message ? e.message : 'unknown',
            filename: e && e.filename ? e.filename : '',
            lineno: e && e.lineno ? e.lineno : 0,
            colno: e && e.colno ? e.colno : 0
        });
    });
    self.addEventListener('unhandledrejection', (e) => {
        recordSwLog('unhandledrejection', {
            reason: e && e.reason ? (e.reason.message || String(e.reason)) : 'unknown'
        });
    });
}

if (wzmChrome && wzmChrome.runtime && wzmChrome.runtime.onConnect) {
    wzmChrome.runtime.onConnect.addListener((port) => {
        recordSwLog('connect', { name: port && port.name ? port.name : '' });
        if (port && port.onDisconnect) {
            port.onDisconnect.addListener(() => {
                recordSwLog('disconnect', { name: port && port.name ? port.name : '' });
            });
        }
    });
}
if (wzmChrome && wzmChrome.tabs && wzmChrome.tabs.onRemoved) {
    wzmChrome.tabs.onRemoved.addListener(async (tabId) => {
        let { pauseForTabs, excludeForTabs } = await storageGet(storageSession, { pauseForTabs: [], excludeForTabs: [] });
        let changed = false;
        if (Array.isArray(pauseForTabs)) {
            for (let i = 0; i < pauseForTabs.length; i++) {
                if (pauseForTabs[i] == tabId) { pauseForTabs.splice(i, 1); i--; changed = true; }
            }
        }
        if (Array.isArray(excludeForTabs)) {
            for (let i = 0; i < excludeForTabs.length; i++) {
                let entry = excludeForTabs[i];
                if (entry && entry.tabId == tabId) { excludeForTabs.splice(i, 1); i--; changed = true; }
            }
        }
        if (changed)
            storageSet(storageSession, { pauseForTabs, excludeForTabs });
    });
}

function storageGet(area, keys) {
    if (!area) return Promise.resolve({});
    try {
        const maybePromise = area.get(keys);
        if (maybePromise && typeof maybePromise.then === 'function') return maybePromise;
    } catch (err) {
        // Fall back to callback-based APIs.
    }
    return new Promise(resolve => area.get(keys, resolve));
}

function storageSet(area, items) {
    if (!area) return Promise.resolve();
    try {
        const maybePromise = area.set(items);
        if (maybePromise && typeof maybePromise.then === 'function') return maybePromise;
    } catch (err) {
        // Fall back to callback-based APIs.
    }
    return new Promise(resolve => area.set(items, resolve));
}

chrome.runtime.onInstalled.addListener(
    async function () {
        let { urlList, settings } = await storageGet(storageLocal, ['urlList', 'settings']);
        if (!urlList || !settings) {
            await storageSet(storageLocal, {
                urlList: [],
                    settings: {
                        paused: false,
                        noEye: false,
                        blackList: false,
                        closeOnClick: false,
                        maxSafe: 32,
                        alwaysBlock: false
                    }
                });
        }
    }
);

/** @type {WebSocket} */
let ws_g, settings;

chrome.runtime.onMessage.addListener(
    function (request, sender, sendResponse) {
        const shouldRespond = !!request && typeof request.r === 'string' && (request.r.startsWith('get') || request.r === 'wzmPing');
        Promise.resolve(handle()).catch(() => {
            if (shouldRespond) {
                try { sendResponse(0); } catch (err) { /* ignore */ }
            }
        });
        return shouldRespond;

        async function handle() {
            if (!request || typeof request.r !== 'string')
                return;

            switch (request.r) {
                case 'wzmPing': {
                    sendResponse({
                        ok: true,
                        ts: Date.now(),
                        hasWebSocket: typeof WebSocket !== 'undefined'
                    });
                    break;
                }
                case 'getUrlList': {
                    let { urlList } = await storageGet(storageLocal, 'urlList');
                    if (!urlList) urlList = [];
                    sendResponse(urlList);
                    break;
                }
                case 'getSettings': {
                    let { urlList, settings, allowSafeDomains } = await storageGet(storageLocal, ['urlList', 'settings', 'allowSafeDomains']);
                    if (!urlList) urlList = [];
                    if (!allowSafeDomains) allowSafeDomains = [];
                    if (!settings) {
                        settings = {
                            paused: false,
                            noEye: false,
                            blackList: false,
                            closeOnClick: false,
                            maxSafe: 32,
                            alwaysBlock: false
                        };
                        storageSet(storageLocal, { settings, urlList, allowSafeDomains });
                    }
                    if (settings.alwaysBlock == null) {
                        settings.alwaysBlock = false;
                        storageSet(storageLocal, { settings });
                    }
                    let { pauseForTabs, excludeForTabs } = await storageGet(storageSession, { pauseForTabs: [], excludeForTabs: [] });
                    let _settings = Object.assign({}, settings);
                    recordSwLog('getSettings', { tabId: (request.tab || (sender && sender.tab) || {}).id || null });
                    let tab = request.tab || sender.tab;
                    if (tab) {
                        if (pauseForTabs.indexOf(tab.id) != -1)
                            _settings.pausedForTab = true;
                        if (tab.url) {
                            let domain = getDomain(tab.url);
                            if (domain) {
                                for (let i = 0; i < excludeForTabs.length; i++) {
                                    let entry = excludeForTabs[i];
                                    if (entry && entry.tabId == tab.id && entry.domain == domain) { _settings.excludedForTab = true; break; }
                                }
                                for (let i = 0; i < allowSafeDomains.length; i++) {
                                    if (domain.indexOf(allowSafeDomains[i]) !== -1) { _settings.allowSafeDomain = true; break; }
                                }
                            }
                            let lowerUrl = tab.url.toLowerCase();
                            for (let i = 0; i < urlList.length; i++) {
                                if (lowerUrl.indexOf(urlList[i]) != -1) { _settings.excluded = true; break; }
                            }
                        }
                    }
                    sendResponse(_settings);
                    break;
                }
                case 'setColorIcon':
                    if (!sender || !sender.tab || typeof sender.tab.id !== 'number')
                        break;
                    if (chrome.action && chrome.action.setIcon)
                        chrome.action.setIcon({ path: request.toggle ? 'icon.png' : 'icon-d.png', tabId: sender.tab.id });
                    else if (chrome.browserAction && chrome.browserAction.setIcon)
                        chrome.browserAction.setIcon({ path: request.toggle ? 'icon.png' : 'icon-d.png', tabId: sender.tab.id });
                    break;
                case 'urlListAdd': {
                    let { urlList } = await storageGet(storageLocal, 'urlList');
                    if (!urlList) urlList = [];
                    let url = request.domainOnly ? getDomain(request.url) : request.url.toLowerCase();
                    if (url) {
                        urlList.push(url);
                        storageSet(storageLocal, { urlList });
                        chrome.runtime.sendMessage({ r: 'urlListModified' });
                    }
                    break;
                }
                case 'urlListRemove': {
                    let { urlList } = await storageGet(storageLocal, 'urlList');
                    if (!urlList) urlList = [];
                    if (request.url) {
                        let lowerUrl = request.url.toLowerCase();
                        for (let i = 0; i < urlList.length; i++) {
                            if (lowerUrl.indexOf(urlList[i]) != -1) { urlList.splice(i, 1); i--; }
                        }
                    } else
                        urlList.splice(request.index, 1);
                    storageSet(storageLocal, { urlList });
                    chrome.runtime.sendMessage({ r: 'urlListModified' });
                    break;
                }
                case 'setUrlList': {
                    let urlList = request.urlList;
                    storageSet(storageLocal, { urlList });
                    break;
                }
                case 'pause': {
                    await getSettings();
                    settings.paused = request.toggle;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'pauseForTab': {
                    let { pauseForTabs } = await storageGet(storageSession, { pauseForTabs: [] });
                    if (request.toggle)
                        pauseForTabs.push(request.tabId);
                    else
                        for (let i = 0; i < pauseForTabs.length; i++)
                            if (pauseForTabs[i] == request.tabId) { pauseForTabs.splice(i, 1); break; }
                    storageSet(storageSession, { pauseForTabs });
                    break;
                }
                case 'excludeForTab': {
                    let { excludeForTabs } = await storageGet(storageSession, { excludeForTabs: [] });
                    let domain = getDomain(request.tab.url);
                    if (!domain) return;
                    if (request.toggle) {
                        excludeForTabs.push({ tabId: request.tab.id, domain: domain });
                    }
                    else {
                        for (let i = 0; i < excludeForTabs.length; i++)
                            if (excludeForTabs[i].tabId == request.tab.id && excludeForTabs[i].domain == domain) { excludeForTabs.splice(i, 1); break; }
                    }
                    storageSet(storageSession, { excludeForTabs });
                    break;
                }
                case 'allowSafeForDomain': {
                    let { allowSafeDomains } = await storageGet(storageLocal, { allowSafeDomains: [] });
                    let domain = request.domain;
                    if (!domain && request.url)
                        domain = getDomain(request.url);
                    if (!domain)
                        break;
                    if (request.toggle) {
                        if (allowSafeDomains.indexOf(domain) === -1)
                            allowSafeDomains.push(domain);
                    }
                    else {
                        for (let i = 0; i < allowSafeDomains.length; i++) {
                            if (domain.indexOf(allowSafeDomains[i]) !== -1) { allowSafeDomains.splice(i, 1); i--; }
                        }
                    }
                    storageSet(storageLocal, { allowSafeDomains });
                    break;
                }
                case 'setNoEye': {
                    await getSettings();
                    settings.noEye = request.toggle;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setBlackList': {
                    await getSettings();
                    settings.blackList = request.toggle;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setMaxSafe': {
                    let ms = +request.maxSafe;
                    if (!ms || ms < 1 || ms > 1000)
                        ms = 32;
                    await getSettings();
                    settings.maxSafe = ms;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setCloseOnClick': {
                    await getSettings();
                    settings.closeOnClick = request.toggle;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setAlwaysBlock': {
                    await getSettings();
                    settings.alwaysBlock = request.toggle;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setUnwanted': {
                    await getSettings();
                    settings.unwanted = request.unwanted;
                    storageSet(storageLocal, { settings });
                    break;
                }
                case 'setToken':
                    await getSettings();
                    settings.token = request.token;
                    settings.phone = request.phone;
                    storageSet(storageLocal, { settings });
                    break;
                case 'getAnalyzeResponse': {
                    if (!request.imgUrl) {
                        sendResponse(0);
                        break;
                    }
                    if (typeof WebSocket === 'undefined') {
                        recordSwLog('ws-missing', null);
                        sendResponse(0);
                        break;
                    }
                    await getSettings();
                    let token = settings.token, unwanted = settings.unwanted;
                    if (!token || !unwanted) {
                        sendResponse(0);
                        return;
                    }
                    let ws = ws_g;
                    if (ws && ws.unwanted != unwanted) {
                        ws.close();
                        ws = null;
                    }
                    if (!ws || ws.readyState == WebSocket.CLOSING || ws.readyState == WebSocket.CLOSED || Date.now() - ws.lastMsg > 1000 * 40) {
                        try {
                            ws_g = ws = new WebSocket('wss://wizman.wizmage.com/ws?token=' + token);
                        } catch (err) {
                            recordSwLog('ws-create-error', { message: err && err.message ? err.message : String(err) });
                            sendResponse(0);
                            break;
                        }
                        ws.img_id = 0;
                        ws.openPromise = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
                        ws.onmessage = x => {
                            let d = JSON.parse(x.data);
                            if (d.err == 'bad-user') {
                                settings.token = undefined;
                                settings.phone = undefined;
                                storageSet(storageLocal, { settings });
                                return;
                            }
                            if (d.img_id)
                                sendResult(ws, d.img_id, d.result, true);
                            ws.lastMsg = Date.now()
                        }
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
                                        requests.forEach(x => sendResult(ws, x.img_id, 0));
                                        return;
                                    }
                                    if (ws.readyState == WebSocket.CLOSING || ws.readyState == WebSocket.CLOSED) {
                                        requests.forEach(x => sendResult(ws, x.img_id, 0));
                                        return;
                                    }
                                    try {
                                        ws.send(JSON.stringify({ requests, unwanted }))
                                    } catch (err) {
                                        requests.forEach(x => sendResult(ws, x.img_id, 0));
                                    }
                                }, 100);
                            }
                            ws.sendQueue.push(data);
                            ws.reqCallbacks.set(data.img_id, callback);
                            ws.urlResults.set(data.url, { sendResponses: callback.sendResponses, time: Date.now() });
                        }
                        ws.unwanted = unwanted;
                    }

                    let img_id = ++ws.img_id, url = request.imgUrl, b64;
                    if (url.startsWith('data:')) {
                        let m = /data:image\/\w+;base64,(.+)/.exec(url);
                        if (!m) {
                            sendResponse(0);
                            return;
                        }
                        b64 = m[1];
                        url = 'hash:' + hash64(b64);
                    }
                    let urlResult = ws.urlResults.get(url);
                    if (urlResult && urlResult.sendResponses && Date.now() - urlResult.time < 1000 * 30) {
                        urlResult.sendResponses.push(sendResponse);
                        break;
                    }
                    if (urlResult && urlResult.result) {
                        sendResponse(urlResult.result);
                        break;
                    }

                    let callback = { sendResponses: [sendResponse], url };
                    if (b64)
                        callback.tryNext = { b64 };
                    ws.addReq({ img_id, url }, callback);
                    break;
                }
            }
        }
    }
);

function getDomain(url) {
    let regex = /^\w+:\/\/([\w\.:-]+)/.exec(url);
    return regex ? regex[1].toLowerCase() : null;
}
function sendResult(ws, img_id, result, fromAnalysis) {
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
async function getSettings() {
    if (!settings) {
        let o = await storageGet(storageLocal, 'settings');
        settings = o.settings;
        if (!settings) {
            settings = {
                paused: false,
                noEye: false,
                blackList: false,
                closeOnClick: false,
                maxSafe: 32,
                alwaysBlock: false
            };
            storageSet(storageLocal, { settings });
        }
        // alwaysBlockPaused removed
    }
}
function hash64(str) {
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
