import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";
import { loadBackground, SENDER, TAB, WINDOW } from "./helpers/background-harness.mjs";

const sandbox = {};
sandbox.globalThis = sandbox;
loadClassic("chrome-extension/lib/page-capture-client.js", sandbox);
loadClassic("chrome-extension/lib/capture-plan.js", sandbox);
const { PiPageCaptureClient, PiCapturePlan } = sandbox;

// ASSUMPTION (plan 1173). A long page at a device pixel ratio of 2 gives the
// maximum of 60 tiles (PiCapturePlan MAX_TILES). One tile is a PNG of about
// 1.5 MB. base64 adds a third, so one tile is 2 000 000 characters in a data
// URL. 60 tiles are about 120 MB in one message. Chrome refuses a runtime
// message above 64 MiB (67 108 864 bytes). The fake runtime applies that limit.
const MiB = 1024 * 1024;
const LIMIT = 64 * MiB;
const TILES = 60;
const TILE_BYTES = 1_500_000;

// The fallback in content.js buildScreenshots runs exactly when this throws.
const run = (env, generation = 1) => PiPageCaptureClient.request(env.send, generation);

async function startSession(env, generation = 1) {
  await env.send({ type: "PANEL_SESSION", generation });
}

test("premise: 60 tiles of 1.5 MB in one message are above the 64 MiB limit", () => {
  const dataUrl = "data:image/png;base64," + Buffer.alloc(TILE_BYTES, 7).toString("base64");
  const one = Buffer.byteLength(JSON.stringify({ dataUrl }));
  assert.ok(one * TILES > LIMIT, `60 tiles are ${one * TILES} bytes`);
  assert.ok(one < LIMIT / 20, "one tile is far below the limit");
});

test("60 tiles of 1.5 MB: the joined result comes with no message above the limit and no fallback", async () => {
  const env = loadBackground({ limit: LIMIT, tiles: TILES, tileBytes: TILE_BYTES });
  await startSession(env);
  const result = await run(env); // a throw here is the "viewport" fallback
  assert.equal(result.tiles.length, TILES);
  assert.equal(result.partial, null);
  assert.ok(result.tiles.every((t) => t.dataUrl.startsWith("data:image/png;base64,") && t.src && typeof t.destY === "number"));
  const planned = PiCapturePlan.planJoin(result.tiles.map((t) => ({ src: t.src, destY: t.destY })));
  // The canvas limit (16384 px) splits 60000 rows into images; no row is lost.
  assert.equal(planned.reduce((sum, image) => sum + image.height, 0), TILES * 1000);
  assert.ok(env.largest() <= LIMIT, `largest message ${env.largest()}`);
  assert.ok(env.largest() < 4 * MiB, `largest message ${env.largest()} holds one tile at most`);
  console.log(`largest message: ${env.largest()} bytes (limit ${LIMIT})`);
});

test("a message can carry a small run in full: the answer has a run id and no data URL", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env);
  const first = await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.value.count, 3);
  assert.equal(typeof first.value.runId, "string");
  assert.ok(first.value.tiles.every((t) => t.dataUrl === undefined));
});

test("the background refuses an unknown run id", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env);
  await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  const r = await env.send({ type: "CAPTURE_PAGE_TILE", generation: 1, runId: "nope", index: 0 });
  assert.ok(r.value.error);
  assert.equal(r.value.dataUrl, undefined);
});

test("the background refuses a tile request from a different tab", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env);
  const { value } = await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  const other = { ...SENDER, tab: { id: TAB + 1, windowId: WINDOW }, documentId: "doc2" };
  await env.sendFrom(other, { type: "PANEL_SESSION", generation: 1 });
  const r = await env.sendFrom(other, { type: "CAPTURE_PAGE_TILE", generation: 1, runId: value.runId, index: 0 });
  assert.ok(r.value.error);
  assert.equal(r.value.dataUrl, undefined);
  // The owner still gets the tile.
  const mine = await env.send({ type: "CAPTURE_PAGE_TILE", generation: 1, runId: value.runId, index: 0 });
  assert.ok(mine.value.dataUrl);
});

