/**
 * Pi Annotate - X-ray measurement core (plan 1168)
 *
 * Pure logic for the X-ray mode. Plain data in, plain data out. The DOM reader
 * (overlay.js) turns the live page into a tree of plain records. This file
 * turns that tree and a frame into the specs to draw: gaps, paddings, content
 * boxes, sizes, and corner radii, each in CSS px with its geometry in screen px.
 *
 * CONTRACT
 *   - No DOM access, no browser API, no extension API. Node can run this file
 *     (tests/xray-measure.test.mjs, docs/probes/xray-check.js).
 *   - Input records and output specs are JSON only: no node, no function.
 *   - Registers on the single X-ray namespace; no other global.
 *
 * RECORD (one per element, built by the reader)
 *   { id, tag, rect:{left,top,width,height}   // screen px
 *     display, position, opacity, overflow, flexDirection, justifyContent,
 *     padding:{top,right,bottom,left}, border:{top,right,bottom,left}, // CSS px
 *     radius:[tl,tr,br,bl]    // numbers (CSS px) or strings like "8px", "50%"
 *     fill, hasBgImage, hasShadow, hasOwnText, lines:[rect],
 *     children:[record] }
 *
 * UNITS. A rectangle is in screen px. A value is in CSS px. `scale` is the
 * factor between the two (rect width over layout width of the root).
 *
 * GRID. The grid step is in CSS px. A value is on the grid when its distance
 * to the nearest multiple of the step is at most 0.5 CSS px.
 */
