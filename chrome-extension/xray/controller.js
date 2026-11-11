/**
 * Pi Annotate - X-ray controller (plan 1168)
 *
 * Owns the on/off state of X-ray mode and the input: Shift+drag opens a
 * frame, Escape closes it. The measuring and drawing live in measure.js and
 * overlay.js.
 *
 * CONTRACT
 *   - Off means off: toggle() removes every listener (one AbortController
 *     signal covers all of them), destroys the overlay, and restores the
 *     selection guard. No listener, timer, frame callback, or node stays.
 *   - The overlay is created on the first drag, not when the mode turns on.
 *   - A Shift+click with no movement is a page click: no event is stopped
 *     before the pointer has moved DRAG_START_PX.
 *   - The only write to a page element is the selection guard: one inline
 *     style on the root element during a drag, restored on release or off.
 *   - The listeners are on `window` in the capture phase, so they run before
 *     the annotation session's capture listeners on `document`.
 *   - No extension API and no network API.
 *   - Memory only: navigation resets the mode and nothing is stored.
 *
 * Loaded raw (no bundler) after overlay.js and before content.js.
 */
(function (root) {
  "use strict";

  var ns = (root.__piXray = root.__piXray || {});
  var DRAG_START_PX = 4;
  var EDITABLE = ["input", "textarea", "select"];

  var control = null; // { abort, overlay, pending, dragging, swallowClick, guard }

  function isEditableFocus() {
    var a = document.activeElement;
    if (!a) return false;
    return EDITABLE.indexOf(a.localName) >= 0 || !!a.isContentEditable;
  }

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function frameBetween(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function applyGuard(c) {
    if (c.guard) return;
    var el = document.documentElement;
    c.guard = { el: el, prior: el.style.userSelect };
    el.style.userSelect = "none";
  }

  function releaseGuard(c) {
    if (!c.guard) return;
    c.guard.el.style.userSelect = c.guard.prior;
    c.guard = null;
  }

  function onPointerDown(c, e) {
    c.swallowClick = false;
    c.pending = null;
    if (!e.shiftKey || e.button !== 0 || isEditableFocus()) return;
    c.pending = { x: e.clientX, y: e.clientY };
  }

  function onPointerMove(c, e) {
    if (!c.pending && !c.dragging) return;
    if (!c.dragging) {
      var dx = e.clientX - c.pending.x;
      var dy = e.clientY - c.pending.y;
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      c.dragging = true;
      applyGuard(c);
      if (!c.overlay) c.overlay = ns.createOverlay();
    }
    stop(e);
    c.overlay.setFrame(frameBetween(c.pending, { x: e.clientX, y: e.clientY }));
  }

  function onPointerUp(c, e) {
    if (c.dragging) {
      stop(e);
      c.swallowClick = true; // the one click that follows the release
    }
    c.dragging = false;
    c.pending = null;
    releaseGuard(c);
  }

  function onClick(c, e) {
    if (!c.swallowClick) return;
    c.swallowClick = false;
    stop(e);
  }

  function onKeyDown(c, e) {
    if (e.key === "Escape" && c.overlay && c.overlay.isOpen()) {
      c.overlay.close();
      stop(e);
    }
  }

  function turnOn() {
    var abort = new AbortController();
    var c = { abort: abort, overlay: null, pending: null, dragging: false, swallowClick: false, guard: null };
    var opts = { capture: true, signal: abort.signal };
    function listen(type, handler) { root.addEventListener(type, function (e) { handler(c, e); }, opts); }
    listen("keydown", onKeyDown);
    listen("pointerdown", onPointerDown);
    listen("pointermove", onPointerMove);
    listen("pointerup", onPointerUp);
    listen("click", onClick);
    listen("dragstart", function (cc, e) { if (cc.dragging) stop(e); });
    listen("selectstart", function (cc, e) { if (cc.dragging) stop(e); });
    // Losing the window while Shift is down must not leave a drag open.
    listen("blur", function (cc, e) { if (e.target !== root) return; cc.pending = null; cc.dragging = false; releaseGuard(cc); });
    control = c;
  }

  function turnOff() {
    var c = control;
    control = null;
    c.abort.abort();
    releaseGuard(c);
    if (c.overlay) c.overlay.destroy();
  }

  ns.toggle = function () {
    if (control) turnOff(); else turnOn();
    return !!control;
  };
  ns.isOn = function () { return !!control; };
  ns.isFrameOpen = function () { return !!(control && control.overlay && control.overlay.isOpen()); };
})(globalThis);
