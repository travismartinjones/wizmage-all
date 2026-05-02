{
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
    function wzmStorageSetLocal(items, callback) {
        if (!wzmStorageLocal || !wzmStorageLocal.set) {
            if (callback) callback();
            return;
        }
        try {
            var maybePromise = wzmStorageLocal.set(items);
            if (maybePromise && typeof maybePromise.then === 'function') {
                if (callback) maybePromise.then(callback).catch(function () { callback(); });
                return maybePromise;
            }
        } catch (err) {
            // fall through
        }
        try {
            return wzmStorageLocal.set(items, callback);
        } catch (err) {
            if (callback) callback();
        }
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
    function wzmNormalizeSettings(settings) {
        settings = Object.assign(wzmDefaultSettings(), (settings && typeof settings === 'object') ? settings : {});
        if (!settings.blockTarget)
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
    function wzmUpdateSettingsLocal(updateFn, done) {
        wzmStorageGetLocal(['settings'], function (data) {
            let s = wzmNormalizeSettings(data && data.settings);
            updateFn(s);
            wzmStorageSetLocal({ settings: s }, function () {
                if (done) done(s);
            });
        });
    }
    function wzmUpdateUrlListLocal(updateFn, done) {
        wzmStorageGetLocal(['urlList'], function (data) {
            let list = (data && Array.isArray(data.urlList)) ? data.urlList : [];
            updateFn(list);
            wzmStorageSetLocal({ urlList: list }, function () {
                if (done) done(list);
            });
        });
    }
    function wzmUpdateAllowSafeDomainsLocal(updateFn, done) {
        wzmStorageGetLocal(['allowSafeDomains'], function (data) {
            let list = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
            updateFn(list);
            wzmStorageSetLocal({ allowSafeDomains: list }, function () {
                if (done) done(list);
            });
        });
    }
    function wzmGetSettings(callback) {
        wzmSendMessage({ r: 'getSettings' }, function (settings) {
            if (settings && typeof settings === 'object') {
                callback(wzmNormalizeSettings(settings));
                return;
            }
            wzmStorageGetLocal(['settings'], function (data) {
                callback(wzmNormalizeSettings(data && data.settings));
            });
        });
    }
    function wzmGetUrlList(callback) {
        wzmSendMessage({ r: 'getUrlList' }, function (urlList) {
            if (Array.isArray(urlList)) {
                callback(urlList);
                return;
            }
            wzmStorageGetLocal(['urlList'], function (data) {
                callback((data && Array.isArray(data.urlList)) ? data.urlList : []);
            });
        });
    }
    function wzmGetAllowSafeDomains(callback) {
        wzmStorageGetLocal(['allowSafeDomains'], function (data) {
            callback((data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : []);
        });
    }
    function wzmRefreshActiveTab() {
        if (!wzmTabs || !wzmTabs.query || !wzmTabs.sendMessage)
            return;
        let query = { active: true, currentWindow: true };
        if (wzmUsePromiseApi) {
            try {
                wzmTabs.query(query).then(tabs => {
                    if (tabs && tabs[0])
                        wzmTabs.sendMessage(tabs[0].id, { r: 'refreshSettings' }).catch(function () { });
                }).catch(function () { });
            } catch (err) { }
            return;
        }
        try {
            wzmTabs.query(query, function (tabs) {
                if (tabs && tabs[0])
                    wzmTabs.sendMessage(tabs[0].id, { r: 'refreshSettings' }, function () { });
            });
        } catch (err) { }
    }

    const originalAppend = Element.prototype.append;
    Element.prototype.append = function (...args) {
        originalAppend.apply(this, args);
        return this;
    };
    Element.prototype.setText = function (t) {
        this.innerText = t;
        return this;
    };

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

    wzmGetSettings(function (settings) {
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
    });

    if (wzmRuntime && wzmRuntime.onMessage && wzmRuntime.onMessage.addListener) {
        wzmRuntime.onMessage.addListener(function (request) {
            if (request.r == 'urlListModified')
                CreateList();
        });
    }

    for (let r of blockTargetRadios) {
        r.onclick = function () {
            wzmSendMessage({ r: 'setBlockTarget', blockTarget: this.value });
            wzmUpdateSettingsLocal(s => { s.blockTarget = this.value; }, wzmRefreshActiveTab);
        };
    }
    noPattern.onclick = function () {
        wzmSendMessage({ r: 'setNoPattern', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.noPattern = !!noPattern.checked; }, wzmRefreshActiveTab);
    };
    noEye.onclick = function () {
        wzmSendMessage({ r: 'setNoEye', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.noEye = !!noEye.checked; }, wzmRefreshActiveTab);
    };
    alwaysBlock.onclick = function () {
        wzmSendMessage({ r: 'setAlwaysBlock', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.alwaysBlock = !!alwaysBlock.checked; }, wzmRefreshActiveTab);
        if (allowSafeSection)
            allowSafeSection.style.display = alwaysBlock.checked ? '' : 'none';
    };
    whiteList.onclick = function () {
        wzmSendMessage({ r: 'setBlackList', toggle: false });
        wzmUpdateSettingsLocal(s => { s.blackList = false; }, wzmRefreshActiveTab);
    };
    blackList.onclick = function () {
        wzmSendMessage({ r: 'setBlackList', toggle: true });
        wzmUpdateSettingsLocal(s => { s.blackList = true; }, wzmRefreshActiveTab);
    };
    maxSafe.onchange = function () {
        wzmSendMessage({ r: 'setMaxSafe', maxSafe: maxSafe.value });
        wzmUpdateSettingsLocal(s => { s.maxSafe = +maxSafe.value || 32; }, wzmRefreshActiveTab);
    };
    closeOnClick.onclick = function () {
        wzmSendMessage({ r: 'setCloseOnClick', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.closeOnClick = !!closeOnClick.checked; });
    };
    window.onunload = () => maxSafe.blur();

    form.onsubmit = function () {
        let url = addName.value.trim().toLowerCase();
        if (!url.length) return false;
        wzmSendMessage({ r: 'urlListAdd', url: url });
        wzmUpdateUrlListLocal(list => { wzmAddUnique(list, url); }, function () {
            CreateList();
            wzmRefreshActiveTab();
        });
        addName.value = '';
        return false;
    };
    list.onclick = ev => {
        let del = ev.target.closest('.delete');
        if (del) {
            let item = ev.target.closest('.item');
            wzmSendMessage({ r: 'urlListRemove', index: item.ix });
            wzmUpdateUrlListLocal(list => {
                if (item.ix >= 0 && item.ix < list.length)
                    list.splice(item.ix, 1);
            }, function () {
                CreateList();
                wzmRefreshActiveTab();
            });
        }
    };
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
                        let url = lines[i].trim();
                        if (url)
                            urls.push(url);
                    }
                    wzmSendMessage({ r: 'setUrlList', urlList: urls }, CreateList);
                    wzmUpdateUrlListLocal(list => {
                        list.length = 0;
                        urls.forEach(u => list.push(u));
                    }, function () {
                        CreateList();
                        wzmRefreshActiveTab();
                    });
                };
            }
            else {
                for (let i = 0; i < urlList.length; i++) {
                    let item = m$('item');
                    item.className = 'item';
                    item.ix = i;
                    item.innerHTML = `<span class='delete'>X</span> <span class='url'>${urlList[i]}</span>`;
                    list.appendChild(item);
                }
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
        for (let i = 0; i < allowList.length; i++) {
            let item = m$('item');
            item.className = 'item';
            item.ix = i;
            item.innerHTML = `<span class='delete'>X</span> <span class='url'>${allowList[i]}</span>`;
            allowSafeList.appendChild(item);
        }
    }
    function addAllowSafeEntry() {
        if (!allowSafeAdd)
            return false;
        let url = allowSafeAdd.value.trim().toLowerCase();
        if (!url.length)
            return false;
        wzmUpdateAllowSafeDomainsLocal(list => {
            wzmAddUnique(list, url);
        }, function (list) {
            renderAllowSafeList(list);
            wzmRefreshActiveTab();
        });
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
                wzmUpdateAllowSafeDomainsLocal(list => {
                    if (item.ix >= 0 && item.ix < list.length)
                        list.splice(item.ix, 1);
                }, function (list) {
                    renderAllowSafeList(list);
                    wzmRefreshActiveTab();
                });
            }
        };
    }
    wzmGetAllowSafeDomains(renderAllowSafeList);

    function m$(cls, tag, attrs) {
        let el = document.createElement(tag || 'div');
        el.className = cls;
        if (attrs) {
            for (const [key, value] of Object.entries(attrs))
                el[key] = value;
        }
        return el;
    }
}
