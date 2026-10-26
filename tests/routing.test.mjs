import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
sandbox.globalThis = sandbox;
loadClassic("chrome-extension/panel/protocol.js", sandbox);
loadClassic("chrome-extension/lib/routing.js", sandbox);
const { PiRouting, PiPanelProtocol } = sandbox;

const PANEL = "chrome-extension://abc/panel/panel.html";
const plain = (v) => JSON.parse(JSON.stringify(v));

function harness({ nativeConnected = true } = {}) {
  const log = { toTab: [], toPort: [], closed: [], native: [] };
  let counter = 0;
  const router = PiRouting.createRouter({
    panelUrl: PANEL,
    randomHex: (bytes) => String(++counter).padStart(bytes * 2, "0"),
    postToPort: (port, msg) => log.toPort.push({ port: port.name, msg: plain(msg) }),
    closePort: (port) => { port.closed = true; log.closed.push(port.name); },
    sendToTab: (tabId, msg, target) => { log.toTab.push({ tabId, msg: plain(msg), target: plain(target) }); return Promise.resolve(); },
    sendToNative: (msg) => { log.native.push(plain(msg)); return true; },
    nativeConnected: () => nativeConnected,
  });
  return { router, log };
}

const content = (tabId, documentId = `doc${tabId}`, extra = {}) => ({
  tab: { id: tabId, windowId: 1 }, frameId: 0, url: "https://site.test/", documentId, ...extra,
});
const pane = (name, extra = {}) => ({ name, sender: { url: `${PANEL}?host=devtools`, ...extra } });
const frame = (name, tabId, extra = {}) => ({
  name, sender: { tab: { id: tabId }, frameId: 3, url: `${PANEL}?host=frame`, documentId: "frameDoc", ...extra },
});
const hello = (tabId) => ({ type: "PANE_HELLO", tabId });
const session = () => ({
  multi: false, screenshotMode: "each", notesVisible: true, debug: false, etch: { on: false, count: 0 },
  edit: false, interact: false, elements: [], context: "", managed: true, prepared: null,
});
const stateMsg = (generation = 1, revision = 1) => ({ type: "STATE", generation, revision, session: session() });
const action = (name, args = {}, generation = 1) => ({ type: "ACTION", generation, name, args });

function startSession(router, tabId, generation = 1, documentId) {
  return router.registerSession(content(tabId, documentId), generation);
}

test("a pane binds only from an extension page without a tab", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const good = pane("pane1");
  assert.equal(router.onPortMessage(good, hello(1)).ok, true);
  assert.equal(router.isPaneBound(1), true);

  const tabbed = pane("tabbed", { tab: { id: 1 } });
  assert.equal(router.onPortMessage(tabbed, hello(1)).ok, false);
  assert.equal(tabbed.closed, true);
  const foreign = { name: "foreign", sender: { url: "https://evil.test/panel.html" } };
  assert.equal(router.onPortMessage(foreign, hello(1)).ok, false);
  assert.equal(foreign.closed, true);
  const badTab = pane("badTab");
  assert.equal(router.onPortMessage(badTab, { type: "PANE_HELLO", tabId: "1" }).ok, false);
  assert.equal(router.isPaneBound(1), true);
  assert.equal(log.closed.includes("pane1"), false);
});

test("STATE reaches only the bound view of its own tab", () => {
  const { router, log } = harness();
  startSession(router, 1);
  startSession(router, 2);
  const p1 = pane("p1");
  const p2 = pane("p2");
  router.onPortMessage(p1, hello(1));
  router.onPortMessage(p2, hello(2));
  assert.equal(router.relayState(content(1), stateMsg()).ok, true);
  assert.deepEqual(log.toPort.map((x) => x.port), ["p1"]);
  assert.equal(log.toPort[0].msg.type, "STATE");
  // nothing bound for tab 3
  startSession(router, 3);
  assert.equal(router.relayState(content(3), stateMsg()).ok, false);
  assert.equal(log.toPort.length, 1);
});

test("an ACTION from the bound view reaches the content script of its tab only", () => {
  const { router, log } = harness();
  startSession(router, 1);
  startSession(router, 2);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  router.onPortMessage(pane("p2"), hello(2));
  log.toTab.length = 0;
  assert.equal(router.onPortMessage(p1, action("setMulti", { value: true })).ok, true);
  assert.equal(log.toTab.length, 1);
  assert.equal(log.toTab[0].tabId, 1);
  assert.deepEqual(log.toTab[0].target, { documentId: "doc1" });
  assert.equal(log.toTab[0].msg.name, "setMulti");
});

