var wzmBrowser = typeof browser !== 'undefined' ? browser : null;
var wzmChrome = typeof chrome !== 'undefined' ? chrome : null;
var wzmRuntime = (wzmChrome && wzmChrome.runtime) || (wzmBrowser && wzmBrowser.runtime) || null;
var wzmTabs = (wzmChrome && wzmChrome.tabs) || (wzmBrowser && wzmBrowser.tabs) || null;
var wzmUsePromiseApi = !!wzmBrowser && (!wzmChrome || wzmChrome === wzmBrowser);
var wzmStorageLocal = (wzmChrome && wzmChrome.storage && wzmChrome.storage.local) || (wzmBrowser && wzmBrowser.storage && wzmBrowser.storage.local) || null;
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
function wzmDefaultSettings() {
    return {
        paused: false,
        noEye: false,
        blackList: false,
        closeOnClick: false,
        maxSafe: 32,
        alwaysBlock: false
    };
}
function wzmGetDomain(url) {
    let regex = /^\w+:\/\/([\w\.:-]+)/.exec(url || '');
    return regex ? regex[1].toLowerCase() : null;
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
        if (activeTab && activeTab.url) {
            let lowerUrl = activeTab.url.toLowerCase();
            for (let i = 0; i < urlList.length; i++) {
                if (lowerUrl.indexOf(urlList[i]) != -1) { s.excluded = true; break; }
            }
            let domain = wzmGetDomain(activeTab.url);
            if (domain) {
                for (let i = 0; i < allowSafeDomains.length; i++) {
                    if (domain.indexOf(allowSafeDomains[i]) !== -1) { s.allowSafeDomain = true; break; }
                }
            }
        }
        callback(s);
    });
}
function wzmUpdateSettingsLocal(updateFn) {
    wzmStorageGetLocal(['settings'], function (data) {
        let s = data && data.settings ? data.settings : wzmDefaultSettings();
        updateFn(s);
        wzmStorageSetLocal({ settings: s });
    });
}
function wzmUpdateUrlListLocal(updateFn) {
    wzmStorageGetLocal(['urlList'], function (data) {
        let list = (data && Array.isArray(data.urlList)) ? data.urlList : [];
        updateFn(list);
        wzmStorageSetLocal({ urlList: list });
    });
}
function wzmUpdateAllowSafeDomainsLocal(updateFn) {
    wzmStorageGetLocal(['allowSafeDomains'], function (data) {
        let list = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
        updateFn(list);
        wzmStorageSetLocal({ allowSafeDomains: list });
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
    var activeTab = tabs[0], closeOnClick;
    var excludeAlwaysBlock = document.getElementById('excludeAlwaysBlock');
    var excludeAlwaysBlockW = document.getElementById('exclude-always-block-w');
    function showImages() {
        wzmTabsSendMessage(activeTab.id, { r: 'showImages' });
    }
    function restartImages() {
        wzmTabsSendMessage(activeTab.id, { r: 'restart' }, function (resp) {
            if (!resp || !resp.ok) {
                wzmTabsReload(activeTab.id);
            }
        });
    }
    function refreshSettings() {
        wzmTabsSendMessage(activeTab.id, { r: 'refreshSettings' }, function (resp) {
            if (!resp || !resp.ok) {
                wzmTabsReload(activeTab.id);
            }
        });
    }
    wzmGetPopupSettings(activeTab, function (settings) {
        let showErr = msg => {
            document.getElementById('when-running').style.display = 'none';
            document.getElementById('err-msg').innerText = msg;
        }
        if (!settings.token) {
            showErr('Go to All Settings, and set your phone number.')
            return;
        }
        if (!settings.unwanted) {
            showErr('Go to All Settings, and select what you wish to block.')
            return;
        }
        document.getElementById('pauseChk').checked = settings.paused;
        document.getElementById('pauseTab').checked = settings.pausedForTab;
        document.getElementById('excludeDomain').checked = settings.excluded;
        document.getElementById('excludeForTab').checked = settings.excludedForTab;
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
        if (document.getElementById('excludeDomain').checked) {
            wzmSendMessage({ r: 'urlListAdd', url: activeTab.url, domainOnly: true });
            wzmUpdateUrlListLocal(list => {
                let domain = wzmGetDomain(activeTab.url);
                if (domain)
                    list.push(domain);
            });
            showImages();
        } else {
            wzmSendMessage({ r: 'urlListRemove', url: activeTab.url });
            wzmUpdateUrlListLocal(list => {
                let lowerUrl = (activeTab.url || '').toLowerCase();
                for (let i = 0; i < list.length; i++) {
                    if (lowerUrl.indexOf(list[i]) != -1) { list.splice(i, 1); i--; }
                }
            });
            restartImages();
        }
        if (closeOnClick) close();
    };
    document.getElementById('excludeForTab').onclick = function () {
        var isChecked = document.getElementById('excludeForTab').checked;
        wzmSendMessage({ r: 'excludeForTab', toggle: isChecked, tab: activeTab });
        if (isChecked)
            showImages();
        if (closeOnClick) close();
    };
    document.getElementById('pauseChk').onclick = function () {
        wzmSendMessage({ r: 'pause', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.paused = !!document.getElementById('pauseChk').checked; });
        if (this.checked)
            showImages();
        else
            restartImages();
        if (closeOnClick) close();
    };
    document.getElementById('pauseTab').onclick = function () {
        wzmSendMessage({ r: 'pauseForTab', tabId: activeTab.id, toggle: this.checked });
        if (this.checked)
            showImages();
        else
            restartImages();
        if (closeOnClick) close();
    };
    if (excludeAlwaysBlock) {
        excludeAlwaysBlock.onclick = function () {
            let isChecked = excludeAlwaysBlock.checked;
            wzmSendMessage({ r: 'allowSafeForDomain', url: activeTab.url, toggle: isChecked });
            wzmUpdateAllowSafeDomainsLocal(list => {
                let domain = wzmGetDomain(activeTab.url);
                if (!domain) return;
                if (isChecked) {
                    if (list.indexOf(domain) === -1)
                        list.push(domain);
                } else {
                    for (let i = 0; i < list.length; i++) {
                        if (domain.indexOf(list[i]) !== -1) { list.splice(i, 1); i--; }
                    }
                }
            });
            wzmTabsSendMessage(activeTab.id, { r: 'allowSafeForDomain', toggle: isChecked }, function (resp) {
                if (!resp || !resp.ok) {
                    refreshSettings();
                }
            });
            if (closeOnClick) close();
        };
    }
});
document.getElementById('close').onclick = function () { close(); };
