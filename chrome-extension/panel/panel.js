/**
 * Pi Annotate - shared panel page (plan 1055).
 *
 * One view for the DevTools Elements pane and the iframe fallback. It renders
 * only from STATE messages and sends only ACTION messages. All page data goes
 * in with textContent. The view never uses page data as HTML or as a URL.
 *
 * createView(env) holds the logic and takes its DOM, transport and clipboard
 * from env, so tests can run it with stubs. The boot code at the bottom wires
 * the real page and runs only inside an extension page.
 */
(function (root) {
  var P = root.PiPanelProtocol;
  var COPY_FAILED_HINT = "Press Ctrl+C to copy";

  function setClass(el, name, on) {
    var parts = String(el.className || "").split(/\s+/).filter(Boolean);
    var has = parts.indexOf(name) !== -1;
    if (on && !has) parts.push(name);
    if (!on && has) parts = parts.filter(function (p) { return p !== name; });
    el.className = parts.join(" ");
  }

  function describeError(err) {
    if (err && typeof err === "object") {
      var name = typeof err.name === "string" && err.name ? err.name : "Error";
      var message = typeof err.message === "string" ? err.message : "";
      return message ? name + ": " + message : name;
    }
    return String(err);
  }

  function createView(env) {
    var doc = env.document;
    var send = env.send;
    var $ = function (id) { return doc.getElementById(id); };
    var ui = {
      single: $("pi-mode-single"), multi: $("pi-mode-multi"),
      ssEach: $("pi-ss-each"), ssFull: $("pi-ss-full"), ssNone: $("pi-ss-none"),
      count: $("pi-count"), notes: $("pi-notes-visible"), debug: $("pi-debug-mode"),
      etch: $("pi-etch-mode"), etchLabel: $("pi-etch-label"), etchCount: $("pi-etch-count"),
      edit: $("pi-tailedit-mode"), interact: $("pi-interact-mode"),
      context: $("pi-context"), elements: $("pi-elements"), delivery: $("pi-delivery"),
      prepare: $("pi-prepare"), copyText: $("pi-copy-text"), copyImages: $("pi-copy-images"),
      cancel: $("pi-cancel"), submit: $("pi-submit"), close: $("pi-close"),
      useSelected: $("pi-use-selected"), cleanup: $("pi-cleanup"), status: $("pi-status"),
      manual: $("pi-manual"), manualText: $("pi-manual-text"),
    };

    var state = null;      // { generation, revision, session }
    var prepared = null;   // { preparedId, revision, text, images }
    var imageButtons = []; // { button, item }
    var rows = {};         // element id -> row record
    var order = [];        // element ids in DOM order
    var busyPreparing = false;

    function setStatus(text, kind) {
      ui.status.textContent = text;
      ui.status.className = "pi-status" + (kind ? " " + kind : "");
    }

    function hideManual() {
      ui.manual.hidden = true;
      ui.manualText.value = "";
    }

    function showManual(text) {
      ui.manualText.value = text;
      ui.manual.hidden = false;
      if (typeof ui.manualText.focus === "function") ui.manualText.focus();
      if (typeof ui.manualText.select === "function") ui.manualText.select();
    }

    function sendAction(name, args) {
      if (!state) return;
      send({ type: P.TYPES.ACTION, generation: state.generation, name: name, args: args });
    }

    function isStale() {
      return !!(prepared && state && state.revision > prepared.revision);
    }

    function updateCopyControls() {
      var stale = isStale();
      ui.copyText.disabled = !prepared || stale;
      for (var i = 0; i < imageButtons.length; i++) {
        imageButtons[i].button.disabled = stale || !imageButtons[i].item;
      }
      if (stale) setStatus("The session changed. Prepare again.", "");
    }

    // ── rows ──────────────────────────────────────────────────────────
    function makeButton(label, title, onClick) {
      var b = doc.createElement("button");
      b.className = "pi-el-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      return b;
    }

    function createRow(el) {
      var row = doc.createElement("div");
      row.className = "pi-el-row";
      var head = doc.createElement("div");
      head.className = "pi-el-head";
      var badge = doc.createElement("span");
      badge.className = "pi-el-badge";
      var selector = doc.createElement("span");
      selector.className = "pi-el-selector";
      head.appendChild(badge);
      head.appendChild(selector);
      head.appendChild(makeButton("▲", "Expand to parent", function () { sendAction("expandElement", { id: el.id }); }));
      head.appendChild(makeButton("▼", "Contract to child", function () { sendAction("contractElement", { id: el.id }); }));
      head.appendChild(makeButton("×", "Remove element", function () { sendAction("removeElement", { id: el.id }); }));
      var comment = doc.createElement("textarea");
      comment.className = "pi-el-comment";
      comment.placeholder = "Describe changes for this element...";
      comment.addEventListener("input", function () {
        sendAction("setComment", { id: el.id, text: String(comment.value).slice(0, P.MAX_TEXT) });
      });
      var meta = doc.createElement("div");
      meta.className = "pi-el-meta";
      row.appendChild(head);
      row.appendChild(comment);
      row.appendChild(meta);
      return { id: el.id, node: row, badge: badge, selector: selector, comment: comment, meta: meta };
    }

    function renderElements(list) {
      var wanted = list.map(function (e) { return e.id; });
      // remove rows that are gone
      order.slice().forEach(function (id) {
        if (wanted.indexOf(id) === -1) {
          ui.elements.removeChild(rows[id].node);
          delete rows[id];
          order.splice(order.indexOf(id), 1);
        }
      });
      list.forEach(function (el, index) {
        var rec = rows[el.id];
        if (!rec) {
          rec = createRow(el);
          rows[el.id] = rec;
          ui.elements.appendChild(rec.node);
          order.push(el.id);
        }
        rec.badge.textContent = String(index + 1);
        rec.selector.textContent = el.selector;
        rec.selector.title = el.selector;
        var meta = "<" + el.tag + ">" + (el.text ? " " + el.text : "");
        if (el.attachments.length) meta += " | " + el.attachments.length + " reference image(s): " + el.attachments.join(", ");
        if (!el.screenshot) meta += " | no screenshot";
        rec.meta.textContent = meta;
        // Do not overwrite a field the user is typing in.
        if (doc.activeElement !== rec.comment && rec.comment.value !== el.comment) rec.comment.value = el.comment;
      });
      // Put the rows in the order of the list (only when the order changed).
      var same = order.length === wanted.length && order.every(function (id, i) { return id === wanted[i]; });
      if (!same) {
        wanted.forEach(function (id) { ui.elements.appendChild(rows[id].node); });
        order = wanted.slice();
      }
    }

    // ── render ────────────────────────────────────────────────────────
    function render() {
      var has = !!state;
      var s = has ? state.session : null;
      [ui.prepare, ui.cancel, ui.submit].forEach(function (b) { b.disabled = !has || (b === ui.prepare && busyPreparing); });
      if (!has) {
        ui.delivery.textContent = "";
        setStatus("Waiting for an annotation session...", "");
        updateCopyControls();
        return;
      }
      setClass(ui.single, "active", !s.multi);
      setClass(ui.multi, "active", s.multi);
      setClass(ui.ssEach, "active", s.screenshotMode === "each");
      setClass(ui.ssFull, "active", s.screenshotMode === "full");
      setClass(ui.ssNone, "active", s.screenshotMode === "none");
      ui.count.textContent = s.elements.length + " selected";
      ui.notes.checked = s.notesVisible;
      ui.debug.checked = s.debug;
      ui.etch.checked = s.etch.on;
      setClass(ui.etchLabel, "recording", s.etch.on);
      ui.etchCount.textContent = s.etch.count > 0 ? String(s.etch.count) : "";
      ui.etchCount.style.display = s.etch.count > 0 ? "inline-flex" : "none";
      ui.edit.checked = s.edit;
      ui.interact.checked = s.interact;
      if (doc.activeElement !== ui.context && ui.context.value !== s.context) ui.context.value = s.context;
      ui.delivery.textContent = s.managed ? "Sends to the waiting caller" : "Sends to the last active agent";
      renderElements(s.elements);
      updateCopyControls();
    }

    // ── incoming messages ─────────────────────────────────────────────
    function onState(raw) {
      var checked = P.validateState(raw);
      if (!checked.ok) return;
      var next = checked.state;
      if (state && next.generation < state.generation) return;
      if (state && next.generation === state.generation && next.revision < state.revision) return;
      if (!state || next.generation !== state.generation) {
        prepared = null;
        imageButtons = [];
        ui.copyImages.textContent = "";
        hideManual();
        busyPreparing = false;
        if (state) setStatus("", "");
      }
      state = next;
      render();
    }

    function dataUrlToBlob(dataUrl) {
      var comma = dataUrl.indexOf(",");
      var binary = env.atob(dataUrl.slice(comma + 1));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new env.Blob([bytes], { type: "image/png" });
    }

    function buildImageButtons(images) {
      imageButtons = [];
      ui.copyImages.textContent = "";
      images.forEach(function (img, i) {
        // Build the ClipboardItem before the button is enabled, so the click
        // handler can call clipboard.write at once.
        var item = null;
        try {
          item = new env.ClipboardItem({ "image/png": dataUrlToBlob(img.dataUrl) });
        } catch (err) {
          item = null;
        }
        var button = doc.createElement("button");
        button.className = "pi-btn pi-btn-secondary";
        button.textContent = "Copy image " + (i + 1);
        button.disabled = true;
        button.addEventListener("click", function () {
          if (!item) return;
          var p;
          try { p = env.clipboard.write([item]); } catch (err) { p = Promise.reject(err); }
          Promise.resolve(p).then(
            function () { setStatus("Copied image " + (i + 1), "ok"); },
            function (err) { setStatus("Could not copy the image. " + describeError(err), "error"); },
          );
        });
        ui.copyImages.appendChild(button);
        imageButtons.push({ button: button, item: item });
      });
    }

    function onPrepared(raw) {
      var checked = P.validatePrepared(raw);
      busyPreparing = false;
      if (!checked.ok) {
        setStatus("The prepared output was not valid.", "error");
        render();
        return;
      }
      var p = checked.prepared;
      if (p.error !== undefined) {
        prepared = null;
        imageButtons = [];
        ui.copyImages.textContent = "";
        setStatus(p.error, "error");
        render();
        return;
      }
      prepared = p;
      hideManual();
      buildImageButtons(p.images);
      setStatus("Output is ready. Press Copy prepared output.", "");
      render();
    }

    function onSessionEnded() {
      if (!state) return;
      state = null;
      prepared = null;
      imageButtons = [];
      ui.copyImages.textContent = "";
      hideManual();
      busyPreparing = false;
      render();
    }

    function handleMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === P.TYPES.STATE) onState(msg);
      else if (msg.type === P.TYPES.PREPARED) onPrepared(msg);
      else if (msg.type === P.TYPES.SESSION_ENDED) onSessionEnded();
    }

    // ── controls ──────────────────────────────────────────────────────
    ui.single.addEventListener("click", function () { sendAction("setMulti", { value: false }); });
    ui.multi.addEventListener("click", function () { sendAction("setMulti", { value: true }); });
    ui.ssEach.addEventListener("click", function () { sendAction("setScreenshotMode", { value: "each" }); });
    ui.ssFull.addEventListener("click", function () { sendAction("setScreenshotMode", { value: "full" }); });
    ui.ssNone.addEventListener("click", function () { sendAction("setScreenshotMode", { value: "none" }); });
    ui.notes.addEventListener("change", function () { sendAction("setNotesVisible", { value: !!ui.notes.checked }); });
    ui.debug.addEventListener("change", function () { sendAction("setDebug", { value: !!ui.debug.checked }); });
    ui.etch.addEventListener("change", function () { sendAction("setEtch", { value: !!ui.etch.checked }); });
    ui.edit.addEventListener("change", function () { sendAction("setEdit", { value: !!ui.edit.checked }); });
    ui.interact.addEventListener("change", function () { sendAction("setInteract", { value: !!ui.interact.checked }); });
    ui.context.addEventListener("input", function () {
      sendAction("setContext", { text: String(ui.context.value).slice(0, P.MAX_TEXT) });
    });
    ui.cancel.addEventListener("click", function () { sendAction("cancel", {}); });
    ui.close.addEventListener("click", function () { sendAction("close", {}); });
    ui.submit.addEventListener("click", function () { sendAction("submit", {}); });
    ui.prepare.addEventListener("click", function () {
      if (!state || busyPreparing) return;
      busyPreparing = true;
      prepared = null;
      imageButtons = [];
      ui.copyImages.textContent = "";
      hideManual();
      setStatus("Preparing output...", "");
      sendAction("prepareOutput", {});
      render();
    });
    ui.useSelected.addEventListener("click", function () {
      if (typeof env.useSelected === "function") env.useSelected(function (message) { setStatus(message, "error"); });
    });
    // Cleanup works with or without a session; it never goes through sendAction.
    ui.cleanup.addEventListener("click", function () {
      if (typeof env.cleanupPage === "function") env.cleanupPage(setStatus);
    });

    // The click handler calls writeText first. No message, capture or native
    // call comes before it, so the click still counts as a fresh user action.
    ui.copyText.addEventListener("click", function () {
      if (!prepared || isStale()) return;
      var text = prepared.text;
      var p;
      try {
        if (!env.clipboard || typeof env.clipboard.writeText !== "function") throw new Error("Clipboard API unavailable");
        p = env.clipboard.writeText(text);
      } catch (err) {
        p = Promise.reject(err);
      }
      Promise.resolve(p).then(
        function () {
          hideManual();
          setStatus("Copied", "ok");
        },
        function (err) {
          setStatus("Could not use the clipboard (" + describeError(err) + "). " + COPY_FAILED_HINT + ".", "error");
          showManual(text);
        },
      );
    });

    render();
    return {
      handleMessage: handleMessage,
      setStatus: setStatus,
      sendAction: sendAction,
      get state() { return state; },
      get prepared() { return prepared; },
    };
  }

  root.PiPanelView = { createView: createView, bootFrame: bootFrame };

  // ── boot (extension page only) ────────────────────────────────────────
  function boot() {
    var params = new URLSearchParams(root.location.search);
    var mode = params.get("host") === "devtools" ? "devtools" : "frame";
    root.document.body.setAttribute("data-host", mode);

    var port = null;
    var view = null;
    function post(msg) { if (port) { try { port.postMessage(msg); } catch (e) { /* port closed */ } } }

    view = createView({
      document: root.document,
      send: post,
      clipboard: root.navigator.clipboard,
      ClipboardItem: root.ClipboardItem,
      Blob: root.Blob,
      atob: root.atob.bind(root),
      useSelected: mode === "devtools" ? function (report) {
        root.chrome.devtools.inspectedWindow.eval(
          "window.__piAnnotateSelect && window.__piAnnotateSelect($0)",
          { useContentScriptContext: true },
          function (result, exception) {
            if (exception && exception.isException) report("Could not read the selected element.");
            else if (!result) report("Select an element in the Elements panel while a session is active.");
          },
        );
      } : null,
      cleanupPage: mode === "devtools" ? function (report) {
        root.chrome.devtools.inspectedWindow.eval(
          "window.__piAnnotateCleanup ? window.__piAnnotateCleanup() : false",
          { useContentScriptContext: true },
          function (result, exception) {
            if (exception && exception.isException) report("Could not clean the page.", "error");
            else if (!result) report("No Pi Annotate script on this page.", "");
            else report("Page cleaned.", "ok");
          },
        );
      } : null,
    });

    if (mode === "devtools") bootPane(view, function () { return port; }, function (p) { port = p; });
    else bootFrame(view, function (p) { port = p; });
  }

  function bootPane(view, getPort, setPort) {
    var retryTimer = null;
    // The panel page loads only when the panel is first shown, so it starts
    // visible. devtools.js forwards the later onShown and onHidden events.
    var visible = true;
    function requestStart() {
      var p = getPort();
      if (p && visible && !view.state) p.postMessage({ type: P.TYPES.PANE_START });
    }
    root.__piPanelShown = function () { visible = true; requestStart(); };
    root.__piPanelHidden = function () { visible = false; };
    function connect() {
      var p = root.chrome.runtime.connect({ name: "pi-pane" });
      setPort(p);
      p.onMessage.addListener(function (msg) { view.handleMessage(msg); });
      p.onDisconnect.addListener(function () {
        if (getPort() === p) setPort(null);
        // A service-worker restart drops the port. Connect again.
        clearTimeout(retryTimer);
        retryTimer = setTimeout(function () { if (!getPort()) connect(); }, 1000);
      });
      p.postMessage({ type: P.TYPES.PANE_HELLO, tabId: root.chrome.devtools.inspectedWindow.tabId });
      // An open panel is ready at once: ask for a session when the tab has none.
      requestStart();
    }
    connect();
    root.addEventListener("focus", function () {
      var p = getPort();
      if (p) p.postMessage({ type: P.TYPES.PANE_FOCUS });
      requestStart();
    });
    // Old selections are gone after a navigation: bind again.
    root.chrome.devtools.network.onNavigated.addListener(function () {
      var p = getPort();
      clearTimeout(retryTimer);
      if (p) { setPort(null); p.disconnect(); }
      connect();
    });
  }

  function bootFrame(view, setPort) {
    var MAX_TRIES = 3;
    var tries = 0;
    var open = 0;
    var bound = null;

    function failVisibly() {
      view.setStatus("Panel not connected; close and start again", "error");
    }

    function tryToken(token) {
      tries++;
      open++;
      var p = root.chrome.runtime.connect({ name: "pi-frame" });
      p.onMessage.addListener(function (msg) {
        if (msg && msg.type === P.TYPES.HELLO_ACK) {
          // First port that background accepts.
          if (!bound) {
            bound = p;
            setPort(p);
          }
          return;
        }
        if (bound === p) view.handleMessage(msg);
      });
      p.onDisconnect.addListener(function () {
        open--;
        if (bound === p) {
          // A bound port closed (for example a service-worker restart). Ask
          // the content script for a new token and start counting again.
          bound = null;
          tries = 0;
          setPort(null);
          root.parent.postMessage({ type: P.TYPES.PI_FRAME_UNBOUND }, "*");
        } else if (!bound && open === 0 && tries >= MAX_TRIES) {
          failVisibly();
        }
      });
      p.postMessage({ type: P.TYPES.FRAME_HELLO, token: token });
    }

    // Drag the frame host by its header (the host moves; this page does not).
    var header = root.document.querySelector(".pi-header");
    var dragging = false;
    if (header) {
      header.addEventListener("mousedown", function (e) {
        if (e.target && e.target.tagName === "BUTTON") return;
        dragging = true;
        e.preventDefault();
      });
      root.addEventListener("mouseup", function () { dragging = false; });
      root.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        if (e.buttons !== 1) { dragging = false; return; }
        var dx = Math.max(-P.MAX_DRAG, Math.min(P.MAX_DRAG, e.movementX || 0));
        var dy = Math.max(-P.MAX_DRAG, Math.min(P.MAX_DRAG, e.movementY || 0));
        if (dx !== 0 || dy !== 0) view.sendAction("dragBy", { dx: dx, dy: dy });
      });
    }

    // Page scripts share window.parent with the content script, so event.source
    // cannot tell them apart. Accept a few tokens; background accepts only the
    // one real token, once.
    root.addEventListener("message", function (event) {
      if (event.source !== root.parent) return;
      var data = event.data;
      if (!data || data.type !== P.TYPES.PI_FRAME_TOKEN || typeof data.token !== "string") return;
      if (bound) return;
      if (tries >= MAX_TRIES) {
        failVisibly();
        return;
      }
      tryToken(data.token);
    });
  }

  if (typeof root.chrome !== "undefined" && root.chrome.runtime && root.chrome.runtime.id
    && root.document && typeof root.document.getElementById === "function" && root.location) {
    boot();
  }
})(globalThis);
