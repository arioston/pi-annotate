/**
 * Pi Annotate — Tailedit suggestion index (Phase A, plan 283)
 *
 * Lazy, budget-guarded Tailwind class suggestion source. Hybrid per design §4/D5:
 *   1. host-page CSSOM introspection (classes actually in use on the page), and
 *   2. a bundled open static default-theme list (tw-default-classes.js), plus
 *   3. an arbitrary-value passthrough parser (`prefix-[...]`).
 *
 * No-freeze contract (plans 280/285): the index is built on first editor open,
 * never at content-script load. The CSSOM pass is selector-text-only, does NOT
 * walk parent declaration text, is deferred to requestIdleCallback, and is
 * bounded by its own time/rule budget shared across all sheets (plan 419,
 * decoupled from content.js's Etch budget — a different, quadratic-cost
 * workload). On hitting the budget it stops the whole pass cleanly and
 * records truncation via index.stats() rather than silently degrading.
 *
 * Loaded raw (no bundler). Exposes ns.createSuggestionIndex on the single
 * window.__piTailedit namespace; all state is private to the factory closure.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  // Budget for the CSSOM class-token scan (plan 419). content.js's freeze
  // guard for Etch's per-rule parent.cssText walks is a different, quadratic
  // workload — this scan does one regex + Set.add per rule, so it can afford
  // a much larger ceiling. Time is the primary guard because rule *cost*
  // varies with selector complexity, not just count; the rule ceiling below
  // is a backstop for the pathological case. Calibrated against the plan-418
  // spike measurements: uncapped scans measured 7,973 rules / ~14-31ms on
  // tailwindcss.com (worst observed loss under the old 4000-per-sheet cap:
  // 28.7% of class tokens) and 23,326 rules / ~34-80ms across 51 sheets on
  // github.com. SCAN_TIME_BUDGET_MS is roughly double the slowest full scan
  // measured; MAX_TOTAL_RULES is comfortably above the largest rule count
  // measured.
  const SCAN_TIME_BUDGET_MS = 150; // wall-clock across the whole scanCssom() pass, not per sheet
  const MAX_TOTAL_RULES = 60000; // backstop across all sheets combined, not per sheet
  const DEADLINE_CHECK_INTERVAL = 500; // rules between performance.now() calls — checking every rule would itself cost time
  const MAX_SUGGESTIONS = 24;
  const MAX_DECLARATIONS = 6;
  const ARBITRARY_FAMILIES = new Set([
    "w", "h", "p", "m", "gap", "text", "bg", "border", "top", "left", "right", "bottom", "z", "rounded",
  ]);
  const DERIVED_PREFIXES = [
    "space-x", "space-y", "gap-x", "gap-y", "min-w", "max-w", "min-h", "max-h", "ring-offset",
    "background", "border", "rounded", "padding", "margin", "text", "font", "w", "h", "p", "m", "gap",
  ];
  const SPACING_SCALE = {
    "0": "0px", px: "1px", "0.5": "0.125rem", "1": "0.25rem", "1.5": "0.375rem", "2": "0.5rem",
    "2.5": "0.625rem", "3": "0.75rem", "3.5": "0.875rem", "4": "1rem", "5": "1.25rem",
    "6": "1.5rem", "7": "1.75rem", "8": "2rem", "9": "2.25rem", "10": "2.5rem", "11": "2.75rem",
    "12": "3rem", "14": "3.5rem", "16": "4rem", "20": "5rem", "24": "6rem", "28": "7rem",
    "32": "8rem", "36": "9rem", "40": "10rem", "44": "11rem", "48": "12rem", "52": "13rem",
    "56": "14rem", "60": "15rem", "64": "16rem", "72": "18rem", "80": "20rem", "96": "24rem",
  };
  const SIZING_KEYWORDS = { full: "100%", screen: "100vw", auto: "auto" };
  const SPACING_PROPERTIES = {
    p: "padding", px: "padding-inline", py: "padding-block", pt: "padding-top", pr: "padding-right",
    pb: "padding-bottom", pl: "padding-left", m: "margin", mx: "margin-inline", my: "margin-block",
    mt: "margin-top", mr: "margin-right", mb: "margin-bottom", ml: "margin-left", gap: "gap",
    "gap-x": "column-gap", "gap-y": "row-gap", "space-x": "margin-inline-start", "space-y": "margin-block-start",
  };
  const SIZING_PROPERTIES = {
    w: "width", h: "height", "min-w": "min-width", "max-w": "max-width", "min-h": "min-height", "max-h": "max-height",
  };
  const TEXT_SIZES = { xs: "0.75rem", sm: "0.875rem", base: "1rem", lg: "1.125rem", xl: "1.25rem", "2xl": "1.5rem", "3xl": "1.875rem", "4xl": "2.25rem", "5xl": "3rem", "6xl": "3.75rem", "7xl": "4.5rem", "8xl": "6rem", "9xl": "8rem" };
  const FONT_WEIGHTS = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
  const RADII = { none: "0px", sm: "0.125rem", "": "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", full: "9999px" };
  // class tokens inside a selector, e.g. `.md\:bg-blue-500:hover` → md:bg-blue-500
  const CLASS_TOKEN_RE = /\.((?:\\.|[-\w[\]#.%/])+)/g;

  function leadingKey(cls) {
    // token before the utility value, e.g. "bg" from "bg-blue-500", "p" from "p-4"
    const body = cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls;
    const dash = body.indexOf("-");
    return dash === -1 ? body : body.slice(0, dash);
  }

  function createSuggestionIndex() {
    const colors = ns.data?.colors || {};
    const colorPrefixes = new Set(ns.data?.colorPrefixes || []);
    let built = false;
    let scanned = false;
    let scanStats = { truncated: false, rulesScanned: 0, sheetsScanned: 0, sheetsSkipped: 0, elapsedMs: 0 };
    const byPrefix = new Map(); // leadingKey → ClassEntry[]
    const byClass = new Map(); // exact class name → ClassEntry
    const seen = new Set(); // dedupe className

    function addEntry(className, source, rule) {
      if (!className) return;
      if (seen.has(className)) {
        const existing = byClass.get(className);
        if (rule && existing && !existing.rule) existing.rule = rule;
        return;
      }
      seen.add(className);
      const entry = { className, source, preview: previewFor(className), rule };
      byClass.set(className, entry);
      const key = leadingKey(className);
      let list = byPrefix.get(key);
      if (!list) byPrefix.set(key, (list = []));
      list.push(entry);
    }

    // Resolve a color swatch from the bundled palette (no DOM probe → no Etch churn).
    function colorHex(className) {
      const body = className.includes(":")
        ? className.slice(className.lastIndexOf(":") + 1)
        : className;
      const dash = body.indexOf("-");
      if (dash === -1) return null;
      const prefix = body.slice(0, dash);
      if (!colorPrefixes.has(prefix)) return null;
      const family = body.slice(dash + 1); // e.g. "blue-500", "white"
      return colors[family] || null;
    }

    function declarationsOf(rule, max = MAX_DECLARATIONS) {
      const style = rule && rule.style;
      if (!style) return "";
      const parts = [];
      const limit = Math.min(style.length, max);
      for (let i = 0; i < limit; i++) {
        const prop = style[i];
        const value = style.getPropertyValue(prop).trim();
        if (prop && value) parts.push(`${prop}: ${value}`);
      }
      if (style.length > max) parts.push("…");
      return parts.join("; ");
    }

    function utilityBody(className) {
      const idx = className.lastIndexOf(":");
      return idx === -1 ? className : className.slice(idx + 1);
    }

    function splitDerivedUtility(className) {
      const body = utilityBody(className);
      for (const prefix of DERIVED_PREFIXES) {
        if (body === prefix) return [prefix, ""];
        if (body.startsWith(`${prefix}-`)) return [prefix, body.slice(prefix.length + 1)];
      }
      const dash = body.indexOf("-");
      return [dash === -1 ? body : body.slice(0, dash), dash === -1 ? "" : body.slice(dash + 1)];
    }

    function scaleValue(value) {
      return SPACING_SCALE[value] || null;
    }

    function derivedCss(className) {
      const [prefix, value] = splitDerivedUtility(className);
      const hex = colorHex(className);
      if (hex) {
        if (prefix === "bg") return `background-color: ${hex}`;
        if (prefix === "border") return `border-color: ${hex}`;
        if (prefix === "text") return `color: ${hex}`;
      }

      const spacing = scaleValue(value);
      if (spacing && SPACING_PROPERTIES[prefix]) return `${SPACING_PROPERTIES[prefix]}: ${spacing}`;

      if (SIZING_PROPERTIES[prefix]) {
        const sizing = SIZING_KEYWORDS[value] || spacing;
        if (sizing) return `${SIZING_PROPERTIES[prefix]}: ${sizing}`;
      }

      if (prefix === "text" && TEXT_SIZES[value]) return `font-size: ${TEXT_SIZES[value]}`;
      if (prefix === "font" && FONT_WEIGHTS[value]) return `font-weight: ${FONT_WEIGHTS[value]}`;
      if (prefix === "rounded" && Object.prototype.hasOwnProperty.call(RADII, value)) return `border-radius: ${RADII[value]}`;
      return "";
    }

    // explain stays lazy: only render paths ask for resolved CSS.
    function explain(className) {
      const base = utilityBody(className);
      const entry = byClass.get(base) || byClass.get(className);
      if (entry && entry.rule) {
        const css = declarationsOf(entry.rule);
        if (css) return { css, source: "page" };
      }
      const css = derivedCss(className);
      return css ? { css, source: "default" } : "";
    }

    function previewFor(className) {
      // arbitrary value: prefix-[...]
      const arb = /-\[([^\]]+)\]$/.exec(className);
      if (arb) {
        const v = arb[1];
        if (/^#([0-9a-f]{3,8})$/i.test(v) || /^(rgb|hsl)a?\(/i.test(v)) {
          return { kind: "color", value: v };
        }
        if (/^-?[\d.]+(px|rem|em|%|vh|vw|ch)$/i.test(v)) {
          return { kind: "length", value: v };
        }
        return { kind: "none" };
      }
      const hex = colorHex(className);
      if (hex) return { kind: "color", value: hex };
      return { kind: "none" };
    }

    function buildStatic() {
      for (const family of Object.keys(colors)) {
        for (const p of colorPrefixes) addEntry(`${p}-${family}`, "static");
      }
      for (const u of ns.data?.utilities || []) addEntry(u, "static");
    }

    // Selector-text-only scan of one sheet's rule list, with no parent-rule
    // walks. `state` (rulesScanned/deadline/truncated) is owned by scanCssom
    // and shared across every sheet in the pass — it is NOT reset here, so
    // one large sheet spends the same shared budget as many small ones
    // (plan 419: the old per-sheet reset is why tailwindcss.com's one huge
    // sheet lost 29% of classes while github.com, spreading the same rules
    // across 51 sheets, lost none — pure luck of sheet boundaries, not
    // headroom). Returns false when the shared budget is exhausted, which
    // tells the caller to stop the whole pass, not just this sheet.
    function scanSheetRules(rules, state) {
      const pending = [rules];
      while (pending.length) {
        const list = pending.pop();
        for (let i = 0; i < list.length; i++) {
          state.rulesScanned++;
          if (state.rulesScanned > MAX_TOTAL_RULES) {
            state.truncated = true;
            return false;
          }
          if (state.rulesScanned % DEADLINE_CHECK_INTERVAL === 0 && performance.now() > state.deadline) {
            state.truncated = true;
            return false;
          }
          const rule = list[i];
          const sel = rule.selectorText;
          if (sel) {
            let m;
            CLASS_TOKEN_RE.lastIndex = 0;
            while ((m = CLASS_TOKEN_RE.exec(sel)) !== null) {
              addEntry(m[1].replace(/\\/g, ""), "cssom", rule);
            }
          }
          const nested = rule.cssRules; // grouping rule (@media/@supports) — one level of refs, no declaration text
          if (nested && nested.length) pending.push(nested);
        }
      }
      return true;
    }

    function scanCssom() {
      if (scanned) return;
      scanned = true;
      const start = performance.now();
      const state = { rulesScanned: 0, truncated: false, deadline: start + SCAN_TIME_BUDGET_MS };
      let sheetsScanned = 0;
      let sheetsSkipped = 0;
      const sheets = document.styleSheets;
      for (let i = 0; i < sheets.length; i++) {
        let rules;
        try {
          rules = sheets[i].cssRules; // throws on cross-origin → skip
        } catch {
          sheetsSkipped++;
          continue;
        }
        if (!rules) continue;
        sheetsScanned++;
        if (!scanSheetRules(rules, state)) break; // shared budget hit → stop the whole pass, deliberately
      }
      scanStats = {
        truncated: state.truncated,
        rulesScanned: state.rulesScanned,
        sheetsScanned,
        sheetsSkipped,
        elapsedMs: performance.now() - start,
      };
    }

    function scheduleCssomScan() {
      const run = () => scanCssom();
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    }

    function ensureBuilt() {
      if (built) return;
      built = true;
      buildStatic();
      scheduleCssomScan(); // deferred; never blocks the editor-open path
    }

    // Split a partial token into an optional variant chain + utility stub.
    function splitVariants(token) {
      const idx = token.lastIndexOf(":");
      if (idx === -1) return { variant: "", stub: token };
      return { variant: token.slice(0, idx + 1), stub: token.slice(idx + 1) };
    }

    function query(token) {
      ensureBuilt();
      if (!token) return [];
      const trimmed = token.trim();
      if (!trimmed) return [];

      // Arbitrary value typed in full → accept verbatim.
      if (/-\[[^\]]*\]$/.test(trimmed)) {
        return [{ className: trimmed, source: "arbitrary", preview: previewFor(trimmed) }];
      }

      const { variant, stub } = splitVariants(trimmed);
      if (!stub) {
        // user just typed "hover:" — offer nothing yet, wait for the utility part
        return [];
      }
      const key = leadingKey(stub);
      const pool = byPrefix.get(key) || [];
      const out = [];
      // exact-prefix matches on the leading key first
      for (const entry of pool) {
        if (entry.className.startsWith(stub)) {
          out.push(reVariant(entry, variant));
          if (out.length >= MAX_SUGGESTIONS) break;
        }
      }
      // fuzzy fallback: substring match across all pools
      if (out.length < 6) {
        for (const [, list] of byPrefix) {
          for (const entry of list) {
            if (entry.className.includes(stub) && !entry.className.startsWith(stub)) {
              out.push(reVariant(entry, variant));
              if (out.length >= MAX_SUGGESTIONS) break;
            }
          }
          if (out.length >= MAX_SUGGESTIONS) break;
        }
      }
      const family = stub.split("-", 1)[0];
      if ((stub.endsWith("-") || ARBITRARY_FAMILIES.has(family)) && !stub.includes("[")) {
        const template = `${variant}${stub}[…]`;
        if (!out.some((entry) => entry.className === template)) {
          if (out.length >= MAX_SUGGESTIONS) out.length = MAX_SUGGESTIONS - 1;
          out.push({ className: template, source: "arbitrary", template: true });
        }
      }
      return out;
    }

    function reVariant(entry, variant) {
      const result = {
        // Re-attach the typed variant chain to the suggested utility while
        // keeping the internal CSSStyleRule reference out of query results.
        className: variant ? variant + entry.className : entry.className,
        source: entry.source,
        preview: entry.preview,
      };
      if (entry.template) result.template = true;
      return result;
    }

    // Snapshot of the CSSOM scan's completeness. `truncated` is true iff the
    // shared time or rule budget was hit before every sheet was covered —
    // callers should treat the index as possibly incomplete when true.
    // Zeros/false before the deferred scan has run (ensureBuilt schedules it
    // via requestIdleCallback; it does not block editor open).
    function stats() {
      return { ...scanStats };
    }

    return { ensureBuilt, query, explain, stats };
  }

  ns.createSuggestionIndex = createSuggestionIndex;
})();
