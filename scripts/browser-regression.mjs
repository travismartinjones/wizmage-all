import { spawn, spawnSync } from "node:child_process";
import {
  constants,
  accessSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const OUTPUT_LIMIT = 8 * 1024 * 1024;

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name) {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory.replace(/^"|"$/g, ""), name + extension);
      if (existsSync(candidate) && canExecute(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveBrowserCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  const unquoted = String(candidate).trim().replace(/^"(.*)"$/, "$1");
  if (isAbsolute(unquoted) || unquoted.includes("/") || unquoted.includes("\\")) {
    const absolute = resolve(unquoted);
    return existsSync(absolute) && canExecute(absolute) ? absolute : null;
  }
  return findOnPath(unquoted);
}

export function findSupportedBrowser() {
  if (process.env.WIZMAGE_BROWSER) {
    const configured = resolveBrowserCandidate(process.env.WIZMAGE_BROWSER);
    if (!configured) {
      throw new Error(`WIZMAGE_BROWSER is not an executable file: ${process.env.WIZMAGE_BROWSER}`);
    }
    return configured;
  }

  const candidates = [];
  if (process.platform === "win32") {
    for (const base of [
      process.env.PROGRAMFILES,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (!base) {
        continue;
      }
      candidates.push(
        join(base, "Google", "Chrome", "Application", "chrome.exe"),
        join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && canExecute(candidate)) {
      return candidate;
    }
  }
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "msedge",
  ]) {
    const candidate = findOnPath(name);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function fixtureHtml() {
  return `<!doctype html>
<html data-wzm-test-status="running">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WZM_TEST_RUNNING</title>
  <link rel="stylesheet" href="/css.css">
  <script src="/media-startup.js"></script>
  <script>
    window.__wzmLoadErrors = [];
    window.addEventListener('error', function (event) {
      window.__wzmLoadErrors.push(String(event.message || event.error || 'script error'));
    });
  </script>
</head>
<body>
  <button id="site-button" type="button">Site action</button>
  <img id="single-image" src="/img/single.png" alt="single fixture" style="width:120px;height:120px">
  <script>
    window.__wzmInitialMediaState = (function () {
      const image = document.getElementById('single-image');
      const style = getComputedStyle(image);
      return {
        opacity: style.opacity,
        pending: image.getAttribute('data-wzm-media-pending'),
        locked: image.getAttribute('data-wzm-locked')
      };
    })();
  </script>
  <pre id="wzm-test-result">running</pre>
  <script src="/shared.js"></script>
  <script src="/content-controller.js"></script>
  <script src="/runtime-regression-page.js"></script>
</body>
</html>`;
}

function mv3FixtureHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>WZM_MV3_SMOKE</title>
  <style>
    .mv3-css-preview,
    .mv3-delayed-css-preview {
      width: 120px;
      height: 120px;
    }
    .mv3-css-preview {
      background-image: url("/img/mv3-background-preview.png");
    }
    .mv3-delayed-css-preview {
      background-image: url("/img/mv3-delayed-background-preview.png");
    }
  </style>
</head>
<body>
  <button id="mv3-site-button" type="button">Site action</button>
  <img id="mv3-image" src="/img/mv3-smoke.png" alt="MV3 smoke fixture" style="width:120px;height:120px">
  <div id="mv3-css-preview" class="mv3-css-preview"></div>
  <div id="mv3-stress-spinner">Loading compiler architecture diagrams...</div>
  <section id="mv3-stress-grid"></section>
  <script>
    window.mv3PageToken = Math.random().toString(36);
    window.mv3TargetClicks = 0;
    window.mv3BubbleClicks = 0;
    document.getElementById('mv3-site-button').addEventListener('click', function () { window.mv3TargetClicks++; });
    document.body.addEventListener('click', function (event) {
      if (event.target.id === 'mv3-site-button') window.mv3BubbleClicks++;
    });
    window.__wzmMv3Stress = {
      created: 0,
      loaded: 0,
      locked: 0,
      maxHeartbeatGap: 0,
      sourceStable: false,
      dynamicProbeFrames: 0,
      dynamicRawFrames: 0,
      dynamicSuppressedFrames: 0,
      cssPreviewProbeFrames: 0,
      cssPreviewRawFrames: 0,
      cssPreviewSuppressedFrames: 0,
      cssPreviewLocked: false,
      delayedCssPreviewInserted: false,
      delayedCssPreviewProbeFrames: 0,
      delayedCssPreviewRawFrames: 0,
      delayedCssPreviewSuppressedFrames: 0,
      delayedCssPreviewLocked: false,
      quietVisualWrites: 0,
      closedRootStyleSeen: false,
      closedRootImageLocked: false,
      closedRootReinsertions: 0,
      closedRootLoopBounded: false,
      spinnerHidden: false,
      done: false,
      error: ''
    };
    window.__wzmMv3Paint = {
      frames: 0,
      preLockFrames: 0,
      suppressedPreLockFrames: 0,
      rawFrames: 0,
      done: false,
      samples: []
    };
    window.__wzmRawMediaExposed = function (image) {
      const style = getComputedStyle(image);
      return style.opacity !== '0' &&
        image.getAttribute('data-wzm-locked') !== '1' &&
        image.getAttribute('data-wzm-hide') !== '1';
    };
    window.__wzmRawCssMediaExposed = function (element) {
      const style = getComputedStyle(element);
      return style.backgroundImage !== 'none' &&
        style.backgroundSize !== '0px 0px' &&
        element.getAttribute('data-wzm-pattern-bg-img') !== '1' &&
        element.getAttribute('data-wzm-suppress-self-background') !== '1';
    };
    requestAnimationFrame(function sampleCssPreview() {
      const state = window.__wzmMv3Stress;
      const preview = document.getElementById('mv3-css-preview');
      state.cssPreviewProbeFrames++;
      if (window.__wzmRawCssMediaExposed(preview)) state.cssPreviewRawFrames++;
      else state.cssPreviewSuppressedFrames++;
      if (preview.getAttribute('data-wzm-pattern-bg-img') === '1' || state.cssPreviewProbeFrames >= 120) {
        state.cssPreviewLocked = preview.getAttribute('data-wzm-pattern-bg-img') === '1';
        return;
      }
      requestAnimationFrame(sampleCssPreview);
    });
    setTimeout(function hydrateDelayedCssPreview() {
      const state = window.__wzmMv3Stress;
      const preview = document.createElement('div');
      preview.id = 'mv3-delayed-css-preview';
      preview.className = 'mv3-delayed-css-preview';
      document.body.appendChild(preview);
      state.delayedCssPreviewInserted = true;
      requestAnimationFrame(function sampleDelayedCssPreview() {
        state.delayedCssPreviewProbeFrames++;
        if (window.__wzmRawCssMediaExposed(preview)) state.delayedCssPreviewRawFrames++;
        else state.delayedCssPreviewSuppressedFrames++;
        if (preview.getAttribute('data-wzm-pattern-bg-img') === '1' ||
          state.delayedCssPreviewProbeFrames >= 120) {
          state.delayedCssPreviewLocked = preview.getAttribute('data-wzm-pattern-bg-img') === '1';
          return;
        }
        requestAnimationFrame(sampleDelayedCssPreview);
      });
    }, 1250);
    requestAnimationFrame(function sampleInitialMedia() {
      const paint = window.__wzmMv3Paint;
      const image = document.getElementById('mv3-image');
      const locked = image.getAttribute('data-wzm-locked') === '1';
      const exposed = window.__wzmRawMediaExposed(image);
      paint.frames++;
      if (!locked) {
        paint.preLockFrames++;
        if (exposed) paint.rawFrames++;
        else paint.suppressedPreLockFrames++;
      }
      if (paint.samples.length < 8) {
        paint.samples.push({
          opacity: getComputedStyle(image).opacity,
          pending: image.getAttribute('data-wzm-media-pending'),
          locked: image.getAttribute('data-wzm-locked'),
          rootClass: document.documentElement.className
        });
      }
      if (locked || paint.frames >= 120) {
        paint.done = true;
        return;
      }
      requestAnimationFrame(sampleInitialMedia);
    });
    (async function () {
      const state = window.__wzmMv3Stress;
      const grid = document.getElementById('mv3-stress-grid');
      const spinner = document.getElementById('mv3-stress-spinner');
      const entries = [];
      const closedHost = document.createElement('div');
      const closedRoot = closedHost.attachShadow({ mode: 'closed' });
      const closedImage = document.createElement('img');
      closedImage.alt = 'closed shadow compiler architecture diagram';
      closedImage.src = '/img/mv3-closed-shadow-compiler.png';
      closedImage.style.width = '120px';
      closedImage.style.height = '120px';
      closedRoot.appendChild(closedImage);
      document.body.appendChild(closedHost);
      let heartbeatLast = performance.now();
      const heartbeat = setInterval(function () {
        const now = performance.now();
        state.maxHeartbeatGap = Math.max(state.maxHeartbeatGap, now - heartbeatLast);
        heartbeatLast = now;
      }, 25);
      try {
        const loads = [];
        for (let batch = 0; batch < 8; batch++) {
          const fragment = document.createDocumentFragment();
          for (let offset = 0; offset < 20; offset++) {
            const index = batch * 20 + offset;
            const low = '/img/mv3-compiler-' + index + '-low.png';
            const high = '/img/mv3-compiler-' + index + '-high.png';
            const image = document.createElement('img');
            image.alt = 'compiler architecture diagram ' + index;
            image.style.width = '96px';
            image.style.height = '96px';
            loads.push(new Promise(function (resolve) {
              image.addEventListener('load', function () { state.loaded++; resolve(); }, { once: true });
              image.addEventListener('error', resolve, { once: true });
            }));
            image.src = low;
            image.srcset = low + ' 1x, ' + high + ' 2x';
            image.sizes = '96px';
            entries.push({ image: image, low: new URL(low, location.href).href, high: new URL(high, location.href).href });
            fragment.appendChild(image);
            state.created++;
          }
          grid.appendChild(fragment);
          if (batch === 0) {
            requestAnimationFrame(function () {
              state.dynamicProbeFrames++;
              if (window.__wzmRawMediaExposed(entries[0].image)) state.dynamicRawFrames++;
              else state.dynamicSuppressedFrames++;
            });
          }
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
        }
        await Promise.all(loads);
        const selected = entries.map(function (entry) { return entry.image.currentSrc; });
        for (let round = 0; round < 8; round++) {
          entries.forEach(function (entry, index) {
            const unused = new URL('/img/mv3-compiler-' + index + '-unused-' + round + '.png', location.href).href;
            entry.image.srcset = selected[index] === entry.high
              ? unused + ' 1x, ' + entry.high + ' 2x'
              : entry.low + ' 1x, ' + unused + ' 2x';
            entry.image.sizes = (96 + round) + 'px';
          });
          await new Promise(function (resolve) { requestAnimationFrame(resolve); });
        }
        state.sourceStable = entries.every(function (entry, index) {
          return entry.image.currentSrc === selected[index];
        });
        const lockDeadline = performance.now() + 5000;
        while (performance.now() < lockDeadline
          && !entries.every(function (entry) { return entry.image.getAttribute('data-wzm-locked') === '1'; })) {
          await new Promise(function (resolve) { setTimeout(resolve, 25); });
        }
        state.locked = entries.filter(function (entry) {
          return entry.image.getAttribute('data-wzm-locked') === '1';
        }).length;
        const closedDeadline = performance.now() + 5000;
        while (performance.now() < closedDeadline &&
          !(closedImage.getAttribute('data-wzm-locked') === '1' &&
            closedRoot.querySelector('link[data-wzm-shadow-style="1"]'))) {
          await new Promise(function (resolve) { setTimeout(resolve, 25); });
        }
        state.closedRootImageLocked = closedImage.getAttribute('data-wzm-locked') === '1';
        state.closedRootStyleSeen = !!closedRoot.querySelector('link[data-wzm-shadow-style="1"]');
        const delayedCssDeadline = performance.now() + 5000;
        while (performance.now() < delayedCssDeadline && !state.delayedCssPreviewLocked) {
          await new Promise(function (resolve) { setTimeout(resolve, 25); });
        }
        if (state.closedRootStyleSeen) {
          let reconciliationTimerFired = false;
          const pageReconciler = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
              Array.from(mutation.addedNodes || []).forEach(function (node) {
                if (state.closedRootReinsertions >= 12 || !node.matches ||
                  !node.matches('link[data-wzm-shadow-style="1"]')) return;
                state.closedRootReinsertions++;
                node.remove();
              });
            });
          });
          pageReconciler.observe(closedRoot, { childList: true });
          setTimeout(function () { reconciliationTimerFired = true; }, 0);
          closedRoot.querySelector('link[data-wzm-shadow-style="1"]').remove();
          await new Promise(function (resolve) { setTimeout(resolve, 250); });
          pageReconciler.disconnect();
          state.closedRootLoopBounded = reconciliationTimerFired &&
            state.closedRootReinsertions > 0 && state.closedRootReinsertions <= 4 &&
            closedRoot.querySelectorAll('link[data-wzm-shadow-style="1"]').length <= 1;
        }
        const quietObserver = new MutationObserver(function (mutations) {
          state.quietVisualWrites += mutations.filter(function (mutation) {
            return String(mutation.attributeName || '').startsWith('data-wzm-');
          }).length;
        });
        quietObserver.observe(grid, { attributes: true, subtree: true });
        await new Promise(function (resolve) { setTimeout(resolve, 1100); });
        quietObserver.disconnect();
        spinner.hidden = true;
        state.spinnerHidden = true;
      } catch (error) {
        state.error = String(error && error.stack ? error.stack : error);
      } finally {
        clearInterval(heartbeat);
        state.done = true;
      }
    })();
  </script>
