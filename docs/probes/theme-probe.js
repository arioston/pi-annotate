/**
 * Pi Annotate — runtime Tailwind theme introspection probe (plan 418 spike)
 *
 * Standalone, throwaway. NOT wired into the extension, NOT in the manifest.
 * Paste into any page's DevTools console. Takes no arguments, mutates
 * nothing, only console.log's a structured report — including :root custom
 * property VALUES (not just names), and a targeted v4ScaleShape check for
 * whether Tailwind v4's spacing scale is discrete (--spacing-4, ...) or a
 * single base value meant to be derived via calc(). Mirrors the budget shape
 * of chrome-extension/tailedit/suggest.js (MAX_SHEET_RULES) but does not
 * import or depend on the extension.
 */
(() => {
  "use strict";

  const MAX_SHEET_RULES = 4000; // mirrors tailedit/suggest.js MAX_SHEET_RULES
  const V4_PREFIX_GROUPS = [
    "--font-weight-", "--breakpoint-", "--color-", "--text-", "--font-",
    "--radius-", "--shadow-", "--spacing", "--leading-", "--tracking-",
  ];
  const CLASS_TOKEN_RE = /\.((?:\\.|[-\w[\]#.%/])+)/g;
  const UTILITY_SAMPLE = ["p-4", "text-lg", "bg-blue-500"];
  // Naive utility-shape heuristic for v3 evidence (mode detection only, not
  // the class-token census in item 5). Reliability against a non-Tailwind
  // page is exactly what this probe's step 2 run is meant to test — see the
  // findings doc, do not treat this as validated.
  const TW_LIKE_PREFIXES = new Set([
    "p", "px", "py", "pt", "pr", "pb", "pl", "m", "mx", "my", "mt", "mr", "mb", "ml",
    "gap", "w", "h", "min-w", "max-w", "min-h", "max-h", "text", "bg", "border",
    "rounded", "flex", "grid", "items", "justify", "font", "leading", "tracking",
    "shadow", "z", "top", "left", "right", "bottom", "inset", "space-x", "space-y", "ring",
  ]);
  function twLikeKey(token) {
    const body = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
    const dash = body.indexOf("-");
    return dash === -1 ? body : body.slice(0, dash);
  }

  const SAMPLE_SIZE = 8;
  const FULL_LIST_GROUPS = new Set(["--color-", "--spacing"]);
  const FULL_LIST_CAP = 400;
  const VALUE_TRUNCATE = 80;

  function truncateValue(v) {
    return v.length > VALUE_TRUNCATE ? `${v.slice(0, VALUE_TRUNCATE)}…` : v;
  }

  // --- 2. :root custom properties (names AND values) ---
  function scanRootCustomProps(cs) {
    const groups = {};
    for (const g of V4_PREFIX_GROUPS) groups[g] = [];
    const other = [];
    let total = 0;
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      if (!prop || !prop.startsWith("--")) continue;
      total++;
      const value = truncateValue(cs.getPropertyValue(prop).trim());
      const group = V4_PREFIX_GROUPS.find((p) => prop.startsWith(p));
      (group ? groups[group] : other).push({ name: prop, value });
    }
    const summary = {};
    const fullNameLists = {};
    for (const g of V4_PREFIX_GROUPS) {
      const entries = groups[g];
      summary[g] = {
        count: entries.length,
        samples: entries.slice(0, SAMPLE_SIZE).map((e) => `${e.name}: ${e.value}`),
      };
      if (FULL_LIST_GROUPS.has(g)) {
        const names = entries.map((e) => e.name);
        fullNameLists[g] = { names: names.slice(0, FULL_LIST_CAP), truncated: names.length > FULL_LIST_CAP };
      }
    }
    return {
      total, byPrefix: summary, fullNameLists,
      otherCount: other.length,
      otherSamples: other.slice(0, SAMPLE_SIZE).map((e) => `${e.name}: ${e.value}`),
    };
  }

  // --- targeted v4 scale-shape probe: is the spacing scale discrete or a
  // single base value derived via calc()? This one boolean flips the
  // spacing-half recommendation between GO and NO-GO — see plan 418 §2/§4.
  const V4_SCALE_SHAPE_PROPS = [
    "--spacing", "--spacing-4", "--color-blue-500", "--text-lg",
    "--font-weight-bold", "--radius-lg", "--breakpoint-md",
  ];

  function scanV4ScaleShape(cs) {
    const props = {};
    for (const name of V4_SCALE_SHAPE_PROPS) {
      const raw = cs.getPropertyValue(name).trim();
      props[name] = { defined: raw !== "", value: raw || null };
    }
    return { discreteSpacingScale: props["--spacing-4"].defined, props };
  }

  // --- 3/4/5. single CSSOM pass: sheet census + utility sample + class tokens
  function scanCssom() {
    const sheets = document.styleSheets;
    let sheetsThrew = 0;
    let totalRules = 0;
    let maxSheetRuleCount = 0;
    let capTripped = false;
    const classTokens = new Set();
    let twLikeTokenCount = 0;
    const utilityMatches = {};
    const utilityRe = {};
    for (const cls of UTILITY_SAMPLE) {
      utilityMatches[cls] = null;
      utilityRe[cls] = new RegExp(`\\.${cls.replace(/[.]/g, "\\.")}(?![\\w-])`);
    }

    for (let s = 0; s < sheets.length; s++) {
      let rules;
      try {
        rules = sheets[s].cssRules;
      } catch {
        sheetsThrew++;
        continue;
      }
      if (!rules) continue;
      let sheetCount = 0;
      const pending = [rules];
      while (pending.length) {
        const list = pending.pop();
        for (let i = 0; i < list.length; i++) {
          sheetCount++;
          totalRules++;
          if (sheetCount > MAX_SHEET_RULES) capTripped = true;
          const rule = list[i];
          const sel = rule.selectorText;
          if (sel) {
            let m;
            CLASS_TOKEN_RE.lastIndex = 0;
            while ((m = CLASS_TOKEN_RE.exec(sel)) !== null) {
              const token = m[1].replace(/\\/g, "");
              if (!classTokens.has(token) && TW_LIKE_PREFIXES.has(twLikeKey(token))) twLikeTokenCount++;
              classTokens.add(token);
            }
            for (const cls of UTILITY_SAMPLE) {
              if (utilityMatches[cls] || !utilityRe[cls].test(sel)) continue;
              const style = rule.style;
              const decls = [];
              for (let d = 0; style && d < style.length; d++) {
                decls.push(`${style[d]}: ${style.getPropertyValue(style[d]).trim()}`);
              }
              utilityMatches[cls] = { selector: sel, declarations: decls };
            }
          }
          const nested = rule.cssRules;
          if (nested && nested.length) pending.push(nested);
        }
      }
      if (sheetCount > maxSheetRuleCount) maxSheetRuleCount = sheetCount;
    }

    return {
      sheetCensus: { totalSheets: sheets.length, sheetsThrew, totalRules, maxSheetRuleCount, capTripped },
      utilitySample: utilityMatches,
      classTokenCount: classTokens.size,
      twLikeTokenCount,
    };
  }

  const cs = getComputedStyle(document.documentElement);
  const rootProps = scanRootCustomProps(cs);
  const scaleShape = scanV4ScaleShape(cs);
  const cssom = scanCssom();

  const v4Evidence = Object.entries(rootProps.byPrefix).filter(([, v]) => v.count > 0).map(([k]) => k);
  // Threshold is arbitrary (>=3 distinct utility-shaped tokens); this heuristic
  // is unvalidated — see the naive-heuristic note above and the findings doc.
  const v3Evidence = cssom.twLikeTokenCount >= 3;
  let mode = "unknown";
  if (v4Evidence.length > 0) mode = "v4";
  else if (v3Evidence) mode = "v3-or-unknown-tailwind";

  const report = {
    url: location.href,
    // Surfaced near the top: the single most decision-relevant bit in this
    // report. true only when --spacing-4 resolves to a non-empty value —
    // i.e. the spacing scale is enumerable from :root, not just derivable.
    discreteSpacingScale: scaleShape.discreteSpacingScale,
    v4ScaleShape: scaleShape.props,
    detectedMode: {
      mode, v4EvidencePrefixes: v4Evidence,
      twLikeTokenCountAsV3Evidence: cssom.twLikeTokenCount,
      totalDistinctClassTokens: cssom.classTokenCount,
    },
    rootCustomProperties: rootProps,
    stylesheetCensus: cssom.sheetCensus,
    utilitySample: cssom.utilitySample,
    classTokenCensus: { distinctClassTokens: cssom.classTokenCount },
  };

  console.log("=== theme-probe.js report ===");
  console.log(report);
  console.log(JSON.stringify(report, null, 2));
})();
