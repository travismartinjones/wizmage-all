{
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
    function wzmLegacyUnwantedToBlockTarget(unwanted) {
        if (wzmShared)
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
    function wzmNormalizeSettings(settings) {
        if (wzmShared)
            return wzmShared.normalizeSettings(settings);
        let source = (settings && typeof settings === 'object') ? settings : {};
        settings = Object.assign(wzmDefaultSettings(), source);
        if (!source.blockTarget)
            settings.blockTarget = wzmLegacyUnwantedToBlockTarget(settings.unwanted);
        if (['all', 'men', 'women', 'people'].indexOf(settings.blockTarget) === -1)
            settings.blockTarget = 'all';
        settings.maxSafe = +settings.maxSafe || 32;
        if (settings.maxSafe < 1 || settings.maxSafe > 1000)
            settings.maxSafe = 32;
        return settings;
    }
    function wzmAddUnique(list, value) {
        if (value && list.indexOf(value) === -1)
            list.push(value);
    }
    function wzmGetDomain(url) {
        if (wzmShared) {
            let parsed = wzmShared.parseUrl(url);
            return parsed ? wzmShared.normalizeHost(parsed.hostname) : null;
        }
        let match = /^\w+:\/\/([\w.:-]+)/.exec(url || '');
        return match ? match[1].toLowerCase() : null;
    }
    function wzmNormalizeDomainEntry(value) {
        let candidate = String(value || '').trim().toLowerCase();
        if (!candidate)
            return null;
        try {
            let parsed = new URL(/^\w+:\/\//.test(candidate) ? candidate : 'https://' + candidate);
            return (parsed.hostname || '').replace(/^\*\./, '').replace(/^\.+|\.+$/g, '').toLowerCase() || null;
        } catch (err) {
            return null;
        }
    }
    function wzmUrlMatchesList(url, list) {
        if (wzmShared)
            return wzmShared.urlMatchesList(url, list);
        return false;
    }
    function wzmDomainMatchesList(domain, list) {
        if (wzmShared)
            return wzmShared.domainMatchesList(domain, list);
        domain = wzmNormalizeDomainEntry(domain);
        if (!domain)
            return false;
        return list.some(entry => {
            entry = wzmNormalizeDomainEntry(entry);
            return !!entry && (domain === entry || domain.endsWith('.' + entry));
        });
    }
    function wzmUpdateSettingsLocal(updateFn, done) {
        wzmStorageGetLocal(['settings'], function (data, success) {
            if (!success) {
                if (done) done(false);
                return;
            }
            let s = wzmNormalizeSettings(data && data.settings);
            updateFn(s);
            wzmStorageSetLocal({ settings: s }, function (success) {
                if (done) done(success);
            });
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
            wzmStorageSetLocal({ urlList: list }, function (success) {
                if (done) done(success);
            });
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
            wzmStorageSetLocal({ allowSafeDomains: list }, function (success) {
                if (done) done(success);
            });
        });
    }
    function wzmGetSettingsFromStorage(tab, callback) {
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
                let settings = wzmNormalizeSettings(data && data.settings);
                let urlList = data && Array.isArray(data.urlList) ? data.urlList : [];
                let allowSafeDomains = data && Array.isArray(data.allowSafeDomains) ? data.allowSafeDomains : [];
                let pauseForTabs = sessionData && Array.isArray(sessionData.pauseForTabs) ? sessionData.pauseForTabs : [];
                let excludeForTabs = sessionData && Array.isArray(sessionData.excludeForTabs) ? sessionData.excludeForTabs : [];
                settings.pausedForTab = !!(tab && tab.id != null && pauseForTabs.indexOf(tab.id) !== -1);
                settings.excluded = !!(tab && tab.url && wzmUrlMatchesList(tab.url, urlList));
                settings.excludedForTab = false;
                settings.allowSafeDomain = false;
                if (tab && tab.url) {
                    let domain = wzmGetDomain(tab.url);
                    if (domain) {
                        settings.allowSafeDomain = wzmDomainMatchesList(domain, allowSafeDomains);
                        settings.excludedForTab = excludeForTabs.some(entry => entry && entry.tabId == tab.id && entry.domain == domain);
                    }
                }
                callback(settings);
            });
        });
    }
    function wzmGetSettings(tab, callback) {
        if (!wzmCanUseWorker) {
            wzmGetSettingsFromStorage(tab, callback);
            return;
        }
        let finished = false;
        let finish = function (settings) {
            if (finished)
                return;
            finished = true;
            callback(settings && typeof settings === 'object' && settings.ok !== false ? wzmNormalizeSettings(settings) : null);
        };
        wzmSendMessage({ r: 'getSettings', tab: tab }, finish);
        setTimeout(function () { finish(null); }, 2000);
    }
    function wzmGetUrlList(callback) {
        if (!wzmCanUseWorker) {
            wzmStorageGetLocal(['urlList'], function (data) {
                callback((data && Array.isArray(data.urlList)) ? data.urlList : []);
            });
            return;
        }
        let finished = false;
        let finish = function (urlList) {
            if (finished)
                return;
            finished = true;
            callback(Array.isArray(urlList) ? urlList : []);
        };
        wzmSendMessage({ r: 'getUrlList' }, finish);
        setTimeout(function () { finish([]); }, 2000);
    }
    function wzmGetAllowSafeDomains(callback) {
        wzmStorageGetLocal(['allowSafeDomains'], function (data) {
            callback((data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : []);
        });
    }
    function wzmTabsQuery(queryInfo, callback) {
        if (!wzmTabs || !wzmTabs.query) {
            if (callback) callback([]);
            return;
        }
        if (wzmUsePromiseApi) {
            try {
                let promise = wzmTabs.query(queryInfo);
                if (callback) promise.then(callback).catch(function () { callback([]); });
                return promise;
            } catch (err) {
                if (callback) callback([]);
                return;
            }
        }
        try {
            return wzmTabs.query(queryInfo, callback);
        } catch (err) {
            if (callback) callback([]);
        }
    }
    function wzmTabsSendMessage(tabId, message, callback) {
        if (!wzmTabs || !wzmTabs.sendMessage) {
            if (callback) callback();
            return;
        }
        if (wzmUsePromiseApi) {
            try {
                let promise = wzmTabs.sendMessage(tabId, message);
                if (callback) promise.then(callback).catch(function () { callback(); });
                return promise;
            } catch (err) {
                if (callback) callback();
                return;
            }
        }
        try {
            return wzmTabs.sendMessage(tabId, message, callback);
        } catch (err) {
            if (callback) callback();
        }
    }
    function wzmTabsReload(tabId) {
        if (!wzmTabs || !wzmTabs.reload)
            return;
        try {
            let result = wzmTabs.reload(tabId);
            if (result && typeof result.catch === 'function')
                result.catch(function () { });
            return result;
        } catch (err) {
            // ignore
        }
    }
    function wzmIsFilteringActive(settings) {
        if (!settings)
            return false;
        return !settings.paused
            && !settings.pausedForTab
            && ((!settings.blackList && !settings.excluded && !settings.excludedForTab)
                || (settings.blackList && (settings.excluded || settings.excludedForTab)));
    }
    function wzmCanReceiveContentMessages(tab) {
        return !!(tab && tab.id != null && /^https?:/i.test(tab.url || ''));
    }
    function wzmSelectContentTab(tabs) {
        tabs = Array.isArray(tabs) ? tabs : [];
        let activeTab = tabs.find(tab => tab && tab.active);
        if (wzmCanReceiveContentMessages(activeTab))
            return activeTab;
        if (activeTab && activeTab.openerTabId != null) {
            let opener = tabs.find(tab => tab && tab.id == activeTab.openerTabId);
            if (wzmCanReceiveContentMessages(opener))
                return opener;
        }
        let candidates = tabs.filter(wzmCanReceiveContentMessages);
        candidates.sort((a, b) => (+b.lastAccessed || 0) - (+a.lastAccessed || 0));
        return candidates[0] || null;
    }

    let wzmActiveTab = null;
    let wzmActiveSettings = null;
    let wzmWriteQueue = [];
    let wzmWriteInProgress = false;
    let wzmSaveStatus = document.getElementById('save-status');

    function wzmShowSaveError() {
        if (!wzmSaveStatus)
            return;
        wzmSaveStatus.textContent = 'The setting could not be saved. Try again.';
        wzmSaveStatus.classList.add('show');
    }

    function wzmClearSaveError() {
        if (!wzmSaveStatus)
            return;
        wzmSaveStatus.textContent = '';
        wzmSaveStatus.classList.remove('show');
    }

    function wzmSyncActiveTab(wasActive, done) {
        if (!wzmActiveTab || wzmActiveTab.id == null) {
            if (done) done();
            return;
        }
        wzmGetSettings(wzmActiveTab, function (settings) {
            if (!settings) {
                wzmTabsReload(wzmActiveTab.id);
                if (done) done();
                return;
            }
            wzmActiveSettings = settings;
            let isActive = wzmIsFilteringActive(settings);
            if (!isActive) {
                wzmTabsSendMessage(wzmActiveTab.id, { r: 'showImages' });
                if (done) done();
                return;
            }
            let route = wasActive ? 'refreshSettings' : 'restart';
            let responded = false;
            let finish = function (response) {
                if (responded)
                    return;
                responded = true;
                if (!response || !response.ok)
                    wzmTabsReload(wzmActiveTab.id);
                if (done) done();
            };
            wzmTabsSendMessage(wzmActiveTab.id, { r: route }, finish);
            setTimeout(function () { finish(); }, 2000);
        });
    }
    function wzmRunSettingsWrite(message, localFallback, options) {
        wzmWriteQueue.push({
            message: message,
            localFallback: localFallback,
            options: options || {}
        });
        wzmDrainSettingsWrites();
    }
    function wzmDrainSettingsWrites() {
        if (wzmWriteInProgress || !wzmWriteQueue.length)
            return;
        wzmWriteInProgress = true;
        let job = wzmWriteQueue.shift();
        let wasActive = wzmIsFilteringActive(wzmActiveSettings);
        let finished = false;
        let finishWrite = function (success) {
            if (finished)
                return;
            finished = true;
            if (job.options.done)
                job.options.done(success);
            let release = function () {
                wzmWriteInProgress = false;
                wzmDrainSettingsWrites();
            };
            if (!success) {
                wzmShowSaveError();
                release();
                return;
            }
            wzmClearSaveError();
            if (job.options.sync === false) {
                release();
                return;
            }
            // Keep the worker write small and let this page update only the
            // content tab the user came from. Background tabs catch up from
            // storage when they become visible.
            wzmSyncActiveTab(wasActive, release);
        };
        if (!wzmCanUseWorker) {
            if (job.localFallback)
                job.localFallback(function (success) { finishWrite(success === true); });
            else
                finishWrite(false);
            return;
        }
        wzmSendMessage(job.message, function (response) {
            finishWrite(!!response && response.ok === true);
        });
        setTimeout(function () { finishWrite(false); }, 2000);
    }

    let addName = document.getElementById('addName'),
        noPattern = document.getElementById('noPattern'),
        noEye = document.getElementById('noEye'),
        alwaysBlock = document.getElementById('always-block'),
        list = document.getElementById('list'),
        allowSafeSection = document.getElementById('always-block-exclusions-section'),
        allowSafeForm = document.getElementById('allow-safe-form'),
        allowSafeAdd = document.getElementById('allow-safe-add'),
        allowSafeList = document.getElementById('allow-safe-list'),
        whiteList = document.getElementById('white-list'),
        blackList = document.getElementById('black-list'),
        form = document.getElementById('form'),
        freeText = document.getElementById('free-text'),
        maxSafe = document.getElementById('max-safe'),
        closeOnClick = document.getElementById('close-on-click'),
        blockTargetRadios = document.querySelectorAll('input[name="block-target"]'),
        isFreeText = false,
        iosDone = document.getElementById('ios-done'),
        iosCloseHint = document.getElementById('ios-close-hint');

    let isIOS = /iP(hone|ad|od)/i.test(navigator.userAgent) || (navigator.userAgent.indexOf('Mac') > -1 && navigator.maxTouchPoints > 1);
    let infoTooltip;
    if (isIOS) {
        document.addEventListener('click', (ev) => {
            let icon = ev.target.closest('.info-icon');
            if (!icon) {
                if (infoTooltip) infoTooltip.classList.remove('show');
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            let text = icon.getAttribute('title') || icon.getAttribute('data-title') || '';
            if (!text) return;
            if (!infoTooltip) {
                infoTooltip = document.createElement('div');
                infoTooltip.className = 'ios-info-tooltip';
                document.body.appendChild(infoTooltip);
            }
            if (!icon.dataset.tooltipId)
                icon.dataset.tooltipId = Math.random().toString(36).slice(2);
            infoTooltip.dataset.anchor = icon.dataset.tooltipId;
            infoTooltip.textContent = text;
            infoTooltip.style.visibility = 'hidden';
            infoTooltip.classList.add('show');
            infoTooltip.style.left = '0px';
            infoTooltip.style.top = '0px';
            let rect = icon.getBoundingClientRect();
            let tooltipWidth = infoTooltip.offsetWidth;
            let tooltipHeight = infoTooltip.offsetHeight;
            let scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
            let scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
            let left = rect.left + rect.width / 2 + scrollX - tooltipWidth / 2;
            let minLeft = 8 + scrollX;
            let maxLeft = scrollX + document.documentElement.clientWidth - tooltipWidth - 8;
            if (left < minLeft) left = minLeft;
            if (left > maxLeft) left = maxLeft;
            let top = rect.bottom + 8 + scrollY;
            if (top + tooltipHeight > scrollY + window.innerHeight - 8)
                top = rect.top - tooltipHeight - 8 + scrollY;
            infoTooltip.style.left = left + 'px';
            infoTooltip.style.top = top + 'px';
            infoTooltip.style.visibility = 'visible';
        }, true);
        window.addEventListener('scroll', () => { if (infoTooltip) infoTooltip.classList.remove('show'); }, { passive: true });
        window.addEventListener('resize', () => { if (infoTooltip) infoTooltip.classList.remove('show'); });
        document.addEventListener('touchstart', (ev) => {
            if (!ev.target.closest('.info-icon') && infoTooltip)
                infoTooltip.classList.remove('show');
        }, { passive: true });
    }
    if (iosDone) {
        iosDone.onclick = () => {
            if (history.length > 1) {
                history.back();
                return;
            }
            try { window.close(); } catch (err) { }
            if (iosCloseHint) {
                setTimeout(() => {
                    if (document.visibilityState !== 'hidden') {
                        iosCloseHint.classList.add('show');
                        setTimeout(() => iosCloseHint.classList.remove('show'), 2500);
                    }
                }, 150);
            }
        };
    }
    if (addName)
        addName.focus();

    function renderSettings(settings) {
        settings = settings || wzmDefaultSettings();
        let target = settings.blockTarget || 'all';
        for (let r of blockTargetRadios)
            r.checked = r.value === target;
        noPattern.checked = !!settings.noPattern;
        noEye.checked = !!settings.noEye;
        alwaysBlock.checked = !!settings.alwaysBlock;
        if (allowSafeSection)
            allowSafeSection.style.display = alwaysBlock.checked ? '' : 'none';
        closeOnClick.checked = !!settings.closeOnClick;
        (settings.blackList ? blackList : whiteList).checked = true;
        maxSafe.value = settings.maxSafe;
    }
    wzmTabsQuery({ currentWindow: true }, function (tabs) {
        wzmActiveTab = wzmSelectContentTab(tabs);
        wzmGetSettings(wzmActiveTab, function (settings) {
            wzmActiveSettings = settings;
            renderSettings(settings);
        });
    });

    if (wzmRuntime && wzmRuntime.onMessage && wzmRuntime.onMessage.addListener) {
        wzmRuntime.onMessage.addListener(function (request) {
            if (request.r == 'urlListModified')
                CreateList();
        });
    }

    for (let r of blockTargetRadios) {
        r.onchange = function () {
            let value = this.value;
            wzmRunSettingsWrite(
                { r: 'setBlockTarget', blockTarget: value },
                done => wzmUpdateSettingsLocal(s => { s.blockTarget = value; }, done)
            );
        };
    }
    noPattern.onclick = function () {
        let toggle = !!this.checked;
        wzmRunSettingsWrite(
            { r: 'setNoPattern', toggle: toggle },
            done => wzmUpdateSettingsLocal(s => { s.noPattern = toggle; }, done)
        );
    };
    noEye.onclick = function () {
        let toggle = !!this.checked;
        wzmRunSettingsWrite(
            { r: 'setNoEye', toggle: toggle },
            done => wzmUpdateSettingsLocal(s => { s.noEye = toggle; }, done)
        );
    };
    alwaysBlock.onclick = function () {
        let toggle = !!this.checked;
        wzmRunSettingsWrite(
            { r: 'setAlwaysBlock', toggle: toggle },
            done => wzmUpdateSettingsLocal(s => { s.alwaysBlock = toggle; }, done)
        );
        if (allowSafeSection)
            allowSafeSection.style.display = toggle ? '' : 'none';
    };
    whiteList.onclick = function () {
        wzmRunSettingsWrite(
            { r: 'setBlackList', toggle: false },
            done => wzmUpdateSettingsLocal(s => { s.blackList = false; }, done)
        );
    };
    blackList.onclick = function () {
        wzmRunSettingsWrite(
            { r: 'setBlackList', toggle: true },
            done => wzmUpdateSettingsLocal(s => { s.blackList = true; }, done)
        );
    };
    maxSafe.onchange = function () {
        let value = +maxSafe.value || 32;
        if (value < 1 || value > 1000)
            value = 32;
        maxSafe.value = value;
        wzmRunSettingsWrite(
            { r: 'setMaxSafe', maxSafe: value },
            done => wzmUpdateSettingsLocal(s => { s.maxSafe = value; }, done)
        );
    };
    closeOnClick.onclick = function () {
        let toggle = !!this.checked;
        wzmRunSettingsWrite(
            { r: 'setCloseOnClick', toggle: toggle },
            done => wzmUpdateSettingsLocal(s => { s.closeOnClick = toggle; }, done),
            { sync: false }
        );
    };
    window.onunload = () => maxSafe.blur();

    form.onsubmit = function () {
        let url = addName.value.trim().toLowerCase();
        if (!url.length) return false;
        if (wzmShared && wzmShared.isValidUrlListEntry && !wzmShared.isValidUrlListEntry(url)) {
            wzmShowSaveError();
            return false;
        }
        wzmRunSettingsWrite(
            { r: 'urlListAdd', url: url },
            done => {
                if (wzmShared && wzmShared.isValidUrlListEntry && !wzmShared.isValidUrlListEntry(url)) {
                    done(false);
                    return;
                }
                wzmUpdateUrlListLocal(list => { wzmAddUnique(list, url); }, done);
            },
            { done: success => { if (success) CreateList(); } }
        );
        addName.value = '';
        return false;
    };
    list.onclick = ev => {
        let del = ev.target.closest('.delete');
        if (del) {
            let item = ev.target.closest('.item');
            let valueElement = item.querySelector('.url');
            let value = valueElement ? valueElement.textContent : '';
            wzmRunSettingsWrite(
                { r: 'urlListRemove', url: value },
                done => wzmUpdateUrlListLocal(list => {
                    let index = list.indexOf(value);
                    if (index !== -1)
                        list.splice(index, 1);
                }, done),
                { done: success => { if (success) CreateList(); } }
            );
        }
    };
    function createListItem(value) {
        let item = createElementWithClass('item');
        let remove = createElementWithClass('delete', 'span');
        let text = createElementWithClass('url', 'span');
        remove.textContent = 'X';
        text.textContent = value;
        item.appendChild(remove);
        item.appendChild(document.createTextNode(' '));
        item.appendChild(text);
        return item;
    }
    function CreateList() {
        wzmGetUrlList(function (urlList) {
            list.innerHTML = '';
            if (isFreeText) {
                let textarea = document.createElement('textarea');
                textarea.style.width = '100%';
                textarea.rows = 15;
                textarea.value = urlList.join('\n');
                list.appendChild(textarea);
                textarea.onchange = function () {
                    let text = textarea.value, lines = text.split('\n'), urls = [];
                    for (let i = 0; i < lines.length; i++) {
                        let url = lines[i].trim().toLowerCase();
                        if (url)
                            urls.push(url);
                    }
                    if (wzmShared && wzmShared.isValidUrlListEntry
                        && urls.some(url => !wzmShared.isValidUrlListEntry(url))) {
                        wzmShowSaveError();
                        return;
                    }
                    wzmRunSettingsWrite(
                        { r: 'setUrlList', urlList: urls },
                        done => {
                            if (wzmShared && wzmShared.isValidUrlListEntry
                                && urls.some(url => !wzmShared.isValidUrlListEntry(url))) {
                                done(false);
                                return;
                            }
                            wzmUpdateUrlListLocal(list => {
                                list.length = 0;
                                urls.forEach(u => list.push(u));
                            }, done);
                        },
                        { done: success => { if (success) CreateList(); } }
                    );
                };
            }
            else {
                for (let i = 0; i < urlList.length; i++)
                    list.appendChild(createListItem(urlList[i]));
            }
        });
    }
    freeText.onclick = function () {
        isFreeText = freeText.checked;
        CreateList();
    };
    CreateList();

    function renderAllowSafeList(allowList) {
        if (!allowSafeList)
            return;
        allowSafeList.innerHTML = '';
        for (let i = 0; i < allowList.length; i++)
            allowSafeList.appendChild(createListItem(allowList[i]));
    }
    function addAllowSafeEntry() {
        if (!allowSafeAdd)
            return false;
        let domain = wzmNormalizeDomainEntry(allowSafeAdd.value);
        if (!domain)
            return false;
        wzmRunSettingsWrite(
            { r: 'allowSafeForDomain', domain: domain, toggle: true },
            done => wzmUpdateAllowSafeDomainsLocal(list => { wzmAddUnique(list, domain); }, done),
            { done: success => { if (success) wzmGetAllowSafeDomains(renderAllowSafeList); } }
        );
        allowSafeAdd.value = '';
        return true;
    }
    if (allowSafeForm) {
        allowSafeForm.addEventListener('submit', function (ev) {
            if (ev) {
                ev.preventDefault();
                ev.stopPropagation();
            }
            addAllowSafeEntry();
            return false;
        });
    }
    if (allowSafeAdd) {
        allowSafeAdd.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                addAllowSafeEntry();
            }
        });
    }
    if (allowSafeList) {
        allowSafeList.onclick = ev => {
            let del = ev.target.closest('.delete');
            if (del) {
                let item = ev.target.closest('.item');
                let domain = item.querySelector('.url');
                domain = domain ? domain.textContent : '';
                wzmRunSettingsWrite(
                    { r: 'allowSafeForDomain', domain: domain, toggle: false },
                    done => wzmUpdateAllowSafeDomainsLocal(list => {
                        let index = list.findIndex(entry => wzmNormalizeDomainEntry(entry) === wzmNormalizeDomainEntry(domain));
                        if (index !== -1)
                            list.splice(index, 1);
                    }, done),
                    { done: success => { if (success) wzmGetAllowSafeDomains(renderAllowSafeList); } }
                );
            }
        };
    }
    wzmGetAllowSafeDomains(renderAllowSafeList);

    function createElementWithClass(cls, tag) {
        let el = document.createElement(tag || 'div');
        el.className = cls;
        return el;
    }
}
