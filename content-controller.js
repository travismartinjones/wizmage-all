(function (root, factory) {
    const Controller = factory(root && root.WizmageShared);
    if (typeof module !== 'undefined' && module.exports)
        module.exports = Controller;
    if (root)
        root.WizmageContentController = Controller;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Shared) {
    'use strict';

    if (!Shared)
        throw new Error('WizmageShared must load before content-controller.js');

    const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    const STYLE_MEDIA_PROPERTIES = [
        'backgroundImage', 'maskImage', 'webkitMaskImage', 'borderImageSource', 'listStyleImage', 'content'
    ];
    const DIRECT_MEDIA_SELECTOR = 'img,input[type="image"],canvas,svg,image,object,embed,video';
    const INLINE_STYLE_MEDIA_SELECTOR = '[style*="url("]';
    const MEDIA_PENDING_ATTRIBUTE = 'data-wzm-media-pending';
    const SHADOW_HOST_PENDING_ATTRIBUTE = 'data-wzm-shadow-pending';
    const EARLY_SHADOW_MEDIA_HOST_SELECTOR = 'syndigo-powerpage';
    const EARLY_SHADOW_MEDIA_HOSTS = new Set(['syndigo-powerpage']);
    const MEDIA_PENDING_FAIL_OPEN_MS = 5000;
    const SHADOW_HOST_PENDING_FAIL_OPEN_MS = 10000;
    const INITIAL_MEDIA_GATE_MIN_MS = 1750;
    const INITIAL_MEDIA_GATE_FAIL_OPEN_MS = 10000;
    const VISUAL_ATTRIBUTES = [
        'data-wzm-hide', 'data-wzm-locked', 'data-wzm-pattern-bg-img', 'data-wzm-shade',
        'data-wzm-checking', 'data-wzm-always', 'data-wzm-no-pattern', MEDIA_PENDING_ATTRIBUTE,
        'data-wzm-suppress-media', 'data-wzm-suppress-content',
        'data-wzm-suppress-self-media', 'data-wzm-suppress-before-media', 'data-wzm-suppress-after-media',
        'data-wzm-suppress-self-background', 'data-wzm-suppress-self-mask',
        'data-wzm-suppress-self-border', 'data-wzm-suppress-self-list', 'data-wzm-suppress-self-content',
        'data-wzm-suppress-before-background', 'data-wzm-suppress-before-mask',
        'data-wzm-suppress-before-border', 'data-wzm-suppress-before-list', 'data-wzm-suppress-before-content',
        'data-wzm-suppress-after-background', 'data-wzm-suppress-after-mask',
        'data-wzm-suppress-after-border', 'data-wzm-suppress-after-list', 'data-wzm-suppress-after-content'
    ];
    const VISUAL_ATTRIBUTE_SET = new Set(VISUAL_ATTRIBUTES);
    // WebKit 21624 can crash while resolving computed style for a transient
    // <textarea> (HTMLTextAreaElement::innerTextElement) on mutation-heavy pages.
    // Text controls are not useful image surfaces, so never force their layout
    // merely to look for a CSS background.
    const SKIP_BACKGROUND_TAGS = /^(?:HEAD|META|LINK|STYLE|SCRIPT|NOSCRIPT|TEMPLATE|SOURCE|TRACK|BR|HR|TEXTAREA)$/;
    const REPLACED_KINDS = new Set(['img', 'input-image', 'canvas', 'svg', 'object', 'embed', 'video-poster']);
    const MAX_ACTIVE_SCAN_JOBS = 128;
    const MAINTENANCE_INTERVAL_MS = 1000;
    const MAX_LATE_SHADOW_HOSTS = 1024;
    const MAX_PENDING_OBJECTS = 512;
    const MAX_MAINTENANCE_ELEMENTS = 128;
    const MAX_SHADOW_PROBES_PER_POLL = 4096;
    const MAX_SHADOW_ROOTS_PER_POLL = 64;
    const MAX_SHADOW_POLL_MS = 3;
    const MAX_SHADOW_STYLE_INSERTIONS_PER_WINDOW = 4;
    const SHADOW_STYLE_INSERTION_WINDOW_MS = 10000;
    const SHADOW_STYLE_RETRY_COOLDOWN_MS = 30000;
    const BUILT_IN_SHADOW_HOSTS = new Set([
        'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DIV', 'FOOTER', 'H1', 'H2',
        'H3', 'H4', 'H5', 'H6', 'HEADER', 'MAIN', 'NAV', 'P', 'SECTION', 'SPAN'
    ]);
    const UNKNOWN_OBJECT_GRACE_MS = 3000;
    const ANALYSIS_ERROR_RETRY_MS = 30000;
    const MAX_STYLESHEET_ROOTS_PER_POLL = 64;
    const MAX_STYLESHEETS_PER_POLL = 256;
    const MAX_CSS_RULES_PER_POLL = 4096;
    const MAX_CSS_POLL_MS = 4;
    const MAX_SELECTOR_ATTRIBUTES = 512;
    const ATTRIBUTE_SUBTREE_MIN_INTERVAL_MS = 1000;
    const UNKNOWN_ATTRIBUTE_SUBTREE_INTERVAL_MS = 30000;
    const COMMON_SELECTOR_ATTRIBUTES = new Set([
        'class', 'id', 'style', 'dir', 'lang', 'open', 'hidden', 'checked',
        'disabled', 'selected', 'inert', 'aria-expanded', 'aria-hidden',
        'data-state', 'data-theme', 'data-mode'
    ]);

    class WizmageContentController {
        constructor(win, settings, environment) {
            this.win = win;
            this.doc = win.document;
            this.settings = Shared.normalizeSettings(settings);
            this.environment = environment || {};
            const userAgent = String(win.navigator && win.navigator.userAgent || '');
            this.usesSafariTextControlLayoutGuard = /\bSafari\//.test(userAgent)
                && !/\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)\//.test(userAgent);
            this.hasSeenTextareaLayoutHazard = false;
            this.noteTextareaLayoutHazard(this.doc);
            this.extensionUrl = this.environment.getURL ? this.environment.getURL('') : '';
            this.active = false;
            this.started = false;
            this.settingsRevision = 1;
            this.records = new Set();
            this.recordsByElement = new WeakMap();
            this.svgMutationVersions = new WeakMap();
            this.observers = new Set();
            this.observerRoots = new Map();
            this.shadowStyleLinks = new Set();
            this.shadowStyleByRoot = new WeakMap();
            this.shadowStyleRepairByRoot = new WeakMap();
            this.shadowStyleRootByLink = new WeakMap();
            this.shadowStyleKeyByRoot = new WeakMap();
            const configuredShadowRetry = Number(this.environment.shadowStyleRetryCooldownMs);
            this.shadowStyleRetryCooldownMs = Number.isFinite(configuredShadowRetry) && configuredShadowRetry >= 1
                ? configuredShadowRetry : SHADOW_STYLE_RETRY_COOLDOWN_MS;
            this.resourceObserver = null;
            this.resourceScanTimeout = null;
            this.observedRoots = new WeakSet();
            this.queuedRoots = new WeakSet();
            this.customElementChecks = new WeakSet();
            this.customElementDefinitionChecks = new Set();
            this.lateShadowHosts = new Set();
            this.pendingObjectElements = new Set();
            this.objectFirstSeen = new WeakMap();
            this.loadedObjectUrls = new WeakMap();
            this.stylesheetSignature = null;
            this.stylesheetRevision = 0;
            this.stylesheetPollNumber = 0;
            this.stylesheetPollingStarted = false;
            this.stylesheetRoots = new Set();
            this.stylesheetRootSheetCounts = new WeakMap();
            this.stylesheetRootSheetOffsets = new WeakMap();
            this.cssSheetStates = new WeakMap();
            this.selectorAttributeNames = new Set();
            this.shadowProbeRoots = new Set();
            this.shadowProbeWalkers = new WeakMap();
            this.maintenanceTimeout = null;
            this.affectedTreeLastQueued = new WeakMap();
            this.unknownAttributeLastQueued = new WeakMap();
            this.deferredUnknownAttributeRoots = new Set();
            this.unknownAttributeFallbackTimeout = null;
            this.deferredAffectedTreeRoots = new Set();
            this.affectedTreeThrottleTimeout = null;
            this.scanJobs = [];
            this.deferredScanScopes = new Set();
            this.pendingElements = new Set();
            this.pendingMediaElements = new Map();
            this.pendingMediaTimeout = null;
            this.pendingShadowHosts = new Map();
            this.pendingShadowHostTimeout = null;
            this.shadowPendingReleaseLinks = new WeakSet();
            this.inspectedMediaUrls = new WeakMap();
            this.initialMediaGatePending = false;
            this.initialMediaGateStartedAt = 0;
            this.initialMediaGateMinimumTimeout = null;
            this.initialMediaGateTimeout = null;
            this.listeners = [];
            this.timeouts = new Set();
            this.idleHandle = null;
            this.idleHandleKind = null;
            this.scanScheduled = false;
            this.preferPendingElement = true;
            this.ownWrites = new WeakMap();
            this.eye = null;
            this.eyeRecord = null;
            this.eyeHideTimeout = null;
            this.pruneTimeout = null;
            this.resizeScanTimeout = null;
            this.hoverScanRoot = null;
            this.hoverScanTimeout = null;
            this.dynamicSubtreeRoots = new Set();
            this.dynamicSubtreeTimeout = null;
            this.rootPatternValues = null;
            this.rootHadStyleAttribute = false;
            this.lastFullScanAt = 0;
            this.lastScanError = null;
            this.boundMutationHandler = mutations => this.onMutations(mutations);
        }

        start() {
            if (this.active)
                return;
            this.active = true;
            this.startMediaGateCycle();
            if (this.isRawMediaDocument()) {
                this.revealRoot();
                return;
            }
            if (this.doc.readyState === 'loading') {
                this.listen(this.doc, 'DOMContentLoaded', () => {
                    this.begin();
                    this.createEye();
                    if (this.doc.body) {
                        this.markPendingMediaTree(this.doc.body, true);
                        this.markPendingShadowHostTree(this.doc.body, true);
                        this.queueTree(this.doc.body, true);
                    }
                    else {
                        this.finishInitialMediaGate();
                    }
                }, { once: true });
            }
            if (this.doc.documentElement)
                this.begin();
            else if (this.doc.readyState !== 'loading')
                this.setTrackedTimeout(() => this.begin(), 0);
        }

        begin() {
            if (!this.active || this.started || !this.doc.documentElement)
                return;
            this.started = true;
            this.noteTextareaLayoutHazard(this.doc);
            this.doc.documentElement.classList.add('wizmage-running');
            this.applyPatternVariables(this.doc);
            this.createEye();
            this.markPendingMediaTree(this.doc.documentElement, true);
            this.markPendingShadowHostTree(this.doc.documentElement, true);
            this.observeRoot(this.doc);
            this.observeCssResources();
            this.installLifecycleListeners();
            this.queueTree(this.doc.documentElement, true);
            this.lastFullScanAt = Date.now();
            this.stylesheetSignature = this.computeStylesheetSignature();
            this.scheduleMaintenance();
        }

        destroy(options) {
            options = options || {};
            this.active = false;
            if (options.show !== false)
                this.revealRoot();
            this.settingsRevision++;
            this.cancelScheduledWork();
            for (const observer of this.observers)
                observer.disconnect();
            this.observers.clear();
            this.observerRoots.clear();
            if (this.resourceObserver) {
                try { this.resourceObserver.disconnect(); } catch (err) { /* ignore */ }
            }
            this.resourceObserver = null;
            this.resourceScanTimeout = null;
            for (const link of this.shadowStyleLinks) {
                try { link.remove(); } catch (err) { /* ignore */ }
            }
            this.shadowStyleLinks.clear();
            this.shadowStyleByRoot = new WeakMap();
            this.shadowStyleRepairByRoot = new WeakMap();
            this.shadowStyleRootByLink = new WeakMap();
            this.shadowStyleKeyByRoot = new WeakMap();
            for (const item of this.listeners) {
                try { item.target.removeEventListener(item.type, item.listener, item.options); } catch (err) { /* ignore */ }
            }
            this.listeners.length = 0;
            for (const record of Array.from(this.records))
                this.cancelRecordAnalyses(record);
            if (options.show !== false) {
                for (const record of Array.from(this.records))
                    this.showRecord(record, false, true);
            }
            this.records.clear();
            this.recordsByElement = new WeakMap();
            this.svgMutationVersions = new WeakMap();
            for (const element of this.pendingMediaElements.keys()) {
                try { element.removeAttribute(MEDIA_PENDING_ATTRIBUTE); } catch (err) { /* ignore */ }
            }
            this.pendingMediaElements.clear();
            this.pendingMediaTimeout = null;
            for (const element of this.pendingShadowHosts.keys()) {
                try { element.removeAttribute(SHADOW_HOST_PENDING_ATTRIBUTE); } catch (err) { /* ignore */ }
            }
            this.pendingShadowHosts.clear();
            this.pendingShadowHostTimeout = null;
            this.shadowPendingReleaseLinks = new WeakSet();
            this.inspectedMediaUrls = new WeakMap();
            this.initialMediaGatePending = false;
            this.initialMediaGateStartedAt = 0;
            this.initialMediaGateMinimumTimeout = null;
            this.initialMediaGateTimeout = null;
            this.ownWrites = new WeakMap();
            this.pendingElements.clear();
            this.scanJobs.length = 0;
            this.deferredScanScopes.clear();
            this.observedRoots = new WeakSet();
            this.queuedRoots = new WeakSet();
            this.preferPendingElement = true;
            this.customElementChecks = new WeakSet();
            this.customElementDefinitionChecks.clear();
            this.lateShadowHosts.clear();
            this.pendingObjectElements.clear();
            this.objectFirstSeen = new WeakMap();
            this.loadedObjectUrls = new WeakMap();
            this.stylesheetSignature = null;
            this.stylesheetRevision = 0;
            this.stylesheetPollNumber = 0;
            this.stylesheetPollingStarted = false;
            this.stylesheetRoots.clear();
            this.stylesheetRootSheetCounts = new WeakMap();
            this.stylesheetRootSheetOffsets = new WeakMap();
            this.cssSheetStates = new WeakMap();
            this.selectorAttributeNames.clear();
            this.shadowProbeRoots.clear();
            this.shadowProbeWalkers = new WeakMap();
            this.maintenanceTimeout = null;
            this.affectedTreeLastQueued = new WeakMap();
            this.unknownAttributeLastQueued = new WeakMap();
            this.deferredUnknownAttributeRoots.clear();
            this.unknownAttributeFallbackTimeout = null;
            this.deferredAffectedTreeRoots.clear();
            this.affectedTreeThrottleTimeout = null;
            this.pruneTimeout = null;
            this.resizeScanTimeout = null;
            this.hoverScanRoot = null;
            this.hoverScanTimeout = null;
            this.dynamicSubtreeRoots.clear();
            this.dynamicSubtreeTimeout = null;
            this.removeEye();
            this.restorePatternVariables();
            if (this.doc.documentElement) {
                this.doc.documentElement.classList.remove('wizmage-running');
                this.doc.documentElement.classList.add('wizmage-show-html');
            }
            this.started = false;
        }

        updateSettings(next) {
            const previous = this.settings;
            this.settings = Shared.normalizeSettings(next);
            const candidacyChanged = previous.maxSafe !== this.settings.maxSafe
                || previous.alwaysBlock !== this.settings.alwaysBlock;
            const classifierChanged = previous.blockTarget !== this.settings.blockTarget
                || previous.serverUrl !== this.settings.serverUrl;
            const safeDomainChanged = previous.allowSafeDomain !== this.settings.allowSafeDomain;
            if (this.eye)
                this.eye.style.display = 'none';
            if (classifierChanged || candidacyChanged) {
                this.startMediaGateCycle();
                for (const record of Array.from(this.records))
                    this.markMediaPending(record.element);
            }
            if (classifierChanged) {
                this.settingsRevision++;
                for (const record of Array.from(this.records)) {
                    this.cancelRecordAnalyses(record);
                    record.generation++;
                    record.safeKey = null;
                    record.userAllowedKey = null;
                    record.pendingKey = null;
                    record.pendingRevision = 0;
                    record.settledKey = null;
                    record.settledRevision = 0;
                    record.settledStatus = null;
                    record.retryAfter = 0;
                    this.queueElement(record.element);
                }
            }
            else if (candidacyChanged) {
                // Size and always-block changes do not alter the classifier
                // result. Preserve settled URL decisions and recompute whether
                // each existing record is still eligible/presented.
                for (const record of Array.from(this.records))
                    this.queueElement(record.element);
            }
            if (candidacyChanged) {
                // A previous threshold may have skipped an element before it had
                // a record. Revisit the document so newly eligible media cannot
                // remain permanently outside the filter.
                this.queueAllObservedRoots();
            }
            if (safeDomainChanged && !classifierChanged && !candidacyChanged)
                this.applySafeDomainPresentation();
            if (!classifierChanged && !candidacyChanged
                && previous.noPattern !== this.settings.noPattern) {
                for (const record of this.records) {
                    if (record.blocked)
                        this.applyVisual(record, record.status);
                }
            }
            if (!this.hasScanWork())
                this.finishInitialMediaGate();
        }

        setAllowSafeDomain(toggle) {
            this.updateSettings(Object.assign({}, this.settings, { allowSafeDomain: !!toggle }));
        }

        showCurrentImages() {
            if (!this.active)
                return false;
            this.pruneDisconnectedRecords();
            for (const record of Array.from(this.records)) {
                if (!record.element || !record.element.isConnected || record.element.ownerDocument !== this.doc)
                    continue;
                this.showRecord(record, true, false);
                this.clearMediaPending(record.element);
            }
            this.revealRoot();
            this.hideEye();
            return true;
        }

        applySafeDomainPresentation() {
            const enforceSafeBlock = this.settings.alwaysBlock && !this.settings.allowSafeDomain;
            for (const record of Array.from(this.records)) {
                if (!record || record.key == null)
                    continue;
                const isCachedSafe = record.safeKey === record.key
                    && record.safeRevision === this.settingsRevision;
                if (record.userAllowedKey === record.key && !(enforceSafeBlock && isCachedSafe)) {
                    this.showRecord(record, false, false);
                    continue;
                }
                if (!isCachedSafe)
                    continue;
                if (enforceSafeBlock) {
                    // Re-enabling Safe Block for the website supersedes an older
                    // one-image reveal, but only for media already proven safe.
                    record.userAllowedKey = null;
                    this.applyVisual(record, 'always');
                }
                else {
                    this.showRecord(record, false, false);
                }
            }
        }

        revealRoot() {
            this.initialMediaGatePending = false;
            this.initialMediaGateStartedAt = 0;
            this.cancelInitialMediaGateMinimumTimeout();
            this.cancelInitialMediaGateTimeout();
            if (!this.invokeMediaGate('release'))
                this.setRootClass('wizmage-media-starting', false);
            this.setRootClass('wizmage-show-html', true);
        }

        startMediaGateCycle() {
            this.cancelInitialMediaGateMinimumTimeout();
            this.cancelInitialMediaGateTimeout();
            this.initialMediaGatePending = true;
            this.initialMediaGateStartedAt = this.now();
            if (!this.invokeMediaGate('claim') && !this.invokeMediaGate('activate'))
                this.setRootClass('wizmage-media-starting', true);
            this.setRootClass('wizmage-show-html', false);
            this.initialMediaGateTimeout = this.setTrackedTimeout(() => {
                this.initialMediaGateTimeout = null;
                this.initialMediaGatePending = false;
                this.initialMediaGateStartedAt = 0;
                this.cancelInitialMediaGateMinimumTimeout();
                if (!this.invokeMediaGate('release'))
                    this.setRootClass('wizmage-media-starting', false);
            }, INITIAL_MEDIA_GATE_FAIL_OPEN_MS);
        }

        finishInitialMediaGate() {
            if (!this.initialMediaGatePending || !this.active || this.doc.readyState === 'loading' || this.hasScanWork())
                return false;
            const elapsed = this.now() - this.initialMediaGateStartedAt;
            if (elapsed < INITIAL_MEDIA_GATE_MIN_MS) {
                if (this.initialMediaGateMinimumTimeout == null) {
                    this.initialMediaGateMinimumTimeout = this.setTrackedTimeout(() => {
                        this.initialMediaGateMinimumTimeout = null;
                        this.finishInitialMediaGate();
                    }, INITIAL_MEDIA_GATE_MIN_MS - elapsed);
                }
                return false;
            }
            this.initialMediaGatePending = false;
            this.initialMediaGateStartedAt = 0;
            this.cancelInitialMediaGateMinimumTimeout();
            this.cancelInitialMediaGateTimeout();
            if (!this.invokeMediaGate('release'))
                this.setRootClass('wizmage-media-starting', false);
            return true;
        }

        invokeMediaGate(method) {
            const gate = this.win && this.win.WizmageMediaGate;
            if (!gate || typeof gate[method] !== 'function')
                return false;
            const root = this.doc.documentElement;
            const before = root && root.getAttribute ? root.getAttribute('class') : null;
            gate[method]();
            if (root && root.getAttribute) {
                const after = root.getAttribute('class');
                if (after !== before)
                    this.rememberOwnWrite(root, 'class', after);
            }
            return true;
        }

        setRootClass(name, active) {
            const root = this.doc.documentElement;
            if (!root)
                return;
            const before = root.getAttribute('class');
            root.classList.toggle(name, !!active);
            const after = root.getAttribute('class');
            if (after !== before)
                this.rememberOwnWrite(root, 'class', after);
        }

        cancelInitialMediaGateMinimumTimeout() {
            if (this.initialMediaGateMinimumTimeout == null)
                return;
            this.win.clearTimeout(this.initialMediaGateMinimumTimeout);
            this.timeouts.delete(this.initialMediaGateMinimumTimeout);
            this.initialMediaGateMinimumTimeout = null;
        }

        cancelInitialMediaGateTimeout() {
            if (this.initialMediaGateTimeout == null)
                return;
            this.win.clearTimeout(this.initialMediaGateTimeout);
            this.timeouts.delete(this.initialMediaGateTimeout);
            this.initialMediaGateTimeout = null;
        }

        isDirectMediaElement(element) {
            const tag = String(element && element.tagName || '').toUpperCase();
            return tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG' || tag === 'IMAGE'
                || tag === 'OBJECT' || tag === 'EMBED' || tag === 'VIDEO'
                || (tag === 'INPUT' && String(element.type || '').toLowerCase() === 'image');
        }

        markPendingMediaTree(root, includeRoot) {
            if (!root)
                return;
            if (includeRoot && root.nodeType === 1) {
                this.markMediaPending(root);
                this.markInlineStyleMediaPending(root);
            }
            if (!root.querySelectorAll)
                return;
            let media;
            try { media = root.querySelectorAll(DIRECT_MEDIA_SELECTOR); }
            catch (err) { return; }
            for (const element of media)
                this.markMediaPending(element);
            let styled;
            try { styled = root.querySelectorAll(INLINE_STYLE_MEDIA_SELECTOR); }
            catch (err) { return; }
            for (const element of styled)
                this.markInlineStyleMediaPending(element);
        }

        hasInlineStyleMedia(element) {
            const style = element && element.style;
            if (!style)
                return false;
            for (const property of STYLE_MEDIA_PROPERTIES) {
                if (Shared.extractCssUrls(style[property]).length)
                    return true;
            }
            return false;
        }

        markInlineStyleMediaPending(element) {
            if (!this.active || !element || element.nodeType !== 1 || !element.getAttribute
                || !this.hasInlineStyleMedia(element))
                return false;
            if (element.getAttribute(MEDIA_PENDING_ATTRIBUTE) === '1')
                return true;
            this.pendingMediaElements.set(element, this.now());
            this.writeAttribute(element, MEDIA_PENDING_ATTRIBUTE, '1');
            this.schedulePendingMediaFailOpen();
            return true;
        }

        markMediaPending(element) {
            if (!this.active || !this.isDirectMediaElement(element) || !element.getAttribute)
                return false;
            if (element.getAttribute(MEDIA_PENDING_ATTRIBUTE) === '1')
                return true;
            this.pendingMediaElements.set(element, this.now());
            this.writeAttribute(element, MEDIA_PENDING_ATTRIBUTE, '1');
            this.schedulePendingMediaFailOpen();
            return true;
        }

        clearMediaPending(element) {
            if (!element)
                return;
            this.pendingMediaElements.delete(element);
            this.writeAttribute(element, MEDIA_PENDING_ATTRIBUTE, null);
        }

        isEarlyShadowMediaHost(element) {
            return !!(element && element.localName
                && EARLY_SHADOW_MEDIA_HOSTS.has(String(element.localName).toLowerCase()));
        }

        markPendingShadowHostTree(root, includeRoot) {
            if (!root)
                return;
            if (includeRoot && root.nodeType === 1)
                this.markShadowHostPending(root);
            if (!root.querySelectorAll)
                return;
            let hosts;
            try { hosts = root.querySelectorAll(EARLY_SHADOW_MEDIA_HOST_SELECTOR); }
            catch (err) { return; }
            for (const host of hosts)
                this.markShadowHostPending(host);
        }

        markShadowHostPending(element) {
            if (!this.active || !this.isEarlyShadowMediaHost(element) || !element.getAttribute)
                return false;
            if (!this.pendingShadowHosts.has(element))
                this.pendingShadowHosts.set(element, {
                    createdAt: this.now(),
                    root: null,
                    scanComplete: false,
                    styleReady: false
                });
            if (element.getAttribute(SHADOW_HOST_PENDING_ATTRIBUTE) !== '1')
                this.writeAttribute(element, SHADOW_HOST_PENDING_ATTRIBUTE, '1');
            this.schedulePendingShadowHostFailOpen();
            return true;
        }

        clearShadowHostPending(element) {
            if (!element)
                return;
            this.pendingShadowHosts.delete(element);
            this.writeAttribute(element, SHADOW_HOST_PENDING_ATTRIBUTE, null);
        }

        schedulePendingMediaFailOpen() {
            if (!this.active || this.pendingMediaTimeout != null || !this.pendingMediaElements.size)
                return;
            let oldest = Infinity;
            for (const createdAt of this.pendingMediaElements.values())
                oldest = Math.min(oldest, createdAt);
            const delay = Math.max(0, MEDIA_PENDING_FAIL_OPEN_MS - (this.now() - oldest));
            this.pendingMediaTimeout = this.setTrackedTimeout(() => {
                this.pendingMediaTimeout = null;
                const cutoff = this.now() - MEDIA_PENDING_FAIL_OPEN_MS;
                for (const [element, createdAt] of Array.from(this.pendingMediaElements)) {
                    if (createdAt <= cutoff)
                        this.clearMediaPending(element);
                }
                this.schedulePendingMediaFailOpen();
            }, delay);
        }

        schedulePendingShadowHostFailOpen() {
            if (!this.active || this.pendingShadowHostTimeout != null || !this.pendingShadowHosts.size)
                return;
            let oldest = Infinity;
            for (const state of this.pendingShadowHosts.values())
                oldest = Math.min(oldest, state.createdAt);
            const delay = Math.max(0, SHADOW_HOST_PENDING_FAIL_OPEN_MS - (this.now() - oldest));
            this.pendingShadowHostTimeout = this.setTrackedTimeout(() => {
                this.pendingShadowHostTimeout = null;
                const cutoff = this.now() - SHADOW_HOST_PENDING_FAIL_OPEN_MS;
                for (const [element, state] of Array.from(this.pendingShadowHosts)) {
                    if (!element || !element.isConnected || element.ownerDocument !== this.doc || state.createdAt <= cutoff)
                        this.clearShadowHostPending(element);
                }
                this.schedulePendingShadowHostFailOpen();
            }, delay);
        }

        currentDirectMediaUrl(element) {
            const tag = String(element && element.tagName || '').toUpperCase();
            if (tag === 'IMG' || (tag === 'INPUT' && String(element.type || '').toLowerCase() === 'image'))
                return this.resolveMediaUrl(element.currentSrc || element.src || element.getAttribute('src'));
            if (tag === 'IMAGE') {
                let value = '';
                try { value = element.href && element.href.baseVal ? element.href.baseVal : ''; } catch (err) { /* ignore */ }
                return this.resolveMediaUrl(value || element.getAttribute('href') || element.getAttribute('xlink:href'));
            }
            if (tag === 'OBJECT')
                return this.resolveMediaUrl(element.data || element.getAttribute('data'));
            if (tag === 'EMBED')
                return this.resolveMediaUrl(element.src || element.getAttribute('src'));
            if (tag === 'VIDEO')
                return this.resolveMediaUrl(element.poster || element.getAttribute('poster'));
            return '';
        }

        shouldGateMediaMutation(element, attributeName) {
            if (!this.isDirectMediaElement(element))
                return false;
            const name = String(attributeName || '').toLowerCase();
            if (name === 'type')
                return true;
            // Geometry-only changes still queue candidacy inspection, but hiding
            // an already-safe IMG on every layout reconciliation recreates the
            // Gmail flicker this controller is designed to avoid.
            if (/^(?:width|height)$/.test(name))
                return false;
            if (!/^(?:src|srcset|sizes|data|href|xlink:href|poster)$/.test(name))
                return false;
            const previous = this.inspectedMediaUrls.get(element);
            const tag = String(element.tagName || '').toUpperCase();
            let current;
            if (name === 'src' && tag === 'IMG' && !String(element.getAttribute('srcset') || '').trim())
                current = this.resolveMediaUrl(element.getAttribute('src') || element.src);
            else if (name === 'src' && (tag === 'INPUT' || tag === 'EMBED'))
                current = this.resolveMediaUrl(element.getAttribute('src') || element.src);
            else if (name === 'data' && tag === 'OBJECT')
                current = this.resolveMediaUrl(element.getAttribute('data') || element.data);
            else if (name === 'poster' && tag === 'VIDEO')
                current = this.resolveMediaUrl(element.getAttribute('poster') || element.poster);
            else if (/^(?:href|xlink:href)$/.test(name) && tag === 'IMAGE')
                current = this.resolveMediaUrl(element.getAttribute(name));
            else
                current = this.currentDirectMediaUrl(element);
            return previous == null || previous !== current;
        }

        isRawMediaDocument() {
            const contentType = String(this.doc.contentType || '').toLowerCase();
            // Image documents (including image URLs loaded in iframes) still need
            // filtering. Video and PDF viewers stay untouched so their controls
            // and browser-provided viewer UI remain functional.
            return contentType.startsWith('video/') || contentType === 'application/pdf';
        }

        applyPatternVariables(doc) {
            if (!doc || !doc.documentElement || !doc.documentElement.style)
                return;
            if (doc === this.doc && !this.rootPatternValues) {
                this.rootPatternValues = new Map();
                this.rootHadStyleAttribute = doc.documentElement.hasAttribute('style');
                const style = doc.documentElement.style;
                const existingProperties = new Set(Array.from({ length: style.length }, (_, index) => style.item(index)));
                for (let i = 0; i < 8; i++) {
                    for (const name of ['--wzm-pattern-' + i, '--wzm-pattern-light-' + i]) {
                        this.rootPatternValues.set(name, {
                            existed: existingProperties.has(name),
                            value: style.getPropertyValue(name),
                            priority: style.getPropertyPriority(name)
                        });
                    }
                }
            }
            for (let i = 0; i < 8; i++) {
                doc.documentElement.style.setProperty('--wzm-pattern-' + i, 'url("' + this.getURL('pattern' + i + '.png') + '")');
                doc.documentElement.style.setProperty('--wzm-pattern-light-' + i, 'url("' + this.getURL('pattern-light' + i + '.png') + '")');
            }
        }

        restorePatternVariables() {
            if (!this.rootPatternValues || !this.doc.documentElement || !this.doc.documentElement.style)
                return;
            const style = this.doc.documentElement.style;
            for (const [name, original] of this.rootPatternValues) {
                if (original.existed)
                    style.setProperty(name, original.value, original.priority);
                else
                    style.removeProperty(name);
            }
            if (!this.rootHadStyleAttribute && style.length === 0)
                this.doc.documentElement.removeAttribute('style');
            this.rootPatternValues = null;
            this.rootHadStyleAttribute = false;
        }

        getURL(path) {
            return this.environment.getURL ? this.environment.getURL(path) : path;
        }

        listen(target, type, listener, options) {
            if (!target || !target.addEventListener)
                return;
            target.addEventListener(type, listener, options);
            this.listeners.push({ target, type, listener, options });
        }

        setTrackedTimeout(callback, delay) {
            const id = this.win.setTimeout(() => {
                this.timeouts.delete(id);
                if (this.active)
                    callback();
            }, delay);
            this.timeouts.add(id);
            return id;
        }

        cancelScheduledWork() {
            for (const id of this.timeouts)
                this.win.clearTimeout(id);
            this.timeouts.clear();
            if (this.idleHandle != null) {
                if (this.idleHandleKind === 'idle' && this.win.cancelIdleCallback)
                    this.win.cancelIdleCallback(this.idleHandle);
                else
                    this.win.clearTimeout(this.idleHandle);
            }
            this.idleHandle = null;
            this.idleHandleKind = null;
            this.scanScheduled = false;
        }

        installLifecycleListeners() {
            this.listen(this.doc, 'load', event => this.onResourceLoad(event), true);
            this.listen(this.doc, 'mouseover', event => this.onMouseOver(event), true);
            this.listen(this.doc, 'keydown', event => this.onKeyDown(event), false);
            this.listen(this.doc, 'transitionend', event => this.queueDynamicTarget(event.target), true);
            this.listen(this.doc, 'animationstart', event => this.queueDynamicTarget(event.target), true);
            this.listen(this.doc, 'animationend', event => this.queueDynamicTarget(event.target), true);
            this.listen(this.doc, 'click', event => this.onInteractionStateChange(event), true);
            this.listen(this.doc, 'input', event => this.onInteractionStateChange(event), true);
            this.listen(this.doc, 'change', event => this.onInteractionStateChange(event), true);
            this.listen(this.doc, 'focusin', event => this.onInteractionStateChange(event), true);
            this.listen(this.doc, 'focusout', event => this.onInteractionStateChange(event), true);
            this.listen(this.win, 'resize', () => this.onResize(), { passive: true });
            this.listen(this.win, 'hashchange', () => {
                this.queueAllObservedRoots();
                this.lastFullScanAt = Date.now();
            }, { passive: true });
            this.listen(this.win, 'scroll', () => this.hideEye(), { passive: true });
            this.listen(this.win, 'focus', () => this.onLifecycleWake(), { passive: true });
            this.listen(this.win, 'pageshow', () => this.onLifecycleWake(), { passive: true });
            this.listen(this.doc, 'visibilitychange', () => {
                if (!this.doc.hidden)
                    this.onLifecycleWake();
            }, { passive: true });
        }

        onResourceLoad(event) {
            const element = event && event.target;
            if (!element || element === this.doc)
                return;
            const tag = String(element.tagName || '').toUpperCase();
            if (/^(?:LINK|STYLE)$/.test(tag)) {
                this.queueStyleScope(element);
                return;
            }
            if (tag === 'OBJECT' || tag === 'EMBED') {
                const rawUrl = tag === 'OBJECT'
                    ? (element.data || element.getAttribute('data'))
                    : (element.src || element.getAttribute('src'));
                this.loadedObjectUrls.set(element, this.resolveMediaUrl(rawUrl));
                this.objectFirstSeen.delete(element);
                this.pendingObjectElements.delete(element);
            }
            if (tag === 'SOURCE')
                this.queueSourceOwner(element);
            else {
                if (this.isDirectMediaElement(element)
                    && this.inspectedMediaUrls.get(element) !== this.currentDirectMediaUrl(element))
                    this.markMediaPending(element);
                this.queueElement(element);
            }
        }

        onResize() {
            for (const record of Array.from(this.records))
                this.queueElement(record.element);
            if (this.doc.querySelectorAll) {
                for (const element of this.doc.querySelectorAll('img,input[type="image"],canvas,svg,image,object,embed'))
                    this.queueElement(element);
            }
            if (!this.resizeScanTimeout) {
                this.resizeScanTimeout = this.setTrackedTimeout(() => {
                    this.resizeScanTimeout = null;
                    this.queueAllObservedRoots();
                    this.lastFullScanAt = Date.now();
                }, 100);
            }
        }

        onLifecycleWake() {
            this.pruneDisconnectedRecords();
            for (const record of Array.from(this.records))
                this.queueElement(record.element);
            if (Date.now() - this.lastFullScanAt > 30000) {
                this.queueAllObservedRoots();
                this.lastFullScanAt = Date.now();
            }
        }

        queueDynamicTarget(target) {
            let element = target && target.nodeType === 1 ? target : null;
            for (let i = 0; element && i < 4; i++) {
                this.queueElement(element);
                let next = element.parentElement;
                if (!next && element.getRootNode) {
                    const root = element.getRootNode();
                    next = root && root.host ? root.host : null;
                }
                element = next;
            }
        }

        onInteractionStateChange(event) {
            const target = event && event.target && event.target.nodeType === 1 ? event.target : null;
            if (!target)
                return;
            this.queueDynamicTarget(target);
            let parent = target.parentElement;
            if (!parent && target.getRootNode) {
                const root = target.getRootNode();
                parent = root && root.host ? root.host : null;
            }
            if (parent)
                this.queueAffectedTree(parent);
        }

        observeRoot(root) {
            if (!root || this.observedRoots.has(root))
                return;
            const observer = new this.win.MutationObserver(this.boundMutationHandler);
            observer.observe(root, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true
            });
            this.observedRoots.add(root);
            this.observers.add(observer);
            this.observerRoots.set(observer, root);
            this.stylesheetRoots.add(root);
            this.shadowProbeRoots.add(root);
        }

        observeCssResources() {
            if (this.resourceObserver || typeof this.win.PerformanceObserver !== 'function')
                return;
            try {
                this.resourceObserver = new this.win.PerformanceObserver(list => {
                    if (!this.active)
                        return;
                    const hasPageCssResource = list.getEntries().some(entry =>
                        entry.initiatorType === 'css' && !this.isExtensionAsset(entry.name)
                    );
                    if (!hasPageCssResource || this.resourceScanTimeout)
                        return;
                    this.resourceScanTimeout = this.setTrackedTimeout(() => {
                        this.resourceScanTimeout = null;
                        this.queueAllObservedRoots();
                        this.lastFullScanAt = Date.now();
                    }, 120);
                });
                this.resourceObserver.observe({ type: 'resource', buffered: false });
            } catch (err) {
                if (this.resourceObserver) {
                    try { this.resourceObserver.disconnect(); } catch (disconnectError) { /* ignore */ }
                }
                this.resourceObserver = null;
            }
        }

        scheduleMaintenance() {
            if (!this.active || this.maintenanceTimeout)
                return;
            this.maintenanceTimeout = this.setTrackedTimeout(() => {
                this.maintenanceTimeout = null;
                this.runMaintenance();
                this.scheduleMaintenance();
            }, MAINTENANCE_INTERVAL_MS);
        }

        runMaintenance() {
            const signature = this.computeStylesheetSignature();
            if (this.stylesheetSignature != null && signature !== this.stylesheetSignature) {
                // CSSStyleSheet.insertRule/replaceSync and adoptedStyleSheets do
                // not produce DOM mutations or resource timing entries.
                this.queueAllObservedRoots();
                this.lastFullScanAt = Date.now();
            }
            this.stylesheetSignature = signature;
            this.pollLateShadowHosts();
            this.pollAllShadowHosts();
            this.pollPendingObjects();
            this.retryExpiredAnalyses();
        }

        retryExpiredAnalyses() {
            const now = Date.now();
            let queued = 0;
            for (const record of Array.from(this.records)) {
                if (queued >= MAX_MAINTENANCE_ELEMENTS)
                    break;
                if (record.settledStatus !== 'unchecked' || !record.retryAfter
                    || record.retryAfter > now || record.pendingKey != null)
                    continue;
                this.queueElement(record.element);
                queued++;
            }
        }

        computeStylesheetSignature() {
            const pollNumber = ++this.stylesheetPollNumber;
            const wasStarted = this.stylesheetPollingStarted;
            let changed = false;
            const roots = this.takeStylesheetRoots();
            const rootInfos = [];
            for (const root of roots) {
                const lists = [];
                let total = 0;
                for (const property of ['styleSheets', 'adoptedStyleSheets']) {
                    let list = null;
                    try { list = root[property] || null; } catch (err) { /* unsupported or inaccessible */ }
                    const length = list && Number.isFinite(Number(list.length)) ? Number(list.length) : 0;
                    if (!length)
                        continue;
                    lists.push({ list, start: total, length });
                    total += length;
                }
                const previousCount = this.stylesheetRootSheetCounts.get(root);
                if (previousCount != null && previousCount !== total)
                    changed = true;
                this.stylesheetRootSheetCounts.set(root, total);
                if (total) {
                    rootInfos.push({
                        root,
                        lists,
                        total,
                        start: (this.stylesheetRootSheetOffsets.get(root) || 0) % total,
                        taken: 0
                    });
                }
            }
            const sheets = [];
            const seen = new Set();
            const addFromRoot = info => {
                if (!info || info.taken >= info.total || sheets.length >= MAX_STYLESHEETS_PER_POLL)
                    return false;
                const flatIndex = (info.start + info.taken++) % info.total;
                let source = null;
                for (const candidate of info.lists) {
                    if (flatIndex >= candidate.start && flatIndex < candidate.start + candidate.length) {
                        source = candidate;
                        break;
                    }
                }
                if (!source)
                    return true;
                const localIndex = flatIndex - source.start;
                let sheet = null;
                try { sheet = source.list[localIndex] || (source.list.item && source.list.item(localIndex)); } catch (err) { /* ignore */ }
                if (sheet && !seen.has(sheet)) {
                    seen.add(sheet);
                    sheets.push(sheet);
                }
                return true;
            };
            const fairShare = rootInfos.length
                ? Math.max(1, Math.floor(MAX_STYLESHEETS_PER_POLL / rootInfos.length))
                : 0;
            for (const info of rootInfos) {
                const count = Math.min(info.total, fairShare);
                for (let index = 0; index < count; index++)
                    addFromRoot(info);
            }
            let progressed = true;
            while (sheets.length < MAX_STYLESHEETS_PER_POLL && progressed) {
                progressed = false;
                for (const info of rootInfos) {
                    if (addFromRoot(info))
                        progressed = true;
                    if (sheets.length >= MAX_STYLESHEETS_PER_POLL)
                        break;
                }
            }
            for (const info of rootInfos)
                this.stylesheetRootSheetOffsets.set(info.root, (info.start + info.taken) % info.total);

            // Give rule time to the least-recently sampled sheets first. Merely
            // rotating a root offset is ineffective when exactly the 256-sheet
            // cap is selected (256 mod 256 is zero), which could otherwise leave
            // later rule cursors at zero forever under the time deadline.
            sheets.sort((left, right) => {
                const leftState = this.cssSheetStates.get(left);
                const rightState = this.cssSheetStates.get(right);
                const leftInactive = leftState && leftState.ruleCount <= 0 ? 1 : 0;
                const rightInactive = rightState && rightState.ruleCount <= 0 ? 1 : 0;
                if (leftInactive !== rightInactive)
                    return leftInactive - rightInactive;
                return ((leftState && leftState.lastRuleSamplePoll) || 0)
                    - ((rightState && rightState.lastRuleSamplePoll) || 0);
            });

            // Root and sheet enumeration above is independently count-bounded.
            // Start the rule deadline afterwards so a large shadow-root set can
            // never starve every CSSOM cursor at zero.
            const deadline = this.now() + MAX_CSS_POLL_MS;
            const baseRuleBudget = sheets.length
                ? Math.max(1, Math.min(32, Math.floor(MAX_CSS_RULES_PER_POLL / sheets.length)))
                : 0;
            let remainingRuleBudget = MAX_CSS_RULES_PER_POLL;
            const incomplete = [];
            for (const sheet of sheets) {
                const result = this.sampleStylesheet(
                    sheet,
                    Math.min(baseRuleBudget, remainingRuleBudget),
                    pollNumber,
                    wasStarted,
                    deadline
                );
                remainingRuleBudget = Math.max(0, remainingRuleBudget - result.sampled);
                if (result.changed)
                    changed = true;
                if (result.incomplete)
                    incomplete.push(sheet);
            }
            let remainingWeight = incomplete.reduce((total, sheet) => {
                const state = this.cssSheetStates.get(sheet);
                return total + Math.max(1, state.ruleCount - state.cursor);
            }, 0);
            for (const sheet of incomplete) {
                if (!remainingRuleBudget)
                    break;
                const state = this.cssSheetStates.get(sheet);
                const weight = Math.max(1, state.ruleCount - state.cursor);
                const allocation = Math.max(1, Math.min(
                    remainingRuleBudget,
                    Math.floor(remainingRuleBudget * weight / Math.max(1, remainingWeight))
                ));
                const result = this.sampleStylesheet(sheet, allocation, pollNumber, wasStarted, deadline);
                remainingRuleBudget = Math.max(0, remainingRuleBudget - result.sampled);
                remainingWeight = Math.max(0, remainingWeight - weight);
                if (result.changed)
                    changed = true;
            }
            this.stylesheetPollingStarted = true;
            if (changed)
                this.stylesheetRevision++;
            return String(this.stylesheetRevision);
        }

        takeStylesheetRoots() {
            const roots = [];
            if (this.stylesheetRoots.has(this.doc))
                roots.push(this.doc);
            const attempts = this.stylesheetRoots.size;
            for (let index = 0; index < attempts && roots.length < MAX_STYLESHEET_ROOTS_PER_POLL; index++) {
                const iterator = this.stylesheetRoots.values();
                const next = iterator.next();
                if (next.done)
                    break;
                const root = next.value;
                this.stylesheetRoots.delete(root);
                const connected = root === this.doc
                    || (root && root.host && root.host.isConnected && root.host.ownerDocument === this.doc);
                if (connected)
                    this.stylesheetRoots.add(root);
                if (connected && root !== this.doc)
                    roots.push(root);
            }
            return roots;
        }

        sampleStylesheet(sheet, ruleBudget, pollNumber, wasStarted, deadline) {
            let media = '';
            let href = '';
            let disabled = false;
            try { media = sheet.media && sheet.media.mediaText || ''; } catch (err) { /* ignore */ }
            try { href = sheet.href || ''; } catch (err) { /* ignore */ }
            try { disabled = !!sheet.disabled; } catch (err) { /* ignore */ }
            let rules = null;
            let accessible = true;
            try { rules = sheet.cssRules; } catch (err) { accessible = false; }
            const metadata = href + '\u001f' + (disabled ? 1 : 0) + '\u001f' + media + '\u001f' + (accessible ? 1 : 0);
            let state = this.cssSheetStates.get(sheet);
            let changed = false;
            if (!state) {
                state = {
                    metadata,
                    ruleCount: accessible && rules ? rules.length : -1,
                    cursor: 0,
                    cycleHash: 2166136261,
                    previousCycleHash: null,
                    cycleStartedPoll: pollNumber,
                    lastRuleSamplePoll: 0
                };
                this.cssSheetStates.set(sheet, state);
                if (wasStarted)
                    changed = true;
            }
            else if (state.metadata !== metadata) {
                state.metadata = metadata;
                changed = true;
            }
            if (!accessible || !rules)
                return { changed, sampled: 0, incomplete: false };

            const count = rules.length;
            if (state.ruleCount !== count) {
                if (state.ruleCount >= 0)
                    changed = true;
                state.ruleCount = count;
                state.cursor = 0;
                state.cycleHash = 2166136261;
                state.previousCycleHash = null;
                state.cycleStartedPoll = pollNumber;
            }
            if (!count) {
                if (state.previousCycleHash == null)
                    state.previousCycleHash = state.cycleHash >>> 0;
                return { changed, sampled: 0, incomplete: false };
            }

            const end = Math.min(count, state.cursor + Math.max(1, ruleBudget));
            let index = state.cursor;
            let sampled = 0;
            for (; index < end && this.now() < deadline; index++) {
                let rule = null;
                let cssText = '';
                let selectorText = '';
                try { rule = rules[index]; } catch (err) { /* ignore */ }
                try { cssText = rule && rule.cssText || ''; } catch (err) { /* ignore */ }
                try { selectorText = rule && rule.selectorText || ''; } catch (err) { /* ignore */ }
                this.registerSelectorAttributes(selectorText || cssText.slice(0, 8192));
                state.cycleHash = this.hashCssValue(state.cycleHash, index + ':' + this.cssRuleFingerprint(cssText) + ';');
                sampled++;
            }
            state.cursor = index;
            if (sampled)
                state.lastRuleSamplePoll = pollNumber;
            if (state.cursor >= count) {
                const completedHash = state.cycleHash >>> 0;
                if (state.previousCycleHash != null && state.previousCycleHash !== completedHash)
                    changed = true;
                else if (state.previousCycleHash == null && pollNumber > state.cycleStartedPoll)
                    // A large initial sheet required multiple bounded samples.
                    // Queue one conservative scan because it could have changed
                    // while that baseline was being assembled.
                    changed = true;
                state.previousCycleHash = completedHash;
                state.cursor = 0;
                state.cycleHash = 2166136261;
                state.cycleStartedPoll = pollNumber;
            }
            return {
                changed,
                sampled,
                incomplete: state.cursor > 0 || (state.previousCycleHash == null && count > 0)
            };
        }

        cssRuleFingerprint(cssText) {
            cssText = String(cssText || '');
            if (cssText.length <= 2048)
                return this.hashString(cssText) + ':' + cssText.length;
            const middle = Math.max(0, Math.floor(cssText.length / 2) - 512);
            const sample = cssText.slice(0, 512)
                + cssText.slice(middle, middle + 1024)
                + cssText.slice(-512);
            return this.hashString(sample) + ':' + cssText.length;
        }

        hashCssValue(hash, value) {
            value = String(value || '');
            hash >>>= 0;
            for (let index = 0; index < value.length; index++) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return hash >>> 0;
        }

        registerSelectorAttributes(selectorText) {
            if (!selectorText || this.selectorAttributeNames.size >= MAX_SELECTOR_ATTRIBUTES)
                return;
            const pattern = /\[\s*([^\s~|^$*=\]]+)/g;
            let match;
            while ((match = pattern.exec(String(selectorText)))
                && this.selectorAttributeNames.size < MAX_SELECTOR_ATTRIBUTES) {
                this.selectorAttributeNames.add(String(match[1] || '').toLowerCase());
            }
        }

        pollLateShadowHosts() {
            const candidates = Array.from(this.lateShadowHosts).slice(0, MAX_MAINTENANCE_ELEMENTS);
            for (const element of candidates) {
                this.lateShadowHosts.delete(element);
                if (!element || !element.isConnected || element.ownerDocument !== this.doc)
                    continue;
                const shadow = this.getShadowRoot(element);
                if (!shadow) {
                    this.lateShadowHosts.add(element);
                    continue;
                }
                this.observeDiscoveredShadowRoot(shadow, element);
            }
        }

        pollAllShadowHosts() {
            const roots = this.takeShadowProbeRoots();
            if (!roots.length)
                return;
            const deadline = this.now() + MAX_SHADOW_POLL_MS;
            let remaining = MAX_SHADOW_PROBES_PER_POLL;
            const incomplete = [];
            const documentRoot = roots[0] === this.doc ? roots.shift() : null;
            if (documentRoot) {
                const documentBudget = roots.length
                    ? Math.floor(MAX_SHADOW_PROBES_PER_POLL * 0.75)
                    : MAX_SHADOW_PROBES_PER_POLL;
                const result = this.probeShadowRoot(documentRoot, documentBudget, deadline);
                remaining -= result.sampled;
                if (!result.complete)
                    incomplete.push(documentRoot);
            }
            const baseBudget = roots.length ? Math.max(1, Math.floor(Math.max(0, remaining) / roots.length)) : 0;
            for (const root of roots) {
                if (remaining <= 0 || this.now() >= deadline)
                    break;
                const result = this.probeShadowRoot(root, Math.min(64, baseBudget, remaining), deadline);
                remaining -= result.sampled;
                if (!result.complete)
                    incomplete.push(root);
            }
            let madeProgress = true;
            while (remaining > 0 && incomplete.length && this.now() < deadline && madeProgress) {
                madeProgress = false;
                const nextIncomplete = [];
                for (const root of incomplete) {
                    if (remaining <= 0 || this.now() >= deadline)
                        break;
                    const result = this.probeShadowRoot(root, Math.min(256, remaining), deadline);
                    remaining -= result.sampled;
                    if (result.sampled)
                        madeProgress = true;
                    if (!result.complete)
                        nextIncomplete.push(root);
                }
                incomplete.length = 0;
                incomplete.push(...nextIncomplete);
            }
        }

        takeShadowProbeRoots() {
            const roots = [];
            if (this.shadowProbeRoots.has(this.doc))
                roots.push(this.doc);
            const attempts = this.shadowProbeRoots.size;
            for (let index = 0; index < attempts && roots.length < MAX_SHADOW_ROOTS_PER_POLL; index++) {
                const next = this.shadowProbeRoots.values().next();
                if (next.done)
                    break;
                const root = next.value;
                this.shadowProbeRoots.delete(root);
                const connected = root === this.doc
                    || (root && root.host && root.host.isConnected && root.host.ownerDocument === this.doc);
                if (connected)
                    this.shadowProbeRoots.add(root);
                if (connected && root !== this.doc)
                    roots.push(root);
            }
            return roots;
        }

        probeShadowRoot(root, budget, deadline) {
            let walker = this.shadowProbeWalkers.get(root);
            if (!walker) {
                try { walker = this.doc.createTreeWalker(root, this.win.NodeFilter.SHOW_ELEMENT); }
                catch (err) { return { sampled: 0, complete: true }; }
                this.shadowProbeWalkers.set(root, walker);
            }
            let sampled = 0;
            while (sampled < budget && this.now() < deadline) {
                const element = walker.nextNode();
                if (!element) {
                    this.shadowProbeWalkers.delete(root);
                    return { sampled, complete: true };
                }
                sampled++;
                if (!this.canHostShadow(element))
                    continue;
                const shadow = this.getShadowRoot(element);
                if (!shadow || this.observedRoots.has(shadow))
                    continue;
                this.observeDiscoveredShadowRoot(shadow, element);
            }
            return { sampled, complete: false };
        }

        observeDiscoveredShadowRoot(shadow, host) {
            const styleLink = this.ensureShadowStyle(shadow, host);
            if (!this.observedRoots.has(shadow)) {
                this.markPendingMediaTree(shadow, false);
                this.observeRoot(shadow);
                this.queueTree(shadow, false);
            }
            this.trackShadowHostReadiness(host, shadow, styleLink);
        }

        trackShadowHostReadiness(host, shadow, styleLink) {
            if (!host || typeof host.getAttribute !== 'function'
                || host.getAttribute(SHADOW_HOST_PENDING_ATTRIBUTE) !== '1' || !styleLink)
                return;
            let state = this.pendingShadowHosts.get(host);
            if (!state) {
                state = {
                    createdAt: this.now(),
                    root: shadow,
                    scanComplete: false,
                    styleReady: false
                };
                this.pendingShadowHosts.set(host, state);
            }
            state.root = shadow;
            state.scanComplete = this.observedRoots.has(shadow) && !this.queuedRoots.has(shadow);
            let ready = false;
            try { ready = !!styleLink.sheet; } catch (err) { ready = false; }
            if (ready) {
                state.styleReady = true;
                this.maybeReleaseShadowHost(host);
                return;
            }
            if (this.shadowPendingReleaseLinks.has(styleLink))
                return;
            this.shadowPendingReleaseLinks.add(styleLink);
            this.listen(styleLink, 'load', () => {
                this.shadowPendingReleaseLinks.delete(styleLink);
                if (!this.active)
                    return;
                const current = this.pendingShadowHosts.get(host);
                if (current) {
                    current.styleReady = true;
                    this.maybeReleaseShadowHost(host);
                }
            }, { once: true });
        }

        markShadowRootScanComplete(root) {
            const host = root && root.host;
            if (!host || typeof host.getAttribute !== 'function'
                || host.getAttribute(SHADOW_HOST_PENDING_ATTRIBUTE) !== '1')
                return;
            const state = this.pendingShadowHosts.get(host);
            if (!state || (state.root && state.root !== root))
                return;
            state.root = root;
            state.scanComplete = true;
            this.maybeReleaseShadowHost(host);
        }

        maybeReleaseShadowHost(host) {
            const state = this.pendingShadowHosts.get(host);
            if (state && state.styleReady && state.scanComplete)
                this.clearShadowHostPending(host);
        }

        canHostShadow(element) {
            const localName = String(element && element.localName || '');
            return localName.includes('-') || BUILT_IN_SHADOW_HOSTS.has(String(element && element.tagName || '').toUpperCase());
        }

        pollPendingObjects() {
            const candidates = Array.from(this.pendingObjectElements).slice(0, MAX_MAINTENANCE_ELEMENTS);
            for (const element of candidates) {
                this.pendingObjectElements.delete(element);
                if (!element || !element.isConnected || element.ownerDocument !== this.doc)
                    continue;
                this.queueElement(element);
                this.pendingObjectElements.add(element);
            }
        }

        onMutations(mutations) {
            if (!this.active)
                return;
            if (!this.eye && this.doc.body)
                this.createEye();
            let sawRemoval = false;
            const shadowStyleRoots = new Set();
            for (const mutation of mutations) {
                if (mutation.type === 'characterData') {
                    this.bumpSvgMutation(mutation.target);
                    const parent = mutation.target && mutation.target.parentElement;
                    if (parent && String(parent.tagName || '').toUpperCase() === 'STYLE')
                        this.queueStyleScope(parent);
                    else if (parent)
                        this.queueDynamicTarget(parent);
                    continue;
                }
                if (mutation.type === 'attributes') {
                    const element = mutation.target;
                    if (this.consumeOwnWrite(element, mutation.attributeName))
                        continue;
                    if (String(mutation.attributeName || '').toLowerCase() === 'style')
                        this.markInlineStyleMediaPending(element);
                    if (this.shadowStyleLinks.has(element)) {
                        const shadow = this.shadowStyleRootByLink.get(element);
                        if (this.isShadowRootLike(shadow))
                            shadowStyleRoots.add(shadow);
                        continue;
                    }
                    if (VISUAL_ATTRIBUTE_SET.has(String(mutation.attributeName || '').toLowerCase())) {
                        // A page may reconcile attributes on an element after Wizmage
                        // renders it. Repair that element only; treating our private
                        // attributes as selector input can otherwise rescan a large SPA.
                        if (this.hasBlockedRecord(element))
                            this.queueElement(element);
                        continue;
                    }
                    this.bumpSvgMutation(element);
                    if (this.isDirectMediaAttribute(element, mutation.attributeName)) {
                        const mediaTag = String(element.tagName || '').toUpperCase();
                        if (mediaTag === 'SOURCE') {
                            this.queueSourceOwner(element);
                            if (this.shouldQueueAttributeSubtree(mutation.attributeName))
                                this.queueAffectedTree(element.parentElement || element);
                        }
                        else {
                            if (this.shouldGateMediaMutation(element, mutation.attributeName))
                                this.markMediaPending(element);
                            this.queueElement(element);
                            if (mediaTag === 'OBJECT')
                                this.queueAffectedTree(element);
                        }
                    }
                    else if (/^(?:STYLE|LINK)$/.test(String(element.tagName || '').toUpperCase()))
                        this.queueStyleScope(element);
                    else if (element.tagName === 'SOURCE') {
                        this.queueSourceOwner(element);
                        if (this.shouldQueueAttributeSubtree(mutation.attributeName))
                            this.queueAffectedTree(element.parentElement || element);
                    }
                    else if (this.shouldQueueAttributeSubtree(mutation.attributeName)) {
                        // Selector-bearing attributes can affect descendants.
                        // Accessible stylesheet selectors are learned by the
                        // rolling CSSOM sampler; common state attributes remain a
                        // conservative fallback for inaccessible stylesheets.
                        this.queueAffectedTree(element);
                    }
                    else {
                        this.queueElement(element);
                        this.queueUnknownAttributeFallback(element);
                    }
                    continue;
                }
                if (mutation.removedNodes && mutation.removedNodes.length) {
                    for (const node of mutation.removedNodes) {
                        if (this.shadowStyleLinks.has(node)) {
                            const shadow = this.isShadowRootLike(mutation.target)
                                ? mutation.target : this.shadowStyleRootByLink.get(node);
                            if (this.isShadowRootLike(shadow))
                                shadowStyleRoots.add(shadow);
                            else if (!node.isConnected) {
                                this.shadowStyleLinks.delete(node);
                                this.shadowStyleRootByLink.delete(node);
                            }
                        }
                        else {
                            sawRemoval = true;
                        }
                    }
                }
                if (mutation.target && mutation.target.nodeType === 1)
                    this.queueDynamicTarget(mutation.target);
                this.bumpSvgMutation(mutation.target);
                for (const node of mutation.addedNodes || []) {
                    if (node.nodeType !== 1)
                        continue;
                    this.noteTextareaLayoutHazard(node);
                    if (this.shadowStyleLinks.has(node)) {
                        if (this.isShadowRootLike(mutation.target)) {
                            this.shadowStyleRootByLink.set(node, mutation.target);
                            shadowStyleRoots.add(mutation.target);
                        }
                        else
                            this.shadowStyleRootByLink.delete(node);
                        continue;
                    }
                    // Prioritize each newly inserted root (especially an IMG or
                    // background host) instead of letting it wait behind the
                    // bounded subtree-job queue. Descendants still scan in the
                    // yielding tree lane.
                    this.markPendingMediaTree(node, true);
                    this.markPendingShadowHostTree(node, true);
                    this.queueElement(node);
                    this.queueTree(node, false);
                    if (/^(?:STYLE|LINK)$/.test(String(node.tagName || '').toUpperCase())) {
                        this.queueStyleScope(node);
                    }
                }
                if (mutation.target && /^(?:STYLE|LINK)$/.test(String(mutation.target.tagName || '').toUpperCase())) {
                    this.queueStyleScope(mutation.target);
                }
            }
            for (const shadow of shadowStyleRoots)
                this.ensureShadowStyle(shadow);
            if (sawRemoval)
                this.schedulePrune();
        }

        bumpSvgMutation(node) {
            let element = node && node.nodeType === 1 ? node : node && node.parentElement;
            while (element) {
                if (String(element.tagName || '').toUpperCase() === 'SVG') {
                    this.svgMutationVersions.set(element, (this.svgMutationVersions.get(element) || 0) + 1);
                    this.queueElement(element);
                }
                element = element.parentElement;
            }
        }

        queueStyleScope(styleElement) {
            const root = styleElement && styleElement.getRootNode ? styleElement.getRootNode() : this.doc;
            if (root && root.host)
                this.queueTree(root, false);
            else {
                this.queueTree(this.doc.documentElement, true);
                this.lastFullScanAt = Date.now();
            }
        }

        queueAffectedTree(element) {
            if (!this.active || !element || element.nodeType !== 1)
                return;
            this.queueElement(element);
            const now = Date.now();
            const lastQueued = this.affectedTreeLastQueued.get(element) || 0;
            const remaining = ATTRIBUTE_SUBTREE_MIN_INTERVAL_MS - (now - lastQueued);
            if (remaining > 0) {
                this.deferredAffectedTreeRoots.add(element);
                this.scheduleDeferredAffectedTrees(remaining);
                return;
            }
            this.affectedTreeLastQueued.set(element, now);
            this.enqueueAffectedTree(element);
        }

        shouldQueueAttributeSubtree(attributeName) {
            const name = String(attributeName || '').toLowerCase();
            return COMMON_SELECTOR_ATTRIBUTES.has(name) || this.selectorAttributeNames.has(name);
        }

        isDirectMediaAttribute(element, attributeName) {
            const tag = String(element && element.tagName || '').toUpperCase();
            const name = String(attributeName || '').toLowerCase();
            if (tag === 'IMG')
                return /^(?:src|srcset|sizes|width|height)$/.test(name);
            if (tag === 'SOURCE')
                return /^(?:src|srcset|sizes|media|type)$/.test(name);
            if (tag === 'INPUT')
                return /^(?:src|type|width|height)$/.test(name);
            if (tag === 'OBJECT')
                return /^(?:data|type|width|height)$/.test(name);
            if (tag === 'EMBED')
                return /^(?:src|type|width|height)$/.test(name);
            if (tag === 'IMAGE')
                return /^(?:href|xlink:href|width|height)$/.test(name);
            if (tag === 'CANVAS')
                return /^(?:width|height)$/.test(name);
            return false;
        }

        queueUnknownAttributeFallback(element) {
            const now = Date.now();
            const lastFallback = this.unknownAttributeLastQueued.get(element) || 0;
            const remaining = UNKNOWN_ATTRIBUTE_SUBTREE_INTERVAL_MS - (now - lastFallback);
            if (remaining <= 0) {
                // CSSOM selectors from cross-origin stylesheets are unreadable.
                // Give an unknown attribute one immediate conservative subtree
                // pass, then rate-limit subsequent passes.
                this.unknownAttributeLastQueued.set(element, now);
                this.queueAffectedTree(element);
                return;
            }
            // Preserve the last state of a burst: without a trailing pass, a
            // final selector value set during the cooldown could leak forever.
            this.deferredUnknownAttributeRoots.add(element);
            this.scheduleUnknownAttributeFallback(remaining);
        }

        scheduleUnknownAttributeFallback(delay) {
            if (this.unknownAttributeFallbackTimeout)
                return;
            this.unknownAttributeFallbackTimeout = this.setTrackedTimeout(() => {
                this.unknownAttributeFallbackTimeout = null;
                const now = Date.now();
                let nextDelay = UNKNOWN_ATTRIBUTE_SUBTREE_INTERVAL_MS;
                for (const root of Array.from(this.deferredUnknownAttributeRoots)) {
                    if (!root.isConnected || root.ownerDocument !== this.doc) {
                        this.deferredUnknownAttributeRoots.delete(root);
                        continue;
                    }
                    const lastFallback = this.unknownAttributeLastQueued.get(root) || 0;
                    const remaining = UNKNOWN_ATTRIBUTE_SUBTREE_INTERVAL_MS - (now - lastFallback);
                    if (remaining > 0) {
                        nextDelay = Math.min(nextDelay, remaining);
                        continue;
                    }
                    this.deferredUnknownAttributeRoots.delete(root);
                    this.unknownAttributeLastQueued.set(root, now);
                    this.queueAffectedTree(root);
                }
                if (this.deferredUnknownAttributeRoots.size)
                    this.scheduleUnknownAttributeFallback(Math.max(1, nextDelay));
            }, Math.max(1, delay));
        }

        scheduleDeferredAffectedTrees(delay) {
            if (this.affectedTreeThrottleTimeout)
                return;
            this.affectedTreeThrottleTimeout = this.setTrackedTimeout(() => {
                this.affectedTreeThrottleTimeout = null;
                const now = Date.now();
                let nextDelay = ATTRIBUTE_SUBTREE_MIN_INTERVAL_MS;
                for (const root of Array.from(this.deferredAffectedTreeRoots)) {
                    if (!root.isConnected || root.ownerDocument !== this.doc) {
                        this.deferredAffectedTreeRoots.delete(root);
                        continue;
                    }
                    const lastQueued = this.affectedTreeLastQueued.get(root) || 0;
                    const remaining = ATTRIBUTE_SUBTREE_MIN_INTERVAL_MS - (now - lastQueued);
                    if (remaining > 0) {
                        nextDelay = Math.min(nextDelay, remaining);
                        continue;
                    }
                    this.deferredAffectedTreeRoots.delete(root);
                    this.affectedTreeLastQueued.set(root, now);
                    this.enqueueAffectedTree(root);
                }
                if (this.deferredAffectedTreeRoots.size)
                    this.scheduleDeferredAffectedTrees(Math.max(1, nextDelay));
            }, Math.max(1, delay));
        }

        enqueueAffectedTree(element) {
            for (const root of this.dynamicSubtreeRoots) {
                if (root === element || (root.contains && root.contains(element)))
                    return;
                if (element.contains && element.contains(root))
                    this.dynamicSubtreeRoots.delete(root);
            }
            this.dynamicSubtreeRoots.add(element);
            if (!this.dynamicSubtreeTimeout) {
                this.dynamicSubtreeTimeout = this.setTrackedTimeout(() => {
                    const roots = Array.from(this.dynamicSubtreeRoots);
                    this.dynamicSubtreeRoots.clear();
                    this.dynamicSubtreeTimeout = null;
                    for (const root of roots) {
                        if (root.isConnected && root.ownerDocument === this.doc) {
                            this.queueTree(root, true);
                            this.queueObservedShadowRootsWithin(root);
                        }
                    }
                }, 120);
            }
        }

        queueObservedShadowRootsWithin(element) {
            if (!element || !element.contains)
                return;
            for (const root of new Set(this.observerRoots.values())) {
                if (root && root.host && element.contains(root.host))
                    this.queueTree(root, false);
            }
        }

        queueAllObservedRoots() {
            this.queueTree(this.doc.documentElement, true);
            for (const root of new Set(this.observerRoots.values())) {
                if (root && root.host && root.host.isConnected && root.host.ownerDocument === this.doc)
                    this.queueTree(root, false);
            }
        }

        queueSourceOwner(source) {
            const picture = source && source.parentElement;
            if (picture && picture.tagName === 'PICTURE') {
                const image = picture.querySelector('img');
                if (image) {
                    if (this.inspectedMediaUrls.get(image) !== this.currentDirectMediaUrl(image))
                        this.markMediaPending(image);
                    this.queueElement(image);
                }
                return;
            }
            const video = picture && picture.tagName === 'VIDEO' ? picture : null;
            if (video)
                this.queueElement(video);
        }

        schedulePrune() {
            if (this.pruneTimeout)
                return;
            this.pruneTimeout = this.setTrackedTimeout(() => {
                this.pruneTimeout = null;
                this.pruneDisconnectedRecords();
            }, 50);
        }

        pruneDisconnectedRecords() {
            for (const record of Array.from(this.records)) {
                if (!record.element || !record.element.isConnected || record.element.ownerDocument !== this.doc) {
                    this.cancelRecordAnalyses(record);
                    record.generation++;
                    this.removeVisualAttributes(record);
                    this.records.delete(record);
                    const map = record.element && this.recordsByElement.get(record.element);
                    if (map && map.get(record.kind) === record) {
                        map.delete(record.kind);
                        if (!map.size)
                            this.recordsByElement.delete(record.element);
                    }
                    if (record.element)
                        this.ownWrites.delete(record.element);
                    if (this.eyeRecord === record)
                        this.hideEye();
                }
            }
            for (const element of Array.from(this.pendingMediaElements.keys())) {
                if (!element || !element.isConnected || element.ownerDocument !== this.doc) {
                    try { element.removeAttribute(MEDIA_PENDING_ATTRIBUTE); } catch (err) { /* ignore */ }
                    this.pendingMediaElements.delete(element);
                }
            }
            for (const element of Array.from(this.pendingShadowHosts.keys())) {
                if (!element || !element.isConnected || element.ownerDocument !== this.doc) {
                    try { element.removeAttribute(SHADOW_HOST_PENDING_ATTRIBUTE); } catch (err) { /* ignore */ }
                    this.pendingShadowHosts.delete(element);
                }
            }
            for (const [observer, root] of Array.from(this.observerRoots.entries())) {
                if (root === this.doc || !root || !root.host)
                    continue;
                if (root.host.isConnected && root.host.ownerDocument === this.doc) {
                    this.ensureShadowStyle(root);
                    continue;
                }
                observer.disconnect();
                this.observers.delete(observer);
                this.observerRoots.delete(observer);
                this.observedRoots.delete(root);
                this.stylesheetRoots.delete(root);
                this.shadowProbeRoots.delete(root);
                const shadowStyleKey = this.getShadowStyleStateKey(root);
                const tracked = this.shadowStyleByRoot.get(shadowStyleKey);
                if (tracked) {
                    try { tracked.remove(); } catch (err) { /* ignore */ }
                    this.shadowStyleLinks.delete(tracked);
                    this.shadowStyleRootByLink.delete(tracked);
                    this.shadowStyleByRoot.delete(shadowStyleKey);
                }
                this.cancelShadowStyleRetry(shadowStyleKey);
                const rootLinks = this.getShadowStyleLinks(root);
                for (const link of Array.from(this.shadowStyleLinks)) {
                    let sameRoot = !!(rootLinks && rootLinks.includes(link));
                    if (!sameRoot) {
                        try { sameRoot = !!(link.getRootNode && link.getRootNode() === root); } catch (err) { /* ignore */ }
                    }
                    if (sameRoot) {
                        try { link.remove(); } catch (err) { /* ignore */ }
                        this.shadowStyleLinks.delete(link);
                        this.shadowStyleRootByLink.delete(link);
                    }
                }
            }
            for (const link of Array.from(this.shadowStyleLinks)) {
                if (!link.isConnected) {
                    try { link.remove(); } catch (err) { /* ignore */ }
                    this.shadowStyleLinks.delete(link);
                    this.shadowStyleRootByLink.delete(link);
                }
            }
            for (const element of Array.from(this.pendingElements)) {
                if (!element.isConnected || element.ownerDocument !== this.doc)
                    this.pendingElements.delete(element);
            }
            for (const root of Array.from(this.dynamicSubtreeRoots)) {
                if (!root.isConnected || root.ownerDocument !== this.doc)
                    this.dynamicSubtreeRoots.delete(root);
            }
            for (const element of Array.from(this.lateShadowHosts)) {
                if (!element.isConnected || element.ownerDocument !== this.doc)
                    this.lateShadowHosts.delete(element);
            }
            for (const element of Array.from(this.pendingObjectElements)) {
                if (!element.isConnected || element.ownerDocument !== this.doc)
                    this.pendingObjectElements.delete(element);
            }
            for (const element of Array.from(this.deferredAffectedTreeRoots)) {
                if (!element.isConnected || element.ownerDocument !== this.doc)
                    this.deferredAffectedTreeRoots.delete(element);
            }
            for (const element of Array.from(this.deferredUnknownAttributeRoots)) {
                if (!element.isConnected || element.ownerDocument !== this.doc)
                    this.deferredUnknownAttributeRoots.delete(element);
            }
            for (const scope of Array.from(this.deferredScanScopes)) {
                if (scope !== this.doc && (!scope.host || !scope.host.isConnected || scope.host.ownerDocument !== this.doc))
                    this.deferredScanScopes.delete(scope);
            }
            for (let index = this.scanJobs.length - 1; index >= 0; index--) {
                const job = this.scanJobs[index];
                const root = job.root;
                const connected = root === this.doc
                    || root === this.doc.documentElement
                    || (root && root.host
                        ? root.host.isConnected && root.host.ownerDocument === this.doc
                        : root && root.isConnected && root.ownerDocument === this.doc);
                if (connected)
                    continue;
                this.scanJobs.splice(index, 1);
                this.queuedRoots.delete(root);
            }
        }

        queueElement(element) {
            if (!this.active || !element || element.nodeType !== 1)
                return;
            this.pendingElements.add(element);
            this.scheduleScan();
        }

        queueTree(root, includeRoot) {
            if (!this.active || !root)
                return;
            if (this.queuedRoots.has(root)) {
                this.deferredScanScopes.add(this.scanScopeFor(root));
                if (includeRoot && root.nodeType === 1)
                    this.queueElement(root);
                else
                    this.scheduleScan();
                return;
            }
            for (let index = this.scanJobs.length - 1; index >= 0; index--) {
                const existing = this.scanJobs[index];
                // A newly added or restyled subtree still needs its own pass even
                // while an ancestor walker is active: that walker may already have
                // passed the insertion point. Keep the narrower job instead of
                // turning every live-page mutation into a full-document rescan.
                if (root !== existing.root && root.contains && root.contains(existing.root)) {
                    this.scanJobs.splice(index, 1);
                    this.queuedRoots.delete(existing.root);
                }
            }
            if (this.scanJobs.length >= MAX_ACTIVE_SCAN_JOBS) {
                this.deferredScanScopes.add(this.scanScopeFor(root));
                if (root.nodeType === 1)
                    this.queueElement(root);
                else
                    this.scheduleScan();
                return;
            }
            this.addScanJob(root, includeRoot);
            this.scheduleScan();
        }

        addScanJob(root, includeRoot) {
            const documentForRoot = root.ownerDocument || this.doc;
            let walker;
            try {
                walker = documentForRoot.createTreeWalker(root, this.win.NodeFilter.SHOW_ELEMENT);
            } catch (err) {
                return false;
            }
            this.queuedRoots.add(root);
            this.scanJobs.push({ root, walker, includeRoot: !!includeRoot, included: false });
            return true;
        }

        scanScopeFor(root) {
            if (root === this.doc || root === this.doc.documentElement)
                return this.doc;
            const scope = root && root.getRootNode ? root.getRootNode() : null;
            return scope && scope.host ? scope : this.doc;
        }

        promoteDeferredScan() {
            if (this.scanJobs.length >= MAX_ACTIVE_SCAN_JOBS || !this.deferredScanScopes.size)
                return false;
            for (const scope of Array.from(this.deferredScanScopes)) {
                const root = scope === this.doc ? this.doc.documentElement : scope;
                const connected = root === this.doc.documentElement
                    || (root && root.host && root.host.isConnected && root.host.ownerDocument === this.doc);
                if (!connected) {
                    this.deferredScanScopes.delete(scope);
                    continue;
                }
                if (this.queuedRoots.has(root))
                    continue;
                this.deferredScanScopes.delete(scope);
                return this.addScanJob(root, root.nodeType === 1);
            }
            return false;
        }

        scheduleScan() {
            if (!this.active || this.scanScheduled)
                return;
            this.scanScheduled = true;
            const run = deadline => {
                this.scanScheduled = false;
                this.idleHandle = null;
                this.idleHandleKind = null;
                this.flushScan(deadline);
            };
            if (this.win.requestIdleCallback) {
                this.idleHandleKind = 'idle';
                this.idleHandle = this.win.requestIdleCallback(run, { timeout: 120 });
            }
            else {
                this.idleHandleKind = 'timeout';
                this.idleHandle = this.win.setTimeout(() => run(null), 0);
            }
        }

        flushScan(deadline) {
            if (!this.active)
                return;
            const started = this.now();
            let processed = 0;
            while (processed < 80 && this.now() - started < 8 && this.hasScanWork()) {
                const element = this.takeNextScanElement();
                if (!element)
                    continue;
                processed++;
                if (!element.isConnected && element !== this.doc.documentElement) {
                    this.clearMediaPending(element);
                    continue;
                }
                try {
                    this.inspectElement(element);
                } catch (err) {
                    this.lastScanError = err;
                    if (this.environment.onError)
                        this.environment.onError(err, element);
                } finally {
                    this.clearMediaPending(element);
                }
                if (deadline && typeof deadline.timeRemaining === 'function' && !deadline.didTimeout && deadline.timeRemaining() < 1)
                    break;
            }
            if (this.hasScanWork())
                this.scheduleScan();
            else
                this.finishInitialMediaGate();
        }

        now() {
            return this.win.performance && this.win.performance.now ? this.win.performance.now() : Date.now();
        }

        hasScanWork() {
            return this.pendingElements.size > 0 || this.scanJobs.length > 0 || this.deferredScanScopes.size > 0;
        }

        hasPendingScanWork() {
            return this.hasScanWork()
                || this.deferredAffectedTreeRoots.size > 0
                || this.deferredUnknownAttributeRoots.size > 0
                || this.dynamicSubtreeRoots.size > 0
                || this.scanScheduled
                || this.idleHandle != null
                || this.affectedTreeThrottleTimeout != null
                || this.unknownAttributeFallbackTimeout != null
                || this.dynamicSubtreeTimeout != null
                || this.resourceScanTimeout != null
                || this.resizeScanTimeout != null
                || this.hoverScanTimeout != null;
        }

        takeNextScanElement() {
            let element;
            if (this.preferPendingElement) {
                element = this.takePendingElement() || this.takeTreeElement();
            }
            else {
                element = this.takeTreeElement() || this.takePendingElement();
            }
            this.preferPendingElement = !this.preferPendingElement;
            return element;
        }

        takePendingElement() {
            const iterator = this.pendingElements.values();
            const next = iterator.next();
            if (next.done)
                return null;
            this.pendingElements.delete(next.value);
            return next.value;
        }

        takeTreeElement() {
            this.promoteDeferredScan();
            while (this.scanJobs.length) {
                const job = this.scanJobs.shift();
                if (job.includeRoot && !job.included) {
                    job.included = true;
                    if (job.root.nodeType === 1) {
                        this.scanJobs.push(job);
                        return job.root;
                    }
                }
                const element = job.walker.nextNode();
                if (element) {
                    this.scanJobs.push(job);
                    return element;
                }
                this.queuedRoots.delete(job.root);
                this.markShadowRootScanComplete(job.root);
                this.promoteDeferredScan();
            }
            return null;
        }

        inspectElement(element) {
            this.discoverShadowRoot(element);
            // HTML tagName values are usually uppercase, while SVG tagName values are
            // lowercase in Chromium. Normalize once so SVG roots and <image> nodes take
            // the same inspection path as HTML media elements.
            const tag = String(element.tagName || '').toUpperCase();
            if (tag === 'IMG')
                this.inspectImage(element);
            else if (tag === 'INPUT' && String(element.type || '').toLowerCase() === 'image')
                this.inspectUrlElement(element, 'input-image', element.currentSrc || element.src || element.getAttribute('src'));
            else if (tag === 'INPUT')
                this.clearRecordKind(element, 'input-image');
            else if (tag === 'CANVAS')
                this.inspectCanvas(element);
            else if (tag === 'IMAGE')
                this.inspectSvgImage(element);
            else if (tag === 'SVG')
                this.inspectSvgRoot(element);
            else if (tag === 'OBJECT')
                this.inspectObject(element, 'object', element.data || element.getAttribute('data'));
            else if (tag === 'EMBED')
                this.inspectObject(element, 'embed', element.src || element.getAttribute('src'));
            else if (tag === 'PICTURE') {
                const image = element.querySelector('img');
                if (image)
                    this.queueElement(image);
            }
            else if (tag === 'VIDEO')
                this.inspectVideoPoster(element);

            if (!SKIP_BACKGROUND_TAGS.test(tag) && !this.hasSeenTextareaLayoutHazard)
                this.inspectBackground(element);
        }

        noteTextareaLayoutHazard(root) {
            if (!this.usesSafariTextControlLayoutGuard || this.hasSeenTextareaLayoutHazard || !root)
                return;
            if (String(root.tagName || '').toUpperCase() === 'TEXTAREA') {
                this.hasSeenTextareaLayoutHazard = true;
                return;
            }
            try {
                if (root.querySelector && root.querySelector('textarea'))
                    this.hasSeenTextareaLayoutHazard = true;
            } catch (err) { /* inaccessible roots are handled by later mutations */ }
        }

        discoverShadowRoot(element) {
            const containingRoot = element.getRootNode ? element.getRootNode() : null;
            if (containingRoot && containingRoot.host)
                this.ensureShadowStyle(containingRoot, containingRoot.host);
            const shadow = this.getShadowRoot(element);
            if (shadow) {
                this.lateShadowHosts.delete(element);
                this.observeDiscoveredShadowRoot(shadow, element);
                return;
            }
            if (this.canHostShadow(element)) {
                this.markShadowHostPending(element);
                if (!this.lateShadowHosts.has(element) && this.lateShadowHosts.size >= MAX_LATE_SHADOW_HOSTS) {
                    // Keep the tracker bounded. The oldest host has already had
                    // at least one discovery attempt and will be rediscovered by
                    // any subsequent DOM/style/lifecycle scan.
                    const oldest = this.lateShadowHosts.values().next().value;
                    this.lateShadowHosts.delete(oldest);
                }
                this.lateShadowHosts.add(element);
            }
            if (element.localName && element.localName.includes('-')) {
                if (this.customElementChecks.has(element))
                    return;
                this.customElementChecks.add(element);
                const customElements = this.win.customElements;
                if (customElements && customElements.whenDefined && !this.customElementDefinitionChecks.has(element.localName)) {
                    const localName = element.localName;
                    this.customElementDefinitionChecks.add(localName);
                    const controllerReference = typeof this.win.WeakRef === 'function' ? new this.win.WeakRef(this) : null;
                    if (controllerReference) {
                        customElements.whenDefined(localName).then(() => {
                            const controller = controllerReference.deref();
                            if (!controller || !controller.active || !controller.doc.querySelectorAll)
                                return;
                            for (const candidate of controller.doc.querySelectorAll(localName))
                                controller.queueElement(candidate);
                        }).catch(() => { });
                    }
                }
            }
        }

        getShadowRoot(element) {
            try {
                if (this.environment.getShadowRoot) {
                    const resolved = this.environment.getShadowRoot(element);
                    if (resolved)
                        return resolved;
                }
                return element.openOrClosedShadowRoot || element.shadowRoot || null;
            } catch (err) {
                try { return element.shadowRoot || null; } catch (fallbackError) { return null; }
            }
        }

        isUsableShadowStyleLink(node, cssUrl) {
            try {
                return !!(node && node.nodeType === 1 &&
                    String(node.tagName || '').toUpperCase() === 'LINK' &&
                    node.getAttribute('data-wzm-shadow-style') === '1' &&
                    node.href === cssUrl &&
                    String(node.rel || '').toLowerCase() === 'stylesheet' &&
                    !node.disabled &&
                    (!String(node.type || '').trim() || String(node.type || '').trim().toLowerCase() === 'text/css') &&
                    !String(node.integrity || '').trim() &&
                    !String(node.crossOrigin || '').trim() &&
                    (!String(node.media || '').trim() || String(node.media || '').trim().toLowerCase() === 'all'));
            } catch (err) {
                return false;
            }
        }

        isShadowRootLike(root) {
            return !!(root && root.nodeType === 11 && root.querySelectorAll && root.prepend);
        }

        isShadowStyleMember(shadow, link) {
            if (!shadow || !link)
                return false;
            try {
                if (shadow.contains && shadow.contains(link))
                    return true;
            } catch (err) { /* Fall back to wrapper-safe selector membership. */ }
            const links = this.getShadowStyleLinks(shadow);
            return !!(links && links.includes(link));
        }

        getShadowStyleLinks(shadow) {
            try {
                return Array.from(shadow.querySelectorAll('link[data-wzm-shadow-style="1"]'));
            } catch (err) {
                return null;
            }
        }

        getShadowStyleStateKey(shadow, explicitKey) {
            if (explicitKey && (typeof explicitKey === 'object' || typeof explicitKey === 'function')) {
                this.shadowStyleKeyByRoot.set(shadow, explicitKey);
                return explicitKey;
            }
            const knownKey = this.shadowStyleKeyByRoot.get(shadow);
            if (knownKey)
                return knownKey;
            try {
                const host = shadow.host;
                if (host) {
                    this.shadowStyleKeyByRoot.set(shadow, host);
                    return host;
                }
                return shadow;
            } catch (err) {
                return shadow;
            }
        }

        cancelShadowStyleRetry(key) {
            const state = this.shadowStyleRepairByRoot.get(key);
            if (!state || state.retryTimeout == null)
                return;
            this.win.clearTimeout(state.retryTimeout);
            this.timeouts.delete(state.retryTimeout);
            state.retryTimeout = null;
            state.retryShadow = null;
        }

        scheduleShadowStyleRetry(shadow, key, state) {
            if (!this.active || state.retryTimeout != null)
                return;
            state.retryShadow = shadow;
            const delay = Math.max(1, state.blockedUntil - Date.now() + 1);
            state.retryTimeout = this.setTrackedTimeout(() => {
                state.retryTimeout = null;
                let retryShadow = state.retryShadow;
                state.retryShadow = null;
                if (key && key.nodeType === 1) {
                    if (!key.isConnected || key.ownerDocument !== this.doc)
                        return;
                    retryShadow = this.getShadowRoot(key) || retryShadow;
                }
                if (retryShadow)
                    this.ensureShadowStyle(retryShadow, key);
            }, delay);
        }

        reserveShadowStyleInsertion(shadow, key) {
            const now = Date.now();
            key = key || this.getShadowStyleStateKey(shadow);
            let state = this.shadowStyleRepairByRoot.get(key);
            if (!state) {
                state = {
                    windowStartedAt: now,
                    insertions: 0,
                    blockedUntil: 0,
                    retryTimeout: null,
                    retryShadow: null
                };
                this.shadowStyleRepairByRoot.set(key, state);
            }
            if (state.blockedUntil > now) {
                this.scheduleShadowStyleRetry(shadow, key, state);
                return false;
            }
            if ((state.blockedUntil && state.blockedUntil <= now) ||
                now - state.windowStartedAt >= SHADOW_STYLE_INSERTION_WINDOW_MS) {
                state.windowStartedAt = now;
                state.insertions = 0;
                state.blockedUntil = 0;
            }
            if (state.insertions >= MAX_SHADOW_STYLE_INSERTIONS_PER_WINDOW) {
                state.blockedUntil = now + this.shadowStyleRetryCooldownMs;
                this.scheduleShadowStyleRetry(shadow, key, state);
                return false;
            }
            state.insertions++;
            return true;
        }

        ensureShadowStyle(shadow, explicitKey) {
            if (!shadow || !shadow.querySelectorAll || !shadow.prepend)
                return null;
            const key = this.getShadowStyleStateKey(shadow, explicitKey);
            const tracked = this.shadowStyleByRoot.get(key);
            const cssUrl = this.resolveMediaUrl(this.getURL('css.css'));
            const trackedInShadow = !!(tracked && this.isShadowStyleMember(shadow, tracked));
            if (trackedInShadow && this.isUsableShadowStyleLink(tracked, cssUrl)) {
                this.shadowStyleRootByLink.set(tracked, shadow);
                this.cancelShadowStyleRetry(key);
                return tracked;
            }
            const links = this.getShadowStyleLinks(shadow);
            if (!links)
                return null;
            if (tracked) {
                this.shadowStyleByRoot.delete(key);
                if (!tracked.isConnected) {
                    this.shadowStyleLinks.delete(tracked);
                    this.shadowStyleRootByLink.delete(tracked);
                }
            }
            try {
                const usableLinks = links.filter(candidate =>
                    this.shadowStyleLinks.has(candidate) && this.isUsableShadowStyleLink(candidate, cssUrl));
                let link = usableLinks[0] || null;
                if (link) {
                    for (const candidate of usableLinks) {
                        this.shadowStyleLinks.add(candidate);
                        this.shadowStyleRootByLink.set(candidate, shadow);
                    }
                }
                if (!link) {
                    if (!this.reserveShadowStyleInsertion(shadow, key))
                        return null;
                    const invalidOwnedLinks = links.filter(candidate => this.shadowStyleLinks.has(candidate));
                    if (trackedInShadow && tracked && this.shadowStyleLinks.has(tracked) &&
                        !invalidOwnedLinks.includes(tracked))
                        invalidOwnedLinks.push(tracked);
                    for (const invalid of invalidOwnedLinks) {
                        try { invalid.remove(); } catch (err) { /* ignore */ }
                        this.shadowStyleLinks.delete(invalid);
                        this.shadowStyleRootByLink.delete(invalid);
                    }
                    link = this.doc.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = cssUrl;
                    link.setAttribute('data-wzm-shadow-style', '1');
                    this.shadowStyleLinks.add(link);
                    this.shadowStyleRootByLink.set(link, shadow);
                    try {
                        shadow.prepend(link);
                    } catch (err) {
                        this.shadowStyleLinks.delete(link);
                        this.shadowStyleRootByLink.delete(link);
                        throw err;
                    }
                }
                this.shadowStyleLinks.add(link);
                this.shadowStyleRootByLink.set(link, shadow);
                this.shadowStyleByRoot.set(key, link);
                this.cancelShadowStyleRetry(key);
                return link;
            } catch (err) {
                return null;
            }
        }

        inspectImage(element) {
            const url = this.resolveMediaUrl(element.currentSrc || element.src || element.getAttribute('src'));
            this.inspectUrlElement(element, 'img', url);
        }

        renderedSize(element) {
            // Safari can crash inside RenderTextControl when any JavaScript
            // geometry read forces layout after a page has created a textarea.
            // An unknown size is deliberately conservative: sizeNeedsBlocking
            // treats it as a candidate, so direct media remains filtered without
            // asking WebKit to lay out the document.
            if (this.usesSafariTextControlLayoutGuard && this.hasSeenTextareaLayoutHazard)
                return { width: 0, height: 0 };
            return Shared.renderedSize(element);
        }

        inspectVideoPoster(element) {
            const poster = this.resolveMediaUrl(element.poster || element.getAttribute('poster'));
            if (poster) {
                this.inspectUrlElement(element, 'video-poster', poster);
                return;
            }
            this.clearRecordKind(element, 'video-poster');
        }

        inspectUrlElement(element, kind, rawUrl, extraKey) {
            const url = this.resolveMediaUrl(rawUrl);
            this.inspectedMediaUrls.set(element, url);
            const record = this.getRecord(element, kind, false);
            if (!url || this.isExtensionAsset(url) || url === BLANK_IMAGE) {
                if (record)
                    this.showRecord(record, false, false);
                return;
            }
            const size = this.renderedSize(element);
            const force = this.settings.alwaysBlock || this.isLikelyProfileImage(element, url);
            if (!Shared.sizeNeedsBlocking(size.width, size.height, this.settings.maxSafe, force)) {
                if (record)
                    this.showRecord(record, false, false);
                return;
            }
            const key = Shared.candidateKey(kind, [url], extraKey || '');
            this.evaluateCandidate(this.getRecord(element, kind, true), [url], key);
        }

        inspectCanvas(element) {
            const record = this.getRecord(element, 'canvas', false);
            const size = this.renderedSize(element);
            if (!Shared.sizeNeedsBlocking(size.width, size.height, this.settings.maxSafe, this.settings.alwaysBlock)) {
                if (record)
                    this.showRecord(record, false, false);
                return;
            }
            const key = Shared.candidateKey('canvas', [], element.width + 'x' + element.height);
            const target = this.getRecord(element, 'canvas', true);
            target.key = key;
            target.generation++;
            target.userAllowedKey = target.userAllowedKey === key ? key : null;
            if (target.userAllowedKey === key) {
                this.showRecord(target, false, false);
                return;
            }
            this.applyVisual(target, this.settings.blockTarget === 'all' ? 'bad' : 'unchecked');
        }

        inspectSvgImage(element) {
            let value = '';
            try { value = element.href && element.href.baseVal ? element.href.baseVal : ''; } catch (err) { /* ignore */ }
            value = value || element.getAttribute('href') || element.getAttribute('xlink:href');
            this.inspectUrlElement(element, 'svg-image', value);
        }

        inspectSvgRoot(element) {
            const record = this.getRecord(element, 'svg', false);
            const size = this.renderedSize(element);
            if (!Shared.sizeNeedsBlocking(size.width, size.height, this.settings.maxSafe, this.settings.alwaysBlock)) {
                if (record)
                    this.showRecord(record, false, false);
                return;
            }
            const key = Shared.candidateKey(
                'svg',
                [],
                this.hashString(this.visualMarkupSignature(element)) + ':'
                    + (this.svgMutationVersions.get(element) || 0) + ':'
                    + size.width + 'x' + size.height
            );
            const target = this.getRecord(element, 'svg', true);
            target.key = key;
            target.generation++;
            if (target.userAllowedKey === key) {
                this.showRecord(target, false, false);
                return;
            }
            this.applyVisual(target, this.settings.blockTarget === 'all' ? 'bad' : 'unchecked');
        }

        inspectObject(element, kind, rawUrl) {
            const type = String(element.type || element.getAttribute('type') || '').toLowerCase();
            const url = this.resolveMediaUrl(rawUrl);
            this.inspectedMediaUrls.set(element, url);
            const embeddedType = this.readEmbeddedContentType(element);
            const isDeclaredImage = type.startsWith('image/');
            const isEmbeddedImage = embeddedType.startsWith('image/');
            if (isDeclaredImage || isEmbeddedImage || Shared.isImageLikeUrl(url)) {
                this.pendingObjectElements.delete(element);
                this.objectFirstSeen.delete(element);
                this.inspectUrlElement(element, kind, url, type || embeddedType);
                return;
            }
            if ((type && type !== 'application/octet-stream')
                || (embeddedType && embeddedType !== 'application/octet-stream')
                || this.isClearlyNonImageObjectUrl(url)) {
                this.pendingObjectElements.delete(element);
                this.objectFirstSeen.delete(element);
                this.clearRecordKind(element, kind);
                return;
            }
            if (!url) {
                this.pendingObjectElements.delete(element);
                this.objectFirstSeen.delete(element);
                this.clearRecordKind(element, kind);
                return;
            }
            if (!this.isSameOriginMediaUrl(url)) {
                // Without a declared MIME type, extension, accessible nested
                // document, or host permission there is no reliable way to
                // distinguish a cross-origin image from an embedded HTML/PDF
                // application. Preserve the application instead of disabling
                // an entire site control on a guess.
                this.pendingObjectElements.delete(element);
                this.objectFirstSeen.delete(element);
                this.clearRecordKind(element, kind);
                return;
            }

            let firstSeen = this.objectFirstSeen.get(element);
            if (!firstSeen || firstSeen.url !== url) {
                firstSeen = { url, time: Date.now() };
                this.objectFirstSeen.set(element, firstSeen);
            }
            const loadConfirmed = this.loadedObjectUrls.get(element) === url;
            if (!loadConfirmed && Date.now() - firstSeen.time < UNKNOWN_OBJECT_GRACE_MS
                && this.pendingObjectElements.size < MAX_PENDING_OBJECTS) {
                // Wait for the element's load event or an accessible nested
                // document before deciding an extensionless response. Unknown
                // raster image responses have no contentDocument, so they fail
                // closed after the short grace period instead of leaking forever.
                this.pendingObjectElements.add(element);
                const record = this.getRecord(element, kind, false);
                if (record)
                    this.showRecord(record, false, false);
                return;
            }
            this.pendingObjectElements.delete(element);
            this.inspectUrlElement(element, kind, url, type || embeddedType || 'unknown-image-response');
        }

        readEmbeddedContentType(element) {
            let nested = null;
            try {
                if (typeof element.getSVGDocument === 'function')
                    nested = element.getSVGDocument();
            } catch (err) { /* cross-origin embedded documents are inaccessible */ }
            if (!nested) {
                try { nested = element.contentDocument || null; } catch (err) { /* inaccessible */ }
            }
            if (!nested)
                return '';
            try {
                const documentElement = nested.documentElement;
                if (documentElement && (String(documentElement.localName || '').toLowerCase() === 'svg'
                    || documentElement.namespaceURI === 'http://www.w3.org/2000/svg'))
                    return 'image/svg+xml';
                if (nested.contentType)
                    return String(nested.contentType).toLowerCase();
                if (documentElement && String(documentElement.localName || '').toLowerCase() === 'html')
                    return 'text/html';
            } catch (err) { /* inaccessible */ }
            return '';
        }

        isClearlyNonImageObjectUrl(url) {
            return /\.(?:html?|xhtml|pdf|txt|json|xml|mp4|webm|og[gv]|mov|m4v|mp3|wav|m4a|wasm)(?:[?#]|$)/i.test(String(url || ''));
        }

        isSameOriginMediaUrl(url) {
            try {
                return new URL(url, this.win.location && this.win.location.href).origin === this.win.location.origin;
            } catch (err) {
                return false;
            }
        }

        inspectBackground(element) {
            const recordMap = this.recordsByElement.get(element);
            const existingKinds = recordMap
                ? Array.from(recordMap.keys()).filter(kind => this.isBackgroundRecordKind(kind))
                : [];
            const hasBlockedBackground = existingKinds.some(kind => {
                const record = recordMap.get(kind);
                return record && record.blocked;
            });
            const hasBlockedReplacedElement = recordMap
                ? Array.from(recordMap.values()).some(record => record.blocked && REPLACED_KINDS.has(record.kind))
                : false;

            // Reading the unfiltered computed background used to remove every
            // visual attribute and immediately restore it. On mutation-heavy apps
            // such as Gmail that unlocked each IMG for a frame and let the page's
            // reconciler create a permanent feedback loop. A settled blocked
            // surface is already safely covered, so keep that decision until it is
            // explicitly revealed, removed, or invalidated by a settings change.
            if (hasBlockedBackground || hasBlockedReplacedElement)
                return;

            const media = this.readStyleMedia(element);
            const hostSize = this.renderedSize(element);
            const size = {
                width: Math.max(hostSize.width, media.width || 0),
                height: Math.max(hostSize.height, media.height || 0)
            };
            const seenKinds = new Set();
            for (const candidate of media.candidates) {
                const kind = 'background:' + candidate.surface;
                seenKinds.add(kind);
                const urls = candidate.urls
                    .map(url => this.resolveMediaUrl(url))
                    .filter(url => url && !this.isExtensionAsset(url));
                const uniqueUrls = Array.from(new Set(urls));
                const profile = uniqueUrls.some(url => this.isLikelyProfileImage(element, url));
                const force = this.settings.alwaysBlock || profile;
                if (!uniqueUrls.length
                    || !Shared.sizeNeedsBlocking(size.width, size.height, this.settings.maxSafe, force)) {
                    this.clearRecordKind(element, kind);
                    continue;
                }
                const key = Shared.candidateKey('background', uniqueUrls, candidate.surface);
                const record = this.getRecord(element, kind, true);
                record.surfaces = [candidate.surface];
                this.evaluateCandidate(record, uniqueUrls, key);
            }
            for (const kind of existingKinds) {
                if (!seenKinds.has(kind))
                    this.clearRecordKind(element, kind);
            }
        }

        readStyleMedia(element) {
            const urls = [];
            const surfaces = [];
            const styles = [];
            const candidatesBySurface = new Map();
            let width = 0;
            let height = 0;
            const read = (style, surface) => {
                if (!style)
                    return;
                styles.push(style);
                const styleWidth = parseFloat(style.width);
                const styleHeight = parseFloat(style.height);
                if (Number.isFinite(styleWidth)) width = Math.max(width, styleWidth);
                if (Number.isFinite(styleHeight)) height = Math.max(height, styleHeight);
                for (const property of STYLE_MEDIA_PROPERTIES) {
                    const value = style[property];
                    const extracted = Shared.extractCssUrls(value);
                    if (!extracted.length)
                        continue;
                    const surfaceName = surface + ':' + property;
                    let candidate = candidatesBySurface.get(surfaceName);
                    if (!candidate) {
                        candidate = { surface: surfaceName, urls: [] };
                        candidatesBySurface.set(surfaceName, candidate);
                        surfaces.push(surfaceName);
                    }
                    for (const url of extracted) {
                        if (!urls.includes(url))
                            urls.push(url);
                        if (!candidate.urls.includes(url))
                            candidate.urls.push(url);
                    }
                }
            };
            let baseStyle;
            try { baseStyle = this.win.getComputedStyle(element); } catch (err) {
                return { urls, surfaces, styles, candidates: [], width, height };
            }
            read(baseStyle, 'self');
            if (this.shouldInspectPseudo(element)) {
                try { read(this.win.getComputedStyle(element, '::before'), 'before'); } catch (err) { /* ignore */ }
                try { read(this.win.getComputedStyle(element, '::after'), 'after'); } catch (err) { /* ignore */ }
            }
            return { urls, surfaces, styles, candidates: Array.from(candidatesBySurface.values()), width, height };
        }

        isBackgroundRecordKind(kind) {
            return kind === 'background' || String(kind || '').startsWith('background:');
        }

        shouldInspectPseudo(element) {
            return !!(element && element.tagName);
        }

        evaluateCandidate(record, urls, key) {
            if (!record)
                return;
            if (record.key !== key) {
                this.cancelRecordAnalyses(record);
                record.key = key;
                record.safeKey = null;
                record.pendingKey = null;
                record.pendingRevision = 0;
                record.settledKey = null;
                record.settledRevision = 0;
                record.settledStatus = null;
                record.retryAfter = 0;
                if (record.userAllowedKey !== key)
                    record.userAllowedKey = null;
            }
            if (record.userAllowedKey === key) {
                this.showRecord(record, false, false);
                return;
            }
            if (record.safeKey === key && record.safeRevision === this.settingsRevision) {
                if (this.settings.alwaysBlock && !this.settings.allowSafeDomain)
                    this.applyVisual(record, 'always');
                else
                    this.showRecord(record, false, false);
                return;
            }
            const revision = this.settingsRevision;
            if (record.settledKey === key && record.settledRevision === revision) {
                const retryExpired = record.settledStatus === 'unchecked'
                    && Date.now() >= record.retryAfter;
                if (!retryExpired) {
                    this.applyVisual(record, record.settledStatus);
                    return;
                }
                record.settledKey = null;
                record.settledRevision = 0;
                record.settledStatus = null;
            }
            if (record.pendingKey === key && record.pendingRevision === revision) {
                if (!record.blocked)
                    this.applyVisual(record, 'checking');
                return;
            }

            const generation = ++record.generation;
            record.pendingKey = key;
            record.pendingRevision = revision;
            if (this.settings.blockTarget === 'all') {
                record.pendingKey = null;
                record.pendingRevision = 0;
                record.settledKey = key;
                record.settledRevision = revision;
                record.settledStatus = 'bad';
                record.retryAfter = 0;
                this.applyVisual(record, 'bad');
                return;
            }
            let pending = urls.length;
            let sawError = false;
            let finalized = false;
            if (!pending) {
                record.pendingKey = null;
                record.pendingRevision = 0;
                record.settledKey = key;
                record.settledRevision = revision;
                record.settledStatus = 'unchecked';
                record.retryAfter = Date.now() + ANALYSIS_ERROR_RETRY_MS;
                this.applyVisual(record, 'unchecked');
                return;
            }
            if (!record.blocked)
                this.applyVisual(record, 'checking');
            for (const url of urls) {
                if (finalized)
                    break;
                const cancel = this.environment.analyze(url, result => {
                    if (finalized || !this.active || record.generation !== generation || record.key !== key
                        || record.pendingKey !== key || record.pendingRevision !== revision
                        || this.settingsRevision !== revision)
                        return;
                    result = Number(result);
                    if (result === 1) {
                        finalized = true;
                        this.cancelRecordAnalyses(record);
                        record.pendingKey = null;
                        record.pendingRevision = 0;
                        record.settledKey = key;
                        record.settledRevision = revision;
                        record.settledStatus = 'bad';
                        record.retryAfter = 0;
                        this.applyVisual(record, 'bad');
                        return;
                    }
                    if (result !== 0)
                        sawError = true;
                    pending--;
                    if (pending > 0)
                        return;
                    finalized = true;
                    this.cancelRecordAnalyses(record);
                    record.pendingKey = null;
                    record.pendingRevision = 0;
                    if (sawError) {
                        record.settledKey = key;
                        record.settledRevision = revision;
                        record.settledStatus = 'unchecked';
                        record.retryAfter = Date.now() + ANALYSIS_ERROR_RETRY_MS;
                        this.applyVisual(record, 'unchecked');
                        return;
                    }
                    record.settledKey = null;
                    record.settledRevision = 0;
                    record.settledStatus = null;
                    record.retryAfter = 0;
                    record.safeKey = key;
                    record.safeRevision = revision;
                    if (this.settings.alwaysBlock && !this.settings.allowSafeDomain)
                        this.applyVisual(record, 'always');
                    else
                        this.showRecord(record, false, false);
                });
                if (typeof cancel === 'function') {
                    if (finalized)
                        cancel();
                    else
                        record.analysisCancels.push(cancel);
                }
            }
        }

        getRecord(element, kind, create) {
            let map = this.recordsByElement.get(element);
            if (!map && create) {
                map = new Map();
                this.recordsByElement.set(element, map);
            }
            if (!map)
                return null;
            let record = map.get(kind);
            if (!record && create) {
                record = {
                    element,
                    kind,
                    key: null,
                    generation: 0,
                    blocked: false,
                    status: null,
                    safeKey: null,
                    safeRevision: 0,
                    pendingKey: null,
                    pendingRevision: 0,
                    analysisCancels: [],
                    settledKey: null,
                    settledRevision: 0,
                    settledStatus: null,
                    retryAfter: 0,
                    userAllowedKey: null,
                    surfaces: null
                };
                map.set(kind, record);
                this.records.add(record);
            }
            else if (record && create && !this.records.has(record)) {
                this.records.add(record);
            }
            return record || null;
        }

        clearRecordKind(element, kind) {
            const map = this.recordsByElement.get(element);
            const record = map && map.get(kind);
            if (!record)
                return;
            this.cancelRecordAnalyses(record);
            record.generation++;
            this.showRecord(record, false, false);
            this.records.delete(record);
            map.delete(kind);
            if (!map.size)
                this.recordsByElement.delete(element);
        }

        clearElementRecords(element) {
            const map = this.recordsByElement.get(element);
            if (!map)
                return;
            for (const record of map.values()) {
                this.cancelRecordAnalyses(record);
                record.generation++;
                this.showRecord(record, false, false);
                this.records.delete(record);
            }
            map.clear();
        }

        applyVisual(record, status) {
            if (!record || !record.element)
                return;
            record.status = status;
            record.blocked = true;
            this.renderElementVisuals(record.element);
        }

        hasBlockedRecord(element) {
            const map = this.recordsByElement.get(element);
            return !!(map && Array.from(map.values()).some(record => record.blocked));
        }

        renderElementVisuals(element) {
            if (!element)
                return;
            const map = this.recordsByElement.get(element);
            const blocked = map ? Array.from(map.values()).filter(record => record.blocked) : [];
            if (!blocked.length) {
                for (const attribute of VISUAL_ATTRIBUTES)
                    this.writeAttribute(element, attribute, null);
                return;
            }
            const priority = { bad: 4, checking: 3, unchecked: 2, always: 1 };
            const selected = blocked.reduce((best, record) =>
                (priority[record.status] || 0) > (priority[best.status] || 0) ? record : best
            );
            const status = selected.status;
            const shade = status === 'bad' ? 5 : (status === 'checking' ? 2 : (status === 'always' ? 0 : 1));
            // Older releases used one broad pseudo selector. Always remove those
            // legacy attributes, then describe only the exact CSS surface that
            // contains a blocked URL so sibling pseudo text remains functional.
            this.writeAttribute(element, 'data-wzm-suppress-media', null);
            this.writeAttribute(element, 'data-wzm-suppress-content', null);
            this.writeAttribute(element, 'data-wzm-suppress-self-media', null);
            this.writeAttribute(element, 'data-wzm-suppress-before-media', null);
            this.writeAttribute(element, 'data-wzm-suppress-after-media', null);
            const blockedSurfaces = new Set();
            for (const record of blocked) {
                if (!this.isBackgroundRecordKind(record.kind) || !Array.isArray(record.surfaces))
                    continue;
                for (const surface of record.surfaces)
                    blockedSurfaces.add(surface);
            }
            const blocksReplacedElement = blocked.some(record => REPLACED_KINDS.has(record.kind));
            const showHostPattern = blocksReplacedElement
                || blockedSurfaces.has('self:backgroundImage');
            this.writeAttribute(element, 'data-wzm-pattern-bg-img', showHostPattern ? '1' : null);
            this.writeAttribute(element, 'data-wzm-shade', showHostPattern ? String(shade) : null);
            this.writeAttribute(element, 'data-wzm-checking', showHostPattern && status === 'checking' ? '1' : null);
            this.writeAttribute(element, 'data-wzm-always', showHostPattern && status === 'always' ? '1' : null);
            this.writeAttribute(element, 'data-wzm-no-pattern', showHostPattern && this.settings.noPattern ? '1' : null);
            const writeSurfaceAttributes = scope => {
                this.writeAttribute(element, 'data-wzm-suppress-' + scope + '-background',
                    blockedSurfaces.has(scope + ':backgroundImage') ? '1' : null);
                this.writeAttribute(element, 'data-wzm-suppress-' + scope + '-mask',
                    (blockedSurfaces.has(scope + ':maskImage') || blockedSurfaces.has(scope + ':webkitMaskImage')) ? '1' : null);
                this.writeAttribute(element, 'data-wzm-suppress-' + scope + '-border',
                    blockedSurfaces.has(scope + ':borderImageSource') ? '1' : null);
                this.writeAttribute(element, 'data-wzm-suppress-' + scope + '-list',
                    blockedSurfaces.has(scope + ':listStyleImage') ? '1' : null);
                this.writeAttribute(element, 'data-wzm-suppress-' + scope + '-content',
                    blockedSurfaces.has(scope + ':content') ? '1' : null);
            };
            writeSurfaceAttributes('self');
            writeSurfaceAttributes('before');
            writeSurfaceAttributes('after');
            this.writeAttribute(element, 'data-wzm-locked', blocksReplacedElement ? '1' : null);
            this.writeAttribute(element, 'data-wzm-hide', blocked.some(record => record.kind === 'svg-image') ? '1' : null);
        }

        repairVisual(record) {
            if (!record || !record.blocked || !record.element)
                return;
            this.renderElementVisuals(record.element);
        }

        cancelRecordAnalyses(record) {
            if (!record || !Array.isArray(record.analysisCancels) || !record.analysisCancels.length)
                return false;
            const cancels = record.analysisCancels.splice(0);
            for (const cancel of cancels) {
                try { cancel(); } catch (err) { /* A request may already be complete. */ }
            }
            return true;
        }

        showRecord(record, userInitiated, destroying) {
            if (!record)
                return;
            const hadCancelableAnalysis = this.cancelRecordAnalyses(record);
            const hadPending = record.pendingKey != null || hadCancelableAnalysis;
            if (hadPending) {
                record.generation++;
                record.pendingKey = null;
                record.pendingRevision = 0;
            }
            if (userInitiated) {
                if (!hadPending)
                    record.generation++;
                record.userAllowedKey = record.key;
            }
            record.blocked = false;
            record.status = null;
            if (destroying) {
                if (!hadPending && !userInitiated)
                    record.generation++;
                record.safeKey = null;
                record.userAllowedKey = null;
            }
            this.renderElementVisuals(record.element);
        }

        removeVisualAttributes(record) {
            const element = record && record.element;
            if (!element)
                return;
            for (const attribute of VISUAL_ATTRIBUTES)
                this.writeAttribute(element, attribute, null);
        }

        rehideRecord(record) {
            if (!record)
                return;
            this.cancelRecordAnalyses(record);
            record.userAllowedKey = null;
            record.safeKey = null;
            record.generation++;
            record.pendingKey = null;
            record.pendingRevision = 0;
            this.queueElement(record.element);
        }

        writeAttribute(element, name, value) {
            if (!element || !element.getAttribute)
                return;
            const current = element.getAttribute(name);
            const expected = value == null ? null : String(value);
            if (current === expected)
                return;
            this.rememberOwnWrite(element, name, expected);
            if (expected == null)
                element.removeAttribute(name);
            else
                element.setAttribute(name, expected);
        }

        rememberOwnWrite(element, name, expected) {
            let writes = this.ownWrites.get(element);
            if (!writes) {
                writes = new Map();
                this.ownWrites.set(element, writes);
            }
            const previous = writes.get(name);
            writes.set(name, { expected, remaining: (previous ? previous.remaining : 0) + 1 });
        }

        consumeOwnWrite(element, name) {
            const writes = this.ownWrites.get(element);
            if (!writes || !writes.has(name))
                return false;
            const entry = writes.get(name);
            const current = element.getAttribute(name);
            if (current !== entry.expected) {
                writes.delete(name);
                return false;
            }
            entry.remaining--;
            if (entry.remaining <= 0)
                writes.delete(name);
            return true;
        }

        isLikelyProfileImage(element, url) {
            const parts = [url || ''];
            let node = element;
            for (let i = 0; node && i < 5 && node !== this.doc.body && node !== this.doc.documentElement; i++, node = node.parentElement) {
                parts.push(node.tagName || '', node.id || '', typeof node.className === 'string' ? node.className : '');
                for (const attr of ['alt', 'title', 'aria-label', 'role', 'data-testid', 'data-test', 'data-locator', 'src'])
                    parts.push(node.getAttribute ? (node.getAttribute(attr) || '') : '');
            }
            return /\b(?:avatar|profile|portrait|headshot|recruiter|assistant|agent|chatbot|chatbox)\b|ai[\s_-]*recruit/i.test(parts.join(' '));
        }

        resolveMediaUrl(value) {
            return Shared.resolveUrl(value, this.win.location && this.win.location.href);
        }

        isExtensionAsset(url) {
            return !!(this.extensionUrl && String(url).startsWith(this.extensionUrl));
        }

        hashString(value) {
            let hash = 2166136261;
            value = String(value || '');
            for (let i = 0; i < value.length; i++) {
                hash ^= value.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16);
        }

        visualMarkupSignature(element) {
            const parts = [];
            let remainingCharacters = 65536;
            let visited = 0;
            const append = value => {
                if (remainingCharacters <= 0)
                    return;
                value = String(value || '');
                if (value.length > remainingCharacters)
                    value = value.slice(0, remainingCharacters);
                parts.push(value);
                remainingCharacters -= value.length;
            };
            let walker;
            try {
                walker = this.doc.createTreeWalker(
                    element,
                    this.win.NodeFilter.SHOW_ELEMENT | this.win.NodeFilter.SHOW_TEXT
                );
            } catch (err) {
                return String(element.tagName || 'svg');
            }
            const depths = new WeakMap();
            depths.set(element, 0);
            let node = element;
            while (node && visited < 2048 && remainingCharacters > 0) {
                visited++;
                const parentDepth = node.parentNode ? depths.get(node.parentNode) : -1;
                const depth = node === element ? 0 : (Number.isFinite(parentDepth) ? parentDepth + 1 : 0);
                if (node.nodeType === 1) {
                    depths.set(node, depth);
                    append(depth + '<' + String(node.tagName || '').toLowerCase() + ':' + node.childNodes.length + ':');
                    let attributeCount = 0;
                    for (const attribute of node.attributes || []) {
                        if (attributeCount++ >= 128) {
                            append('#attrs-truncated');
                            break;
                        }
                        if (VISUAL_ATTRIBUTE_SET.has(attribute.name.toLowerCase()))
                            continue;
                        const value = attribute.value || '';
                        append(attribute.name + '=' + value.slice(0, 1024) + '#' + value.length + ';');
                        if (remainingCharacters <= 0)
                            break;
                    }
                    append('>');
                }
                else {
                    const value = node.nodeValue || '';
                    append(depth + '#text:' + value.slice(0, 1024) + '#' + value.length + ';');
                }
                node = walker.nextNode();
            }
            if (node)
                append('#truncated');
            return parts.join('');
        }

        createEye() {
            if (this.eye || !this.doc.body)
                return;
            const eye = this.doc.createElement('button');
            eye.type = 'button';
            eye.setAttribute('aria-label', 'Show filtered image');
            eye.setAttribute('data-wzm-eye', '1');
            eye.style.display = 'none';
            eye.style.position = 'fixed';
            eye.style.width = '24px';
            eye.style.height = '24px';
            eye.style.padding = '0';
            eye.style.margin = '0';
            eye.style.border = '0';
            eye.style.borderRadius = '4px';
            eye.style.backgroundColor = 'rgba(255,255,255,.85)';
            eye.style.backgroundImage = 'url("' + this.getURL('eye.svg') + '")';
            eye.style.backgroundSize = 'contain';
            eye.style.backgroundRepeat = 'no-repeat';
            eye.style.cursor = 'pointer';
            eye.style.zIndex = '2147483647';
            eye.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const record = this.eyeRecord;
                if (!record)
                    return;
                if (record.blocked) {
                    this.showRecord(record, true, false);
                    eye.setAttribute('aria-label', 'Hide image again');
                    eye.style.backgroundImage = 'url("' + this.getURL('undo.png') + '")';
                    this.scheduleEyeHide();
                }
                else {
                    this.rehideRecord(record);
                    eye.setAttribute('aria-label', 'Show filtered image');
                    eye.style.backgroundImage = 'url("' + this.getURL('eye.svg') + '")';
                    this.scheduleEyeHide();
                }
            });
            this.doc.body.appendChild(eye);
            this.eye = eye;
        }

        removeEye() {
            if (this.eye && this.eye.parentNode)
                this.eye.parentNode.removeChild(this.eye);
            this.eye = null;
            this.eyeRecord = null;
            if (this.eyeHideTimeout)
                this.win.clearTimeout(this.eyeHideTimeout);
            this.eyeHideTimeout = null;
        }

        onMouseOver(event) {
            this.queueHoverTree(event);
            if (!this.active || this.settings.noEye || !this.eye
                || (this.usesSafariTextControlLayoutGuard && this.hasSeenTextareaLayoutHazard)) {
                this.hideEye();
                return;
            }
            const path = event.composedPath ? event.composedPath() : [event.target];
            let record = null;
            for (const element of path) {
                if (!element || element.nodeType !== 1)
                    continue;
                const map = this.recordsByElement.get(element);
                if (!map)
                    continue;
                record = Array.from(map.values()).find(candidate => candidate.blocked);
                if (record)
                    break;
            }
            if (!record)
                return;
            this.eyeRecord = record;
            const rect = record.element.getBoundingClientRect();
            this.eye.style.left = Math.max(0, Math.min(this.win.innerWidth - 24, rect.right - 24)) + 'px';
            this.eye.style.top = Math.max(0, Math.min(this.win.innerHeight - 24, rect.top)) + 'px';
            this.eye.style.display = 'block';
            this.eye.setAttribute('aria-label', 'Show filtered image');
            this.eye.style.backgroundImage = 'url("' + this.getURL('eye.svg') + '")';
        }

        queueHoverTree(event) {
            if (!this.active)
                return;
            const path = event && event.composedPath ? event.composedPath() : [event && event.target];
            let root = null;
            let depth = 0;
            for (const element of path) {
                if (!element || element.nodeType !== 1 || element === this.eye)
                    continue;
                if (element === this.doc.body || element === this.doc.documentElement)
                    break;
                root = element;
                depth++;
                if (depth >= 4)
                    break;
            }
            if (!root)
                return;
            this.hoverScanRoot = root;
            if (!this.hoverScanTimeout) {
                this.hoverScanTimeout = this.setTrackedTimeout(() => {
                    const currentRoot = this.hoverScanRoot;
                    this.hoverScanRoot = null;
                    this.hoverScanTimeout = null;
                    if (currentRoot && currentRoot.isConnected) {
                        this.queueTree(currentRoot, true);
                        this.queueObservedShadowRootsWithin(currentRoot);
                    }
                }, 40);
            }
        }

        scheduleEyeHide() {
            if (this.eyeHideTimeout)
                this.win.clearTimeout(this.eyeHideTimeout);
            this.eyeHideTimeout = this.win.setTimeout(() => this.hideEye(), 2500);
        }

        hideEye() {
            if (this.eye)
                this.eye.style.display = 'none';
            this.eyeRecord = null;
            if (this.eyeHideTimeout)
                this.win.clearTimeout(this.eyeHideTimeout);
            this.eyeHideTimeout = null;
        }

        onKeyDown(event) {
            if (!event.altKey)
                return;
            if ((event.key === 'a' || event.key === 'A') && this.eyeRecord && this.eyeRecord.blocked)
                this.showRecord(this.eyeRecord, true, false);
            else if ((event.key === 'z' || event.key === 'Z') && this.eyeRecord && !this.eyeRecord.blocked)
                this.rehideRecord(this.eyeRecord);
            else if ((event.key === 'p' || event.key === 'P') && this.environment.sendMessage)
                this.environment.sendMessage({ r: 'pause', toggle: true });
        }
    }

    WizmageContentController.BLANK_IMAGE = BLANK_IMAGE;
    // Kept as an explicit compatibility signal for diagnostics. A null filter
    // means MutationObserver watches every attribute because any attribute may
    // participate in a CSS selector.
    WizmageContentController.ATTRIBUTE_FILTER = null;
    WizmageContentController.OBSERVES_ALL_ATTRIBUTES = true;
    return WizmageContentController;
});
