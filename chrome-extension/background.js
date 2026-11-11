/**
 * Pi Annotate - Background Service Worker
 *
 * Connects to native messaging host and forwards messages between
 * the native host (Pi) and content scripts.
 */

// Panel routing (plan 1055): the protocol and the pure routing logic.
importScripts("lib/routing.js", "panel/protocol.js");
// Full-page capture (plan 1169): the planners and the store. The PDF writer is
// loaded by the result page only.
importScripts("lib/capture-plan.js", "capture/store.js");

let nativePort = null;
let pendingPing = null;
let lastNativeDisconnectError = "";
const requestTabs = new Map();
const networkSessions = new Map();
const MAX_NETWORK_REQUESTS = 200;
let browserIdentityPromise = null;

function sanitizeNetworkUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const key of parsed.searchParams.keys()) {
      if (/(token|key|secret|auth|password|passwd|session|signature|code|credential|jwt|sso|ticket)/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString().slice(0, 2048);
  } catch {
    return String(rawUrl || "").slice(0, 2048);
  }
}

function startNetworkCapture(requestId, tabId) {
  if (!requestId || !Number.isInteger(tabId)) return;
  // A tab only has one active annotation UI. Drop capture state belonging to
  // a request replaced by a newer client session on that same tab.
  for (const [existingId, session] of networkSessions) {
    if (session.tabId === tabId && existingId !== requestId) networkSessions.delete(existingId);
  }
  if (networkSessions.has(requestId)) return;
  networkSessions.set(requestId, {
    tabId,
    startedAt: Date.now(),
    requests: new Map(),
    truncated: false,
  });
}

function beginNetworkRequest(details) {
  for (const session of networkSessions.values()) {
    if (session.tabId !== details.tabId) continue;
    if (!session.requests.has(details.requestId) && session.requests.size >= MAX_NETWORK_REQUESTS) {
      session.truncated = true;
      continue;
    }
    session.requests.set(details.requestId, {
      url: sanitizeNetworkUrl(details.url),
      method: details.method || "GET",
      type: details.type || "other",
      startedAtMs: Math.max(0, Math.round(details.timeStamp - session.startedAt)),
      startedAtEpoch: details.timeStamp,
    });
  }
}

function finishNetworkRequest(details, error) {
  for (const session of networkSessions.values()) {
    if (session.tabId !== details.tabId) continue;
    const entry = session.requests.get(details.requestId);
    if (!entry) continue;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAtEpoch));
    if (typeof details.statusCode === "number") entry.statusCode = details.statusCode;
    if (typeof details.fromCache === "boolean") entry.fromCache = details.fromCache;
    if (error) entry.error = String(error).slice(0, 300);
  }
}

function finishNetworkCapture(requestId) {
  const session = networkSessions.get(requestId);
  if (!session) return null;
  networkSessions.delete(requestId);
  const endedAt = Date.now();
  const requests = [...session.requests.values()]
    .map(({ startedAtEpoch: _privateTimestamp, ...request }) => request)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  return {
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - session.startedAt,
    truncated: session.truncated,
    requests,
  };
}

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(beginNetworkRequest, { urls: ["<all_urls>"] });
  chrome.webRequest.onCompleted.addListener(
    (details) => finishNetworkRequest(details),
    { urls: ["<all_urls>"] },
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => finishNetworkRequest(details, details.error || "request_failed"),
    { urls: ["<all_urls>"] },
  );
}

