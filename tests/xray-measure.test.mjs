import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
loadClassic("chrome-extension/xray/measure.js", sandbox);
const m = sandbox.__piXray.measure;

const j = (x) => JSON.parse(JSON.stringify(x));
const R = (left, top, width, height) => ({ left, top, width, height });
const SIDES = (t, r = t, b = t, l = r) => ({ top: t, right: r, bottom: b, left: l });
const rec = (id, rect, extra = {}) => ({
  id, tag: "div", rect, display: "block", position: "static", opacity: 1, overflow: "visible",
  padding: SIDES(0), border: SIDES(0), radius: [0, 0, 0, 0], fill: null, children: [], ...extra,
});

test("frame snap: corners move to the nearest grid line from the root origin", () => {
  const f = m.snapFrame(R(13, 21, 50, 30), R(10, 20, 500, 500), 4, 1);
  assert.deepEqual(j(f), R(14, 20, 48, 32));
});

test("frame snap: a scale of 2 doubles the step", () => {
  const f = m.snapFrame(R(13, 21, 50, 30), R(10, 20, 500, 500), 4, 2);
  assert.deepEqual(j(f), R(10, 20, 56, 32));
});

test("root: the innermost box that holds the frame wins; a crossing frame picks the parent", () => {
  const frame = R(20, 20, 40, 40);
  const inner = R(10, 10, 100, 100);
  const outer = R(0, 0, 400, 400);
  assert.equal(m.chooseRoot(frame, [inner, outer]), 0);
  const left = R(10, 10, 50, 100);
  const sibling = R(60, 10, 100, 100);
  assert.equal(m.chooseRoot(R(40, 20, 40, 40), [left, outer]), 1);
  assert.equal(m.chooseRoot(R(40, 20, 40, 40), [sibling, outer]), 1);
  assert.equal(m.chooseRoot(R(500, 500, 10, 10), [inner, outer]), -1);
});

test("gap: horizontal in a flex row, vertical in a block parent", () => {
  const a = rec("a", R(0, 0, 40, 40));
  const b = rec("b", R(52, 0, 40, 40));
  const row = rec("p", R(0, 0, 100, 40), { display: "flex", children: [a, b] });
  const g = m.gapsOf(row, 1, 4);
  assert.equal(g.length, 1);
  assert.equal(g[0].axis, "x");
  assert.equal(g[0].value, 12);
  assert.deepEqual(j(g[0].geometry), R(40, 0, 12, 40));
  const c = rec("c", R(0, 0, 40, 20));
  const d = rec("d", R(0, 36, 40, 20));
  const col = rec("q", R(0, 0, 40, 60), { children: [c, d] });
  const g2 = m.gapsOf(col, 1, 4);
  assert.equal(g2[0].axis, "y");
  assert.equal(g2[0].value, 16);
});

test("gap: none for space-between, space-around, space-evenly", () => {
  ["space-between", "space-around", "space-evenly"].forEach((j) => {
    const row = rec("p", R(0, 0, 200, 40), {
      display: "flex", justifyContent: j,
      children: [rec("a", R(0, 0, 40, 40)), rec("b", R(160, 0, 40, 40))],
    });
    assert.equal(m.gapsOf(row, 1, 4).length, 0, j);
  });
});

test("gap: none for absolute or fixed children, none under 0.5 px", () => {
  const abs = rec("p", R(0, 0, 100, 100), {
    children: [rec("a", R(0, 0, 40, 20)), rec("b", R(0, 40, 40, 20), { position: "absolute" })],
  });
  assert.equal(m.gapsOf(abs, 1, 4).length, 0);
  const fix = rec("p", R(0, 0, 100, 100), {
    children: [rec("a", R(0, 0, 40, 20)), rec("b", R(0, 40, 40, 20), { position: "fixed" })],
  });
  assert.equal(m.gapsOf(fix, 1, 4).length, 0);
  const tiny = rec("p", R(0, 0, 100, 100), {
    children: [rec("a", R(0, 0, 40, 20)), rec("b", R(0, 20.4, 40, 20))],
  });
  assert.equal(m.gapsOf(tiny, 1, 4).length, 0);
});

test("padding: four sides and the content box; a zero side gives no spec", () => {
  const e = rec("e", R(0, 0, 100, 60), { padding: SIDES(8, 16, 8, 16) });
  const specs = m.paddingsOf(e, 1, 4);
  assert.equal(specs.filter((s) => s.kind === "padding").length, 4);
  const content = specs.find((s) => s.kind === "content");
  assert.deepEqual(j(content.geometry), R(16, 8, 68, 44));
  const one = m.paddingsOf(rec("e", R(0, 0, 100, 60), { padding: SIDES(0, 0, 0, 12) }), 1, 4);
  assert.deepEqual(j(one.filter((s) => s.kind === "padding").map((s) => s.side)), ["left"]);
});

test("classification: button, card with bordered child, img, child of a block", () => {
  const button = rec("btn", R(0, 0, 80, 40), { tag: "button", fill: "#08f", hasOwnText: true });
  assert.equal(m.isBlock(button, 1), true);
  const inner = rec("in", R(4, 4, 40, 40), { border: SIDES(1) });
  const card = rec("card", R(0, 0, 200, 200), { fill: "#fff", hasOwnText: true, children: [inner] });
  assert.equal(m.isBlock(card, 1), false);
  assert.equal(m.isBlock(rec("i", R(0, 0, 10, 10), { tag: "img" }), 1), true);
  const kid = rec("kid", R(2, 2, 20, 20), { fill: "#f00" });
  const blockWithKid = rec("b", R(0, 0, 80, 40), { tag: "svg", children: [kid] });
  const tree = rec("root", R(0, 0, 200, 200), { children: [blockWithKid] });
  const out = m.measure({ frame: R(0, 0, 200, 200), root: tree, step: 4, scale: 1 });
  assert.ok(out.blocks.includes("b"));
  assert.ok(!out.items.some((i) => i.id === "kid"));
});

