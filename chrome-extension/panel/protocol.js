/**
 * Pi Annotate - panel protocol (classic script, global PiPanelProtocol).
 *
 * content.js owns the session. A panel (DevTools pane, extension iframe) is a
 * view: it gets STATE snapshots and sends ACTION messages. This file holds the
 * message names and the validators, so the content script, the background
 * relay and the view agree on one shape.
 */
(function (root) {
  var MAX_TEXT = 10000;
  var MAX_DRAG = 10000;
  var ID_PATTERN = /^e[0-9]{1,9}$/;
  var SCREENSHOT_MODES = ["each", "full", "none"];

  var TYPES = {
    // content -> view (through the background relay)
    STATE: "STATE",
    PREPARED: "PREPARED",
    // view -> content (through the background relay)
    ACTION: "ACTION",
    // content -> background
    PANEL_SESSION: "PANEL_SESSION",
    FRAME_TOKEN_REQUEST: "FRAME_TOKEN_REQUEST",
    PREPARED_RESULT: "PREPARED_RESULT",
    // view -> background (ports)
    PANE_HELLO: "PANE_HELLO",
    PANE_FOCUS: "PANE_FOCUS",
    FRAME_HELLO: "FRAME_HELLO",
    // background -> content
    VIEW_BOUND: "VIEW_BOUND",
    VIEW_UNBOUND: "VIEW_UNBOUND",
    // background -> view (port reply to an accepted hello)
    HELLO_ACK: "HELLO_ACK",
    // page window messages between content.js and the frame
    PI_FRAME_TOKEN: "PI_FRAME_TOKEN",
    PI_FRAME_UNBOUND: "PI_FRAME_UNBOUND",
  };

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, keys) {
    var own = Object.keys(value);
    if (own.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (own.indexOf(keys[i]) === -1) return false;
    }
    return true;
  }

  function isBool(v) { return typeof v === "boolean"; }
  function isText(v) { return typeof v === "string" && v.length <= MAX_TEXT; }
  function isId(v) { return typeof v === "string" && ID_PATTERN.test(v); }
  function isDrag(v) { return typeof v === "number" && isFinite(v) && Math.abs(v) <= MAX_DRAG; }
  function isGeneration(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= 0; }

  // name -> { keys, check(args) }
  var ACTION_SPECS = {
    setMulti: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setScreenshotMode: { keys: ["value"], check: function (a) { return SCREENSHOT_MODES.indexOf(a.value) !== -1; } },
    setNotesVisible: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setDebug: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setEtch: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setEdit: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setInteract: { keys: ["value"], check: function (a) { return isBool(a.value); } },
    setComment: { keys: ["id", "text"], check: function (a) { return isId(a.id) && isText(a.text); }, element: true },
    setContext: { keys: ["text"], check: function (a) { return isText(a.text); } },
    removeElement: { keys: ["id"], check: function (a) { return isId(a.id); }, element: true },
    expandElement: { keys: ["id"], check: function (a) { return isId(a.id); }, element: true },
    contractElement: { keys: ["id"], check: function (a) { return isId(a.id); }, element: true },
    dragBy: { keys: ["dx", "dy"], check: function (a) { return isDrag(a.dx) && isDrag(a.dy); } },
    submit: { keys: [], check: function () { return true; } },
    cancel: { keys: [], check: function () { return true; } },
    close: { keys: [], check: function () { return true; } },
    prepareOutput: { keys: [], check: function () { return true; } },
  };

  function toIdList(ids) {
    if (!ids) return null;
    if (Array.isArray(ids)) return ids;
    var list = [];
    ids.forEach(function (id) { list.push(id); });
    return list;
  }

  /**
   * Validate a view -> content ACTION.
   * ctx.generation: reject any other generation.
   * ctx.elementIds: array or Set of the live element ids; an element action
   * with another id is rejected.
   */
  function validateAction(raw, ctx) {
    var context = ctx || {};
    if (!isPlainObject(raw)) return { ok: false, reason: "not-an-object" };
    if (!hasExactKeys(raw, ["generation", "name", "args"])) return { ok: false, reason: "bad-keys" };
    if (!isGeneration(raw.generation)) return { ok: false, reason: "bad-generation" };
    if (typeof raw.name !== "string" || !Object.prototype.hasOwnProperty.call(ACTION_SPECS, raw.name)) {
      return { ok: false, reason: "unknown-action" };
    }
    if (!isPlainObject(raw.args)) return { ok: false, reason: "bad-args" };
    var spec = ACTION_SPECS[raw.name];
    if (!hasExactKeys(raw.args, spec.keys)) return { ok: false, reason: "bad-args" };
    if (!spec.check(raw.args)) return { ok: false, reason: "bad-args" };
    if (context.generation !== undefined && raw.generation !== context.generation) {
      return { ok: false, reason: "stale-generation" };
    }
    if (spec.element) {
      var ids = toIdList(context.elementIds) || [];
      if (ids.indexOf(raw.args.id) === -1) return { ok: false, reason: "unknown-element" };
    }
    return { ok: true, action: { generation: raw.generation, name: raw.name, args: raw.args } };
  }

  function validElement(el) {
    return isPlainObject(el)
      && isId(el.id)
      && typeof el.selector === "string" && typeof el.tag === "string"
      && typeof el.text === "string" && typeof el.comment === "string"
      && Array.isArray(el.attachments) && el.attachments.every(function (n) { return typeof n === "string"; })
      && isBool(el.screenshot);
  }

  function validateSession(s) {
    if (!isPlainObject(s)) return false;
    if (!isBool(s.multi) || SCREENSHOT_MODES.indexOf(s.screenshotMode) === -1) return false;
    if (!isBool(s.notesVisible) || !isBool(s.debug) || !isBool(s.edit) || !isBool(s.interact)) return false;
    if (!isPlainObject(s.etch) || !isBool(s.etch.on) || !isGeneration(s.etch.count)) return false;
    if (!Array.isArray(s.elements) || !s.elements.every(validElement)) return false;
    if (typeof s.context !== "string" || !isBool(s.managed)) return false;
    if (s.prepared !== null) {
      if (!isPlainObject(s.prepared) || typeof s.prepared.preparedId !== "string" || !isGeneration(s.prepared.revision)) return false;
    }
    return true;
  }

  /** Validate a content -> view STATE message. */
  function validateState(raw) {
    if (!isPlainObject(raw) || raw.type !== TYPES.STATE) return { ok: false, reason: "not-state" };
    if (!isGeneration(raw.generation) || !isGeneration(raw.revision)) return { ok: false, reason: "bad-generation" };
    if (!validateSession(raw.session)) return { ok: false, reason: "bad-session" };
    return { ok: true, state: { generation: raw.generation, revision: raw.revision, session: raw.session } };
  }

  /** Validate a background -> view PREPARED message. */
  function validatePrepared(raw) {
    if (!isPlainObject(raw) || raw.type !== TYPES.PREPARED) return { ok: false, reason: "not-prepared" };
    if (typeof raw.preparedId !== "string" || !isGeneration(raw.revision)) return { ok: false, reason: "bad-prepared" };
    if (raw.error !== undefined) {
      if (typeof raw.error !== "string") return { ok: false, reason: "bad-prepared" };
      return { ok: true, prepared: { preparedId: raw.preparedId, revision: raw.revision, error: raw.error } };
    }
    if (typeof raw.text !== "string" || !Array.isArray(raw.images)) return { ok: false, reason: "bad-prepared" };
    for (var i = 0; i < raw.images.length; i++) {
      var img = raw.images[i];
      if (!isPlainObject(img) || typeof img.dataUrl !== "string" || img.dataUrl.indexOf("data:image/png;base64,") !== 0) {
        return { ok: false, reason: "bad-prepared" };
      }
    }
    return { ok: true, prepared: { preparedId: raw.preparedId, revision: raw.revision, text: raw.text, images: raw.images } };
  }

  root.PiPanelProtocol = {
    TYPES: TYPES,
    ACTION_NAMES: Object.keys(ACTION_SPECS),
    MAX_TEXT: MAX_TEXT,
    MAX_DRAG: MAX_DRAG,
    validateAction: validateAction,
    validateState: validateState,
    validatePrepared: validatePrepared,
  };
})(globalThis);