function detectBrowserName() {
  const brands = navigator.userAgentData?.brands || [];
  const brand = brands.find((item) => /Edge|Chrome/i.test(item.brand))
    || brands.find((item) => /Chromium/i.test(item.brand))
    || brands.find((item) => !/Not.A.Brand/i.test(item.brand));
  if (brand?.brand) return brand.brand;
  if (/Edg\//.test(navigator.userAgent)) return "Microsoft Edge";
  if (/Chromium\//.test(navigator.userAgent)) return "Chromium";
  if (/Chrome\//.test(navigator.userAgent)) return "Google Chrome";
  return "Chrome/Chromium";
}

// Same label grammar as Surf targets and the Dalinar rendezvous contract.
const PROFILE_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function getBrowserIdentity() {
  if (browserIdentityPromise) return browserIdentityPromise;
  browserIdentityPromise = chrome.storage.local.get(["browserId", "browserName", "profileLabel"]).then(async (stored) => {
    const id = typeof stored.browserId === "string" && stored.browserId
      ? stored.browserId
      : crypto.randomUUID();
    const name = typeof stored.browserName === "string" && stored.browserName.trim()
      ? stored.browserName.trim()
      : `${detectBrowserName()} ${id.slice(0, 6)}`;
    await chrome.storage.local.set({ browserId: id, browserName: name });
    const identity = { id, name, browser: detectBrowserName() };
    // An absent or invalid label announces this profile unlabeled.
    if (typeof stored.profileLabel === "string" && PROFILE_LABEL_PATTERN.test(stored.profileLabel)) identity.label = stored.profileLabel;
    return identity;
  });
  return browserIdentityPromise;
}

async function registerBrowser(port = nativePort) {
  const identity = await getBrowserIdentity();
  if (!port || nativePort !== port) return identity;
  port.postMessage({ type: "REGISTER_BROWSER", ...identity });
  return identity;
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// All bindings live in memory. A service-worker restart drops them; views
// connect again and the content script rebuilds its record (see routing.js).
const router = PiRouting.createRouter({
  panelUrl: chrome.runtime.getURL("panel/panel.html"),
  randomHex,
  postToPort: (port, msg) => {
    try { port.postMessage(msg); } catch (err) { /* the view is gone */ }
  },
  closePort: (port) => {
    try { port.disconnect(); } catch (err) { /* already closed */ }
  },
  sendToTab: (tabId, msg, target) => chrome.tabs.sendMessage(tabId, msg, target).catch(() => {}),
  sendToNative: (msg) => {
    sendToNative(msg);
    return !!nativePort;
  },
  nativeConnected: () => !!nativePort,
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pi-pane" && port.name !== "pi-frame") return;
  port.onMessage.addListener((msg) => {
    const outcome = router.onPortMessage(port, msg);
    // A shown pane with no session on its tab asks for one (PANE_START).
    if (outcome?.ok && outcome.start) startUnmanagedSession(outcome.start.tabId);
    // Smoke check S0: show why a view hello was refused. Never log the token.
    if (outcome && outcome.ok === false && (msg?.type === "PANE_HELLO" || msg?.type === "FRAME_HELLO")) {
      const s = port.sender || {};
      console.warn("[pi-annotate] View hello refused:", msg.type, outcome.reason, {
        url: s.url, origin: s.origin, tabId: s.tab?.id, frameId: s.frameId, documentId: s.documentId,
      });
    }
  });
  port.onDisconnect.addListener(() => router.onPortDisconnect(port));
});

// Where a native request goes: the request's own tab, the last focused
// DevTools pane tab, else the active tab of the last focused normal window.
async function resolveTargetTab(requestId) {
  const choice = PiRouting.selectTargetTab({
    requestBoundTabId: requestId && requestTabs.has(requestId) ? requestTabs.get(requestId) : null,
    lastFocusedPaneTab: router.lastFocusedPaneTab(),
    isPaneBound: router.isPaneBound,
    boundPaneTabs: router.boundPaneTabs,
  });
  if (choice.source !== "window") {
    try {
      const tab = await chrome.tabs.get(choice.tabId);
      if (tab?.id) return tab;
    } catch (err) {
      // The tab is gone. Use the focused window.
    }
  }
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!win?.id) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab || null;
  } catch (err) {
    return null;
  }
}

function getRequestId(msg) {
  return typeof msg.requestId === "number" ? msg.requestId : (typeof msg.id === "number" ? msg.id : null);
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url);
}

function resolvePendingPing(result) {
  if (!pendingPing) return;
  clearTimeout(pendingPing.timeoutId);
  pendingPing.resolve(result);
  pendingPing = null;
}

function pingNative() {
  if (!nativePort) {
    return Promise.resolve({
      connected: false,
      error: lastNativeDisconnectError || "Native host not connected",
    });
  }

  if (pendingPing) {
    return pendingPing.promise;
  }

  let resolvePing;
  const promise = new Promise((resolve) => {
    resolvePing = resolve;
  });

  const timeoutId = setTimeout(() => {
    if (!pendingPing || pendingPing.promise !== promise) return;
    pendingPing = null;
    resolvePing({ connected: false, error: "Timeout - native host not responding" });
  }, 3000);

  pendingPing = { promise, resolve: resolvePing, timeoutId };

  try {
    nativePort.postMessage({ type: "PING" });
  } catch (err) {
    clearTimeout(timeoutId);
    pendingPing = null;
    resolvePing({
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return promise;
}

function sendToNative(msg) {
  if (!nativePort) {
    console.error("[pi-annotate] Cannot send to native host - not connected");
    return;
  }
  try {
    const requestId = getRequestId(msg);
    if (msg?.type === "CANCEL" && requestId) finishNetworkCapture(requestId);
    nativePort.postMessage(msg);
  } catch (err) {
    console.error("[pi-annotate] Failed to send to native host:", err);
  }
}

// Start an unmanaged session (no request ID) for a shown DevTools pane.
async function startUnmanagedSession(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || isRestrictedUrl(tab.url)) return;
    await sendToContentScript(tabId, { type: "START_ANNOTATION" });
  } catch (err) {
    // The tab is gone; the pane will reconnect or close.
  }
}

// Send message to content script, injecting it first if needed
async function sendToContentScript(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    console.log("[pi-annotate] Content script not found, injecting...");
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: chrome.runtime.getManifest().content_scripts[0].js,
      });
      await new Promise(r => setTimeout(r, 100));
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (injectErr) {
      console.error("[pi-annotate] Failed to inject:", injectErr.message);
      const requestId = getRequestId(msg);
      if (requestId) {
        requestTabs.delete(requestId);
        sendToNative({ type: "CANCEL", requestId, reason: `Cannot inject into tab: ${injectErr.message}` });
      }
    }
  }
}

