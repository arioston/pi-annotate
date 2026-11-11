import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
loadClassic("chrome-extension/lib/capture-plan.js", sandbox);
const P = sandbox.PiCapturePlan;
const j = (x) => JSON.parse(JSON.stringify(x));

const VIEW = { left: 0, top: 0, width: 1000, height: 800 };

// Run the incremental loop on a page that reports its own positions.
function run({ content, view = VIEW, dpr = 1, report = (pos) => pos, contentAt = () => content, limits }) {
  const tiles = [];
  let covered = 0;
  let reason = null;
  for (let guard = 0; guard < 200; guard++) {
    const contentNow = contentAt(tiles.length);
    reason = P.stopReason(tiles.length, covered / dpr, contentNow, limits);
    if (reason) break;
    const pos = P.nextPosition(covered, view.height, contentNow, dpr);
    if (pos === null) break;
    const reported = report(pos, tiles.length);
    const tile = P.recordTile({ reported, visible: view, contentHeight: contentNow, dpr, covered });
    if (!tile) break;
    tiles.push(tile);
    covered = tile.covered;
  }
  return { tiles, covered, reason };
}

test("content shorter than the viewport: one tile, full height", () => {
  const { tiles } = run({ content: 500 });
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].src.h, 500);
  assert.equal(tiles[0].destY, 0);
});

test("content of exactly 3 viewports: 3 tiles, no overlap", () => {
  const { tiles } = run({ content: 2400 });
  assert.equal(tiles.length, 3);
  assert.deepEqual(j(tiles.map((t) => t.src.y)), [0, 0, 0]);
  assert.deepEqual(j(tiles.map((t) => t.destY)), [0, 800, 1600]);
  assert.deepEqual(j(tiles.map((t) => t.src.h)), [800, 800, 800]);
});

test("content of 2.5 viewports: the third tile is the bottom half of its picture", () => {
  const { tiles } = run({ content: 2000 });
  assert.equal(tiles.length, 3);
  assert.equal(tiles[2].src.h, 400);
  assert.equal(tiles[2].src.y, 400);
  assert.equal(tiles[2].destY, 1600);
  assert.equal(P.planPositions(2000, 800, 1).positions.length, 3);
  assert.deepEqual(j(P.planPositions(2000, 800, 1).positions), [0, 800, 1200]);
});

test("device pixel ratio 2: rectangles are in device px", () => {
  const { tiles, covered } = run({ content: 1600, dpr: 2 });
  assert.equal(covered, 3200);
  assert.equal(tiles[0].src.w, 2000);
  assert.equal(tiles[0].src.h, 1600);
  assert.equal(tiles.reduce((s, t) => s + t.src.h, 0), 3200);
});

test("the page reports another scroll position: the tile uses the reported one", () => {
  // Asked for 800, the page clamps to 600: the picture holds rows 600-1400.
  const { tiles } = run({ content: 1800, report: (pos) => Math.min(pos, 600) });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[1].destY, 800);
  assert.equal(tiles[1].src.y, 200);
  assert.equal(tiles[1].src.h, 600);
});

test("content grows during the capture: no gap and no repeated row", () => {
  const { tiles, covered } = run({ content: 0, contentAt: (n) => (n === 0 ? 1600 : 2500) });
  assert.equal(covered, 2500);
  let next = 0;
  for (const t of tiles) {
    assert.equal(t.destY, next);
    next += t.src.h;
  }
  assert.equal(next, 2500);
});

test("a step that adds no new row gives no tile", () => {
  const tile = P.recordTile({ reported: 0, visible: VIEW, contentHeight: 800, dpr: 1, covered: 800 });
  assert.equal(tile, null);
});

test("limits: 61 planned tiles stop with reason tiles; 70000 px stops with reason height", () => {
  const many = P.planPositions(61 * 900, 900, 1);
  assert.equal(many.positions.length, 60);
  assert.equal(many.partial, "tiles");
  const tall = P.planPositions(70000, 1200, 1);
  assert.equal(tall.partial, "height");
  assert.ok(tall.positions.length <= 60);
  const loop = run({ content: 70000, view: { left: 0, top: 0, width: 1000, height: 1200 } });
  assert.equal(loop.reason, "height");
  const loop2 = run({ content: 61 * 900, view: { left: 0, top: 0, width: 1000, height: 900 } });
  assert.equal(loop2.reason, "tiles");
  assert.equal(loop2.tiles.length, 60);
});

test("join: 40000 device px gives 3 images, none above 16384, no row missing or repeated", () => {
  const tiles = [];
  for (let i = 0; i < 40; i++) tiles.push({ src: { x: 0, y: 0, w: 1000, h: 1000 }, destY: i * 1000 });
  const images = P.planJoin(tiles);
  assert.equal(images.length, 3);
  assert.ok(images.every((i) => i.height <= 16384 && i.width <= 16384));
  assert.equal(images.reduce((s, i) => s + i.height, 0), 40000);
  // Rebuild the page row of each source row and check the sequence.
  let expected = 0;
  for (const img of images) {
    let imgRow = 0;
    for (const part of img.parts) {
      assert.equal(part.destY, imgRow);
      const pageRow = tiles[part.tile].destY + (part.srcY - tiles[part.tile].src.y);
      assert.equal(pageRow, expected);
      imgRow += part.h;
      expected += part.h;
    }
    assert.equal(imgRow, img.height);
  }
  assert.equal(expected, 40000);
});

test("inner scroller: tile rectangles are offset by the visible rectangle", () => {
  const inner = { left: 120, top: 60, width: 600, height: 500 };
  const tile = P.recordTile({ reported: 0, visible: inner, contentHeight: 300, dpr: 1, covered: 0 });
  assert.deepEqual(j(tile.src), { x: 120, y: 60, w: 600, h: 300 });
  const tile2 = P.recordTile({ reported: 400, visible: inner, contentHeight: 900, dpr: 2, covered: 1000 });
  assert.equal(tile2.src.x, 240);
  assert.equal(tile2.src.y, 120 + (1000 - 800));
});
