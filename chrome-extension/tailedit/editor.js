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
      right: 16px;
      bottom: 16px;
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
    }
    .te-title { font-weight: 600; color: #8abeb7; }
    .te-close {
      background: none; border: none; color: #808080; cursor: pointer;
      font-size: 16px; line-height: 1; padding: 0 4px;
    }
    .te-close:hover { color: #e0e0e0; }
    .te-body { padding: 10px; }
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
    .te-empty { color: #666; font-style: italic; }
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
      display: flex; align-items: center; gap: 8px; padding: 5px 8px;
      cursor: pointer; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    }
    .te-opt:hover, .te-opt.active { background: #3a3a4a; }
    .te-opt .sw { width: 12px; height: 12px; border-radius: 2px; border: 1px solid #0006; flex: none; }
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
    let els = {}; // shadow-root element refs

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
          <div class="te-target"><span class="muted">Hover an element, press Space to pin</span></div>
          <div class="te-chips"></div>
          <div class="te-input-wrap">
            <input class="te-input" type="text" placeholder="add class (e.g. bg-blue-500) — Enter to apply" spellcheck="false" />
            <div class="te-drop"></div>
          </div>
          <div class="te-actions">
            <button class="te-btn te-copy">Copy classlist</button>
          </div>
          <div class="te-hint">Space pins the hovered element · edits mutate the real class attribute (captured by Etch)</div>
        </div>
      `;

      shadow.appendChild(highlight);
      shadow.appendChild(panel);

      els = {
        highlight,
        panel,
        etch: panel.querySelector(".te-etch"),
        target: panel.querySelector(".te-target"),
        chips: panel.querySelector(".te-chips"),
        input: panel.querySelector(".te-input"),
        drop: panel.querySelector(".te-drop"),
        copy: panel.querySelector(".te-copy"),
        close: panel.querySelector(".te-close"),
      };

      els.close.addEventListener("click", () => disable());
      els.copy.addEventListener("click", copyClasslist);
      els.input.addEventListener("input", onInput);
      els.input.addEventListener("keydown", onInputKey);
      els.input.addEventListener("blur", () => setTimeout(hideDrop, 120));
      // Keep the panel's own clicks from leaking to the host page.
      panel.addEventListener("click", (e) => e.stopPropagation(), true);
      panel.addEventListener("mousemove", (e) => e.stopPropagation(), true);

      document.body.appendChild(hostEl);
    }

    // ── enable / disable ────────────────────────────────────────────────
    function enable() {
      mount();
      if (suggest) suggest.ensureBuilt();
      enabled = true;
      els.panel.style.display = "block";
      refreshEtchBanner();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", updateBoxes, true);
      window.addEventListener("resize", updateBoxes);
    }

    function disable() {
      enabled = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", updateBoxes, true);
      window.removeEventListener("resize", updateBoxes);
      hoverEl = null;
      pinnedEl = null;
      if (els.highlight) els.highlight.style.display = "none";
      if (els.panel) els.panel.style.display = "none";
      hideDrop();
    }

    function destroy() {
      disable();
      hostEl?.remove();
      hostEl = null;
      shadow = null;
      els = {};
    }

    // ── hover / highlight ───────────────────────────────────────────────
    function onMove(e) {
      if (!enabled) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (
        !el || el === hostEl || isPiElement(el) ||
        el === document.body || el === document.documentElement
      ) {
        hoverEl = null;
        if (!pinnedEl) els.highlight.style.display = "none";
        return;
      }
      hoverEl = el;
      if (!pinnedEl) drawHighlight(el, false);
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
      if (pinnedEl && document.contains(pinnedEl)) drawHighlight(pinnedEl, true);
      else if (hoverEl && document.contains(hoverEl)) drawHighlight(hoverEl, false);
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
      drawHighlight(el, true);
      renderTarget();
      renderChips();
      refreshEtchBanner();
      els.input.value = "";
      hideDrop();
      els.input.focus();
    }

    function renderTarget() {
      if (!pinnedEl) return;
      const tag = pinnedEl.tagName ? pinnedEl.tagName.toLowerCase() : "?";
      const id = pinnedEl.id ? `#${pinnedEl.id}` : "";
      els.target.textContent = `${tag}${id}`;
    }

    function renderChips() {
      const chips = els.chips;
      chips.textContent = "";
      if (!pinnedEl) return;
      const list = classListOf(pinnedEl);
      if (!list.length) {
        const empty = document.createElement("span");
        empty.className = "te-empty";
        empty.textContent = "no classes";
        chips.appendChild(empty);
        return;
      }
      for (const cls of list) {
        const chip = document.createElement("span");
        chip.className = "te-chip";
        const hex = swatchFor(cls);
        if (hex) {
          const sw = document.createElement("span");
          sw.className = "sw";
          sw.style.background = hex;
          chip.appendChild(sw);
        }
        const label = document.createElement("span");
        label.textContent = cls;
        chip.appendChild(label);
        const rm = document.createElement("button");
        rm.textContent = "×";
        rm.title = "remove class";
        rm.addEventListener("click", () => applyRemove(cls));
        chip.appendChild(rm);
        chips.appendChild(chip);
      }
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
      renderChips();
      refreshEtchBanner();
    }

    function applyRemove(cls) {
      if (!pinnedEl || !cls) return;
      pinnedEl.classList.remove(cls); // one class-attribute mutation
      renderChips();
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
        if (h.preview && h.preview.kind === "color") {
          const sw = document.createElement("span");
          sw.className = "sw";
          sw.style.background = h.preview.value;
          opt.appendChild(sw);
        }
        const name = document.createElement("span");
        name.textContent = h.className;
        opt.appendChild(name);
        const src = document.createElement("span");
        src.className = "src";
        src.textContent = h.source;
        opt.appendChild(src);
        // mousedown (not click) so the input keeps focus and blur doesn't fire first
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          chooseSuggestion(h.className);
        });
        drop.appendChild(opt);
      });
      drop.style.display = "block";
    }

    function hideDrop() {
      if (els.drop) els.drop.style.display = "none";
      activeOpt = -1;
    }

    function chooseSuggestion(cls) {
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
          chooseSuggestion(opts[activeOpt].querySelector("span").textContent);
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
