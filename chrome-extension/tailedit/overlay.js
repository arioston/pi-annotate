/**
 * Pi Annotate — Tailedit box-model overlay (Phase D1, plan 416)
 *
 * Draws coloured margin / padding / content regions over the pinned element,
 * each labelled with the Tailwind class responsible for that side (falling
 * back to the computed px when no utility class is responsible). Per the
 * design (docs/tailscan-integration-design.md §Phase D) and plan 416:
 *
 *   - Two-tier refresh, the core perf contract:
 *       Tier 1 (recompute, expensive/rare) — getComputedStyle + the class
 *       lookup, run ONLY on pin / class change / resize. Cached in a plain
 *       object.
 *       Tier 2 (reposition, cheap/frequent) — getBoundingClientRect ONLY, on
 *       scroll, coalesced through a single requestAnimationFrame.
 *     getComputedStyle is NEVER called from reposition() or from a scroll
 *     handler — that is precisely the freeze-prevention contract plans
 *     280/285 exist to protect.
 *   - Opt-in, pinned-only: the caller (editor.js) only calls setTarget() with
 *     a non-null element when the user has switched the overlay on.
 *   - Never writes to the measured page element — every `.style` write in
 *     this file targets a node this factory created and owns.
 *   - Labels prefer the class the element actually has (via ns.spacing.SIDES)
 *     and fall back to the computed px; never a guessed class.
 *
 * Loaded raw (no bundler) BEFORE editor.js, AFTER tw-spacing.js. Registers
 * ns.createOverlay (a factory, not a singleton — no shared globals) on the
 * single window.__piTailedit namespace.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  // side name -> [CSS property for computed px, region-node kind]
  const SIDE_NAMES = ["top", "right", "bottom", "left"];

  function classListOf(el) {
    return ((el && el.getAttribute && el.getAttribute("class")) || "").split(/\s+/).filter(Boolean);
  }

  /**
   * Resolve the class responsible for one side of one box (padding or
   * margin), longest-specific prefix first, per ns.spacing.SIDES. Only
   * considers live, unprefixed (no ":") classes actually present on the
   * element — never guesses. Returns null when no utility class matches
   * (the caller falls back to the computed px in that case).
   */
  function responsibleClass(el, side, box) {
    const prefixes = ns.spacing.SIDES[side][box];
    const rx = ns.spacing.familyRegex;
    const live = classListOf(el).filter((cls) => !cls.includes(":"));
    for (const prefix of prefixes) {
      const pattern = rx(prefix);
      for (const cls of live) {
        if (pattern.test(cls)) return cls;
      }
    }
    return null;
  }

  ns.createOverlay = function (opts) {
    const root = (opts && opts.root) || null;

    let target = null; // the measured page element (read-only, never written to)
    let container = null;
    let regions = {}; // { "margin:top": { el, label } , "padding:top": {...}, content: {...} }
    let cache = null; // tier-1 result: { margin: {top,right,bottom,left}, padding: {...}, labels: {...} }
    let rafId = null;
    let enabled = false;

    function buildDom() {
      if (container || !root) return;
      container = document.createElement("div");
      container.className = "te-ov";
      container.style.display = "none";

      const make = (cls) => {
        const el = document.createElement("div");
        el.className = cls;
        el.style.pointerEvents = "none";
        const label = document.createElement("span");
        label.className = "te-ov-label";
        el.appendChild(label);
        container.appendChild(el);
        return { el, label };
      };

      for (const side of SIDE_NAMES) {
        regions["margin:" + side] = make("te-ov-m " + side);
        regions["padding:" + side] = make("te-ov-p " + side);
      }
      regions.content = make("te-ov-c");

      root.appendChild(container);
    }

    /** tier 1 — expensive, rare: getComputedStyle + class-label lookup. */
    function recompute() {
      if (!target || !container) return;
      if (!document.contains(target)) {
        cache = null;
        reposition();
        return;
      }
      const cs = getComputedStyle(target);
      const margin = {
        top: parseFloat(cs.marginTop) || 0,
        right: parseFloat(cs.marginRight) || 0,
        bottom: parseFloat(cs.marginBottom) || 0,
        left: parseFloat(cs.marginLeft) || 0,
      };
      const padding = {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      };
      // getBoundingClientRect() returns the BORDER box, not the padding box —
      // border width has to be read here (tier 1) so reposition() (tier 2)
      // can derive the padding box without ever calling getComputedStyle.
      const border = {
        top: parseFloat(cs.borderTopWidth) || 0,
        right: parseFloat(cs.borderRightWidth) || 0,
        bottom: parseFloat(cs.borderBottomWidth) || 0,
        left: parseFloat(cs.borderLeftWidth) || 0,
      };
      const labels = {};
      for (const side of SIDE_NAMES) {
        const marginCls = responsibleClass(target, side, "margin");
        labels["margin:" + side] = marginCls || Math.round(margin[side]) + "px";
        labels["margin:" + side + ":muted"] = !marginCls;
        const paddingCls = responsibleClass(target, side, "padding");
        labels["padding:" + side] = paddingCls || Math.round(padding[side]) + "px";
        labels["padding:" + side + ":muted"] = !paddingCls;
      }
      cache = { margin, padding, border, labels };
      reposition();
    }

    /** tier 2 — cheap, frequent: getBoundingClientRect ONLY. No getComputedStyle here. */
    function reposition() {
      if (!container) return;
      if (!enabled || !target || !cache || !document.contains(target)) {
        if (container) container.style.display = "none";
        return;
      }
      container.style.display = "block";
      const r = target.getBoundingClientRect(); // the BORDER box
      const { margin, padding, border } = cache;

      // getBoundingClientRect() is the border box. The padding box sits
      // inset from it by the border width on each side — derive that first,
      // then place every inner region (padding strips, content) relative to
      // the padding box, not the raw border-box rect.
      const padLeft = r.left + border.left;
      const padTop = r.top + border.top;
      const padWidth = Math.max(0, r.width - border.left - border.right);
      const padHeight = Math.max(0, r.height - border.top - border.bottom);

      // Content box: the padding box inset by the padding widths.
      placeRegion(
        regions.content,
        padLeft + padding.left, padTop + padding.top,
        Math.max(0, padWidth - padding.left - padding.right),
        Math.max(0, padHeight - padding.top - padding.bottom),
        null, true,
      );

      // Padding regions: thin strips just inside the padding box's edges
      // (i.e. just inside the border, which is exactly where padding lives).
      placeRegion(
        regions["padding:top"],
        padLeft, padTop, padWidth, padding.top,
        cache.labels["padding:top"], cache.labels["padding:top:muted"],
      );
      placeRegion(
        regions["padding:bottom"],
        padLeft, padTop + padHeight - padding.bottom, padWidth, padding.bottom,
        cache.labels["padding:bottom"], cache.labels["padding:bottom:muted"],
      );
      placeRegion(
        regions["padding:left"],
        padLeft, padTop + padding.top, padding.left, Math.max(0, padHeight - padding.top - padding.bottom),
        cache.labels["padding:left"], cache.labels["padding:left:muted"],
      );
      placeRegion(
        regions["padding:right"],
        padLeft + padWidth - padding.right, padTop + padding.top, padding.right, Math.max(0, padHeight - padding.top - padding.bottom),
        cache.labels["padding:right"], cache.labels["padding:right:muted"],
      );

      // Margin regions: thin strips just outside the element's edges.
      placeRegion(
        regions["margin:top"],
        r.left - margin.left, r.top - margin.top, r.width + margin.left + margin.right, margin.top,
        cache.labels["margin:top"], cache.labels["margin:top:muted"],
      );
      placeRegion(
        regions["margin:bottom"],
        r.left - margin.left, r.top + r.height, r.width + margin.left + margin.right, margin.bottom,
        cache.labels["margin:bottom"], cache.labels["margin:bottom:muted"],
      );
      placeRegion(
        regions["margin:left"],
        r.left - margin.left, r.top, margin.left, r.height,
        cache.labels["margin:left"], cache.labels["margin:left:muted"],
      );
      placeRegion(
        regions["margin:right"],
        r.left + r.width, r.top, margin.right, r.height,
        cache.labels["margin:right"], cache.labels["margin:right:muted"],
      );
    }

    /** Position + label ONE region node. size<=0 hides the region and its label. */
    function placeRegion(region, left, top, width, height, labelText, muted) {
      if (!region) return;
      if (width <= 0 || height <= 0) {
        region.el.style.display = "none";
        return;
      }
      region.el.style.display = "block";
      region.el.style.left = left + "px";
      region.el.style.top = top + "px";
      region.el.style.width = width + "px";
      region.el.style.height = height + "px";
      if (labelText === null) {
        region.label.style.display = "none";
        return;
      }
      region.label.style.display = "inline-block";
      region.label.textContent = labelText;
      region.label.classList.toggle("muted", !!muted);
    }

    /** rAF-coalesced tier-2 refresh — safe to call at scroll-handler rate. */
    function scheduleReposition() {
      if (rafId !== null) return; // a frame is already pending — no-op
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reposition();
      });
    }

    /**
     * Sets (or clears) the measured element. Clearing hides the overlay
     * immediately (cheap). Setting a live element does NOT itself run
     * getComputedStyle — the caller (editor.js) always follows setTarget()
     * with an explicit recompute() at every tier-1 hook site, so a target
     * change never pays for two getComputedStyle passes back to back.
     */
    function setTarget(el) {
      target = el || null;
      if (!target) {
        cache = null;
        reposition();
      }
    }

    function setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (container) container.style.display = "none";
        return;
      }
      buildDom();
      if (target) recompute();
    }

    function destroy() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (container && container.parentNode) container.parentNode.removeChild(container);
      container = null;
      regions = {};
      cache = null;
      target = null;
      enabled = false;
    }

    return { setTarget, recompute, reposition, scheduleReposition, setEnabled, destroy };
  };
})();
