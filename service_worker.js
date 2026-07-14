if (typeof importScripts === 'function') {
    try { importScripts('shared.js'); }
    catch (err) { /* Tests and older packages can use the local fallbacks below. */ }
}

const wzmShared = (typeof globalThis !== 'undefined' && globalThis.WizmageShared)
    ? globalThis.WizmageShared
    : null;

const wzmChrome = (typeof chrome !== 'undefined') ? chrome : (typeof browser !== 'undefined' ? browser : null);
if (typeof chrome === 'undefined' && wzmChrome) {
    globalThis.chrome = wzmChrome;
}

const storageLocal = wzmChrome && wzmChrome.storage ? wzmChrome.storage.local : null;
const storageSession = (wzmChrome && wzmChrome.storage && wzmChrome.storage.session) ? wzmChrome.storage.session : storageLocal;

const DEFAULT_SERVER_URL = 'wss://aiserver.wizmage.com:5002/ws';
const BATCH_FLUSH_MS = 50;
const BATCH_MAX_SIZE = 32;
const MAX_PENDING_ANALYSES = 512;
const MAX_WAITERS_PER_ANALYSIS = 256;
const MAX_PENDING_WAITERS = 4096;
const MAX_ANALYSIS_URL_CHARS = 512 * 1024;
const MAX_NETWORK_URL_CHARS = 32 * 1024;
const MAX_PENDING_URL_CHARS = 8 * 1024 * 1024;
const MAX_PAGE_URL_CHARS = 16 * 1024;
const CACHE_MAX = 2000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const WS_OPEN_TIMEOUT_MS = 6000;
const WS_RESPONSE_TIMEOUT_MS = 12000;
const WS_IDLE_TIMEOUT_MS = 40000;
const WS_HEARTBEAT_MS = 25000;
const WS_IDLE_CLOSE_MS = 60 * 1000;
const RESPONSE_ROUTES = new Set([
    'wzmPing',
    'getUrlList',
    'getSettings',
    'getAnalyzeResponse',
    'pageUrlChanged',
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
]);

let ws_g = null;
let settings = null;
let nextReqId = 0;
let stateRevision = Date.now();
let settingsUpdateQueue = Promise.resolve();
let storageReconcileQueue = Promise.resolve();
let lastWsCreateErrorLog = 0;
const urlCache = new Map();
const pendingCache = new Map();
const tabRefreshSuppressions = new Map();
const tabNavigationUrls = new Map();
const storageMutationQueues = new Map();
let sendQueue = null;
let flushTimer = null;
let pendingUrlCharacters = 0;
let pendingWaiterCount = 0;

const swLogKey = 'wzmSwLog';
function recordSwLog(event, detail) {
    try {
        const write = storageSet(storageLocal, {
            [swLogKey]: {
                ts: Date.now(),
                event,
                detail: detail || null
            }
        });
        if (write && typeof write.catch === 'function')
            write.catch(() => { /* Logging must never create another unhandled rejection. */ });
    } catch (err) {
        // Ignore logging failures.
    }
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

if (wzmChrome && wzmChrome.tabs && wzmChrome.tabs.onRemoved) {
    wzmChrome.tabs.onRemoved.addListener(async (tabId) => {
        tabNavigationUrls.delete(tabId);
        try {
            await queueStorageMutation(storageSession, { pauseForTabs: [], excludeForTabs: [] }, data => {
                const pauseForTabs = Array.isArray(data.pauseForTabs) ? data.pauseForTabs : [];
                const excludeForTabs = Array.isArray(data.excludeForTabs) ? data.excludeForTabs : [];
                const previousPauseCount = pauseForTabs.length;
                const previousExcludeCount = excludeForTabs.length;
                removeMatches(pauseForTabs, entry => entry == tabId);
                removeMatches(excludeForTabs, entry => entry && entry.tabId == tabId);
                const items = {};
                if (pauseForTabs.length !== previousPauseCount)
                    items.pauseForTabs = pauseForTabs;
                if (excludeForTabs.length !== previousExcludeCount)
                    items.excludeForTabs = excludeForTabs;
                return items;
            }, true);
        } catch (err) {
            recordSwLog('tab-cleanup-error', { message: err && err.message ? err.message : String(err) });
        }
    });
}

if (wzmChrome && wzmChrome.tabs && wzmChrome.tabs.onUpdated) {
    wzmChrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!changeInfo || typeof changeInfo.url !== 'string')
            return;
        void refreshTabForNavigation(tabId, changeInfo.url);
    });
}

