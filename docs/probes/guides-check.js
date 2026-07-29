/**
 * Pi Annotate — guidelines / measuring-lines regression check (plan 423)
 *
 * NODE SCRIPT, not a console-paste probe. Loads guides.js verbatim under a
 * `global.window` stub and drives the two pure functions — `measure()` and
 * `annotate()` — with fabricated rects. No browser, no DOM, no rendering: the
 * factory half of guides.js is exercised by the operator smoke, the geometry
 * half is exercised here, and the geometry half is where every edge case lives.
 *
 * Two assertions are load-bearing rather than merely thorough:
 *
 *   - "overlapping, neither contained" must emit NO distances. A negative gap
 *     is not a measurement; drawing one would confidently show a wrong number.
 *   - "no class names anywhere in the output" is the honesty rule (plans 416 /
 *     420 / 421) as a test. A distance between two elements has no provable
 *     responsible class, so the tool must never print one.
 *
 * Identical rects: this file asserts the deliberate choice — six alignment
 * guides and ZERO distances. Two elements occupying the same box are contained
 * in each other, and every inset is 0, which the renderer drops. Alignment is
 * the whole of the useful answer.
 *
 * Run: node docs/probes/guides-check.js
 * Exit code 0 = all assertions passed. Non-zero = at least one failed.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const src = fs.readFileSync(path.join(root, "chrome-extension/tailedit/guides.js"), "utf8");

global.window = {};
// eslint-disable-next-line no-eval
eval(src);

const ns = global.window.__piTailedit;
assert.ok(ns && ns.guides, "guides.js did not register ns.guides");
assert.ok(typeof ns.guides.measure === "function", "ns.guides.measure missing");
assert.ok(typeof ns.guides.annotate === "function", "ns.guides.annotate missing");
assert.ok(typeof ns.createGuides === "function", "ns.createGuides missing");

const { measure, annotate } = ns.guides;

let failures = 0;
const captured = []; // every result, for the class-name sweep at the end
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

const rect = (left, top, width, height) => ({ left, top, width, height });
function run(a, b, opts) {
  const result = measure(a, b, opts);
  captured.push(result);
  return result;
}
const axis = (result, which) => result.distances.filter((d) => d.axis === which);

// ── 1. Apart ────────────────────────────────────────────────────────────

check("side by side, 20px apart: one x distance, no y distance", () => {
  const r = run(rect(0, 0, 100, 50), rect(120, 0, 100, 50));
  assert.equal(r.relation, "apart");
  assert.equal(axis(r, "x").length, 1);
  assert.equal(axis(r, "x")[0].px, 20);
  assert.equal(axis(r, "x")[0].side, "right", "the probe is to the right of the anchor");
  assert.equal(axis(r, "y").length, 0, "the rects overlap vertically — no y gap exists");
});

check("probe to the LEFT: the gap is still positive and side flips", () => {
  const r = run(rect(120, 0, 100, 50), rect(0, 0, 100, 50));
  assert.equal(axis(r, "x")[0].px, 20);
  assert.equal(axis(r, "x")[0].side, "left");
});

check("stacked, 12px apart: one y distance, no x distance", () => {
  const r = run(rect(0, 0, 100, 50), rect(0, 62, 100, 50));
  assert.equal(r.relation, "apart");
  assert.equal(axis(r, "y").length, 1);
  assert.equal(axis(r, "y")[0].px, 12);
  assert.equal(axis(r, "y")[0].side, "bottom");
  assert.equal(axis(r, "x").length, 0);
});

check("diagonal: a distance on each axis", () => {
  const r = run(rect(0, 0, 100, 50), rect(150, 80, 40, 40));
  assert.equal(r.relation, "apart");
  assert.equal(axis(r, "x").length, 1);
  assert.equal(axis(r, "y").length, 1);
  assert.equal(axis(r, "x")[0].px, 50);
  assert.equal(axis(r, "y")[0].px, 30);
});

check("touching edges (zero gap) is still 'apart', and reports 0", () => {
  const r = run(rect(0, 0, 100, 50), rect(100, 0, 100, 50));
  assert.equal(r.relation, "apart");
  assert.equal(axis(r, "x")[0].px, 0, "the renderer drops a 0px connector; the geometry still reports it");
});

// ── 2. Overlapping — the do-not-invent-a-negative-gap case ──────────────

check("overlapping, neither contained: NO distances at all", () => {
  const r = run(rect(0, 0, 100, 100), rect(50, 50, 100, 100));
  assert.equal(r.relation, "overlapping");
  assert.deepEqual(r.distances, [], "a negative gap is not a measurement");
});

// ── 3. Containment ──────────────────────────────────────────────────────

check("probe nested inside anchor: four insets, asymmetric values correct", () => {
  const r = run(rect(0, 0, 200, 100), rect(10, 20, 150, 40));
  assert.equal(r.relation, "contained");
  assert.equal(r.distances.length, 4);
  const bySide = Object.fromEntries(r.distances.map((d) => [d.side, d.px]));
  assert.deepEqual(bySide, { left: 10, right: 40, top: 20, bottom: 40 });
});

check("anchor nested inside probe: relation flips, insets stay positive", () => {
  const r = run(rect(10, 20, 150, 40), rect(0, 0, 200, 100));
  assert.equal(r.relation, "contains");
  const bySide = Object.fromEntries(r.distances.map((d) => [d.side, d.px]));
  assert.deepEqual(bySide, { left: 10, right: 40, top: 20, bottom: 40 });
});

// ── 4. Alignment ────────────────────────────────────────────────────────

const kinds = (r) => r.aligned.map((g) => g.axis + ":" + g.kind).sort();

check("left edges within tolerance: one left guide, reported once", () => {
  const r = run(rect(0, 0, 100, 50), rect(0.4, 200, 60, 50));
  assert.ok(kinds(r).includes("x:left"));
  assert.equal(r.aligned.filter((g) => g.kind === "left").length, 1);
});

check("left edges 3px apart: no left guide", () => {
  const r = run(rect(0, 0, 100, 50), rect(3, 200, 60, 50));
  assert.ok(!kinds(r).includes("x:left"));
});

check("centre alignment is detected independently of edge alignment", () => {
  // Centres agree at x=50; edges do not (0..100 vs 25..75).
  const r = run(rect(0, 0, 100, 50), rect(25, 200, 50, 50));
  assert.ok(kinds(r).includes("x:center"));
  assert.ok(!kinds(r).includes("x:left"));
  assert.ok(!kinds(r).includes("x:right"));
});

check("tolerance is configurable and actually applied", () => {
  const a = rect(0, 0, 100, 50);
  const b = rect(3, 200, 100, 50);
  assert.ok(!kinds(measure(a, b)).includes("x:left"));
  assert.ok(kinds(measure(a, b, { tolerance: 4 })).includes("x:left"));
});

check("identical rects: six alignment guides, zero non-zero distances", () => {
  const r = run(rect(10, 10, 100, 100), rect(10, 10, 100, 100));
  assert.equal(kinds(r).length, 6, "left/right/centre on x, top/bottom/centre on y");
  assert.equal(r.distances.length, 4, "containment still emits four insets…");
  assert.ok(r.distances.every((d) => d.px === 0), "…and every one of them is 0, which the renderer drops");
});

// ── 5. The spacing annotation ───────────────────────────────────────────

check("annotate: exact multiples become steps", () => {
  assert.deepEqual(annotate(24, 4), { px: 24, steps: 6 });
  assert.deepEqual(annotate(4, 4), { px: 4, steps: 1 });
});

check("annotate: a non-multiple stays px-only rather than rounding to a lie", () => {
  assert.equal(annotate(25, 4).steps, null);
  assert.equal(annotate(23.2, 4).steps, null);
});

check("annotate: sub-half-pixel drift still counts as a multiple", () => {
  assert.equal(annotate(23.9, 4).steps, 6, "layout rounding must not suppress a real match");
});

check("annotate: no base, zero base, zero distance → no steps", () => {
  assert.equal(annotate(24, 0).steps, null);
  assert.equal(annotate(24, null).steps, null);
  assert.equal(annotate(24, undefined).steps, null);
  assert.equal(annotate(0, 4).steps, null);
});

check("annotate: the noise cap holds", () => {
  assert.equal(annotate(64 * 4, 4).steps, 64, "at the cap");
  assert.equal(annotate(65 * 4, 4).steps, null, "past the cap — '65 × spacing' is noise");
});

// ── 6. The honesty rule, as a test ──────────────────────────────────────

check("no class name appears anywhere in any measurement output", () => {
  assert.ok(captured.length >= 10, "the sweep is only meaningful over the cases above");
  const serialized = JSON.stringify(captured);
  const match = serialized.match(/\b(p|m|px|py|mx|my|gap|space)-\d/);
  assert.equal(match, null, `measurement output must never name a class, found: ${match && match[0]}`);
  // The renderer's annotation text is built from annotate(); prove that shape
  // carries no class either.
  const annotated = JSON.stringify([annotate(16, 4), annotate(24, 4), annotate(7, 4)]);
  assert.equal(annotated.match(/\b(p|m|gap|space)-\d/), null);
});

// ── 7. Source-level contracts ───────────────────────────────────────────

// Both contracts are about CODE, not prose — the header comment names both
// APIs while explaining why neither is used the way you'd expect, and a raw
// grep would flag that. Strip comments first, then assert.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("guides.js contains no getComputedStyle, in any form", () => {
  assert.equal(code.includes("getComputedStyle"), false, "the whole point is that there is no expensive tier here");
});

check("guides.js coalesces through exactly one requestAnimationFrame", () => {
  assert.equal((code.match(/requestAnimationFrame/g) || []).length, 1);
});

check("every .style write in guides.js targets a node this file created", () => {
  // node.el / el / label are all created by makeNode(); anchor and probe are
  // page elements and must never be written to.
  const writes = code.match(/[\w.]+\.style\.[\w]+\s*=/g) || [];
  assert.ok(writes.length > 0, "the renderer does write styles — this check is not vacuous");
  const illegal = writes.filter((w) => /\b(anchor|probe|target)\./.test(w));
  assert.deepEqual(illegal, [], "a page element was written to");
});

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
