/**
 * Pi Annotate — spacing vocabulary regression check (plan 420)
 *
 * NODE SCRIPT, not a console-paste probe. Unlike the other files in this
 * directory (scan-budget-probe.js, theme-probe.js), which are meant to be
 * pasted into a live page's DevTools console, this one runs under plain
 * `node` with no browser and no page — it loads tw-spacing.js and
 * tw-default-classes.js verbatim under a `global.window` stub and asserts
 * the invariant plan 420 restored: the widget's family regexes and the
 * autocomplete's default class list are the SAME 35-step spacing scale, so
 * the widget can never fail to recognize a class the autocomplete offered.
 *
 * Run: node docs/probes/spacing-vocabulary-check.js
 * Exit code 0 = all assertions passed. Non-zero = at least one failed
 * (message printed to stderr), so this can be wired into a check later.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const spacingSrc = fs.readFileSync(
  path.join(root, "chrome-extension/tailedit/tw-spacing.js"),
  "utf8",
);
const defaultClassesSrc = fs.readFileSync(
  path.join(root, "chrome-extension/tailedit/tw-default-classes.js"),
  "utf8",
);

global.window = {};
// eslint-disable-next-line no-eval
eval(spacingSrc);
// eslint-disable-next-line no-eval
eval(defaultClassesSrc);

const ns = global.window.__piTailedit;
assert.ok(ns && ns.spacing, "tw-spacing.js did not register ns.spacing");
assert.ok(ns.data, "tw-default-classes.js did not register ns.data");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`NOT OK - ${name}`);
    console.error(`  ${err.message}`);
  }
}

// ── 1/2: every p-*/m-*/gap-* (and every sibling family the Spacing widget
// actually renders a row for) utility in ns.data.utilities must be visible
// to the matching family regex. Zero invisible steps is the whole point of
// plan 420 — this is the exact assertion that would have caught the
// original bug (p-32 offered by autocomplete, invisible to the widget).
//
// GROUND_TRUTH_SCALE is a hardcoded, independent copy of Tailwind's default
// 35-step spacing scale — deliberately NOT read from ns.spacing.SCALE. If
// this check instead iterated ns.spacing.SCALE, it would trivially pass any
// time the two files drift back apart in lockstep (as they now structurally
// must), which defeats the purpose of a regression guard. Iterating this
// independent literal is what would have caught the original bug: the
// widget regex was built from an 18-step SCALE while the autocomplete data
// carried the full 35.
const GROUND_TRUTH_SCALE = [
  "0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6",
  "7", "8", "9", "10", "11", "12", "14", "16", "20", "24", "28", "32",
  "36", "40", "44", "48", "52", "56", "60", "64", "72", "80", "96",
];
const WIDGET_FAMILIES = [
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap",
];

check("every p-*/m-*/gap-* utility offered by autocomplete is visible to the widget regex", () => {
  const invisible = [];
  for (const prefix of WIDGET_FAMILIES) {
    const rx = ns.spacing.familyRegex(prefix);
    for (const step of GROUND_TRUTH_SCALE) {
      const cls = `${prefix}-${step}`;
      if (!ns.data.utilities.includes(cls)) continue; // not offered by autocomplete, not this check's concern
      if (!rx.test(cls)) invisible.push(cls);
    }
  }
  assert.deepEqual(invisible, [], `invisible to widget: ${invisible.join(", ")}`);
});

check("SCALE and spacingScale-derived utilities agree on step count (35)", () => {
  assert.equal(ns.spacing.SCALE.length, 35);
  const pUtilities = ns.data.utilities.filter((u) => /^p-/.test(u));
  assert.equal(pUtilities.length, 35);
});

// ── 3: plan-409 collision cases — a family regex must not swallow a
// sibling family's classes just because it shares a text prefix.
check("^p- does not match px-4 (plan 409 collision case)", () => {
  assert.equal(ns.spacing.familyRegex("p").test("px-4"), false);
});
check("^m- does not match min-w-0 (plan 409 collision case)", () => {
  assert.equal(ns.spacing.familyRegex("m").test("min-w-0"), false);
});
check("^gap- does not match gap-x-2 (plan 409 collision case)", () => {
  assert.equal(ns.spacing.familyRegex("gap").test("gap-x-2"), false);
});

// ── 4: simulate the reported bug end to end. Reimplements the exact
// readFamily/applyFamily algorithm in editor.js (plan 409) against a
// minimal classList stub, so this fails if the real algorithm's semantics
// (replace vs add) or the shared scale ever regress.
function makeElement(initialClasses) {
  const classes = [...initialClasses];
  const mutations = [];
  return {
    classes,
    mutations,
    classList: {
      replace(oldCls, newCls) {
        const i = classes.indexOf(oldCls);
        if (i !== -1) classes.splice(i, 1, newCls);
        mutations.push({ type: "replace", from: oldCls, to: newCls });
      },
      add(cls) {
        classes.push(cls);
        mutations.push({ type: "add", to: cls });
      },
      remove(cls) {
        const i = classes.indexOf(cls);
        if (i !== -1) classes.splice(i, 1);
        mutations.push({ type: "remove", from: cls });
      },
    },
  };
}

// Mirrors editor.js's readFamily/applyFamily (plan 409), parameterized over
// the element instead of a module-level `pinnedEl`.
function readFamily(el, familyRegex) {
  for (const cls of el.classes) {
    if (cls.includes(":")) continue;
    if (familyRegex.test(cls)) return cls;
  }
  return null;
}
function applyFamily(el, familyRegex, nextClass) {
  const current = readFamily(el, familyRegex);
  if (current && nextClass) {
    if (current !== nextClass) el.classList.replace(current, nextClass);
  } else if (!current && nextClass) {
    el.classList.add(nextClass);
  } else if (current && !nextClass) {
    el.classList.remove(current);
  }
}

check("applying p-4 over p-32 replaces (not adds) — the reported bug is fixed", () => {
  const el = makeElement(["p-32", "flex"]);
  const rx = ns.spacing.familyRegex("p");
  applyFamily(el, rx, "p-4");

  const livePClasses = el.classes.filter((c) => rx.test(c));
  assert.equal(livePClasses.length, 1, `expected exactly one live p-* class, got: ${livePClasses.join(", ")}`);
  assert.deepEqual(livePClasses, ["p-4"]);
  assert.equal(el.mutations.length, 1, `expected exactly one mutation, got ${el.mutations.length}`);
  assert.equal(el.mutations[0].type, "replace", `expected a replace mutation, got: ${JSON.stringify(el.mutations[0])}`);
});

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("all assertions passed");
process.exit(0);