function storageGet(area, keys) {
    if (!area) return Promise.reject(new Error('Storage area is unavailable'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const succeed = value => {
            if (settled) return;
            settled = true;
            resolve(value || {});
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error || 'Storage read failed')));
        };
        const callbackResult = value => {
            if (wzmChrome && wzmChrome.runtime && wzmChrome.runtime.lastError) {
                fail(new Error(wzmChrome.runtime.lastError.message || 'Storage read failed'));
                return;
            }
            succeed(value);
        };
        try {
            // Pass the callback on the first and only invocation. Promise-capable
            // implementations may also return a thenable; settlement is de-duplicated.
            const maybePromise = area.get(keys, callbackResult);
            if (maybePromise && typeof maybePromise.then === 'function')
                maybePromise.then(succeed).catch(fail);
        } catch (err) {
            // browser.* implementations can reject a callback argument. That failure
            // happens before the operation, so a promise-form retry is safe.
            try {
                const maybePromise = area.get(keys);
                if (maybePromise && typeof maybePromise.then === 'function')
                    maybePromise.then(succeed).catch(fail);
                else
                    fail(err);
            } catch (retryError) {
                fail(retryError);
            }
        }
    });
}

function storageSet(area, items) {
    if (!area) return Promise.reject(new Error('Storage area is unavailable'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const succeed = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error || 'Storage write failed')));
        };
        const callbackResult = () => {
            if (wzmChrome && wzmChrome.runtime && wzmChrome.runtime.lastError) {
                fail(new Error(wzmChrome.runtime.lastError.message || 'Storage write failed'));
                return;
            }
            succeed();
        };
        try {
            const maybePromise = area.set(items, callbackResult);
            if (maybePromise && typeof maybePromise.then === 'function')
                maybePromise.then(succeed).catch(fail);
        } catch (err) {
            try {
                const maybePromise = area.set(items);
                if (maybePromise && typeof maybePromise.then === 'function')
                    maybePromise.then(succeed).catch(fail);
                else
                    fail(err);
            } catch (retryError) {
                fail(retryError);
            }
        }
    });
}

function storageAreaName(area) {
    return area === storageSession && storageSession !== storageLocal ? 'session' : 'local';
}

function suppressNextTabRefresh(areaName, key) {
    const mapKey = areaName + ':' + key;
    const current = tabRefreshSuppressions.get(mapKey);
    tabRefreshSuppressions.set(mapKey, {
        count: current && current.expires > Date.now() ? current.count + 1 : 1,
        expires: Date.now() + 10000
    });
}

function consumeTabRefreshSuppression(areaName, key) {
    const mapKey = areaName + ':' + key;
    const current = tabRefreshSuppressions.get(mapKey);
    if (!current || current.expires <= Date.now()) {
        tabRefreshSuppressions.delete(mapKey);
        return false;
    }
    if (current.count <= 1)
        tabRefreshSuppressions.delete(mapKey);
    else
        current.count--;
    return true;
}

function releaseTabRefreshSuppression(areaName, key) {
    const mapKey = areaName + ':' + key;
    const current = tabRefreshSuppressions.get(mapKey);
    if (!current)
        return;
    if (current.count <= 1)
        tabRefreshSuppressions.delete(mapKey);
    else
        current.count--;
}

function queueStorageMutation(area, defaults, mutate, suppressContentRefresh) {
    const queueKey = storageAreaName(area);
    const previous = storageMutationQueues.get(queueKey) || Promise.resolve();
    const runMutation = async () => {
        const data = await storageGet(area, defaults);
        const items = await mutate(data || {});
        if (items && Object.keys(items).length) {
            let suppressedKeys = [];
            if (suppressContentRefresh) {
                const areaName = storageAreaName(area);
                suppressedKeys = Object.keys(items);
                for (let key of suppressedKeys)
                    suppressNextTabRefresh(areaName, key);
            }
            try {
                await storageSet(area, items);
            } catch (err) {
                if (suppressContentRefresh) {
                    const areaName = storageAreaName(area);
                    for (let key of suppressedKeys)
                        releaseTabRefreshSuppression(areaName, key);
                }
                throw err;
            }
        }
        return items;
    };
    const mutation = previous.then(runMutation, runMutation);
    storageMutationQueues.set(queueKey, mutation.catch(() => { /* Keep later storage mutations usable. */ }));
    return mutation;
}

function sendRuntimeMessage(message) {
    if (!wzmChrome || !wzmChrome.runtime || !wzmChrome.runtime.sendMessage)
        return;
    try {
        const maybePromise = wzmChrome.runtime.sendMessage(message);
        if (maybePromise && typeof maybePromise.catch === 'function')
            maybePromise.catch(() => { /* No extension page may be listening. */ });
    } catch (err) {
        // The receiving extension page may have closed between the change and this broadcast.
    }
}

