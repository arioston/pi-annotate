/**
 * Pi Annotate — Tailedit typography control (Phase C2, plan 409; Phase E, plan 421)
 *
 * Font-size / weight / alignment / leading / tracking widget for the Controls
 * pane. `text-*` is the awkward family here: the same prefix is shared by
 * font size (`text-lg`), alignment (`text-left`), AND colour (`text-blue-500`,
 * owned by controls/color.js). A plain prefix regex would clobber across
 * these, so every row below matches by MEMBERSHIP in an explicit token list
 * (an exact, both-ends-anchored alternation) rather than by shared prefix —
 * plan 409 Step 3. `currentXxx()` double-checks the match against the same
 * token list via Array.includes before trusting it, as a defence-in-depth
 * belt-and-braces in case a future edit loosens a regex.
 *
 * Phase E (plan 421): size / weight / leading / tracking token lists come
 * from `ctx.theme` (chrome-extension/tailedit/tw-theme.js) when the page's
 * own live values are available, falling back to the DEFAULT_* bundled
 * constants below otherwise — per family, independently. `ALIGN_TOKENS` is
 * not a Tailwind theme family (there is no `--text-align-*` custom
 * property) and is never resolved live. The membership discipline itself is
 * unchanged: whichever token list is active, the family regex is still
 * built by exact membership, so `text-lg` (size) can never be confused with
 * `text-blue-500` (colour) or `text-left` (alignment).
 *
 * Loaded raw (no bundler) BEFORE editor.js, AFTER tw-default-classes.js.
 * Registers onto the single window.__piTailedit namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});
  ns.controls = ns.controls || {};

  // Default-theme token lists (subsets) — the bundled floor. Used verbatim
  // when a family isn't live (no theme resolver, or its canonical anchor
  // didn't resolve on this page).
  const DEFAULT_SIZE_TOKENS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];
  const DEFAULT_WEIGHT_TOKENS = ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"];
  const ALIGN_TOKENS = ["left", "center", "right", "justify"];
  const DEFAULT_LEADING_TOKENS = ["none", "tight", "snug", "normal", "relaxed", "loose", "3", "4", "5", "6", "7", "8", "9", "10"];
  const DEFAULT_TRACKING_TOKENS = ["tighter", "tight", "normal", "wide", "wider", "widest"];

  function escapeToken(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Membership regex: anchored at both ends against the exact token
  // alternation for THIS family only, so e.g. the size regex cannot match
  // "text-left" (alignment) or "text-blue-500" (colour) — those strings are
  // not "text-" + a size token, full stop.
  function membershipRegex(prefix, tokens) {
    const alt = tokens.map(escapeToken).join("|");
    return new RegExp("^" + escapeToken(prefix) + "-(?:" + alt + ")$");
  }

  // Live token list for a family, falling back to the bundled default when
  // the resolver is absent, the family isn't live, or the live scan is
  // (defensively) empty.
  function tokensFor(theme, familyName, bundled) {
    if (!theme) return bundled;
    const fam = theme.family(familyName);
    if (!fam || !fam.live || !fam.values) return bundled;
    const keys = Object.keys(fam.values);
    return keys.length ? keys : bundled;
  }

  ns.controls.typography = {
    title: "Typography",
    create(ctx) {
      const doc = ctx.doc;
      const theme = ctx.theme;

      // Resolved once here — ctx.theme itself is built once per mount() and
      // cached, so this does not re-read :root; it just picks live vs
      // bundled per family (plan 421 per-family gating).
      const SIZE_TOKENS = tokensFor(theme, "text", DEFAULT_SIZE_TOKENS);
      const WEIGHT_TOKENS = tokensFor(theme, "fontWeight", DEFAULT_WEIGHT_TOKENS);
      const LEADING_TOKENS = tokensFor(theme, "leading", DEFAULT_LEADING_TOKENS);
      const TRACKING_TOKENS = tokensFor(theme, "tracking", DEFAULT_TRACKING_TOKENS);

      const SIZE_RX = membershipRegex("text", SIZE_TOKENS);
      const WEIGHT_RX = membershipRegex("font", WEIGHT_TOKENS);
      const ALIGN_RX = membershipRegex("text", ALIGN_TOKENS);
      const LEADING_RX = membershipRegex("leading", LEADING_TOKENS);
      const TRACKING_RX = membershipRegex("tracking", TRACKING_TOKENS);

      const GROUPS = [
        { label: "Size", prefix: "text", tokens: SIZE_TOKENS, rx: SIZE_RX },
        { label: "Weight", prefix: "font", tokens: WEIGHT_TOKENS, rx: WEIGHT_RX },
        { label: "Align", prefix: "text", tokens: ALIGN_TOKENS, rx: ALIGN_RX },
        { label: "Leading", prefix: "leading", tokens: LEADING_TOKENS, rx: LEADING_RX },
        { label: "Tracking", prefix: "tracking", tokens: TRACKING_TOKENS, rx: TRACKING_RX },
      ];

      const root = doc.createElement("div");
      root.className = "te-ctl-body";

      const rows = GROUPS.map((group) => {
        const row = doc.createElement("div");
        row.className = "te-ctl-row";
        const label = doc.createElement("label");
        label.textContent = group.label;
        const select = doc.createElement("select");
        select.className = "te-ctl-select";
        const clearOpt = doc.createElement("option");
        clearOpt.value = "";
        clearOpt.textContent = "—";
        select.appendChild(clearOpt);
        for (const token of group.tokens) {
          const opt = doc.createElement("option");
          opt.value = token;
          opt.textContent = token;
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          const value = select.value;
          // Defensive: only ever apply a value that is a real member of this
          // family's token list (mirrors the membership check in sync()).
          if (value && !group.tokens.includes(value)) return;
          ctx.applyFamily(group.rx, value ? group.prefix + "-" + value : null);
        });
        row.appendChild(label);
        row.appendChild(select);
        root.appendChild(row);
        return { group, select };
      });

      // Membership check: the regex already restricts matches to this
      // family's own tokens, but re-validate the candidate against the
      // token list by array membership before trusting it as "current".
      function currentValue(group) {
        const candidate = ctx.readFamily(group.rx);
        if (!candidate) return "";
        const token = candidate.slice(group.prefix.length + 1);
        return group.tokens.includes(token) ? token : "";
      }

      function sync() {
        for (const { group, select } of rows) {
          select.value = currentValue(group);
        }
      }

      return { root, sync };
    },
  };
})();
