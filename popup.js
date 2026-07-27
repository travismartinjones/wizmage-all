var wzmBrowser = typeof browser !== 'undefined' ? browser : null;
var wzmChrome = typeof chrome !== 'undefined' ? chrome : null;
var wzmRuntime = (wzmChrome && wzmChrome.runtime) || (wzmBrowser && wzmBrowser.runtime) || null;
var wzmTabs = (wzmChrome && wzmChrome.tabs) || (wzmBrowser && wzmBrowser.tabs) || null;
var wzmUsePromiseApi = !!wzmBrowser && (!wzmChrome || wzmChrome === wzmBrowser);
var wzmStorageLocal = (wzmChrome && wzmChrome.storage && wzmChrome.storage.local) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.local) || null;
var wzmStorageSession = (wzmChrome && wzmChrome.storage && wzmChrome.storage.session) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.session) || wzmStorageLocal;
var wzmCanUseWorker = !!wzmRuntime && typeof wzmRuntime.sendMessage === 'function';
var wzmShared = typeof globalThis !== 'undefined' ? globalThis.WizmageShared : null;
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
    callback = typeof callback === 'function' ? callback : function () { };
    if (!area || !area.get) {
        callback({}, false);
        return;
    }
    let completed = false;
    let finish = function (value, success) {
        if (completed)
            return;
        completed = true;
        callback(value || {}, !!success);
    };
    let callbackResult = function (value) {
        if (wzmChrome && wzmChrome.runtime && wzmChrome.runtime.lastError)
            finish({}, false);
        else
            finish(value, true);
    };
    try {
        let maybePromise = area.get(keys, callbackResult);
        if (maybePromise && typeof maybePromise.then === 'function')
            maybePromise.then(function (value) { finish(value, true); }).catch(function () { finish({}, false); });
        return maybePromise;
    } catch (err) {
        try {
            var promise = area.get(keys);
            if (promise && typeof promise.then === 'function')
                promise.then(function (value) { finish(value, true); }).catch(function () { finish({}, false); });
            else
                finish({}, false);
            return promise;
        } catch (retryError) {
            finish({}, false);
            return;
        }
    }
}
function wzmStorageSet(area, items, callback) {
    callback = typeof callback === 'function' ? callback : function () { };
    if (!area || !area.set) {
        callback(false);
        return;
    }
    let completed = false;
    let finish = function (success) {
        if (completed)
            return;
        completed = true;
        callback(!!success);
    };
    let callbackResult = function () {
        if (wzmChrome && wzmChrome.runtime && wzmChrome.runtime.lastError)
            finish(false);
        else
            finish(true);
    };
    try {
        let maybePromise = area.set(items, callbackResult);
        if (maybePromise && typeof maybePromise.then === 'function')
            maybePromise.then(function () { finish(true); }).catch(function () { finish(false); });
        return maybePromise;
    } catch (err) {
        // Promise-only browser APIs reject the callback argument before writing.
        try {
            var promise = area.set(items);
            if (promise && typeof promise.then === 'function')
                promise.then(function () { finish(true); }).catch(function () { finish(false); });
            else
                finish(false);
            return promise;
        } catch (retryError) {
            finish(false);
            return;
        }
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
    if (wzmShared)
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
function wzmGetDomain(url) {
    if (wzmShared) {
        let parsed = wzmShared.parseUrl(url);
        return parsed ? wzmShared.normalizeHost(parsed.hostname) : null;
    }
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
    if (wzmShared)
        return wzmShared.urlMatchesList(url, list);
    return false;
}
function wzmNormalizeSettings(settings) {
    if (wzmShared)
        return wzmShared.normalizeSettings(settings);
    return Object.assign(wzmDefaultSettings(), settings && typeof settings === 'object' ? settings : {});
}
function wzmDomainMatchesList(domain, list) {
    if (wzmShared)
        return wzmShared.domainMatchesList(domain, list);
    domain = (domain || '').toLowerCase();
    for (let i = 0; i < list.length; i++) {
        let entry = (list[i] || '').toLowerCase();
        if (entry && (domain === entry || domain.endsWith('.' + entry)))
            return true;
    }
    return false;
}
function wzmGetPopupSettings(activeTab, callback) {
    if (!wzmCanUseWorker) {
        wzmGetSettingsFromStorage(activeTab, callback);
        return;
    }
    let responded = false;
    wzmSendMessage({ r: 'getSettings', tab: activeTab }, function (settings) {
        if (responded)
            return;
        responded = true;
        if (settings && typeof settings === 'object' && settings.ok !== false) {
            callback(settings);
            return;
        }
        callback(null);
    });
    setTimeout(function () {
        if (responded)
            return;
        responded = true;
        callback(null);
    }, 2000);
}
function wzmGetSettingsFromStorage(activeTab, callback) {
    wzmStorageGetLocal(['settings', 'urlList', 'allowSafeDomains'], function (data, localOk) {
        if (!localOk) {
            callback(null);
            return;
        }
        wzmStorageGetSession({ pauseForTabs: [], excludeForTabs: [] }, function (sessionData, sessionOk) {
            if (!sessionOk) {
                callback(null);
                return;
            }
            let s = wzmNormalizeSettings(data && data.settings);
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
    wzmStorageGetLocal(['settings'], function (data, success) {
        if (!success) {
            if (done) done(false);
            return;
        }
        let s = data && data.settings ? data.settings : wzmDefaultSettings();
        updateFn(s);
        wzmStorageSetLocal({ settings: s }, done);
    });
}
function wzmUpdateUrlListLocal(updateFn, done) {
    wzmStorageGetLocal(['urlList'], function (data, success) {
        if (!success) {
            if (done) done(false);
            return;
        }
        let list = (data && Array.isArray(data.urlList)) ? data.urlList : [];
        updateFn(list);
        wzmStorageSetLocal({ urlList: list }, done);
    });
}
function wzmUpdateAllowSafeDomainsLocal(updateFn, done) {
    wzmStorageGetLocal(['allowSafeDomains'], function (data, success) {
        if (!success) {
            if (done) done(false);
            return;
        }
        let list = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
        updateFn(list);
        wzmStorageSetLocal({ allowSafeDomains: list }, done);
    });
}
function wzmUpdatePauseForTabsLocal(tabId, toggle, done) {
    wzmStorageGetSession({ pauseForTabs: [] }, function (data, success) {
        if (!success) {
            if (done) done(false);
            return;
        }
        let list = (data && Array.isArray(data.pauseForTabs)) ? data.pauseForTabs : [];
        if (toggle)
            wzmAddUnique(list, tabId);
        else
            wzmRemoveMatches(list, entry => entry == tabId);
        wzmStorageSetSession({ pauseForTabs: list }, done);
    });
}
function wzmUpdateExcludeForTabsLocal(tab, toggle, done) {
    wzmStorageGetSession({ excludeForTabs: [] }, function (data, success) {
        if (!success) {
            if (done) done(false);
            return;
        }
        let list = (data && Array.isArray(data.excludeForTabs)) ? data.excludeForTabs : [];
        let domain = tab && wzmGetDomain(tab.url);
        if (!domain) {
            if (done) done(false);
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
    try {
        var result = wzmTabs.reload(tabId);
        if (result && typeof result.catch === 'function')
            result.catch(function () { });
        return result;
    } catch (err) {
        // ignore
    }
}
wzmTabsQuery({ active: true, currentWindow: true }, function (tabs) {
    var activeTab = tabs[0], closeOnClick, currentSettings;
    var settingsWriteQueue = [], settingsWriteInProgress = false;
    var excludeAlwaysBlock = document.getElementById('excludeAlwaysBlock');
    var excludeAlwaysBlockW = document.getElementById('exclude-always-block-w');
    function sendContentCommandWithReloadFallback(route, done) {
        if (!activeTab) {
            if (done) done(false);
            return;
        }
        let finished = false;
        let finish = function (resp) {
            if (finished)
                return;
            finished = true;
            let ok = !!resp && resp.ok === true;
            if (!ok)
                wzmTabsReload(activeTab.id);
            if (done) done(ok);
        };
        wzmTabsSendMessage(activeTab.id, { r: route }, finish);
        setTimeout(function () { finish(); }, 2000);
    }
    function showImages(done) {
        sendContentCommandWithReloadFallback('showImages', done);
    }
    function restartImages(done) {
        sendContentCommandWithReloadFallback('restart', done);
    }
    function refreshSettings(done) {
        sendContentCommandWithReloadFallback('refreshSettings', done);
    }
    function isFilteringActive(settings) {
        if (!settings)
            return false;
        return !settings.paused
            && !settings.pausedForTab
            && ((!settings.blackList && !settings.excluded && !settings.excludedForTab)
                || (settings.blackList && (settings.excluded || settings.excludedForTab)));
    }
    function syncContentForSettings(wasActive, done) {
        let active = isFilteringActive(currentSettings);
        if (active) {
            if (wasActive)
                refreshSettings(done);
            else
                restartImages(done);
        }
        else {
            showImages(done);
        }
    }
    function showPopupError(message) {
        let whenRunning = document.getElementById('when-running');
        let error = document.getElementById('err-msg');
        if (whenRunning)
            whenRunning.style.display = 'none';
        if (error)
            error.innerText = message;
    }
    function finishQuickSetting(wasActive, success) {
        if (!success) {
            showPopupError('The setting could not be saved. Reopen the popup and try again.');
            return;
        }
        // The worker persists settings without fanning work out across every
        // open tab. Update this tab directly; hidden tabs refresh themselves
        // when they next become visible.
        syncContentForSettings(wasActive, function () {
            if (closeOnClick) close();
        });
    }
    function runSettingsWrite(message, fallback, done) {
        settingsWriteQueue.push({ message: message, fallback: fallback, done: done });
        drainSettingsWrites();
    }
    function drainSettingsWrites() {
        if (settingsWriteInProgress || !settingsWriteQueue.length)
            return;
        settingsWriteInProgress = true;
        let job = settingsWriteQueue.shift();
        let finished = false;
        let finish = function (success) {
            if (finished)
                return;
            finished = true;
            if (job.done)
                job.done(success);
            settingsWriteInProgress = false;
            drainSettingsWrites();
        };
        if (!wzmCanUseWorker) {
            if (job.fallback) {
                job.fallback(function (success) { finish(success === true); });
            }
            else {
                finish(false);
            }
            return;
        }
        wzmSendMessage(job.message, function (response) {
            finish(!!response && response.ok === true);
        });
        setTimeout(function () { finish(false); }, 2000);
    }
    wzmGetPopupSettings(activeTab, function (settings) {
        if (!settings) {
            showPopupError('WizMage settings could not be loaded. Reopen the popup and try again.');
            return;
        }
        currentSettings = wzmNormalizeSettings(settings);
        let activeDomain = activeTab && wzmGetDomain(activeTab.url);
        document.getElementById('pauseChk').checked = !!settings.paused;
        document.getElementById('pauseTab').checked = !!settings.pausedForTab;
        document.getElementById('excludeDomain').checked = !!settings.excluded;
        document.getElementById('excludeDomain').disabled = !activeDomain;
        document.getElementById('excludeForTab').checked = !!settings.excludedForTab;
        document.getElementById('excludeForTab').disabled = !activeDomain;
        let excludeTabWrap = document.getElementById('exclude-tab-wrap');
        if (excludeTabWrap)
            excludeTabWrap.style.display = 'block';
        if (excludeAlwaysBlock && excludeAlwaysBlockW) {
            excludeAlwaysBlock.checked = !!settings.allowSafeDomain;
            excludeAlwaysBlock.disabled = !activeDomain;
            excludeAlwaysBlockW.style.display = settings.alwaysBlock ? '' : 'none';
        }
        document.querySelectorAll('i-add-exclude').forEach(x => x.innerText = settings.blackList ? 'Add' : 'Exclude');
        closeOnClick = settings.closeOnClick;
    });
    document.getElementById('showImages').onclick = function () {
        showImages(function () {
            if (closeOnClick) close();
        });
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
                done => {
                    let domain = wzmGetDomain(activeTab.url);
                    if (!domain) {
                        done(false);
                        return;
                    }
                    wzmUpdateUrlListLocal(list => wzmAddUnique(list, domain), done);
                },
                success => finishQuickSetting(wasActive, success)
            );
        } else {
            runSettingsWrite(
                { r: 'urlListRemove', url: activeTab.url },
                done => wzmUpdateUrlListLocal(list => {
                    wzmRemoveMatches(list, entry => wzmUrlMatchesList(activeTab.url, [entry]));
                }, done),
                success => finishQuickSetting(wasActive, success)
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
            success => finishQuickSetting(wasActive, success)
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
            success => finishQuickSetting(wasActive, success)
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
            success => finishQuickSetting(wasActive, success)
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
                        wzmRemoveMatches(list, entry => wzmDomainMatchesList(domain, [entry]));
                }, done),
                success => finishQuickSetting(isFilteringActive(currentSettings), success)
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
