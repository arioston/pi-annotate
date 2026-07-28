/**
 * Pi Annotate — Tailedit editor (Phase A, plan 283)
 *
 * A shadow-DOM-isolated visual Tailwind class editor. Per the integration design
 * (docs/tailscan-integration-design.md):
 *   §2  Isolation: one `#pi-tailedit-root` host on <body> with an open shadow
 *       root holding the ENTIRE editor surface (panel + highlight + dropdown).
 *       The host is pointer-events:none so `elementFromPoint` reaches the page;
 *       the panel layer is pointer-events:auto. All CSS lives inside the shadow.
 *   §3  Etch contract (single-mutation rule): to apply a class the editor calls
 *       exactly one `classList.add/remove` on the REAL host element. Its own DOM
 *       churn is inside the shadow root (invisible to Etch's documentElement
 *       observer, which does not descend into shadow trees) and the host node is
 *       `pi-`-prefixed (pre-excluded by isPiElement). No private marker attribute
 *       is written to the target. → exactly one Etch class mutation per element.
 *   §4  Autocomplete via ns.createSuggestionIndex (lazy, budget-guarded).
 *   §6  Space pins the hovered element; keydown is SCOPED so Space/Escape behave
 *       as text editing while the shadow input has focus.
 *
 * Loaded raw (no bundler). Exposes ns.createTailedit on window.__piTailedit; all
 * state is private to the factory closure (no other globals leak).
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});
  const HOST_ID = "pi-tailedit-root"; // pi-prefixed → Etch's isPiElement ignores it

  const SHADOW_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    .te-highlight {
      position: fixed;
      pointer-events: none;
      z-index: 1;
      background: rgba(138, 190, 183, 0.15);
      border: 2px solid #8abeb7;
      border-radius: 3px;
      display: none;
    }
    .te-highlight.pinned { border-color: #f0c674; background: rgba(240, 198, 116, 0.12); }
    .te-panel {
      position: fixed;
      /* Also declared here, not only on :host — the host node is a div, so a
         page rule setting font-family on div with !important outranks the
         :host declaration and would otherwise inherit into the panel. */
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      width: 320px;
      max-height: 70vh;
      overflow: auto;
      pointer-events: auto;
      background: #1e1e24;
      color: #e0e0e0;
      border: 1px solid #505050;
      border-radius: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
      font-size: 12px;
      z-index: 2;
      display: none;
    }
    .te-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid #333;
      cursor: move;
      user-select: none;
    }
    .te-title { font-weight: 600; color: #8abeb7; }
    .te-close {
      background: none; border: none; color: #808080; cursor: pointer;
      font-size: 16px; line-height: 1; padding: 0 4px;
    }
    .te-close:hover { color: #e0e0e0; }
    .te-body { padding: 10px; }
    .te-tabs { display: flex; gap: 4px; margin-bottom: 8px; border-bottom: 1px solid #333; }
    .te-tab {
      flex: 1; background: none; color: #808080; border: none; border-bottom: 2px solid transparent;
      padding: 5px 6px; font-size: 11px; cursor: pointer;
    }
    .te-tab:hover { color: #e0e0e0; }
    .te-tab.active { color: #8abeb7; border-bottom-color: #8abeb7; }
    .te-pane[hidden] { display: none; }
    .te-controls-placeholder { padding: 20px 8px; color: #666; font-size: 11px; text-align: center; }
    .te-etch {
      font-size: 11px; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .te-etch.off { background: rgba(204, 102, 102, 0.15); color: #e6a3a3; }
    .te-etch.on { background: rgba(181, 189, 104, 0.15); color: #b5bd68; }
    .te-etch button {
      margin-left: auto; background: #b5bd68; color: #18181e; border: none;
      border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer;
    }
    .te-target {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      color: #8abeb7; font-size: 11px; margin-bottom: 8px; word-break: break-all;
    }
    .te-target .muted { color: #666; }
    .te-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .te-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: #2b2b37; border: 1px solid #3f3f46; border-radius: 3px;
      padding: 2px 4px 2px 6px; font-family: ui-monospace, Menlo, monospace;
      font-size: 11px; color: #e0e0e0;
    }
    .te-chip .sw { width: 10px; height: 10px; border-radius: 2px; border: 1px solid #0004; }
    .te-chip button {
      background: none; border: none; color: #999; cursor: pointer;
      font-size: 12px; line-height: 1; padding: 0 2px;
    }
    .te-chip button:hover { color: #cc6666; }
    .te-chip .tog { color: #8abeb7; }
    .te-chip .tog:hover { color: #b5d9d3; }
    .te-chip.off { opacity: 0.45; }
    .te-chip.off .lbl { text-decoration: line-through; }
    .te-chips.readonly .te-chip { opacity: 0.85; }
    .te-empty { color: #666; font-style: italic; }
    .te-nav { display: flex; gap: 4px; margin-bottom: 8px; }
    .te-nav button {
      flex: 1; background: #2b2b37; color: #e0e0e0; border: 1px solid #3f3f46;
      border-radius: 3px; padding: 3px 0; font-size: 11px; cursor: pointer;
    }
    .te-nav button:hover:not(:disabled) { background: #3a3a4a; }
    .te-nav button:disabled { opacity: 0.35; cursor: default; }
    .te-vars { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; }
    .te-var {
      background: #2b2b37; color: #b0b0b0; border: 1px solid #3f3f46;
      border-radius: 3px; padding: 2px 6px; font-size: 10px; cursor: pointer;
      font-family: ui-monospace, Menlo, monospace;
    }
    .te-var:hover { background: #3a3a4a; color: #e0e0e0; }
    .te-var.active { border-color: #8abeb7; color: #8abeb7; }
    .te-bp-bar {
      border-top: 1px solid #333; padding: 5px 10px; font-size: 10px;
      color: #808080; font-family: ui-monospace, Menlo, monospace;
      display: flex; justify-content: space-between;
    }
    .te-bp-bar .bp { color: #8abeb7; font-weight: 600; }
    .te-input-wrap { position: relative; }
    .te-input {
      width: 100%; background: #18181e; color: #e0e0e0;
      border: 1px solid #505050; border-radius: 4px; padding: 6px 8px;
      font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    }
    .te-input:focus { outline: none; border-color: #5f87ff; }
    .te-drop {
      position: absolute; left: 0; right: 0; bottom: 100%; margin-bottom: 4px;
      max-height: 220px; overflow: auto; background: #252530;
      border: 1px solid #505050; border-radius: 4px; display: none; z-index: 3;
    }
    .te-opt {
      display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px;
      cursor: pointer; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    }
    .te-opt:hover, .te-opt.active { background: #3a3a4a; }
    .te-opt .sw { width: 12px; height: 12px; border-radius: 2px; border: 1px solid #0006; flex: none; }
    .te-opt .opt-body { min-width: 0; flex: 1; }
    .te-opt .opt-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .te-opt .te-css {
      display: block; overflow: hidden; color: #858595; font-size: 10px; line-height: 1.3;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .te-opt .te-css .default { color: #666; }
    .te-opt .src { margin-left: auto; color: #666; font-size: 10px; }
    .te-actions { margin-top: 8px; display: flex; gap: 6px; }
    .te-btn {
      background: #2b2b37; color: #e0e0e0; border: 1px solid #3f3f46;
      border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer;
    }
    .te-btn:hover { background: #3a3a4a; }
    .te-hint { margin-top: 8px; color: #666; font-size: 10px; }
  `;

  function createTailedit(deps) {
    deps = deps || {};
    const getEtchState = deps.getEtchState || (() => ({ recording: false }));
    const startEtchCapture = deps.startEtchCapture || (() => {});
    const isPiElement = deps.isPiElement || (() => false);
    const suggest = ns.createSuggestionIndex ? ns.createSuggestionIndex() : null;

    let hostEl = null;
    let shadow = null;
    let enabled = false;
    let hoverEl = null;
    let pinnedEl = null;
    let activeOpt = -1;
    let activeTab = "classes";
    let els = {}; // shadow-root element refs
    // Last element the hover renderer drew, so mousemove only re-renders when
    // the target actually changes (§ no-freeze contract: nothing per-move).
    let renderedHoverEl = null;
    // A manual drag pins the window in place until the next pin().
    let userMoved = false;
    let dragFrom = null;
    // Classes switched off but remembered, per element. The page only ever
    // sees one classList mutation per toggle; the memory lives here.
    const disabledClasses = new WeakMap();

    // Default Tailwind breakpoint scale (Phase E replaces this with the
    // project's own config; keep it in exactly one place).
    const BREAKPOINTS = [
      ["2xl", 1536],
      ["xl", 1280],
      ["lg", 1024],
      ["md", 768],
      ["sm", 640],
    ];
    const VARIANTS = ["sm", "md", "lg", "xl", "2xl", "hover", "focus", "dark"];

    function classAttr(el) {
      return (el && el.getAttribute && el.getAttribute("class")) || "";
    }
    function classListOf(el) {
      return classAttr(el).split(/\s+/).filter(Boolean);
    }

    function mount() {
      if (hostEl) return;
      hostEl = document.createElement("div");
      hostEl.id = HOST_ID;
      shadow = hostEl.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SHADOW_CSS;
      shadow.appendChild(style);

      const highlight = document.createElement("div");
      highlight.className = "te-highlight";

      const panel = document.createElement("div");
      panel.className = "te-panel";
      panel.innerHTML = `
        <div class="te-head">
          <span class="te-title">π Tailwind edit</span>
          <button class="te-close" title="Stop editing">×</button>
        </div>
        <div class="te-body">
          <div class="te-etch off"></div>
          <div class="te-tabs" role="tablist">
            <button class="te-tab active" data-tab="classes" role="tab">Classes</button>
            <button class="te-tab" data-tab="controls" role="tab">Controls</button>
          </div>
          <div class="te-pane" data-pane="classes">
            <div class="te-target"><span class="muted">Hover an element, click or press Space to pin</span></div>
            <div class="te-nav">
              <button class="te-up" title="parent element">▲ parent</button>
              <button class="te-down" title="first child element">▼ child</button>
              <button class="te-prev" title="previous sibling">◀ prev</button>
              <button class="te-next" title="next sibling">▶ next</button>
            </div>
            <div class="te-chips"></div>
            <div class="te-vars"></div>
            <div class="te-input-wrap">
              <input class="te-input" type="text" placeholder="add class — e.g. bg-blue-500 or w-[37px]" spellcheck="false" />
              <div class="te-drop"></div>
            </div>
            <div class="te-actions">
              <button class="te-btn te-copy">Copy classlist</button>
            </div>
            <div class="te-hint">Click or Space pins the hovered element · edits mutate the real class attribute (captured by Etch) · off classes are real removals until re-enabled · arbitrary values: any utility + -[value]</div>
          </div>
          <div class="te-pane" data-pane="controls" hidden>
            <div class="te-controls-placeholder">Visual controls land in Phase C2</div>
          </div>
        </div>
        <div class="te-bp-bar"><span class="bp">base</span><span class="w"></span></div>
      `;

      shadow.appendChild(highlight);
      shadow.appendChild(panel);

      els = {
        highlight,
        panel,
        etch: panel.querySelector(".te-etch"),
        tabs: panel.querySelectorAll(".te-tab"),
        panes: panel.querySelectorAll(".te-pane"),
        target: panel.querySelector(".te-target"),
        chips: panel.querySelector(".te-chips"),
        input: panel.querySelector(".te-input"),
        drop: panel.querySelector(".te-drop"),
        copy: panel.querySelector(".te-copy"),
        close: panel.querySelector(".te-close"),
        head: panel.querySelector(".te-head"),
        nav: {
          up: panel.querySelector(".te-up"),
          down: panel.querySelector(".te-down"),
          prev: panel.querySelector(".te-prev"),
          next: panel.querySelector(".te-next"),
        },
        vars: panel.querySelector(".te-vars"),
        bp: panel.querySelector(".te-bp-bar .bp"),
        bpWidth: panel.querySelector(".te-bp-bar .w"),
      };

      els.close.addEventListener("click", () => disable());
      els.copy.addEventListener("click", copyClasslist);
      els.head.addEventListener("mousedown", onDragStart);
      els.nav.up.addEventListener("click", () => navigate("up"));
      els.nav.down.addEventListener("click", () => navigate("down"));
      els.nav.prev.addEventListener("click", () => navigate("prev"));
      els.nav.next.addEventListener("click", () => navigate("next"));
      renderVariantRow();
      els.input.addEventListener("input", onInput);
      els.input.addEventListener("keydown", onInputKey);
      els.input.addEventListener("blur", () => setTimeout(hideDrop, 120));
      els.tabs.forEach((tab) => tab.addEventListener("click", () => setActiveTab(tab.dataset.tab)));
      // Keep the panel's own events from leaking to the host page. This MUST
      // be the bubble phase: a capture-phase stopPropagation() here runs
      // before the event reaches the button inside the panel, which silently
      // kills every click control in the editor (close, copy, chip ×, nav,
      // toggles). Bubbling lets the control handle the event first, then
      // stops it here on the way out.
      panel.addEventListener("click", (e) => e.stopPropagation());
      panel.addEventListener("mousemove", (e) => e.stopPropagation());

      document.body.appendChild(hostEl);
    }

    // ── enable / disable ────────────────────────────────────────────────
    function enable() {
      mount();
      if (suggest) suggest.ensureBuilt();
      enabled = true;
      els.panel.style.display = "block";
      refreshEtchBanner();
      refreshBreakpoint();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("click", onPageClick, true);
      window.addEventListener("scroll", updateBoxes, true);
      window.addEventListener("resize", updateBoxes);
    }

    function disable() {
      enabled = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onPageClick, true);
      window.removeEventListener("scroll", updateBoxes, true);
      window.removeEventListener("resize", updateBoxes);
      endDrag(); // drops the transient drag listeners if a drag was in flight
      hoverEl = null;
      pinnedEl = null;
      renderedHoverEl = null;
      userMoved = false;
      if (els.highlight) els.highlight.style.display = "none";
      if (els.panel) els.panel.style.display = "none";
      hideDrop();
      setActiveTab("classes");
    }

    function setActiveTab(tab) {
      activeTab = tab === "controls" ? "controls" : "classes";
      if (!els.tabs || !els.panes) return;
      els.tabs.forEach((button) => button.classList.toggle("active", button.dataset.tab === activeTab));
      els.panes.forEach((pane) => {
        pane.hidden = pane.dataset.pane !== activeTab;
      });
    }

    function destroy() {
      disable();
      hostEl?.remove();
      hostEl = null;
      shadow = null;
      els = {};
    }

    // ── hover / highlight ───────────────────────────────────────────────
    /** Elements the editor must never inspect, navigate to, or pin. */
    function eligible(el) {
      return !!el && el !== hostEl && !isPiElement(el) &&
        el !== document.body && el !== document.documentElement;
    }

    function onMove(e) {
      if (!enabled) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!eligible(el)) {
        hoverEl = null;
        if (!pinnedEl) els.highlight.style.display = "none";
        return;
      }
      hoverEl = el;
      if (pinnedEl) return;
      drawHighlight(el, false);
      // Re-render only on a real target change — never per mousemove.
      if (el !== renderedHoverEl) {
        renderedHoverEl = el;
        renderTarget(el);
        renderChips(el, true);
      }
    }

    /** Click pins, the same as Space, without reaching the page. */
    function onPageClick(e) {
      if (!enabled) return;
      const target = e.target;
      if (target === hostEl || (hostEl && hostEl.contains(target))) return;
      if (!eligible(hoverEl)) return;
      e.preventDefault();
      e.stopPropagation();
      pin(hoverEl);
    }

    function drawHighlight(el, pinned) {
      if (!el || !els.highlight) return;
      const r = el.getBoundingClientRect();
      const s = els.highlight.style;
      s.display = "block";
      s.left = r.left + "px";
      s.top = r.top + "px";
      s.width = r.width + "px";
      s.height = r.height + "px";
      els.highlight.classList.toggle("pinned", !!pinned);
    }

    function updateBoxes() {
      if (!enabled) return;
      if (pinnedEl && document.contains(pinnedEl)) {
        drawHighlight(pinnedEl, true);
        positionPanel(pinnedEl);
        renderTarget(pinnedEl);
      } else if (hoverEl && document.contains(hoverEl)) {
        drawHighlight(hoverEl, false);
      }
      refreshBreakpoint();
    }

    // ── floating window placement ───────────────────────────────────────
    /**
     * Park the panel beside the anchor: right, else left, else below, else
     * above, always fully inside the viewport. One rect read, one style
     * write — no layout thrash, nothing per-mousemove.
     */
    function positionPanel(anchorEl) {
      if (!els.panel || !anchorEl || userMoved) return;
      const gap = 12;
      const margin = 8;
      const r = anchorEl.getBoundingClientRect();
      const pw = els.panel.offsetWidth || 320;
      const ph = els.panel.offsetHeight || 240;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left;
      let top = r.top;
      if (r.right + gap + pw + margin <= vw) left = r.right + gap;
      else if (r.left - gap - pw >= margin) left = r.left - gap - pw;
      else {
        left = r.left;
        top = r.bottom + gap + ph + margin <= vh ? r.bottom + gap : r.top - gap - ph;
      }
      els.panel.style.left = clamp(left, margin, Math.max(margin, vw - pw - margin)) + "px";
      els.panel.style.top = clamp(top, margin, Math.max(margin, vh - ph - margin)) + "px";
    }

    function clamp(value, low, high) {
      return value < low ? low : value > high ? high : value;
    }

    function onDragStart(e) {
      if (e.target && e.target.classList && e.target.classList.contains("te-close")) return;
      const r = els.panel.getBoundingClientRect();
      dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      userMoved = true;
      e.preventDefault();
      document.addEventListener("mousemove", onDragMove, true);
      document.addEventListener("mouseup", endDrag, true);
    }

    function onDragMove(e) {
      if (!dragFrom) return;
      const pw = els.panel.offsetWidth || 320;
      const ph = els.panel.offsetHeight || 240;
      els.panel.style.left =
        clamp(dragFrom.left + (e.clientX - dragFrom.x), 0, Math.max(0, window.innerWidth - pw)) + "px";
      els.panel.style.top =
        clamp(dragFrom.top + (e.clientY - dragFrom.y), 0, Math.max(0, window.innerHeight - ph)) + "px";
    }

    function endDrag() {
      dragFrom = null;
      document.removeEventListener("mousemove", onDragMove, true);
      document.removeEventListener("mouseup", endDrag, true);
    }

    // ── breakpoint bar ──────────────────────────────────────────────────
    function currentBreakpoint(width) {
      for (const [name, min] of BREAKPOINTS) if (width >= min) return name;
      return "base";
    }

    function refreshBreakpoint() {
      if (!els.bp) return;
      const width = window.innerWidth;
      const name = currentBreakpoint(width);
      els.bp.textContent = name;
      els.bpWidth.textContent = Math.round(width) + "px";
      if (!els.vars) return;
      for (const btn of els.vars.querySelectorAll(".te-var")) {
        btn.classList.toggle("active", btn.dataset.variant === name);
      }
    }

    // ── variant quick-prefixes ──────────────────────────────────────────
    function renderVariantRow() {
      if (!els.vars) return;
      els.vars.textContent = "";
      for (const variant of VARIANTS) {
        const btn = document.createElement("button");
        btn.className = "te-var";
        btn.dataset.variant = variant;
        btn.textContent = variant;
        // mousedown, not click: the input must not blur first.
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          applyVariantPrefix(variant);
        });
        els.vars.appendChild(btn);
      }
    }

    /** Extend the input's variant chain; suggest.js re-attaches it to hits. */
    function applyVariantPrefix(variant) {
      const value = els.input.value;
      const prefix = variant + ":";
      if (!value.includes(prefix)) {
        const split = value.lastIndexOf(":");
        const chain = split >= 0 ? value.slice(0, split + 1) : "";
        const stub = split >= 0 ? value.slice(split + 1) : value;
        els.input.value = chain + prefix + stub;
      }
      els.input.focus();
      onInput();
    }

    // ── keydown (scoped) ────────────────────────────────────────────────
    function focusInsideEditor() {
      // When focus is inside our shadow root, document.activeElement is the host.
      return document.activeElement === hostEl;
    }

    function onKey(e) {
      if (!enabled) return;
      if (focusInsideEditor()) return; // typing in the panel → normal text editing
      if (e.code === "Space" || e.key === " ") {
        if (!hoverEl) return;
        e.preventDefault();
        e.stopPropagation();
        pin(hoverEl);
      }
    }

    // ── pin / render ────────────────────────────────────────────────────
    function pin(el) {
      pinnedEl = el;
      userMoved = false; // a fresh pin re-anchors the window
      drawHighlight(el, true);
      positionPanel(el);
      renderTarget(el);
      renderChips(el, false);
      refreshNav();
      refreshEtchBanner();
      els.input.value = "";
      hideDrop();
      els.input.focus();
    }

    function renderTarget(el) {
      if (!el) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : "?";
      const id = el.id ? `#${el.id}` : "";
      const r = el.getBoundingClientRect();
      const count = classListOf(el).length;
      els.target.textContent = "";
      const head = document.createElement("span");
      head.textContent = `${tag}${id}`;
      els.target.appendChild(head);
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = ` — ${count} class${count === 1 ? "" : "es"} · ${Math.round(r.width)} × ${Math.round(r.height)}px`;
      els.target.appendChild(meta);
    }

    /**
     * One renderer for both modes. Read-only (hover) shows the live classes
     * with no controls; pinned mode adds the toggle and remove buttons and
     * folds in the element's remembered off-classes.
     */
    function renderChips(el, readOnly) {
      const chips = els.chips;
      chips.textContent = "";
      chips.classList.toggle("readonly", !!readOnly);
      if (!el) return;
      const live = classListOf(el);
      const off = readOnly ? new Set() : disabledClasses.get(el) || new Set();
      const list = live.concat([...off].filter((cls) => !live.includes(cls)));
      if (!list.length) {
        const empty = document.createElement("span");
        empty.className = "te-empty";
        empty.textContent = "no classes";
        chips.appendChild(empty);
        return;
      }
      for (const cls of list) {
        const isOff = off.has(cls);
        const chip = document.createElement("span");
        chip.className = isOff ? "te-chip off" : "te-chip";
        if (!readOnly) {
          const tog = document.createElement("button");
          tog.className = "tog";
          tog.textContent = isOff ? "○" : "◉";
          tog.title = isOff ? "enable class" : "disable class (kept in the list)";
          tog.addEventListener("click", () => toggleClass(cls));
          chip.appendChild(tog);
        }
        const hex = swatchFor(cls);
        if (hex) {
          const sw = document.createElement("span");
          sw.className = "sw";
          sw.style.background = hex;
          chip.appendChild(sw);
        }
        const label = document.createElement("span");
        label.className = "lbl";
        label.textContent = cls;
        chip.appendChild(label);
        const explanation = suggest && suggest.explain ? suggest.explain(cls) : "";
        if (explanation) chip.title = explanation.css;
        if (!readOnly) {
          const rm = document.createElement("button");
          rm.textContent = "×";
          rm.title = "remove class";
          rm.addEventListener("click", () => applyRemove(cls));
          chip.appendChild(rm);
        }
        chips.appendChild(chip);
      }
    }

    // ── navigator ───────────────────────────────────────────────────────
    /** Nearest eligible element in a direction, skipping pi-annotate nodes. */
    function neighbour(el, direction) {
      if (!el) return null;
      if (direction === "up") {
        let node = el.parentElement;
        while (node && !eligible(node)) node = node.parentElement;
        return node;
      }
      if (direction === "down") {
        let node = el.firstElementChild;
        while (node && !eligible(node)) node = node.nextElementSibling;
        return node;
      }
      const step = direction === "next" ? "nextElementSibling" : "previousElementSibling";
      let node = el[step];
      while (node && !eligible(node)) node = node[step];
      return node;
    }

    function navigate(direction) {
      const next = neighbour(pinnedEl, direction);
      if (next) pin(next);
    }

    function refreshNav() {
      if (!els.nav) return;
      els.nav.up.disabled = !neighbour(pinnedEl, "up");
      els.nav.down.disabled = !neighbour(pinnedEl, "down");
      els.nav.prev.disabled = !neighbour(pinnedEl, "prev");
      els.nav.next.disabled = !neighbour(pinnedEl, "next");
    }

    // Swatch from the bundled palette (via a throwaway suggestion query preview).
    function swatchFor(cls) {
      if (!suggest) return null;
      const hits = suggest.query(cls);
      for (const h of hits) {
        if (h.className === cls && h.preview && h.preview.kind === "color") {
          return h.preview.value;
        }
      }
      return null;
    }

    // ── apply (single-mutation rule) ────────────────────────────────────
    function applyAdd(cls) {
      if (!pinnedEl || !cls) return;
      pinnedEl.classList.add(cls); // exactly one class-attribute mutation → one Etch entry
      const off = disabledClasses.get(pinnedEl);
      if (off) off.delete(cls); // re-adding by hand clears the remembered off state
      renderChips(pinnedEl, false);
      renderTarget(pinnedEl);
      refreshEtchBanner();
    }

    function applyRemove(cls) {
      if (!pinnedEl || !cls) return;
      pinnedEl.classList.remove(cls); // one class-attribute mutation
      const off = disabledClasses.get(pinnedEl);
      if (off) off.delete(cls); // × drops it from the union list too
      renderChips(pinnedEl, false);
      renderTarget(pinnedEl);
    }

    /**
     * Switch a class off without losing it. Still exactly one classList
     * mutation per action — the "remembered" half lives only in editor memory,
     * so Etch sees a plain remove (and a plain add when switched back on).
     */
    function toggleClass(cls) {
      if (!pinnedEl || !cls) return;
      let off = disabledClasses.get(pinnedEl);
      if (!off) {
        off = new Set();
        disabledClasses.set(pinnedEl, off);
      }
      if (off.has(cls)) {
        pinnedEl.classList.add(cls); // one class-attribute mutation
        off.delete(cls);
      } else {
        pinnedEl.classList.remove(cls); // one class-attribute mutation
        off.add(cls);
      }
      renderChips(pinnedEl, false);
      renderTarget(pinnedEl);
      refreshEtchBanner();
    }

    // ── autocomplete ────────────────────────────────────────────────────
    function onInput() {
      const token = els.input.value.trim();
      if (!token || !suggest) return hideDrop();
      const hits = suggest.query(token);
      renderDrop(hits);
    }

    function renderDrop(hits) {
      const drop = els.drop;
      drop.textContent = "";
      activeOpt = -1;
      if (!hits.length) return hideDrop();
      hits.forEach((h, i) => {
        const opt = document.createElement("div");
        opt.className = "te-opt";
        opt.dataset.index = String(i);
        opt.dataset.cls = h.className;
        if (h.template) opt.dataset.template = "true";
        if (h.preview && h.preview.kind === "color") {
          const sw = document.createElement("span");
          sw.className = "sw";
          sw.style.background = h.preview.value;
          opt.appendChild(sw);
        }
        const body = document.createElement("span");
        body.className = "opt-body";
        const name = document.createElement("span");
        name.className = "opt-name";
        name.textContent = h.className;
        body.appendChild(name);
        const explanation = suggest && suggest.explain ? suggest.explain(h.className) : "";
        if (explanation) {
          const css = document.createElement("span");
          css.className = "te-css";
          if (explanation.source === "default") {
            const marker = document.createElement("span");
            marker.className = "default";
            marker.textContent = "default · ";
            css.appendChild(marker);
          }
          css.appendChild(document.createTextNode(explanation.css));
          body.appendChild(css);
        }
        opt.appendChild(body);
        const src = document.createElement("span");
        src.className = "src";
        src.textContent = h.source;
        opt.appendChild(src);
        // mousedown (not click) so the input keeps focus and blur doesn't fire first
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          chooseSuggestion(h.className, h.template === true);
        });
        drop.appendChild(opt);
      });
      drop.style.display = "block";
    }

    function hideDrop() {
      if (els.drop) els.drop.style.display = "none";
      activeOpt = -1;
    }

    function chooseSuggestion(cls, template = false) {
      if (template) {
        const token = cls.replace(/[…]$/, "");
        els.input.value = token + "[]";
        const caret = els.input.value.length - 1;
        els.input.setSelectionRange(caret, caret);
        els.input.focus();
        onInput();
        return;
      }
      applyAdd(cls);
      els.input.value = "";
      hideDrop();
      els.input.focus();
    }

    function onInputKey(e) {
      const opts = els.drop.querySelectorAll(".te-opt");
      if (e.key === "Enter") {
        e.preventDefault();
        if (activeOpt >= 0 && opts[activeOpt]) {
          chooseSuggestion(opts[activeOpt].dataset.cls, opts[activeOpt].dataset.template === "true");
        } else {
          const token = els.input.value.trim();
          if (token) chooseSuggestion(token); // apply typed token verbatim
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (opts.length) setActiveOpt(Math.min(activeOpt + 1, opts.length - 1), opts);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (opts.length) setActiveOpt(Math.max(activeOpt - 1, 0), opts);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // keep Escape from bubbling to pi-annotate's cancel
        hideDrop();
      }
    }

    function setActiveOpt(i, opts) {
      opts.forEach((o) => o.classList.remove("active"));
      activeOpt = i;
      if (opts[i]) opts[i].classList.add("active");
    }

    // ── Etch banner ─────────────────────────────────────────────────────
    function refreshEtchBanner() {
      if (!els.etch) return;
      const recording = !!getEtchState().recording;
      els.etch.classList.toggle("on", recording);
      els.etch.classList.toggle("off", !recording);
      els.etch.textContent = "";
      const label = document.createElement("span");
      if (recording) {
        label.textContent = "Etch on — changes are being captured";
        els.etch.appendChild(label);
      } else {
        label.textContent = "Etch off — changes not being captured";
        els.etch.appendChild(label);
        const btn = document.createElement("button");
        btn.textContent = "Start capture";
        btn.addEventListener("click", () => {
          startEtchCapture();
          refreshEtchBanner();
        });
        els.etch.appendChild(btn);
      }
    }

    // ── copy ────────────────────────────────────────────────────────────
    function copyClasslist() {
      if (!pinnedEl) return;
      const text = classAttr(pinnedEl);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    }

    return { enable, disable, destroy, isActive: () => enabled };
  }

  ns.createTailedit = createTailedit;
})();