test("the background refuses a tile request with a bad index", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env);
  const { value } = await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  for (const index of [-1, 3, 1.5, "0", undefined]) {
    const r = await env.send({ type: "CAPTURE_PAGE_TILE", generation: 1, runId: value.runId, index });
    assert.ok(r.value.error, `index ${String(index)}`);
  }
});

async function begin(env) {
  await startSession(env);
  const { value } = await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  return value.runId;
}
const tile = (env, runId, index = 0) => env.send({ type: "CAPTURE_PAGE_TILE", generation: 1, runId, index });

test("the tiles are freed after the last tile", async () => {
  const env = loadBackground({ tiles: 3 });
  const runId = await begin(env);
  assert.ok((await tile(env, runId, 0)).value.dataUrl);
  assert.ok((await tile(env, runId, 2)).value.dataUrl);
  assert.ok((await tile(env, runId, 1)).value.error);
  assert.ok((await tile(env, runId, 2)).value.error);
});

test("the tiles are freed on a tab change", async () => {
  for (const [name, fire] of [
    ["activated", (env) => env.listeners.activated({ tabId: TAB + 1, windowId: WINDOW })],
    ["removed", (env) => env.listeners.removed(TAB, { windowId: WINDOW })],
    ["navigation", (env) => env.listeners.updated(TAB, { status: "loading" })],
  ]) {
    const env = loadBackground({ tiles: 3 });
    const runId = await begin(env);
    fire(env);
    assert.ok((await tile(env, runId, 0)).value.error, name);
  }
});

test("the tiles stay when another window changes its tab", async () => {
  const env = loadBackground({ tiles: 3 });
  const runId = await begin(env);
  env.listeners.activated({ tabId: 99, windowId: WINDOW + 1 });
  assert.ok((await tile(env, runId, 0)).value.dataUrl);
});

test("the tiles are freed at the end of the session", async () => {
  for (const type of ["PANEL_SESSION_END", "CANCEL", "ANNOTATIONS_COMPLETE"]) {
    const env = loadBackground({ tiles: 3 });
    const runId = await begin(env);
    await env.send({ type, generation: 1 });
    assert.ok((await tile(env, runId, 0)).value.error, type);
  }
});

test("the tiles are freed after the time limit", async () => {
  const env = loadBackground({ tiles: 3 });
  const runId = await begin(env);
  assert.equal(env.timers.filter((t) => t.fn).length, 1);
  env.timers.forEach((t) => t.fn && t.fn());
  assert.ok((await tile(env, runId, 0)).value.error);
});

test("a tab change during the run frees the tiles of that run", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env);
  env.setActive(TAB + 1); // the tab is not active when the run starts
  const { value } = await env.send({ type: "CAPTURE_PAGE", generation: 1 });
  assert.ok(value.error);
  assert.equal(env.timers.filter((t) => t.fn).length, 0);
});

test("a worker restart during a run fails the request, so the viewport fallback applies", async () => {
  const before = loadBackground({ tiles: 3 });
  const runId = await begin(before);
  const after = loadBackground({ tiles: 3 }); // a new worker has no tiles
  await startSession(after);
  assert.ok((await tile(after, runId, 0)).value.error);
  // The client turns a failed tile request into a throw (the fallback).
  const send = async (msg) => (msg.type === "CAPTURE_PAGE" ? before.send(msg) : after.send(msg));
  await assert.rejects(() => PiPageCaptureClient.request(send, 1));
});

test("an old generation cannot read the tiles", async () => {
  const env = loadBackground({ tiles: 3 });
  await startSession(env, 2);
  const { value } = await env.send({ type: "CAPTURE_PAGE", generation: 2 });
  const r = await env.send({ type: "CAPTURE_PAGE_TILE", generation: 1, runId: value.runId, index: 0 });
  assert.ok(r.value.error);
});
