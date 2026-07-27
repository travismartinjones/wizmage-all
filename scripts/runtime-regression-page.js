(function () {
    'use strict';

    const resultNode = document.getElementById('wzm-test-result');
    const completedChecks = [];
    const SHADOW_HOST_PENDING_ATTRIBUTE = 'data-wzm-shadow-pending';
    const VISUAL_ATTRIBUTES = [
        'data-wzm-hide',
        'data-wzm-locked',
        'data-wzm-pattern-bg-img',
        'data-wzm-shade',
        'data-wzm-checking',
        'data-wzm-always',
        'data-wzm-no-pattern',
        'data-wzm-media-pending',
        'data-wzm-suppress-media',
        'data-wzm-suppress-content',
        'data-wzm-suppress-self-media',
        'data-wzm-suppress-before-media',
        'data-wzm-suppress-after-media',
        'data-wzm-suppress-self-background',
        'data-wzm-suppress-self-mask',
        'data-wzm-suppress-self-border',
        'data-wzm-suppress-self-list',
        'data-wzm-suppress-self-content',
        'data-wzm-suppress-before-background',
        'data-wzm-suppress-before-mask',
        'data-wzm-suppress-before-border',
        'data-wzm-suppress-before-list',
        'data-wzm-suppress-before-content',
        'data-wzm-suppress-after-background',
        'data-wzm-suppress-after-mask',
        'data-wzm-suppress-after-border',
        'data-wzm-suppress-after-list',
        'data-wzm-suppress-after-content'
    ];

    function finish(status, details) {
        document.documentElement.setAttribute('data-wzm-test-status', status);
        document.title = status === 'pass' ? 'WZM_TEST_PASS' : 'WZM_TEST_FAIL';
        resultNode.textContent = status === 'pass'
            ? JSON.stringify({ status, checks: completedChecks })
            : String(details && details.stack ? details.stack : details);
    }

    function assert(condition, message) {
        if (!condition)
            throw new Error(message);
    }

    function delay(milliseconds) {
        return new Promise(resolve => window.setTimeout(resolve, milliseconds));
    }

    async function waitFor(predicate, message, timeout) {
        const deadline = performance.now() + (timeout || 4000);
        let lastError = null;
        while (performance.now() < deadline) {
            try {
                if (predicate())
                    return;
            } catch (error) {
                lastError = error;
            }
            await delay(20);
        }
        const details = typeof message === 'function' ? message() : message;
        throw new Error(details + (lastError ? ': ' + lastError.message : ''));
    }

    function imageUrl(name) {
        return new URL('/img/' + name, location.href).href;
    }

    function extensionUrl(path) {
        return new URL('/extension/' + (path || ''), location.href).href;
    }

    function recordFor(controller, element, kind) {
        const records = controller.recordsByElement.get(element);
        if (!records)
            return null;
        if (records.has(kind))
            return records.get(kind);
        for (const [recordKind, record] of records) {
            if (recordKind.startsWith(kind + ':'))
                return record;
        }
        return null;
    }

    function recordsFor(controller, element, kind) {
        const records = controller.recordsByElement.get(element);
        return records ? Array.from(records.entries())
            .filter(entry => entry[0] === kind || entry[0].startsWith(kind + ':'))
            .map(entry => entry[1]) : [];
    }

    function isBlocked(element) {
        return element.getAttribute('data-wzm-pattern-bg-img') === '1';
    }

    function hasNoVisualAttributes(element) {
        return VISUAL_ATTRIBUTES.every(attribute => !element.hasAttribute(attribute));
    }

    function mark(name) {
        completedChecks.push(name);
    }

    function makeSettings(blockTarget) {
        return Object.assign({}, globalThis.WizmageShared.DEFAULT_SETTINGS, {
            blockTarget,
            maxSafe: 32,
            noEye: true,
            noPattern: false,
            alwaysBlock: false,
            allowSafeDomain: false
        });
    }

    function makeEnvironment(analyze) {
        return {
            getURL: extensionUrl,
            analyze,
            sendMessage: function () { },
            onError: function (error) { throw error; }
        };
    }

    function makePendingAnalyzer(options) {
        const cancelable = !!(options && options.cancelable);
        const requests = [];
        return {
            requests,
            analyze: function (url, callback) {
                const request = { url: String(url), callback, delivered: false, canceled: false };
                requests.push(request);
                if (!cancelable)
                    return undefined;
                return function () {
                    if (request.delivered || request.canceled)
                        return;
                    request.canceled = true;
                    request.callback = null;
                };
            },
            has: function (part) {
                return requests.some(request => request.url.includes(part));
            },
            matching: function (part, pendingOnly) {
                return requests.filter(request =>
                    request.url.includes(part) && (!pendingOnly || (!request.delivered && !request.canceled))
                );
            },
            deliverRequest: function (request, result) {
                if (!request || request.delivered || request.canceled)
                    return false;
                request.delivered = true;
                request.callback(result);
                return true;
            },
            deliver: function (part, result) {
                let delivered = 0;
                for (const request of requests.slice()) {
                    if (request.delivered || request.canceled || !request.url.includes(part))
                        continue;
                    request.delivered = true;
                    delivered++;
                    request.callback(result);
                }
                return delivered;
            },
            deliverAll: function (result) {
                let delivered = 0;
                for (const request of requests.slice()) {
                    if (request.delivered || request.canceled)
                        continue;
                    request.delivered = true;
                    delivered++;
                    request.callback(result);
                }
                return delivered;
            }
        };
    }

    async function runDiscoveryAndCleanupChecks() {
        const Controller = globalThis.WizmageContentController;
        const singleImage = document.getElementById('single-image');
        const siteButton = document.getElementById('site-button');
        assert(
            window.__wzmInitialMediaState &&
                window.__wzmInitialMediaState.opacity === '0' &&
                window.__wzmInitialMediaState.pending == null &&
                window.__wzmInitialMediaState.locked == null,
            'A parser-created image exposed its raw pixels before Wizmage inspected it'
        );
        mark('parser-created media is concealed before inspection');
        const rootStyle = document.documentElement.style;
        rootStyle.setProperty('--wzm-pattern-0', 'url("site-owned-pattern.png")', 'important');
        rootStyle.removeProperty('--wzm-pattern-1');
        const controller = new Controller(
            window,
            makeSettings('all'),
            makeEnvironment(function (_url, callback) { callback(1); })
        );
        const mediaGateStartedAt = performance.now();
        controller.start();
        assert(
            document.documentElement.classList.contains('wizmage-media-starting') &&
                !document.documentElement.classList.contains('wizmage-show-html'),
            'Starting an active controller disabled the media prepaint gate'
        );
        assert(controller.initialMediaGateTimeout != null, 'The active media gate has no bounded fail-open');
        controller.trackShadowHostReadiness({}, null, null);
        controller.markShadowRootScanComplete({ host: {} });
        mark('non-element shadow hosts are ignored safely');

        assert(
            rootStyle.getPropertyValue('--wzm-pattern-0').includes('/extension/pattern0.png'),
            'The controller did not install its root pattern variables'
        );

        await waitFor(
            () => singleImage.getAttribute('data-wzm-locked') === '1',
            'An ordinary page containing one image was not filtered'
        );
        await waitFor(
            () => !document.documentElement.classList.contains('wizmage-media-starting'),
            'The controller did not release the initial media gate after scanning'
        );
        const mediaGateDuration = performance.now() - mediaGateStartedAt;
        assert(
            mediaGateDuration >= 1650,
            'The initial media gate released before delayed SPA media could hydrate: ' +
                Math.round(mediaGateDuration) + 'ms'
        );
        assert(controller.initialMediaGateTimeout == null, 'A completed initial scan retained its fail-open timer');
        assert(recordFor(controller, singleImage, 'img'), 'The initial image has no controller record');
        mark('ordinary one-image page is filtered through the SPA hydration window');

        const largeTree = document.createElement('div');
        const largeCanvasCount = 300;
        let lastLargeCanvas = null;
        for (let index = 0; index < largeCanvasCount; index++) {
            const item = document.createElement('canvas');
            item.width = 40;
            item.height = 40;
            item.style.width = '40px';
            item.style.height = '40px';
            largeTree.appendChild(item);
            lastLargeCanvas = item;
        }
        const siteTimerStarted = performance.now();
        const siteTimer = new Promise(resolve => window.setTimeout(() => resolve(performance.now()), 0));
        document.body.appendChild(largeTree);
        const siteTimerFinished = await siteTimer;
        const blockedBeforeSiteTimer = largeTree.querySelectorAll('[data-wzm-locked="1"]').length;
        assert(siteTimerFinished - siteTimerStarted < 1000, 'A queued scan delayed a zero-delay site timer for too long');
        assert(
            blockedBeforeSiteTimer < largeCanvasCount / 2,
            'A large added subtree was scanned synchronously before the site timer could run'
        );
        await waitFor(
            () => lastLargeCanvas.getAttribute('data-wzm-locked') === '1',
            'The batched large-DOM scan did not complete'
        );
        largeTree.remove();
        await waitFor(
            () => !Array.from(controller.records).some(record => largeTree.contains(record.element)),
            'Large-DOM records were not pruned after removal'
        );
        mark('large DOM scans yield to site timers');

        const hotAttributeRoot = document.createElement('section');
        for (let index = 0; index < 600; index++)
            hotAttributeRoot.appendChild(document.createElement('span'));
        document.body.appendChild(hotAttributeRoot);
        await waitFor(
            () => !controller.scanJobs.some(job => job.root === hotAttributeRoot),
            'The hot-attribute fixture did not finish its initial scan'
        );
        const originalQueueTree = controller.queueTree.bind(controller);
        let hotSubtreeScans = 0;
        controller.queueTree = function (root, includeRoot) {
            if (root === hotAttributeRoot)
                hotSubtreeScans++;
            return originalQueueTree(root, includeRoot);
        };
        for (let index = 0; index < 45; index++) {
            hotAttributeRoot.dataset.tick = String(index);
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        await delay(1200);
        controller.queueTree = originalQueueTree;
        assert(hotSubtreeScans <= 1, 'An unused high-frequency data attribute queued repeated subtree scans');
        hotAttributeRoot.remove();
        mark('unused high-frequency attributes do not rescan large subtrees');

        let buttonTargetClicks = 0;
        let buttonBubbleClicks = 0;
        const bubbleListener = event => {
            if (event.target === siteButton)
                buttonBubbleClicks++;
        };
        document.body.addEventListener('click', bubbleListener);
        siteButton.addEventListener('click', () => { buttonTargetClicks++; });
        siteButton.style.width = '120px';
        siteButton.style.height = '80px';
        siteButton.style.backgroundImage = 'url("' + imageUrl('button-background.png') + '")';
        await waitFor(
            () => isBlocked(siteButton) && !!recordFor(controller, siteButton, 'background'),
            'The button background was not filtered'
        );

        // Gmail continuously reconciles attributes on image hosts. Wizmage must
        // reach a write-free steady state after a candidate has been decided;
        // otherwise each filter write causes Gmail to write again and the image
        // visibly oscillates between the page and the blocking pattern.
        await delay(100);
        const gmailImageSrc = singleImage.getAttribute('src');
        const gmailButtonBackground = siteButton.style.backgroundImage;
        let gmailVisualWrites = 0;
        let gmailReconciliationPasses = 0;
        let gmailReconciliationScheduled = false;
        const gmailObserver = new MutationObserver(mutations => {
            let sawVisualWrite = false;
            for (const mutation of mutations) {
                if ((mutation.target === singleImage || mutation.target === siteButton)
                    && VISUAL_ATTRIBUTES.includes(mutation.attributeName)) {
                    gmailVisualWrites++;
                    sawVisualWrite = true;
                }
            }
            if (!sawVisualWrite || gmailReconciliationScheduled || gmailReconciliationPasses >= 12)
                return;
            gmailReconciliationScheduled = true;
            requestAnimationFrame(() => {
                gmailReconciliationScheduled = false;
                gmailReconciliationPasses++;
                const revision = String(gmailReconciliationPasses % 2);
                singleImage.setAttribute('data-gmail-render-revision', revision);
                siteButton.setAttribute('data-gmail-render-revision', revision);
                singleImage.setAttribute('src', gmailImageSrc);
                siteButton.style.backgroundImage = gmailButtonBackground;
            });
        });
        gmailObserver.observe(singleImage, { attributes: true, attributeOldValue: true });
        gmailObserver.observe(siteButton, { attributes: true, attributeOldValue: true });
        singleImage.setAttribute('data-gmail-render-revision', 'seed');
        siteButton.setAttribute('data-gmail-render-revision', 'seed');
        await delay(750);
        const gmailWritesBeforeQuiescence = gmailVisualWrites;
        await delay(250);
        gmailObserver.disconnect();
        assert(gmailVisualWrites === 0, 'A settled Gmail-like image triggered repeated Wizmage visual writes');
        assert(gmailReconciliationPasses === 0, 'Wizmage visual writes triggered Gmail-like reconciliation');
        assert(
            gmailVisualWrites === gmailWritesBeforeQuiescence,
            'Gmail-like visual mutations continued after the controller should have quiesced'
        );
        assert(singleImage.getAttribute('src') === gmailImageSrc, 'Filtering changed a Gmail-like image source');
        assert(siteButton.style.backgroundImage === gmailButtonBackground, 'Filtering changed a Gmail-like background source');
        assert(
            singleImage.getAttribute('data-wzm-locked') === '1' && isBlocked(siteButton),
            'Gmail-like image surfaces did not remain blocked throughout reconciliation'
        );
        singleImage.removeAttribute('data-gmail-render-revision');
        siteButton.removeAttribute('data-gmail-render-revision');
        mark('settled Gmail-like images remain write-free under page reconciliation');

        siteButton.click();
        assert(buttonTargetClicks === 1, 'The extension prevented the site button handler');
        assert(buttonBubbleClicks === 1, 'The extension stopped the site click from bubbling');
        mark('blocked controls preserve site click propagation');

        const video = document.createElement('video');
        video.id = 'fixture-video';
        video.controls = true;
        video.poster = imageUrl('video-poster.png');
        video.style.width = '160px';
        video.style.height = '100px';
        let videoClicks = 0;
        let videoBubbleClicks = 0;
        video.addEventListener('click', () => { videoClicks++; });
        const videoBubbleListener = event => {
            if (event.target === video)
                videoBubbleClicks++;
        };
        document.body.addEventListener('click', videoBubbleListener);
        document.body.appendChild(video);
        await waitFor(
            () => video.getAttribute('data-wzm-locked') === '1' &&
                video.getAttribute('data-wzm-pattern-bg-img') === '1',
            'A video poster image was not filtered'
        );
        video.click();
        assert(video.controls, 'Video controls were disabled');
        assert(getComputedStyle(video).pointerEvents !== 'none', 'Video pointer events were disabled');
        assert(videoClicks === 1 && videoBubbleClicks === 1, 'Video click behavior was intercepted');
        mark('video poster is filtered while video controls remain functional');

        document.body.style.backgroundImage = 'url("' + imageUrl('body-background.png') + '")';

        const dynamicImage = document.createElement('img');
        dynamicImage.id = 'dynamic-image';
        dynamicImage.alt = 'dynamic fixture';
        dynamicImage.src = imageUrl('dynamic.png');
        dynamicImage.style.width = '120px';
        dynamicImage.style.height = '120px';
        // Hold the scan lane for one task so this assertion samples the state
        // produced by the MutationObserver, before classification can finish.
        document.body.appendChild(dynamicImage);
        controller.onMutations([{
            type: 'childList',
            target: document.body,
            addedNodes: [dynamicImage],
            removedNodes: []
        }]);
        const dynamicPendingState = {
            opacity: getComputedStyle(dynamicImage).opacity,
            pending: dynamicImage.getAttribute('data-wzm-media-pending'),
            locked: dynamicImage.getAttribute('data-wzm-locked')
        };
        assert(
            dynamicPendingState.opacity === '0' &&
                dynamicPendingState.pending === '1' &&
                dynamicPendingState.locked == null,
            'A dynamically inserted image exposed its raw pixels before inspection: ' +
                JSON.stringify(dynamicPendingState)
        );
        mark('dynamic media is concealed synchronously');

        const dynamicBackground = document.createElement('div');
        dynamicBackground.id = 'dynamic-background';
        dynamicBackground.style.width = '120px';
        dynamicBackground.style.height = '120px';
        dynamicBackground.style.backgroundImage = 'url("' + imageUrl('dynamic-background.png') + '")';
        document.body.appendChild(dynamicBackground);
        controller.onMutations([{
            type: 'childList',
            target: document.body,
            addedNodes: [dynamicBackground],
            removedNodes: []
        }]);
        const dynamicBackgroundPendingState = {
            backgroundImage: getComputedStyle(dynamicBackground).backgroundImage,
            backgroundSize: getComputedStyle(dynamicBackground).backgroundSize,
            pending: dynamicBackground.getAttribute('data-wzm-media-pending'),
            pattern: dynamicBackground.getAttribute('data-wzm-pattern-bg-img')
        };
        assert(
            dynamicBackgroundPendingState.backgroundImage.includes('dynamic-background.png') &&
                dynamicBackgroundPendingState.backgroundSize === '0px 0px' &&
                dynamicBackgroundPendingState.pending === '1' &&
                dynamicBackgroundPendingState.pattern == null,
            'A dynamically inserted CSS image exposed its raw pixels before inspection: ' +
                JSON.stringify(dynamicBackgroundPendingState)
        );
        await waitFor(
            () => dynamicBackground.getAttribute('data-wzm-pattern-bg-img') === '1' &&
                !dynamicBackground.hasAttribute('data-wzm-media-pending'),
            'A dynamically inserted CSS image did not settle into its filtered state'
        );
        mark('dynamic CSS media is concealed synchronously');

        const sourceSwapImage = document.createElement('img');
        sourceSwapImage.id = 'source-swap-image';
        sourceSwapImage.alt = 'source mutation fixture';
        sourceSwapImage.src = imageUrl('source-swap-a.png');
        sourceSwapImage.style.width = '20px';
        sourceSwapImage.style.height = '20px';
        document.body.appendChild(sourceSwapImage);
        await delay(0);
        await waitFor(
            () => !controller.hasScanWork() &&
                !sourceSwapImage.hasAttribute('data-wzm-media-pending'),
            'The source-mutation baseline image did not finish inspection'
        );
        assert(!sourceSwapImage.hasAttribute('data-wzm-locked'), 'The source-mutation baseline was unexpectedly blocked');

        sourceSwapImage.setAttribute('width', '21');
        controller.onMutations([{
            type: 'attributes',
            target: sourceSwapImage,
            attributeName: 'width'
        }]);
        const geometryMutationState = {
            opacity: getComputedStyle(sourceSwapImage).opacity,
            pending: sourceSwapImage.getAttribute('data-wzm-media-pending'),
            locked: sourceSwapImage.getAttribute('data-wzm-locked')
        };
        assert(
            geometryMutationState.opacity !== '0' && geometryMutationState.pending == null,
            'A geometry-only image mutation caused filtering flicker: ' + JSON.stringify(geometryMutationState)
        );
        await waitFor(
            () => !controller.hasScanWork() && !sourceSwapImage.hasAttribute('data-wzm-media-pending'),
            'The geometry-only mutation did not finish its non-gating inspection'
        );
        mark('geometry-only media changes remain visible during reinspection');

        sourceSwapImage.src = imageUrl('source-swap-b.png');
        controller.onMutations([{
            type: 'attributes',
            target: sourceSwapImage,
            attributeName: 'src'
        }]);
        const sourceMutationState = {
            opacity: getComputedStyle(sourceSwapImage).opacity,
            pending: sourceSwapImage.getAttribute('data-wzm-media-pending'),
            locked: sourceSwapImage.getAttribute('data-wzm-locked')
        };
        assert(
            sourceMutationState.opacity === '0' && sourceMutationState.pending === '1' && sourceMutationState.locked == null,
            'A changed image source was exposed before reinspection: ' + JSON.stringify(sourceMutationState)
        );
        mark('changed media sources are concealed before reinspection');

        const cssOnlyImage = document.createElement('img');
        cssOnlyImage.id = 'css-only-image';
        cssOnlyImage.alt = 'CSS-only replaced-element fixture';
        cssOnlyImage.style.width = '120px';
        cssOnlyImage.style.height = '120px';
        cssOnlyImage.style.minWidth = '120px';
        cssOnlyImage.style.minHeight = '120px';
        cssOnlyImage.style.backgroundImage = 'url("' + imageUrl('css-only-background.png') + '")';
        cssOnlyImage.style.content = 'url("' + imageUrl('css-only-content.png') + '")';
        document.body.appendChild(cssOnlyImage);

        const inputImage = document.createElement('input');
        inputImage.id = 'input-image';
        inputImage.type = 'image';
        inputImage.src = imageUrl('input.png');
        inputImage.style.width = '120px';
        inputImage.style.height = '120px';
        document.body.appendChild(inputImage);

        const canvas = document.createElement('canvas');
        canvas.id = 'fixture-canvas';
        canvas.width = 120;
        canvas.height = 120;
        canvas.style.width = '120px';
        canvas.style.height = '120px';
        const context = canvas.getContext('2d');
        if (context) {
            context.fillStyle = '#123456';
            context.fillRect(0, 0, 120, 120);
        }
        document.body.appendChild(canvas);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'fixture-svg';
        svg.setAttribute('width', '120');
        svg.setAttribute('height', '120');
        svg.style.width = '120px';
        svg.style.height = '120px';
        const svgImage = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        svgImage.id = 'fixture-svg-image';
        svgImage.setAttribute('href', imageUrl('svg-image.png'));
        svgImage.setAttribute('width', '120');
        svgImage.setAttribute('height', '120');
        svg.appendChild(svgImage);
        document.body.appendChild(svg);

        const purePathSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        purePathSvg.id = 'fixture-pure-path-svg';
        purePathSvg.setAttribute('width', '120');
        purePathSvg.setAttribute('height', '120');
        purePathSvg.style.width = '120px';
        purePathSvg.style.height = '120px';
        const purePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        purePath.setAttribute('d', 'M0 0 H120 V120 H0 Z');
        purePath.setAttribute('fill', '#654321');
        purePathSvg.appendChild(purePath);
        document.body.appendChild(purePathSvg);

        if (!customElements.get('wzm-fixture-card')) {
            customElements.define('wzm-fixture-card', class extends HTMLElement {
                constructor() {
                    super();
                    const shadow = this.attachShadow({ mode: 'open' });
                    const image = document.createElement('img');
                    image.id = 'shadow-image';
                    image.alt = 'shadow fixture';
                    image.src = imageUrl('shadow.png');
                    image.style.width = '120px';
                    image.style.height = '120px';
                    shadow.appendChild(image);
                }
            });
        }
        const customHost = document.createElement('wzm-fixture-card');
        document.body.appendChild(customHost);
        const shadowImage = customHost.shadowRoot.getElementById('shadow-image');

        const syndigoHost = document.createElement('syndigo-powerpage');
        syndigoHost.id = 'wzm-syndigo-host';
        syndigoHost.style.display = 'block';
        syndigoHost.style.width = '120px';
        syndigoHost.style.height = '120px';
        let syndigoReleasedWithBackgroundCover = false;
        let syndigoBackground = null;
        const syndigoReleaseObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (mutation.attributeName === SHADOW_HOST_PENDING_ATTRIBUTE &&
                    !syndigoHost.hasAttribute(SHADOW_HOST_PENDING_ATTRIBUTE)) {
                    syndigoReleasedWithBackgroundCover = !!(syndigoBackground &&
                        syndigoBackground.getAttribute('data-wzm-pattern-bg-img') === '1');
                }
            }
        });
        syndigoReleaseObserver.observe(syndigoHost, { attributes: true });
        document.body.appendChild(syndigoHost);
        await waitFor(
            () => syndigoHost.getAttribute(SHADOW_HOST_PENDING_ATTRIBUTE) === '1' &&
                getComputedStyle(syndigoHost).opacity === '0',
            'A Syndigo shadow host was not concealed before its shadow root attached'
        );
        const genericCustomHost = document.createElement('wzm-generic-shadow-host');
        genericCustomHost.textContent = 'generic custom element';
        document.body.appendChild(genericCustomHost);
        await delay(20);
        assert(
            !genericCustomHost.hasAttribute(SHADOW_HOST_PENDING_ATTRIBUTE) &&
                getComputedStyle(genericCustomHost).opacity !== '0',
            'The early shadow host gate concealed a generic custom element'
        );
        genericCustomHost.remove();
        const syndigoShadow = syndigoHost.attachShadow({ mode: 'open' });
        const syndigoImage = document.createElement('img');
        syndigoImage.id = 'syndigo-shadow-image';
        syndigoImage.src = imageUrl('syndigo-shadow.png');
        syndigoImage.style.width = '120px';
        syndigoImage.style.height = '120px';
        syndigoShadow.appendChild(syndigoImage);
        for (let index = 0; index < 240; index++)
            syndigoShadow.appendChild(document.createElement('span'));
        syndigoBackground = document.createElement('div');
        syndigoBackground.id = 'syndigo-shadow-background';
        syndigoBackground.style.width = '120px';
        syndigoBackground.style.height = '120px';
        syndigoBackground.style.backgroundImage = 'url("' + imageUrl('syndigo-background.png') + '")';
        syndigoShadow.appendChild(syndigoBackground);

        const lateGeneric = document.createElement('section');
        lateGeneric.id = 'late-generic';
        lateGeneric.textContent = 'late background fixture';
        document.body.appendChild(lateGeneric);
        await delay(20);
        const lateStyle = document.createElement('style');
        lateStyle.id = 'late-generic-style';
        lateStyle.textContent = '.wzm-late-generic { width: 120px; height: 120px; background-image: url("' + imageUrl('late-class.png') + '"); }';
        document.head.appendChild(lateStyle);
        lateGeneric.className = 'wzm-late-generic';

        const ancestorStyle = document.createElement('style');
        ancestorStyle.id = 'ancestor-descendant-style';
        ancestorStyle.textContent = '.wzm-ancestor-active .wzm-ancestor-descendant { width: 120px; height: 120px; background-image: url("' + imageUrl('ancestor-descendant.png') + '"); }';
        document.head.appendChild(ancestorStyle);
        const ancestor = document.createElement('div');
        const ancestorDescendant = document.createElement('span');
        ancestorDescendant.className = 'wzm-ancestor-descendant';
        ancestorDescendant.textContent = 'ancestor descendant fixture';
        ancestor.appendChild(ancestorDescendant);
        document.body.appendChild(ancestor);
        await delay(80);
        assert(!isBlocked(ancestorDescendant), 'Ancestor descendant unexpectedly started with media');
        ancestor.className = 'wzm-ancestor-active';

        const resizeStyle = document.createElement('style');
        resizeStyle.id = 'resize-descendant-style';
        document.head.appendChild(resizeStyle);
        const resizeAncestor = document.createElement('div');
        resizeAncestor.className = 'wzm-resize-ancestor';
        const resizeDescendant = document.createElement('span');
        resizeDescendant.className = 'wzm-resize-descendant';
        resizeDescendant.textContent = 'resize descendant fixture';
        resizeAncestor.appendChild(resizeDescendant);
        document.body.appendChild(resizeAncestor);
        await delay(80);
        assert(!isBlocked(resizeDescendant), 'Resize descendant unexpectedly started with media');
        resizeStyle.sheet.insertRule('@media (min-width: 1px) { .wzm-resize-ancestor .wzm-resize-descendant { width: 120px; height: 120px; background-image: url("' + imageUrl('resize-descendant.png') + '"); } }');
        window.dispatchEvent(new Event('resize'));

        const hoverStyle = document.createElement('style');
        hoverStyle.id = 'hover-descendant-style';
        hoverStyle.textContent = '.wzm-hover-active .wzm-hover-descendant { width: 120px; height: 120px; background-image: url("' + imageUrl('hover-descendant.png') + '"); }';
        document.head.appendChild(hoverStyle);
        const hoverAncestor = document.createElement('div');
        const hoverDescendant = document.createElement('span');
        hoverDescendant.className = 'wzm-hover-descendant';
        hoverDescendant.textContent = 'hover descendant fixture';
        hoverAncestor.appendChild(hoverDescendant);
        hoverAncestor.addEventListener('mouseover', () => hoverAncestor.classList.add('wzm-hover-active'));
        document.body.appendChild(hoverAncestor);
        await delay(80);
        assert(!isBlocked(hoverDescendant), 'Hover descendant unexpectedly started with media');
        hoverDescendant.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));

        const textDataTarget = document.createElement('span');
        textDataTarget.className = 'wzm-style-text-data';
        textDataTarget.textContent = 'style text-node data fixture';
        document.body.appendChild(textDataTarget);
        const textDataStyle = document.createElement('style');
        textDataStyle.appendChild(document.createTextNode('.wzm-style-text-data { width: 120px; height: 120px; }'));
        document.head.appendChild(textDataStyle);
        await delay(80);
        assert(!isBlocked(textDataTarget), 'Style text-node target unexpectedly started with media');
        textDataStyle.firstChild.data = '.wzm-style-text-data { width: 120px; height: 120px; background-image: url("' + imageUrl('style-text-data.png') + '"); }';

        const layoutGrowthStyle = document.createElement('style');
        layoutGrowthStyle.textContent = '.wzm-layout-growth { display: inline-block; min-width: 24px; width: auto; height: 24px; line-height: 24px; white-space: nowrap; font: 16px monospace; background-image: url("' + imageUrl('layout-growth.png') + '"); }';
        document.head.appendChild(layoutGrowthStyle);
        const textGrowthHost = document.createElement('span');
        textGrowthHost.className = 'wzm-layout-growth';
        const growthTextNode = document.createTextNode('x');
        textGrowthHost.appendChild(growthTextNode);
        const childGrowthHost = document.createElement('span');
        childGrowthHost.className = 'wzm-layout-growth';
        childGrowthHost.textContent = 'x';
        document.body.append(textGrowthHost, childGrowthHost);
        await delay(100);
        assert(!isBlocked(textGrowthHost), 'The text-growth host started above the filtering threshold');
        assert(!isBlocked(childGrowthHost), 'The child-growth host started above the filtering threshold');
        growthTextNode.data = 'text data now makes this background host wider than the filtering threshold';
        const growthChild = document.createElement('strong');
        growthChild.textContent = ' child insertion also makes this host wider than the filtering threshold';
        childGrowthHost.appendChild(growthChild);

        const selectorStyle = document.createElement('style');
        selectorStyle.textContent = '#wzm-selector-active[data-state="active"] { width: 120px; height: 120px; background-image: url("' + imageUrl('selector-state.png') + '"); }';
        document.head.appendChild(selectorStyle);
        const selectorTarget = document.createElement('div');
        selectorTarget.id = 'wzm-selector-inactive';
        selectorTarget.dataset.state = 'inactive';
        document.body.appendChild(selectorTarget);
        await delay(80);
        assert(!isBlocked(selectorTarget), 'The id/data-state selector fixture unexpectedly started with media');
        selectorTarget.id = 'wzm-selector-active';
        selectorTarget.dataset.state = 'active';

        const unreadableSelectorStyle = document.createElement('style');
        unreadableSelectorStyle.textContent = '[data-open="1"] .wzm-unreadable-selector-media { width:120px; height:120px; background-image:url("' + imageUrl('unreadable-selector.png') + '"); }';
        document.head.appendChild(unreadableSelectorStyle);
        const unreadableSelectorAncestor = document.createElement('div');
        const unreadableSelectorMedia = document.createElement('div');
        unreadableSelectorMedia.className = 'wzm-unreadable-selector-media';
        unreadableSelectorAncestor.appendChild(unreadableSelectorMedia);
        document.body.appendChild(unreadableSelectorAncestor);
        await waitFor(() => !controller.hasScanWork(), 'The unreadable-selector baseline scan did not settle');
        assert(!isBlocked(unreadableSelectorMedia), 'The unreadable-selector fixture unexpectedly started with media');
        // Simulate a selector hidden behind a cross-origin stylesheet: its
        // attribute name cannot be learned through cssRules.
        controller.selectorAttributeNames.delete('data-open');
        unreadableSelectorAncestor.setAttribute('data-open', '1');

        const checkedStyle = document.createElement('style');
        checkedStyle.textContent = '.wzm-checked-state input:checked ~ .wzm-checked-media { width:120px; height:120px; background-image:url("' + imageUrl('checked-state.png') + '"); }';
        document.head.appendChild(checkedStyle);
        const checkedContainer = document.createElement('div');
        checkedContainer.className = 'wzm-checked-state';
        const checkedInput = document.createElement('input');
        checkedInput.type = 'checkbox';
        const checkedMedia = document.createElement('div');
        checkedMedia.className = 'wzm-checked-media';
        checkedContainer.append(checkedInput, checkedMedia);
        document.body.appendChild(checkedContainer);
        await delay(80);
        assert(!isBlocked(checkedMedia), 'The :checked fixture unexpectedly started with media');
        checkedInput.click();

        const pseudoStyle = document.createElement('style');
        pseudoStyle.textContent = '.wzm-pseudo-fixture { display: block; width: 120px; height: 120px; } .wzm-pseudo-fixture::before { content: url("' + imageUrl('pseudo-before.png') + '"); } .wzm-pseudo-fixture::after { content: "Site after text"; }';
        document.head.appendChild(pseudoStyle);
        const pseudoTarget = document.createElement('div');
        pseudoTarget.className = 'wzm-pseudo-fixture';
        document.body.appendChild(pseudoTarget);

        const originalAdoptedSheets = Array.from(document.adoptedStyleSheets || []);
        let adoptedSheet = null;
        let adoptedTarget = null;
        let largeCssomSheet = null;
        let largeCssomTarget = null;
        if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in document) {
            adoptedSheet = new CSSStyleSheet();
            adoptedSheet.replaceSync('.wzm-adopted-fixture { width: 120px; height: 120px; }');
            document.adoptedStyleSheets = originalAdoptedSheets.concat(adoptedSheet);
            adoptedTarget = document.createElement('div');
            adoptedTarget.className = 'wzm-adopted-fixture';
            document.body.appendChild(adoptedTarget);
            await delay(80);
            assert(!isBlocked(adoptedTarget), 'The adopted stylesheet fixture unexpectedly started with media');
            adoptedSheet.insertRule('.wzm-adopted-fixture { background-image: url("' + imageUrl('adopted-sheet.png') + '"); }');

            largeCssomSheet = new CSSStyleSheet();
            const largeRules = [];
            for (let index = 0; index < 5000; index++) {
                largeRules.push(index === 4500
                    ? '.wzm-large-cssom-target { --wzm-rule-index: 4500; }'
                    : '.wzm-unused-rule-' + index + ' { --wzm-rule-index: ' + index + '; }');
            }
            largeCssomSheet.replaceSync(largeRules.join('\n'));
            document.adoptedStyleSheets = originalAdoptedSheets.concat(adoptedSheet, largeCssomSheet);
            largeCssomTarget = document.createElement('div');
            largeCssomTarget.className = 'wzm-large-cssom-target';
            largeCssomTarget.style.width = '120px';
            largeCssomTarget.style.height = '120px';
            document.body.appendChild(largeCssomTarget);
            try {
                await waitFor(
                    () => {
                        const state = controller.cssSheetStates.get(largeCssomSheet);
                        return state && state.previousCycleHash != null;
                    },
                    'The bounded stylesheet sampler never completed a 5,000-rule baseline',
                    25000
                );
            } catch (error) {
                const state = controller.cssSheetStates.get(largeCssomSheet);
                throw new Error(error.message + ': ' + JSON.stringify({
                    state,
                    pollNumber: controller.stylesheetPollNumber,
                    roots: controller.stylesheetRoots.size
                }));
            }
            assert(!isBlocked(largeCssomTarget), 'The large CSSOM fixture unexpectedly started with media');
            largeCssomSheet.cssRules[4500].style.setProperty(
                'background-image',
                'url("' + imageUrl('large-cssom-tail.png') + '")'
            );
        }

        if (!customElements.get('wzm-late-shadow-card')) {
            customElements.define('wzm-late-shadow-card', class extends HTMLElement {
                connectedCallback() {
                    if (this._scheduled)
                        return;
                    this._scheduled = true;
                    setTimeout(() => {
                        if (!this.isConnected || this.shadowRoot)
                            return;
                        const shadow = this.attachShadow({ mode: 'open' });
                        const image = document.createElement('img');
                        image.id = 'late-shadow-image';
                        image.src = imageUrl('late-shadow.png');
                        image.style.width = '120px';
                        image.style.height = '120px';
                        shadow.appendChild(image);
                    }, 3200);
                }
            });
        }
        const lateShadowHost = document.createElement('wzm-late-shadow-card');
        document.body.appendChild(lateShadowHost);

        const lateBuiltInShadowHost = document.createElement('div');
        document.body.appendChild(lateBuiltInShadowHost);
        setTimeout(() => {
            if (!lateBuiltInShadowHost.isConnected || lateBuiltInShadowHost.shadowRoot)
                return;
            const shadow = lateBuiltInShadowHost.attachShadow({ mode: 'open' });
            const image = document.createElement('img');
            image.id = 'late-built-in-shadow-image';
            image.src = imageUrl('late-built-in-shadow.png');
            image.style.width = '120px';
            image.style.height = '120px';
            shadow.appendChild(image);
        }, 3200);

        const extensionlessImageObject = document.createElement('object');
        extensionlessImageObject.data = new URL('/object-image', location.href).href;
        extensionlessImageObject.style.width = '120px';
        extensionlessImageObject.style.height = '120px';
        const extensionlessHtmlObject = document.createElement('object');
        extensionlessHtmlObject.data = new URL('/object-html', location.href).href;
        extensionlessHtmlObject.style.width = '120px';
        extensionlessHtmlObject.style.height = '120px';
        const crossOriginHtmlObject = document.createElement('object');
        const crossOriginUrl = new URL('/object-html', location.href);
        crossOriginUrl.hostname = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        let crossOriginHtmlLoaded = false;
        crossOriginHtmlObject.addEventListener('load', () => { crossOriginHtmlLoaded = true; }, { once: true });
        crossOriginHtmlObject.data = crossOriginUrl.href;
        crossOriginHtmlObject.style.width = '120px';
        crossOriginHtmlObject.style.height = '120px';
        document.body.append(extensionlessImageObject, extensionlessHtmlObject, crossOriginHtmlObject);

        await waitFor(() => isBlocked(document.body), 'The body background was not discovered');
        await waitFor(() => dynamicImage.getAttribute('data-wzm-locked') === '1', 'A dynamically added img was not discovered');
        await waitFor(
            () => isBlocked(cssOnlyImage) &&
                recordsFor(controller, cssOnlyImage, 'background').some(record => record.key.includes('css-only-background.png')) &&
                recordsFor(controller, cssOnlyImage, 'background').some(record => record.key.includes('css-only-content.png')),
            () => 'A CSS background/content image on a replaced img was not discovered: ' + JSON.stringify({
                blocked: isBlocked(cssOnlyImage),
                computedBackground: getComputedStyle(cssOnlyImage).backgroundImage,
                computedContent: getComputedStyle(cssOnlyImage).content,
                opacity: getComputedStyle(cssOnlyImage).opacity,
                pending: cssOnlyImage.getAttribute('data-wzm-media-pending'),
                controllerActive: controller.active,
                inspectedMedia: {
                    hasEntry: controller.inspectedMediaUrls.has(cssOnlyImage),
                    url: controller.inspectedMediaUrls.get(cssOnlyImage)
                },
                scanWork: controller.hasScanWork(),
                pendingScanWork: controller.hasPendingScanWork(),
                scanScheduled: controller.scanScheduled,
                idleHandlePresent: controller.idleHandle != null,
                idleHandleKind: controller.idleHandleKind,
                pendingElements: {
                    count: controller.pendingElements.size,
                    includesFixture: controller.pendingElements.has(cssOnlyImage),
                    first: Array.from(controller.pendingElements).slice(0, 8).map(element => ({
                        tag: element && element.tagName,
                        id: element && element.id
                    }))
                },
                scanJobs: {
                    count: controller.scanJobs.length,
                    roots: controller.scanJobs.slice(0, 8).map(job => ({
                        tag: job.root && job.root.tagName,
                        id: job.root && job.root.id,
                        isDocument: job.root === document,
                        isDocumentElement: job.root === document.documentElement,
                        containsFixture: !!(job.root && job.root.contains && job.root.contains(cssOnlyImage)),
                        includeRoot: job.includeRoot,
                        included: job.included
                    }))
                },
                deferredScanScopes: controller.deferredScanScopes.size,
                deferredAffectedTrees: controller.deferredAffectedTreeRoots.size,
                deferredUnknownAttributes: controller.deferredUnknownAttributeRoots.size,
                dynamicSubtreeRoots: controller.dynamicSubtreeRoots.size,
                timers: {
                    affectedTree: controller.affectedTreeThrottleTimeout != null,
                    unknownAttribute: controller.unknownAttributeFallbackTimeout != null,
                    dynamicSubtree: controller.dynamicSubtreeTimeout != null,
                    resourceScan: controller.resourceScanTimeout != null,
                    resizeScan: controller.resizeScanTimeout != null,
                    hoverScan: controller.hoverScanTimeout != null
                },
                loadErrors: window.__wzmLoadErrors,
                lastScanError: controller.lastScanError && String(controller.lastScanError.stack || controller.lastScanError),
                allRecords: Array.from(controller.recordsByElement.get(cssOnlyImage) || []).map(entry => ({
                    kind: entry[0],
                    key: entry[1].key,
                    status: entry[1].status,
                    blocked: entry[1].blocked
                })),
                records: recordsFor(controller, cssOnlyImage, 'background').map(record => ({
                    key: record.key,
                    status: record.status,
                    blocked: record.blocked
                }))
            }),
            8000
        );
        await waitFor(() => inputImage.getAttribute('data-wzm-locked') === '1', 'input[type=image] was not discovered');
        await waitFor(() => canvas.getAttribute('data-wzm-locked') === '1', 'Canvas media was not discovered');
        await waitFor(
            () => svg.getAttribute('data-wzm-locked') === '1' && svgImage.getAttribute('data-wzm-hide') === '1',
            'Inline SVG and its image element were not discovered'
        );
        await waitFor(
            () => purePathSvg.getAttribute('data-wzm-locked') === '1',
            'A large pure-path inline SVG was not discovered'
        );
        await waitFor(
            () => shadowImage.getAttribute('data-wzm-locked') === '1' &&
                !!customHost.shadowRoot.querySelector('[data-wzm-shadow-style="1"]'),
            'An image in an open custom-element shadow root was not discovered'
        );
        await waitFor(
            () => !!syndigoShadow.querySelector('[data-wzm-shadow-style="1"]') &&
                (syndigoImage.getAttribute('data-wzm-media-pending') === '1' ||
                    syndigoImage.getAttribute('data-wzm-locked') === '1'),
            'The Syndigo shadow image was not gated before the host became eligible to show',
            7000
        );
        await waitFor(
            () => syndigoImage.getAttribute('data-wzm-locked') === '1' &&
                syndigoBackground.getAttribute('data-wzm-pattern-bg-img') === '1' &&
                !syndigoHost.hasAttribute(SHADOW_HOST_PENDING_ATTRIBUTE),
            'The Syndigo host was not released after its shadow image was filtered',
            7000
        );
        assert(
            syndigoReleasedWithBackgroundCover,
            'The Syndigo host was released before its shadow background placeholder was covered'
        );
        syndigoReleaseObserver.disconnect();
        mark('Syndigo shadow host is concealed until its shadow media gate is ready');

        const opaqueHost = document.createElement('div');
        const opaqueRealShadow = opaqueHost.attachShadow({ mode: 'closed' });
        const makeOpaqueShadowFacade = () => ({
            querySelectorAll: opaqueRealShadow.querySelectorAll.bind(opaqueRealShadow),
            prepend: opaqueRealShadow.prepend.bind(opaqueRealShadow)
        });
        const opaqueFacadeA = makeOpaqueShadowFacade();
        const opaqueFacadeB = makeOpaqueShadowFacade();
        const shadowLinkCountBeforeOpaqueTest = controller.shadowStyleLinks.size;
        const opaqueTrackedLink = controller.ensureShadowStyle(opaqueFacadeA, opaqueHost);
        const opaqueEnsureFromSecondFacade = controller.ensureShadowStyle(opaqueFacadeB, opaqueHost);
        const opaqueEnsureResult = controller.ensureShadowStyle(opaqueFacadeA, opaqueHost);
        assert(
            opaqueTrackedLink && opaqueEnsureFromSecondFacade === opaqueTrackedLink &&
                opaqueEnsureResult === opaqueTrackedLink &&
                opaqueRealShadow.querySelectorAll('link[data-wzm-shadow-style="1"]').length === 1 &&
                controller.shadowStyleLinks.size === shadowLinkCountBeforeOpaqueTest + 1,
            'An opaque closed-root identity mismatch replaced a valid shadow stylesheet'
        );
        opaqueTrackedLink.remove();
        controller.shadowStyleLinks.delete(opaqueTrackedLink);
        controller.shadowStyleByRoot.delete(opaqueHost);
        controller.shadowStyleRepairByRoot.delete(opaqueHost);
        mark('opaque closed-root stylesheet membership does not trigger reinjection');

        const reconcilingHost = document.createElement('div');
        const reconcilingShadow = reconcilingHost.attachShadow({ mode: 'open' });
        document.body.appendChild(reconcilingHost);
        controller.observeRoot(reconcilingShadow);
        const defaultShadowStyleRetryCooldown = controller.shadowStyleRetryCooldownMs;
        controller.shadowStyleRetryCooldownMs = 150;
        const reconciliationObserverCount = Array.from(controller.observerRoots.values())
            .filter(root => root === reconcilingShadow).length;
        const reconciliationSeed = controller.ensureShadowStyle(reconcilingShadow);
        const reconciliationRemovedLinks = [reconciliationSeed];
        let reconciliationRemovals = 0;
        let reconciliationHeartbeat = false;
        const pageReconciler = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes || []) {
                    if (reconciliationRemovals >= 12 ||
                        !node.matches || !node.matches('link[data-wzm-shadow-style="1"]'))
                        continue;
                    reconciliationRemovals++;
                    reconciliationRemovedLinks.push(node);
                    node.remove();
                }
            }
        });
        pageReconciler.observe(reconcilingShadow, { childList: true });
        setTimeout(() => { reconciliationHeartbeat = true; }, 0);
        reconciliationSeed.remove();
        await waitFor(
            () => reconciliationRemovals >= 3 &&
                !reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]'),
            'The hostile shadow reconciler did not exhaust the bounded insertion budget',
            500
        );
        pageReconciler.disconnect();
        await waitFor(
            () => reconciliationHeartbeat &&
                !!reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]'),
            'The shadow stylesheet did not recover after the hostile reconciler stopped',
            1000
        );
        const reconciliationRecoveredLink = reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]');
        assert(
            reconciliationHeartbeat && reconciliationRemovals > 0 && reconciliationRemovals <= 4 &&
                controller.ensureShadowStyle(reconcilingShadow) === reconciliationRecoveredLink &&
                Array.from(controller.observerRoots.values())
                    .filter(root => root === reconcilingShadow).length === reconciliationObserverCount &&
                reconciliationRemovedLinks.every(link => !controller.shadowStyleLinks.has(link)),
            'A page that removes the shadow stylesheet caused unbounded reinjection'
        );

        document.head.appendChild(reconciliationRecoveredLink);
        await waitFor(
            () => {
                const replacement = reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]');
                return replacement && replacement !== reconciliationRecoveredLink;
            },
            'Moving the owned shadow stylesheet did not repair the original shadow root'
        );
        assert(
            document.head.querySelectorAll('link[data-wzm-shadow-style="1"]').length === 1 &&
                document.head.querySelector('link[data-wzm-shadow-style="1"]') === reconciliationRecoveredLink,
            'Moving a shadow stylesheet caused document head to be reconciled as a shadow root'
        );
        const malformedShadowLink = reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]');
        malformedShadowLink.type = 'text/plain';
        await waitFor(
            () => {
                const replacement = reconcilingShadow.querySelector('link[data-wzm-shadow-style="1"]');
                return replacement && replacement !== malformedShadowLink && !replacement.type;
            },
            'A disabled shadow stylesheet was not replaced within the repair budget'
        );
        assert(
            !malformedShadowLink.isConnected && !controller.shadowStyleLinks.has(malformedShadowLink),
            'Repair retained the malformed shadow stylesheet'
        );
        reconciliationRecoveredLink.remove();
        await waitFor(
            () => !controller.shadowStyleLinks.has(reconciliationRecoveredLink),
            'A moved shadow stylesheet remained retained after ordinary-DOM removal'
        );
        controller.shadowStyleRetryCooldownMs = defaultShadowStyleRetryCooldown;
        reconcilingHost.remove();
        await waitFor(
            () => !Array.from(controller.observerRoots.values()).includes(reconcilingShadow),
            'The hostile shadow reconciliation fixture retained its observer'
        );
        mark('shadow stylesheet reinjection is bounded and recovers after cooldown');

        await waitFor(() => isBlocked(lateGeneric), 'A late generic CSS class background was not discovered');
        await waitFor(
            () => isBlocked(ancestorDescendant),
            'An ancestor class change did not discover a descendant background'
        );
        await waitFor(
            () => isBlocked(resizeDescendant),
            'A resize did not discover a previously unrecorded descendant background'
        );
        await waitFor(
            () => isBlocked(hoverDescendant),
            'A hover-driven style change did not discover a descendant background'
        );
        await waitFor(
            () => isBlocked(textDataTarget),
            'Changing a STYLE text node through CharacterData.data did not trigger a rescan'
        );
        await waitFor(
            () => isBlocked(textGrowthHost) && isBlocked(childGrowthHost),
            'Text-data or child insertion did not re-evaluate a CSS-background host that grew past the threshold'
        );
        await waitFor(() => isBlocked(selectorTarget), 'An id/data-state selector mutation did not trigger media discovery');
        await waitFor(
            () => isBlocked(unreadableSelectorMedia),
            'An unknown ancestor selector attribute did not receive its bounded fallback subtree scan'
        );
        await waitFor(() => isBlocked(checkedMedia), 'A property-only :checked state change did not trigger media discovery');
        await waitFor(
            () => pseudoTarget.getAttribute('data-wzm-suppress-before-content') === '1' &&
                !pseudoTarget.hasAttribute('data-wzm-pattern-bg-img') &&
                getComputedStyle(pseudoTarget, '::after').content.includes('Site after text'),
            'A pseudo-element image was not blocked or unrelated ::after text was suppressed'
        );
        if (adoptedTarget) {
            await waitFor(() => isBlocked(adoptedTarget), 'A CSSOM rule in an adopted stylesheet was not discovered');
        }
        if (largeCssomTarget) {
            await waitFor(
                () => isBlocked(largeCssomTarget),
                'A same-count CSSOM replacement past rule 4,096 was not discovered',
                7000
            );
        }
        await waitFor(
            () => lateShadowHost.shadowRoot &&
                lateShadowHost.shadowRoot.getElementById('late-shadow-image').getAttribute('data-wzm-locked') === '1',
            'A custom element shadow root attached after three seconds was not discovered',
            7000
        );
        await waitFor(
            () => lateBuiltInShadowHost.shadowRoot &&
                lateBuiltInShadowHost.shadowRoot.getElementById('late-built-in-shadow-image').getAttribute('data-wzm-locked') === '1',
            'A built-in host shadow root attached after three seconds was not discovered',
            9000
        );
        await waitFor(
            () => extensionlessImageObject.getAttribute('data-wzm-locked') === '1',
            'An extensionless image object was not blocked',
            7000
        );
        await waitFor(
            () => extensionlessHtmlObject.contentDocument &&
                extensionlessHtmlObject.contentDocument.contentType === 'text/html' &&
                hasNoVisualAttributes(extensionlessHtmlObject),
            'An extensionless HTML object was hidden or stopped functioning',
            7000
        );
        await waitFor(() => crossOriginHtmlLoaded, 'The cross-origin extensionless HTML object did not load', 7000);
        await waitFor(
            () => !controller.pendingElements.has(crossOriginHtmlObject),
            'The cross-origin extensionless HTML object was not evaluated',
            7000
        );
        await delay(500);
        assert(
            hasNoVisualAttributes(crossOriginHtmlObject) &&
                !recordsFor(controller, crossOriginHtmlObject, 'object').some(record => record.blocked),
            'A cross-origin extensionless HTML object was misclassified as an image'
        );
        mark('CSSOM, selector, pseudo, late-shadow, and extensionless object surfaces behave correctly');
        mark('layout-only text and child growth re-evaluates background hosts');
        mark('all supported media surfaces are discovered');

        const purePathRecord = recordFor(controller, purePathSvg, 'svg');
        assert(purePathRecord, 'The pure-path SVG has no media record');
        const stableSvgKey = purePathRecord.key;
        controller.queueElement(purePathSvg);
        await waitFor(
            () => !controller.pendingElements.has(purePathSvg),
            'The stable SVG rescan did not complete'
        );
        assert(purePathRecord.key === stableSvgKey, 'Wizmage visual attributes changed the SVG analysis key');
        controller.showRecord(purePathRecord, true, false);
        assert(!isBlocked(purePathSvg), 'A user-initiated SVG reveal did not remove the visual block');
        controller.queueElement(purePathSvg);
        await waitFor(
            () => !controller.pendingElements.has(purePathSvg),
            'The revealed SVG rescan did not complete'
        );
        assert(
            !isBlocked(purePathSvg) && purePathRecord.key === stableSvgKey && purePathRecord.userAllowedKey === stableSvgKey,
            'A stable SVG rescan discarded the user reveal decision'
        );
        controller.rehideRecord(purePathRecord);
        await waitFor(() => isBlocked(purePathSvg), 'A revealed SVG could not be hidden again');
        mark('SVG keys and user reveal decisions remain stable across rescans');

        const recordsBeforeRemoval = controller.records.size;
        dynamicImage.remove();
        await waitFor(
            () => !Array.from(controller.records).some(record => record.element === dynamicImage),
            'A removed image remained strongly retained by the controller'
        );
        assert(controller.records.size < recordsBeforeRemoval, 'Removing an image did not reduce the record set');
        mark('removed nodes are pruned');

        document.body.appendChild(dynamicImage);
        await waitFor(
            () => dynamicImage.getAttribute('data-wzm-locked') === '1' &&
                Array.from(controller.records).some(record => record.element === dynamicImage),
            'A detached and reinserted image was not restored to the live record set'
        );
        mark('detached and reinserted nodes are tracked again');

        const detachedHost = document.createElement('wzm-fixture-card');
        document.body.appendChild(detachedHost);
        const detachedShadow = detachedHost.shadowRoot;
        const detachedShadowImage = detachedShadow.getElementById('shadow-image');
        await waitFor(
            () => detachedShadowImage.getAttribute('data-wzm-locked') === '1' &&
                !!detachedShadow.querySelector('link[data-wzm-shadow-style="1"]'),
            'Detached-shadow cleanup fixture was not discovered'
        );
        const detachedShadowLink = detachedShadow.querySelector('link[data-wzm-shadow-style="1"]');
        detachedHost.remove();
        await waitFor(
            () => !Array.from(controller.observerRoots.values()).includes(detachedShadow) &&
                !controller.shadowStyleLinks.has(detachedShadowLink) &&
                !detachedShadow.querySelector('link[data-wzm-shadow-style="1"]') &&
                !controller.scanJobs.some(job => job.root === detachedShadow) &&
                !Array.from(controller.records).some(record => record.element === detachedShadowImage),
            'A detached shadow root retained its observer, job, stylesheet, or media record'
        );
        mark('detached shadow-root resources are pruned');

        const destroyVictim = document.createElement('img');
        destroyVictim.src = imageUrl('destroy-pending.png');
        destroyVictim.style.width = '120px';
        destroyVictim.style.height = '120px';
        document.body.appendChild(destroyVictim);
        await waitFor(() => destroyVictim.getAttribute('data-wzm-locked') === '1', 'Destroy fixture was not discovered');
        destroyVictim.remove();
        await waitFor(() => controller.pruneTimeout != null, 'Removal did not schedule a prune timeout', 45);

        const queuedTree = document.createElement('div');
        for (let index = 0; index < 250; index++)
            queuedTree.appendChild(document.createElement('span'));
        document.body.appendChild(queuedTree);
        controller.queueTree(queuedTree, true);
        assert(controller.hasScanWork(), 'The cleanup test did not create pending scan work');

        const connectedShadowLink = customHost.shadowRoot.querySelector('link[data-wzm-shadow-style="1"]');
        assert(connectedShadowLink, 'The connected shadow root lost its injected stylesheet before teardown');
        controller.destroy({ show: true });
        assert(
            document.documentElement.classList.contains('wizmage-show-html'),
            'Destroying with show=true did not fail open'
        );
        assert(
            !document.documentElement.classList.contains('wizmage-media-starting'),
            'Destroying left the initial media gate active'
        );
        assert(
            !syndigoHost.hasAttribute(SHADOW_HOST_PENDING_ATTRIBUTE),
            'Destroy retained the Syndigo shadow-host pending marker'
        );
        assert(!controller.active && !controller.started, 'Destroy left the controller active');
        assert(controller.records.size === 0, 'Destroy retained media records');
        assert(controller.pendingElements.size === 0 && controller.scanJobs.length === 0, 'Destroy retained pending scan work');
        assert(controller.observers.size === 0 && controller.listeners.length === 0, 'Destroy retained observers or listeners');
        assert(controller.timeouts.size === 0 && controller.idleHandle == null && !controller.scanScheduled, 'Destroy retained scheduled work');
        assert(controller.pruneTimeout == null, 'Destroy retained the prune timeout handle');
        assert(controller.eye == null, 'Destroy retained the overlay control');
        assert(
            !connectedShadowLink.isConnected && !customHost.shadowRoot.querySelector('link[data-wzm-shadow-style="1"]'),
            'Destroy retained a shadow-root stylesheet link'
        );
        assert(!reconciliationRecoveredLink.isConnected, 'Destroy retained a shadow stylesheet moved into document head');
        assert(
            rootStyle.getPropertyValue('--wzm-pattern-0') === 'url("site-owned-pattern.png")' &&
                rootStyle.getPropertyPriority('--wzm-pattern-0') === 'important',
            'Destroy did not restore the page-owned root pattern variable'
        );
        assert(!rootStyle.getPropertyValue('--wzm-pattern-1'), 'Destroy retained an extension-owned root pattern variable');
        assert(hasNoVisualAttributes(singleImage), 'Destroy left an image visually locked');
        assert(hasNoVisualAttributes(dynamicImage), 'Destroy left a reinserted image visually locked');
        assert(hasNoVisualAttributes(dynamicBackground), 'Destroy left a CSS image visually locked');
        mark('destroy clears records, observers, listeners, and scheduled work');

        document.body.removeEventListener('click', bubbleListener);
        document.body.removeEventListener('click', videoBubbleListener);
        document.body.removeAttribute('style');
        lateStyle.remove();
        ancestorStyle.remove();
        resizeStyle.remove();
        hoverStyle.remove();
        textDataStyle.remove();
        layoutGrowthStyle.remove();
        selectorStyle.remove();
        unreadableSelectorStyle.remove();
        checkedStyle.remove();
        pseudoStyle.remove();
        if (adoptedSheet)
            document.adoptedStyleSheets = originalAdoptedSheets;
        rootStyle.removeProperty('--wzm-pattern-0');
        document.body.replaceChildren(resultNode);
    }

    async function runSyntheticImageDocumentCheck() {
        const Controller = globalThis.WizmageContentController;
        const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'contentType');
        const image = document.createElement('img');
        image.alt = 'synthetic raw image document fixture';
        image.src = imageUrl('raw-image-document.png');
        image.style.width = '120px';
        image.style.height = '120px';
        document.body.appendChild(image);
        let controller = null;
        try {
            Object.defineProperty(document, 'contentType', {
                configurable: true,
                value: 'image/png'
            });
            controller = new Controller(
                window,
                makeSettings('all'),
                makeEnvironment(function (_url, callback) { callback(1); })
            );
            controller.start();
            await waitFor(
                () => image.getAttribute('data-wzm-locked') === '1',
                'An image/* document bypassed filtering'
            );
            mark('image documents remain filterable');
        } finally {
            if (controller)
                controller.destroy({ show: true });
            if (ownDescriptor)
                Object.defineProperty(document, 'contentType', ownDescriptor);
            else
                delete document.contentType;
            image.remove();
            document.body.replaceChildren(resultNode);
        }
    }

    async function runThresholdSettingsCheck() {
        const Controller = globalThis.WizmageContentController;
        const analyzer = makePendingAnalyzer();
        const image = document.createElement('img');
        image.alt = 'compiler diagram threshold fixture';
        image.src = imageUrl('threshold-settings.png');
        image.style.width = '120px';
        image.style.height = '120px';
        document.body.appendChild(image);
        const initialSettings = makeSettings('people');
        initialSettings.maxSafe = 200;
        const controller = new Controller(window, initialSettings, makeEnvironment(analyzer.analyze));
        controller.start();
        await waitFor(() => !controller.hasScanWork(), 'The threshold fixture did not finish its initial scan');
        assert(!analyzer.has('threshold-settings.png'), 'An image under maxSafe was unexpectedly analyzed');
        assert(!recordFor(controller, image, 'img'), 'An image under maxSafe unexpectedly retained a record');
        assert(!image.hasAttribute('data-wzm-media-pending'), 'A safe image retained its transient media gate');

        controller.updateSettings(Object.assign({}, controller.settings, { maxSafe: 32 }));
        await waitFor(
            () => analyzer.has('threshold-settings.png') && isBlocked(image),
            'Lowering maxSafe did not discover an image that had previously been skipped'
        );
        assert(analyzer.deliver('threshold-settings.png', 1) === 1, 'The threshold callback was unavailable');
        await waitFor(() => image.getAttribute('data-wzm-shade') === '5', 'The newly eligible image decision was not applied');
        mark('lowering maxSafe rescans previously skipped images');

        controller.destroy({ show: true });
        image.remove();
        document.body.replaceChildren(resultNode);
    }

    async function runShowCurrentImagesCheck() {
        const Controller = globalThis.WizmageContentController;
        const currentImage = document.createElement('img');
        currentImage.alt = 'current image reveal fixture';
        currentImage.src = imageUrl('show-current-existing.png');
        currentImage.style.width = '120px';
        currentImage.style.height = '120px';
        document.body.appendChild(currentImage);

        const controller = new Controller(
            window,
            makeSettings('all'),
            makeEnvironment(function (_url, callback) { callback(1); })
        );
        controller.start();
        await waitFor(() => isBlocked(currentImage), 'The current-image fixture was not initially blocked');
        const observerCount = controller.observers.size;
        assert(controller.showCurrentImages(), 'Show Images did not acknowledge the active controller');
        const currentRecord = recordFor(controller, currentImage, 'img');
        assert(
            controller.active && controller.observers.size === observerCount && !isBlocked(currentImage) &&
                currentRecord && currentRecord.userAllowedKey === currentRecord.key,
            'Show Images did not reveal the current image while preserving its observer'
        );

        const lazyImage = document.createElement('img');
        lazyImage.alt = 'lazy image after reveal fixture';
        lazyImage.src = imageUrl('show-current-lazy.png');
        lazyImage.style.width = '120px';
        lazyImage.style.height = '120px';
        document.body.appendChild(lazyImage);
        await waitFor(
            () => isBlocked(lazyImage) && !!recordFor(controller, lazyImage, 'img'),
            'An image inserted after Show Images was not filtered'
        );
        assert(!isBlocked(currentImage), 'Filtering a later image reblocked the user-revealed current image');
        mark('Show Images reveals current media while later lazy media remains filtered');

        controller.destroy({ show: true });
        currentImage.remove();
        lazyImage.remove();
        document.body.replaceChildren(resultNode);
    }

    async function runAllowSafeDomainToggleCheck() {
        const Controller = globalThis.WizmageContentController;
        const analyzer = makePendingAnalyzer();
        const safeImage = document.createElement('img');
        safeImage.alt = 'safe compiler diagram fixture';
        safeImage.src = imageUrl('allow-safe-domain-safe.png');
        safeImage.style.width = '120px';
        safeImage.style.height = '120px';
        const unsafeImage = document.createElement('img');
        unsafeImage.alt = 'unsafe compiler diagram fixture';
        unsafeImage.src = imageUrl('allow-safe-domain-unsafe.png');
        unsafeImage.style.width = '120px';
        unsafeImage.style.height = '120px';
        const safeBackground = document.createElement('div');
        safeBackground.style.width = '120px';
        safeBackground.style.height = '120px';
        safeBackground.style.backgroundImage = 'url("' + imageUrl('allow-safe-domain-background.png') + '")';
        const revealedSafeImage = document.createElement('img');
        revealedSafeImage.alt = 'revealed safe compiler diagram fixture';
        revealedSafeImage.src = imageUrl('allow-safe-domain-revealed-safe.png');
        revealedSafeImage.style.width = '120px';
        revealedSafeImage.style.height = '120px';
        document.body.append(safeImage, unsafeImage, safeBackground, revealedSafeImage);

        const settings = makeSettings('people');
        settings.alwaysBlock = true;
        settings.allowSafeDomain = false;
        const controller = new Controller(window, settings, makeEnvironment(analyzer.analyze));
        controller.start();
        await waitFor(
            () => analyzer.has('allow-safe-domain-safe.png') && analyzer.has('allow-safe-domain-unsafe.png') &&
                analyzer.has('allow-safe-domain-background.png') &&
                analyzer.has('allow-safe-domain-revealed-safe.png'),
            'The safe-domain fixtures were not analyzed'
        );
        assert(analyzer.deliver('allow-safe-domain-safe.png', 0) === 1, 'The cached-safe fixture callback was unavailable');
        assert(analyzer.deliver('allow-safe-domain-unsafe.png', 1) === 1, 'The unsafe fixture callback was unavailable');
        assert(analyzer.deliver('allow-safe-domain-background.png', 0) === 1, 'The cached-safe background callback was unavailable');
        assert(
            analyzer.deliver('allow-safe-domain-revealed-safe.png', 0) === 1,
            'The revealed cached-safe fixture callback was unavailable'
        );
        await waitFor(
            () => safeImage.getAttribute('data-wzm-always') === '1' &&
                unsafeImage.getAttribute('data-wzm-locked') === '1' &&
                safeBackground.getAttribute('data-wzm-always') === '1' &&
                revealedSafeImage.getAttribute('data-wzm-always') === '1',
            'Always Block did not conceal both safe and unsafe fixtures'
        );
        await waitFor(
            () => !document.documentElement.classList.contains('wizmage-media-starting'),
            'The initial safe-domain fixture gate did not finish before its presentation toggle'
        );
        const revealedSafeRecord = recordFor(controller, revealedSafeImage, 'img');
        assert(revealedSafeRecord, 'The revealed cached-safe fixture retained no media record');
        controller.showRecord(revealedSafeRecord, true, false);
        assert(
            revealedSafeRecord.userAllowedKey === revealedSafeRecord.key &&
                !revealedSafeImage.hasAttribute('data-wzm-locked'),
            'The cached-safe fixture could not enter the user-revealed state'
        );
        const analysisCount = analyzer.requests.length;

        controller.setAllowSafeDomain(true);
        assert(
            !document.documentElement.classList.contains('wizmage-media-starting') &&
                !safeImage.hasAttribute('data-wzm-locked') &&
                !safeBackground.hasAttribute('data-wzm-pattern-bg-img') &&
                !revealedSafeImage.hasAttribute('data-wzm-locked') &&
                unsafeImage.getAttribute('data-wzm-locked') === '1',
            'The cached-safe exception was not applied synchronously without a global gate'
        );
        await waitFor(
            () => !safeImage.hasAttribute('data-wzm-locked') &&
                !safeImage.hasAttribute('data-wzm-pattern-bg-img') &&
                !safeImage.hasAttribute('data-wzm-media-pending') &&
                !safeBackground.hasAttribute('data-wzm-pattern-bg-img') &&
                !revealedSafeImage.hasAttribute('data-wzm-locked') &&
                unsafeImage.getAttribute('data-wzm-locked') === '1',
            'Excluding the website from Safe Block did not immediately show only cached-safe media'
        );
        assert(analyzer.requests.length === analysisCount, 'Enabling the safe-domain exception reanalyzed settled media');
        assert(
            !document.documentElement.classList.contains('wizmage-media-starting'),
            'The cached-safe presentation toggle started a document-wide media gate'
        );

        controller.setAllowSafeDomain(false);
        assert(
            !document.documentElement.classList.contains('wizmage-media-starting') &&
                safeImage.getAttribute('data-wzm-always') === '1' &&
                safeBackground.getAttribute('data-wzm-always') === '1' &&
                revealedSafeImage.getAttribute('data-wzm-always') === '1',
            'Removing the cached-safe exception was not applied synchronously without a global gate'
        );
        await waitFor(
            () => safeImage.getAttribute('data-wzm-always') === '1' &&
                safeImage.getAttribute('data-wzm-locked') === '1' &&
                safeBackground.getAttribute('data-wzm-always') === '1' &&
                revealedSafeImage.getAttribute('data-wzm-always') === '1' &&
                revealedSafeImage.getAttribute('data-wzm-locked') === '1' &&
                unsafeImage.getAttribute('data-wzm-locked') === '1',
            'Removing the safe-domain exception did not immediately reblock cached-safe media'
        );
        assert(analyzer.requests.length === analysisCount, 'Disabling the safe-domain exception reanalyzed settled media');
        mark('safe-domain toggle immediately shows and reblocks cached-safe media');

        controller.destroy({ show: true });
        safeImage.remove();
        unsafeImage.remove();
        safeBackground.remove();
        revealedSafeImage.remove();
        document.body.replaceChildren(resultNode);
    }

    async function runAnalysisCancellationCheck() {
        const Controller = globalThis.WizmageContentController;
        const analyzer = makePendingAnalyzer({ cancelable: true });
        const grid = document.createElement('section');
        const staleTiles = [];
        for (let index = 0; index < 240; index++) {
            const image = document.createElement('img');
            image.src = imageUrl('recycled-stale-' + index + '.png');
            image.style.width = '96px';
            image.style.height = '96px';
            grid.appendChild(image);
            staleTiles.push(image);
        }
        document.body.appendChild(grid);
        const controller = new Controller(window, makeSettings('people'), makeEnvironment(analyzer.analyze));
        controller.start();
        await waitFor(
            () => analyzer.matching('recycled-stale-', true).length === staleTiles.length,
            'The recycled-tile fixture did not queue every initial analysis',
            8000
        );

        grid.remove();
        await waitFor(
            () => analyzer.matching('recycled-stale-', false).every(request => request.canceled)
                && !Array.from(controller.records).some(record => staleTiles.includes(record.element)),
            'Removing recycled tiles did not cancel their pending analyses',
            4000
        );
        assert(
            analyzer.matching('recycled-stale-', false).every(request => request.callback == null),
            'Canceled tile analyses retained element callback closures'
        );

        const currentGrid = document.createElement('section');
        const currentTiles = [];
        for (let index = 0; index < 20; index++) {
            const image = document.createElement('img');
            image.src = imageUrl('recycled-current-' + index + '.png');
            image.style.width = '96px';
            image.style.height = '96px';
            currentGrid.appendChild(image);
            currentTiles.push(image);
        }
        document.body.appendChild(currentGrid);
        await waitFor(
            () => analyzer.matching('recycled-current-', true).length === currentTiles.length,
            'Current tiles were not analyzed after stale work was canceled'
        );
        assert(
            analyzer.deliver('recycled-current-', 1) === currentTiles.length,
            'Current tile callbacks were unavailable after recycling'
        );
        await waitFor(
            () => currentTiles.every(image => image.getAttribute('data-wzm-shade') === '5'),
            'Current recycled tiles did not apply their decisions'
        );
        mark('removed SPA tiles cancel stale analyses and release current work');

        controller.destroy({ show: true });
        currentGrid.remove();
        document.body.replaceChildren(resultNode);
    }

    async function runAsyncGenerationChecks() {
        const Controller = globalThis.WizmageContentController;
        const analyzer = makePendingAnalyzer();
        const image = document.createElement('img');
        image.id = 'stale-image';
        image.alt = 'stale callback fixture';
        image.src = imageUrl('stale-a.png');
        image.style.width = '120px';
        image.style.height = '120px';
        document.body.appendChild(image);

        const controller = new Controller(window, makeSettings('people'), makeEnvironment(analyzer.analyze));
        controller.start();
        await waitFor(() => analyzer.has('stale-a.png'), 'The first asynchronous image was not analyzed');
        await waitFor(() => isBlocked(image), 'The first asynchronous image was not held while checking');

        image.src = imageUrl('stale-b.png');
        await waitFor(
            () => image.currentSrc.includes('stale-b.png') && analyzer.has('stale-b.png'),
            'Changing img.src did not reprocess the image'
        );
        const currentRecord = recordFor(controller, image, 'img');
        const secondKey = currentRecord.key;
        assert(analyzer.deliver('stale-a.png', 0) > 0, 'No stale callback was available for the first image');
        await delay(60);
        assert(isBlocked(image), 'A stale safe callback revealed the newer image');
        assert(currentRecord.key === secondKey, 'A stale callback changed the active image key');
        assert(analyzer.deliver('stale-b.png', 1) > 0, 'No callback was available for the newer image');
        await waitFor(() => image.getAttribute('data-wzm-shade') === '5', 'The current unsafe callback was not applied');
        mark('stale AI callbacks cannot reveal newer images');

        const identicalSettingsImage = document.createElement('img');
        identicalSettingsImage.alt = 'identical settings callback fixture';
        identicalSettingsImage.src = imageUrl('identical-settings.png');
        identicalSettingsImage.style.width = '120px';
        identicalSettingsImage.style.height = '120px';
        document.body.appendChild(identicalSettingsImage);
        await waitFor(
            () => analyzer.matching('identical-settings.png', true).length >= 1,
            'The identical-settings fixture was not analyzed'
        );
        const identicalSettingsRecord = recordFor(controller, identicalSettingsImage, 'img');
        const identicalSettingsRequest = analyzer.matching('identical-settings.png', true).slice(-1)[0];
        const identicalPendingRequestCount = analyzer.matching('identical-settings.png', false).length;
        for (let index = 0; index < 8; index++)
            controller.queueElement(identicalSettingsImage);
        await delay(120);
        assert(
            analyzer.matching('identical-settings.png', false).length === identicalPendingRequestCount,
            'Repeated rescans duplicated an identical pending image analysis'
        );
        const revisionBeforeIdenticalUpdate = controller.settingsRevision;
        const generationBeforeIdenticalUpdate = identicalSettingsRecord.generation;
        controller.updateSettings(Object.assign({}, controller.settings));
        assert(
            controller.settingsRevision === revisionBeforeIdenticalUpdate &&
                identicalSettingsRecord.generation === generationBeforeIdenticalUpdate,
            'An identical settings refresh invalidated a pending image decision'
        );
        assert(
            analyzer.deliverRequest(identicalSettingsRequest, 1),
            'The identical-settings callback was no longer pending'
        );
        await waitFor(
            () => identicalSettingsImage.getAttribute('data-wzm-shade') === '5',
            'A callback arriving after an identical settings refresh was ignored'
        );
        const identicalSettledRequestCount = analyzer.matching('identical-settings.png', false).length;
        const identicalSettledGeneration = identicalSettingsRecord.generation;
        for (let index = 0; index < 8; index++)
            controller.queueElement(identicalSettingsImage);
        await delay(160);
        assert(
            analyzer.matching('identical-settings.png', false).length === identicalSettledRequestCount
                && identicalSettingsRecord.generation === identicalSettledGeneration
                && identicalSettingsImage.getAttribute('data-wzm-shade') === '5'
                && !identicalSettingsImage.hasAttribute('data-wzm-checking'),
            'A settled unsafe image was reanalyzed or returned to checking during rescans'
        );
        const classifierRevisionBeforeThresholdChange = controller.settingsRevision;
        controller.updateSettings(Object.assign({}, controller.settings, { maxSafe: 31 }));
        await waitFor(() => !controller.hasScanWork(), 'The threshold presentation update did not settle');
        assert(
            controller.settingsRevision === classifierRevisionBeforeThresholdChange
                && analyzer.matching('identical-settings.png', false).length === identicalSettledRequestCount
                && identicalSettingsImage.getAttribute('data-wzm-shade') === '5',
            'A threshold-only settings change discarded a settled classifier decision'
        );
        controller.updateSettings(Object.assign({}, controller.settings, { maxSafe: 32 }));
        mark('identical settings refreshes preserve pending analysis callbacks');
        mark('pending and settled decisions survive equivalent and presentation-only settings changes');

        const errorImage = document.createElement('img');
        errorImage.alt = 'analysis error backoff fixture';
        errorImage.src = imageUrl('analysis-error.png');
        errorImage.style.width = '120px';
        errorImage.style.height = '120px';
        document.body.appendChild(errorImage);
        await waitFor(
            () => analyzer.matching('analysis-error.png', true).length === 1,
            'The analysis-error fixture was not analyzed exactly once'
        );
        assert(analyzer.deliver('analysis-error.png', -1) === 1, 'The analysis-error callback was unavailable');
        await waitFor(
            () => errorImage.getAttribute('data-wzm-shade') === '1' && !errorImage.hasAttribute('data-wzm-checking'),
            'An analysis error did not settle into the unchecked blocked state'
        );
        const errorRecord = recordFor(controller, errorImage, 'img');
        const errorRequestCount = analyzer.matching('analysis-error.png', false).length;
        const errorGeneration = errorRecord.generation;
        for (let index = 0; index < 8; index++)
            controller.queueElement(errorImage);
        await delay(160);
        assert(
            analyzer.matching('analysis-error.png', false).length === errorRequestCount
                && errorRecord.generation === errorGeneration
                && errorImage.getAttribute('data-wzm-shade') === '1'
                && !errorImage.hasAttribute('data-wzm-checking'),
            'An analysis error retried immediately or returned to checking during rescans'
        );
        errorRecord.retryAfter = Date.now() - 1;
        controller.runMaintenance();
        await waitFor(
            () => analyzer.matching('analysis-error.png', false).length > errorRequestCount,
            'An expired analysis backoff was not retried by maintenance'
        );
        assert(analyzer.deliver('analysis-error.png', 1) > 0, 'The maintenance retry callback was unavailable');
        await waitFor(() => errorImage.getAttribute('data-wzm-shade') === '5', 'The maintenance retry result was not applied');
        mark('analysis errors remain blocked and retry after bounded backoff');

        const serverImage = document.createElement('img');
        serverImage.alt = 'server URL generation fixture';
        serverImage.src = imageUrl('server-revision.png');
        serverImage.style.width = '120px';
        serverImage.style.height = '120px';
        document.body.appendChild(serverImage);
        await waitFor(
            () => analyzer.matching('server-revision.png', true).length >= 1,
            'The server URL fixture was not analyzed'
        );
        const serverRequestsBeforeChange = analyzer.matching('server-revision.png', false);
        const staleServerRequest = serverRequestsBeforeChange.slice(-1)[0];
        const revisionBeforeServerChange = controller.settingsRevision;
        controller.updateSettings(Object.assign({}, controller.settings, {
            serverUrl: 'wss://fixture.invalid/changed-server'
        }));
        await waitFor(
            () => controller.settingsRevision > revisionBeforeServerChange &&
                analyzer.matching('server-revision.png', false).length > serverRequestsBeforeChange.length,
            'Changing serverUrl did not invalidate and reanalyze the current image'
        );
        const currentServerRequest = analyzer.matching('server-revision.png', false)
            .slice(serverRequestsBeforeChange.length)
            .filter(request => !request.delivered)
            .slice(-1)[0];
        assert(analyzer.deliverRequest(staleServerRequest, 0), 'The stale server callback was unavailable');
        await delay(60);
        assert(isBlocked(serverImage), 'A callback from the old server revision revealed the image');
        assert(analyzer.deliverRequest(currentServerRequest, 1), 'The current server callback was unavailable');
        await waitFor(
            () => serverImage.getAttribute('data-wzm-shade') === '5',
            'The reanalysis result from the changed server was not applied'
        );
        mark('server URL changes invalidate stale callbacks and reanalyze');

        const unknownRootsBeforeMediaChurn = new Set(controller.deferredUnknownAttributeRoots);
        const unknownTimeoutBeforeMediaChurn = controller.unknownAttributeFallbackTimeout;
        let heartbeatLast = performance.now();
        let heartbeatMaxGap = 0;
        const heartbeat = window.setInterval(() => {
            const now = performance.now();
            heartbeatMaxGap = Math.max(heartbeatMaxGap, now - heartbeatLast);
            heartbeatLast = now;
        }, 25);
        const originalInspectElement = controller.inspectElement.bind(controller);
        let stressInspectionCount = 0;
        controller.inspectElement = function (element) {
            stressInspectionCount++;
            return originalInspectElement(element);
        };
        const stressGrid = document.createElement('section');
        stressGrid.id = 'google-images-stress-grid';
        const stressTiles = [];
        const stressTileCount = 160;
        document.body.appendChild(stressGrid);
        for (let batch = 0; batch < 8; batch++) {
            const fragment = document.createDocumentFragment();
            for (let offset = 0; offset < stressTileCount / 8; offset++) {
                const index = batch * (stressTileCount / 8) + offset;
                const lowUrl = imageUrl('google-stress-' + index + '-low.png');
                const highUrl = imageUrl('google-stress-' + index + '-high.png');
                const tile = document.createElement('img');
                tile.alt = 'compiler architecture result ' + index;
                tile.src = lowUrl;
                tile.srcset = lowUrl + ' 1x, ' + highUrl + ' 2x';
                tile.sizes = '96px';
                tile.style.width = '96px';
                tile.style.height = '96px';
                fragment.appendChild(tile);
                stressTiles.push({ tile, lowUrl, highUrl });
            }
            stressGrid.appendChild(fragment);
            await delay(0);
        }
        const stressRequests = () => analyzer.requests.filter(request => request.url.includes('google-stress-'));
        await waitFor(
            () => stressTiles.every(entry => entry.tile.currentSrc && recordFor(controller, entry.tile, 'img'))
                && stressRequests().length >= stressTileCount,
            'The Google Images-style result grid did not finish initial discovery',
            8000
        );
        assert(
            stressRequests().length === stressTileCount,
            'Initial discovery analyzed a Google Images-style tile more than once'
        );
        const selectedStressUrls = stressTiles.map(entry => entry.tile.currentSrc);
        const stressGenerations = stressTiles.map(entry => recordFor(controller, entry.tile, 'img').generation);
        const requestCountBeforeMediaChurn = stressRequests().length;
        for (let round = 0; round < 8; round++) {
            for (let index = 0; index < stressTiles.length; index++) {
                const entry = stressTiles[index];
                const replacement = imageUrl('google-stress-' + index + '-unused-' + round + '.png');
                entry.tile.srcset = selectedStressUrls[index] === entry.highUrl
                    ? replacement + ' 1x, ' + entry.highUrl + ' 2x'
                    : entry.lowUrl + ' 1x, ' + replacement + ' 2x';
                entry.tile.sizes = (96 + round) + 'px';
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        await delay(300);
        assert(
            stressTiles.every((entry, index) => entry.tile.currentSrc === selectedStressUrls[index]),
            'A non-selected responsive candidate unexpectedly replaced the selected image'
        );
        assert(
            stressRequests().length === requestCountBeforeMediaChurn,
            'Non-selected srcset/sizes churn created redundant image analyses'
        );
        assert(
            stressTiles.every((entry, index) =>
                recordFor(controller, entry.tile, 'img').generation === stressGenerations[index]
            ),
            'Stable selected images changed analysis generation during responsive candidate churn'
        );
        const newUnknownMediaRoots = Array.from(controller.deferredUnknownAttributeRoots)
            .filter(root => !unknownRootsBeforeMediaChurn.has(root));
        assert(
            newUnknownMediaRoots.length === 0
                && controller.unknownAttributeFallbackTimeout === unknownTimeoutBeforeMediaChurn,
            'Media-only mutations retained a delayed unknown-attribute subtree scan: ' + JSON.stringify({
                timeoutChanged: controller.unknownAttributeFallbackTimeout !== unknownTimeoutBeforeMediaChurn,
                roots: newUnknownMediaRoots.map(root => ({
                    tag: root.tagName,
                    id: root.id,
                    src: root.getAttribute && root.getAttribute('src'),
                    srcset: root.getAttribute && root.getAttribute('srcset'),
                    sizes: root.getAttribute && root.getAttribute('sizes')
                }))
            })
        );
        await waitFor(
            () => !controller.hasPendingScanWork(),
            'Google Images-style media churn did not reach scan quiescence',
            5000
        );
        const settledInspectionCount = stressInspectionCount;
        await delay(1100);
        window.clearInterval(heartbeat);
        assert(
            stressRequests().length === requestCountBeforeMediaChurn,
            'Google Images-style media churn resumed analysis during the maintenance interval'
        );
        assert(
            !controller.hasPendingScanWork() && stressInspectionCount === settledInspectionCount,
            'Google Images-style media churn resumed scanning after reaching quiescence'
        );
        assert(heartbeatMaxGap < 750, 'Google Images-style media churn starved the page heartbeat');
        controller.inspectElement = originalInspectElement;
        assert(analyzer.deliver('google-stress-', 1) === stressTileCount, 'Stress-grid callbacks were unavailable');
        await waitFor(
            () => stressTiles[0].tile.getAttribute('data-wzm-shade') === '5'
                && stressTiles[stressTiles.length - 1].tile.getAttribute('data-wzm-shade') === '5',
            'Google Images-style result decisions were not applied'
        );
        stressGrid.remove();
        mark('Google Images-style responsive churn stays bounded and quiescent');

        const pictureSelectorStyle = document.createElement('style');
        pictureSelectorStyle.textContent = [
            '.wzm-source-selector { display:block; width:120px; height:120px; }',
            '.wzm-source-selector:has(source[media="(min-width: 1px)"]) { background-image:url("' + imageUrl('source-selector-a.png') + '"); }',
            '.wzm-source-selector:has(source[media="(max-width: 0px)"]) { background-image:url("' + imageUrl('source-selector-b.png') + '"); }'
        ].join(' ');
        document.head.appendChild(pictureSelectorStyle);
        const picture = document.createElement('picture');
        picture.className = 'wzm-source-selector';
        const source = document.createElement('source');
        source.media = '(min-width: 1px)';
        source.srcset = imageUrl('picture-c.png') + ' 1x';
        const pictureImage = document.createElement('img');
        pictureImage.alt = 'picture source fixture';
        pictureImage.src = imageUrl('picture-fallback.png');
        pictureImage.style.width = '120px';
        pictureImage.style.height = '120px';
        picture.append(source, pictureImage);
        document.body.appendChild(picture);
        await waitFor(
            () => pictureImage.currentSrc.includes('picture-c.png') && analyzer.has('picture-c.png')
                && analyzer.has('source-selector-a.png') && controller.selectorAttributeNames.has('media'),
            'The initial picture source and selector-dependent background were not analyzed'
        );
        assert(analyzer.deliver('source-selector-a.png', 0) > 0, 'The initial source-selector callback was unavailable');
        await waitFor(() => !isBlocked(picture), 'The safe source-selector background did not settle');
        const pictureRecord = recordFor(controller, pictureImage, 'img');
        const pictureKey = pictureRecord.key;
        source.srcset = imageUrl('picture-d.png') + ' 1x';
        await waitFor(
            () => pictureRecord.key !== pictureKey &&
                pictureRecord.key.includes('picture-d.png') &&
                analyzer.has('picture-d.png'),
            'Changing a picture source attribute did not reprocess its img'
        );
        assert(analyzer.deliver('picture-c.png', 0) > 0, 'No stale picture callback was available');
        await delay(60);
        assert(isBlocked(pictureImage), 'A stale picture source callback revealed the replacement');
        assert(analyzer.deliver('picture-d.png', 1) > 0, 'No current picture callback was available');
        await waitFor(() => pictureImage.getAttribute('data-wzm-shade') === '5', 'Current picture source result was not applied');
        source.media = '(max-width: 0px)';
        await waitFor(
            () => analyzer.has('source-selector-b.png')
                && recordsFor(controller, picture, 'background').some(record => record.key.includes('source-selector-b.png')),
            () => 'A learned source[media] selector change did not rescan its picture scope: ' + JSON.stringify({
                media: source.media,
                computedBackground: getComputedStyle(picture).backgroundImage,
                selectorKnown: controller.selectorAttributeNames.has('media'),
                pendingScan: controller.hasPendingScanWork(),
                requests: analyzer.requests.filter(request => request.url.includes('source-selector-')).map(request => request.url),
                records: recordsFor(controller, picture, 'background').map(record => record.key)
            })
        );
        mark('selected picture sources and selector-dependent media changes reprocess');
        pictureSelectorStyle.remove();

        const surfaceStyle = document.createElement('style');
        surfaceStyle.textContent = [
            '.wzm-surface-a,.wzm-surface-b,.wzm-surface-c { display:block; width:120px; height:120px; }',
            '.wzm-surface-a { background-image:url("' + imageUrl('surface-safe-self.png') + '"); }',
            '.wzm-surface-a::before { content:url("' + imageUrl('surface-unsafe-before.png') + '"); }',
            '.wzm-surface-b { background-image:url("' + imageUrl('surface-unsafe-self.png') + '"); }',
            '.wzm-surface-b::before { content:url("' + imageUrl('surface-safe-before.png') + '"); }',
            '.wzm-surface-c::before { content:""; display:block; width:120px; height:120px; background-image:url("' + imageUrl('surface-safe-before-background.png') + '"); border:4px solid; border-image-source:url("' + imageUrl('surface-unsafe-before-border.png') + '"); border-image-slice:1; }'
        ].join(' ');
        document.head.appendChild(surfaceStyle);
        const surfaceA = document.createElement('div');
        surfaceA.className = 'wzm-surface-a';
        const surfaceB = document.createElement('div');
        surfaceB.className = 'wzm-surface-b';
        const surfaceC = document.createElement('div');
        surfaceC.className = 'wzm-surface-c';
        document.body.append(surfaceA, surfaceB, surfaceC);
        await waitFor(
            () => analyzer.has('surface-safe-self.png') && analyzer.has('surface-unsafe-before.png') &&
                analyzer.has('surface-unsafe-self.png') && analyzer.has('surface-safe-before.png') &&
                analyzer.has('surface-safe-before-background.png') && analyzer.has('surface-unsafe-before-border.png'),
            'Independent CSS surfaces were not analyzed separately'
        );
        assert(analyzer.deliver('surface-safe-self.png', 0) > 0, 'The safe self surface callback was unavailable');
        assert(analyzer.deliver('surface-unsafe-before.png', 1) > 0, 'The unsafe before surface callback was unavailable');
        assert(analyzer.deliver('surface-unsafe-self.png', 1) > 0, 'The unsafe self surface callback was unavailable');
        assert(analyzer.deliver('surface-safe-before.png', 0) > 0, 'The safe before surface callback was unavailable');
        assert(analyzer.deliver('surface-safe-before-background.png', 0) > 0, 'The safe before background callback was unavailable');
        assert(analyzer.deliver('surface-unsafe-before-border.png', 1) > 0, 'The unsafe before border callback was unavailable');
        await waitFor(
            () => getComputedStyle(surfaceA).backgroundImage.includes('surface-safe-self.png') &&
                surfaceA.getAttribute('data-wzm-suppress-before-content') === '1' &&
                !surfaceA.hasAttribute('data-wzm-pattern-bg-img'),
            'An unsafe pseudo image suppressed the safe host background'
        );
        await waitFor(
            () => surfaceB.hasAttribute('data-wzm-pattern-bg-img') &&
                !surfaceB.hasAttribute('data-wzm-suppress-before-content') &&
                getComputedStyle(surfaceB, '::before').content.includes('surface-safe-before.png'),
            'An unsafe host image suppressed the safe pseudo image'
        );
        await waitFor(
            () => surfaceC.getAttribute('data-wzm-suppress-before-border') === '1' &&
                !surfaceC.hasAttribute('data-wzm-suppress-before-background') &&
                getComputedStyle(surfaceC, '::before').backgroundImage.includes('surface-safe-before-background.png'),
            'An unsafe pseudo border image suppressed a safe pseudo background'
        );
        mark('selective filtering preserves independently safe CSS surfaces');
        surfaceStyle.remove();
        surfaceA.remove();
        surfaceB.remove();
        surfaceC.remove();

        controller.destroy({ show: true });
        assert(controller.records.size === 0 && !controller.hasScanWork(), 'Second controller did not clean up');
    }

    async function run() {
        if (document.readyState === 'loading')
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        assert(globalThis.WizmageShared, 'shared.js did not load');
        assert(
            globalThis.WizmageContentController,
            'content-controller.js did not load' +
                (window.__wzmLoadErrors && window.__wzmLoadErrors.length
                    ? ': ' + window.__wzmLoadErrors.join(' | ')
                    : '')
        );

        window.requestIdleCallback = callback => window.setTimeout(
            () => callback({ didTimeout: true, timeRemaining: () => 50 }),
            0
        );
        window.cancelIdleCallback = handle => window.clearTimeout(handle);

        await runDiscoveryAndCleanupChecks();
        await runSyntheticImageDocumentCheck();
        await runThresholdSettingsCheck();
        await runShowCurrentImagesCheck();
        await runAllowSafeDomainToggleCheck();
        await runAnalysisCancellationCheck();
        await runAsyncGenerationChecks();
        finish('pass');
    }

    run().catch(error => finish('fail', error));
})();
