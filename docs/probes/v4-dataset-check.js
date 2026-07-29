/**
 * Pi Annotate — v4 bundled-dataset regression check (plan 422)
 *
 * NODE SCRIPT, not a console-paste probe. Loads tw-spacing.js,
 * tw-default-classes.js, tw-v4-data.js, tw-theme.js and suggest.js verbatim
 * under `global.window` / `global.document` / `global.getComputedStyle` stubs
 * and asserts that:
 *
 *   1. the two bundled datasets are each internally well-formed, and
 *   2. the version verdict that SELECTS between them cannot be tripped by a
 *      non-Tailwind page.
 *
 * (2) is the one that matters. Plan 421's resolver already had to survive the
 * GitHub/Primer false positive for a single family; here a wrong verdict swaps
 * the entire class vocabulary and the whole palette, so the same Primer stub is
 * re-used verbatim as the anchor case. If this file ever passes while
 * theme-resolver-check.js fails, distrust this file.
 *
 * Run: node docs/probes/v4-dataset-check.js
 * Exit code 0 = all assertions passed. Non-zero = at least one failed.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, "chrome-extension/tailedit", rel), "utf8");

// ── :root custom-property stub (same shape as theme-resolver-check.js) ──
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

let currentStyles = makeStyles({});
global.window = {};
global.document = {
  documentElement: {},
  // suggest.js's CSSOM scan walks styleSheets; an empty list keeps this check
  // focused on the BUNDLED half, which is the only half a dataset can affect.
  styleSheets: [],
};
global.getComputedStyle = () => currentStyles;
global.requestIdleCallback = undefined;
global.setTimeout = setTimeout;
global.performance = { now: () => 0 };

for (const f of ["tw-spacing.js", "tw-default-classes.js", "tw-v4-data.js", "tw-theme.js", "suggest.js"]) {
  // eslint-disable-next-line no-eval
  eval(read(f));
}

const ns = global.window.__piTailedit;
assert.ok(ns && ns.data, "tw-default-classes.js did not register ns.data");
assert.ok(ns.dataV4, "tw-v4-data.js did not register ns.dataV4");
assert.ok(typeof ns.createTheme === "function", "tw-theme.js did not register ns.createTheme");
assert.ok(typeof ns.createSuggestionIndex === "function", "suggest.js did not register ns.createSuggestionIndex");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`NOT OK - ${name}`);
    console.error(`  ${err.message}`);
    if (err.actual !== undefined) console.error(`  actual:   ${JSON.stringify(err.actual)}`);
    if (err.expected !== undefined) console.error(`  expected: ${JSON.stringify(err.expected)}`);
  }
}

function familiesOf(colors) {
  return new Set(
    Object.keys(colors).map((k) => (k.includes("-") ? k.slice(0, k.lastIndexOf("-")) : k)),
  );
}

// ── 1. The two palettes ─────────────────────────────────────────────────
// Counts INCLUDE the standalone black/white keys, which controls/color.js
// treats as one-shade families of their own.

check("v4 palette: 288 keys / 28 groups, every shaded value oklch()", () => {
  const colors = ns.dataV4.colors;
  // 288 is theme.css's own `--color-*` count, and it already includes the
  // standalone black/white entries — so 286 shaded + 2.
  assert.equal(Object.keys(colors).length, 288);
  assert.equal(familiesOf(colors).size, 28, "26 shaded families + black + white");
  const shaded = Object.entries(colors).filter(([k]) => k.includes("-"));
  assert.equal(shaded.length, 286);
  const nonOklch = shaded.filter(([, v]) => !v.startsWith("oklch("));
  assert.deepEqual(nonOklch, [], "every shaded v4 value is verbatim oklch() from theme.css");
  assert.equal(colors.black, "#000");
  assert.equal(colors.white, "#fff");
});

check("v4 palette: the four families v4.3 added are present, with full 50-950 ramps", () => {
  const colors = ns.dataV4.colors;
  for (const family of ["mauve", "mist", "olive", "taupe"]) {
    const shades = Object.keys(colors).filter((k) => k.startsWith(family + "-"));
    assert.equal(shades.length, 11, `${family} should have 11 shades, got ${shades.length}`);
  }
});

check("v3 palette untouched by this plan: 244 keys / 24 groups, every value hex", () => {
  const colors = ns.data.colors;
  assert.equal(Object.keys(colors).length, 244);
  assert.equal(familiesOf(colors).size, 24);
  assert.ok(Object.values(colors).every((v) => v.startsWith("#")), "v3 values stay sRGB hex");
  for (const family of ["mauve", "mist", "olive", "taupe"]) {
    assert.ok(
      !Object.keys(colors).some((k) => k.startsWith(family + "-")),
      `${family} is v4-only and must not leak into the v3 palette`,
    );
  }
});

check("key format parity: both palettes group into well-formed family rows", () => {
  for (const [label, colors] of [["v3", ns.data.colors], ["v4", ns.dataV4.colors]]) {
    for (const key of Object.keys(colors)) {
      assert.ok(/^[a-z]+(-(?:50|[1-9]50|[1-9]00))?$/.test(key), `${label} key "${key}" is not family[-shade]`);
      assert.ok(typeof colors[key] === "string" && colors[key].length > 0, `${label} key "${key}" has no value`);
    }
  }
});

// ── 2. The rename traps ─────────────────────────────────────────────────
// v4 renamed the radius / shadow / blur scales rather than only extending
// them, so these names must exist in exactly one dataset.

const V4_ONLY_NAMES = [
  "rounded-xs", "rounded-4xl", "shadow-2xs", "shadow-xs",
  "inset-shadow-sm", "text-shadow-md", "blur-xs", "max-w-3xs", "max-w-2xs",
  "perspective-normal", "outline-hidden",
];

check("v4 utilities carry the v4-only names; v3 utilities carry none of them", () => {
  const v4 = new Set(ns.dataV4.utilities);
  const v3 = new Set(ns.data.utilities);
  for (const name of V4_ONLY_NAMES) {
    assert.ok(v4.has(name), `v4 dataset is missing ${name}`);
    assert.ok(!v3.has(name), `${name} leaked into the v3 dataset`);
  }
});

check("v4 utilities are a superset of v3's — the compat tail keeps every v3 name legal", () => {
  const v4 = new Set(ns.dataV4.utilities);
  const missing = ns.data.utilities.filter((u) => !v4.has(u));
  assert.deepEqual(missing, [], "v4 dropped a v3 utility name");
  // The bare aliases the v3 list actually carries. `blur` is not in either
  // list — v3's hand-written surface never included it — so it is not a
  // compat-tail case to assert here.
  for (const name of ["rounded", "shadow", "shadow-inner"]) {
    assert.ok(v4.has(name), `${name} survives in v4 via theme.css's deprecated-compat tail`);
  }
});

check("the shared spacing cross-product is single-sourced, not re-typed", () => {
  // plan 420's invariant: one SCALE feeds both datasets. If tw-v4-data.js ever
  // grows its own copy, a new step added to ns.spacing.SCALE would appear in
  // only one of them.
  const v3 = new Set(ns.data.utilities);
  const v4 = new Set(ns.dataV4.utilities);
  for (const step of ns.spacing.SCALE) {
    assert.ok(v3.has(`p-${step}`), `v3 missing p-${step}`);
    assert.ok(v4.has(`p-${step}`), `v4 missing p-${step}`);
  }
});

// ── 3. Version detection — the selector ─────────────────────────────────

const STUB_V4 = {
  "--color-blue-500": "oklch(62.3% 0.214 259.815)",
  "--text-lg": "1.125rem",
  "--radius-lg": "0.5rem",
  "--spacing": "0.25rem",
};

// Verbatim from theme-resolver-check.js (plan 421) — the GitHub/Primer case.
const STUB_PRIMER = {
  "--color-prettylights-syntax-meta-diff-range": "#d2a8ff",
  "--color-ansi-yellow-bright": "#e3b341",
  "--breakpoint-xlarge": "80rem",
  "--breakpoint-medium": "48rem",
  "--text-body-size-medium": ".875rem",
  "--text-title-size-large": "2rem",
  "--font-size-small": ".75rem",
};

check("version() is v4 when canonical anchors resolve", () => {
  currentStyles = makeStyles(STUB_V4);
  assert.equal(ns.createTheme().version(), "v4");
});

check("version() is unknown on a bare page — no anchors, no verdict", () => {
  currentStyles = makeStyles({});
  assert.equal(ns.createTheme().version(), "unknown");
});

check("version() is unknown on the Primer-like stub — THE false-positive case", () => {
  currentStyles = makeStyles(STUB_PRIMER);
  assert.equal(
    ns.createTheme().version(),
    "unknown",
    "a Primer page must not select the v4 dataset: prefix presence is not evidence",
  );
});

check("spacing.basePx is resolved inside the single reader, in px", () => {
  currentStyles = makeStyles({ "--spacing": "0.25rem" });
  assert.equal(ns.createTheme().family("spacing").basePx, 4);
  currentStyles = makeStyles({}, "20px");
  // No --spacing: falls back to the bundled 0.25rem base, resolved against
  // THIS page's root font size rather than a hard-coded 16.
  assert.equal(ns.createTheme().family("spacing").basePx, 5);
});

// ── 4. The wrong-answer bug this plan exists to fix ─────────────────────

// explain() returns { css, source } (or "" when it has nothing to say).
const cssOf = (idx, cls) => {
  const out = idx.explain(cls);
  return out && out.css ? out.css : "";
};

check("explain(rounded-sm): 0.25rem under v4, 0.125rem under unknown", () => {
  const v4 = ns.createSuggestionIndex();
  v4.configure({ data: ns.dataV4, version: "v4" });
  assert.equal(cssOf(v4, "rounded-sm"), "border-radius: 0.25rem");
  assert.equal(cssOf(v4, "rounded-xs"), "border-radius: 0.125rem");
  assert.equal(cssOf(v4, "rounded-4xl"), "border-radius: 2rem");
  assert.equal(cssOf(v4, "rounded-full"), "border-radius: calc(infinity * 1px)");

  const v3 = ns.createSuggestionIndex();
  v3.configure({ data: ns.data, version: "unknown" });
  assert.equal(cssOf(v3, "rounded-sm"), "border-radius: 0.125rem");
  assert.equal(cssOf(v3, "rounded-full"), "border-radius: 9999px");
  assert.equal(cssOf(v3, "rounded-xs"), "", "rounded-xs does not exist in v3");
});

check("the version-invariant explainer tables did NOT get duplicated", () => {
  const v4 = ns.createSuggestionIndex();
  v4.configure({ data: ns.dataV4, version: "v4" });
  const v3 = ns.createSuggestionIndex();
  v3.configure({ data: ns.data, version: "unknown" });
  for (const cls of ["text-lg", "text-9xl", "font-bold", "font-thin", "p-4", "m-96"]) {
    assert.equal(cssOf(v4, cls), cssOf(v3, cls), `${cls} must explain identically in both majors`);
  }
});

check("configure() is inert after the index is built", () => {
  const idx = ns.createSuggestionIndex();
  idx.configure({ data: ns.dataV4, version: "v4" });
  idx.ensureBuilt();
  idx.configure({ data: ns.data, version: "unknown" });
  assert.equal(cssOf(idx, "rounded-sm"), "border-radius: 0.25rem", "a post-build swap would mix two vocabularies");
});

check("the v4 index actually offers v4-only classes; the v3 index does not", () => {
  const v4 = ns.createSuggestionIndex();
  v4.configure({ data: ns.dataV4, version: "v4" });
  v4.ensureBuilt();
  const v3 = ns.createSuggestionIndex();
  v3.configure({ data: ns.data, version: "unknown" });
  v3.ensureBuilt();
  const has = (idx, cls) => idx.query(cls).some((h) => h.className === cls);
  for (const cls of ["rounded-4xl", "text-shadow-md", "shadow-2xs"]) {
    assert.ok(has(v4, cls), `v4 index should offer ${cls}`);
    assert.ok(!has(v3, cls), `v3 index should not offer ${cls}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