function queryTabs() {
    if (!wzmChrome || !wzmChrome.tabs || !wzmChrome.tabs.query)
        return Promise.resolve([]);
    return new Promise(resolve => {
        let settled = false;
        const finish = tabs => {
            if (settled) return;
            settled = true;
            resolve(Array.isArray(tabs) ? tabs : []);
        };
        try {
            const maybePromise = wzmChrome.tabs.query({}, finish);
            if (maybePromise && typeof maybePromise.then === 'function')
                maybePromise.then(finish).catch(() => finish([]));
        } catch (err) {
            try {
                const maybePromise = wzmChrome.tabs.query({});
                if (maybePromise && typeof maybePromise.then === 'function')
                    maybePromise.then(finish).catch(() => finish([]));
                else
                    finish([]);
            } catch (retryError) {
                finish([]);
            }
        }
    });
}

function sendTabMessage(tabId, message) {
    if (!wzmChrome || !wzmChrome.tabs || !wzmChrome.tabs.sendMessage || typeof tabId !== 'number')
        return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            // Reading lastError prevents expected "no receiver" errors from leaking.
            void (wzmChrome.runtime && wzmChrome.runtime.lastError);
            resolve();
        };
        try {
            const maybePromise = wzmChrome.tabs.sendMessage(tabId, message, finish);
            if (maybePromise && typeof maybePromise.then === 'function')
                maybePromise.then(finish).catch(finish);
        } catch (err) {
            try {
                const maybePromise = wzmChrome.tabs.sendMessage(tabId, message);
                if (maybePromise && typeof maybePromise.then === 'function')
                    maybePromise.then(finish).catch(finish);
                else
                    finish();
            } catch (retryError) {
                finish();
            }
        }
    });
}

async function refreshTabForNavigation(tabId, pageUrl) {
    if (typeof tabId !== 'number')
        return false;
    pageUrl = String(pageUrl || '').slice(0, MAX_PAGE_URL_CHARS);
    if (!pageUrl || tabNavigationUrls.get(tabId) === pageUrl)
        return false;
    tabNavigationUrls.set(tabId, pageUrl);
    await sendTabMessage(tabId, {
        r: 'refreshSettings',
        changedKeys: ['pageUrl'],
        pageUrl,
        revision: ++stateRevision
    });
    return true;
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
    if (wzmShared && wzmShared.DEFAULT_SETTINGS)
        return Object.assign({}, wzmShared.DEFAULT_SETTINGS);
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
    if (wzmShared && wzmShared.legacyUnwantedToBlockTarget)
        return wzmShared.legacyUnwantedToBlockTarget(unwanted);
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
    if (wzmShared && wzmShared.normalizeSettings)
        return wzmShared.normalizeSettings(raw);
    const source = (raw && typeof raw === 'object') ? raw : {};
    let normalized = Object.assign(defaultSettings(), source);
    if (!source.blockTarget)
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

function parseServerUrl(value) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate || candidate.length > 2048)
        return null;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? parsed.href : null;
    } catch (err) {
        return null;
    }
}

function getServerUrl(value) {
    return parseServerUrl(value && value.serverUrl) || DEFAULT_SERVER_URL;
}

