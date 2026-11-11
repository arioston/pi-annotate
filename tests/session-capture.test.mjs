import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
loadClassic("chrome-extension/lib/capture-plan.js", sandbox);
const P = sandbox.PiCapturePlan;
const j = (x) => JSON.parse(JSON.stringify(x));

const VIEW = { width: 1000, height: 800, scrollX: 0, scrollY: 0 };
const R = (left, top, width, height) => ({ left, top, width, height });

test("needs page capture: an element inside the viewport does not", () => {
  assert.equal(P.needsPageCapture(VIEW, [R(10, 10, 200, 100)]), false);
  assert.equal(P.needsPageCapture(VIEW, []), false);
});

test("needs page capture: an element below the fold does", () => {
  assert.equal(P.needsPageCapture(VIEW, [R(10, 900, 200, 100)]), true);
});

test("needs page capture: an element taller than the viewport does", () => {
  assert.equal(P.needsPageCapture(VIEW, [R(10, 0, 200, 1500)]), true);
});

test("needs page capture: the scroll position moves the viewport in page px", () => {
  const scrolled = { ...VIEW, scrollY: 1000 };
  assert.equal(P.needsPageCapture(scrolled, [R(10, 1100, 200, 100)]), false);
  assert.equal(P.needsPageCapture(scrolled, [R(10, 900, 200, 100)]), true);
});

test("crop rectangle: padding added, clamped at the page edge", () => {
  const img = { width: 1000, height: 3000 };
  assert.deepEqual(j(P.cropRect(R(100, 200, 300, 400), 20, 1, img)), { x: 80, y: 180, w: 340, h: 440 });
  assert.deepEqual(j(P.cropRect(R(5, 5, 100, 100), 20, 1, img)), { x: 0, y: 0, w: 125, h: 125 });
  assert.deepEqual(j(P.cropRect(R(900, 2900, 100, 100), 20, 1, img)), { x: 880, y: 2880, w: 120, h: 120 });
});

test("crop rectangle: device pixel ratio 2", () => {
  const img = { width: 2000, height: 6000 };
  assert.deepEqual(j(P.cropRect(R(100, 200, 300, 400), 20, 2, img)), { x: 160, y: 360, w: 680, h: 880 });
});

test("crop rectangle: a whole tall element keeps its full height", () => {
  const img = { width: 1000, height: 5000 };
  const c = P.cropRect(R(0, 100, 1000, 3000), 20, 1, img);
  assert.equal(c.h, 3040);
  assert.equal(P.cropRect(R(5000, 5000, 10, 10), 20, 1, img), null);
});

test("reduce plan: keep, then jpeg for a PNG, then scale for a JPEG", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(j(P.reducePlan(5 * MB, 12 * MB, "png")), { action: "keep" });
  assert.deepEqual(j(P.reducePlan(20 * MB, 12 * MB, "png")), { action: "jpeg" });
  assert.deepEqual(j(P.reducePlan(20 * MB, 12 * MB, "jpeg")), { action: "scale", factor: 0.75 });
  assert.deepEqual(j(P.reducePlan(13 * MB, undefined, "jpeg")), { action: "scale", factor: 0.75 });
});
