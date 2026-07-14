import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function makeStorageArea(initial, writes) {
  const data = clone(initial || {});
  let nextSetError = null;
  function select(keys) {
    if (keys == null) {
      return clone(data);
    }
    if (typeof keys === "string") {
      return { [keys]: clone(data[keys]) };
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map(key => [key, clone(data[key])]));
    }
    const result = clone(keys || {});
    for (const key of Object.keys(result)) {
      if (Object.hasOwn(data, key)) {
        result[key] = clone(data[key]);
      }
    }
    return result;
  }
  return {
    data,
    failNextSet(error) {
      nextSetError = error instanceof Error ? error : new Error(String(error || "Storage write failed"));
    },
    get(keys, callback) {
      const result = select(keys);
      if (callback) {
        callback(result);
      }
      return Promise.resolve(result);
    },
    set(items, callback) {
      if (nextSetError) {
        const error = nextSetError;
        nextSetError = null;
        return Promise.reject(error);
      }
      Object.assign(data, clone(items));
      writes.push(clone(items));
      if (callback) {
        callback();
      }
      return Promise.resolve();
    },
  };
}

function makeFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay, ...args) {
      const id = nextId++;
      timers.set(id, { callback, delay: Number(delay) || 0, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    run(id) {
      const timer = timers.get(id);
      if (!timer) {
        return false;
      }
      timers.delete(id);
      timer.callback(...timer.args);
      return true;
    },
  };
}

function loadShared() {
  const context = vm.createContext({ URL, console: { warn() {}, error() {}, log() {} } });
  const source = readFileSync(join(ROOT_DIR, "shared.js"), "utf8");
  vm.runInContext(`${source}\n;globalThis.__wzmSharedTest = globalThis.WizmageShared;`, context, {
    filename: "shared.js",
  });
  return context.__wzmSharedTest;
}

function testMediaStartupGate() {
  const timers = makeFakeTimers();
  const classNames = new Set();
  const context = vm.createContext({
    document: {
      documentElement: {
        classList: {
          contains(value) { return classNames.has(value); },
          toggle(value, active) {
            if (active) classNames.add(value);
            else classNames.delete(value);
          },
        },
      },
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const source = readFileSync(join(ROOT_DIR, "media-startup.js"), "utf8");
  vm.runInContext(source, context, { filename: "media-startup.js" });
  assert(classNames.has("wizmage-media-starting"), "The bootstrap did not activate the media gate.");
  const failOpen = Array.from(timers.timers.entries()).find(([, timer]) => timer.delay === 2000);
  assert(failOpen, "The bootstrap did not schedule its independent fail-open.");
  timers.run(failOpen[0]);
  assert(!classNames.has("wizmage-media-starting"), "The bootstrap fail-open left media concealed.");
  context.WizmageMediaGate.activate();
  assert(classNames.has("wizmage-media-starting"), "A filter restart could not reactivate the media gate.");
  context.WizmageMediaGate.claim();
  assert.equal(timers.timers.size, 0, "An active controller did not claim the bootstrap timer.");
  context.WizmageMediaGate.release();
  assert(!classNames.has("wizmage-media-starting"), "An explicit release left the media gate active.");

  const delayedTimers = makeFakeTimers();
  const delayedClassNames = new Set();
  const delayedDocument = { documentElement: null };
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const delayedContext = vm.createContext({
    document: delayedDocument,
    MutationObserver: FakeMutationObserver,
    setTimeout: delayedTimers.setTimeout,
    clearTimeout: delayedTimers.clearTimeout,
  });
  vm.runInContext(source, delayedContext, { filename: "media-startup-delayed-root.js" });
  assert.equal(observers.length, 1, "A missing document root did not install the bootstrap observer.");
  assert(observers[0].connected, "The missing-root bootstrap observer was not active.");
  const delayedFailOpen = Array.from(delayedTimers.timers.entries()).find(([, timer]) => timer.delay === 2000);
  assert(delayedFailOpen, "The missing-root bootstrap omitted its fail-open timer.");
  delayedTimers.run(delayedFailOpen[0]);
  assert(!observers[0].connected, "The missing-root fail-open retained its observer.");
  delayedDocument.documentElement = {
    classList: {
      contains(value) { return delayedClassNames.has(value); },
      toggle(value, active) {
        if (active) delayedClassNames.add(value);
        else delayedClassNames.delete(value);
      },
    },
  };
  observers[0].callback();
  assert(
    !delayedClassNames.has("wizmage-media-starting"),
    "A stale root observer reactivated the media gate after fail-open.",
  );
}

function createWorkerHarness(shared) {
  const localWrites = [];
  const sessionWrites = [];
  const runtimeMessages = [];
  const tabMessages = [];
  const queriedTabs = [
    { id: 11, url: "https://one.example/" },
    { id: 22, url: "https://two.example/" },
    { id: 33, url: "https://three.example/" },
  ];
  const runtimeMessageEvent = makeEvent();
  const storageChangedEvent = makeEvent();
  const installedEvent = makeEvent();
  const removedEvent = makeEvent();
  const updatedEvent = makeEvent();
  const local = makeStorageArea(
    {
      settings: Object.assign({}, clone(shared.DEFAULT_SETTINGS), { blockTarget: "people" }),
      urlList: [],
      allowSafeDomains: [],
    },
    localWrites,
  );
  const session = makeStorageArea({ pauseForTabs: [], excludeForTabs: [] }, sessionWrites);
  const timers = makeFakeTimers();
  let now = 1_750_000_000_000;

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(message) {
      this.sent.push(message);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const chrome = {
    action: { setIcon() {} },
    runtime: {
      getURL(path) {
        return `chrome-extension://fixture/${path || ""}`;
      },
      lastError: null,
      onInstalled: installedEvent,
      onMessage: runtimeMessageEvent,
      sendMessage(message) {
        runtimeMessages.push(clone(message));
        return Promise.resolve();
      },
    },
    storage: {
      local,
      session,
      onChanged: storageChangedEvent,
    },
    tabs: {
      onRemoved: removedEvent,
      onUpdated: updatedEvent,
      query(_query, callback) {
        const result = clone(queriedTabs);
        if (callback) {
          callback(result);
        }
        return Promise.resolve(result);
      },
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message: clone(message) });
        if (callback) {
          callback();
        }
        return Promise.resolve();
      },
    },
  };

  const context = vm.createContext({
    URL,
    Date: FakeDate,
    Map,
    Promise,
    Set,
    WebSocket: FakeWebSocket,
    WizmageShared: shared,
    chrome,
    clearTimeout: timers.clearTimeout,
    console: { warn() {}, error() {}, log() {} },
    importScripts() {},
    self: { addEventListener() {} },
    setTimeout: timers.setTimeout,
  });
  const source = readFileSync(join(ROOT_DIR, "service_worker.js"), "utf8");
  const exposure = `
;globalThis.__wzmWorkerTest = {
  analyze,
  abortAnalyzeRequests,
  cacheGet,
  cachePut,
  clearAnalyzeCache,
  completeRequest,
  getSettings,
  isRemoteImageCandidate,
  reconcileStorageChange,
  refreshTabForNavigation,
  updateSettings,
  pendingCache,
  tabNavigationUrls,
  tabRefreshSuppressions,
  urlCache,
  constants: {
    CACHE_MAX,
    CACHE_TTL_MS,
    MAX_ANALYSIS_URL_CHARS,
    MAX_NETWORK_URL_CHARS,
    MAX_PENDING_ANALYSES,
    MAX_PENDING_WAITERS,
    MAX_PENDING_URL_CHARS,
    MAX_WAITERS_PER_ANALYSIS,
    REQUEST_TIMEOUT_MS
  },
  getState: () => ({
    pendingWaiterCount,
    pendingUrlCharacters,
    sendQueueLength: sendQueue ? sendQueue.length : 0,
    settings: settings ? Object.assign({}, settings) : null
  }),
  setPendingWaiterCountForTest: value => { pendingWaiterCount = value; },
  setPendingUrlCharactersForTest: value => { pendingUrlCharacters = value; }
};`;
  vm.runInContext(`${source}\n${exposure}`, context, { filename: "service_worker.js" });

  return {
    api: context.__wzmWorkerTest,
    chrome,
    local,
    localWrites,
    queriedTabs,
    runtimeMessageEvent,
    runtimeMessages,
    session,
    sessionWrites,
    tabMessages,
    timers,
    updatedEvent,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function createContentHarness(shared, options = {}) {
  const timers = makeFakeTimers();
  const analysisMessages = [];
  const settingsMessages = [];
  const runtimeListeners = [];
  const controllers = [];
  const pendingSettingsCallbacks = [];
  const classNames = new Set(["wizmage-media-starting"]);
  let throwAnalyzeMessages = false;
  const settings = Object.assign(
    {},
    clone(shared.DEFAULT_SETTINGS),
    { blockTarget: "people" },
    clone(options.settingsOverrides || {}),
  );
  let holdSettings = !!options.holdSettings;

  class FakeController {
    constructor(_window, initialSettings, environment) {
      this.settings = initialSettings;
      this.environment = environment;
      this.active = false;
      controllers.push(this);
    }
    start() {
      this.active = true;
      classNames.add("wizmage-media-starting");
      if (options.throwControllerStart)
        throw new Error("fixture controller startup failure");
    }
    destroy() { this.active = false; }
    updateSettings(next) { this.settings = next; }
    setAllowSafeDomain(toggle) { this.settings.allowSafeDomain = !!toggle; }
  }

  const base = {
    URL,
    WizmageShared: shared,
    WizmageContentController: FakeController,
    WizmageMediaGate: {
      activate() { classNames.add("wizmage-media-starting"); },
      claim() { classNames.add("wizmage-media-starting"); },
      release() { classNames.delete("wizmage-media-starting"); },
    },
    chrome: {
      runtime: {
        lastError: null,
        getURL(path) { return `chrome-extension://fixture/${path || ""}`; },
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        sendMessage(message, callback) {
          if (message.r === "getSettings") {
            settingsMessages.push(clone(message));
            if (holdSettings)
              pendingSettingsCallbacks.push(callback);
            else
              callback(clone(settings));
          } else if (message.r === "getAnalyzeResponse") {
            if (throwAnalyzeMessages) {
              throw new Error("fixture extension context invalidated");
            }
            analysisMessages.push({ message: clone(message), callback });
          } else if (callback) {
            callback({ ok: true });
          }
        },
      },
      storage: {
        local: options.enableStorageFallback ? {
          get(_keys, callback) {
            const value = { settings: clone(settings), urlList: [], allowSafeDomains: [] };
            if (callback) callback(value);
            return Promise.resolve(value);
          },
        } : null,
      },
    },
    clearTimeout: timers.clearTimeout,
    console: { warn() {}, error() {}, log() {} },
    document: {
      documentElement: {
        classList: {
          add(value) { classNames.add(value); },
          remove(value) { classNames.delete(value); },
        },
      },
    },
    location: { href: "https://one.example/start" },
    navigation: { addEventListener() {} },
    addEventListener() {},
    setTimeout: timers.setTimeout,
  };
  const context = vm.createContext(base);
  vm.runInContext("window = globalThis; top = globalThis;", context);
  const source = readFileSync(join(ROOT_DIR, "js.js"), "utf8");
  vm.runInContext(source, context, { filename: "js.js" });

  return {
    analysisMessages,
    classNames,
    controllers,
    pendingSettingsCallbacks,
    runtimeListeners,
    settingsMessages,
    timers,
    respondSettings(nextSettings = settings) {
      const callback = pendingSettingsCallbacks.shift();
      assert(callback, "No delayed settings callback was available.");
      callback(clone(nextSettings));
    },
    setHoldSettings(value) { holdSettings = !!value; },
    setAnalyzeSendFailure(value) { throwAnalyzeMessages = !!value; },
  };
}

async function flushPromises(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function testSharedHelpers(shared) {
  const settings = shared.normalizeSettings({ blockTarget: "invalid", maxSafe: 9001, paused: 1 });
  assert.equal(settings.blockTarget, "all");
  assert.equal(settings.maxSafe, 32);
  assert.equal(settings.paused, true);

  assert(shared.urlMatchesEntry("https://img.example.com/gallery/item", "example.com/gallery"));
  assert(!shared.urlMatchesEntry("https://notexample.com/gallery/item", "example.com/gallery"));
  assert(!shared.urlMatchesEntry("http://example.com/gallery/item", "https://example.com/gallery"));
  assert(shared.urlMatchesEntry("https://media.deep.example.com/image", "*.example.com"));
  assert(shared.urlMatchesEntry("https://media.example.com/path/image", "https://*.example.com/path"));
  assert(!shared.urlMatchesEntry("http://media.example.com/path/image", "https://*.example.com/path"));
  assert(shared.isValidUrlListEntry("https://*.example.com/path"));
  assert(!shared.isValidUrlListEntry("not a valid URL"));
  assert(shared.hostMatches("media.deep.example.com", "example.com"));
  assert(!shared.hostMatches("malicious-example.com", "example.com"));

  const cssUrls = shared.extractCssUrls(
    'linear-gradient(red, blue), url("first.png"), image-set(url(second.webp) 1x, url("first.png") 2x)',
  );
  assert.equal(JSON.stringify(Array.from(cssUrls)), JSON.stringify(["first.png", "second.webp"]));
  assert.equal(shared.resolveUrl("asset.png", "https://example.com/path/page"), "https://example.com/path/asset.png");
  assert.equal(shared.sizeNeedsBlocking(33, 20, 32, false), true);
  assert.equal(shared.sizeNeedsBlocking(20, 20, 32, false), false);
  assert.equal(shared.sizeNeedsBlocking(1, 1, 1000, true), true);
  const size = shared.renderedSize({ getBoundingClientRect: () => ({ width: -50, height: 60 }) });
  assert.equal(size.width, 50);
  assert.equal(size.height, 60);
}

function testAnalyzeBounds(harness) {
  const { api } = harness;
  const { constants } = api;
  assert(api.isRemoteImageCandidate("https://example.com/image.png"));
  assert(!api.isRemoteImageCandidate("ftp://example.com/image.png"));
  assert(!api.isRemoteImageCandidate(`https://example.com/${"x".repeat(constants.MAX_NETWORK_URL_CHARS)}`));
  assert(api.isRemoteImageCandidate(`data:image/png;base64,${"x".repeat(100)}`));
  assert(!api.isRemoteImageCandidate(`data:image/png;base64,${"x".repeat(constants.MAX_ANALYSIS_URL_CHARS)}`));

  for (let index = 0; index < constants.MAX_PENDING_ANALYSES; index += 1) {
    api.pendingCache.set(`fixture-${index}`, { request: null, waiters: [] });
  }
  let overflowResult = null;
  api.analyze("https://example.com/overflow.png", "https://page.example/", "people", "wss://fixture", result => {
    overflowResult = result;
  });
  assert.equal(overflowResult, -2);
  api.pendingCache.clear();

  api.setPendingUrlCharactersForTest(constants.MAX_PENDING_URL_CHARS);
  let characterLimitResult = null;
  api.analyze("https://example.com/chars.png", "https://page.example/", "people", "wss://fixture", result => {
    characterLimitResult = result;
  });
  assert.equal(characterLimitResult, -2);
  api.setPendingUrlCharactersForTest(0);

  api.setPendingWaiterCountForTest(constants.MAX_PENDING_WAITERS);
  let globalWaiterLimitResult = null;
  api.analyze("https://example.com/global-waiter-limit.png", "https://page.example/", "people", "wss://fixture", result => {
    globalWaiterLimitResult = result;
  });
  assert.equal(globalWaiterLimitResult, -2);
  assert(!api.pendingCache.has("https://example.com/global-waiter-limit.png"));
  api.setPendingWaiterCountForTest(0);
}

function testAnalyzeDedupTimeoutAndCache(harness) {
  const { api, advance, timers } = harness;
  const url = "https://example.com/deduplicated.png";
  const menResults = [];
  const womenResults = [];
  api.analyze(url, "https://page.example/", "men", "wss://fixture", value => menResults.push(value));
  api.analyze(url, "https://page.example/", "women", "wss://fixture", value => womenResults.push(value));
  const pending = api.pendingCache.get(url);
  assert(pending, "The first analysis was not retained as pending.");
  assert.equal(pending.waiters.length, 2);
  assert.equal(api.getState().pendingWaiterCount, 2);
  assert.equal(api.getState().sendQueueLength, 1);
  api.completeRequest(pending.request, 3, true);
  assert.equal(JSON.stringify(menResults), "[1]");
  assert.equal(JSON.stringify(womenResults), "[1]");
  assert.equal(api.pendingCache.size, 0);
  assert.equal(api.getState().pendingWaiterCount, 0);

  const cachedResults = [];
  api.analyze(url, "https://page.example/", "people", "wss://fixture", value => cachedResults.push(value));
  assert.equal(JSON.stringify(cachedResults), "[1]");
  assert.equal(api.pendingCache.size, 0);
  advance(api.constants.CACHE_TTL_MS + 1);
  assert.equal(api.cacheGet(url), null);

  const timeoutUrl = "https://example.com/timeout.png";
  const timeoutResults = [];
  api.analyze(timeoutUrl, "https://page.example/", "people", "wss://fixture", value => timeoutResults.push(value));
  const timeoutRequest = api.pendingCache.get(timeoutUrl).request;
  assert.equal(timers.timers.get(timeoutRequest.requestTimer).delay, api.constants.REQUEST_TIMEOUT_MS);
  assert(timers.run(timeoutRequest.requestTimer), "The request timeout timer was not scheduled.");
  assert.equal(JSON.stringify(timeoutResults), "[-1]");
  assert(!api.pendingCache.has(timeoutUrl));
  assert.equal(timeoutRequest.url, null);

  const waiterUrl = "https://example.com/waiters.png";
  const waiterResults = [];
  api.analyze(waiterUrl, "https://page.example/", "people", "wss://fixture", value => waiterResults.push(value));
  for (let index = 1; index < api.constants.MAX_WAITERS_PER_ANALYSIS; index += 1) {
    api.analyze(waiterUrl, "https://page.example/", "people", "wss://fixture", value => waiterResults.push(value));
  }
  let rejectedWaiter = null;
  api.analyze(waiterUrl, "https://page.example/", "people", "wss://fixture", value => {
    rejectedWaiter = value;
  });
  assert.equal(rejectedWaiter, -2);
  assert.equal(api.pendingCache.get(waiterUrl).waiters.length, api.constants.MAX_WAITERS_PER_ANALYSIS);
  api.abortAnalyzeRequests("test-cleanup");
  assert.equal(api.pendingCache.size, 0);
  assert.equal(api.getState().pendingUrlCharacters, 0);
  assert.equal(api.getState().pendingWaiterCount, 0);

  api.clearAnalyzeCache();
  for (let index = 0; index <= api.constants.CACHE_MAX; index += 1) {
    api.cachePut(`cache-${index}`, index % 4);
  }
  assert.equal(api.urlCache.size, api.constants.CACHE_MAX);
  assert(!api.urlCache.has("cache-0"));
}

function testContentBackpressureAndManualRefresh(shared) {
  const delayedHarness = createContentHarness(shared, { holdSettings: true });
  assert(
    delayedHarness.classNames.has("wizmage-media-starting") &&
      !delayedHarness.classNames.has("wizmage-show-html"),
    "Content startup revealed media before settings were available.",
  );
  const settingsFallback = Array.from(delayedHarness.timers.timers.entries())
    .find(([, timer]) => timer.delay === 5000);
  assert(settingsFallback, "Content startup did not schedule its bounded settings fail-open.");
  delayedHarness.timers.run(settingsFallback[0]);
  assert(
    !delayedHarness.classNames.has("wizmage-media-starting") &&
      delayedHarness.classNames.has("wizmage-show-html"),
    "The settings timeout did not release the media prepaint gate.",
  );

  const localFallbackHarness = createContentHarness(shared, {
    holdSettings: true,
    enableStorageFallback: true,
  });
  assert(
    localFallbackHarness.controllers.length === 1 && localFallbackHarness.controllers[0].active,
    "Local settings did not start filtering while the MV3 worker was cold.",
  );
  assert(
    localFallbackHarness.classNames.has("wizmage-media-starting") &&
      localFallbackHarness.classNames.has("wizmage-media-authority-pending") &&
      !localFallbackHarness.classNames.has("wizmage-show-html"),
    "Local settings exposed media before the provisional controller scan.",
  );
  assert(
    Array.from(localFallbackHarness.timers.timers.values()).some(timer => timer.delay === 5000),
    "Provisional local settings canceled the worker-authority deadline.",
  );
  localFallbackHarness.respondSettings(Object.assign({}, clone(shared.DEFAULT_SETTINGS), {
    blockTarget: "people",
    pausedForTab: true,
  }));
  assert(
    !localFallbackHarness.controllers[0].active &&
      !localFallbackHarness.classNames.has("wizmage-media-starting") &&
      !localFallbackHarness.classNames.has("wizmage-media-authority-pending") &&
      localFallbackHarness.classNames.has("wizmage-show-html"),
    "Authoritative paused-tab settings did not replace an active provisional controller.",
  );
  assert(
    !Array.from(localFallbackHarness.timers.timers.values()).some(timer => timer.delay === 5000),
    "Authoritative settings retained the worker-authority deadline.",
  );

  const provisionalTimeoutHarness = createContentHarness(shared, {
    holdSettings: true,
    enableStorageFallback: true,
  });
  const provisionalAuthorityTimeout = Array.from(provisionalTimeoutHarness.timers.timers.entries())
    .find(([, timer]) => timer.delay === 5000);
  assert(provisionalAuthorityTimeout, "A provisional controller had no worker-authority deadline.");
  provisionalTimeoutHarness.timers.run(provisionalAuthorityTimeout[0]);
  assert(
    !provisionalTimeoutHarness.controllers[0].active &&
      !provisionalTimeoutHarness.classNames.has("wizmage-media-starting") &&
      !provisionalTimeoutHarness.classNames.has("wizmage-media-authority-pending") &&
      provisionalTimeoutHarness.classNames.has("wizmage-show-html"),
    "A missing worker left provisional filtering active indefinitely.",
  );

  const blacklistTabHarness = createContentHarness(shared, {
    holdSettings: true,
    enableStorageFallback: true,
    settingsOverrides: { blackList: true },
  });
  assert.equal(
    blacklistTabHarness.controllers.length,
    0,
    "Incomplete local blacklist settings started filtering before tab exclusion was known.",
  );
  assert(
    blacklistTabHarness.classNames.has("wizmage-media-starting") &&
      blacklistTabHarness.classNames.has("wizmage-media-authority-pending") &&
      !blacklistTabHarness.classNames.has("wizmage-show-html"),
    "Incomplete local blacklist settings exposed media before worker reconciliation.",
  );
  blacklistTabHarness.respondSettings(Object.assign({}, clone(shared.DEFAULT_SETTINGS), {
    blockTarget: "people",
    blackList: true,
    excludedForTab: true,
  }));
  assert(
    blacklistTabHarness.controllers.length === 1 && blacklistTabHarness.controllers[0].active,
    "Authoritative per-tab blacklist settings did not start filtering.",
  );
  assert(
    !blacklistTabHarness.classNames.has("wizmage-media-authority-pending"),
    "Authoritative per-tab blacklist settings retained the authority gate.",
  );

  const provisionalRefreshHarness = createContentHarness(shared, {
    holdSettings: true,
    enableStorageFallback: true,
  });
  assert(
    provisionalRefreshHarness.controllers.length === 1 &&
      provisionalRefreshHarness.controllers[0].active,
    "The refresh-race fixture did not start provisionally.",
  );
  provisionalRefreshHarness.runtimeListeners[0]({ r: "refreshSettings" }, {}, () => {});
  const replacementAuthorityTimeout = Array.from(provisionalRefreshHarness.timers.timers.entries())
    .find(([, timer]) => timer.delay === 5000);
  assert(replacementAuthorityTimeout, "Refreshing provisional state lost its replacement authority deadline.");
  provisionalRefreshHarness.timers.run(replacementAuthorityTimeout[0]);
  assert(
    !provisionalRefreshHarness.controllers[0].active &&
      !provisionalRefreshHarness.classNames.has("wizmage-media-authority-pending") &&
      provisionalRefreshHarness.classNames.has("wizmage-show-html"),
    "A refresh preserved provisional settings indefinitely without worker authority.",
  );

  const knownInactiveHarness = createContentHarness(shared, {
    settingsOverrides: { paused: true },
    enableStorageFallback: true,
  });
  assert(
    knownInactiveHarness.classNames.has("wizmage-show-html") &&
      !knownInactiveHarness.classNames.has("wizmage-media-starting"),
    "Initial authoritative paused settings did not reveal media.",
  );
  knownInactiveHarness.setHoldSettings(true);
  let knownInactiveResponse = null;
  knownInactiveHarness.runtimeListeners[0](
    { r: "refreshSettings" },
    {},
    response => { knownInactiveResponse = response; },
  );
  assert(
    knownInactiveHarness.classNames.has("wizmage-show-html") &&
      !knownInactiveHarness.classNames.has("wizmage-media-starting"),
    "Refreshing a known paused page re-gated its media.",
  );
  const knownInactiveDeadline = Array.from(knownInactiveHarness.timers.timers.entries())
    .find(([, timer]) => timer.delay === 5000);
  assert(knownInactiveDeadline, "A known-state refresh had no bounded response deadline.");
  knownInactiveHarness.timers.run(knownInactiveDeadline[0]);
  assert(
    knownInactiveResponse && knownInactiveResponse.ok && knownInactiveResponse.active === false,
    "A stalled known-state refresh did not preserve and report the paused state.",
  );
  assert(
    knownInactiveHarness.classNames.has("wizmage-show-html") &&
      !knownInactiveHarness.classNames.has("wizmage-media-starting"),
    "A stalled known-state refresh changed paused-page visibility.",
  );

  const startupFailureHarness = createContentHarness(shared, {
    holdSettings: true,
    throwControllerStart: true,
  });
  startupFailureHarness.respondSettings();
  assert(
    !startupFailureHarness.classNames.has("wizmage-media-starting") &&
      startupFailureHarness.classNames.has("wizmage-show-html"),
    "An asynchronous controller startup failure stranded the media gate.",
  );
  assert(
    startupFailureHarness.controllers.length === 1 && !startupFailureHarness.controllers[0].active,
    "An asynchronous controller startup failure left a controller active.",
  );
  assert(
    !Array.from(startupFailureHarness.timers.timers.values()).some(timer => timer.delay === 5000),
    "An asynchronous controller startup failure retained its settings timeout.",
  );

  const harness = createContentHarness(shared);
  const firstController = harness.controllers[0];
  assert(firstController && firstController.active, "Content startup did not create an active controller.");
  assert(
    !harness.classNames.has("wizmage-show-html"),
    "Active filtering left the media prepaint gate disabled.",
  );

  const duplicateResults = [];
  const duplicateUrl = "https://images.example/shared-result.png";
  for (let index = 0; index < 100; index += 1) {
    firstController.environment.analyze(duplicateUrl, value => duplicateResults.push(value));
  }
  assert.equal(
    harness.analysisMessages.length,
    1,
    "Identical content analyses were not coalesced before worker IPC.",
  );
  harness.analysisMessages[0].callback(1);
  assert.equal(duplicateResults.length, 100, "A coalesced analysis did not release every waiting candidate.");
  assert(duplicateResults.every(value => value === 1));

  const partiallyCanceledResults = [];
  const partiallyCanceledStart = harness.analysisMessages.length;
  const duplicateCancels = [];
  for (let index = 0; index < 100; index += 1) {
    duplicateCancels.push(firstController.environment.analyze(
      "https://images.example/cancel-shared.png",
      value => partiallyCanceledResults.push(value),
    ));
  }
  assert.equal(
    harness.analysisMessages.length - partiallyCanceledStart,
    1,
    "Cancelable duplicate analyses did not share one worker request.",
  );
  for (const cancel of duplicateCancels.slice(0, 60))
    cancel();
  harness.analysisMessages.at(-1).callback(0);
  assert.equal(partiallyCanceledResults.length, 40, "Canceled analysis waiters still received a result.");

  const results = [];
  const uniqueMessageStart = harness.analysisMessages.length;
  for (let index = 0; index < 300; index += 1) {
    firstController.environment.analyze(`https://images.example/${index}.png`, value => results.push(value));
  }
  assert.equal(
    harness.analysisMessages.length - uniqueMessageStart,
    8,
    "The content scheduler exceeded its active request limit.",
  );
  for (let index = uniqueMessageStart; index < harness.analysisMessages.length; index += 1) {
    harness.analysisMessages[index].callback(0);
  }
  assert.equal(
    harness.analysisMessages.length - uniqueMessageStart,
    300,
    "Queued analyses were not dispatched as capacity returned.",
  );
  assert.equal(results.length, 300);
  assert(results.every(value => value === 0));

  let retriedResult = null;
  firstController.environment.analyze("https://images.example/backpressure.png", value => { retriedResult = value; });
  const firstAttempt = harness.analysisMessages.at(-1);
  firstAttempt.callback(-2);
  const retryTimer = Array.from(harness.timers.timers.entries()).find(([, timer]) => timer.delay === 100);
  assert(retryTimer, "A retryable worker backpressure response did not schedule a retry.");
  harness.timers.run(retryTimer[0]);
  const retryAttempt = harness.analysisMessages.at(-1);
  assert.notEqual(retryAttempt, firstAttempt);
  retryAttempt.callback(0);
  assert.equal(retriedResult, 0);

  const canceledResults = [];
  const activeBeforeShow = harness.analysisMessages.length;
  for (let index = 0; index < 10; index += 1) {
    firstController.environment.analyze(`https://images.example/cancel-${index}.png`, value => canceledResults.push(value));
  }
  const activeMessages = harness.analysisMessages.slice(activeBeforeShow);
  const listener = harness.runtimeListeners[0];
  assert(listener, "The content script did not install its runtime listener.");
  listener({ r: "showImages" }, {}, () => {});
  assert(
    !harness.classNames.has("wizmage-media-starting") && harness.classNames.has("wizmage-show-html"),
    "Show Images did not release the media prepaint gate.",
  );
  assert.equal(canceledResults.length, 10, "Show Images did not immediately release active analysis slots.");
  assert(canceledResults.every(value => value === -1));
  for (const message of activeMessages)
    message.callback(0);
  assert.equal(canceledResults.length, 10, "A late response completed a canceled analysis twice.");

  let refreshResponse = null;
  listener(
    { r: "refreshSettings", pageUrl: "https://one.example/after-history" },
    {},
    response => { refreshResponse = response; },
  );
  assert(refreshResponse && refreshResponse.ok && refreshResponse.active);
  assert(
    harness.classNames.has("wizmage-media-starting") && !harness.classNames.has("wizmage-show-html"),
    "Restarting filtering did not restore the media prepaint gate.",
  );
  assert.equal(harness.controllers.length, 2, "Refresh Settings left the manual Show Images latch active.");
  assert.equal(harness.settingsMessages.at(-1).pageUrl, "https://one.example/after-history");

  const secondController = harness.controllers.at(-1);
  const beforeNewAnalysis = harness.analysisMessages.length;
  secondController.environment.analyze("https://images.example/after-restart.png", () => {});
  assert.equal(harness.analysisMessages.length, beforeNewAnalysis + 1, "Canceled requests still occupied frame analysis slots.");
  harness.analysisMessages.at(-1).callback(0);

  const failureHarness = createContentHarness(shared);
  const failureController = failureHarness.controllers[0];
  const failureResults = [];
  for (let index = 0; index < 300; index += 1) {
    failureController.environment.analyze(
      `https://images.example/context-failure-${index}.png`,
      value => failureResults.push(value),
    );
  }
  assert.equal(failureHarness.analysisMessages.length, 8);
  failureHarness.setAnalyzeSendFailure(true);
  failureHarness.analysisMessages[0].callback(0);
  assert.equal(
    failureResults.length,
    9,
    "A synchronous messaging failure drained the full analysis backlog without yielding.",
  );
  assert(
    Array.from(failureHarness.timers.timers.values()).some(timer => timer.delay === 0),
    "The scheduler did not yield the failed backlog to a later task.",
  );
  failureHarness.runtimeListeners[0]({ r: "showImages" }, {}, () => {});
  assert.equal(failureResults.length, 300, "Canceling after a messaging failure did not release the backlog.");
}

async function dispatchWorkerMessage(harness, request, sender) {
  const listener = harness.runtimeMessageEvent.listeners[0];
  assert(listener, "The worker did not install its runtime message listener.");
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`Worker route did not respond: ${request.r}`));
      }
    }, 1000);
    listener(request, sender || {}, response => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise(response);
    });
  });
}

