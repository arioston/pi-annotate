/**
 * Pi Annotate — Tailedit live theme resolver (Phase E, plan 421)
 *
 * The single place in the codebase that ever calls
 * `getComputedStyle(document.documentElement)` to read a page's Tailwind v4
 * theme custom properties off `:root`. Every consumer — controls/typography.js,
 * controls/color.js, editor.js's breakpoint bar — asks THIS module for a
 * family; none of them probe the DOM directly. See
 * docs/theme-introspection-spike.md (plan 418) for the measured evidence
 * this module encodes; do not re-derive it:
 *
 *   - Tailwind v4 exposes theme values as `:root` custom properties
 *     (`--color-*`, `--text-*`, `--font-weight-*`, `--radius-*`,
 *     `--breakpoint-*`, `--leading-*`, `--tracking-*`, plus a single
 *     `--spacing` base unit — NOT a discrete `--spacing-4`/`--spacing-8`/…
 *     scale; that scale is not enumerable on the page at all).
 *   - Prefix presence is NOT evidence a page is really Tailwind. GitHub's
 *     Primer design system uses the exact same custom-property namespace
 *     (`--color-*`, `--breakpoint-*`, `--text-*`, ...) with unrelated
 *     values and would be misread as Tailwind v4 by a naive prefix check.
 *     Bootstrap likewise trips a naive v3 heuristic.
 *   - What discriminates: canonical-name probing, per family. A family is
 *     only served live when ITS OWN canonical anchor property resolves to
 *     a non-empty value — independently of every other family (GitHub has
 *     `--color-*` but no `--radius-*`/`--spacing`/`--leading-*`/`--tracking-*`).
 *
 * Bundled defaults are never duplicated here. When a family's anchor is
 * missing, `family(name)` reports `{ live: false, source: "bundled" }` and
 * the CALLER falls back to its own existing constant (`ns.data.colors`,
 * typography.js's token lists, editor.js's `BREAKPOINTS`) — exactly as it
 * did before this module existed. A page with no Tailwind v4 theme behaves
 * identically to today.
 *
 * Loaded raw (no bundler), after tw-spacing.js and before editor.js.
 * Registers onto the single window.__piTailedit namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  // Canonical anchor + prefix per family (plan 421 anchor table, verified
  // against a live Tailwind v4 page in the plan-418 spike). Liveness is
  // decided ONLY by the anchor resolving non-empty — never by prefix
  // presence, which Primer/Bootstrap can trip (spike §4.4, the GitHub
  // false-positive case).
  const FAMILY_DEFS = {
    color: { anchor: "--color-blue-500", prefix: "--color-" },
    text: { anchor: "--text-lg", prefix: "--text-" },
    fontWeight: { anchor: "--font-weight-bold", prefix: "--font-weight-" },
    radius: { anchor: "--radius-lg", prefix: "--radius-" },
    breakpoint: { anchor: "--breakpoint-md", prefix: "--breakpoint-" },
    leading: { anchor: "--leading-normal", prefix: "--leading-" },
    tracking: { anchor: "--tracking-wide", prefix: "--tracking-" },
  };
  const SPACING_ANCHOR = "--spacing";
  // Tailwind's own public default spacing base unit (1 step = 0.25rem),
  // re-derived from the MIT-licensed default theme — not from Tailscan
  // (plan 281 provenance guardrail). The bundled floor when `--spacing`
  // does not resolve on the page.
  const DEFAULT_SPACING_BASE = "0.25rem";

  function parseLengthToPx(raw, rootFontSizePx) {
    if (typeof raw !== "string") return null;
    const match = /^(-?[\d.]+)(px|rem|em)?$/.exec(raw.trim());
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return null;
    const unit = match[2] || "px";
    if (unit === "px") return num;
    return num * rootFontSizePx; // rem/em resolved relative to the root font size
  }

  /** Every custom-property name on a CSSStyleDeclaration (indices are enumerable). */
  function customPropertyNames(styles) {
    const names = [];
    for (let i = 0; i < styles.length; i++) {
      const name = styles[i];
      if (name && name.indexOf("--") === 0) names.push(name);
    }
    return names;
  }

  function scanPrefix(styles, names, prefix, filter) {
    const values = {};
    for (const name of names) {
      if (name.indexOf(prefix) !== 0) continue;
      if (filter && !filter(name)) continue;
      const key = name.slice(prefix.length);
      if (!key) continue;
      const raw = styles.getPropertyValue(name).trim();
      if (raw) values[key] = raw;
    }
    return values;
  }

  // `--text-*` mixes size tokens with line-height companions
  // (`--text-8xl--line-height`) and an unrelated `--text-shadow-*` family
  // (spike §4.2) — both filtered out so a consumer sees size tokens only.
  function textFilter(name) {
    if (name.indexOf("--text-shadow-") === 0) return false;
    if (name.indexOf("--line-height") !== -1) return false;
    return true;
  }

  function resolveFamilies() {
    const styles = getComputedStyle(document.documentElement);
    const names = customPropertyNames(styles);
    const rootFontSizePx = parseFloat(styles.fontSize) || 16;
    const families = {};

    for (const name of Object.keys(FAMILY_DEFS)) {
      const def = FAMILY_DEFS[name];
      const anchorRaw = styles.getPropertyValue(def.anchor).trim();
      if (!anchorRaw) {
        families[name] = { live: false, values: null, source: "bundled" };
        continue;
      }
      const filter = name === "text" ? textFilter : undefined;
      let values = scanPrefix(styles, names, def.prefix, filter);
      if (name === "breakpoint") {
        // Breakpoint values arrive as CSS lengths ("48rem") — resolve to px
        // up front so editor.js can sort/compare without touching :root itself.
        const px = {};
        for (const key of Object.keys(values)) {
          const converted = parseLengthToPx(values[key], rootFontSizePx);
          if (converted !== null) px[key] = converted;
        }
        values = px;
      }
      families[name] = { live: true, values, source: "page" };
    }

    // Spacing: base unit only, per D6/spike §4.2 — the scale's step keys
    // are never enumerable from :root (`--spacing-4` does not exist) and
    // stay bundled in tw-spacing.js's SCALE regardless of this result.
    const spacingRaw = styles.getPropertyValue(SPACING_ANCHOR).trim();
    families.spacing = spacingRaw
      ? { live: true, base: spacingRaw, source: "page" }
      : { live: false, base: DEFAULT_SPACING_BASE, source: "bundled" };

    return { families, resolvedAt: Date.now() };
  }

  ns.createTheme = function createTheme() {
    let cache = null; // read once per mount(), never per pin/render

    function resolve() {
      if (!cache) cache = resolveFamilies();
      return cache;
    }

    function family(name) {
      const cached = resolve();
      return cached.families[name] || { live: false, values: null, source: "bundled" };
    }

    function isLive(name) {
      return !!family(name).live;
    }

    function stats() {
      const cached = resolve();
      const liveFamilies = [];
      const bundledFamilies = [];
      for (const name of Object.keys(cached.families)) {
        (cached.families[name].live ? liveFamilies : bundledFamilies).push(name);
      }
      return { resolvedAt: cached.resolvedAt, liveFamilies, bundledFamilies };
    }

    // Clears the cache so the next resolve() re-reads :root. Nothing calls
    // this in plan 421 — it exists as a seam for a future SPA-navigation hook.
    function refresh() {
      cache = null;
    }

    // Seam for a future spacing consumer (controls/spacing.js and
    // overlay.js are both out of scope for plan 421 and are not edited to
    // call this). Any per-step value derived from the live base unit is
    // SYNTHESIZED — calc(base * N) — not read from the page, and must be
    // presented as such rather than as a verified page value (D6 honesty
    // rule, the same rule the breakpoint bar's provenance label follows).
    function synthesizeSpacing(multiplier) {
      const spacing = family("spacing");
      return {
        value: "calc(" + spacing.base + " * " + multiplier + ")",
        synthesized: true,
        source: spacing.source,
      };
    }

    return { resolve, family, isLive, stats, refresh, synthesizeSpacing };
  };
})();