(function (root) {
  "use strict";

  var ns = (root.__piXray = root.__piXray || {});

  var GRID_STEP = 4;
  var MIN_GAP = 0.5;
  var GRID_TOLERANCE = 0.5;
  var BLOCK_MAX_HEIGHT = 64;
  var MIN_OPACITY = 0.01;
  var DEFAULT_CAP = 1500;
  var REPLACED = ["img", "svg", "video", "canvas", "iframe", "input", "textarea", "select"];
  var CORNERS = ["tl", "tr", "br", "bl"];

  // ── numbers and rectangles ────────────────────────────────────────────

  function round2(n) { return Math.round(n * 100) / 100; }

  function toCss(px, scale) { return scale > 0 ? px / scale : px; }

  function scaleOf(rectWidth, layoutWidth) {
    return layoutWidth > 0 && rectWidth > 0 ? rectWidth / layoutWidth : 1;
  }

  function isOnGrid(cssValue, step) {
    var s = step || GRID_STEP;
    var nearest = Math.round(cssValue / s) * s;
    return Math.abs(cssValue - nearest) <= GRID_TOLERANCE;
  }

  function right(r) { return r.left + r.width; }
  function bottom(r) { return r.top + r.height; }

  function intersect(a, b) {
    var l = Math.max(a.left, b.left);
    var t = Math.max(a.top, b.top);
    var r = Math.min(right(a), right(b));
    var bt = Math.min(bottom(a), bottom(b));
    return r > l && bt > t ? { left: l, top: t, width: r - l, height: bt - t } : null;
  }

  function contains(outer, inner) {
    return outer.left <= inner.left && outer.top <= inner.top &&
      right(outer) >= right(inner) && bottom(outer) >= bottom(inner);
  }

  // ── frame and root ────────────────────────────────────────────────────

  /**
   * Snap the corners of a frame to the grid. The grid origin is the top-left
   * corner of the measured root; the step is `step` CSS px, so `step * scale`
   * screen px.
   */
  function snapFrame(frame, origin, step, scale) {
    var s = (step || GRID_STEP) * (scale > 0 ? scale : 1);
    function snap(v, o) { return o + Math.round((v - o) / s) * s; }
    var l = snap(frame.left, origin.left);
    var t = snap(frame.top, origin.top);
    var r = snap(right(frame), origin.left);
    var b = snap(bottom(frame), origin.top);
    return { left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
  }

  /**
   * Index of the innermost rectangle that holds the whole frame. `rects` is
   * ordered innermost first (the order of an elements-from-point list).
   * Returns -1 when none holds it; the reader then falls back to the body.
   */
  function chooseRoot(frame, rects) {
    for (var i = 0; i < rects.length; i++) {
      if (contains(rects[i], frame)) return i;
    }
    return -1;
  }

  // ── classification ────────────────────────────────────────────────────

  function hasBorder(rec) {
    var b = rec.border || {};
    return (b.top > 0) || (b.right > 0) || (b.bottom > 0) || (b.left > 0);
  }

  function hasFill(rec) { return !!rec.fill; }

  function anyChild(rec, test) {
    return (rec.children || []).some(function (c) { return test(c) || anyChild(c, test); });
  }

  function subtreeHasText(rec) {
    return !!rec.hasOwnText || anyChild(rec, function (c) { return !!c.hasOwnText; });
  }

  function isBlock(rec, scale) {
    if (REPLACED.indexOf(String(rec.tag || "").toLowerCase()) >= 0) return true;
    if (rec.hasBgImage) return true;
    if (!hasFill(rec)) return false;
    if (anyChild(rec, function (c) { return hasFill(c) || hasBorder(c); })) return false;
    var heightCss = toCss(rec.rect.height, scale);
    return heightCss <= BLOCK_MAX_HEIGHT || !subtreeHasText(rec);
  }

  function isMeasured(rec, block) {
    return block || hasFill(rec) || hasBorder(rec) || !!rec.hasShadow || !!rec.hasOwnText;
  }

  // ── collection ────────────────────────────────────────────────────────

  function isHidden(rec) {
    return rec.display === "none" || (typeof rec.opacity === "number" && rec.opacity < MIN_OPACITY);
  }

  function clipsContent(rec) {
    return !!rec.overflow && rec.overflow !== "visible";
  }

  /**
   * Walk the tree in document order. Keep the elements that touch the frame
   * and sit inside the clip of each ancestor with non-visible overflow. A
   * block is kept, and its children are not visited. Stops at `cap` elements
   * and reports it.
   */
  function collect(rootRec, frame, cap, scale) {
    var limit = cap || DEFAULT_CAP;
    var kept = [];
    var visited = 0;
    var partial = false;

    function visit(rec, parent, clip) {
      if (partial) return;
      visited += 1;
      if (visited > limit) { partial = true; return; }
      if (isHidden(rec)) return;
      var visible = intersect(rec.rect, clip);
      var touches = visible && intersect(rec.rect, frame);
      var block = isBlock(rec, scale);
      if (touches) kept.push({ rec: rec, parent: parent, block: block, measured: isMeasured(rec, block) });
      if (block) return;
      var childClip = clipsContent(rec) ? (intersect(clip, rec.rect) || { left: 0, top: 0, width: 0, height: 0 }) : clip;
      (rec.children || []).forEach(function (c) { visit(c, rec, childClip); });
    }

    visit(rootRec, null, { left: -1e9, top: -1e9, width: 2e9, height: 2e9 });
    return { kept: kept, partial: partial };
  }

  // ── specs ─────────────────────────────────────────────────────────────

  function valueSpec(kind, cssValue, geometry, step) {
    return { kind: kind, value: round2(cssValue), geometry: geometry, offGrid: !isOnGrid(cssValue, step) };
  }

  function isFlowChild(rec) {
    return rec.position !== "absolute" && rec.position !== "fixed" && !isHidden(rec);
  }

  function isRowFlex(rec) {
    var flex = rec.display === "flex" || rec.display === "inline-flex";
    return flex && (!rec.flexDirection || rec.flexDirection === "row" || rec.flexDirection === "row-reverse");
  }

  function spreadsRoom(rec) {
    var j = String(rec.justifyContent || "");
    return j.indexOf("space-") >= 0 || j.indexOf("evenly") >= 0;
  }

  /** Gaps between adjacent in-flow children of one parent. */
  function gapsOf(parent, scale, step) {
    if (spreadsRoom(parent)) return [];
    var horizontal = isRowFlex(parent);
    var kids = (parent.children || []).filter(isFlowChild).slice().sort(function (a, b) {
      return horizontal ? a.rect.left - b.rect.left : a.rect.top - b.rect.top;
    });
    var out = [];
    for (var i = 1; i < kids.length; i++) {
      var p = kids[i - 1].rect;
      var n = kids[i].rect;
      var distance = horizontal ? n.left - right(p) : n.top - bottom(p);
      var cssDistance = toCss(distance, scale);
      if (cssDistance < MIN_GAP) continue;
      var geometry;
      if (horizontal) {
        var t = Math.max(p.top, n.top);
        var h = Math.min(bottom(p), bottom(n)) - t;
        geometry = { left: right(p), top: h > 0 ? t : p.top, width: distance, height: h > 0 ? h : p.height };
      } else {
        var l = Math.max(p.left, n.left);
        var w = Math.min(right(p), right(n)) - l;
        geometry = { left: w > 0 ? l : p.left, top: bottom(p), width: w > 0 ? w : p.width, height: distance };
      }
      var spec = valueSpec("gap", cssDistance, geometry, step);
      spec.axis = horizontal ? "x" : "y";
      out.push(spec);
    }
    return out;
  }

  /** Four padding strips and one content box for one element. */
  function paddingsOf(rec, scale, step) {
    var pad = rec.padding || {};
    var bw = rec.border || {};
    var r = rec.rect;
    var inner = {
      left: r.left + (bw.left || 0) * scale,
      top: r.top + (bw.top || 0) * scale,
      width: r.width - ((bw.left || 0) + (bw.right || 0)) * scale,
      height: r.height - ((bw.top || 0) + (bw.bottom || 0)) * scale,
    };
    var specs = [];
    var any = false;
    ["top", "right", "bottom", "left"].forEach(function (side) {
      var v = pad[side] || 0;
      if (!(v > 0)) return;
      any = true;
      var px = v * scale;
      var g = side === "top" ? { left: inner.left, top: inner.top, width: inner.width, height: px }
        : side === "bottom" ? { left: inner.left, top: bottom(inner) - px, width: inner.width, height: px }
        : side === "left" ? { left: inner.left, top: inner.top, width: px, height: inner.height }
        : { left: right(inner) - px, top: inner.top, width: px, height: inner.height };
      var spec = valueSpec("padding", v, g, step);
      spec.side = side;
      specs.push(spec);
    });
    if (any) {
      specs.push({
        kind: "content",
        geometry: {
          left: inner.left + (pad.left || 0) * scale,
          top: inner.top + (pad.top || 0) * scale,
          width: Math.max(0, inner.width - ((pad.left || 0) + (pad.right || 0)) * scale),
          height: Math.max(0, inner.height - ((pad.top || 0) + (pad.bottom || 0)) * scale),
        },
      });
    }
    return specs;
  }

  function sizeSpec(rec, scale, step) {
    var w = toCss(rec.rect.width, scale);
    var h = toCss(rec.rect.height, scale);
    return {
      kind: "size",
      value: { w: round2(w), h: round2(h) },
      geometry: rec.rect,
      offGrid: !isOnGrid(w, step) || !isOnGrid(h, step),
    };
  }

  // ── radius ────────────────────────────────────────────────────────────

  /** A radius value in CSS px. A percentage resolves against the width. */
  function parseRadius(value, widthCss) {
    if (typeof value === "number") return isFinite(value) ? value : 0;
    var first = String(value == null ? "" : value).trim().split(/\s+/)[0];
    var n = parseFloat(first);
    if (!isFinite(n)) return 0;
    return /%$/.test(first) ? (n / 100) * widthCss : n;
  }

  function cornerCentre(rect, corner, rScreen) {
    var x = corner === "tl" || corner === "bl" ? rect.left + rScreen : right(rect) - rScreen;
    var y = corner === "tl" || corner === "tr" ? rect.top + rScreen : bottom(rect) - rScreen;
    return { x: x, y: y };
  }

  /**
   * One corner for each rounded element. A circle or a pill (radius at or
   * above half the shorter side) gives none. A corner whose arc centre is the
   * same point as the arc centre of another element wins (concentric).
   */
  function radiiOf(items, scale) {
    var cands = [];
    items.forEach(function (it) {
      var r = it.rec;
      var wCss = toCss(r.rect.width, scale);
      var hCss = toCss(r.rect.height, scale);
      var shorter = Math.min(wCss, hCss);
      var list = [];
      CORNERS.forEach(function (corner, i) {
        var v = parseRadius((r.radius || [])[i], wCss);
        if (v > 0 && v < shorter / 2) {
          list.push({ id: r.id, corner: corner, value: v, centre: cornerCentre(r.rect, corner, v * scale), rect: r.rect });
        }
      });
      if (list.length) cands.push(list);
    });
    var tol = 0.5 * (scale > 0 ? scale : 1);
    function shared(c) {
      return cands.some(function (other) {
        return other[0].id !== c.id && other.some(function (o) {
          return Math.abs(o.centre.x - c.centre.x) <= tol && Math.abs(o.centre.y - c.centre.y) <= tol;
        });
      });
    }
    return cands.map(function (list) {
      var pick = list.filter(shared)[0] || list[0];
      return {
        kind: "radius",
        id: pick.id,
        corner: pick.corner,
        value: round2(pick.value),
        concentric: shared(pick),
        offGrid: false,
        geometry: { cx: pick.centre.x, cy: pick.centre.y, r: pick.value * scale },
      };
    });
  }

  // ── entry point ───────────────────────────────────────────────────────

  /**
   * measure({ frame, root, step, scale, cap })
   * `frame` is the raw dragged frame in screen px, `root` the record tree of
   * the measured root. Returns the snapped frame and the lists to draw.
   */
  function measure(input) {
    var step = input.step || GRID_STEP;
    var scale = input.scale > 0 ? input.scale : 1;
    var rootRec = input.root;
    var frame = snapFrame(input.frame, rootRec.rect, step, scale);
    var found = collect(rootRec, frame, input.cap, scale);

    var items = [];
    var specs = [];
    var blocks = [];
    var sizedRoot = false;
    found.kept.forEach(function (k) {
      var rec = k.rec;
      var isRoot = rec === rootRec;
      if (!k.measured && !isRoot) return;
      items.push({
        id: rec.id,
        tag: rec.tag,
        rect: rec.rect,
        block: k.block,
        fill: rec.fill || null,
        radius: (rec.radius || []).map(function (v) { return parseRadius(v, toCss(rec.rect.width, scale)) * scale; }),
        border: rec.border || null,
        lines: rec.lines || [],
      });
      if (k.block) blocks.push(rec.id);
      if (!k.block) {
        paddingsOf(rec, scale, step).forEach(function (s) { s.id = rec.id; specs.push(s); });
        gapsOf(rec, scale, step).forEach(function (s) { s.id = rec.id; specs.push(s); });
      }
      if (k.block || isRoot) {
        var s = sizeSpec(rec, scale, step);
        s.id = rec.id;
        specs.push(s);
        if (isRoot) sizedRoot = true;
      }
    });
    if (!sizedRoot) {
      var rs = sizeSpec(rootRec, scale, step);
      rs.id = rootRec.id;
      specs.push(rs);
    }
    var roundable = found.kept.filter(function (k) { return k.measured; });
    radiiOf(roundable.map(function (k) { return { rec: k.rec }; }), scale).forEach(function (s) { specs.push(s); });

    return { frame: frame, scale: scale, step: step, partial: found.partial, items: items, blocks: blocks, specs: specs };
  }

  ns.measure = {
    GRID_STEP: GRID_STEP,
    snapFrame: snapFrame,
    chooseRoot: chooseRoot,
    isBlock: isBlock,
    isMeasured: isMeasured,
    collect: collect,
    gapsOf: gapsOf,
    paddingsOf: paddingsOf,
    radiiOf: radiiOf,
    parseRadius: parseRadius,
    toCss: toCss,
    scaleOf: scaleOf,
    isOnGrid: isOnGrid,
    measure: measure,
  };
})(globalThis);
