const wzmChrome = (typeof chrome !== 'undefined') ? chrome : (typeof browser !== 'undefined' ? browser : null);
if (typeof chrome === 'undefined' && wzmChrome) {
    globalThis.chrome = wzmChrome;
}

const storageLocal = wzmChrome && wzmChrome.storage ? wzmChrome.storage.local : null;
const storageSession = (wzmChrome && wzmChrome.storage && wzmChrome.storage.session) ? wzmChrome.storage.session : storageLocal;

const DEFAULT_SERVER_URL = 'wss://aiserver.wizmage.com:5002/ws';
const BATCH_FLUSH_MS = 50;
const BATCH_MAX_SIZE = 32;
const CACHE_MAX = 10000;
const WS_IDLE_TIMEOUT_MS = 40000;
const WS_HEARTBEAT_MS = 25000;
const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const WS_IDLE_CLOSE_MS = 5 * 60 * 1000;

let ws_g = null;
let settings = null;
let nextReqId = 0;
let reconnectDelay = WS_RECONNECT_MIN_MS;
const urlCache = new Map();
const pendingCache = new Map();
let sendQueue = null;
let flushTimer = null;

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
            removeMatches(pauseForTabs, entry => {
                let match = entry == tabId;
                if (match) changed = true;
                return match;
            });
        }
        if (Array.isArray(excludeForTabs)) {
            removeMatches(excludeForTabs, entry => {
                let match = entry && entry.tabId == tabId;
                if (match) changed = true;
                return match;
            });
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

function addUnique(list, value) {
    if (value && list.indexOf(value) === -1)
        list.push(value);
}

function removeMatches(list, predicate) {
    for (let i = 0; i < list.length; i++) {
        if (predicate(list[i])) {
            list.splice(i, 1);
            i--;
        }
    }
}

function defaultSettings() {
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

function legacyUnwantedToBlockTarget(unwanted) {
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

function normalizeSettings(raw) {
    let normalized = Object.assign(defaultSettings(), (raw && typeof raw === 'object') ? raw : {});
    if (!normalized.blockTarget)
        normalized.blockTarget = legacyUnwantedToBlockTarget(normalized.unwanted);
    if (['all', 'men', 'women', 'people'].indexOf(normalized.blockTarget) === -1)
        normalized.blockTarget = 'all';
    normalized.maxSafe = +normalized.maxSafe || 32;
    if (normalized.maxSafe < 1 || normalized.maxSafe > 1000)
        normalized.maxSafe = 32;
    normalized.paused = !!normalized.paused;
    normalized.noEye = !!normalized.noEye;
    normalized.noPattern = !!normalized.noPattern;
    normalized.blackList = !!normalized.blackList;
    normalized.closeOnClick = !!normalized.closeOnClick;
    normalized.alwaysBlock = !!normalized.alwaysBlock;
    return normalized;
}

chrome.runtime.onInstalled.addListener(async function () {
    let { urlList, settings: storedSettings, allowSafeDomains } = await storageGet(storageLocal, ['urlList', 'settings', 'allowSafeDomains']);
    await storageSet(storageLocal, {
        urlList: Array.isArray(urlList) ? urlList : [],
        allowSafeDomains: Array.isArray(allowSafeDomains) ? allowSafeDomains : [],
        settings: normalizeSettings(storedSettings)
    });
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    const responseMessages = [
        'wzmPing',
        'getUrlList',
        'getSettings',
        'getAnalyzeResponse',
        'urlListAdd',
        'urlListRemove',
        'setUrlList',
        'pause',
        'pauseForTab',
        'excludeForTab',
        'allowSafeForDomain',
        'setNoPattern',
        'setNoEye',
        'setBlackList',
        'setMaxSafe',
        'setCloseOnClick',
        'setAlwaysBlock',
        'setBlockTarget',
        'setServerUrl'
    ];
    const shouldRespond = !!request && typeof request.r === 'string' && responseMessages.indexOf(request.r) !== -1;

    Promise.resolve(handle()).catch((err) => {
        recordSwLog('message-error', { route: request && request.r, message: err && err.message ? err.message : String(err) });
        if (shouldRespond) {
            try { sendResponse(request && request.r === 'getAnalyzeResponse' ? -1 : { ok: false }); } catch (sendErr) { /* ignore */ }
        }
    });
    return shouldRespond;

    async function handle() {
        if (!request || typeof request.r !== 'string')
            return;

        switch (request.r) {
            case 'wzmPing':
                sendResponse({ ok: true, ts: Date.now(), hasWebSocket: typeof WebSocket !== 'undefined' });
                break;
            case 'getUrlList': {
                let { urlList } = await storageGet(storageLocal, 'urlList');
                sendResponse(Array.isArray(urlList) ? urlList : []);
                break;
            }
            case 'getSettings': {
                let effective = await getEffectiveSettings(request.tab || (sender && sender.tab));
                sendResponse(effective);
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
                urlList = Array.isArray(urlList) ? urlList : [];
                let url = request.domainOnly ? getDomain(request.url) : (request.url || '').toLowerCase();
                if (url) {
                    addUnique(urlList, url);
                    await storageSet(storageLocal, { urlList });
                    try { chrome.runtime.sendMessage({ r: 'urlListModified' }); } catch (err) { /* ignore */ }
                }
                sendResponse({ ok: true });
                break;
            }
            case 'urlListRemove': {
                let { urlList } = await storageGet(storageLocal, 'urlList');
                urlList = Array.isArray(urlList) ? urlList : [];
                if (request.url) {
                    let lowerUrl = request.url.toLowerCase();
                    removeMatches(urlList, entry => lowerUrl.indexOf((entry || '').toLowerCase()) != -1);
                } else if (request.index >= 0 && request.index < urlList.length) {
                    urlList.splice(request.index, 1);
                }
                await storageSet(storageLocal, { urlList });
                try { chrome.runtime.sendMessage({ r: 'urlListModified' }); } catch (err) { /* ignore */ }
                sendResponse({ ok: true });
                break;
            }
            case 'setUrlList':
                await storageSet(storageLocal, { urlList: Array.isArray(request.urlList) ? request.urlList : [] });
                sendResponse({ ok: true });
                break;
            case 'pause':
                await updateSettings(s => { s.paused = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'pauseForTab': {
                let { pauseForTabs } = await storageGet(storageSession, { pauseForTabs: [] });
                pauseForTabs = Array.isArray(pauseForTabs) ? pauseForTabs : [];
                if (request.toggle)
                    addUnique(pauseForTabs, request.tabId);
                else
                    removeMatches(pauseForTabs, entry => entry == request.tabId);
                await storageSet(storageSession, { pauseForTabs });
                sendResponse({ ok: true });
                break;
            }
            case 'excludeForTab': {
                let { excludeForTabs } = await storageGet(storageSession, { excludeForTabs: [] });
                excludeForTabs = Array.isArray(excludeForTabs) ? excludeForTabs : [];
                let tab = request.tab || {};
                let domain = getDomain(tab.url);
                if (!domain || tab.id == null) {
                    sendResponse({ ok: false });
                    break;
                }
                if (request.toggle) {
                    let exists = excludeForTabs.some(entry => entry && entry.tabId == tab.id && entry.domain == domain);
                    if (!exists)
                        excludeForTabs.push({ tabId: tab.id, domain });
                }
                else {
                    removeMatches(excludeForTabs, entry => entry && entry.tabId == tab.id && entry.domain == domain);
                }
                await storageSet(storageSession, { excludeForTabs });
                sendResponse({ ok: true });
                break;
            }
            case 'allowSafeForDomain': {
                let { allowSafeDomains } = await storageGet(storageLocal, { allowSafeDomains: [] });
                allowSafeDomains = Array.isArray(allowSafeDomains) ? allowSafeDomains : [];
                let domain = request.domain || getDomain(request.url);
                if (!domain) {
                    sendResponse({ ok: false });
                    break;
                }
                if (request.toggle)
                    addUnique(allowSafeDomains, domain);
                else
                    removeMatches(allowSafeDomains, entry => domain.indexOf((entry || '').toLowerCase()) !== -1);
                await storageSet(storageLocal, { allowSafeDomains });
                sendResponse({ ok: true });
                break;
            }
            case 'setNoPattern':
                await updateSettings(s => { s.noPattern = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'setNoEye':
                await updateSettings(s => { s.noEye = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'setBlackList':
                await updateSettings(s => { s.blackList = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'setMaxSafe': {
                let ms = +request.maxSafe;
                if (!ms || ms < 1 || ms > 1000)
                    ms = 32;
                await updateSettings(s => { s.maxSafe = ms; });
                sendResponse({ ok: true });
                break;
            }
            case 'setCloseOnClick':
                await updateSettings(s => { s.closeOnClick = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'setAlwaysBlock':
                await updateSettings(s => { s.alwaysBlock = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'setBlockTarget':
                await updateSettings(s => { s.blockTarget = ['all', 'men', 'women', 'people'].indexOf(request.blockTarget) === -1 ? 'all' : request.blockTarget; });
                sendResponse({ ok: true });
                break;
            case 'setServerUrl':
                await updateSettings(s => { s.serverUrl = request.serverUrl; });
                if (ws_g) {
                    try { ws_g.close(); } catch (err) { /* ignore */ }
                    ws_g = null;
                }
                sendResponse({ ok: true });
                break;
            case 'getAnalyzeResponse': {
                if (!request.imgUrl || typeof WebSocket === 'undefined') {
                    sendResponse(-1);
                    break;
                }
                let current = await getSettings();
                let blockTarget = current.blockTarget || 'all';
                if (blockTarget === 'all') {
                    sendResponse(1);
                    break;
                }
                analyze(request.imgUrl, request.pageUrl, blockTarget, current.serverUrl || DEFAULT_SERVER_URL, sendResponse);
                break;
            }
        }
    }
});

async function getSettings() {
    if (!settings) {
        let data = await storageGet(storageLocal, 'settings');
        settings = normalizeSettings(data.settings);
        await storageSet(storageLocal, { settings });
    }
    return settings;
}

async function updateSettings(updateFn) {
    let current = normalizeSettings((await storageGet(storageLocal, 'settings')).settings);
    updateFn(current);
    settings = normalizeSettings(current);
    await storageSet(storageLocal, { settings });
}

async function getEffectiveSettings(tab) {
    let { urlList, allowSafeDomains } = await storageGet(storageLocal, ['urlList', 'allowSafeDomains']);
    let { pauseForTabs, excludeForTabs } = await storageGet(storageSession, { pauseForTabs: [], excludeForTabs: [] });
    urlList = Array.isArray(urlList) ? urlList : [];
    allowSafeDomains = Array.isArray(allowSafeDomains) ? allowSafeDomains : [];
    pauseForTabs = Array.isArray(pauseForTabs) ? pauseForTabs : [];
    excludeForTabs = Array.isArray(excludeForTabs) ? excludeForTabs : [];

    let effective = Object.assign({}, await getSettings());
    effective.pausedForTab = false;
    effective.excludedForTab = false;
    effective.excluded = false;
    effective.allowSafeDomain = false;
    if (tab) {
        if (pauseForTabs.indexOf(tab.id) != -1)
            effective.pausedForTab = true;
        if (tab.url) {
            let domain = getDomain(tab.url);
            if (domain) {
                effective.allowSafeDomain = allowSafeDomains.some(entry => {
                    entry = (entry || '').toLowerCase();
                    return entry && domain.indexOf(entry) !== -1;
                });
                effective.excludedForTab = excludeForTabs.some(entry => entry && entry.tabId == tab.id && entry.domain == domain);
            }
            let lowerUrl = tab.url.toLowerCase();
            effective.excluded = urlList.some(entry => {
                entry = (entry || '').toLowerCase();
                return entry && lowerUrl.indexOf(entry) != -1;
            });
        }
    }
    return effective;
}

function analyze(imgUrl, pageUrl, blockTarget, serverUrl, sendResponse) {
    let cacheKey = imgUrl.startsWith('data:') ? ('data:' + hash64(imgUrl)) : imgUrl;
    let cached = urlCache.get(cacheKey);
    if (cached) {
        sendResponse(mapResult(cached.result, blockTarget));
        return;
    }
    let pendings = pendingCache.get(cacheKey);
    if (pendings) {
        pendings.push({ sendResponse, blockTarget });
        return;
    }
    pendingCache.set(cacheKey, [{ sendResponse, blockTarget }]);
    ensureWs(serverUrl);
    if (ws_g) ws_g.lastReqTs = Date.now();
    queueReq({ id: ++nextReqId, url: imgUrl, pageUrl, cacheKey });
}

function mapResult(result, blockTarget) {
    if (result === -1) return -1;
    if (blockTarget === 'men') return (result === 1 || result === 3) ? 1 : 0;
    if (blockTarget === 'women') return (result === 2 || result === 3) ? 1 : 0;
    if (blockTarget === 'people') return (result !== 0) ? 1 : 0;
    return 1;
}

function queueReq(req) {
    if (!sendQueue) sendQueue = [];
    sendQueue.push(req);
    if (sendQueue.length >= BATCH_MAX_SIZE)
        flushQueue();
    else if (!flushTimer)
        flushTimer = setTimeout(flushQueue, BATCH_FLUSH_MS);
}

async function flushQueue() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    let queue = sendQueue;
    sendQueue = null;
    if (!queue || !queue.length) return;
    if (!ws_g) {
        failReqs(queue);
        return;
    }
    try { await ws_g.openPromise; } catch (err) { failReqs(queue); return; }
    if (ws_g.readyState !== WebSocket.OPEN) { failReqs(queue); return; }
    let msg = { requests: queue.map(q => ({ id: q.id, url: q.url, pageUrl: q.pageUrl })) };
    try { ws_g.send(JSON.stringify(msg)); } catch (err) { failReqs(queue); return; }
    for (let q of queue) ws_g.pendingReqs.set(q.id, q);
}

function failReqs(queue) {
    for (let q of queue) {
        let waiters = pendingCache.get(q.cacheKey);
        pendingCache.delete(q.cacheKey);
        if (waiters) for (let w of waiters) w.sendResponse(-1);
    }
}

function cachePut(url, result) {
    urlCache.set(url, { result, ts: Date.now() });
    if (urlCache.size > CACHE_MAX) {
        let target = Math.floor(CACHE_MAX * 0.05);
        let it = urlCache.keys();
        for (let i = 0; i < target; i++) urlCache.delete(it.next().value);
    }
}

function ensureWs(serverUrl) {
    if (ws_g && (ws_g.readyState === WebSocket.OPEN || ws_g.readyState === WebSocket.CONNECTING)
        && ws_g.url === serverUrl && Date.now() - ws_g.lastMsg < WS_IDLE_TIMEOUT_MS) {
        return;
    }
    if (ws_g) { try { ws_g.close(); } catch (err) { /* ignore */ } }
    let ws;
    try { ws = new WebSocket(serverUrl); }
    catch (err) {
        recordSwLog('ws-create-error', { message: err && err.message ? err.message : String(err) });
        scheduleReconnect(serverUrl);
        return;
    }
    ws_g = ws;
    ws.url = serverUrl;
    ws.pendingReqs = new Map();
    ws.lastMsg = Date.now();
    ws.lastReqTs = Date.now();
    ws.openPromise = new Promise((resolve, reject) => {
        ws.onopen = () => { reconnectDelay = WS_RECONNECT_MIN_MS; ws.lastMsg = Date.now(); resolve(); };
        ws.onerror = reject;
    });
    ws.onmessage = ev => {
        ws.lastMsg = Date.now();
        let data;
        try { data = JSON.parse(ev.data); } catch (err) { return; }
        if (data.pong) return;
        if (!Array.isArray(data.results)) return;
        for (let resultMsg of data.results) {
            let q = ws.pendingReqs.get(resultMsg.id);
            if (!q) continue;
            ws.pendingReqs.delete(resultMsg.id);
            let result = typeof resultMsg.result === 'number' ? resultMsg.result : -1;
            cachePut(q.cacheKey, result);
            let waiters = pendingCache.get(q.cacheKey);
            pendingCache.delete(q.cacheKey);
            if (waiters) for (let w of waiters) w.sendResponse(mapResult(result, w.blockTarget));
        }
    };
    ws.onclose = () => {
        let stuck = Array.from(ws.pendingReqs.values());
        ws.pendingReqs.clear();
        failReqs(stuck);
        if (ws_g === ws)
            scheduleReconnect(serverUrl);
    };
    ws.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            clearInterval(ws.heartbeat);
            return;
        }
        if (Date.now() - ws.lastReqTs > WS_IDLE_CLOSE_MS) {
            clearInterval(ws.heartbeat);
            if (ws_g === ws) ws_g = null;
            try { ws.close(1000, 'idle'); } catch (err) { /* ignore */ }
            return;
        }
        try { ws.send(JSON.stringify({ ping: 1 })); } catch (err) { /* ignore */ }
    }, WS_HEARTBEAT_MS);
}

function scheduleReconnect(serverUrl) {
    let delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
    setTimeout(() => { ws_g = null; if (sendQueue && sendQueue.length) ensureWs(serverUrl); }, delay);
}

function getDomain(url) {
    let regex = /^\w+:\/\/([\w\.:-]+)/.exec(url || '');
    return regex ? regex[1].toLowerCase() : null;
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