// Wait for a tab to finish loading, then inject content script
function injectAfterLoad(tabId, msg, requestId) {
  let timeoutId = null;
  const listener = (updatedTabId, info) => {
    if (updatedTabId === tabId && info.status === "complete") {
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => {
        if (requestId) requestTabs.set(requestId, tabId);
        sendToContentScript(tabId, msg);
      }, 150);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);

  timeoutId = setTimeout(() => {
    chrome.tabs.onUpdated.removeListener(listener);
    console.log("[pi-annotate] Navigation timeout - listener removed");
    if (requestId) {
      requestTabs.delete(requestId);
      sendToNative({ type: "CANCEL", requestId, reason: "navigation_timeout" });
    }
  }, 30000);
}

// Toggle annotation picker on active tab (used by popup + keyboard shortcut)
async function togglePicker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || isRestrictedUrl(tab.url)) {
      console.log("[pi-annotate] Cannot toggle picker: no valid tab");
      return;
    }
    await sendToContentScript(tab.id, { type: "TOGGLE_PICKER" });
  } catch (err) {
    console.error("[pi-annotate] Toggle picker failed:", err);
  }
}

// Toggle X-ray measurements on the active tab (popup + keyboard shortcut).
// X-ray needs no annotation session and no native host.
async function toggleXray() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || isRestrictedUrl(tab.url)) {
      console.log("[pi-annotate] Cannot toggle X-ray: no valid tab");
      return;
    }
    await sendToContentScript(tab.id, { type: "TOGGLE_XRAY" });
  } catch (err) {
    console.error("[pi-annotate] Toggle X-ray failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Full-page capture (plan 1169)
//
// One capture runs at a time. The service worker owns the run state in memory.
// The page module (capture/page.js) is the only code that changes the page and
// the only code that restores it.
// ─────────────────────────────────────────────────────────────────────────

const CAPTURE_INTERVAL_MS = 550; // Chrome allows 2 tab captures each second
let captureRun = null; // { tabId, aborted }
let lastCaptureAt = 0;

// Like sendToContentScript, but returns the answer of the page. Injects on a miss.
async function requestContentScript(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: chrome.runtime.getManifest().content_scripts[0].js,
    });
    await new Promise((r) => setTimeout(r, 100));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function isActiveTabOf(tabId, windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id === tabId;
}

function takePicture(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) reject(new Error(chrome.runtime.lastError?.message || "Capture failed"));
      else resolve(dataUrl);
    });
  });
}

