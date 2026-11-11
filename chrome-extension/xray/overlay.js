/**
 * Pi Annotate - X-ray reader and renderer (plan 1168)
 *
 * Builds the record tree for the measurement core from the live page, runs the
 * core, and draws the result in one fixed SVG above the page.
 *
 * CONTRACT
 *   - The page is never changed. Every attribute and style write in this file
 *     targets a node this factory created (the host, its shadow root, the SVG).
 *   - No extension API and no network API.
 *   - Work exists only while a frame is open: one animation frame chain starts
 *     in setFrame() and stops in close() and destroy(). destroy() also removes
 *     the host, so nothing stays behind.
 *   - A scan (element walk and computed styles) runs when the frame changes and
 *     otherwise at most once each SCAN_INTERVAL_MS. Between scans each frame
 *     reads rectangles only. If a scan takes more than SCAN_BUDGET_MS, the next
 *     scans use half the element cap, with a floor of MIN_CAP.
 *   - One scan visits at most the cap (1500 elements at most). A scan that
 *     reaches the cap reports `partial`.
 *   - Pi Annotate's own nodes (ids and classes that start with "pi-") are
 *     skipped by the reader.
 *
 * COLOURS come from two values: an accent, and the page background behind the
 * root (the first opaque background colour at or above the root). Label text is
 * black or white by the luminance of that background.
 *
 * Loaded raw (no bundler) after measure.js and before controller.js.
 */