test("radius: concentric pair preferred; circle and pill give none; 50% resolves on width", () => {
  const outer = rec("o", R(0, 0, 200, 100), { fill: "#fff", radius: [12, 12, 12, 12] });
  const inner = rec("i", R(4, 4, 80, 32), { fill: "#08f", radius: [8, 8, 8, 8] });
  const specs = m.radiiOf([{ rec: outer }, { rec: inner }], 1);
  assert.equal(specs.length, 2);
  assert.ok(specs.every((s) => s.concentric));
  assert.equal(specs.find((s) => s.id === "o").corner, "tl");
  const circle = rec("c", R(0, 0, 40, 40), { radius: [20, 20, 20, 20] });
  const pill = rec("p", R(0, 0, 100, 40), { radius: [999, 999, 999, 999] });
  assert.equal(m.radiiOf([{ rec: circle }, { rec: pill }], 1).length, 0);
  assert.equal(m.parseRadius("50%", 80), 40);
  assert.equal(m.parseRadius("8px", 80), 8);
  const pct = rec("q", R(0, 0, 80, 200), { radius: ["10%", 0, 0, 0] });
  assert.equal(m.radiiOf([{ rec: pct }], 1)[0].value, 8);
});

test("off-grid: 16 is on the grid, 15 is not, 15.6 is on the grid", () => {
  assert.equal(m.isOnGrid(16, 4), true);
  assert.equal(m.isOnGrid(15, 4), false);
  assert.equal(m.isOnGrid(15.6, 4), true);
});

test("scale: 200 screen px at scale 2 is 100 CSS px", () => {
  assert.equal(m.toCss(200, 2), 100);
  assert.equal(m.scaleOf(200, 100), 2);
  const tree = rec("root", R(0, 0, 200, 200));
  const out = m.measure({ frame: R(0, 0, 200, 200), root: tree, step: 4, scale: 2 });
  const size = out.specs.find((s) => s.kind === "size");
  assert.deepEqual(j(size.value), { w: 100, h: 100 });
});

test("output holds no DOM node and no function", () => {
  const tree = rec("root", R(0, 0, 300, 200), {
    display: "flex", padding: SIDES(16), radius: [12, 12, 12, 12], fill: "#fff",
    children: [
      rec("a", R(16, 16, 80, 32), { tag: "button", fill: "#08f", radius: [8, 8, 8, 8], hasOwnText: true }),
      rec("b", R(108, 16, 80, 32), { tag: "button", fill: "#08f", hasOwnText: true }),
    ],
  });
  const out = m.measure({ frame: R(0, 0, 300, 200), root: tree, step: 4, scale: 1 });
  assert.deepEqual(j(out), j(JSON.parse(JSON.stringify(out))));
  assert.equal(JSON.stringify(out).includes("undefined"), false);
});

test("fixture layout: the numbers of tests/fixtures/xray/card.html", () => {
  // Card: 320 x 120 at (0,0), padding 16, radius 12, flex row, gap 12.
  const left = rec("left", R(16, 16, 120, 32), { tag: "button", fill: "#08f", radius: [8, 8, 8, 8], hasOwnText: true });
  const right = rec("right", R(148, 16, 120, 32), { tag: "button", fill: "#08f", hasOwnText: true });
  const card = rec("card", R(0, 0, 320, 120), {
    display: "flex", fill: "#fff", radius: [12, 12, 12, 12], padding: SIDES(16), children: [left, right],
  });
  const odd = rec("odd", R(0, 140, 200, 40), { border: SIDES(1), padding: SIDES(15), hasOwnText: true });
  const spread = rec("spread", R(0, 200, 320, 32), {
    display: "flex", justifyContent: "space-between",
    children: [rec("s1", R(0, 200, 40, 32), { fill: "#ccc" }), rec("s2", R(280, 200, 40, 32), { fill: "#ccc" })],
  });
  const page = rec("page", R(0, 0, 320, 240), { children: [card, odd, spread] });
  const out = m.measure({ frame: R(0, 0, 320, 240), root: page, step: 4, scale: 1 });
  const gaps = out.specs.filter((s) => s.kind === "gap" && s.id === "card");
  assert.deepEqual(j(gaps.map((g) => g.value)), [12]);
  assert.equal(out.specs.filter((s) => s.kind === "gap" && s.id === "spread").length, 0);
  const cardPads = out.specs.filter((s) => s.kind === "padding" && s.id === "card");
  assert.deepEqual(j(cardPads.map((p) => p.value)), [16, 16, 16, 16]);
  assert.ok(cardPads.every((p) => !p.offGrid));
  const oddPads = out.specs.filter((s) => s.kind === "padding" && s.id === "odd");
  assert.deepEqual(j(oddPads.map((p) => p.value)), [15, 15, 15, 15]);
  assert.ok(oddPads.every((p) => p.offGrid));
  const btn = out.specs.find((s) => s.kind === "size" && s.id === "left");
  assert.deepEqual(j(btn.value), { w: 120, h: 32 });
  const radii = out.specs.filter((s) => s.kind === "radius");
  assert.ok(radii.find((r) => r.id === "card" && r.value === 12));
  assert.ok(radii.find((r) => r.id === "left" && r.value === 8 && r.concentric === false));
});