async function testSettingsWritesAndBroadcast(harness) {
  const { api, local, localWrites, queriedTabs, runtimeMessages, tabMessages } = harness;
  await Promise.all([
    api.updateSettings(settings => { settings.noPattern = true; }, { url: "chrome-extension://fixture/options.htm" }),
    api.updateSettings(settings => { settings.maxSafe = 77; }, { url: "chrome-extension://fixture/options.htm" }),
  ]);
  assert.equal(local.data.settings.noPattern, true);
  assert.equal(local.data.settings.maxSafe, 77);
  assert.equal(localWrites.filter(write => write.settings).length, 2);

  const settingsWritesBeforeFailure = localWrites.filter(write => write.settings).length;
  local.failNextSet(new Error("fixture storage rejection"));
  const rejectedResponse = await dispatchWorkerMessage(
    harness,
    { r: "setNoPattern", toggle: false },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(rejectedResponse.ok, false, "A rejected settings write was reported as successful.");
  assert.equal(local.data.settings.noPattern, true, "A rejected settings write mutated persisted state.");
  assert.equal(
    localWrites.filter(write => write.settings).length,
    settingsWritesBeforeFailure,
    "A rejected settings write was recorded as persisted.",
  );
  const recoveredResponse = await dispatchWorkerMessage(
    harness,
    { r: "setNoPattern", toggle: false },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(recoveredResponse.ok, true, "The settings queue did not recover after a rejected write.");
  assert.equal(local.data.settings.noPattern, false, "The post-rejection settings write was not persisted.");

  localWrites.length = 0;
  const previousSettings = clone(local.data.settings);
  const response = await dispatchWorkerMessage(
    harness,
    { r: "setNoEye", toggle: true },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(response.ok, true);
  assert.equal(local.data.settings.noEye, true);
  assert.equal(localWrites.filter(write => write.settings).length, 1);

  runtimeMessages.length = 0;
  tabMessages.length = 0;
  await api.reconcileStorageChange(
    { settings: { oldValue: previousSettings, newValue: clone(local.data.settings) } },
    "local",
  );
  await flushPromises();

  const settingsChanged = runtimeMessages.filter(message => message.r === "settingsChanged");
  assert.equal(settingsChanged.length, 1, "A UI-origin settings write emitted duplicate global broadcasts.");
  assert.equal(tabMessages.length, queriedTabs.length, "A UI-origin settings write did not refresh every open tab exactly once.");
  assert.equal(
    JSON.stringify(tabMessages.map(item => item.tabId).sort((left, right) => left - right)),
    JSON.stringify(queriedTabs.map(tab => tab.id).sort((left, right) => left - right)),
  );
  assert(tabMessages.every(item => item.message.r === "refreshSettings"));
  assert.equal(new Set(tabMessages.map(item => item.message.revision)).size, 1);
  assert.equal(api.tabRefreshSuppressions.size, 0, "A global UI settings write left a stale tab-refresh suppression.");

  const closeOnClickPrevious = clone(local.data.settings);
  const settingsWritesBeforeCloseOnClick = localWrites.filter(write => write.settings).length;
  const closeOnClickResponse = await dispatchWorkerMessage(
    harness,
    { r: "setCloseOnClick", toggle: true },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(closeOnClickResponse.ok, true);
  assert.equal(local.data.settings.closeOnClick, true);
  assert.equal(localWrites.filter(write => write.settings).length, settingsWritesBeforeCloseOnClick + 1);

  runtimeMessages.length = 0;
  tabMessages.length = 0;
  await api.reconcileStorageChange(
    { settings: { oldValue: closeOnClickPrevious, newValue: clone(local.data.settings) } },
    "local",
  );
  await flushPromises();
  assert.equal(
    runtimeMessages.filter(message => message.r === "settingsChanged").length,
    1,
    "A closeOnClick-only change did not notify extension pages exactly once.",
  );
  assert.equal(tabMessages.length, 0, "A closeOnClick-only change refreshed content tabs.");
}

async function testNavigationRefresh(harness) {
  const { api, local, tabMessages, updatedEvent } = harness;
  tabMessages.length = 0;

  assert.equal(await api.refreshTabForNavigation(11, "https://one.example/listed"), true);
  assert.equal(tabMessages.length, 1);
  assert.equal(tabMessages[0].tabId, 11);
  assert.equal(tabMessages[0].message.r, "refreshSettings");
  assert.equal(tabMessages[0].message.pageUrl, "https://one.example/listed");
  assert.equal(await api.refreshTabForNavigation(11, "https://one.example/listed"), false);
  assert.equal(tabMessages.length, 1, "A duplicate URL signal refreshed the tab twice.");

  local.data.urlList = ["one.example/listed"];
  const hintedSettings = await dispatchWorkerMessage(
    harness,
    { r: "getSettings", pageUrl: "https://one.example/listed/photo" },
    { tab: { id: 11, url: "https://one.example/unlisted" } },
  );
  assert.equal(hintedSettings.excluded, true, "The navigation URL hint was ignored while tab metadata lagged.");

  const routeResponse = await dispatchWorkerMessage(
    harness,
    { r: "pageUrlChanged", url: "https://one.example/other" },
    { tab: { id: 11, url: "https://one.example/other" } },
  );
  assert.equal(routeResponse.ok, true);
  assert.equal(routeResponse.refreshed, true);
  assert.equal(tabMessages.at(-1).message.pageUrl, "https://one.example/other");

  const listener = updatedEvent.listeners[0];
  assert(listener, "The worker did not install tabs.onUpdated navigation handling.");
  listener(11, { url: "https://one.example/from-tabs-event" });
  await flushPromises();
  assert.equal(tabMessages.at(-1).message.pageUrl, "https://one.example/from-tabs-event");
}

async function testInvalidUrlListMutation(harness) {
  const { local, localWrites } = harness;
  const writesBeforeInvalidRequest = localWrites.length;
  const invalidResponse = await dispatchWorkerMessage(
    harness,
    { r: "urlListAdd", url: "not a valid URL", domainOnly: true },
    { url: "chrome-extension://fixture/popup.htm" },
  );
  assert.equal(invalidResponse.ok, false, "A hostless urlListAdd request was reported as successful.");
  assert.equal(localWrites.length, writesBeforeInvalidRequest, "A hostless urlListAdd request wrote storage.");

  const invalidSetResponse = await dispatchWorkerMessage(
    harness,
    { r: "setUrlList", urlList: ["*.example.com", "not a valid URL"] },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(invalidSetResponse.ok, false, "setUrlList accepted an invalid mixed list.");
  assert.equal(localWrites.length, writesBeforeInvalidRequest, "An invalid setUrlList request wrote storage.");

  const wildcardSetResponse = await dispatchWorkerMessage(
    harness,
    { r: "setUrlList", urlList: ["https://*.example.com/path"] },
    { url: "chrome-extension://fixture/options.htm" },
  );
  assert.equal(wildcardSetResponse.ok, true, "setUrlList rejected a valid wildcard URL entry.");
  const wildcardSettings = await dispatchWorkerMessage(
    harness,
    { r: "getSettings", tab: { id: 91, url: "https://media.deep.example.com/path/image" } },
  );
  assert.equal(wildcardSettings.excluded, true, "Worker settings did not apply a wildcard URL-list entry.");
  const wrongSchemeSettings = await dispatchWorkerMessage(
    harness,
    { r: "getSettings", tab: { id: 92, url: "http://media.deep.example.com/path/image" } },
  );
  assert.equal(wrongSchemeSettings.excluded, false, "Worker wildcard URL matching ignored the stored scheme.");

  const validResponse = await dispatchWorkerMessage(
    harness,
    { r: "urlListAdd", url: "https://valid.example/path", domainOnly: true },
    { url: "chrome-extension://fixture/popup.htm" },
  );
  assert.equal(validResponse.ok, true, "A valid urlListAdd failed after a rejected request.");
  assert(Array.isArray(local.data.urlList) && local.data.urlList.includes("valid.example"));
}

export async function runRuntimeVmTests() {
  const shared = loadShared();
  testMediaStartupGate();
  testSharedHelpers(shared);
  const harness = createWorkerHarness(shared);
  testAnalyzeBounds(harness);
  testAnalyzeDedupTimeoutAndCache(harness);
  testContentBackpressureAndManualRefresh(shared);
  await testSettingsWritesAndBroadcast(harness);
  await testNavigationRefresh(harness);
  await testInvalidUrlListMutation(harness);
  return { sharedAssertions: 20, workerAssertions: 68, contentAssertions: 72 };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
const isMainModule =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;

if (isMainModule) {
  try {
    const result = await runRuntimeVmTests();
    console.log(
      `Runtime VM regression passed (${result.sharedAssertions} shared-helper and ` +
        `${result.workerAssertions} worker and ${result.contentAssertions} content assertions).`,
    );
  } catch (error) {
    console.error(`Runtime VM regression failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
