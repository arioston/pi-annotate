/**
 * Pi Annotate — live theme resolver regression check (plan 421)
 *
 * NODE SCRIPT, not a console-paste probe. Unlike theme-probe.js (which is
 * meant to be pasted into a live page's DevTools console), this one runs
 * under plain `node` with no browser and no page — it loads tw-theme.js
 * (and controls/typography.js, controls/color.js) verbatim under a
 * `global.window` / `global.document` / `global.getComputedStyle` stub and
 * asserts the per-family, canonical-anchor-gated behavior plan 421 requires.
 *
 * The single most important case here is the GitHub/Primer false positive
 * (§4.4 of docs/theme-introspection-spike.md, plan 418): a page can expose
 * `--color-*`, `--breakpoint-*`, `--text-*` custom properties that are NOT
 * Tailwind's, and any gate weaker than "does this family's own canonical
 * anchor property resolve" will misattribute another design system's
 * values to Tailwind. Assertion 3 below is that guard.
 *
 * Run: node docs/probes/theme-resolver-check.js
 * Optionally pass a path to an alternate tw-theme.js to check against
 * (used for the plan's required adversarial self-test — see plan 421 report):
 *   node docs/probes/theme-resolver-check.js /path/to/scratch-tw-theme.js
 * Exit code 0 = all assertions passed. Non-zero = at least one failed.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const themePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "chrome-extension/tailedit/tw-theme.js");
const typographyPath = path.join(root, "chrome-extension/tailedit/controls/typography.js");
const colorPath = path.join(root, "chrome-extension/tailedit/controls/color.js");

const themeSrc = fs.readFileSync(themePath, "utf8");
const typographySrc = fs.readFileSync(typographyPath, "utf8");
const colorSrc = fs.readFileSync(colorPath, "utf8");

// ── minimal DOM stub ────────────────────────────────────────────────────
// Just enough of `document.createElement()` for the two widget factories'
// create(ctx): classList add/remove/toggle, style as a plain object,
// appendChild collecting children, addEventListener as a no-op sink. No
// widget under test calls querySelector or reads from the live page DOM.
function makeFakeDoc() {
  function makeEl() {
    const el = {
      _children: [],
      style: {},
      dataset: {},
      value: "",
      textContent: "",
      title: "",
      className: "",
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) {
          const has = this._set.has(c);
          const next = on === undefined ? !has : !!on;
          if (next) this._set.add(c);
          else this._set.delete(c);
        },
        contains(c) { return this._set.has(c); },
      },
      appendChild(child) { this._children.push(child); return child; },
      addEventListener() {},
      querySelectorAll() { return []; },
    };
    return el;
  }
  return { createElement: () => makeEl() };
}

// ── :root custom-property stub ──────────────────────────────────────────
function makeStyles(props, fontSize) {
  const names = Object.keys(props);
  const styles = {
    length: names.length,
    fontSize: fontSize || "16px",
    getPropertyValue(name) {
      return props[name] !== undefined ? props[name] : "";
    },
  };
  names.forEach((name, i) => {
    styles[i] = name;
  });
  return styles;
}

let currentStyles = null;
global.window = {};
global.document = { documentElement: {} };
global.getComputedStyle = () => currentStyles;

// eslint-disable-next-line no-eval
eval(themeSrc);
// eslint-disable-next-line no-eval
eval(typographySrc);
// eslint-disable-next-line no-eval
eval(colorSrc);

const ns = global.window.__piTailedit;
assert.ok(ns && typeof ns.createTheme === "function", "tw-theme.js did not register ns.createTheme");
assert.ok(ns.controls && ns.controls.typography, "controls/typography.js did not register ns.controls.typography");
assert.ok(ns.controls && ns.controls.color, "controls/color.js did not register ns.controls.color");

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

// Independent ground-truth copies of the bundled defaults — deliberately
// NOT read from typography.js's internals, mirroring the GROUND_TRUTH_SCALE
// pattern in spacing-vocabulary-check.js. If typography.js's DEFAULT_*
// constants ever drift, this check should notice, not silently follow them.
const GROUND_TRUTH_SIZE_TOKENS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];
const GROUND_TRUTH_WEIGHT_TOKENS = ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"];
const GROUND_TRUTH_LEADING_TOKENS = ["none", "tight", "snug", "normal", "relaxed", "loose", "3", "4", "5", "6", "7", "8", "9", "10"];
const GROUND_TRUTH_TRACKING_TOKENS = ["tighter", "tight", "normal", "wide", "wider", "widest"];

function buildCtx(theme) {
  return {
    applyFamily() {},
    readFamily() { return null; },
    data: { colors: { "blue-500": "#3b82f6", "red-500": "#ef4444" } },
    doc: makeFakeDoc(),
    theme,
  };
}

// A widget row's <select> is root._children[i]._children[1]; its <option>
// children (skipping the leading "clear" option) hold the active token list.
function sizeLikeTokensFromTypography(ctx) {
  const instance = ns.controls.typography.create(ctx);
  const rows = instance.root._children; // one .te-ctl-row div per GROUPS entry
  const byLabel = {};
  const labels = ["Size", "Weight", "Align", "Leading", "Tracking"];
  rows.forEach((row, i) => {
    const select = row._children[1];
    byLabel[labels[i]] = select._children.slice(1).map((opt) => opt.value);
  });
  return byLabel;
}

// Swatch buttons are nested one level inside each family's ".te-ctl-swatches"
// row div, not direct children of the grid — walk the whole rendered tree
// rather than assuming a flat shape, so this doesn't silently stop testing
// anything if color.js's markup nesting ever changes.
function collectSwatches(el, results) {
  if (el.style && el.style.background) results.push({ token: el.title, hex: el.style.background });
  for (const child of el._children || []) collectSwatches(child, results);
}
function swatchTokensFromColor(ctx) {
  const instance = ns.controls.color.create(ctx);
  const results = [];
  collectSwatches(instance.root, results);
  return results;
}

// ── 1. All anchors present → every family live, values from the stub ────
const STUB_FULL_V4 = {
  "--color-blue-500": "lab(54.1736% 13.3369 -74.6839)",
  "--color-red-500": "lab(56.87% 78.44 34.6)",
  "--text-lg": "1.125rem",
  "--text-sm": ".875rem",
  "--text-8xl--line-height": "1", // companion — must be filtered out
  "--text-shadow-xs": "0px 1px 1px #0003", // unrelated family — must be filtered out
  "--font-weight-bold": "700",
  "--font-weight-normal": "400",
  "--radius-lg": ".5rem",
  "--radius-sm": ".25rem",
  "--breakpoint-md": "48rem",
  "--breakpoint-sm": "40rem",
  "--leading-normal": "1.5",
  "--leading-tight": "1.25",
  "--tracking-wide": ".025em",
  "--tracking-tight": "-.025em",
  "--spacing": ".25rem",
};

check("all anchors present: every family reports live, values taken from the stub", () => {
  currentStyles = makeStyles(STUB_FULL_V4);
  const theme = ns.createTheme();
  const stats = theme.stats();
  assert.deepEqual(
    stats.liveFamilies.slice().sort(),
    ["breakpoint", "color", "fontWeight", "leading", "radius", "spacing", "text", "tracking"].sort(),
    `expected all 8 families (including spacing's base unit) live, got: ${stats.liveFamilies.join(", ")}`,
  );
  assert.deepEqual(stats.bundledFamilies, []);

  const color = theme.family("color");
  assert.equal(color.live, true);
  assert.deepEqual(color.values, { "blue-500": STUB_FULL_V4["--color-blue-500"], "red-500": STUB_FULL_V4["--color-red-500"] });
  assert.equal(color.source, "page");

  const text = theme.family("text");
  assert.deepEqual(text.values, { lg: "1.125rem", sm: ".875rem" }, "text values must exclude line-height companions and --text-shadow-*");

  const fontWeight = theme.family("fontWeight");
  assert.deepEqual(fontWeight.values, { bold: "700", normal: "400" });

  const radius = theme.family("radius");
  assert.deepEqual(radius.values, { lg: ".5rem", sm: ".25rem" });

  const breakpoint = theme.family("breakpoint");
  assert.deepEqual(breakpoint.values, { md: 768, sm: 640 }, "48rem/40rem must resolve to px using the 16px root font size");

  const leading = theme.family("leading");
  assert.deepEqual(leading.values, { normal: "1.5", tight: "1.25" });

  const tracking = theme.family("tracking");
  assert.deepEqual(tracking.values, { wide: ".025em", tight: "-.025em" });

  const spacing = theme.family("spacing");
  assert.equal(spacing.live, true);
  assert.equal(spacing.base, ".25rem");
  assert.equal(spacing.source, "page");
});

// ── 2. No anchors → every family bundled, byte-identical to today's consts ─
const STUB_NONE = {};

check("no anchors: every family bundled, resolver returns no live overrides", () => {
  currentStyles = makeStyles(STUB_NONE);
  const theme = ns.createTheme();
  const stats = theme.stats();
  assert.deepEqual(stats.liveFamilies, []);
  assert.deepEqual(
    stats.bundledFamilies.slice().sort(),
    ["breakpoint", "color", "fontWeight", "leading", "radius", "spacing", "text", "tracking"].sort(),
  );
  for (const name of ["color", "text", "fontWeight", "radius", "breakpoint", "leading", "tracking"]) {
    const fam = theme.family(name);
    assert.equal(fam.live, false, `${name} must not be live`);
    assert.equal(fam.values, null, `${name} must carry no live values so its consumer's own bundled constant is used untouched`);
    assert.equal(fam.source, "bundled");
  }
  const spacing = theme.family("spacing");
  assert.equal(spacing.live, false);
  assert.equal(spacing.base, "0.25rem", "bundled spacing base must be Tailwind's own public default, byte-identical every run");
  assert.equal(spacing.source, "bundled");
});

check("no anchors: typography widget renders exactly today's bundled token lists", () => {
  currentStyles = makeStyles(STUB_NONE);
  const theme = ns.createTheme();
  const ctx = buildCtx(theme);
  const tokens = sizeLikeTokensFromTypography(ctx);
  assert.deepEqual(tokens.Size, GROUND_TRUTH_SIZE_TOKENS);
  assert.deepEqual(tokens.Weight, GROUND_TRUTH_WEIGHT_TOKENS);
  assert.deepEqual(tokens.Leading, GROUND_TRUTH_LEADING_TOKENS);
  assert.deepEqual(tokens.Tracking, GROUND_TRUTH_TRACKING_TOKENS);
});

check("no anchors: color widget renders exactly ctx.data.colors, untouched", () => {
  currentStyles = makeStyles(STUB_NONE);
  const theme = ns.createTheme();
  const ctx = buildCtx(theme);
  const swatches = swatchTokensFromColor(ctx);
  const tokens = swatches.map((s) => s.token).sort();
  assert.deepEqual(tokens, ["blue-500", "red-500"], "must be exactly the fixture passed as ctx.data.colors, nothing from the (unresolved) theme");
});

// ── 3. Primer-like (GitHub) stub → every family bundled — THE false-positive
// case. All seven prefix families are present with real-looking values, but
// NONE of the seven canonical anchor names resolve. A gate weaker than
// "does THIS family's own anchor resolve" (e.g. "does any --color-* exist")
// would misreport color/text/breakpoint as live here.
const STUB_PRIMER = {
  "--color-prettylights-syntax-meta-diff-range": "#d2a8ff",
  "--color-ansi-yellow-bright": "#e3b341",
  "--breakpoint-xlarge": "80rem",
  "--breakpoint-medium": "48rem",
  "--text-body-size-medium": ".875rem",
  "--text-title-size-large": "2rem",
  "--font-size-small": ".75rem",
};

check("Primer-like stub (GitHub false-positive case): every family bundled, none misattributed", () => {
  currentStyles = makeStyles(STUB_PRIMER);
  const theme = ns.createTheme();
  const stats = theme.stats();
  assert.deepEqual(stats.liveFamilies, [], `expected NO live families on a Primer-like page, got: ${stats.liveFamilies.join(", ")}`);
  for (const name of ["color", "text", "fontWeight", "radius", "breakpoint", "leading", "tracking", "spacing"]) {
    assert.equal(theme.family(name).live, false, `${name} must not be live on a Primer-like page — prefix presence is not evidence`);
  }
});

check("Primer-like stub: color/typography widgets fall back to bundled data untouched", () => {
  currentStyles = makeStyles(STUB_PRIMER);
  const theme = ns.createTheme();
  const ctx = buildCtx(theme);
  const tokens = sizeLikeTokensFromTypography(ctx);
  assert.deepEqual(tokens.Size, GROUND_TRUTH_SIZE_TOKENS);
  const swatches = swatchTokensFromColor(ctx).map((s) => s.token).sort();
  assert.deepEqual(swatches, ["blue-500", "red-500"]);
});

// ── 4. Mixed — color's own anchor present, radius's own anchor absent ────
const STUB_MIXED = {
  "--color-blue-500": "lab(54.1736% 13.3369 -74.6839)",
};

check("mixed stub: color live, radius (and every other family) bundled — per-family independence", () => {
  currentStyles = makeStyles(STUB_MIXED);
  const theme = ns.createTheme();
  assert.equal(theme.family("color").live, true);
  for (const name of ["text", "fontWeight", "radius", "breakpoint", "leading", "tracking", "spacing"]) {
    assert.equal(theme.family(name).live, false, `${name} must stay bundled even though color is live`);
  }
});

// ── 5. family("spacing") never returns a step list ───────────────────────
check('family("spacing") never returns a step list, in either live or bundled mode', () => {
  currentStyles = makeStyles(STUB_FULL_V4);
  const liveSpacing = ns.createTheme().family("spacing");
  assert.equal(Object.prototype.hasOwnProperty.call(liveSpacing, "values"), false, "live spacing must not carry a values map");
  assert.equal(typeof liveSpacing.base, "string");
  assert.equal(Array.isArray(liveSpacing.base), false);

  currentStyles = makeStyles(STUB_NONE);
  const bundledSpacing = ns.createTheme().family("spacing");
  assert.equal(Object.prototype.hasOwnProperty.call(bundledSpacing, "values"), false, "bundled spacing must not carry a values map either");
  assert.equal(Array.isArray(bundledSpacing.base), false);
});

check("synthesizeSpacing() labels its output synthesized, never claims it was read from the page", () => {
  currentStyles = makeStyles(STUB_FULL_V4);
  const theme = ns.createTheme();
  const step = theme.synthesizeSpacing(4);
  assert.equal(step.synthesized, true);
  assert.equal(step.value, "calc(.25rem * 4)");
});

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("all assertions passed");
process.exit(0);
