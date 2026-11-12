import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
sandbox.globalThis = sandbox;
const P = loadClassic("chrome-extension/panel/protocol.js", sandbox).PiPanelProtocol;
const ctx = { generation: 3, elementIds: ["e1", "e2"] };
const act = (name, args, generation = 3) => ({ generation, name, args });
const ok = (raw, c = ctx) => P.validateAction(raw, c).ok;
const reason = (raw, c = ctx) => P.validateAction(raw, c).reason;

test("every action name accepts good arguments", () => {
  const good = {
    setMulti: { value: true },
    setScreenshotMode: { value: "full" },
    setNotesVisible: { value: false },
    setDebug: { value: true },
    setEtch: { value: true },
    setEdit: { value: false },
    setInteract: { value: true },
    setComment: { id: "e1", text: "hello" },
    setContext: { text: "ctx" },
    removeElement: { id: "e2" },
    expandElement: { id: "e1" },
    contractElement: { id: "e1" },
    dragBy: { dx: 4, dy: -5 },
    submit: {},
    cancel: {},
    close: {},
    prepareOutput: {},
  };
  assert.deepEqual(Object.keys(good).sort(), [...P.ACTION_NAMES].sort());
  for (const [name, args] of Object.entries(good)) assert.equal(ok(act(name, args)), true, name);
});

test("bad arguments are rejected for every name", () => {
  const bad = [
    ["setMulti", { value: "yes" }], ["setMulti", {}], ["setScreenshotMode", { value: "all" }],
    ["setNotesVisible", { value: 1 }], ["setDebug", { value: null }], ["setEtch", { value: "x" }],
    ["setEdit", { value: {} }], ["setInteract", { value: [] }],
    ["setComment", { id: "e1", text: 5 }], ["setComment", { id: 1, text: "x" }], ["setComment", { id: "e1" }],
    ["setContext", { text: null }], ["removeElement", { id: "1" }], ["expandElement", { id: "e" }],
    ["contractElement", { id: "e1; drop" }], ["dragBy", { dx: 1 }], ["dragBy", { dx: "1", dy: 2 }],
    ["submit", { value: true }], ["cancel", { x: 1 }], ["close", { x: 1 }], ["prepareOutput", { x: 1 }],
  ];
  for (const [name, args] of bad) assert.equal(ok(act(name, args)), false, `${name} ${JSON.stringify(args)}`);
});

test("drag values must be finite and within 10 000", () => {
  assert.equal(ok(act("dragBy", { dx: NaN, dy: 0 })), false);
  assert.equal(ok(act("dragBy", { dx: Infinity, dy: 0 })), false);
  assert.equal(ok(act("dragBy", { dx: 0, dy: -Infinity })), false);
  assert.equal(ok(act("dragBy", { dx: 10001, dy: 0 })), false);
  assert.equal(ok(act("dragBy", { dx: 0, dy: -10001 })), false);
  assert.equal(ok(act("dragBy", { dx: 10000, dy: -10000 })), true);
});

test("long strings are rejected", () => {
  assert.equal(ok(act("setContext", { text: "a".repeat(10000) })), true);
  assert.equal(ok(act("setContext", { text: "a".repeat(10001) })), false);
  assert.equal(ok(act("setComment", { id: "e1", text: "a".repeat(10001) })), false);
});

test("unknown and removed element ids are rejected", () => {
  assert.equal(reason(act("removeElement", { id: "e9" })), "unknown-element");
  assert.equal(reason(act("setComment", { id: "e9", text: "x" })), "unknown-element");
  // e2 was removed: the live id list no longer has it.
  assert.equal(reason(act("expandElement", { id: "e2" }), { generation: 3, elementIds: new Set(["e1"]) }), "unknown-element");
  assert.equal(ok(act("expandElement", { id: "e1" }), { generation: 3, elementIds: new Set(["e1"]) }), true);
  assert.equal(reason(act("removeElement", { id: "e1" }), { generation: 3 }), "unknown-element");
});

