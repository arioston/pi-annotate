/**
 * Pi Annotate - full-page capture, page side (plan 1169)
 *
 * The service worker runs the capture. This module is the only code that
 * changes the page for it, and the only code that restores the page. It does
 * three things on request: begin (find the scroll target, prepare the page),
 * step (scroll, wait, report), end (restore).
 *
 * INVARIANT 1: the page is restored on each exit path: success, abort, error,
 * tab switch, and navigation away (pagehide). end() is safe to call two times.
 *
 * WHAT THIS MODULE CHANGES ON THE PAGE, each with its restore in end():
 *   1. One <style> element (id pi-capture-style) that hides scrollbars and sets
 *      scroll-behavior auto.        -> removed.
 *   2. The scroll position of the scroll target. -> set back to the value that
 *      begin() recorded (for the document, window.scrollTo).
 *   3. The inline `visibility` of each position: fixed or position: sticky
 *      element, set to hidden after the first picture, so that a header or a
 *      floating button appears one time. -> each element gets back its earlier
 *      inline value and priority.
 * It also adds two listeners (Escape, pagehide). -> removed.
 *
 * ANNOTATION SESSION (plan 1170). A capture that the session itself asks for
 * (begin with fromSession: true) is allowed during a session. A capture from
 * the popup or the command is still refused. Nodes of Pi Annotate (id or class
 * that starts with "pi-") are never chosen as the scroll target and never
 * hidden, so the session UI keeps the state that the session gave it.
 *
 * SCROLL TARGET. The document scroller when the document is taller than the
 * viewport. Otherwise the largest visible element that scrolls on the vertical
 * axis (for example a chat pane); its content is the output, without the frame
 * around it. When there is none, the document with a single picture.
 */
(function (root) {
  "use strict";

  var STYLE_ID = "pi-capture-style";
  var SETTLE_FRAMES = 2;
  var SETTLE_MS = 150;
  var FRAME_FALLBACK_MS = 120;
  var CSS =
    "html, html *, body, body * { scroll-behavior: auto !important; scrollbar-width: none !important; }" +
    "html::-webkit-scrollbar, html *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }";

  var run = null; // { target, kind, scrollTop, styleEl, hidden, onKey, onPageHide }

  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function nextFrame() {
    return Promise.race([
      new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); }),
      delay(FRAME_FALLBACK_MS),
    ]);
  }

  function settle() {
    var chain = Promise.resolve();
    for (var i = 0; i < SETTLE_FRAMES; i++) chain = chain.then(nextFrame);
    return chain.then(function () { return delay(SETTLE_MS); });
  }

  function documentScroller() { return document.scrollingElement || document.documentElement; }

  function clipToViewport(r) {
    var left = Math.max(0, r.left);
    var top = Math.max(0, r.top);
    var right = Math.min(innerWidth, r.left + r.width);
    var bottom = Math.min(innerHeight, r.top + r.height);
    return { left: left, top: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function isPiNode(el) {
    return !!el.closest('[id^="pi-"], [class^="pi-"], [class*=" pi-"]');
  }

  function innerScroller() {
    var best = null;
    var bestArea = 0;
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < 100 || isPiNode(el)) continue;
      var oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      var r = clipToViewport(el.getBoundingClientRect());
      var area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function findTarget() {
    var doc = documentScroller();
    if (doc.scrollHeight > innerHeight + 1) return { kind: "document", el: doc };
    var inner = innerScroller();
    return inner ? { kind: "element", el: inner } : { kind: "document", el: doc };
  }

  function visibleRectOf(target) {
    if (target.kind === "document") return { left: 0, top: 0, width: innerWidth, height: innerHeight };
    var el = target.el;
    var r = el.getBoundingClientRect();
    return clipToViewport({ left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight });
  }

  function contentHeightOf(target) { return target.el.scrollHeight; }

  function scrollTopOf(target) { return target.kind === "document" ? (window.scrollY || target.el.scrollTop) : target.el.scrollTop; }

  function scrollTo(target, top) {
    if (target.kind === "document") window.scrollTo(0, top);
    else target.el.scrollTop = top;
  }

  function hideFloating() {
    if (!run || run.hidden.length) return;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.id === STYLE_ID || isPiNode(el)) continue;
      if (run.kind === "element" && run.target.el.contains(el)) continue;
      var pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      run.hidden.push({
        el: el,
        value: el.style.getPropertyValue("visibility"),
        priority: el.style.getPropertyPriority("visibility"),
      });
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  function end() {
    if (!run) return { ok: true };
    var r = run;
    run = null;
    root.removeEventListener("keydown", r.onKey, true);
    root.removeEventListener("pagehide", r.onPageHide, true);
    r.hidden.forEach(function (h) {
      if (h.value) h.el.style.setProperty("visibility", h.value, h.priority);
      else h.el.style.removeProperty("visibility");
    });
    if (r.styleEl.parentNode) r.styleEl.remove();
    scrollTo(r.target, r.scrollTop);
    return { ok: true };
  }

  /**
   * begin({ sessionActive, fromSession }) -> metrics, or { error }.
   * Refuses while an annotation session is active (plan 1169, decision 3),
   * unless the session itself asked for the capture (plan 1170).
   */
  function begin(options) {
    var opts = options || {};
    if (opts.sessionActive && !opts.fromSession) return Promise.resolve({ error: "Close the annotation session before a full-page capture." });
    if (run) end();
    var target = findTarget();
    var styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    var state = {
      target: target,
      kind: target.kind,
      scrollTop: scrollTopOf(target),
      styleEl: styleEl,
      hidden: [],
      onKey: null,
      onPageHide: null,
    };
    state.onKey = function (e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (root.PiSafeRuntime) root.PiSafeRuntime.sendMessageSafe({ type: "CAPTURE_PAGE_ABORT" });
    };
    state.onPageHide = function () { end(); };
    run = state;
    (document.head || document.documentElement).appendChild(styleEl);
    root.addEventListener("keydown", state.onKey, true);
    root.addEventListener("pagehide", state.onPageHide, true);
    scrollTo(target, 0);
    return settle().then(function () {
      return {
        kind: target.kind,
        visible: visibleRectOf(target),
        contentHeight: contentHeightOf(target),
        scrollTop: scrollTopOf(target),
        dpr: root.devicePixelRatio || 1,
        url: location.href,
        title: document.title,
      };
    });
  }

  /** step({ position, hideFloating }) -> { scrollTop, contentHeight }. */
  function step(options) {
    if (!run) return Promise.resolve({ error: "No capture is running." });
    var target = run.target;
    if (options.hideFloating) hideFloating();
    scrollTo(target, options.position);
    return settle().then(function () {
      if (!run) return { error: "The capture ended." };
      return { scrollTop: scrollTopOf(target), contentHeight: contentHeightOf(target), visible: visibleRectOf(target) };
    });
  }

  /**
   * describe() -> { kind, visible, scrollTop }: what begin() would choose,
   * with no change to the page. The session reads it before the capture to
   * turn element rectangles into content coordinates.
   */
  function describe() {
    var target = findTarget();
    return { kind: target.kind, visible: visibleRectOf(target), scrollTop: scrollTopOf(target) };
  }

  root.__piCapture = { begin: begin, step: step, end: end, describe: describe };
})(globalThis);
