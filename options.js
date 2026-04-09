{
    var wzmBrowser = typeof browser !== 'undefined' ? browser : null;
    var wzmChrome = typeof chrome !== 'undefined' ? chrome : null;
    var wzmRuntime = (wzmChrome && wzmChrome.runtime) || (wzmBrowser && wzmBrowser.runtime) || null;
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
    function wzmUpdateAllowSafeDomainsLocal(updateFn, done) {
        wzmStorageGetLocal(['allowSafeDomains'], function (data) {
            let list = (data && Array.isArray(data.allowSafeDomains)) ? data.allowSafeDomains : [];
            updateFn(list);
            let ret = wzmStorageSetLocal({ allowSafeDomains: list });
            if (done) {
                if (ret && typeof ret.then === 'function')
                    ret.then(() => done(list)).catch(() => done(list));
                else
                    setTimeout(() => done(list), 0);
            }
        });
    }
    function wzmGetSettings(callback) {
        wzmSendMessage({ r: 'getSettings' }, function (settings) {
            if (settings && typeof settings === 'object') {
                callback(settings);
                return;
            }
            wzmStorageGetLocal(['settings'], function (data) {
                let s = data && data.settings ? data.settings : wzmDefaultSettings();
                callback(s);
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
    const originalAppend = Element.prototype.append;
    Element.prototype.append = function (...args) {
        originalAppend.apply(this, args);
        return this;
    };
    Element.prototype.setText = function (t) {
        this.innerText = t;
        return this;
    }

    let addName = document.getElementById('addName'),
        phoneW = document.getElementById('phone-w'),
        noEye = document.getElementById('noEye'),
        alwaysBlock = document.getElementById('always-block'),
        list = document.getElementById('list'),
        allowSafeSection = document.getElementById('always-block-exclusions-section'),
        allowSafeForm = document.getElementById('allow-safe-form'),
        allowSafeAdd = document.getElementById('allow-safe-add'),
        allowSafeList = document.getElementById('allow-safe-list'),
        whiteBlackList = document.getElementById('w-b-list'),
        form = document.getElementById('form'),
        freeText = document.getElementById('free-text'),
        maxSafe = document.getElementById('max-safe'),
        closeOnClick = document.getElementById('close-on-click'),
        exclusions = document.getElementById('exclusions'),
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
            if (infoTooltip.dataset.anchor === icon.dataset.tooltipId && infoTooltip.classList.contains('show')) {
                infoTooltip.classList.remove('show');
                return;
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
            let pageX = rect.left + rect.width / 2 + scrollX;
            let left = pageX - tooltipWidth / 2;
            let minLeft = 8 + scrollX;
            let maxLeft = scrollX + document.documentElement.clientWidth - tooltipWidth - 8;
            if (left < minLeft) left = minLeft;
            if (left > maxLeft) left = maxLeft;
            let top = rect.bottom + 8 + scrollY;
            if (top + tooltipHeight > scrollY + window.innerHeight - 8) {
                top = rect.top - tooltipHeight - 8 + scrollY;
            }
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
            try {
                window.close();
            } catch (err) { }
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
    wzmGetSettings(function (settings) {
        noEye.checked = settings.noEye;
        alwaysBlock.checked = !!settings.alwaysBlock;
        if (allowSafeSection)
            allowSafeSection.style.display = alwaysBlock.checked ? '' : 'none';
        closeOnClick.checked = settings.closeOnClick;
        whiteBlackList.value = settings.blackList ? 'B' : 'W';
        exclusions.setAttribute('data-type', whiteBlackList.value);
        maxSafe.value = settings.maxSafe;
        $phone_t_t.setText(settings.phone || 'No Phone Number')
        $phone_t_set.setText(settings.phone ? 'Modify Number' : 'Set Number')
        phoneW.setAttribute('data-has-num', settings.phone ? 'Y' : 'N')
        if (settings.unwanted) {
            if (unwanted_ideas.indexOf(settings.unwanted) > -1) {
                $unwanted_opt.value = settings.unwanted;
            }
            else {
                $unwanted_opt.value = 'cust';
                $unwanted_w.classList.add('cust');
                $unwanted_cust.value = settings.unwanted;
            }
        }
    });
    if (wzmRuntime && wzmRuntime.onMessage && wzmRuntime.onMessage.addListener) {
        wzmRuntime.onMessage.addListener(function (request) {
            if (request.r == 'urlListModified')
                CreateList();
        });
    }
    noEye.onclick = function () {
        wzmSendMessage({ r: 'setNoEye', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.noEye = !!noEye.checked; });
    };
    alwaysBlock.onclick = function () {
        wzmSendMessage({ r: 'setAlwaysBlock', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.alwaysBlock = !!alwaysBlock.checked; });
        if (allowSafeSection)
            allowSafeSection.style.display = alwaysBlock.checked ? '' : 'none';
    };
    whiteBlackList.onchange = function () {
        wzmSendMessage({ r: 'setBlackList', toggle: whiteBlackList.value == 'B' });
        exclusions.setAttribute('data-type', whiteBlackList.value);
        wzmUpdateSettingsLocal(s => { s.blackList = (whiteBlackList.value == 'B'); });
    };
    maxSafe.onchange = function () {
        wzmSendMessage({ r: 'setMaxSafe', maxSafe: maxSafe.value });
        wzmUpdateSettingsLocal(s => { s.maxSafe = +maxSafe.value || 32; });
    };
    closeOnClick.onclick = function () {
        wzmSendMessage({ r: 'setCloseOnClick', toggle: this.checked });
        wzmUpdateSettingsLocal(s => { s.closeOnClick = !!closeOnClick.checked; });
    };
    window.onunload = () => maxSafe.blur();
    form.onsubmit = function () {
        let url = addName.value.trim().toLowerCase();
        if (!url.length) return;
        wzmSendMessage({ r: 'urlListAdd', url: url });
        wzmUpdateUrlListLocal(list => { list.push(url); });
        CreateList();
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
            });
            CreateList();
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
                    });
                    CreateList();
                };
            }
            else {
                for (let i = 0; i < urlList.length; i++) {
                    let item = m$('item');
                    item.className = 'item';
                    item.ix = i;
                    item.innerHTML = `<span class='url'>${urlList[i]}</span><span class='delete'>X</span>`;
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
            item.innerHTML = `<span class='url'>${allowList[i]}</span><span class='delete'>X</span>`;
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
            if (list.indexOf(url) === -1)
                list.push(url);
        }, renderAllowSafeList);
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
                }, renderAllowSafeList);
            }
        };
    }
    function CreateAllowSafeList() {
        if (!allowSafeList)
            return;
        wzmGetAllowSafeDomains(renderAllowSafeList);
    }
    CreateAllowSafeList();

    //phone
    let $phone_t_set = document.getElementById('phone-t-set'), $phone_t_t = document.getElementById('phone-t-t');
    $phone_t_set.onclick = () => {
        let $cc = m$('cc', 'select', { required: true }).append(m$('', 'option').setText('Country')),
            $num = m$('num', 'input', { type: 'tel', required: true, placeholder: 'Phone number', inputMode: 'numeric', pattern: '[0-9]*', autocomplete: 'tel' }),
            $wa = m$('method-radio', 'input', { type: 'radio', name: 'method', checked: true }), $waW = m$('method-lbl wa', 'label').append($wa, ' WhatsApp'),
            $sms = m$('method-radio', 'input', { type: 'radio', name: 'method' }), $smsW = m$('method-lbl sms', 'label').append($sms, ' SMS'),
            $noWhatsApp = m$('no-wa').setText("If you don't have WhatsApp, email your phone number to ai@wizmage.com and we will try to email you your code."),
            $cancel = m$('cancel', 'button', { type: 'button' }).setText('Cancel'),
            $phoneD = m$('dialog', 'form').append(m$('c').append(
                m$('icon-w').append(m$('', 'img', { src: 'green-tick.png' })),
                m$('h').setText('Enter your phone number'),
                m$('t').setText('For security reasons we need to verify your phone number. ').append(m$('', 'a', { href: 'https://wizmage.com/ai#privacy', target: '_blank' }).setText('Why')),
                m$('phone').append($cc, $num),
                m$('method').append($waW, $smsW, $noWhatsApp),
                m$('ctrls').append($cancel, m$('cont', 'button').setText('Continue')),
            ));
        for (let c of [
            ["Australia", "61"],
            ["Belgium", "32"],
            ["Canada", "1"],
            ["France", "33"],
            ["Israel", "972"],
            ["Pakistan", "92"],
            ["Poland", "48"],
            ["UK", "44"],
            ["USA", "1"]
        ]) {
            $cc.append(m$('', 'option', { value: c[1] }).setText(c[0]));
        }
        $cc.onchange = () => {
            let cc = $cc.value, validCC = !!cc;
            $phoneD.classList.toggle('valid-cc', validCC);
            $phoneD.classList.toggle('cc-usa', cc == '1');
            if (cc != '1')
                $wa.checked = true;
            if (validCC)
                $num.focus();
            //I know some communities in these countries, and feel I can distinguish spam from real, manually.
            $noWhatsApp.style.display = cc == '44' || cc == '972' ? 'block' : 'none';
        };
        $num.oninput = () => {
            if (/[^0-9]/.test($num.value))
                $num.value = $num.value.replace(/[^0-9]/g, '');
        };
        $cancel.onclick = () => $phoneD.remove();
        showDialog($phoneD, 'send_code',
            () => $cc.focus(),
            () => {
                let cc = $cc.value, num = $num.value;
                if ((cc == '1' && num[0] == '1') || (cc != '1' && num[0] == '0'))
                    num = num.substr(1)
                if ((cc == '1' && num.length != 10) || num.length < 4 || num.length > 15) {
                    alert('Phone number is not the correct length.');
                    return;
                }
                let phone = '+' + cc + num;
                return { phone, sms: $sms.checked };
            },
            (data, r) => {
                let phone = data.phone,
                    $digits = m$('field digits'),
                    $cancel = m$('cancel', 'button', { type: 'button' }).setText('Cancel'),
                    $codeD = m$('dialog', 'form').append(m$('c').append(
                        m$('icon-w').append(m$('', 'img', { src: 'green-tick.png' })),
                        m$('h').setText('Verify your number'),
                        m$('t').setText('We sent your code. Enter it below. ').append(m$('', 'a', { href: 'https://wizmage.com/ai#privacy', target: '_blank' }).setText('Why')),
                        $digits,
                        m$('ctrls').append($cancel, m$('cont', 'button').setText('Continue'))
                    )),
                    digits = [], numDigits = 8;
                let firstDigit;
                for (let i = 0; i < numDigits; i++) {
                    let attrs = { required: 'required', maxlength: 1, type: 'tel', inputMode: 'numeric', pattern: '[0-9]*' };
                    if (i === 0 && isIOS) {
                        attrs.maxlength = numDigits;
                        attrs.autocomplete = 'one-time-code';
                        attrs.name = 'one-time-code';
                    }
                    let $digit = m$('digit', 'input', attrs);
                    if (i === 0)
                        firstDigit = $digit;
                    $digits.append($digit);
                    digits.push($digit);
                    $digit.oninput = () => {
                        if ($digit.value) {
                            let v = $digit.value.replace(/[^0-9]/g, '');
                            if (i === 0 && v.length > 1) {
                                for (let j = 0; j < numDigits; j++)
                                    digits[j].value = v[j] || '';
                                return;
                            }
                            $digit.value = v.slice(0, 1);
                            if (i < numDigits - 1 && v.length === 1)
                                digits[i + 1].focus();
                        }
                    };
                    $digit.onpaste = ev => {
                        let v = ev.clipboardData.getData('text').trim();
                        if (v.length == numDigits) {
                            ev.preventDefault();
                            for (let i = 0; i < numDigits; i++)
                                digits[i].value = v.substr(i, 1);
                        }
                    };
                    $digit.onkeydown = ev => {
                        if (ev.key == 'Backspace' && !ev.currentTarget.value && i > 0) {
                            digits[i - 1].focus();
                        }
                    };
                    $digit.inputMode = 'numeric';
                    $digit.pattern = '[0-9]*';
                    if (i == 0 && !isIOS)
                        $digit.autocomplete = 'one-time-code';
                }
                $cancel.onclick = () => $codeD.remove();
                if (isIOS && firstDigit) {
                    let unlockFocus = () => {
                        try { firstDigit.focus({ preventScroll: true }); } catch (err) { firstDigit.focus(); }
                        if (firstDigit.select) firstDigit.select();
                        $codeD.removeEventListener('touchstart', unlockFocus, true);
                        $codeD.removeEventListener('click', unlockFocus, true);
                    };
                    $codeD.addEventListener('touchstart', unlockFocus, { capture: true, passive: true });
                    $codeD.addEventListener('click', unlockFocus, true);
                }
                showDialog($codeD, 'verify_code',
                    () => {
                        if (!firstDigit) return;
                        setTimeout(() => {
                            try { firstDigit.focus({ preventScroll: true }); } catch (err) { firstDigit.focus(); }
                            if (firstDigit.select) firstDigit.select();
                        }, 50);
                    },
                    () => {
                        let data = {
                            phone,
                            code: ''
                        };
                        digits.forEach(x => data.code += x.value);
                        return data;
                    },
                    (data, r) => {
        wzmSendMessage({ r: 'setToken', token: r.token, phone })
        wzmUpdateSettingsLocal(s => { s.token = r.token; s.phone = phone; });
        $phone_t_t.setText(phone);
        $phone_t_set.setText('Modify Number')
        phoneW.setAttribute('data-has-num', 'Y')
                    }
                );
            }
        );
    }

    //unwanted
    let $unwanted_w = document.getElementById('unwanted-w'), $unwanted_opt = document.getElementById('unwanted-opt'),
        $unwanted_cust = document.getElementById('unwanted-cust'),
        unwanted_ideas = ['nudity', 'delicious food', 'a woman', 'a man', 'advertizing'];
    for (let idea of unwanted_ideas) {
        let opt = document.createElement('option');
        opt.innerText = idea;
        $unwanted_opt.appendChild(opt);
    }
    let saveUnwanted = () => {
        let v = $unwanted_opt.value;
        if (v == 'cust')
            v = $unwanted_cust.value;
        wzmSendMessage({ r: 'setUnwanted', unwanted: v })
        wzmUpdateSettingsLocal(s => { s.unwanted = v; });
    };
    $unwanted_opt.onchange = () => {
        let v = $unwanted_opt.value;
        if (v == 'cust')
            $unwanted_w.classList.add('cust');
        else
            $unwanted_w.classList.remove('cust');
        saveUnwanted();
    }
    $unwanted_cust.oninput = saveUnwanted;

    function m$(cls, tag, attrs) {
        let el = document.createElement(tag || 'div');
        el.className = cls;
        if (attrs) {
            for (const [key, value] of Object.entries(attrs))
                el[key] = value;
        }
        return el;
    }

    function showDialog($d, endpoint, onShow, getData, onResp) {

        document.body.append($d);
        onShow();

        let submitting;
        $d.onsubmit = async ev => {
            ev.preventDefault();
            if (submitting) return;
            let data = getData();
            if (!data) return;
            submitting = true;
            let r;
            try {
                let resp = await fetch('https://wizman.wizmage.com/' + endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(data)
                }).finally(() => submitting = false);
                if (!resp.ok) throw new Error();
                r = await resp.json();
            }
            catch {
                alert('There was an error connecting to the server.');
                return;
            }
            if (r.err) {
                alert(r.err);
                return;
            }
            $d.remove();
            onResp(data, r);
        }
    }

}
