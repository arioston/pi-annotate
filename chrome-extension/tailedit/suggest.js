/**
 * Pi Annotate — Tailedit suggestion index (Phase A, plan 283)
 *
 * Lazy, budget-guarded Tailwind class suggestion source. Hybrid per design §4/D5:
 *   1. host-page CSSOM introspection (classes actually in use on the page), and
 *   2. a bundled open static default-theme list (tw-default-classes.js), plus
 *   3. an arbitrary-value passthrough parser (`prefix-[...]`).
 *
 * No-freeze contract (plans 280/285): the index is built on first editor open,
 * never at content-script load. The CSSOM pass is selector-text-only, honors the
 * same per-sheet rule budget as Etch (ETCH_MAX_SHEET_RULES), does NOT walk
 * `parent.cssText`, is deferred to requestIdleCallback, and degrades to the
 * static list if a sheet exceeds budget or is cross-origin.
 *
 * Loaded raw (no bundler). Exposes ns.createSuggestionIndex on the single
 * window.__piTailedit namespace; all state is private to the factory closure.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  const MAX_SHEET_RULES = 4000; // mirrors content.js ETCH_MAX_SHEET_RULES
  const MAX_SUGGESTIONS = 24;
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
    const byPrefix = new Map(); // leadingKey → ClassEntry[]
    const seen = new Set(); // dedupe className

    function addEntry(className, source) {
      if (!className || seen.has(className)) return;
      seen.add(className);
      const entry = { className, source, preview: previewFor(className) };
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

    // Selector-text-only CSSOM scan, budget-capped, no parent.cssText walks.
    function scanSheet(sheet) {
      let rules;
      try {
        rules = sheet.cssRules; // throws on cross-origin → skip
      } catch {
        return;
      }
      if (!rules) return;
      let count = 0;
      const pending = [rules];
      while (pending.length) {
        const list = pending.pop();
        for (let i = 0; i < list.length; i++) {
          if (++count > MAX_SHEET_RULES) return; // oversized sheet → degrade to static
          const rule = list[i];
          const sel = rule.selectorText;
          if (sel) {
            let m;
            CLASS_TOKEN_RE.lastIndex = 0;
            while ((m = CLASS_TOKEN_RE.exec(sel)) !== null) {
              addEntry(m[1].replace(/\\/g, ""), "cssom");
            }
          }
          const nested = rule.cssRules; // grouping rule (@media/@supports) — one level of refs, no cssText
          if (nested && nested.length) pending.push(nested);
        }
      }
    }

    function scanCssom() {
      if (scanned) return;
      scanned = true;
      const sheets = document.styleSheets;
      for (let i = 0; i < sheets.length; i++) scanSheet(sheets[i]);
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
          if (out.length >= MAX_SUGGESTIONS) return out;
        }
      }
      if (out.length >= 6) return out;
      // fuzzy fallback: substring match across all pools
      for (const [, list] of byPrefix) {
        for (const entry of list) {
          if (entry.className.includes(stub) && !entry.className.startsWith(stub)) {
            out.push(reVariant(entry, variant));
            if (out.length >= MAX_SUGGESTIONS) return out;
          }
        }
      }
      return out;
    }

    function reVariant(entry, variant) {
      if (!variant) return entry;
      // re-attach the typed variant chain to the suggested utility
      return {
        className: variant + entry.className,
        source: entry.source,
        preview: entry.preview,
      };
    }

    return { ensureBuilt, query };
  }

  ns.createSuggestionIndex = createSuggestionIndex;
})();