test("bad, stale and unknown actions are not relayed", () => {
  const { router, log } = harness();
  startSession(router, 1, 4);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  log.toTab.length = 0;
  assert.equal(router.onPortMessage(p1, action("setMulti", { value: "x" }, 4)).ok, false);
  assert.equal(router.onPortMessage(p1, action("rm -rf", {}, 4)).ok, false);
  assert.equal(router.onPortMessage(p1, action("submit", {}, 3)).reason, "stale-generation");
  assert.equal(router.onPortMessage(p1, { type: "SOMETHING" }).ok, false);
  assert.equal(log.toTab.length, 0);
});

test("frame binding needs the real token, once, from the owned frame", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const issued = router.requestFrameToken(content(1), 1);
  assert.equal(issued.ok, true);
  assert.match(issued.token, /^[0-9]{64}$/);
  const token = issued.token;

  const wrongToken = frame("wrong", 1);
  assert.equal(router.onPortMessage(wrongToken, { type: "FRAME_HELLO", token: "nope" }).ok, false);
  assert.equal(wrongToken.closed, true);
  const wrongTab = frame("wrongTab", 2);
  assert.equal(router.onPortMessage(wrongTab, { type: "FRAME_HELLO", token }).ok, false);
  assert.equal(wrongTab.closed, true);
  const topFrame = frame("topFrame", 1, { frameId: 0 });
  assert.equal(router.onPortMessage(topFrame, { type: "FRAME_HELLO", token }).ok, false);
  const badUrl = frame("badUrl", 1, { url: "https://evil.test/" });
  assert.equal(router.onPortMessage(badUrl, { type: "FRAME_HELLO", token }).ok, false);

  const good = frame("good", 1);
  log.toTab.length = 0;
  assert.equal(router.onPortMessage(good, { type: "FRAME_HELLO", token }).ok, true);
  assert.deepEqual(log.toPort.find((x) => x.port === "good").msg, { type: "HELLO_ACK" });
  assert.deepEqual(log.toTab.map((x) => x.msg), [{ type: "VIEW_BOUND", kind: "frame" }]);

  const reuse = frame("reuse", 1);
  assert.equal(router.onPortMessage(reuse, { type: "FRAME_HELLO", token }).ok, false);
  assert.equal(reuse.closed, true);
  assert.equal(router.boundKind(1), "frame");
});

test("three false tokens do not stop the real token from binding", () => {
  const { router } = harness();
  startSession(router, 1);
  const { token } = router.requestFrameToken(content(1), 1);
  for (let i = 0; i < 3; i++) {
    const fake = frame(`fake${i}`, 1);
    assert.equal(router.onPortMessage(fake, { type: "FRAME_HELLO", token: `fake${i}` }).ok, false);
    assert.equal(fake.closed, true);
  }
  assert.equal(router.onPortMessage(frame("real", 1), { type: "FRAME_HELLO", token }).ok, true);
});

test("an old document cannot bind, relay or capture", async () => {
  const { router, log } = harness();
  startSession(router, 1, 1, "docA");
  const { token } = router.requestFrameToken(content(1, "docA"), 1);
  // the tab loaded a new document
  startSession(router, 1, 1, "docB");
  assert.equal(router.onPortMessage(frame("late", 1), { type: "FRAME_HELLO", token }).ok, false);
  assert.equal(router.relayState(content(1, "docA"), stateMsg()).ok, false);
  const result = await router.guardedCapture(content(1, "docA"), 1, { getActiveTabId: async () => 1, capture: async () => ({ dataUrl: "x" }) });
  assert.ok(result.error);
  assert.equal(log.native.length, 0);
});

