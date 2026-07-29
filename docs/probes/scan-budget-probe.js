/**
 * Pi Annotate — CSSOM scan budget probe (plan 419)
 *
 * Standalone, throwaway. NOT wired into the extension, NOT in the manifest.
 * Paste into any page's DevTools console. Takes no arguments, mutates
 * nothing, only console.log's a structured report.
 *
 * Confirms the fix in chrome-extension/tailedit/suggest.js: compares the
 * count of distinct Tailwind class tokens found under the OLD per-sheet
 * 4000-rule cap (which the plan-418 spike measured dropping 28.7% of
 * tailwindcss.com's classes — 0% on github.com, by luck of sheet
 * boundaries, not headroom) against the NEW shared time+rule budget
 * (SCAN_TIME_BUDGET_MS / MAX_TOTAL_RULES, counted across all sheets).
 *
 * Measurement harness only — does not import suggest.js, does not change
 * the extension's behavior. Walks the page's CSSOM exactly once (uncapped)
 * and replays that single rule list against both budget policies, so the
 * three reported scans are directly comparable.
 */
(() => {
  "use strict";

  // Mirrors chrome-extension/tailedit/suggest.js constants (plan 419).
  const OLD_MAX_SHEET_RULES = 4000; // pre-fix per-sheet cap, reset per sheet
  const NEW_SCAN_TIME_BUDGET_MS = 150;
  const NEW_MAX_TOTAL_RULES = 60000;
  const NEW_DEADLINE_CHECK_INTERVAL = 500;

  const CLASS_TOKEN_RE = /\.((?:\\.|[-\w[\]#.%/])+)/g;

  function classTokensOf(sel, into) {
    let m;
    CLASS_TOKEN_RE.lastIndex = 0;
    while ((m = CLASS_TOKEN_RE.exec(sel)) !== null) into.add(m[1].replace(/\\/g, ""));
  }

  // Single full-page CSSOM walk (uncapped), recording every rule's
  // selectorText per sheet in the same DFS/pending-stack traversal order
  // suggest.js uses. Every "under a cap" measurement below replays this
  // list instead of re-walking the DOM, so the page is only walked once.
  function collectAllRules() {
    const sheets = document.styleSheets;
    let sheetsThrew = 0;
    const rulesBySheet = []; // index-aligned with `sheets`; null = threw (cross-origin)
    for (let s = 0; s < sheets.length; s++) {
      let rules;
      try {
        rules = sheets[s].cssRules;
      } catch {
        sheetsThrew++;
        rulesBySheet.push(null);
        continue;
      }
      const flat = [];
      if (rules) {
        const pending = [rules];
        while (pending.length) {
          const list = pending.pop();
          for (let i = 0; i < list.length; i++) {
            const rule = list[i];
            flat.push(rule.selectorText || null);
            const nested = rule.cssRules; // grouping rule (@media/@supports)
            if (nested && nested.length) pending.push(nested);
          }
        }
      }
      rulesBySheet.push(flat);
    }
    return { sheets, rulesBySheet, sheetsThrew };
  }

  // OLD behavior: counter resets per sheet; on exceeding the cap the sheet
  // is abandoned (mirrors the old `if (++count > MAX_SHEET_RULES) return;`).
  function underOldPerSheetCap(rulesBySheet) {
    const tokens = new Set();
    let rulesCounted = 0;
    let sheetsTruncated = 0;
    for (const flat of rulesBySheet) {
      if (!flat) continue; // cross-origin, skipped the same as before
      let count = 0;
      for (const sel of flat) {
        if (++count > OLD_MAX_SHEET_RULES) {
          sheetsTruncated++;
          break; // abandons the rest of this sheet, exactly like the old `return`
        }
        rulesCounted++;
        if (sel) classTokensOf(sel, tokens);
      }
    }
    return { distinctClassTokens: tokens.size, rulesCounted, sheetsTruncated };
  }

  // NEW behavior: one counter and one deadline shared across every sheet;
  // stops the whole pass (not just one sheet) on hitting either.
  function underNewSharedBudget(rulesBySheet) {
    const tokens = new Set();
    const deadline = performance.now() + NEW_SCAN_TIME_BUDGET_MS;
    let rulesScanned = 0;
    let truncated = false;
    outer: for (const flat of rulesBySheet) {
      if (!flat) continue;
      for (const sel of flat) {
        rulesScanned++;
        if (rulesScanned > NEW_MAX_TOTAL_RULES) {
          truncated = true;
          break outer;
        }
        if (rulesScanned % NEW_DEADLINE_CHECK_INTERVAL === 0 && performance.now() > deadline) {
          truncated = true;
          break outer;
        }
        if (sel) classTokensOf(sel, tokens);
      }
    }
    return { distinctClassTokens: tokens.size, rulesScanned, truncated };
  }

  const t0 = performance.now();
  const { sheets, rulesBySheet, sheetsThrew } = collectAllRules();
  const collectElapsedMs = performance.now() - t0;

  let totalRules = 0;
  let maxSheetRuleCount = 0;
  const allTokens = new Set();
  for (const flat of rulesBySheet) {
    if (!flat) continue;
    totalRules += flat.length;
    if (flat.length > maxSheetRuleCount) maxSheetRuleCount = flat.length;
    for (const sel of flat) if (sel) classTokensOf(sel, allTokens);
  }

  const oldCap = underOldPerSheetCap(rulesBySheet);
  const newBudget = underNewSharedBudget(rulesBySheet);
  const lostByOldCap = allTokens.size - oldCap.distinctClassTokens;
  const lostByNewBudget = allTokens.size - newBudget.distinctClassTokens;
  const pct = (lost) => (allTokens.size ? +((lost / allTokens.size) * 100).toFixed(1) : 0);

  const report = {
    url: location.href,
    sheetCensus: { totalSheets: sheets.length, sheetsThrew, totalRules, maxSheetRuleCount },
    collectElapsedMs,
    uncapped: { distinctClassTokens: allTokens.size },
    oldPerSheetCap: {
      cap: OLD_MAX_SHEET_RULES,
      ...oldCap,
      lostClassTokens: lostByOldCap,
      lostPct: pct(lostByOldCap),
    },
    newSharedBudget: {
      timeBudgetMs: NEW_SCAN_TIME_BUDGET_MS,
      ruleBudget: NEW_MAX_TOTAL_RULES,
      ...newBudget,
      lostClassTokens: lostByNewBudget,
      lostPct: pct(lostByNewBudget),
    },
  };

  console.log("=== scan-budget-probe.js report ===");
  console.log(report);
  console.log(JSON.stringify(report, null, 2));
})();