function settingsAffectContent(previous, next) {
    previous = previous || {};
    next = next || {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    keys.delete('closeOnClick');
    for (const key of keys) {
        if (previous[key] !== next[key])
            return true;
    }
    return false;
}

async function broadcastStateChange(changedKeys, refreshContentTabs) {
    const revision = ++stateRevision;
    const keys = Array.from(new Set(changedKeys || []));
    const globalSettings = Object.assign({}, await getSettings());

    // Extension pages can use this richer notification without another storage read.
    sendRuntimeMessage({
        r: 'settingsChanged',
        settings: globalSettings,
        changedKeys: keys,
        revision
    });
    // Retain the notification consumed by the existing options page.
    if (keys.indexOf('urlList') !== -1)
        sendRuntimeMessage({ r: 'urlListModified', revision });

    if (!refreshContentTabs)
        return;

    // Content scripts need tab-specific effective settings, so ask each frame to refresh
    // through the existing getSettings route rather than broadcasting global-only values.
    const tabs = await queryTabs();
    const message = { r: 'refreshSettings', changedKeys: keys, revision };
    await Promise.all(tabs.map(tab => sendTabMessage(tab && tab.id, message)));
}

async function reconcileStorageChange(changes, areaName) {
    if (!changes || (areaName !== 'local' && areaName !== 'session'))
        return;

    const changedKeys = [];
    const contentRelevantKeys = new Set();
    if (areaName === 'local') {
        if (changes.settings) {
            const previous = normalizeSettings(changes.settings.oldValue);
            const next = normalizeSettings(changes.settings.newValue);
            settings = next;
            changedKeys.push('settings');
            if (settingsAffectContent(previous, next))
                contentRelevantKeys.add('settings');
            if (getServerUrl(previous) !== getServerUrl(next)) {
                clearAnalyzeCache();
                abortAnalyzeRequests('server-url-changed');
            }
        }
        if (changes.urlList)
            changedKeys.push('urlList');
        if (changes.allowSafeDomains)
            changedKeys.push('allowSafeDomains');
    }
    if (changes.pauseForTabs)
        changedKeys.push('pauseForTabs');
    if (changes.excludeForTabs)
        changedKeys.push('excludeForTabs');

    for (const key of changedKeys) {
        if (key !== 'settings')
            contentRelevantKeys.add(key);
    }

    if (changedKeys.length) {
        const refreshContentTabs = changedKeys.map(key => ({
            key,
            unsuppressed: !consumeTabRefreshSuppression(areaName, key)
        })).some(item => item.unsuppressed && contentRelevantKeys.has(item.key));
        await broadcastStateChange(changedKeys, refreshContentTabs);
    }
}

if (wzmChrome && wzmChrome.storage && wzmChrome.storage.onChanged) {
    wzmChrome.storage.onChanged.addListener((changes, areaName) => {
        const reconcile = () => reconcileStorageChange(changes, areaName);
        const run = storageReconcileQueue.then(reconcile, reconcile);
        storageReconcileQueue = run.catch(err => {
            recordSwLog('storage-change-error', {
                message: err && err.message ? err.message : String(err)
            });
        });
    });
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
    const shouldRespond = !!request && typeof request.r === 'string' && RESPONSE_ROUTES.has(request.r);

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
                let effectiveTab = request.tab || (sender && sender.tab);
                if (!request.tab && effectiveTab && typeof request.pageUrl === 'string' && request.pageUrl) {
                    effectiveTab = Object.assign({}, effectiveTab, {
                        url: request.pageUrl.slice(0, MAX_PAGE_URL_CHARS)
                    });
                }
                let effective = await getEffectiveSettings(effectiveTab);
                sendResponse(effective);
                break;
            }
            case 'pageUrlChanged': {
                const tabId = sender && sender.tab && sender.tab.id;
                const pageUrl = typeof request.url === 'string'
                    ? request.url
                    : sender && sender.tab && sender.tab.url;
                const refreshed = await refreshTabForNavigation(tabId, pageUrl);
                sendResponse({ ok: true, refreshed });
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
                let url = request.domainOnly ? getDomain(request.url) : String(request.url || '').trim().toLowerCase();
                if (!url || (!request.domainOnly && !isValidUrlListEntry(url))) {
                    sendResponse({ ok: false });
                    break;
                }
                await queueStorageMutation(storageLocal, { urlList: [] }, data => {
                    const urlList = Array.isArray(data.urlList) ? data.urlList : [];
                    addUnique(urlList, url);
                    return { urlList };
                });
                sendResponse({ ok: true });
                break;
            }
            case 'urlListRemove': {
                await queueStorageMutation(storageLocal, { urlList: [] }, data => {
                    const urlList = Array.isArray(data.urlList) ? data.urlList : [];
                    if (request.url) {
                        let lowerUrl = request.url.trim().toLowerCase();
                        removeMatches(urlList, entry => {
                            let lowerEntry = String(entry || '').trim().toLowerCase();
                            return lowerEntry === lowerUrl || urlMatchesListEntry(request.url, entry);
                        });
                    } else if (request.index >= 0 && request.index < urlList.length) {
                        urlList.splice(request.index, 1);
                    }
                    return { urlList };
                });
                sendResponse({ ok: true });
                break;
            }
            case 'setUrlList':
                if (!Array.isArray(request.urlList) || request.urlList.some(entry => !isValidUrlListEntry(entry))) {
                    sendResponse({ ok: false });
                    break;
                }
                await queueStorageMutation(storageLocal, { urlList: [] }, () => ({
                    urlList: request.urlList.map(entry => String(entry).trim().toLowerCase())
                }));
                sendResponse({ ok: true });
                break;
            case 'pause':
                await updateSettings(s => { s.paused = !!request.toggle; });
                sendResponse({ ok: true });
                break;
            case 'pauseForTab': {
                await queueStorageMutation(storageSession, { pauseForTabs: [] }, data => {
                    const pauseForTabs = Array.isArray(data.pauseForTabs) ? data.pauseForTabs : [];
                    if (request.toggle)
                        addUnique(pauseForTabs, request.tabId);
                    else
                        removeMatches(pauseForTabs, entry => entry == request.tabId);
                    return { pauseForTabs };
                });
                sendResponse({ ok: true });
                break;
            }
            case 'excludeForTab': {
                let tab = request.tab || {};
                let domain = getDomain(tab.url);
                if (!domain || tab.id == null) {
                    sendResponse({ ok: false });
                    break;
                }
                await queueStorageMutation(storageSession, { excludeForTabs: [] }, data => {
                    const excludeForTabs = Array.isArray(data.excludeForTabs) ? data.excludeForTabs : [];
                    if (request.toggle) {
                        let exists = excludeForTabs.some(entry => entry && entry.tabId == tab.id && normalizeDomainEntry(entry.domain) === domain);
                        if (!exists)
                            excludeForTabs.push({ tabId: tab.id, domain });
                    }
                    else {
                        removeMatches(excludeForTabs, entry => entry && entry.tabId == tab.id && normalizeDomainEntry(entry.domain) === domain);
                    }
                    return { excludeForTabs };
                });
                sendResponse({ ok: true });
                break;
            }
            case 'allowSafeForDomain': {
                let domain = normalizeDomainEntry(request.domain) || getDomain(request.url);
                if (!domain) {
                    sendResponse({ ok: false });
                    break;
                }
                await queueStorageMutation(storageLocal, { allowSafeDomains: [] }, data => {
                    const allowSafeDomains = Array.isArray(data.allowSafeDomains) ? data.allowSafeDomains : [];
                    if (request.toggle)
                        addUnique(allowSafeDomains, domain);
                    else
                        removeMatches(allowSafeDomains, entry => normalizeDomainEntry(entry) === domain);
                    return { allowSafeDomains };
                });
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
                {
                    const serverUrl = parseServerUrl(request.serverUrl);
                    if (!serverUrl) {
                        sendResponse({ ok: false });
                        break;
                    }
                    await updateSettings(s => { s.serverUrl = serverUrl; });
                }
                sendResponse({ ok: true });
                break;
            case 'getAnalyzeResponse': {
                if (typeof request.imgUrl !== 'string'
                    || !request.imgUrl
                    || !isRemoteImageCandidate(request.imgUrl)
                    || typeof WebSocket === 'undefined') {
                    sendResponse(-1);
                    break;
                }
                let current = await getSettings();
                let blockTarget = current.blockTarget || 'all';
                if (blockTarget === 'all') {
                    sendResponse(1);
                    break;
                }
                analyze(
                    request.imgUrl,
                    String(request.pageUrl || '').slice(0, MAX_PAGE_URL_CHARS),
                    blockTarget,
                    getServerUrl(current),
                    sendResponse
                );
                break;
            }
        }
    }
});

