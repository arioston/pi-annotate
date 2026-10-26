/**
 * Pi Annotate - panel routing (classic script, global PiRouting).
 *
 * Pure logic for the background service worker: which view (DevTools pane or
 * iframe) belongs to which tab, who may capture the screen, and how a prepared
 * result travels to the native host and back. It makes no chrome.* call. The
 * background gives it the side effects through `deps`, so Node tests can run it.
 *
 * All state lives in memory. A service-worker restart drops it. Views connect
 * again, and the content script rebuilds its record from the next message.
 */
(function (root) {
  var ACTIVATE_MESSAGE = "Activate the annotated tab, then try again";
  var CHANGED_MESSAGE = "The tab changed during the capture. Try again";
  var HOST_OLD_MESSAGE = "Update the native host to copy output";
  var EXTENSION_URL = /^(chrome|moz|edge)-extension:/;

  function isInteger(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }

  function startsWithUrl(url, base) {
    if (typeof url !== "string" || typeof base !== "string") return false;
    if (url.indexOf(base) !== 0) return false;
    var rest = url.slice(base.length);
    return rest === "" || rest.charAt(0) === "?" || rest.charAt(0) === "#";
  }

  // The top frame of a normal web page (not an extension page).
  function isPageTopFrame(sender) {
    return !!(sender && sender.tab && isInteger(sender.tab.id) && sender.frameId === 0
      && typeof sender.url === "string" && !EXTENSION_URL.test(sender.url));
  }

  // Pick the PNG data URLs of a result. WebP reference attachments are left out.
  function collectPngImages(result) {
    var images = [];
    var PNG = "data:image/png;base64,";
    function add(label, dataUrl) {
      if (typeof dataUrl === "string" && dataUrl.indexOf(PNG) === 0) images.push({ label: label, dataUrl: dataUrl });
    }
    if (!result || typeof result !== "object") return images;
    add("Full screenshot", result.screenshot);
    if (Array.isArray(result.screenshots)) {
      result.screenshots.forEach(function (shot, i) {
        add("Element " + (shot && isInteger(shot.index) ? shot.index : i + 1), shot && shot.dataUrl);
      });
    }
    if (result.editCapture && typeof result.editCapture === "object") {
      add("Before", result.editCapture.beforeScreenshot);
      add("After", result.editCapture.afterScreenshot);
    }
    return images;
  }

  /**
   * Choose where a native START_ANNOTATION request goes.
   * Order: an existing request binding, then the last focused DevTools pane
   * tab (if it is still bound), then the active tab of the last focused
   * normal window.
   */
  function selectTargetTab(input) {
    if (isInteger(input.requestBoundTabId)) return { source: "request", tabId: input.requestBoundTabId };
    var pane = input.lastFocusedPaneTab;
    if (isInteger(pane) && typeof input.isPaneBound === "function" && input.isPaneBound(pane)) {
      return { source: "pane", tabId: pane };
    }
    // One bound pane in this profile: use its tab even if it never had focus.
    // With two or more, there is no safe guess; use the focused window.
    var bound = typeof input.boundPaneTabs === "function" ? input.boundPaneTabs() : [];
    if (bound.length === 1 && isInteger(bound[0])) return { source: "only-pane", tabId: bound[0] };
    return { source: "window" };
  }

  // A completion from the content script carries the session generation for
  // the capture guard. The native host and the agent never see it. A session
  // with no request ID (popup or shortcut) completes the same way as before.
  function toNativeCompletion(msg) {
    var copy = {};
    Object.keys(msg).forEach(function (key) { if (key !== "generation") copy[key] = msg[key]; });
    return copy;
  }

  function createRouter(deps) {
    // Read when the router is made, so the load order of the two scripts does
    // not matter as long as both are loaded first.
    var T = root.PiPanelProtocol.TYPES;
    var panelUrl = deps.panelUrl;
    var sessions = {};        // tabId -> { tabId, documentId, generation }
    var tokens = {};          // token -> { tabId, documentId, generation }
    var panes = {};           // tabId -> port
    var frames = {};          // tabId -> { port, documentId }
    var portInfo = [];        // [{ port, kind, tabId }]
    var copies = {};          // copyId -> { tabId, port, documentId, revision, images }
    var captures = [];        // active capture watches
    var lastFocusedPaneTab = null;
    var formatCapability = false;

    function infoOf(port) {
      for (var i = 0; i < portInfo.length; i++) if (portInfo[i].port === port) return portInfo[i];
      return null;
    }
    function dropInfo(port) {
      portInfo = portInfo.filter(function (entry) { return entry.port !== port; });
    }
    function targetOf(tabId) {
      var record = sessions[tabId];
      return record && record.documentId ? { documentId: record.documentId } : { frameId: 0 };
    }
    function sendToContent(tabId, msg) {
      return deps.sendToTab(tabId, msg, targetOf(tabId));
    }
    function currentView(tabId) {
      if (panes[tabId]) return { kind: "pane", port: panes[tabId] };
      if (frames[tabId]) return { kind: "frame", port: frames[tabId].port };
      return null;
    }
    function boundKind(tabId) {
      var view = currentView(tabId);
      return view ? view.kind : null;
    }

    // ── content-script session record ────────────────────────────────
    // Accept a record only from the top frame of a web page.
    function registerSession(sender, generation) {
      if (!isPageTopFrame(sender) || !isInteger(generation) || generation < 0) return { ok: false, reason: "bad-sender" };
      var tabId = sender.tab.id;
      var existing = sessions[tabId];
      if (existing && existing.documentId === sender.documentId && generation <= existing.generation) {
        return { ok: true, record: existing, unchanged: true };
      }
      sessions[tabId] = { tabId: tabId, documentId: sender.documentId, generation: generation };
      // The binding of an older document is no longer current.
      if (existing && existing.documentId !== sender.documentId) revokeViewState(tabId, false);
      // Tell the new session which view is bound, so it can show or skip the iframe.
      var kind = boundKind(tabId);
      if (kind) sendToContent(tabId, { type: T.VIEW_BOUND, kind: kind });
      return { ok: true, record: sessions[tabId] };
    }

    // Use the record of the tab. When it is missing (the worker restarted),
    // rebuild it from the top-frame sender. A document mismatch is never rebuilt.
    function ensureRecord(sender, generation) {
      if (!isPageTopFrame(sender) || !isInteger(generation) || generation < 0) return { ok: false, reason: "bad-sender" };
      var tabId = sender.tab.id;
      var record = sessions[tabId];
      if (!record) {
        record = sessions[tabId] = { tabId: tabId, documentId: sender.documentId, generation: generation };
        return { ok: true, record: record, rebuilt: true };
      }
      if (record.documentId !== sender.documentId) return { ok: false, reason: "old-document" };
      if (generation < record.generation) return { ok: false, reason: "old-generation" };
      if (generation > record.generation) record.generation = generation;
      return { ok: true, record: record };
    }

    function endSession(sender, generation) {
      var checked = ensureRecord(sender, generation);
      if (!checked.ok) return checked;
      revokeViewState(checked.record.tabId, true);
      delete sessions[checked.record.tabId];
      return { ok: true };
    }

    // ── pane binding ─────────────────────────────────────────────────
    // Nothing is bound until a valid hello arrives on the port.
    function bindPane(port, hello) {
      var sender = port && port.sender;
      var ok = sender && !sender.tab && startsWithUrl(sender.url, panelUrl)
        && hello && hello.type === T.PANE_HELLO && isInteger(hello.tabId);
      if (!ok) {
        deps.closePort(port);
        return { ok: false, reason: "bad-pane" };
      }
      var tabId = hello.tabId;
      var old = panes[tabId];
      if (old && old !== port) {
        dropInfo(old);
        deps.closePort(old);
      }
      panes[tabId] = port;
      dropInfo(port);
      portInfo.push({ port: port, kind: "pane", tabId: tabId });
      // A pane replaces an iframe view of the same tab.
      var frame = frames[tabId];
      if (frame) {
        delete frames[tabId];
        dropInfo(frame.port);
        deps.closePort(frame.port);
      }
      sendToContent(tabId, { type: T.VIEW_BOUND, kind: "pane" });
      return { ok: true };
    }

    function paneFocus(port) {
      var info = infoOf(port);
      if (!info || info.kind !== "pane" || panes[info.tabId] !== port) return { ok: false };
      lastFocusedPaneTab = info.tabId;
      return { ok: true };
    }

    // ── fallback frame binding (owned-frame proof) ───────────────────
    function requestFrameToken(sender, generation) {
      var checked = ensureRecord(sender, generation);
      if (!checked.ok) return checked;
      var record = checked.record;
      // One outstanding token for each tab.
      Object.keys(tokens).forEach(function (t) { if (tokens[t].tabId === record.tabId) delete tokens[t]; });
      var token = deps.randomHex(32);
      tokens[token] = { tabId: record.tabId, documentId: record.documentId, generation: record.generation };
      return { ok: true, token: token };
    }

    function bindFrame(port, hello) {
      var sender = port && port.sender;
      var entry = hello && typeof hello.token === "string" && hello.type === T.FRAME_HELLO ? tokens[hello.token] : null;
      var record = entry ? sessions[entry.tabId] : null;
      var ok = entry && sender && sender.tab && sender.tab.id === entry.tabId
        && isInteger(sender.frameId) && sender.frameId !== 0
        && startsWithUrl(sender.url, panelUrl)
        && record && record.documentId === entry.documentId;
      if (!ok) {
        deps.closePort(port);
        return { ok: false, reason: "bad-frame" };
      }
      delete tokens[hello.token];
      var tabId = entry.tabId;
      var old = frames[tabId];
      if (old && old.port !== port) {
        dropInfo(old.port);
        deps.closePort(old.port);
      }
      frames[tabId] = { port: port, documentId: entry.documentId };
      dropInfo(port);
      portInfo.push({ port: port, kind: "frame", tabId: tabId });
      deps.postToPort(port, { type: T.HELLO_ACK });
      // The pane wins when both exist. The content script is already told.
      if (!panes[tabId]) sendToContent(tabId, { type: T.VIEW_BOUND, kind: "frame" });
      return { ok: true };
    }

    // ── port events ──────────────────────────────────────────────────
    function onPortMessage(port, msg) {
      if (!msg || typeof msg !== "object") return { ok: false };
      var info = infoOf(port);
      if (msg.type === T.PANE_HELLO) return bindPane(port, msg);
      if (msg.type === T.FRAME_HELLO) return bindFrame(port, msg);
      if (!info) {
        deps.closePort(port);
        return { ok: false, reason: "unbound-port" };
      }
      if (msg.type === T.PANE_FOCUS) return paneFocus(port);
      if (msg.type === T.ACTION) return relayAction(port, info, msg);
      return { ok: false, reason: "unknown-message" };
    }

    function onPortDisconnect(port) {
      var info = infoOf(port);
      dropInfo(port);
      if (!info) return;
      if (info.kind === "pane" && panes[info.tabId] === port) {
        delete panes[info.tabId];
        failCopiesOf(info.tabId, port, "The DevTools pane closed. Prepare again");
        sendToContent(info.tabId, { type: T.VIEW_UNBOUND, kind: "pane" });
      } else if (info.kind === "frame" && frames[info.tabId] && frames[info.tabId].port === port) {
        delete frames[info.tabId];
        failCopiesOf(info.tabId, port, "The panel closed. Prepare again");
        sendToContent(info.tabId, { type: T.VIEW_UNBOUND, kind: "frame" });
      }
    }

    // A view's ACTION goes to the content script of the tab, only for the
    // current bound view and the current document.
    function relayAction(port, info, msg) {
      var view = currentView(info.tabId);
      var record = sessions[info.tabId];
      if (!view || view.port !== port || !record) return { ok: false, reason: "not-current" };
      if (info.kind === "frame" && frames[info.tabId].documentId !== record.documentId) return { ok: false, reason: "old-document" };
      var checked = root.PiPanelProtocol.validateAction({ generation: msg.generation, name: msg.name, args: msg.args }, {});
      if (!checked.ok) return { ok: false, reason: checked.reason };
      if (checked.action.generation !== record.generation) return { ok: false, reason: "stale-generation" };
      deps.sendToTab(info.tabId, {
        type: T.ACTION,
        generation: checked.action.generation,
        name: checked.action.name,
        args: checked.action.args,
      }, { documentId: record.documentId });
      return { ok: true };
    }

    // ── content -> view relay ────────────────────────────────────────
    function relayState(sender, msg) {
      var validated = root.PiPanelProtocol.validateState(msg);
      if (!validated.ok) return { ok: false, reason: validated.reason };
      var checked = ensureRecord(sender, msg.generation);
      if (!checked.ok) return checked;
      var view = currentView(checked.record.tabId);
      if (!view) return { ok: false, reason: "no-view" };
      deps.postToPort(view.port, {
        type: T.STATE,
        generation: msg.generation,
        revision: msg.revision,
        session: msg.session,
      });
      return { ok: true };
    }

    function viewError(view, revision, message) {
      deps.postToPort(view.port, { type: T.PREPARED, preparedId: "error", revision: revision, error: message });
    }

    // ── format correlation ───────────────────────────────────────────
    function onPreparedResult(sender, msg) {
      var checked = ensureRecord(sender, msg && msg.generation);
      if (!checked.ok) return checked;
      var record = checked.record;
      var view = currentView(record.tabId);
      if (!view) return { ok: false, reason: "no-view" };
      var revision = isInteger(msg.revision) ? msg.revision : 0;
      if (typeof msg.error === "string") {
        viewError(view, revision, msg.error.slice(0, 300));
        return { ok: true };
      }
      if (!msg.result || typeof msg.result !== "object") {
        viewError(view, revision, "The prepared output was empty");
        return { ok: false, reason: "no-result" };
      }
      if (!formatCapability) {
        // An old host logs every message and sends unknown ones to the last agent.
        viewError(view, revision, HOST_OLD_MESSAGE);
        return { ok: false, reason: "host-old" };
      }
      if (!deps.nativeConnected()) {
        viewError(view, revision, "The native host is not connected");
        return { ok: false, reason: "host-disconnected" };
      }
      var copyId = deps.randomHex(16);
      copies[copyId] = {
        tabId: record.tabId,
        port: view.port,
        documentId: record.documentId,
        revision: revision,
        images: collectPngImages(msg.result),
      };
      deps.sendToNative({ type: "FORMAT_RESULT", copyId: copyId, result: msg.result });
      return { ok: true, copyId: copyId };
    }

    // Handled before any other native message logic. It never starts an
    // annotation or a tab query.
    function onFormattedResult(msg) {
      var copy = msg && typeof msg.copyId === "string" ? copies[msg.copyId] : null;
      if (!copy) return { ok: false, reason: "unknown-copy" };
      delete copies[msg.copyId];
      var record = sessions[copy.tabId];
      var view = currentView(copy.tabId);
      if (!view || view.port !== copy.port || !record || record.documentId !== copy.documentId) {
        return { ok: false, reason: "view-gone" };
      }
      if (typeof msg.error === "string") {
        viewError(view, copy.revision, msg.error === "too-large"
          ? "The output is too large to copy"
          : "Could not format the output");
        return { ok: true };
      }
      if (typeof msg.text !== "string") {
        viewError(view, copy.revision, "Could not format the output");
        return { ok: false, reason: "bad-text" };
      }
      deps.postToPort(view.port, {
        type: T.PREPARED,
        preparedId: msg.copyId,
        revision: copy.revision,
        text: msg.text,
        images: copy.images,
      });
      return { ok: true };
    }

    function failCopiesOf(tabId, port, message) {
      Object.keys(copies).forEach(function (id) {
        var copy = copies[id];
        if (copy.tabId !== tabId) return;
        delete copies[id];
        if (port && copy.port === port) return; // the view is gone; nobody to tell
        var view = currentView(tabId);
        if (view && view.port === copy.port) viewError(view, copy.revision, message);
      });
    }

    function onNativeMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "PONG" || msg.type === "BROWSER_REGISTERED") {
        formatCapability = Array.isArray(msg.capabilities) && msg.capabilities.indexOf("format-result") !== -1;
      }
    }
    function onNativeDisconnect() {
      formatCapability = false;
    }

    // ── revocation ───────────────────────────────────────────────────
    // Drop the bindings, tokens and pending copies of a tab. `ended` is true
    // when the session ended (the pane stays bound to the tab); on navigation
    // the pane is closed so it connects again after the DevTools navigation.
    function revokeViewState(tabId, ended) {
      Object.keys(tokens).forEach(function (t) { if (tokens[t].tabId === tabId) delete tokens[t]; });
      failCopiesOf(tabId, null, "The page changed. Prepare again");
      var frame = frames[tabId];
      if (frame) {
        delete frames[tabId];
        dropInfo(frame.port);
        deps.closePort(frame.port);
      }
      if (!ended) {
        var pane = panes[tabId];
        if (pane) {
          delete panes[tabId];
          dropInfo(pane);
          deps.closePort(pane);
        }
        if (lastFocusedPaneTab === tabId) lastFocusedPaneTab = null;
      }
    }

    function onTabLoading(tabId) {
      revokeViewState(tabId, false);
      delete sessions[tabId];
    }
    function onTabRemoved(tabId) {
      revokeViewState(tabId, false);
      delete sessions[tabId];
    }

    // ── capture guard ────────────────────────────────────────────────
    // captureVisibleTab(windowId) captures the active tab of that window,
    // which is not always the annotated tab.
    function authorizeCapture(sender, generation) {
      var checked = ensureRecord(sender, generation);
      if (!checked.ok) return { ok: false, error: "The annotated page changed. Try again" };
      var tab = sender.tab;
      return { ok: true, tabId: checked.record.tabId, windowId: tab.windowId };
    }

    function beginCapture(tabId, windowId) {
      var watch = { tabId: tabId, windowId: windowId, changed: false };
      captures.push(watch);
      return watch;
    }
    function endCapture(watch) {
      captures = captures.filter(function (c) { return c !== watch; });
      return { changed: watch.changed };
    }
    // kind: "activated" | "removed" | "updated"
    function noteTabEvent(event) {
      captures.forEach(function (watch) {
        if (event.kind === "activated") {
          if (event.windowId === watch.windowId) watch.changed = true;
        } else if (event.kind === "removed") {
          if (event.tabId === watch.tabId || (event.isWindowClosing && event.windowId === watch.windowId)) watch.changed = true;
        } else if (event.kind === "updated") {
          var info = event.changeInfo || {};
          var counts = Object.prototype.hasOwnProperty.call(info, "status")
            || Object.prototype.hasOwnProperty.call(info, "url")
            || Object.prototype.hasOwnProperty.call(info, "discarded");
          if (counts && event.tabId === watch.tabId) watch.changed = true;
        }
      });
    }

    async function guardedCapture(sender, generation, io) {
      var auth = authorizeCapture(sender, generation);
      if (!auth.ok) return { error: auth.error };
      var watch = beginCapture(auth.tabId, auth.windowId);
      var result;
      var failure = null;
      try {
        var activeId = await io.getActiveTabId(auth.windowId);
        if (activeId !== auth.tabId) {
          failure = ACTIVATE_MESSAGE;
        } else {
          result = await io.capture(auth.windowId);
        }
      } finally {
        var ended = endCapture(watch);
        if (!failure && ended.changed) failure = CHANGED_MESSAGE;
      }
      // A change during the capture discards the image, even if the bound tab
      // is active again.
      if (failure) return { error: failure };
      return result;
    }

    return {
      registerSession: registerSession,
      endSession: endSession,
      ensureRecord: ensureRecord,
      onPortMessage: onPortMessage,
      onPortDisconnect: onPortDisconnect,
      requestFrameToken: requestFrameToken,
      relayState: relayState,
      onPreparedResult: onPreparedResult,
      onFormattedResult: onFormattedResult,
      onNativeMessage: onNativeMessage,
      onNativeDisconnect: onNativeDisconnect,
      onTabLoading: onTabLoading,
      onTabRemoved: onTabRemoved,
      noteTabEvent: noteTabEvent,
      guardedCapture: guardedCapture,
      authorizeCapture: authorizeCapture,
      isPaneBound: function (tabId) { return !!panes[tabId]; },
      boundPaneTabs: function () { return Object.keys(panes).map(Number); },
      lastFocusedPaneTab: function () { return lastFocusedPaneTab; },
      hasFormatCapability: function () { return formatCapability; },
      sessionOf: function (tabId) { return sessions[tabId] || null; },
      boundKind: boundKind,
    };
  }

  root.PiRouting = {
    createRouter: createRouter,
    selectTargetTab: selectTargetTab,
    toNativeCompletion: toNativeCompletion,
    collectPngImages: collectPngImages,
    isPageTopFrame: isPageTopFrame,
    startsWithUrl: startsWithUrl,
    ACTIVATE_MESSAGE: ACTIVATE_MESSAGE,
    CHANGED_MESSAGE: CHANGED_MESSAGE,
    HOST_OLD_MESSAGE: HOST_OLD_MESSAGE,
  };
})(globalThis);