async function waitForCaptureSlot() {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// The one capture loop (plans 1169 and 1170). It scrolls the tab, takes a
// picture of each step, and returns the tiles. It always asks the page to
// restore (CAPTURE_PAGE_END) before it returns or throws.
//   options.shouldStop()  true when the run must stop (abort flag, tab change)
//   options.isAllowed()   async; true when the tab may be captured now
//   options.onProgress(n) called after each picture
//   options.fromSession   true for a capture that an annotation session asked for
// Returns { metrics, tiles: [{ dataUrl, src, destY }], partial }.
async function captureTiles(tabId, windowId, options) {
  const opts = options || {};
  const stopped = () => opts.shouldStop && opts.shouldStop();
  const allowed = async () => (await isActiveTabOf(tabId, windowId)) && (!opts.isAllowed || (await opts.isAllowed()));
  try {
    const metrics = await requestContentScript(tabId, { type: "CAPTURE_PAGE_BEGIN", fromSession: !!opts.fromSession });
    if (!metrics || metrics.error) throw new Error(metrics?.error || "The page did not answer");
    const dpr = metrics.dpr || 1;
    const tiles = [];
    let covered = 0;
    let contentHeight = metrics.contentHeight;
    let visible = metrics.visible;
    let partial = null;
    for (;;) {
      if (stopped()) throw new Error("Capture stopped");
      partial = PiCapturePlan.stopReason(tiles.length, covered / dpr, contentHeight);
      if (partial) break;
      const position = PiCapturePlan.nextPosition(covered, visible.height, contentHeight, dpr);
      if (position === null) break;
      const moved = await requestContentScript(tabId, { type: "CAPTURE_PAGE_STEP", position, hideFloating: tiles.length > 0 });
      if (!moved || moved.error) throw new Error(moved?.error || "The page did not answer");
      contentHeight = moved.contentHeight;
      visible = moved.visible || visible;
      if (!(await allowed())) throw new Error("The tab changed during the capture");
      await waitForCaptureSlot();
      let dataUrl;
      try {
        dataUrl = await takePicture(windowId);
      } finally {
        lastCaptureAt = Date.now();
      }
      if (stopped() || !(await allowed())) throw new Error("The tab changed during the capture");
      const tile = PiCapturePlan.recordTile({ reported: moved.scrollTop, visible, contentHeight, dpr, covered });
      if (!tile) break;
      tiles.push({ dataUrl, src: tile.src, destY: tile.destY });
      covered = tile.covered;
      if (opts.onProgress) opts.onProgress(tiles.length);
    }
    return { metrics, tiles, partial };
  } finally {
    try {
      await requestContentScript(tabId, { type: "CAPTURE_PAGE_END" });
    } catch (err) {
      console.log("[pi-annotate] Capture restore failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

function flashBadge(text, ms) {
  chrome.action.setBadgeText({ text });
  if (ms) setTimeout(() => chrome.action.setBadgeText({ text: "" }), ms);
}

// Capture the whole page of the active tab and open the result tab.
async function captureFullPage() {
  if (captureRun) {
    console.log("[pi-annotate] A capture is already running");
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || isRestrictedUrl(tab.url)) {
      console.log("[pi-annotate] Cannot capture: no valid tab");
      flashBadge("!", 3000);
      return;
    }
    captureRun = { tabId: tab.id, aborted: false };
    await PiCaptureStore.cleanup().catch(() => {});
    const result = await captureTiles(tab.id, tab.windowId, {
      shouldStop: () => captureRun.aborted,
      onProgress: (n) => flashBadge(String(n)),
    });
    const id = await PiCaptureStore.save({
      url: result.metrics.url,
      title: result.metrics.title,
      dpr: result.metrics.dpr,
      partial: result.partial,
      tiles: result.tiles.map((t) => ({ blob: dataUrlToBlob(t.dataUrl), src: t.src, destY: t.destY })),
    });
    flashBadge("");
    await chrome.tabs.create({
      url: chrome.runtime.getURL("capture/result.html") + "?id=" + id,
      index: tab.index + 1,
      windowId: tab.windowId,
    });
  } catch (err) {
    console.error("[pi-annotate] Full-page capture failed:", err instanceof Error ? err.message : String(err));
    flashBadge("!", 3000);
  } finally {
    captureRun = null;
    if (!(await chrome.action.getBadgeText({}).catch(() => "")).startsWith("!")) flashBadge("");
  }
}

// A tab change, a navigation, or a close stops a running capture.
function stopCaptureFor(tabId) {
  if (captureRun && (tabId === undefined || captureRun.tabId === tabId)) captureRun.aborted = true;
}

// Delete captures older than 24 hours when the service worker starts.
PiCaptureStore.cleanup().catch(() => {});

function connectNative() {
  if (nativePort) return;

  console.log("[pi-annotate] Connecting to native host...");
  const port = chrome.runtime.connectNative("com.pi.annotate");
  nativePort = port;

  port.onMessage.addListener((msg) => {
    // A host that lists "format-result" can format a prepared result.
    router.onNativeMessage(msg);

    // Answer to FORMAT_RESULT. It never starts an annotation or a tab query.
    if (msg?.type === "FORMATTED_RESULT") {
      router.onFormattedResult(msg);
      return;
    }

    if (msg?.type === "PONG") {
      lastNativeDisconnectError = "";
      resolvePendingPing({ connected: true });
      return;
    }

    if (msg?.type === "BROWSER_REGISTERED") {
      lastNativeDisconnectError = "";
      return;
    }

    console.log("[pi-annotate] From native host:", msg);

    resolveTargetTab(getRequestId(msg)).then((targetTab) => {
      if (!targetTab?.id) {
        console.log("[pi-annotate] No active tab found");
        const requestId = getRequestId(msg);
        if (requestId) {
          sendToNative({ type: "CANCEL", requestId, reason: "No active browser tab found" });
        }
        return;
      }

      const requestId = getRequestId(msg);
      const tabId = requestId && requestTabs.has(requestId) ? requestTabs.get(requestId) : targetTab.id;
      const currentUrl = targetTab.url;

      if (msg.type === "START_ANNOTATION") {
        const restricted = isRestrictedUrl(currentUrl);

        if (msg.url && (restricted || currentUrl !== msg.url)) {
          if (restricted) {
            console.log("[pi-annotate] Opening new tab:", msg.url);
            chrome.tabs.create({ url: msg.url }, (tab) => {
              if (chrome.runtime.lastError) {
                console.error("[pi-annotate] Failed to create tab:", chrome.runtime.lastError.message);
                sendToNative({ type: "CANCEL", requestId, reason: chrome.runtime.lastError.message });
                return;
              }
              if (msg.captureNetwork) startNetworkCapture(requestId, tab.id);
              injectAfterLoad(tab.id, msg, requestId);
            });
          } else {
            console.log("[pi-annotate] Navigating to:", msg.url);
            if (msg.captureNetwork) startNetworkCapture(requestId, tabId);
            chrome.tabs.update(tabId, { url: msg.url }, (tab) => {
              if (chrome.runtime.lastError) {
                console.error("[pi-annotate] Failed to navigate:", chrome.runtime.lastError.message);
                sendToNative({ type: "CANCEL", requestId, reason: chrome.runtime.lastError.message });
                return;
              }
              injectAfterLoad(tab.id, msg, requestId);
            });
          }
        } else if (restricted) {
          console.log("[pi-annotate] Cannot annotate restricted tab:", currentUrl);
          if (requestId) {
            sendToNative({ type: "CANCEL", requestId, reason: "Current tab cannot be annotated (restricted URL). Provide a URL." });
          }
        } else {
          console.log("[pi-annotate] Activating on current tab:", currentUrl);
          if (requestId) requestTabs.set(requestId, tabId);
          if (msg.captureNetwork) startNetworkCapture(requestId, tabId);
          sendToContentScript(tabId, msg);
        }
      } else {
        if (msg.type === "CANCEL" && requestId) finishNetworkCapture(requestId);
        sendToContentScript(tabId, msg);
      }
    });
  });

  registerBrowser(port).catch((err) => {
    console.error("[pi-annotate] Failed to register browser profile:", err);
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected unexpectedly";
    console.log("[pi-annotate] Native host disconnected", error);
    lastNativeDisconnectError = error;
    resolvePendingPing({ connected: false, error });
    if (nativePort === port) {
      nativePort = null;
      router.onNativeDisconnect();
    }
    setTimeout(connectNative, 2000);
  });
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[pi-annotate] Message:", msg.type);

  if (msg.type === "CHECK_CONNECTION") {
    pingNative().then(sendResponse);
    return true;
  }

  if (msg.type === "TOGGLE_PICKER") {
    togglePicker();
    return;
  }

  if (msg.type === "CAPTURE_FULL_PAGE") {
    captureFullPage();
    return;
  }

  if (msg.type === "CAPTURE_PAGE_ABORT") {
    // Only the content script of the captured tab can abort.
    if (sender.tab?.id !== undefined) stopCaptureFor(sender.tab.id);
    return;
  }

  if (msg.type === "TOGGLE_XRAY") {
    toggleXray();
    return;
  }

  if (msg.type === "GET_BROWSER_IDENTITY") {
    getBrowserIdentity().then(sendResponse, (err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (msg.type === "SET_BROWSER_NAME") {
    const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 80) : "";
    if (!name) {
      sendResponse({ error: "Profile name cannot be empty" });
      return;
    }
    getBrowserIdentity().then(async (identity) => {
      await chrome.storage.local.set({ browserName: name });
      browserIdentityPromise = Promise.resolve({ ...identity, name });
      await registerBrowser();
      sendResponse({ ...identity, name });
    }).catch((err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (msg.type === "SET_PROFILE_LABEL") {
    const label = typeof msg.label === "string" ? msg.label.trim() : "";
    if (label && !PROFILE_LABEL_PATTERN.test(label)) {
      sendResponse({ error: "Profile label must be lowercase letters, digits, or dashes, start with a letter, and be at most 32 characters" });
      return;
    }
    getBrowserIdentity().then(async (identity) => {
      const next = { ...identity };
      if (label) {
        await chrome.storage.local.set({ profileLabel: label });
        next.label = label;
      } else {
        await chrome.storage.local.remove("profileLabel");
        delete next.label;
      }
      browserIdentityPromise = Promise.resolve(next);
      await registerBrowser();
      sendResponse(next);
    }).catch((err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  const requestId = getRequestId(msg);

  if (msg.type === PiPanelProtocol.TYPES.PANEL_SESSION) {
    router.registerSession(sender, msg.generation);
    return;
  }

  if (msg.type === PiPanelProtocol.TYPES.PANEL_SESSION_END) {
    router.endSession(sender, msg.generation);
    return;
  }

  if (msg.type === PiPanelProtocol.TYPES.FRAME_TOKEN_REQUEST) {
    const issued = router.requestFrameToken(sender, msg.generation);
    sendResponse(issued.ok ? { token: issued.token } : { error: issued.reason });
    return;
  }

  if (msg.type === PiPanelProtocol.TYPES.STATE) {
    router.relayState(sender, msg);
    return;
  }

  if (msg.type === PiPanelProtocol.TYPES.PREPARED_RESULT) {
    router.onPreparedResult(sender, msg);
    return;
  }

  if (msg.type === "CAPTURE_SCREENSHOT") {
    if (!sender.tab?.windowId) {
      console.log("[pi-annotate] Screenshot failed: No window ID");
      sendResponse({ error: "No window ID" });
      return true;
    }
    // captureVisibleTab(windowId) captures the active tab of that window, which
    // is not always the annotated tab. The router checks before and after.
    router.guardedCapture(sender, msg.generation, {
      getActiveTabId: async (windowId) => {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        return tab?.id ?? null;
      },
      capture: (windowId) => new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            console.log("[pi-annotate] Screenshot error:", chrome.runtime.lastError.message);
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            console.log("[pi-annotate] Screenshot captured, size:", dataUrl?.length || 0);
            resolve({ dataUrl });
          }
        });
      }),
    }).then(sendResponse, (err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  if (["ANNOTATIONS_COMPLETE", "CANCEL"].includes(msg.type)) {
    if (requestId) requestTabs.delete(requestId);
    if (msg.type === "ANNOTATIONS_COMPLETE" && requestId && msg.result) {
      const network = finishNetworkCapture(requestId);
      if (network) msg.result.network = network;
    }
    console.log("[pi-annotate] Forwarding to native host:", msg.type);
    // The session generation is for the capture guard; the host and the agent never see it.
    sendToNative(PiRouting.toNativeCompletion(msg));
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  stopCaptureFor(tabId);
  for (const [requestId, session] of networkSessions) {
    if (session.tabId === tabId) networkSessions.delete(requestId);
  }
  router.noteTabEvent({ kind: "removed", tabId, windowId: removeInfo?.windowId, isWindowClosing: !!removeInfo?.isWindowClosing });
  router.onTabRemoved(tabId);
});

// Panel bindings end when the document changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  router.noteTabEvent({ kind: "updated", tabId, changeInfo });
  if (changeInfo.status === "loading") stopCaptureFor(tabId);
  if (changeInfo.status === "loading") router.onTabLoading(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (captureRun && activeInfo.tabId !== captureRun.tabId) stopCaptureFor(captureRun.tabId);
  router.noteTabEvent({ kind: "activated", tabId: activeInfo.tabId, windowId: activeInfo.windowId });
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-picker") {
    togglePicker();
  } else if (command === "toggle-xray") {
    toggleXray();
  } else if (command === "capture-full-page") {
    captureFullPage();
  }
});

// Connect on startup
connectNative();
console.log("[pi-annotate] Background script loaded");