async function getSettings() {
    if (!settings) {
        let data = await storageGet(storageLocal, 'settings');
        settings = normalizeSettings(data.settings);
    }
    return settings;
}

function updateSettings(updateFn) {
    const runUpdate = async () => {
        let current = normalizeSettings((await storageGet(storageLocal, 'settings')).settings);
        const previousServerUrl = getServerUrl(current);
        updateFn(current);
        const nextSettings = normalizeSettings(current);
        if (previousServerUrl !== getServerUrl(nextSettings)) {
            clearAnalyzeCache();
            abortAnalyzeRequests('server-url-changed');
        }
        await storageSet(storageLocal, { settings: nextSettings });
        settings = nextSettings;
    };
    const update = settingsUpdateQueue.then(runUpdate, runUpdate);
    settingsUpdateQueue = update.catch(() => { /* Keep later settings mutations usable. */ });
    return update;
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
                    return hostnameMatchesDomain(domain, entry);
                });
                effective.excludedForTab = excludeForTabs.some(entry => entry && entry.tabId == tab.id && normalizeDomainEntry(entry.domain) === domain);
            }
            effective.excluded = urlList.some(entry => urlMatchesListEntry(tab.url, entry));
        }
    }
    return effective;
}

function analyze(imgUrl, pageUrl, blockTarget, serverUrl, sendResponse) {
    let cacheKey = imgUrl.startsWith('data:') ? ('data:' + hash64(imgUrl)) : imgUrl;
    let cached = cacheGet(cacheKey);
    if (cached !== null) {
        sendResponse(mapResult(cached.result, blockTarget));
        return;
    }
    let pending = pendingCache.get(cacheKey);
    if (pending) {
        if (pending.waiters.length >= MAX_WAITERS_PER_ANALYSIS || pendingWaiterCount >= MAX_PENDING_WAITERS)
            sendResponse(-2);
        else {
            pending.waiters.push({ sendResponse, blockTarget });
            pendingWaiterCount++;
        }
        return;
    }
    if (pendingCache.size >= MAX_PENDING_ANALYSES || pendingWaiterCount >= MAX_PENDING_WAITERS) {
        sendResponse(-2);
        return;
    }
    if (pendingUrlCharacters + imgUrl.length > MAX_PENDING_URL_CHARS) {
        sendResponse(-2);
        return;
    }
    const request = {
        id: ++nextReqId,
        url: imgUrl,
        pageUrl,
        cacheKey,
        serverUrl,
        completed: false,
        socket: null,
        requestTimer: null,
        responseTimer: null
    };
    request.urlLength = imgUrl.length;
    pendingUrlCharacters += request.urlLength;
    pendingCache.set(cacheKey, {
        request,
        waiters: [{ sendResponse, blockTarget }]
    });
    pendingWaiterCount++;
    request.requestTimer = setTimeout(() => completeRequest(request, -1, false), REQUEST_TIMEOUT_MS);
    queueReq(request);
}

