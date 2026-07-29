/**
 * Pi Annotate — Tailedit guidelines and measuring lines (Phase D3, plan 423)
 *
 * Answers the question the box-model overlay cannot: not "what padding does
 * THIS element have?" but "how far apart are THESE TWO?". With one element
 * pinned (the anchor) and another hovered (the probe), draws the distances
 * between them and the edges on which they align.
 *
 * PERF CONTRACT — the important part. Plan 416's overlay has an expensive
 * tier 1 (getComputedStyle) and a cheap tier 2 (getBoundingClientRect), and its
 * whole discipline exists to keep tier 1 off the scroll/mousemove path. This
 * module needs NO tier 1 at all: every distance between two elements is rect
 * arithmetic. So:
 *
 *   - No computed-style call appears anywhere in this file, in any form. There
 *     is no expensive path to accidentally call from a handler. (The repo-wide
 *     single-reader gate is a plain grep, so this comment deliberately avoids
 *     spelling the API name.)
 *   - The spacing base used for the `N × spacing` annotation comes from
 *     tw-theme.js (plan 421/422's `family("spacing").basePx`), which is the
 *     codebase's one and only :root computed-style reader. Do not re-probe it
 *     here.
 *   - Rect reads are coalesced through exactly one requestAnimationFrame, with
 *     the same `rafId !== null` early return overlay.js uses.
 *   - `setProbe()` no-ops when handed the element it already has, which is what
 *     makes it safe to call from a mousemove handler.
 *
 * HONESTY RULE (plans 416, 420, 421). Labels are measured px. A gap between two
 * elements has no provable responsible class — it could be a margin, a gap, a
 * justify-between, or absolute positioning — so this file never names one. The
 * optional muted annotation is arithmetic on a known base ("4 × spacing"), not
 * a guess ("gap-4").
 *
 * `measure()` and `annotate()` are pure and public on `ns.guides` so they can be
 * driven from node without a browser (docs/probes/guides-check.js) and reused
 * by any later phase that wants a measurement readout.
 *
 * Never writes to a page element — every `.style` write here targets a node
 * this factory created and owns.
 *
 * Loaded raw (no bundler) AFTER tw-theme.js, BEFORE editor.js. Registers onto
 * the single window.__piTailedit namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  const DEFAULT_TOLERANCE = 1; // px, for edge/centre agreement
  const MAX_STEPS = 64; // "384 × spacing" is noise, not insight

  function edges(rect) {
    return {
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      bottom: rect.top + rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    };
  }

  /** Overlap extent of two 1-D spans, or null when they do not overlap. */
  function overlap1d(aMin, aMax, bMin, bMax) {
    const min = Math.max(aMin, bMin);
    const max = Math.min(aMax, bMax);
    return max > min ? { min, max, mid: (min + max) / 2 } : null;
  }

  function contains(outer, inner) {
    return (
      inner.left >= outer.left &&
      inner.right <= outer.right &&
      inner.top >= outer.top &&
      inner.bottom <= outer.bottom
    );
  }

  /**
   * Pure geometry. `anchor` and `probe` are {left, top, width, height} — a real
   * DOMRect satisfies that, which is what lets the harness pass plain objects.
   *
   *   relation: "apart"       — a gap on at least one axis
   *             "contained"   — probe is inside anchor (insets on all 4 sides)
   *             "contains"    — anchor is inside probe
   *             "overlapping" — they intersect but neither contains the other
   *
   * Distances are emitted ONLY where a non-negative gap genuinely exists. For
   * "overlapping" that is nowhere: a negative gap is not a measurement, and
   * drawing one would be a lie. Values are exact; rounding is the renderer's
   * job so the harness can assert on real numbers.
   */
  function measure(anchor, probe, opts) {
    const tolerance = opts && typeof opts.tolerance === "number" ? opts.tolerance : DEFAULT_TOLERANCE;
    const a = edges(anchor);
    const b = edges(probe);
    const distances = [];

    const overlapX = overlap1d(a.left, a.right, b.left, b.right);
    const overlapY = overlap1d(a.top, a.bottom, b.top, b.bottom);

    // Where to draw a horizontal connector: down the middle of the vertical
    // extent the two elements share, so the line sits where both actually are.
    // With no shared extent, split the difference between them.
    const atY = overlapY ? overlapY.mid : (Math.min(a.bottom, b.bottom) + Math.max(a.top, b.top)) / 2;
    const atX = overlapX ? overlapX.mid : (Math.min(a.right, b.right) + Math.max(a.left, b.left)) / 2;

    const probeInAnchor = contains(a, b);
    const anchorInProbe = contains(b, a);

    if (probeInAnchor || anchorInProbe) {
      const outer = probeInAnchor ? a : b;
      const inner = probeInAnchor ? b : a;
      distances.push(
        { axis: "x", side: "left", px: inner.left - outer.left, from: outer.left, to: inner.left, at: atY },
        { axis: "x", side: "right", px: outer.right - inner.right, from: inner.right, to: outer.right, at: atY },
        { axis: "y", side: "top", px: inner.top - outer.top, from: outer.top, to: inner.top, at: atX },
        { axis: "y", side: "bottom", px: outer.bottom - inner.bottom, from: inner.bottom, to: outer.bottom, at: atX },
      );
    } else {
      if (!overlapX) {
        const probeIsRight = b.left >= a.right;
        const from = probeIsRight ? a.right : b.right;
        const to = probeIsRight ? b.left : a.left;
        distances.push({ axis: "x", side: probeIsRight ? "right" : "left", px: to - from, from, to, at: atY });
      }
      if (!overlapY) {
        const probeIsBelow = b.top >= a.bottom;
        const from = probeIsBelow ? a.bottom : b.bottom;
        const to = probeIsBelow ? b.top : a.top;
        distances.push({ axis: "y", side: probeIsBelow ? "bottom" : "top", px: to - from, from, to, at: atX });
      }
    }

    // Alignment is reported independently of the relation — two overlapping
    // elements that share a left edge is exactly the case someone is checking.
    const aligned = [];
    const near = (p, q) => Math.abs(p - q) <= tolerance;
    if (near(a.left, b.left)) aligned.push({ axis: "x", kind: "left", at: a.left });
    if (near(a.right, b.right)) aligned.push({ axis: "x", kind: "right", at: a.right });
    if (near(a.centerX, b.centerX)) aligned.push({ axis: "x", kind: "center", at: a.centerX });
    if (near(a.top, b.top)) aligned.push({ axis: "y", kind: "top", at: a.top });
    if (near(a.bottom, b.bottom)) aligned.push({ axis: "y", kind: "bottom", at: a.bottom });
    if (near(a.centerY, b.centerY)) aligned.push({ axis: "y", kind: "center", at: a.centerY });

    let relation;
    if (probeInAnchor) relation = "contained";
    else if (anchorInProbe) relation = "contains";
    else if (overlapX && overlapY) relation = "overlapping";
    else relation = "apart";

    return { relation, distances, aligned };
  }

  /**
   * `px` expressed in spacing steps, when it is an exact multiple of the
   * theme's base unit. Returns `steps: null` rather than a rounded lie.
   * NEVER returns a class name — see the honesty rule in the header.
   */
  function annotate(px, basePx) {
    if (!basePx || !(basePx > 0) || !isFinite(px)) return { px, steps: null };
    const steps = px / basePx;
    const rounded = Math.round(steps);
    if (Math.abs(steps - rounded) * basePx > 0.5) return { px, steps: null };
    if (rounded <= 0 || rounded > MAX_STEPS) return { px, steps: null };
    return { px, steps: rounded };
  }

  ns.guides = { measure, annotate, MAX_STEPS, DEFAULT_TOLERANCE };

  ns.createGuides = function (opts) {
    const root = (opts && opts.root) || null;
    const getBasePx = (opts && opts.getBasePx) || (() => null);

    let anchor = null; // pinned element (read-only)
    let probe = null; // hovered element (read-only)
    let container = null;
    let distanceNodes = []; // pool of 4 — the containment case is the maximum
    let alignNodes = []; // pool of 6 — one per alignment kind
    let rafId = null;
    let enabled = false;

    function makeNode(cls, withLabel) {
      const el = document.createElement("div");
      el.className = cls;
      el.style.display = "none";
      el.style.pointerEvents = "none";
      let label = null;
      if (withLabel) {
        label = document.createElement("span");
        label.className = "te-gd-label";
        const value = document.createElement("span");
        value.className = "te-gd-value";
        const steps = document.createElement("span");
        steps.className = "te-gd-steps";
        label.appendChild(value);
        label.appendChild(steps);
        el.appendChild(label);
      }
      container.appendChild(el);
      return { el, label, value: label ? label.firstChild : null, steps: label ? label.lastChild : null };
    }

    function buildDom() {
      if (container || !root) return;
      container = document.createElement("div");
      container.className = "te-gd";
      container.style.display = "none";
      distanceNodes = [0, 1, 2, 3].map(() => makeNode("te-gd-line", true));
      alignNodes = [0, 1, 2, 3, 4, 5].map(() => makeNode("te-gd-align", false));
      root.appendChild(container);
    }

    function hideAll() {
      for (const node of distanceNodes) node.el.style.display = "none";
      for (const node of alignNodes) node.el.style.display = "none";
    }

    /** The only renderer: two getBoundingClientRect calls, then pure math. */
    function reposition() {
      if (!container) return;
      if (
        !enabled ||
        !anchor ||
        !probe ||
        anchor === probe ||
        !document.contains(anchor) ||
        !document.contains(probe)
      ) {
        container.style.display = "none";
        return;
      }
      container.style.display = "block";
      hideAll();

      const result = measure(anchor.getBoundingClientRect(), probe.getBoundingClientRect());
      const basePx = getBasePx();

      result.distances.slice(0, distanceNodes.length).forEach((d, i) => {
        const node = distanceNodes[i];
        const px = Math.round(d.px);
        if (px <= 0) return; // a zero-width connector is not a measurement
        const horizontal = d.axis === "x";
        node.el.style.display = "block";
        node.el.style.left = (horizontal ? Math.min(d.from, d.to) : d.at) + "px";
        node.el.style.top = (horizontal ? d.at : Math.min(d.from, d.to)) + "px";
        node.el.style.width = (horizontal ? Math.abs(d.to - d.from) : 1) + "px";
        node.el.style.height = (horizontal ? 1 : Math.abs(d.to - d.from)) + "px";
        const annotated = annotate(d.px, basePx);
        node.value.textContent = px + "px";
        node.steps.textContent = annotated.steps ? " · " + annotated.steps + " × spacing" : "";
      });

      result.aligned.slice(0, alignNodes.length).forEach((g, i) => {
        const node = alignNodes[i];
        const vertical = g.axis === "x"; // an x-alignment draws a vertical line
        node.el.style.display = "block";
        node.el.style.left = (vertical ? g.at : 0) + "px";
        node.el.style.top = (vertical ? 0 : g.at) + "px";
        node.el.style.width = (vertical ? 1 : window.innerWidth) + "px";
        node.el.style.height = (vertical ? window.innerHeight : 1) + "px";
      });
    }

    /** rAF-coalesced refresh — safe to call at mousemove/scroll rate. */
    function scheduleReposition() {
      if (rafId !== null) return; // a frame is already pending — no-op
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reposition();
      });
    }

    function setAnchor(el) {
      anchor = el || null;
      probe = null;
      if (enabled) scheduleReposition();
    }

    /** Identity no-op is what keeps this cheap enough for a mousemove handler. */
    function setProbe(el) {
      const next = el || null;
      if (next === probe) return;
      probe = next;
      if (enabled) scheduleReposition();
    }

    function setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        probe = null;
        if (container) container.style.display = "none";
        return;
      }
      buildDom();
      scheduleReposition();
    }

    function destroy() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (container && container.parentNode) container.parentNode.removeChild(container);
      container = null;
      distanceNodes = [];
      alignNodes = [];
      anchor = null;
      probe = null;
      enabled = false;
    }

    return { setAnchor, setProbe, setEnabled, reposition, scheduleReposition, destroy };
  };
})();
