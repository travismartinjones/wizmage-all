var wzmBrowser = typeof browser !== 'undefined' ? browser : null;
var wzmChrome = typeof chrome !== 'undefined' ? chrome : null;
var wzmRuntime = (wzmChrome && wzmChrome.runtime) || (wzmBrowser && wzmBrowser.runtime) || null;
var wzmTabs = (wzmChrome && wzmChrome.tabs) || (wzmBrowser && wzmBrowser.tabs) || null;
var wzmUsePromiseApi = !!wzmBrowser && (!wzmChrome || wzmChrome === wzmBrowser);
var wzmStorageLocal = (wzmChrome && wzmChrome.storage && wzmChrome.storage.local) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.local) || null;
var wzmStorageSession = (wzmChrome && wzmChrome.storage && wzmChrome.storage.session) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.session) || wzmStorageLocal;
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
function wzmStorageSet(area, items, callback) {
    if (!area || !area.set) {
        if (callback) callback();
        return;
    }
    try {
        var maybePromise = area.set(items);
        if (maybePromise && typeof maybePromise.then === 'function') {
            if (callback) maybePromise.then(callback).catch(function () { callback(); });
            return maybePromise;
        }
    } catch (err) {
        // fall through
    }
    try {
        return area.set(items, callback);
    } catch (err) {
        if (callback) callback();
    }
}
function wzmStorageGetLocal(keys, callback) {
    return wzmStorageGet(wzmStorageLocal, keys, callback);
}
function wzmStorageSetLocal(items, callback) {
    return wzmStorageSet(wzmStorageLocal, items, callback);
}
function wzmStorageGetSession(keys, callback) {
    return wzmStorageGet(wzmStorageSession, keys, callback);
}
function wzmStorageSetSession(items, callback) {
    return wzmStorageSet(wzmStorageSession, items, callback);
}
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
function wzmGetDomain(url) {
    let regex = /^\w+:\/\/([\w\.:-]+)/.exec(url || '');
    return regex ? regex[1].toLowerCase() : null;
}
function wzmAddUnique(list, value) {
    if (value && list.indexOf(value) === -1)
        list.push(value);
}
function wzmRemoveMatches(list, predicate) {
    for (let i = 0; i < list.length; i++) {
        if (predicate(list[i])) {
            list.splice(i, 1);
            i--;
        }
    }
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
function wzmGetPopupSettings(activeTab, callback) {
    let responded = false;
    wzmSendMessage({ r: 'getSettings', tab: activeTab }, function (settings) {
        if (responded)
            return;
        responded = true;
        if (settings && typeof settings === 'object') {
            callback(settings);
            return;
        }
        wzmGetSettingsFromStorage(activeTab, callback);
    });
    setTimeout(function () {
        if (responded)
            return;
        responded = true;
        wzmGetSettingsFromStorage(activeTab, callback);
    }, 400);
}
function wzmGetSettingsFromStorage(activeTab, callback) {
    wzmStorageGetLocal(['settings', 'urlList', 'allowSafeDomains'], function (data) {
        wzmStorageGetSession({ pauseForTabs: [], excludeForTabs: [] }, function (sessionData) {
            let s = data && data.settings ? data.settings : wzmDefaultSettings();
            if (s && typeof s === 'object') {
                s = Object.assign(wzmDefaultSettings(), s);
            } else {
                s = wzmDefaultSettings();
            }
            s.pausedForTab = false;
            s.excludedForTab = false;
            s.excluded = false;
            s.allowSafeDomain = false;
            let urlList = (data && Array.isArray(data.urlList)) ? data.urlList : [];
            let allowSafeDomains = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
            let pauseForTabs = (sessionData && Array.isArray(sessionData.pauseForTabs)) ? sessionData.pauseForTabs : [];
            let excludeForTabs = (sessionData && Array.isArray(sessionData.excludeForTabs)) ? sessionData.excludeForTabs : [];
            if (activeTab && activeTab.id != null && pauseForTabs.indexOf(activeTab.id) != -1)
                s.pausedForTab = true;
            if (activeTab && activeTab.url) {
                s.excluded = wzmUrlMatchesList(activeTab.url, urlList);
                let domain = wzmGetDomain(activeTab.url);
                if (domain) {
                    s.allowSafeDomain = wzmDomainMatchesList(domain, allowSafeDomains);
                    for (let i = 0; i < excludeForTabs.length; i++) {
                        let entry = excludeForTabs[i];
                        if (entry && entry.tabId == activeTab.id && entry.domain == domain) {
                            s.excludedForTab = true;
                            break;
                        }
                    }
                }
            }
            callback(s);
        });
    });
}
function wzmUpdateSettingsLocal(updateFn, done) {
    wzmStorageGetLocal(['settings'], function (data) {
        let s = data && data.settings ? data.settings : wzmDefaultSettings();
        updateFn(s);
        wzmStorageSetLocal({ settings: s }, done);
    });
}
function wzmUpdateUrlListLocal(updateFn, done) {
    wzmStorageGetLocal(['urlList'], function (data) {
        let list = (data && Array.isArray(data.urlList)) ? data.urlList : [];
        updateFn(list);
        wzmStorageSetLocal({ urlList: list }, done);
    });
}
function wzmUpdateAllowSafeDomainsLocal(updateFn, done) {
    wzmStorageGetLocal(['allowSafeDomains'], function (data) {
        let list = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
        updateFn(list);
        wzmStorageSetLocal({ allowSafeDomains: list }, done);
    });
}
function wzmUpdatePauseForTabsLocal(tabId, toggle, done) {
    wzmStorageGetSession({ pauseForTabs: [] }, function (data) {
        let list = (data && Array.isArray(data.pauseForTabs)) ? data.pauseForTabs : [];
        if (toggle)
            wzmAddUnique(list, tabId);
        else
            wzmRemoveMatches(list, entry => entry == tabId);
        wzmStorageSetSession({ pauseForTabs: list }, done);
    });
}
function wzmUpdateExcludeForTabsLocal(tab, toggle, done) {
    wzmStorageGetSession({ excludeForTabs: [] }, function (data) {
        let list = (data && Array.isArray(data.excludeForTabs)) ? data.excludeForTabs : [];
        let domain = tab && wzmGetDomain(tab.url);
        if (!domain) {
            if (done) done();
            return;
        }
        if (toggle) {
            let exists = false;
            for (let i = 0; i < list.length; i++) {
                let entry = list[i];
                if (entry && entry.tabId == tab.id && entry.domain == domain) {
                    exists = true;
                    break;
                }
            }
            if (!exists)
                list.push({ tabId: tab.id, domain: domain });
        }
        else {
            wzmRemoveMatches(list, entry => entry && entry.tabId == tab.id && entry.domain == domain);
        }
        wzmStorageSetSession({ excludeForTabs: list }, done);
    });
}
function wzmTabsQuery(queryInfo, callback) {
    if (!wzmTabs || !wzmTabs.query) {
        if (callback) callback([]);
        return;
    }
    if (wzmUsePromiseApi) {
        var p = wzmTabs.query(queryInfo);
        if (callback) p.then(callback).catch(function () { callback([]); });
        return p;
    }
    return wzmTabs.query(queryInfo, callback);
}
function wzmTabsSendMessage(tabId, message, callback) {
    if (!wzmTabs || !wzmTabs.sendMessage) {
        if (callback) callback();
        return;
    }
    if (wzmUsePromiseApi) {
        var p = wzmTabs.sendMessage(tabId, message);
        if (callback) p.then(callback).catch(function () { callback(); });
        return p;
    }
    return wzmTabs.sendMessage(tabId, message, callback);
}
function wzmTabsReload(tabId) {
    if (!wzmTabs || !wzmTabs.reload)
        return;
    if (wzmUsePromiseApi) {
        try {
            return wzmTabs.reload(tabId);
        } catch (err) {
            return;
        }
    }
    try {
        return wzmTabs.reload(tabId);
    } catch (err) {
        // ignore
    }
}
wzmTabsQuery({ active: true, currentWindow: true }, function (tabs) {
    var activeTab = tabs[0], closeOnClick, currentSettings;
    var excludeAlwaysBlock = document.getElementById('excludeAlwaysBlock');
    var excludeAlwaysBlockW = document.getElementById('exclude-always-block-w');
    function showImages() {
        if (!activeTab)
            return;
        wzmTabsSendMessage(activeTab.id, { r: 'showImages' });
    }
    function restartImages() {
        if (!activeTab)
            return;
        wzmTabsSendMessage(activeTab.id, { r: 'restart' }, function (resp) {
            if (!resp || !resp.ok) {
                wzmTabsReload(activeTab.id);
            }
        });
    }
    function refreshSettings() {
        if (!activeTab)
            return;
        wzmTabsSendMessage(activeTab.id, { r: 'refreshSettings' }, function (resp) {
            if (!resp || !resp.ok) {
                wzmTabsReload(activeTab.id);
            }
        });
    }
    function isFilteringActive(settings) {
        if (!settings)
            return false;
        let domain = activeTab && activeTab.url ? wzmGetDomain(activeTab.url) : null;
        return domain != 'mail.google.com'
            && !settings.paused
            && !settings.pausedForTab
            && ((!settings.blackList && !settings.excluded && !settings.excludedForTab)
                || (settings.blackList && (settings.excluded || settings.excludedForTab)));
    }
    function syncContentForSettings(wasActive) {
        let active = isFilteringActive(currentSettings);
        if (active) {
            if (wasActive)
                refreshSettings();
            else
                restartImages();
        }
        else {
            showImages();
        }
    }
    function finishQuickSetting(wasActive) {
        syncContentForSettings(wasActive);
        if (closeOnClick) close();
    }
    function runSettingsWrite(message, fallback, done) {
        let finished = false;
        let finish = function (resp) {
            if (finished)
                return;
            if (resp && resp.ok) {
                finished = true;
                if (done) done();
                return;
            }
            if (fallback) {
                finished = true;
                fallback(done);
            }
            else {
                finished = true;
                if (done) done();
            }
        };
        wzmSendMessage(message, finish);
        setTimeout(function () { finish(); }, 800);
    }
    wzmGetPopupSettings(activeTab, function (settings) {
        let showErr = msg => {
            document.getElementById('when-running').style.display = 'none';
            document.getElementById('err-msg').innerText = msg;
        }
        currentSettings = Object.assign(wzmDefaultSettings(), settings);
        document.getElementById('pauseChk').checked = !!settings.paused;
        document.getElementById('pauseTab').checked = !!settings.pausedForTab;
        document.getElementById('excludeDomain').checked = !!settings.excluded;
        document.getElementById('excludeForTab').checked = !!settings.excludedForTab;
        let excludeTabWrap = document.getElementById('exclude-tab-wrap');
        if (excludeTabWrap)
            excludeTabWrap.style.display = 'block';
        if (excludeAlwaysBlock && excludeAlwaysBlockW) {
            excludeAlwaysBlock.checked = !!settings.allowSafeDomain;
            excludeAlwaysBlockW.style.display = settings.alwaysBlock ? '' : 'none';
        }
        document.querySelectorAll('i-add-exclude').forEach(x => x.innerText = settings.blackList ? 'Add' : 'Exclude');
        closeOnClick = settings.closeOnClick;
    });
    document.getElementById('showImages').onclick = function () {
        showImages();
        if (closeOnClick) close();
    };
    document.getElementById('excludeDomain').onclick = function () {
        if (!currentSettings)
            currentSettings = wzmDefaultSettings();
        let isChecked = document.getElementById('excludeDomain').checked;
        let wasActive = isFilteringActive(currentSettings);
        currentSettings.excluded = isChecked;
        if (isChecked) {
            runSettingsWrite(
                { r: 'urlListAdd', url: activeTab.url, domainOnly: true },
                done => wzmUpdateUrlListLocal(list => {
                    let domain = wzmGetDomain(activeTab.url);
                    if (domain)
                        wzmAddUnique(list, domain);
                }, done),
                () => finishQuickSetting(wasActive)
            );
        } else {
            runSettingsWrite(
                { r: 'urlListRemove', url: activeTab.url },
                done => wzmUpdateUrlListLocal(list => {
                    let lowerUrl = (activeTab.url || '').toLowerCase();
                    wzmRemoveMatches(list, entry => lowerUrl.indexOf((entry || '').toLowerCase()) != -1);
                }, done),
                () => finishQuickSetting(wasActive)
            );
        }
    };
    document.getElementById('excludeForTab').onclick = function () {
        if (!currentSettings)
            currentSettings = wzmDefaultSettings();
        let isChecked = document.getElementById('excludeForTab').checked;
        let wasActive = isFilteringActive(currentSettings);
        currentSettings.excludedForTab = isChecked;
        runSettingsWrite(
            { r: 'excludeForTab', toggle: isChecked, tab: activeTab },
            done => wzmUpdateExcludeForTabsLocal(activeTab, isChecked, done),
            () => finishQuickSetting(wasActive)
        );
    };
    document.getElementById('pauseChk').onclick = function () {
        if (!currentSettings)
            currentSettings = wzmDefaultSettings();
        let isChecked = !!this.checked;
        let wasActive = isFilteringActive(currentSettings);
        currentSettings.paused = isChecked;
        runSettingsWrite(
            { r: 'pause', toggle: isChecked },
            done => wzmUpdateSettingsLocal(s => { s.paused = isChecked; }, done),
            () => finishQuickSetting(wasActive)
        );
    };
    document.getElementById('pauseTab').onclick = function () {
        if (!currentSettings)
            currentSettings = wzmDefaultSettings();
        let isChecked = !!this.checked;
        let wasActive = isFilteringActive(currentSettings);
        currentSettings.pausedForTab = isChecked;
        runSettingsWrite(
            { r: 'pauseForTab', tabId: activeTab.id, toggle: isChecked },
            done => wzmUpdatePauseForTabsLocal(activeTab.id, isChecked, done),
            () => finishQuickSetting(wasActive)
        );
    };
    if (excludeAlwaysBlock) {
        excludeAlwaysBlock.onclick = function () {
            if (!currentSettings)
                currentSettings = wzmDefaultSettings();
            let isChecked = excludeAlwaysBlock.checked;
            currentSettings.allowSafeDomain = isChecked;
            runSettingsWrite(
                { r: 'allowSafeForDomain', url: activeTab.url, toggle: isChecked },
                done => wzmUpdateAllowSafeDomainsLocal(list => {
                    let domain = wzmGetDomain(activeTab.url);
                    if (!domain) return;
                    if (isChecked)
                        wzmAddUnique(list, domain);
                    else
                        wzmRemoveMatches(list, entry => domain.indexOf((entry || '').toLowerCase()) !== -1);
                }, done),
                function () {
                    if (isFilteringActive(currentSettings))
                        refreshSettings();
                    else
                        showImages();
                    if (closeOnClick) close();
                }
            );
        };
    }
});
let feedback = document.getElementById('still-seeing-images');
if (feedback) {
    feedback.onclick = function () {
        var advice = document.getElementById('advice');
        advice.style.display = advice.style.display == 'block' ? 'none' : 'block';
    };
}
document.getElementById('close').onclick = function () { close(); };