</body>
</html>`;
}

function startFixtureServer(rootDir) {
  const snapshot = new Map([
    ["/", { type: "text/html; charset=utf-8", contents: Buffer.from(fixtureHtml(), "utf8") }],
    ["/test.html", { type: "text/html; charset=utf-8", contents: Buffer.from(fixtureHtml(), "utf8") }],
    ["/mv3.html", { type: "text/html; charset=utf-8", contents: Buffer.from(mv3FixtureHtml(), "utf8") }],
    ["/shared.js", { type: "text/javascript; charset=utf-8", contents: readFileSync(join(rootDir, "shared.js")) }],
    ["/media-startup.js", { type: "text/javascript; charset=utf-8", contents: readFileSync(join(rootDir, "media-startup.js")) }],
    ["/content-controller.js", { type: "text/javascript; charset=utf-8", contents: readFileSync(join(rootDir, "content-controller.js")) }],
    ["/runtime-regression-page.js", { type: "text/javascript; charset=utf-8", contents: readFileSync(join(rootDir, "scripts", "runtime-regression-page.js")) }],
    ["/css.css", { type: "text/css; charset=utf-8", contents: readFileSync(join(rootDir, "css.css")) }],
    ["/extension/css.css", { type: "text/css; charset=utf-8", contents: readFileSync(join(rootDir, "css.css")) }],
    ["/extension/eye.svg", { type: "image/svg+xml", contents: readFileSync(join(rootDir, "eye.svg")) }],
  ]);
  const pixel = readFileSync(join(rootDir, "clear.png"));
  snapshot.set("/object-image", { type: "image/png", contents: pixel });
  snapshot.set("/object-html", {
    type: "text/html; charset=utf-8",
    contents: Buffer.from("<!doctype html><html><body>Functional embedded HTML</body></html>", "utf8"),
  });

  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://fixture.invalid").pathname;
      const known = snapshot.get(pathname);
      if (known) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": known.type,
          "Content-Length": known.contents.length,
        });
        response.end(known.contents);
        return;
      }
      if (
        pathname.startsWith("/img/") ||
        pathname.endsWith(".png") ||
        pathname === "/favicon.ico"
      ) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "image/png",
          "Content-Length": pixel.length,
        });
        response.end(pixel);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error && error.stack ? error.stack : error));
    }
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      const address = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}/test.html` });
    });
  });
}