test("navigation revokes the record, tokens and bindings and ends pending copies with an error", () => {
  const { router, log } = harness();
  router.onNativeMessage({ type: "PONG", capabilities: ["format-result"] });
  startSession(router, 1);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  const { token } = router.requestFrameToken(content(1), 1);
  router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 1, result: { success: true } });
  assert.equal(log.native.length, 1);
  log.toPort.length = 0;

  router.onTabLoading(1);
  assert.equal(p1.closed, true);
  assert.equal(router.isPaneBound(1), false);
  assert.equal(router.sessionOf(1), null);
  assert.equal(log.toPort[0].msg.type, "PREPARED");
  assert.match(log.toPort[0].msg.error, /page changed/);
  assert.equal(router.onPortMessage(frame("f", 1), { type: "FRAME_HELLO", token }).ok, false);
  // a late FORMATTED_RESULT finds nothing to deliver to
  const copyId = log.native[0].copyId;
  assert.equal(router.onFormattedResult({ type: "FORMATTED_RESULT", copyId, text: "x" }).ok, false);
});

test("a new pane for the same tab replaces the old one", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const first = pane("first");
  const second = pane("second");
  router.onPortMessage(first, hello(1));
  router.onPortMessage(second, hello(1));
  assert.equal(first.closed, true);
  // the closed port's disconnect must not unbind the new one
  log.toTab.length = 0;
  router.onPortDisconnect(first);
  assert.equal(router.isPaneBound(1), true);
  assert.equal(log.toTab.length, 0);
  router.relayState(content(1), stateMsg());
  assert.deepEqual(log.toPort.map((x) => x.port), ["second"]);
});

test("a pane replaces the frame of the same tab", () => {
  const { router } = harness();
  startSession(router, 1);
  const { token } = router.requestFrameToken(content(1), 1);
  const f = frame("f", 1);
  router.onPortMessage(f, { type: "FRAME_HELLO", token });
  router.onPortMessage(pane("p"), hello(1));
  assert.equal(f.closed, true);
  assert.equal(router.boundKind(1), "pane");
});

test("disconnect and session end", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  const { token } = router.requestFrameToken(content(1), 1);
  const f = frame("f", 1);
  // a frame bound beside a pane gets no VIEW_BOUND
  log.toTab.length = 0;
  router.onPortMessage(f, { type: "FRAME_HELLO", token });
  assert.deepEqual(log.toTab, []);
  // session end closes the frame and keeps the pane
  router.endSession(content(1), 1);
  assert.equal(f.closed, true);
  assert.equal(router.isPaneBound(1), true);
  assert.equal(router.sessionOf(1), null);
  log.toTab.length = 0;
  router.onPortDisconnect(p1);
  assert.equal(router.isPaneBound(1), false);
  assert.deepEqual(log.toTab.map((x) => x.msg), [{ type: "VIEW_UNBOUND", kind: "pane" }]);
});

test("VIEW_BOUND and VIEW_UNBOUND arrive in order", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  router.onPortDisconnect(p1);
  // a session that starts while a pane is bound is told at once
  const p2 = pane("p2");
  router.onPortMessage(p2, hello(1));
  startSession(router, 1, 2);
  assert.deepEqual(log.toTab.map((x) => x.msg.type + ":" + x.msg.kind), [
    "VIEW_BOUND:pane", "VIEW_UNBOUND:pane", "VIEW_BOUND:pane", "VIEW_BOUND:pane",
  ]);
});

test("PANE_FOCUS picks the target tab for a native request", () => {
  const { router } = harness();
  startSession(router, 1);
  startSession(router, 2);
  const p1 = pane("p1");
  const p2 = pane("p2");
  router.onPortMessage(p1, hello(1));
  router.onPortMessage(p2, hello(2));
  assert.equal(router.lastFocusedPaneTab(), null);
  router.onPortMessage(p2, { type: "PANE_FOCUS" });
  const pick = (extra = {}) => PiRouting.selectTargetTab({
    requestBoundTabId: null, lastFocusedPaneTab: router.lastFocusedPaneTab(), isPaneBound: router.isPaneBound, ...extra,
  });
  assert.deepEqual(plain(pick()), { source: "pane", tabId: 2 });
  // an existing request binding wins
  assert.deepEqual(plain(pick({ requestBoundTabId: 1 })), { source: "request", tabId: 1 });
  // an unbound pane tab falls back to the window
  router.onPortDisconnect(p2);
  assert.deepEqual(plain(pick()), { source: "window" });
  // focus from a port that is not a bound pane is ignored
  router.onPortMessage(pane("stranger"), { type: "PANE_FOCUS" });
  assert.equal(router.lastFocusedPaneTab(), 2);
});