function isRemoteImageCandidate(value) {
    if (wzmShared && wzmShared.isRemoteImageCandidate)
        return wzmShared.isRemoteImageCandidate(value, MAX_ANALYSIS_URL_CHARS, MAX_NETWORK_URL_CHARS);
    const candidate = String(value || '');
    if (/^data:image\//i.test(candidate))
        return candidate.length <= MAX_ANALYSIS_URL_CHARS;
    if (candidate.length > MAX_NETWORK_URL_CHARS)
        return false;
    const parsed = parseUrl(candidate, false);
    return !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

function mapResult(result, blockTarget) {
    if (result === -2) return -2;
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
        void flushQueue();
    else if (!flushTimer)
        flushTimer = setTimeout(() => { void flushQueue(); }, BATCH_FLUSH_MS);
}

async function flushQueue() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    let queue = sendQueue;
    sendQueue = null;
    queue = (queue || []).filter(request => request && !request.completed);
    if (!queue.length) return;

    const serverUrl = queue[0].serverUrl;
    const wrongServer = queue.filter(request => request.serverUrl !== serverUrl);
    if (wrongServer.length)
        failReqs(wrongServer);
    queue = queue.filter(request => request.serverUrl === serverUrl && !request.completed);
    if (!queue.length) return;

    const ws = ensureWs(serverUrl);
    if (!ws) {
        failReqs(queue);
        return;
    }
    try { await ws.openPromise; } catch (err) { failReqs(queue); return; }
    queue = queue.filter(request => !request.completed);
    if (!queue.length) return;
    if (ws.retired || ws_g !== ws || ws.readyState !== WebSocket.OPEN) {
        failReqs(queue);
        return;
    }

    let msg = { requests: queue.map(q => ({ id: q.id, url: q.url, pageUrl: q.pageUrl })) };
    for (let q of queue) {
        q.socket = ws;
        ws.pendingReqs.set(q.id, q);
    }
    try {
        ws.send(JSON.stringify(msg));
    } catch (err) {
        retireSocket(ws, 'send-error', true);
        return;
    }
    ws.lastReqTs = Date.now();
    for (let q of queue) {
        q.responseTimer = setTimeout(() => completeRequest(q, -1, false), WS_RESPONSE_TIMEOUT_MS);
    }
}

function failReqs(queue) {
    for (let q of queue || [])
        completeRequest(q, -1, false);
}

function completeRequest(request, result, cacheable) {
    if (!request || request.completed)
        return;
    request.completed = true;
    if (request.requestTimer)
        clearTimeout(request.requestTimer);
    if (request.responseTimer)
        clearTimeout(request.responseTimer);
    if (request.socket && request.socket.pendingReqs)
        request.socket.pendingReqs.delete(request.id);

    const cacheKey = request.cacheKey;
    const pending = pendingCache.get(cacheKey);
    if (pending && pending.request === request) {
        pendingCache.delete(cacheKey);
        pendingWaiterCount = Math.max(0, pendingWaiterCount - pending.waiters.length);
        if (cacheable)
            cachePut(cacheKey, result);
        for (let waiter of pending.waiters) {
            try { waiter.sendResponse(mapResult(result, waiter.blockTarget)); }
            catch (err) { /* The requesting frame may have navigated away. */ }
        }
    }

    // Drop potentially large data URLs as soon as their request is settled.
    request.url = null;
    request.pageUrl = null;
    request.socket = null;
    pendingUrlCharacters = Math.max(0, pendingUrlCharacters - (request.urlLength || 0));
    request.urlLength = 0;

    if (ws_g && !ws_g.retired && ws_g.readyState === WebSocket.CONNECTING
        && pendingCache.size === 0 && (!sendQueue || sendQueue.every(item => item.completed))) {
        retireSocket(ws_g, 'no-pending-requests', true);
    }
}

function cacheGet(cacheKey) {
    const cached = urlCache.get(cacheKey);
    if (!cached)
        return null;
    if (Date.now() - cached.ts >= CACHE_TTL_MS) {
        urlCache.delete(cacheKey);
        return null;
    }
    // Refresh insertion order for bounded least-recently-used eviction.
    urlCache.delete(cacheKey);
    urlCache.set(cacheKey, cached);
    return cached;
}

function cachePut(cacheKey, result) {
    if (![0, 1, 2, 3].includes(result))
        return;
    urlCache.delete(cacheKey);
    urlCache.set(cacheKey, { result, ts: Date.now() });
    while (urlCache.size > CACHE_MAX) {
        const oldest = urlCache.keys().next();
        if (oldest.done)
            break;
        urlCache.delete(oldest.value);
    }
}

function clearAnalyzeCache() {
    urlCache.clear();
}

function ensureWs(serverUrl) {
    if (typeof WebSocket === 'undefined')
        return null;

    const existing = ws_g;
    if (existing && !existing.retired && existing.url === serverUrl) {
        if (existing.readyState === WebSocket.CONNECTING)
            return existing;
        if (existing.readyState === WebSocket.OPEN && Date.now() - existing.lastMsg < WS_IDLE_TIMEOUT_MS)
            return existing;
    }
    if (existing)
        retireSocket(existing, 'replace-socket', true);

    let ws;
    try { ws = new WebSocket(serverUrl); }
    catch (err) {
        if (Date.now() - lastWsCreateErrorLog >= 60000) {
            lastWsCreateErrorLog = Date.now();
            recordSwLog('ws-create-error', { message: err && err.message ? err.message : String(err) });
        }
        return null;
    }
    ws_g = ws;
    ws.url = serverUrl;
    ws.pendingReqs = new Map();
    ws.lastMsg = Date.now();
    ws.lastReqTs = Date.now();
    ws.retired = false;
    ws.openTimer = null;
    ws.maintenanceTimer = null;

    let openSettled = false;
    ws.openPromise = new Promise((resolve, reject) => {
        ws.resolveOpen = () => {
            if (openSettled) return;
            openSettled = true;
            resolve();
        };
        ws.rejectOpen = reason => {
            if (openSettled) return;
            openSettled = true;
            reject(reason instanceof Error ? reason : new Error(String(reason || 'WebSocket failed')));
        };
    });
    // A socket can fail before flushQueue reaches its await; attach a rejection handler now.
    ws.openPromise.catch(() => { /* flushQueue handles the failure for its own batch. */ });
    ws.openTimer = setTimeout(() => retireSocket(ws, 'open-timeout', true), WS_OPEN_TIMEOUT_MS);
    ws.onopen = () => {
        if (ws.retired) {
            try { ws.close(); } catch (err) { /* ignore */ }
            return;
        }
        if (ws.openTimer) {
            clearTimeout(ws.openTimer);
            ws.openTimer = null;
        }
        ws.lastMsg = Date.now();
        ws.lastReqTs = Date.now();
        ws.resolveOpen();
        scheduleSocketMaintenance(ws);
    };
    ws.onerror = () => retireSocket(ws, 'socket-error', true);
    ws.onmessage = ev => {
        if (ws.retired)
            return;
        ws.lastMsg = Date.now();
        let data;
        try { data = JSON.parse(ev.data); } catch (err) { return; }
        if (data.pong) return;
        if (!Array.isArray(data.results)) return;
        for (let resultMsg of data.results) {
            let q = ws.pendingReqs.get(resultMsg.id);
            if (!q) continue;
            let result = [0, 1, 2, 3].includes(resultMsg.result) ? resultMsg.result : -1;
            completeRequest(q, result, result !== -1);
        }
    };
    ws.onclose = () => retireSocket(ws, 'socket-closed', false);
    return ws;
}

function scheduleSocketMaintenance(ws) {
    if (!ws || ws.retired || ws.readyState !== WebSocket.OPEN)
        return;
    if (ws.maintenanceTimer)
        clearTimeout(ws.maintenanceTimer);
    const scheduledAt = Date.now();
    let delay = Math.min(WS_HEARTBEAT_MS, Math.max(1, WS_IDLE_TIMEOUT_MS - (scheduledAt - ws.lastMsg)));
    if (ws.pendingReqs.size === 0)
        delay = Math.min(delay, Math.max(1, WS_IDLE_CLOSE_MS - (scheduledAt - ws.lastReqTs)));
    ws.maintenanceTimer = setTimeout(() => {
        ws.maintenanceTimer = null;
        if (ws.retired || ws.readyState !== WebSocket.OPEN)
            return;
        const now = Date.now();
        if (ws.pendingReqs.size === 0 && now - ws.lastReqTs >= WS_IDLE_CLOSE_MS) {
            retireSocket(ws, 'idle', true);
            return;
        }
        if (now - ws.lastMsg >= WS_IDLE_TIMEOUT_MS) {
            retireSocket(ws, 'stale', true);
            return;
        }
        try { ws.send(JSON.stringify({ ping: 1 })); }
        catch (err) {
            retireSocket(ws, 'heartbeat-error', true);
            return;
        }
        scheduleSocketMaintenance(ws);
    }, delay);
}

function retireSocket(ws, reason, closeNative) {
    if (!ws || ws.retired)
        return;
    ws.retired = true;
    if (ws_g === ws)
        ws_g = null;
    if (ws.openTimer) {
        clearTimeout(ws.openTimer);
        ws.openTimer = null;
    }
    if (ws.maintenanceTimer) {
        clearTimeout(ws.maintenanceTimer);
        ws.maintenanceTimer = null;
    }
    if (ws.rejectOpen)
        ws.rejectOpen(new Error(reason || 'WebSocket closed'));

    const stuck = ws.pendingReqs ? Array.from(ws.pendingReqs.values()) : [];
    if (ws.pendingReqs)
        ws.pendingReqs.clear();
    ws.onopen = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onclose = null;
    if (closeNative && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        try { ws.close(1000, reason || 'closed'); } catch (err) { /* ignore */ }
    }
    failReqs(stuck);
}

function abortAnalyzeRequests(reason) {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    const queued = sendQueue || [];
    sendQueue = null;
    failReqs(queued);
    if (ws_g)
        retireSocket(ws_g, reason || 'aborted', true);
    for (let pending of Array.from(pendingCache.values()))
        completeRequest(pending.request, -1, false);
}

function parseUrl(value, allowDomainOnly) {
    if (typeof value !== 'string' || !value.trim())
        return null;
    let candidate = value.trim();
    if (allowDomainOnly && !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate))
        candidate = 'https://' + candidate.replace(/^\/+/, '');
    if (wzmShared && wzmShared.parseUrl)
        return wzmShared.parseUrl(candidate);
    try {
        return new URL(candidate);
    } catch (err) {
        return null;
    }
}

