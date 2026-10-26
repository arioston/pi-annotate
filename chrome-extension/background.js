/**
 * Pi Annotate - Background Service Worker
 *
 * Connects to native messaging host and forwards messages between
 * the native host (Pi) and content scripts.
 */

// Panel routing (plan 1055): the protocol and the pure routing logic.
importScripts("lib/routing.js", "panel/protocol.js");

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
  port.onMessage.addListener((msg) => router.onPortMessage(port, msg));
  port.onDisconnect.addListener(() => router.onPortDisconnect(port));
});

// Where a native request goes: the request's own tab, the last focused
// DevTools pane tab, else the active tab of the last focused normal window.
async function resolveTargetTab(requestId) {
  const choice = PiRouting.selectTargetTab({
    requestBoundTabId: requestId && requestTabs.has(requestId) ? requestTabs.get(requestId) : null,
    lastFocusedPaneTab: router.lastFocusedPaneTab(),
    isPaneBound: router.isPaneBound,
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
  for (const [requestId, session] of networkSessions) {
    if (session.tabId === tabId) networkSessions.delete(requestId);
  }
  router.noteTabEvent({ kind: "removed", tabId, windowId: removeInfo?.windowId, isWindowClosing: !!removeInfo?.isWindowClosing });
  router.onTabRemoved(tabId);
});

// Panel bindings end when the document changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  router.noteTabEvent({ kind: "updated", tabId, changeInfo });
  if (changeInfo.status === "loading") router.onTabLoading(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  router.noteTabEvent({ kind: "activated", tabId: activeInfo.tabId, windowId: activeInfo.windowId });
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-picker") {
    togglePicker();
  }
});

// Connect on startup
connectNative();
console.log("[pi-annotate] Background script loaded");