test("the only bound pane is the target even when it never had focus", () => {
  const { router } = harness();
  const pick = () => PiRouting.selectTargetTab({
    requestBoundTabId: null, lastFocusedPaneTab: router.lastFocusedPaneTab(),
    isPaneBound: router.isPaneBound, boundPaneTabs: router.boundPaneTabs,
  });
  // no pane: the focused window decides
  assert.deepEqual(plain(pick()), { source: "window" });
  // one pane, no focus event: its tab
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(7));
  assert.equal(router.lastFocusedPaneTab(), null);
  assert.deepEqual(plain(pick()), { source: "only-pane", tabId: 7 });
  // two panes and no focus: no guess
  const p2 = pane("p2");
  router.onPortMessage(p2, hello(8));
  assert.deepEqual(plain(pick()), { source: "window" });
  // focus picks one of them
  router.onPortMessage(p2, { type: "PANE_FOCUS" });
  assert.deepEqual(plain(pick()), { source: "pane", tabId: 8 });
  // the other pane closes and the focused one too: back to the window
  router.onPortDisconnect(p2);
  assert.deepEqual(plain(pick()), { source: "only-pane", tabId: 7 });
  router.onPortDisconnect(p1);
  assert.deepEqual(plain(pick()), { source: "window" });
});

test("a service-worker restart: views connect again and a message with a generation rebuilds the record", async () => {
  // a fresh router has no state
  const { router, log } = harness();
  assert.equal(router.sessionOf(1), null);
  const p1 = pane("p1");
  assert.equal(router.onPortMessage(p1, hello(1)).ok, true);
  // VIEW_BOUND goes out by frame 0 because no record exists yet
  assert.deepEqual(log.toTab[0].target, { frameId: 0 });
  // the content script publishes state; the record is rebuilt from the sender
  assert.equal(router.relayState(content(1, "docX"), stateMsg(5, 9)).ok, true);
  assert.deepEqual(plain(router.sessionOf(1)), { tabId: 1, documentId: "docX", generation: 5 });
  // a capture with a generation also rebuilds
  const fresh = harness().router;
  const result = await fresh.guardedCapture(content(2, "docY"), 3, { getActiveTabId: async () => 2, capture: async () => ({ dataUrl: "img" }) });
  assert.deepEqual(plain(result), { dataUrl: "img" });
  assert.equal(fresh.sessionOf(2).generation, 3);
});

test("a host without the capability never gets FORMAT_RESULT", () => {
  const { router, log } = harness();
  startSession(router, 1);
  router.onPortMessage(pane("p1"), hello(1));
  router.onNativeMessage({ type: "BROWSER_REGISTERED", id: "x" });
  const out = router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 4, result: { success: true } });
  assert.equal(out.ok, false);
  assert.equal(log.native.length, 0);
  const last = log.toPort.at(-1).msg;
  assert.equal(last.type, "PREPARED");
  assert.equal(last.error, "Update the native host to copy output");
  assert.equal(last.revision, 4);
});

test("format flow: capability, FORMAT_RESULT, FORMATTED_RESULT, PNG images only, current view only", () => {
  const { router, log } = harness();
  startSession(router, 1);
  router.onPortMessage(pane("p1"), hello(1));
  router.onNativeMessage({ type: "PONG", capabilities: ["format-result"] });
  assert.equal(router.hasFormatCapability(), true);
  const result = {
    success: true,
    screenshot: "data:image/png;base64,AAAA",
    screenshots: [{ index: 2, dataUrl: "data:image/png;base64,BBBB" }, { index: 3, dataUrl: "data:image/webp;base64,CCCC" }],
    elements: [{ attachments: [{ dataUrl: "data:image/webp;base64,DDDD" }] }],
    editCapture: { beforeScreenshot: "data:image/png;base64,EEEE", afterScreenshot: null },
  };
  const out = router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 7, result });
  assert.equal(out.ok, true);
  assert.equal(log.native.length, 1);
  assert.equal(log.native[0].type, "FORMAT_RESULT");
  assert.equal(log.native[0].copyId, out.copyId);
  assert.equal(log.toTab.some((x) => x.msg.type === "FORMAT_RESULT"), false);

  const delivered = router.onFormattedResult({ type: "FORMATTED_RESULT", copyId: out.copyId, text: "## text" });
  assert.equal(delivered.ok, true);
  const prepared = log.toPort.at(-1);
  assert.equal(prepared.port, "p1");
  assert.equal(prepared.msg.preparedId, out.copyId);
  assert.equal(prepared.msg.revision, 7);
  assert.equal(prepared.msg.text, "## text");
  assert.deepEqual(prepared.msg.images.map((i) => i.dataUrl), [
    "data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "data:image/png;base64,EEEE",
  ]);
  assert.equal(PiPanelProtocol.validatePrepared(prepared.msg).ok, true);
  // an answer is delivered once
  assert.equal(router.onFormattedResult({ type: "FORMATTED_RESULT", copyId: out.copyId, text: "again" }).ok, false);
});