(function (root) {
  "use strict";

  var ns = (root.__piXray = root.__piXray || {});

  var HOST_ID = "pi-xray-host";
  var Z_INDEX = 2147483642; // below the annotation tooltip (2147483647)
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MAX_CAP = 1500;
  var MIN_CAP = 200;
  var SCAN_INTERVAL_MS = 200;
  var SCAN_BUDGET_MS = 12;
  var MAX_LINES_PER_ELEMENT = 40;
  var ACCENT = "#0a84ff";
  var OFF_GRID = "#ff7a00";
  var SKIP_TAGS = ["script", "style", "template", "noscript", "head", "meta", "link", "title", "base", "br", "wbr"];

  var HOST_CSS =
    ":host { all: initial; position: fixed; inset: 0; pointer-events: none; }" +
    "svg { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible;" +
    " opacity: 0; transition: opacity 120ms ease-out; }" +
    "svg.on { opacity: 1; }" +
    "text { font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }";

  // ── small helpers ─────────────────────────────────────────────────────

  function plainRect(r) { return { left: r.left, top: r.top, width: r.width, height: r.height }; }

  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function isPiNode(el) {
    var id = el.id || "";
    var cls = typeof el.className === "string" ? el.className : "";
    return id.indexOf("pi-") === 0 || / ?pi-/.test(cls);
  }

  function parseColor(str) {
    var m = /rgba?\(([^)]+)\)/.exec(str || "");
    if (!m) return null;
    var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function isOpaqueEnough(c) { return !!c && c.a > 0.05; }

  function luminance(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

  function svg(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    return el;
  }

  function adopt(parent, child) { parent.appendChild(child); return child; }

  // ── reader ────────────────────────────────────────────────────────────

  function textLines(el) {
    var out = [];
    var range = document.createRange();
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !/\S/.test(n.nodeValue)) continue;
      range.selectNodeContents(n);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length && out.length < MAX_LINES_PER_ELEMENT; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) out.push(plainRect(rects[i]));
      }
    }
    return out;
  }

  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }

  /**
   * Build the record tree under `rootEl`. Returns { tree, nodes, partial }.
   * `nodes` pairs each record with its element, so a later frame can read the
   * rectangles again without a new walk.
   */
  function readTree(rootEl, cap) {
    var nodes = [];
    var visited = 0;
    var partial = false;
    var styleCache = new Map();

    function styleOf(el) {
      var s = styleCache.get(el);
      if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
      return s;
    }

    function childElements(el) {
      var holder = el.shadowRoot || el;
      return Array.prototype.slice.call(holder.children || []);
    }

    // Records of the children of `el`, going through display: contents.
    function readChildren(el) {
      var out = [];
      childElements(el).forEach(function (c) {
        if (partial) return;
        if (SKIP_TAGS.indexOf(c.localName) >= 0 || isPiNode(c)) return;
        var cs = styleOf(c);
        if (cs.display === "none") return;
        if (cs.display === "contents") {
          readChildren(c).forEach(function (r) { out.push(r); });
          return;
        }
        var rec = readOne(c, cs);
        if (rec) out.push(rec);
      });
      return out;
    }

    function readOne(el, cs) {
      visited += 1;
      if (visited > cap) { partial = true; return null; }
      var bg = parseColor(cs.backgroundColor);
      var rec = {
        id: nodes.length,
        tag: el.localName,
        rect: plainRect(el.getBoundingClientRect()),
        display: cs.display,
        position: cs.position,
        opacity: parseFloat(cs.opacity),
        overflow: cs.overflowX !== "visible" || cs.overflowY !== "visible" ? "clip" : "visible",
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        padding: { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) },
        border: { top: px(cs.borderTopWidth), right: px(cs.borderRightWidth), bottom: px(cs.borderBottomWidth), left: px(cs.borderLeftWidth) },
        radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
        fill: isOpaqueEnough(bg) ? cs.backgroundColor : null,
        hasBgImage: cs.backgroundImage !== "none",
        hasShadow: cs.boxShadow !== "none",
        hasOwnText: hasOwnText(el),
        lines: [],
        children: [],
      };
      rec.lines = rec.hasOwnText ? textLines(el) : [];
      nodes.push({ el: el, rec: rec, base: plainRect(rec.rect) });
      rec.children = readChildren(el);
      return rec;
    }

    var tree = readOne(rootEl, styleOf(rootEl));
    return { tree: tree, nodes: nodes, partial: partial };
  }

  // Read rectangles again, with no computed style. Lines follow their element.
  function refreshRects(nodes) {
    var sig = 0;
    nodes.forEach(function (n) {
      var r = n.el.getBoundingClientRect();
      var dx = r.left - n.base.left;
      var dy = r.top - n.base.top;
      if (dx || dy) {
        n.rec.lines = n.rec.lines.map(function (l) {
          return { left: l.left + dx, top: l.top + dy, width: l.width, height: l.height };
        });
        n.base = plainRect(r);
      }
      n.rec.rect = plainRect(r);
      sig += r.left * 3 + r.top * 5 + r.width * 7 + r.height * 11;
    });
    return sig;
  }

  function backgroundBehind(el) {
    for (var cur = el; cur; cur = cur.parentElement) {
      var c = parseColor(getComputedStyle(cur).backgroundColor);
      if (isOpaqueEnough(c)) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function chooseRootElement(frame, host) {
    var stack = document.elementsFromPoint(frame.left + frame.width / 2, frame.top + frame.height / 2)
      .filter(function (el) { return el !== host && !isPiNode(el) && el !== document.documentElement; });
    var rects = stack.map(function (el) { return plainRect(el.getBoundingClientRect()); });
    var i = ns.measure.chooseRoot(frame, rects);
    return i >= 0 ? stack[i] : document.body;
  }

  // ── renderer ──────────────────────────────────────────────────────────

  function specKey(s) {
    return [s.kind, s.id, s.side || s.corner || s.axis || ""].join(":");
  }

  function labelText(s) {
    if (s.kind === "size") return s.value.w + " × " + s.value.h;
    return String(s.value);
  }

  function boxesOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // First free spot from a list of candidates; the last spot of this key first.
  function placeLabel(anchor, size, placed, previous, view) {
    var cands = [
      { x: anchor.cx - size.w / 2, y: anchor.cy - size.h / 2 },
      { x: anchor.cx - size.w / 2, y: anchor.top - size.h - 2 },
      { x: anchor.cx - size.w / 2, y: anchor.bottom + 2 },
      { x: anchor.right + 2, y: anchor.cy - size.h / 2 },
      { x: anchor.left - size.w - 2, y: anchor.cy - size.h / 2 },
    ].map(function (c) {
      return {
        x: Math.min(Math.max(0, c.x), Math.max(0, view.w - size.w)),
        y: Math.min(Math.max(0, c.y), Math.max(0, view.h - size.h)),
        w: size.w, h: size.h,
      };
    });
    if (previous) cands.unshift({ x: previous.x, y: previous.y, w: size.w, h: size.h });
    for (var i = 0; i < cands.length; i++) {
      if (!placed.some(function (p) { return boxesOverlap(p, cands[i]); })) return cands[i];
    }
    return cands[cands.length > 1 ? 1 : 0];
  }

  function anchorOf(g) {
    return { left: g.left, top: g.top, right: g.left + g.width, bottom: g.top + g.height, cx: g.left + g.width / 2, cy: g.top + g.height / 2 };
  }

  function createOverlay(options) {
    var opts = options || {};
    var host = null;
    var shadow = null;
    var svgEl = null;
    var rafId = null;
    var frame = null; // raw dragged frame, viewport px
    var dirty = false;
    var lastScanAt = 0;
    var lastSig = null;
    var scanCap = MAX_CAP;
    var rootEl = null;
    var scene = null; // { tree, nodes, partial, bg, scale }
    var lastSpots = new Map();
    var opened = false;

    function mount() {
      if (host) return;
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("data-pi-xray", "");
      host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:" + Z_INDEX + ";";
      shadow = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = HOST_CSS;
      shadow.appendChild(style);
      svgEl = svg("svg", { xmlns: SVG_NS });
      shadow.appendChild(svgEl);
      document.documentElement.appendChild(host);
    }

    function scan() {
      var started = performance.now();
      rootEl = chooseRootElement(frame, host);
      var read = readTree(rootEl, scanCap);
      var rootRect = rootEl.getBoundingClientRect();
      var layoutWidth = rootEl.offsetWidth || rootRect.width;
      scene = {
        tree: read.tree,
        nodes: read.nodes,
        partial: read.partial,
        bg: backgroundBehind(rootEl),
        scale: ns.measure.scaleOf(rootRect.width, layoutWidth),
      };
      lastScanAt = started;
      var took = performance.now() - started;
      scanCap = took > SCAN_BUDGET_MS ? Math.max(MIN_CAP, Math.floor(scanCap / 2)) : scanCap;
    }

    function tick() {
      rafId = null;
      if (!frame || !host) return;
      var now = performance.now();
      if (dirty || !scene || now - lastScanAt >= SCAN_INTERVAL_MS) {
        scan();
        lastSig = null;
      } else {
        var sig = refreshRects(scene.nodes);
        if (sig === lastSig && !dirty) { schedule(); return; }
        lastSig = sig;
      }
      dirty = false;
      draw(ns.measure.measure({ frame: frame, root: scene.tree, step: ns.measure.GRID_STEP, scale: scene.scale, cap: MAX_CAP }));
      if (!opened) { opened = true; svgEl.classList.add("on"); }
      schedule();
    }

    function schedule() {
      if (rafId === null && frame) rafId = requestAnimationFrame(tick);
    }

    function draw(out) {
      var view = { w: innerWidth, h: innerHeight };
      var dark = luminance(scene.bg) < 0.5;
      var ink = dark ? "#ffffff" : "#111111";
      var paper = "rgb(" + scene.bg.r + "," + scene.bg.g + "," + scene.bg.b + ")";
      var f = out.frame;
      var s = out.scale;
      var minor = ns.measure.GRID_STEP * s;
      var major = minor * 4;

      var layer = svg("g");
      var defs = adopt(layer, svg("defs"));
      var clip = adopt(defs, svg("clipPath", { id: "xr-frame" }));
      adopt(clip, svg("rect", { x: f.left, y: f.top, width: f.width, height: f.height }));

      function gridPattern(id, step, opacity) {
        var p = adopt(defs, svg("pattern", { id: id, x: f.left, y: f.top, width: step, height: step, patternUnits: "userSpaceOnUse" }));
        adopt(p, svg("path", { d: "M " + step + " 0 L 0 0 L 0 " + step, fill: "none", stroke: ACCENT, "stroke-opacity": opacity, "stroke-width": 1 }));
      }
      gridPattern("xr-minor", minor, 0.14);
      gridPattern("xr-major", major, 0.3);
      var hatch = adopt(defs, svg("pattern", { id: "xr-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }));
      adopt(hatch, svg("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: ACCENT, "stroke-width": 2, "stroke-opacity": 0.45 }));

      adopt(layer, svg("rect", { x: f.left, y: f.top, width: f.width, height: f.height, fill: paper, "fill-opacity": 0.55 }));

      // Skeleton: surfaces, borders, blocks, and text bars, clipped to the frame.
      var skeleton = adopt(layer, svg("g", { "clip-path": "url(#xr-frame)" }));
      out.items.forEach(function (it) {
        var r = it.rect;
        if (it.block) {
          adopt(skeleton, svg("rect", { x: r.left, y: r.top, width: r.width, height: r.height, rx: it.radius[0] || 0, fill: ink, "fill-opacity": 0.16 }));
          return;
        }
        if (it.fill) {
          adopt(skeleton, svg("rect", { x: r.left, y: r.top, width: r.width, height: r.height, rx: it.radius[0] || 0, fill: it.fill }));
        }
        var b = it.border;
        if (b) {
          [[b.top, r.left, r.top, r.width, b.top * s], [b.bottom, r.left, r.top + r.height - b.bottom * s, r.width, b.bottom * s],
            [b.left, r.left, r.top, b.left * s, r.height], [b.right, r.left + r.width - b.right * s, r.top, b.right * s, r.height]]
            .forEach(function (q) {
              if (q[0] > 0) adopt(skeleton, svg("rect", { x: q[1], y: q[2], width: q[3], height: q[4], fill: ink, "fill-opacity": 0.45 }));
            });
        }
        it.lines.forEach(function (l) {
          var h = l.height * 0.6;
          adopt(skeleton, svg("rect", { x: l.left, y: l.top + (l.height - h) / 2, width: l.width, height: h, rx: h / 2, fill: ink, "fill-opacity": 0.3 }));
        });
      });
      adopt(layer, svg("rect", { x: f.left, y: f.top, width: f.width, height: f.height, fill: "url(#xr-minor)" }));
      adopt(layer, svg("rect", { x: f.left, y: f.top, width: f.width, height: f.height, fill: "url(#xr-major)" }));
      adopt(layer, svg("rect", { x: f.left, y: f.top, width: f.width, height: f.height, fill: "none", stroke: ACCENT, "stroke-width": 1.5 }));

      // Specs.
      var labels = [];
      out.specs.forEach(function (sp) {
        var g = sp.geometry;
        if (sp.kind === "gap" || sp.kind === "padding") {
          adopt(layer, svg("rect", { x: g.left, y: g.top, width: g.width, height: g.height, fill: "url(#xr-hatch)", "clip-path": "url(#xr-frame)" }));
          labels.push({ sp: sp, anchor: anchorOf(g) });
        } else if (sp.kind === "content") {
          adopt(layer, svg("rect", { x: g.left, y: g.top, width: g.width, height: g.height, fill: "none", stroke: ACCENT, "stroke-width": 1, "stroke-dasharray": "3 3", "clip-path": "url(#xr-frame)" }));
        } else if (sp.kind === "size") {
          adopt(layer, svg("rect", { x: g.left, y: g.top, width: g.width, height: g.height, fill: "none", stroke: sp.offGrid ? OFF_GRID : ACCENT, "stroke-width": 1, "stroke-opacity": 0.8, "clip-path": "url(#xr-frame)" }));
          labels.push({ sp: sp, anchor: { left: g.left, top: g.top, right: g.left + g.width, bottom: g.top + g.height, cx: g.left + g.width - 4, cy: g.top + g.height - 8 } });
        } else if (sp.kind === "radius") {
          adopt(layer, svg("circle", { cx: g.cx, cy: g.cy, r: Math.max(1, g.r), fill: "none", stroke: ACCENT, "stroke-width": 1, "stroke-dasharray": "2 2", "clip-path": "url(#xr-frame)" }));
          labels.push({ sp: sp, anchor: anchorOf({ left: g.cx, top: g.cy, width: 0, height: 0 }) });
        }
      });

      var placed = [];
      var nextSpots = new Map();
      labels.forEach(function (lb) {
        var text = labelText(lb.sp) + (lb.sp.kind === "size" && out.partial ? " partial" : "");
        var size = { w: text.length * 6.2 + 8, h: 14 };
        var key = specKey(lb.sp);
        var spot = placeLabel(lb.anchor, size, placed, lastSpots.get(key), view);
        placed.push(spot);
        nextSpots.set(key, spot);
        var color = lb.sp.offGrid ? OFF_GRID : ACCENT;
        adopt(layer, svg("rect", { x: spot.x, y: spot.y, width: spot.w, height: spot.h, rx: 3, fill: paper, "fill-opacity": 0.92, stroke: color, "stroke-width": 1 }));
        var t = adopt(layer, svg("text", { x: spot.x + 4, y: spot.y + 10, fill: lb.sp.offGrid ? OFF_GRID : ink }));
        t.textContent = text;
      });
      lastSpots = nextSpots;

      svgEl.replaceChildren(layer);
    }

    return {
      setFrame: function (rect) {
        mount();
        frame = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        dirty = true;
        schedule();
      },
      isOpen: function () { return !!frame; },
      close: function () {
        frame = null;
        scene = null;
        opened = false;
        lastSpots = new Map();
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        if (svgEl) { svgEl.classList.remove("on"); svgEl.replaceChildren(); }
      },
      destroy: function () {
        this.close();
        if (host) { host.remove(); host = null; shadow = null; svgEl = null; }
      },
      hostElement: function () { return host; },
    };
  }

  ns.createOverlay = createOverlay;
  ns.HOST_ID = HOST_ID;
})(globalThis);
