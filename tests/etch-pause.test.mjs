import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { repoRoot } from "./helpers/load-classic.mjs";

const content = fs.readFileSync(path.join(repoRoot, "chrome-extension", "content.js"), "utf8");
const start = content.indexOf("// <etch-pause-helpers>");
const end = content.indexOf("// </etch-pause-helpers>");
assert.ok(start > 0 && end > start, "etch helper markers exist in content.js");
const helperSource = content.slice(start, end);

// Run the real helper source against stub page state.
function makeContext() {
  const prelude = `
    let etchObserver = null;
    let etchMode = false;
    let etchStartTime = null;
    let etchSkippedSheets = new WeakSet();
    let etchInitialRules = null;
    let etchChangeCount = 0;
    let etchChildListMutations = [];
    const etchStyleInitials = new Map();
    const etchClassInitials = new Map();
    const etchAttrInitials = new Map();
    const etchTextInitials = new Map();
    const calls = [];
    const documentRoot = { name: "html" };
    const document = { documentElement: documentRoot };
    function clearEtchMarkers() { calls.push("clearMarkers"); }
    function serializeAllStylesheets() { return { sheets: ["snapshot"] }; }
    function updateEtchCounter() { calls.push("counter"); }
    function processEtchMutations(records) { calls.push("process:" + records.length); etchChangeCount += records.length; }
    class MutationObserver {
      constructor(callback) { this.callback = callback; this.observed = []; this.disconnects = 0; this.pending = []; }
      observe(target, options) { this.observed.push({ target, options }); }
      disconnect() { this.disconnects++; }
      takeRecords() { const r = this.pending; this.pending = []; return r; }
    }
  `;
  const context = vm.createContext({});
  vm.runInContext(prelude + helperSource, context);
  const run = (code) => vm.runInContext(code, context);
  return { run };
}

test("pause processes pending records once, disconnects, and keeps every baseline", () => {
  const { run } = makeContext();
  run(`
    startEtchCapture();
    etchStyleInitials.set("el", "color: red");
    etchClassInitials.set("el2", "a");
    etchTextInitials.set("t", "old");
    etchObserver.pending = [{}, {}, {}];
    calls.length = 0;
  `);
  const paused = run("pauseEtchCapture()");
  assert.equal(paused, true);
  assert.deepEqual(JSON.parse(run("JSON.stringify(calls)")), ["process:3"]);
  assert.equal(run("etchObserver.disconnects"), 1);
  assert.equal(run("etchObserver.pending.length"), 0);
  assert.equal(run("etchStyleInitials.size"), 1);
  assert.equal(run("etchClassInitials.size"), 1);
  assert.equal(run("etchTextInitials.size"), 1);
  assert.equal(run("etchInitialRules !== null"), true);
  assert.equal(run("etchStartTime !== null"), true);
  assert.equal(run("etchMode"), true);
  assert.equal(run("etchChangeCount"), 3);
  assert.equal(run("etchObserver !== null"), true);
});

test("pause with no pending records processes nothing", () => {
  const { run } = makeContext();
  run("startEtchCapture(); calls.length = 0;");
  assert.equal(run("pauseEtchCapture()"), true);
  assert.deepEqual(JSON.parse(run("JSON.stringify(calls)")), []);
});

test("pause with no observer reports false and changes nothing", () => {
  const { run } = makeContext();
  assert.equal(run("pauseEtchCapture()"), false);
  assert.equal(run("etchObserver"), null);
  run("resumeEtchCapture()");
  assert.equal(run("etchObserver"), null);
});

test("resume reconnects the same observer with the same options and clears nothing", () => {
  const { run } = makeContext();
  run(`
    startEtchCapture();
    etchStyleInitials.set("el", "x");
    calls.length = 0;
    globalThis.original = etchObserver;
    globalThis.firstOptions = etchObserver.observed[0].options;
  `);
  run("pauseEtchCapture()");
  run("resumeEtchCapture()");
  assert.equal(run("etchObserver === original"), true);
  assert.equal(run("etchObserver.observed.length"), 2);
  assert.equal(run("etchObserver.observed[1].options === firstOptions"), true);
  assert.equal(run("etchObserver.observed[1].target === documentRoot"), true);
  assert.deepEqual(JSON.parse(run("JSON.stringify(etchObserver.observed[1].options)")), {
    attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true, childList: true, subtree: true,
  });
  assert.equal(run("etchStyleInitials.size"), 1);
  assert.deepEqual(JSON.parse(run("JSON.stringify(calls)")), []);
});

test("start still clears baselines (the pause path must not be the start path)", () => {
  const { run } = makeContext();
  run(`startEtchCapture(); etchStyleInitials.set("el", "x");`);
  run("startEtchCapture()");
  assert.equal(run("etchStyleInitials.size"), 0);
});