test("unknown names, extra keys, non-objects and old generations are rejected", () => {
  assert.equal(reason(act("deleteEverything", {})), "unknown-action");
  assert.equal(reason(act("toString", {})), "unknown-action");
  assert.equal(reason(act("__proto__", {})), "unknown-action");
  assert.equal(reason({ ...act("submit", {}), extra: 1 }), "bad-keys");
  assert.equal(reason({ generation: 3, name: "submit" }), "bad-keys");
  assert.equal(reason(null), "not-an-object");
  assert.equal(reason("submit"), "not-an-object");
  assert.equal(reason(act("submit", [])), "bad-args");
  assert.equal(reason(act("submit", {}, 2)), "stale-generation");
  assert.equal(reason(act("submit", {}, 4)), "stale-generation");
  assert.equal(reason(act("submit", {}, 1.5)), "bad-generation");
  assert.equal(reason(act("submit", {}, -1)), "bad-generation");
});

const session = () => ({
  multi: false, screenshotMode: "each", notesVisible: true, debug: false,
  etch: { on: false, count: 0 }, edit: false, interact: false,
  elements: [{ id: "e1", selector: "#a", tag: "div", text: "t", comment: "", attachments: [], screenshot: true }],
  context: "", managed: true, prepared: null,
});

test("STATE validation accepts a good snapshot and rejects bad ones", () => {
  const state = { type: "STATE", generation: 1, revision: 4, session: session() };
  assert.equal(P.validateState(state).ok, true);
  assert.equal(P.validateState({ ...state, session: { ...session(), screenshotMode: "x" } }).ok, false);
  assert.equal(P.validateState({ ...state, session: { ...session(), elements: [{ id: "bad" }] } }).ok, false);
  assert.equal(P.validateState({ ...state, session: { ...session(), prepared: { preparedId: 1, revision: 1 } } }).ok, false);
  assert.equal(P.validateState({ ...state, session: { ...session(), prepared: { preparedId: "p", revision: 2 } } }).ok, true);
  assert.equal(P.validateState({ ...state, revision: "4" }).ok, false);
  assert.equal(P.validateState({ ...state, type: "ACTION" }).ok, false);
});

test("PREPARED validation allows PNG and JPEG image data and refuses every other type", () => {
  const good = { type: "PREPARED", preparedId: "p", revision: 2, text: "x", images: [{ dataUrl: "data:image/png;base64,AAAA" }] };
  assert.equal(P.validatePrepared(good).ok, true);
  assert.equal(P.validatePrepared({ ...good, images: [{ dataUrl: "data:image/jpeg;base64,/9j/AAAA" }] }).ok, true);
  assert.equal(P.validatePrepared({ ...good, images: [{ dataUrl: "data:image/png;base64,AAAA" }, { dataUrl: "data:image/jpeg;base64,AAAA" }] }).ok, true);
  for (const bad of ["data:image/webp;base64,AAAA", "data:image/gif;base64,AAAA", "data:image/svg+xml;base64,AAAA", "data:image/jpg;base64,AAAA", "data:image/jpeg;charset=x;base64,AAAA", "data:text/html;base64,AAAA", "image/jpeg;base64,AAAA"]) {
    assert.equal(P.validatePrepared({ ...good, images: [{ dataUrl: bad }] }).ok, false, bad);
  }
  assert.equal(P.validatePrepared({ ...good, images: [{ dataUrl: "data:image/png;base64,AAAA" }, { dataUrl: "data:image/webp;base64,AAAA" }] }).ok, false);
  assert.equal(P.validatePrepared({ ...good, images: [{ dataUrl: "javascript:alert(1)" }] }).ok, false);
  assert.equal(P.validatePrepared({ type: "PREPARED", preparedId: "p", revision: 2, error: "nope" }).ok, true);
  assert.equal(P.validatePrepared({ ...good, text: 3 }).ok, false);
});