function closeFixtureServer(server) {
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise();
    };
    const timeout = setTimeout(() => {
      try { server.closeAllConnections && server.closeAllConnections(); } catch { /* already closed */ }
      finish();
    }, 2000);
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    server.close(finish);
  });
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function processIsRunning(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !!error && error.code === "EPERM";
  }
}

async function waitForProcessesToExit(processIds, timeoutMilliseconds) {
  const ids = [...new Set((processIds || []).filter(Number.isInteger))];
  const deadline = Date.now() + timeoutMilliseconds;
  let remaining = ids.filter(processIsRunning);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(50);
    remaining = remaining.filter(processIsRunning);
  }
  return remaining;
}

async function removeTemporaryDirectory(directory) {
  const retryableCodes = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
  const attempts = process.platform === "win32" ? 8 : 3;
  let retryDelay = 100;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error && error.code) || attempt === attempts - 1) {
        break;
      }
      await delay(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 1500);
    }
  }
  throw new Error(
    `Unable to remove browser-test directory after bounded retries: ${directory}: ` +
      (lastError && lastError.message ? lastError.message : "unknown cleanup error"),
    { cause: lastError },
  );
}

async function waitForDevToolsEndpoint(profileDirectory, state, timeoutMilliseconds = 15000) {
  const activePortPath = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (state.spawnError) {
      throw state.spawnError;
    }
    if (existsSync(activePortPath)) {
      try {
        const lines = readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
        if (/^\d+$/.test(lines[0] || "") && /^\/devtools\/browser\//.test(lines[1] || "")) {
          return {
            browserWebSocketUrl: `ws://127.0.0.1:${lines[0]}${lines[1]}`,
            httpBase: `http://127.0.0.1:${lines[0]}`,
          };
        }
      } catch {
        // Chrome writes this two-line file non-atomically; retry a partial read.
      }
    }
    await delay(50);
  }
  throw new Error("Headless browser did not publish its DevTools endpoint within 15 seconds.");
}