test("a host error reaches the view as a message, and an unknown copyId is dropped", () => {
  const { router, log } = harness();
  startSession(router, 1);
  router.onPortMessage(pane("p1"), hello(1));
  router.onNativeMessage({ type: "PONG", capabilities: ["format-result"] });
  const out = router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 1, result: { success: true } });
  router.onFormattedResult({ type: "FORMATTED_RESULT", copyId: out.copyId, error: "too-large" });
  assert.equal(log.toPort.at(-1).msg.error, "The output is too large to copy");
  const before = log.toPort.length;
  assert.equal(router.onFormattedResult({ type: "FORMATTED_RESULT", copyId: "zzz", text: "x" }).ok, false);
  assert.equal(log.toPort.length, before);
});

test("a content error and a disconnected host become view errors; nothing is sent to the host", () => {
  const { router, log } = harness({ nativeConnected: false });
  startSession(router, 1);
  router.onPortMessage(pane("p1"), hello(1));
  router.onNativeMessage({ type: "PONG", capabilities: ["format-result"] });
  router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 2, error: "Activate the annotated tab, then try again" });
  assert.equal(log.toPort.at(-1).msg.error, "Activate the annotated tab, then try again");
  router.onPreparedResult(content(1), { type: "PREPARED_RESULT", generation: 1, revision: 2, result: { success: true } });
  assert.match(log.toPort.at(-1).msg.error, /not connected/);
  assert.equal(log.native.length, 0);
  router.onNativeDisconnect();
  assert.equal(router.hasFormatCapability(), false);
});

test("prepareOutput never completes; a submit from an unmanaged session still reaches the content script", () => {
  const { router, log } = harness();
  startSession(router, 1);
  const p1 = pane("p1");
  router.onPortMessage(p1, hello(1));
  log.toTab.length = 0;
  router.onPortMessage(p1, action("prepareOutput"));
  router.onPortMessage(p1, action("submit"));
  assert.deepEqual(log.toTab.map((x) => x.msg.name), ["prepareOutput", "submit"]);
  assert.equal(log.native.length, 0, "the router sends no completion; only the content script does");
  // the completion that the content script sends is forwarded without the generation, with or without a request id
  const unmanaged = PiRouting.toNativeCompletion({ type: "ANNOTATIONS_COMPLETE", generation: 3, requestId: null, result: { success: true } });
  assert.deepEqual(plain(unmanaged), { type: "ANNOTATIONS_COMPLETE", requestId: null, result: { success: true } });
  const noId = PiRouting.toNativeCompletion({ type: "ANNOTATIONS_COMPLETE", generation: 3, result: { success: true } });
  assert.equal("requestId" in noId, false);
  assert.equal("generation" in noId, false);
});

test("only a top frame of a web page may register, ask for tokens or relay", () => {
  const { router } = harness();
  assert.equal(router.registerSession(content(1, "d", { frameId: 2 }), 1).ok, false);
  assert.equal(router.registerSession(content(1, "d", { url: "chrome-extension://abc/panel/panel.html" }), 1).ok, false);
  assert.equal(router.registerSession({ frameId: 0, url: "https://x.test/" }, 1).ok, false);
  assert.equal(router.registerSession(content(1), -1).ok, false);
  assert.equal(router.requestFrameToken(content(1, "d", { frameId: 4 }), 1).ok, false);
  assert.equal(router.relayState(content(1, "d", { frameId: 4 }), stateMsg()).ok, false);
  assert.equal(router.onPreparedResult(content(1, "d", { frameId: 4 }), { generation: 1, revision: 1, result: {} }).ok, false);
});

// ── capture guard ───────────────────────────────────────────────────────
const io = (router, { active = 1, during } = {}) => ({
  getActiveTabId: async () => active,
  capture: async () => { if (during) during(router); return { dataUrl: "data:image/png;base64,ZZZZ" }; },
});