function cleanHostname(hostname) {
    const cleaned = String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\*\./, '');
    if (wzmShared && wzmShared.normalizeHost)
        return wzmShared.normalizeHost(cleaned);
    return cleaned.replace(/^\.+|\.+$/g, '');
}

function normalizeDomainEntry(value) {
    let candidate = String(value || '').trim();
    candidate = candidate.replace(/^([a-z][a-z0-9+.-]*:\/\/)\*\./i, '$1').replace(/^\*\./, '');
    const parsed = parseUrl(candidate, true);
    return parsed ? cleanHostname(parsed.hostname) : null;
}

function hostnameMatchesDomain(hostname, storedDomain) {
    const host = cleanHostname(hostname);
    const entryHost = normalizeDomainEntry(storedDomain);
    if (!host || !entryHost)
        return false;
    if (wzmShared && wzmShared.hostMatches)
        return wzmShared.hostMatches(host, entryHost);
    return host === entryHost || host.endsWith('.' + entryHost);
}

function urlMatchesListEntry(url, storedEntry) {
    if (wzmShared && wzmShared.urlMatchesEntry)
        return wzmShared.urlMatchesEntry(url, storedEntry);
    const current = parseUrl(url, false);
    if (!current || typeof storedEntry !== 'string' || !storedEntry.trim())
        return false;

    const rawEntry = storedEntry.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawEntry);
    const parsedEntry = parseUrl(rawEntry, true);
    if (!parsedEntry || !hostnameMatchesDomain(current.hostname, parsedEntry.hostname))
        return false;

    if (hasScheme && current.protocol.toLowerCase() !== parsedEntry.protocol.toLowerCase())
        return false;
    if ((hasScheme || parsedEntry.port) && current.port !== parsedEntry.port)
        return false;

    const authorityEnd = hasScheme
        ? rawEntry.indexOf('/', rawEntry.indexOf('://') + 3)
        : rawEntry.indexOf('/');
    const hasExplicitSuffix = authorityEnd !== -1 || rawEntry.indexOf('?') !== -1 || rawEntry.indexOf('#') !== -1;
    if (!hasExplicitSuffix)
        return true;

    const entrySuffix = (parsedEntry.pathname + parsedEntry.search + parsedEntry.hash).toLowerCase();
    const currentSuffix = (current.pathname + current.search + current.hash).toLowerCase();
    return currentSuffix.startsWith(entrySuffix);
}

function isValidUrlListEntry(entry) {
    if (wzmShared && wzmShared.isValidUrlListEntry)
        return wzmShared.isValidUrlListEntry(entry);
    const raw = String(entry || '').trim();
    if (!raw)
        return false;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const withoutWildcard = hasScheme
        ? raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)\*\./i, '$1')
        : raw.replace(/^\*\./, '');
    const candidate = hasScheme ? withoutWildcard : 'https://' + withoutWildcard.replace(/^\/+/, '');
    const parsed = parseUrl(candidate, false);
    return !!(parsed && parsed.hostname);
}

function getDomain(url) {
    const parsed = parseUrl(url, false);
    return parsed ? cleanHostname(parsed.hostname) : null;
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