function sendDevToolsCommand(webSocketUrl, method, params = {}, options = {}) {
  const timeoutMilliseconds = options.timeoutMilliseconds || 3000;
  return new Promise((resolvePromise, rejectPromise) => {
    let socket;
    let settled = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try { socket && socket.close(); } catch { /* the browser may already be gone */ }
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(result);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`DevTools command timed out: ${method}`));
    }, timeoutMilliseconds);
    try {
      socket = new WebSocket(webSocketUrl);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method, params }));
      });
      socket.addEventListener("message", event => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id !== 1) {
          return;
        }
        if (message.error) {
          finish(new Error(`DevTools ${method} failed: ${message.error.message || "unknown error"}`));
        } else {
          finish(null, message.result || {});
        }
      });
      socket.addEventListener("close", () => {
        if (options.resolveOnClose) {
          finish(null, {});
        } else {
          finish(new Error(`DevTools connection closed before ${method} responded.`));
        }
      });
      socket.addEventListener("error", () => {
        finish(new Error(`DevTools connection failed: ${method}`));
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function listDevToolsTargets(endpoint) {
  const response = await fetch(`${endpoint.httpBase}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`DevTools target list returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function evaluateTarget(target, expression, awaitPromise = false) {
  const evaluation = await sendDevToolsCommand(
    target.webSocketDebuggerUrl,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    { timeoutMilliseconds: 3000 },
  );
  if (evaluation && evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text || "DevTools evaluation failed.");
  }
  return evaluation && evaluation.result ? evaluation.result.value : undefined;
}

async function waitForFixtureResult(endpoint, fixtureUrl, timeoutMilliseconds = 60000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  const expression = `(() => {
    const root = document.documentElement;
    const result = document.getElementById('wzm-test-result');
    return {
      status: root ? root.getAttribute('data-wzm-test-status') : 'running',
      details: result ? result.textContent : ''
    };
  })()`;

  while (Date.now() < deadline) {
    try {
      const targets = await listDevToolsTargets(endpoint);
      const target = targets.find(candidate =>
        candidate && candidate.type === "page" && candidate.url === fixtureUrl,
      );
      if (target && target.webSocketDebuggerUrl) {
        const evaluation = await sendDevToolsCommand(
          target.webSocketDebuggerUrl,
          "Runtime.evaluate",
          { expression, returnByValue: true },
          { timeoutMilliseconds: 2500 },
        );
        const value = evaluation && evaluation.result && evaluation.result.value;
        if (value && (value.status === "pass" || value.status === "fail")) {
          return value;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    "Headless browser fixture did not finish within 60 seconds" +
      (lastError ? `: ${lastError.message}` : "."),
  );
}

function pathIdentity(path) {
  let canonical;
  try {
    canonical = realpathSync.native(resolve(path));
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function extensionPathForId(profileDirectory, extensionId) {
  for (const name of ["Preferences", "Secure Preferences"]) {
    const preferencesPath = join(profileDirectory, "Default", name);
    if (!existsSync(preferencesPath)) {
      continue;
    }
    try {
      const preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
      const setting = preferences.extensions &&
        preferences.extensions.settings &&
        preferences.extensions.settings[extensionId];
      if (setting && typeof setting.path === "string" && setting.path) {
        return setting.path;
      }
    } catch {
      // Chrome may be replacing a preferences file while the smoke test starts.
    }
  }
  return null;
}

async function waitForPageCondition(pageTarget, expression, message, timeoutMilliseconds = 10000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluateTarget(pageTarget, expression)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(message + (lastError ? `: ${lastError.message}` : ""));
}

async function createPageTarget(endpoint, url, timeoutMilliseconds = 10000) {
  const created = await sendDevToolsCommand(
    endpoint.browserWebSocketUrl,
    "Target.createTarget",
    { url },
  );
  const targetId = created && created.targetId;
  if (!targetId) {
    throw new Error(`DevTools did not create the requested page target: ${url}`);
  }

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const targets = await listDevToolsTargets(endpoint);
    const target = targets.find(candidate => candidate && candidate.id === targetId);
    if (target && target.webSocketDebuggerUrl) {
      return target;
    }
    await delay(50);
  }
  throw new Error(`The requested page target did not become available: ${url}`);
}

async function waitForMv3SmokeResult(endpoint, fixtureUrl, options) {
  const extensionPath = resolve(options.extensionPath);
  const profileDirectory = options.profileDirectory;
  const deadline = Date.now() + 20000;
  let pageTarget = null;
  let workerTarget = null;
  let extensionId = null;

  while (Date.now() < deadline && (!pageTarget || !workerTarget)) {
    const targets = await listDevToolsTargets(endpoint);
    pageTarget = targets.find(target => target.type === "page" && target.url === fixtureUrl) || null;
    for (const target of targets) {
      if (target.type !== "service_worker" || !/^chrome-extension:\/\//.test(target.url || "")) {
        continue;
      }
      try {
        const info = await evaluateTarget(
          target,
          `({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() })`,
        );
        if (!info || !info.id || !info.manifest || info.manifest.name !== "Wizmage Image Hider") {
          continue;
        }
        const storedPath = extensionPathForId(profileDirectory, info.id);
        if (storedPath && pathIdentity(storedPath) === pathIdentity(extensionPath)) {
          workerTarget = target;
          extensionId = info.id;
          break;
        }
      } catch {
        // A service worker can stop between target enumeration and evaluation.
      }
    }
    if (!pageTarget || !workerTarget) {
      await delay(100);
    }
  }

  if (!workerTarget) {
    const error = new Error("Headless Chrome did not load the requested unpacked MV3 extension.");
    error.extensionUnavailable = true;
    throw error;
  }
  if (!pageTarget) {
    throw new Error("The MV3 smoke-test page did not open.");
  }

  await waitForPageCondition(
    pageTarget,
    `document.getElementById("mv3-image")?.getAttribute("data-wzm-locked") === "1"`,
    "The manifest-loaded content script did not lock the default image",
  );
  try {
    await waitForPageCondition(
      pageTarget,
      `window.__wzmMv3Stress?.done === true`,
      "The manifest-loaded Google Images-style stress fixture did not finish",
      30000,
    );
  } catch (error) {
    const diagnostic = await evaluateTarget(
      pageTarget,
      `({ stress: window.__wzmMv3Stress, paint: window.__wzmMv3Paint, visibility: document.visibilityState })`,
    ).catch(() => null);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  }
  const stressState = await evaluateTarget(pageTarget, `(() => ({
    ...window.__wzmMv3Stress,
    paint: window.__wzmMv3Paint,
    documentClass: document.documentElement.className,
    samples: Array.from(document.querySelectorAll("#mv3-stress-grid img")).slice(0, 3).map(image => ({
      currentSrc: image.currentSrc,
      src: image.getAttribute("src"),
      srcset: image.getAttribute("srcset"),
      width: image.getBoundingClientRect().width,
      height: image.getBoundingClientRect().height,
      locked: image.getAttribute("data-wzm-locked"),
      pattern: image.getAttribute("data-wzm-pattern-bg-img"),
      shade: image.getAttribute("data-wzm-shade")
    }))
  }))()`);
  if (!stressState || stressState.error
    || stressState.created !== 160
    || stressState.loaded !== 160
    || stressState.locked !== 160
    || stressState.dynamicProbeFrames !== 1
    || stressState.dynamicRawFrames !== 0
    || stressState.dynamicSuppressedFrames !== 1
    || stressState.cssPreviewProbeFrames < 1
    || stressState.cssPreviewRawFrames !== 0
    || stressState.cssPreviewSuppressedFrames !== stressState.cssPreviewProbeFrames
    || stressState.cssPreviewLocked !== true
    || stressState.delayedCssPreviewInserted !== true
    || stressState.delayedCssPreviewProbeFrames < 1
    || stressState.delayedCssPreviewRawFrames !== 0
    || stressState.delayedCssPreviewSuppressedFrames !== stressState.delayedCssPreviewProbeFrames
    || stressState.delayedCssPreviewLocked !== true
    || !stressState.paint
    || stressState.paint.done !== true
    || stressState.paint.frames < 1
    || stressState.paint.preLockFrames < 1
    || stressState.paint.suppressedPreLockFrames !== stressState.paint.preLockFrames
    || stressState.paint.rawFrames !== 0
    || stressState.sourceStable !== true
    || stressState.closedRootStyleSeen !== true
    || stressState.closedRootImageLocked !== true
    || stressState.closedRootReinsertions < 1
    || stressState.closedRootReinsertions > 4
    || stressState.closedRootLoopBounded !== true
    || stressState.spinnerHidden !== true
    || stressState.quietVisualWrites !== 0
    || stressState.maxHeartbeatGap >= 750) {
    throw new Error(`The manifest-loaded stress fixture was not stable: ${JSON.stringify(stressState)}`);
  }
  const initialState = await evaluateTarget(
    pageTarget,
    `(() => {
      const token = window.mv3PageToken;
      document.getElementById("mv3-site-button").click();
      return { token, target: window.mv3TargetClicks, bubble: window.mv3BubbleClicks };
    })()`,
  );
  if (!initialState || initialState.target !== 1 || initialState.bubble !== 1) {
    throw new Error("The manifest-loaded extension intercepted the site's button click.");
  }

  // runtime.sendMessage does not loop a message back to the same service-worker
  // execution context. Use a real extension page so this exercises the same
  // popup -> worker -> storage -> content-script path as the shipped UI.
  const senderTarget = await createPageTarget(
    endpoint,
    `chrome-extension://${extensionId}/popup.htm?wzm-mv3-smoke=1`,
  );
  await waitForPageCondition(
    senderTarget,
    `document.readyState !== "loading" &&
      typeof chrome === "object" && chrome.runtime?.id === ${JSON.stringify(extensionId)}`,
    "The MV3 extension-page sender did not become ready",
  );

  const sendWorkerCommand = async (message, label) => {
    const result = await evaluateTarget(
      senderTarget,
      `new Promise(resolve => chrome.runtime.sendMessage(
        ${JSON.stringify(message)},
        response => resolve({
          response,
          error: chrome.runtime.lastError ? chrome.runtime.lastError.message : ""
        })
      ))`,
      true,
    );
    if (!result || result.error || !result.response || result.response.ok !== true) {
      throw new Error(`The MV3 worker ${label} route failed${result && result.error ? `: ${result.error}` : "."}`);
    }
  };
  const sendContentCommand = async (message, label) => {
    const result = await evaluateTarget(
      senderTarget,
      `new Promise(resolve => chrome.tabs.query({}, tabs => {
        const tab = tabs.find(candidate => candidate.url === ${JSON.stringify(fixtureUrl)});
        if (!tab) {
          resolve({ response: null, error: "fixture tab not found" });
          return;
        }
        chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}, response => resolve({
          response,
          error: chrome.runtime.lastError ? chrome.runtime.lastError.message : ""
        }));
      }))`,
      true,
    );
    if (!result || result.error || !result.response || result.response.ok !== true) {
      throw new Error(`The MV3 content ${label} route failed${result && result.error ? `: ${result.error}` : "."}`);
    }
  };
  const sendPause = async toggle => sendWorkerCommand({ r: "pause", toggle }, "pause");

  await sendPause(true);
  await waitForPageCondition(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return window.mv3PageToken === ${JSON.stringify(initialState.token)} &&
        !image.hasAttribute("data-wzm-locked") &&
        !image.hasAttribute("data-wzm-pattern-bg-img");
    })()`,
    "Pausing through the MV3 worker did not reveal the image without a reload",
  );
  await sendPause(false);
  await waitForPageCondition(
    pageTarget,
    `window.mv3PageToken === ${JSON.stringify(initialState.token)} &&
      document.getElementById("mv3-image")?.getAttribute("data-wzm-locked") === "1"`,
    "Resuming through the MV3 worker did not re-lock the image without a reload",
  );

  await sendContentCommand({ r: "showImages" }, "Show Images");
  await waitForPageCondition(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return window.mv3PageToken === ${JSON.stringify(initialState.token)} &&
        document.documentElement.classList.contains("wizmage-running") &&
        !image?.hasAttribute("data-wzm-locked") &&
        !image?.hasAttribute("data-wzm-pattern-bg-img");
    })()`,
    "Show Images did not reveal current media while leaving the controller active",
  );
  await evaluateTarget(
    pageTarget,
    `(() => {
      const image = document.createElement("img");
      image.id = "mv3-after-show-image";
      image.src = "/img/mv3-after-show.png";
      image.alt = "lazy media inserted after Show Images";
      image.style.cssText = "width:120px;height:120px";
      document.body.appendChild(image);
      return true;
    })()`,
  );
  await waitForPageCondition(
    pageTarget,
    `document.getElementById("mv3-after-show-image")?.getAttribute("data-wzm-locked") === "1"`,
    "Media inserted after Show Images bypassed the live filter",
  );
  await evaluateTarget(pageTarget, `document.getElementById("mv3-after-show-image")?.remove(); true`);

  const safeDomainFixture = await evaluateTarget(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return { token: window.mv3PageToken, url: image && image.currentSrc };
    })()`,
  );
  if (!safeDomainFixture || !safeDomainFixture.url) {
    throw new Error("The MV3 safe-domain fixture had no current image URL.");
  }
  await evaluateTarget(
    workerTarget,
    `cachePut(${JSON.stringify(safeDomainFixture.url)}, 0); true`,
  );
  await sendWorkerCommand({ r: "setAlwaysBlock", toggle: true }, "Always Block");
  await sendWorkerCommand({ r: "setBlockTarget", blockTarget: "people" }, "block target");
  await waitForPageCondition(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return window.mv3PageToken === ${JSON.stringify(safeDomainFixture.token)} &&
        image?.getAttribute("data-wzm-locked") === "1" &&
        image?.getAttribute("data-wzm-always") === "1";
    })()`,
    "Always Block did not render the cached-safe MV3 fixture",
  );

  const userRevealState = await evaluateTarget(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      image?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
      const eye = document.querySelector('[data-wzm-eye="1"]');
      eye?.click();
      return {
        eyeFound: !!eye,
        locked: image?.getAttribute("data-wzm-locked"),
        pattern: image?.getAttribute("data-wzm-pattern-bg-img")
      };
    })()`,
  );
  if (!userRevealState?.eyeFound || userRevealState.locked || userRevealState.pattern) {
    throw new Error("The MV3 safe-domain fixture could not enter the user-revealed state.");
  }

  await sendWorkerCommand(
    { r: "allowSafeForDomain", url: fixtureUrl, toggle: true },
    "safe-domain enable",
  );
  await waitForPageCondition(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return window.mv3PageToken === ${JSON.stringify(safeDomainFixture.token)} &&
        !image?.hasAttribute("data-wzm-locked") &&
        !image?.hasAttribute("data-wzm-pattern-bg-img") &&
        !image?.hasAttribute("data-wzm-always") &&
        !image?.hasAttribute("data-wzm-media-pending");
    })()`,
    "The safe-domain toggle did not show cached-safe media without navigation",
  );
  await sendWorkerCommand(
    { r: "allowSafeForDomain", url: fixtureUrl, toggle: false },
    "safe-domain disable",
  );
  await waitForPageCondition(
    pageTarget,
    `(() => {
      const image = document.getElementById("mv3-image");
      return window.mv3PageToken === ${JSON.stringify(safeDomainFixture.token)} &&
        image?.getAttribute("data-wzm-locked") === "1" &&
        image?.getAttribute("data-wzm-pattern-bg-img") === "1" &&
        image?.getAttribute("data-wzm-always") === "1";
    })()`,
    "Removing the safe-domain toggle did not reblock cached-safe media without navigation",
  );

  return {
    status: "pass",
    details: `Loaded extension ${extensionId}; ${stressState.paint.preLockFrames} pre-lock frames exposed zero raw media, ` +
      `${stressState.cssPreviewProbeFrames} parser-time CSS-preview frames exposed zero raw media, ` +
      `${stressState.delayedCssPreviewProbeFrames} delayed CSS-preview frames exposed zero raw media, and the ` +
      `160-tile stress, pause/resume, Show Images lazy-load, and safe-domain on/off passed without navigation.`,
  };
}

async function runBrowserProcess(browserPath, profileDirectory, url, options = {}) {
  const arguments_ = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-renderer-backgrounding",
    "--disable-crash-reporter",
    "--disable-sync",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--noerrdialogs",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1280,900",
  ];
  if (options.extensionPath) {
    const extensionPath = resolve(options.extensionPath);
    arguments_.push(
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    );
  } else {
    arguments_.push("--disable-extensions");
  }
  if (process.platform === "linux") {
    arguments_.push("--no-sandbox");
  }
  arguments_.push(url);

  // A POSIX process group provides a fallback if DevTools cannot close the
  // isolated browser. On Windows we additionally capture exact PIDs from that
  // browser's DevTools endpoint, so cleanup never targets Chrome by image name.
  const child = spawn(browserPath, arguments_, {
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const state = { spawnError: null };
  const stderr = [];
  let stderrSize = 0;
  let exitResult = null;
  const childClosed = new Promise(resolveClosed => {
    child.once("error", error => {
      state.spawnError = error;
      resolveClosed({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      exitResult = { code, signal };
      resolveClosed(exitResult);
    });
  });
  child.stdout.resume();
  child.stderr.on("data", chunk => {
    stderrSize += chunk.length;
    if (stderrSize <= OUTPUT_LIMIT) {
      stderr.push(chunk);
    }
  });

  const terminateBrowserTree = processIds => {
    if (process.platform === "win32") {
      // Edge can launch late feature processes while Browser.close is tearing
      // down, then reparent them after the browser root exits. Kill the exact
      // isolated launcher's tree while that parent relationship still exists.
      // The timeout keeps a damaged taskkill/WMI service from hanging the test;
      // the exact DevTools-reported PID fallback below remains authoritative.
      if (Number.isInteger(child.pid) && processIsRunning(child.pid)) {
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        try {
          spawnSync(
            join(systemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", timeout: 8000 },
          );
        } catch {
          // Fall through to terminating only the captured PIDs from this run.
        }
      }
      const ids = new Set([child.pid, ...(processIds || [])].filter(Number.isInteger));
      for (const id of ids) {
        try { process.kill(id, "SIGKILL"); } catch { /* this exact browser process already exited */ }
      }
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* the browser already exited */ }
    }
  };

  let endpoint = null;
  let browserProcessIds = [];
  try {
    endpoint = await waitForDevToolsEndpoint(profileDirectory, state);
    try {
      const processInfo = await sendDevToolsCommand(
        endpoint.browserWebSocketUrl,
        "SystemInfo.getProcessInfo",
      );
      browserProcessIds = (processInfo.processInfo || [])
        .map(item => Number(item.id))
        .filter(Number.isInteger);
    } catch {
      // Browser.close is still the primary cleanup path if process info is unavailable.
    }
    const fixtureResult = options.waitForResult
      ? await options.waitForResult(endpoint, url, {
          ...options,
          profileDirectory,
        })
      : await waitForFixtureResult(endpoint, url);
    return {
      fixtureResult,
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    if (endpoint && process.platform === "win32") {
      try {
        const processInfo = await sendDevToolsCommand(
          endpoint.browserWebSocketUrl,
          "SystemInfo.getProcessInfo",
        );
        browserProcessIds = [...new Set([
          ...browserProcessIds,
          ...(processInfo.processInfo || [])
            .map(item => Number(item.id))
            .filter(Number.isInteger),
        ])];
      } catch {
        // The initial DevTools process snapshot remains an exact scoped fallback.
      }
      terminateBrowserTree(browserProcessIds);
    } else if (endpoint) {
      try {
        await sendDevToolsCommand(
          endpoint.browserWebSocketUrl,
          "Browser.close",
          {},
          { timeoutMilliseconds: 3000, resolveOnClose: true },
        );
      } catch {
        // Fall through to the PID/process-group cleanup scoped to this run.
      }
    }
    const ownedProcessIds = [child.pid, ...browserProcessIds].filter(Number.isInteger);
    await Promise.race([childClosed, delay(1500)]);
    terminateBrowserTree(browserProcessIds);
    // A detached Crashpad/renderer can retain the launcher's inherited pipe even
    // after the isolated browser root exits. Closing our pipe endpoints prevents
    // that unrelated helper lifetime from keeping the Node test process alive.
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.stdin) {
      child.stdin.destroy();
    }
    let remainingProcessIds = await waitForProcessesToExit(ownedProcessIds, 3000);
    if (remainingProcessIds.length > 0) {
      terminateBrowserTree(remainingProcessIds);
      remainingProcessIds = await waitForProcessesToExit(remainingProcessIds, 1500);
    }
    if (remainingProcessIds.length > 0) {
      throw new Error(
        `Headless browser processes did not exit after bounded cleanup: ${remainingProcessIds.join(", ")}`,
      );
    }
    await Promise.race([childClosed, delay(500)]);
    if (state.spawnError) {
      throw state.spawnError;
    }
    if (!exitResult && !endpoint) {
      throw new Error("Headless browser exited before publishing a DevTools endpoint.");
    }
  }
}

function browserVersion(browserPath) {
  // Branded Edge forwards `msedge.exe --version` into an already-running user
  // session on Windows instead of behaving like a console command. Avoid
  // perturbing (and retaining helpers under) an unrelated desktop Edge tree.
  if (process.platform === "win32" && /^msedge\.exe$/i.test(basename(browserPath))) {
    return basename(browserPath);
  }
  const result = spawnSync(browserPath, ["--version"], { encoding: "utf8", windowsHide: true });
  const version = `${result.stdout || ""} ${result.stderr || ""}`.trim();
  return version && !/opening in existing browser session/i.test(version)
    ? version
    : basename(browserPath);
}

export async function runBrowserRegression({
  rootDir = ROOT_DIR,
  extensionDir = rootDir,
  requireBrowser,
  requireMv3,
} = {}) {
  const browserPath = findSupportedBrowser();
  const required = requireBrowser ?? /^(?:1|true|yes)$/i.test(process.env.WIZMAGE_REQUIRE_BROWSER || "");
  const mv3Required = requireMv3 ?? /^(?:1|true|yes)$/i.test(process.env.WIZMAGE_REQUIRE_MV3 || "");
  if (!browserPath) {
    if (required) {
      throw new Error("No supported local Chrome, Chromium, or Edge executable was found.");
    }
    return { skipped: true, reason: "No supported local Chrome, Chromium, or Edge executable was found." };
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "wizmage-browser-regression-"));
  let fixture;
  try {
    fixture = await startFixtureServer(resolve(rootDir));
    const processResult = await runBrowserProcess(
      browserPath,
      join(temporaryRoot, "profile"),
      fixture.url,
    );
    if (!processResult.fixtureResult || processResult.fixtureResult.status !== "pass") {
      const details = processResult.fixtureResult && processResult.fixtureResult.details
        ? processResult.fixtureResult.details
        : processResult.stderr.trim().split(/\r?\n/).slice(-12).join("\n");
      throw new Error(`Runtime DOM regression failed: ${details || "The browser did not publish a test result."}`);
    }
    let mv3Smoke;
    try {
      const mv3Result = await runBrowserProcess(
        browserPath,
        join(temporaryRoot, "mv3-profile"),
        new URL("/mv3.html", fixture.url).href,
        {
          extensionPath: resolve(extensionDir),
          waitForResult: waitForMv3SmokeResult,
        },
      );
      mv3Smoke = {
        skipped: false,
        details: mv3Result.fixtureResult.details,
      };
    } catch (error) {
      if (!error.extensionUnavailable || mv3Required) {
        throw error;
      }
      mv3Smoke = { skipped: true, reason: error.message };
    }
    return {
      skipped: false,
      browserPath,
      browserVersion: browserVersion(browserPath),
      mv3Smoke,
    };
  } finally {
    if (fixture) {
      await closeFixtureServer(fixture.server);
    }
    await removeTemporaryDirectory(temporaryRoot);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
const isMainModule =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;

if (isMainModule) {
  try {
    const result = await runBrowserRegression();
    if (result.skipped) {
      console.log(`Browser regression skipped: ${result.reason}`);
    } else {
      console.log(`Browser DOM regression passed with ${result.browserVersion}.`);
      if (result.mv3Smoke && result.mv3Smoke.skipped) {
        console.log(`Browser MV3 smoke skipped: ${result.mv3Smoke.reason}`);
      } else if (result.mv3Smoke) {
        console.log(`Browser MV3 smoke passed: ${result.mv3Smoke.details}`);
      }
    }
  } catch (error) {
    console.error(`Browser regression failed: ${error.message}`);
    process.exitCode = 1;
  }
}