test("capture: normal capture works", async () => {
  const { router } = harness();
  startSession(router, 1);
  const out = await router.guardedCapture(content(1), 1, io(router));
  assert.equal(out.dataUrl, "data:image/png;base64,ZZZZ");
});

test("capture: an inactive target tab is refused", async () => {
  const { router } = harness();
  startSession(router, 1);
  const out = await router.guardedCapture(content(1), 1, io(router, { active: 2 }));
  assert.equal(out.error, "Activate the annotated tab, then try again");
  assert.equal(out.dataUrl, undefined);
});

test("capture: a switch away and back during the capture is refused", async () => {
  const { router } = harness();
  startSession(router, 1);
  const out = await router.guardedCapture(content(1), 1, io(router, {
    during: (r) => {
      r.noteTabEvent({ kind: "activated", tabId: 2, windowId: 1 });
      r.noteTabEvent({ kind: "activated", tabId: 1, windowId: 1 });
    },
  }));
  assert.ok(out.error);
  assert.equal(out.dataUrl, undefined);
});

test("capture: a navigation during the capture is refused, a title change is allowed", async () => {
  const { router } = harness();
  startSession(router, 1);
  const nav = await router.guardedCapture(content(1), 1, io(router, {
    during: (r) => r.noteTabEvent({ kind: "updated", tabId: 1, changeInfo: { status: "loading" } }),
  }));
  assert.ok(nav.error);
  for (const changeInfo of [{ title: "New title" }, { favIconUrl: "x" }, { audible: true }]) {
    const out = await router.guardedCapture(content(1), 1, io(router, {
      during: (r) => r.noteTabEvent({ kind: "updated", tabId: 1, changeInfo }),
    }));
    assert.equal(out.dataUrl, "data:image/png;base64,ZZZZ", JSON.stringify(changeInfo));
  }
  for (const changeInfo of [{ url: "https://other.test/" }, { discarded: true }]) {
    const out = await router.guardedCapture(content(1), 1, io(router, {
      during: (r) => r.noteTabEvent({ kind: "updated", tabId: 1, changeInfo }),
    }));
    assert.ok(out.error, JSON.stringify(changeInfo));
  }
});

test("capture: removal of the tab or a closing window is refused; other tabs and windows are ignored", async () => {
  const { router } = harness();
  startSession(router, 1);
  const removed = await router.guardedCapture(content(1), 1, io(router, { during: (r) => r.noteTabEvent({ kind: "removed", tabId: 1, windowId: 1 }) }));
  assert.ok(removed.error);
  const closing = await router.guardedCapture(content(1), 1, io(router, { during: (r) => r.noteTabEvent({ kind: "removed", tabId: 9, windowId: 1, isWindowClosing: true }) }));
  assert.ok(closing.error);
  const other = await router.guardedCapture(content(1), 1, io(router, {
    during: (r) => {
      r.noteTabEvent({ kind: "removed", tabId: 9, windowId: 1 });
      r.noteTabEvent({ kind: "activated", tabId: 5, windowId: 2 });
      r.noteTabEvent({ kind: "updated", tabId: 9, changeInfo: { status: "complete" } });
    },
  }));
  assert.equal(other.dataUrl, "data:image/png;base64,ZZZZ");
});

test("capture: a subframe, an old generation and a different document cannot capture", async () => {
  const { router } = harness();
  startSession(router, 1, 5, "docA");
  const sub = await router.guardedCapture(content(1, "docA", { frameId: 2 }), 5, io(router));
  assert.ok(sub.error);
  const old = await router.guardedCapture(content(1, "docA"), 4, io(router));
  assert.ok(old.error);
  const other = await router.guardedCapture(content(1, "docOther"), 5, io(router));
  assert.ok(other.error);
  const ok = await router.guardedCapture(content(1, "docA"), 5, io(router));
  assert.ok(ok.dataUrl);
});

test("capture: the watch ends after a failure, so a later capture is not poisoned", async () => {
  const { router } = harness();
  startSession(router, 1);
  const failed = await router.guardedCapture(content(1), 1, io(router, { during: (r) => r.noteTabEvent({ kind: "activated", tabId: 2, windowId: 1 }) }));
  assert.ok(failed.error);
  const again = await router.guardedCapture(content(1), 1, io(router));
  assert.ok(again.dataUrl);
});
