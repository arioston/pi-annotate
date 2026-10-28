import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

// ── minimal DOM stub ────────────────────────────────────────────────────
class El {
  constructor(tag, doc) {
    this.tag = tag;
    this.doc = doc;
    this.children = [];
    this.listeners = {};
    this.className = "";
    this._text = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.style = {};
    this.selected = false;
    this.focused = false;
    this.html = null;
    this.parent = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
  set innerHTML(v) { this.html = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parent = null; }
  focus() { this.focused = true; this.doc.activeElement = this; }
  select() { this.selected = true; }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
}

const IDS = [
  "pi-mode-single", "pi-mode-multi", "pi-ss-each", "pi-ss-full", "pi-ss-none", "pi-count", "pi-notes-visible",
  "pi-debug-mode", "pi-etch-mode", "pi-etch-label", "pi-etch-count", "pi-tailedit-mode", "pi-interact-mode",
  "pi-context", "pi-elements", "pi-delivery", "pi-prepare", "pi-copy-text", "pi-copy-images", "pi-cancel",
  "pi-submit", "pi-close", "pi-use-selected", "pi-cleanup", "pi-status", "pi-manual", "pi-manual-text",
];

function makeDoc() {
  const doc = { activeElement: null, byId: {} };
  for (const id of IDS) doc.byId[id] = new El("x", doc);
  doc.byId["pi-manual"].hidden = true;
  doc.getElementById = (id) => doc.byId[id];
  doc.createElement = (tag) => new El(tag, doc);
  return doc;
}

const sandbox = {};
sandbox.globalThis = sandbox;
loadClassic("chrome-extension/panel/protocol.js", sandbox);
loadClassic("chrome-extension/panel/panel.js", sandbox);
const { createView } = sandbox.PiPanelView;

const session = (over = {}) => ({
  multi: false, screenshotMode: "each", notesVisible: true, debug: false,
  etch: { on: false, count: 0 }, edit: false, interact: false,
  elements: [
    { id: "e1", selector: "#hero", tag: "section", text: "<b>Hello</b>", comment: "bigger", attachments: [], screenshot: true },
    { id: "e2", selector: "a.link", tag: "a", text: "", comment: "", attachments: ["r.webp"], screenshot: false },
  ],
  context: "ctx", managed: false, prepared: null, ...over,
});
const stateMsg = (revision = 1, over = {}, generation = 1) => ({ type: "STATE", generation, revision, session: session(over) });

function setup({ writeText, write, order = [], cleanupPage = null } = {}) {
  const doc = makeDoc();
  const sent = [];
  const clip = {
    writeText: (t) => { order.push("writeText"); return (writeText ?? (async () => {}))(t); },
    write: (items) => { order.push("write"); return (write ?? (async () => {}))(items); },
  };
  class ClipboardItem { constructor(map) { this.map = map; } }
  const view = createView({
    document: doc,
    send: (m) => { order.push("send"); sent.push(m); },
    clipboard: clip,
    ClipboardItem,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    useSelected: null,
    cleanupPage,
  });
  return { doc, sent, view, order };
}

const preparedMsg = (over = {}) => ({
  type: "PREPARED", preparedId: "p1", revision: 1, text: "## Output\nação ✓", images: [{ dataUrl: "data:image/png;base64,AAAA" }], ...over,
});
const tick = () => new Promise((r) => setImmediate(r));

test("elements render from a fixed STATE and text is set by textContent only", () => {
  const { doc, view } = setup();
  view.handleMessage(stateMsg());
  const list = doc.byId["pi-elements"];
  assert.equal(list.children.length, 2);
  const [row1, row2] = list.children;
  assert.equal(row1.children[0].children[1].textContent, "#hero");
  assert.equal(row1.children[0].children[0].textContent, "1");
  assert.equal(row2.children[0].children[0].textContent, "2");
  // page data went in as text, never as markup
  assert.equal(row1.children[2].textContent, "<section> <b>Hello</b>");
  assert.equal(row1.html, null);
  assert.equal(row1.children[1].value, "bigger");
  assert.match(row2.children[2].textContent, /1 reference image\(s\): r\.webp \| no screenshot/);
  assert.equal(doc.byId["pi-count"].textContent, "2 selected");
  assert.equal(doc.byId["pi-context"].value, "ctx");
  for (const el of Object.values(doc.byId)) assert.equal(el.html, null);
});

test("the delivery label follows managed or unmanaged", () => {
  const { doc, view } = setup();
  view.handleMessage(stateMsg(1, { managed: true }));
  assert.equal(doc.byId["pi-delivery"].textContent, "Sends to the waiting caller");
  view.handleMessage(stateMsg(2, { managed: false }));
  assert.equal(doc.byId["pi-delivery"].textContent, "Sends to the last active agent");
});

test("controls send validated ACTION messages with the current generation", () => {
  const { doc, sent, view } = setup();
  doc.byId["pi-submit"].fire("click");
  assert.equal(sent.length, 0, "no state yet, nothing is sent");
  view.handleMessage(stateMsg(1, {}, 7));
  doc.byId["pi-mode-multi"].fire("click");
  doc.byId["pi-submit"].fire("click");
  doc.byId["pi-elements"].children[0].children[0].children[4].fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.map((m) => [m.generation, m.name, m.args]))), [
    [7, "setMulti", { value: true }],
    [7, "submit", {}],
    [7, "removeElement", { id: "e1" }],
  ]);
  const P = sandbox.PiPanelProtocol;
  for (const m of sent) assert.equal(P.validateAction({ generation: m.generation, name: m.name, args: m.args }, { generation: 7, elementIds: ["e1", "e2"] }).ok, true);
});

test("Cleanup calls env.cleanupPage without a session and sends no ACTION", () => {
  const calls = [];
  const { doc, sent } = setup({ cleanupPage: (report) => { calls.push("cleanup"); report("Page cleaned.", "ok"); } });
  doc.byId["pi-cleanup"].fire("click");
  assert.deepEqual(calls, ["cleanup"]);
  assert.equal(sent.length, 0);
  assert.equal(doc.byId["pi-status"].textContent, "Page cleaned.");
  // frame mode has no cleanupPage: the click is a no-op, never a throw
  const frame = setup();
  frame.doc.byId["pi-cleanup"].fire("click");
  assert.equal(frame.sent.length, 0);
});

test("Copy is disabled before PREPARED", () => {
  const { doc, view } = setup();
  assert.equal(doc.byId["pi-copy-text"].disabled, true);
  view.handleMessage(stateMsg());
  assert.equal(doc.byId["pi-copy-text"].disabled, true);
  view.handleMessage(preparedMsg());
  assert.equal(doc.byId["pi-copy-text"].disabled, false);
  assert.equal(doc.byId["pi-copy-images"].children.length, 1);
  assert.equal(doc.byId["pi-copy-images"].children[0].disabled, false);
});

test("Copy calls clipboard.writeText directly, with no transport call before it", async () => {
  const order = [];
  const calls = [];
  const { doc, view } = setup({ order, writeText: async (t) => { calls.push(t); } });
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  order.length = 0;
  doc.byId["pi-copy-text"].fire("click");
  assert.deepEqual(order, ["writeText"], "writeText is the first and only call in the handler");
  assert.deepEqual(calls, ["## Output\nação ✓"]);
});

test("Copied shows only after the promise resolves", async () => {
  let resolveWrite;
  const { doc, view } = setup({ writeText: () => new Promise((r) => { resolveWrite = r; }) });
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  doc.byId["pi-copy-text"].fire("click");
  await tick();
  assert.notEqual(doc.byId["pi-status"].textContent, "Copied");
  resolveWrite();
  await tick();
  assert.equal(doc.byId["pi-status"].textContent, "Copied");
  assert.equal(doc.byId["pi-manual"].hidden, true);
});

test("a rejected write shows the error name and message and the manual copy box with the text", async () => {
  const err = Object.assign(new Error("Document is not focused"), { name: "NotAllowedError" });
  const { doc, view } = setup({ writeText: async () => { throw err; } });
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  doc.byId["pi-copy-text"].fire("click");
  await tick();
  const status = doc.byId["pi-status"].textContent;
  assert.match(status, /NotAllowedError: Document is not focused/);
  assert.match(status, /Press Ctrl\+C to copy/);
  assert.notEqual(status, "Copied");
  assert.equal(doc.byId["pi-manual"].hidden, false);
  assert.equal(doc.byId["pi-manual-text"].value, "## Output\nação ✓");
  assert.equal(doc.byId["pi-manual-text"].selected, true);
});

test("a synchronous clipboard throw also lands in the manual copy box", async () => {
  const { doc, view } = setup({ writeText: () => { throw new Error("blocked"); } });
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  doc.byId["pi-copy-text"].fire("click");
  await tick();
  assert.equal(doc.byId["pi-manual"].hidden, false);
});

test("a newer revision disables both Copy buttons and asks to prepare again", () => {
  const { doc, view } = setup();
  view.handleMessage(stateMsg(1));
  view.handleMessage(preparedMsg({ revision: 1 }));
  assert.equal(doc.byId["pi-copy-text"].disabled, false);
  view.handleMessage(stateMsg(2));
  assert.equal(doc.byId["pi-copy-text"].disabled, true);
  assert.equal(doc.byId["pi-copy-images"].children[0].disabled, true);
  assert.match(doc.byId["pi-status"].textContent, /Prepare again/);
});

test("Copy image calls clipboard.write with the prebuilt item", async () => {
  const order = [];
  const seen = [];
  const { doc, view } = setup({ order, write: async (items) => { seen.push(items); } });
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  order.length = 0;
  doc.byId["pi-copy-images"].children[0].fire("click");
  assert.deepEqual(order, ["write"]);
  assert.equal(seen[0].length, 1);
  assert.equal(seen[0][0].map["image/png"].type, "image/png");
  await tick();
  assert.match(doc.byId["pi-status"].textContent, /Copied image 1/);
});

test("Prepare output sends prepareOutput, clears old output, and shows a host error", () => {
  const { doc, sent, view } = setup();
  view.handleMessage(stateMsg());
  view.handleMessage(preparedMsg());
  doc.byId["pi-prepare"].fire("click");
  assert.equal(sent.at(-1).name, "prepareOutput");
  assert.equal(doc.byId["pi-copy-text"].disabled, true);
  view.handleMessage({ type: "PREPARED", preparedId: "x", revision: 1, error: "Update the native host to copy output" });
  assert.equal(doc.byId["pi-status"].textContent, "Update the native host to copy output");
  assert.equal(doc.byId["pi-copy-text"].disabled, true);
});

test("old generations and old revisions are ignored; a typed field is not overwritten", () => {
  const { doc, view } = setup();
  view.handleMessage(stateMsg(5, { context: "new" }, 2));
  view.handleMessage(stateMsg(9, { context: "old gen" }, 1));
  view.handleMessage(stateMsg(4, { context: "old rev" }, 2));
  assert.equal(doc.byId["pi-context"].value, "new");
  doc.byId["pi-context"].value = "typing";
  doc.activeElement = doc.byId["pi-context"];
  view.handleMessage(stateMsg(6, { context: "server" }, 2));
  assert.equal(doc.byId["pi-context"].value, "typing");
});

test("rows are kept across STATE updates and removed rows disappear", () => {
  const { doc, view } = setup();
  view.handleMessage(stateMsg(1));
  const firstRow = doc.byId["pi-elements"].children[0];
  view.handleMessage(stateMsg(2, { elements: [session().elements[0]] }));
  assert.equal(doc.byId["pi-elements"].children.length, 1);
  assert.equal(doc.byId["pi-elements"].children[0], firstRow);
});

test("invalid STATE messages are ignored", () => {
  const { doc, view } = setup();
  view.handleMessage({ type: "STATE", generation: 1, revision: 1, session: { nope: true } });
  assert.equal(view.state, null);
  assert.equal(doc.byId["pi-elements"].children.length, 0);
});

// ── frame boot: token tries ─────────────────────────────────────────────
function frameBoot() {
  const listeners = {};
  const parent = { posted: [], postMessage(msg, origin) { this.posted.push([JSON.parse(JSON.stringify(msg)), origin]); } };
  const ports = [];
  const handled = [];
  const statuses = [];
  const bound = [];
  const root = sandbox;
  root.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  root.parent = parent;
  root.document = { querySelector: () => null };
  root.chrome = {
    runtime: {
      connect: (info) => {
        const port = {
          info, sent: [], onMsg: [], onDisc: [],
          onMessage: { addListener: (fn) => port.onMsg.push(fn) },
          onDisconnect: { addListener: (fn) => port.onDisc.push(fn) },
          postMessage: (m) => port.sent.push(JSON.parse(JSON.stringify(m))),
        };
        ports.push(port);
        return port;
      },
    },
  };
  const view = {
    handleMessage: (m) => handled.push(m),
    setStatus: (text) => statuses.push(text),
    sendAction() {},
  };
  sandbox.PiPanelView.bootFrame(view, (p) => bound.push(p));
  const token = (token, source = parent) => (listeners.message || []).forEach((fn) => fn({ source, data: { type: "PI_FRAME_TOKEN", token } }));
  return { ports, handled, statuses, bound, parent, token };
}

test("frame: three false tokens fail visibly; the fourth message is ignored", () => {
  const t = frameBoot();
  for (let i = 0; i < 3; i++) t.token(`fake${i}`);
  assert.equal(t.ports.length, 3);
  assert.deepEqual(t.ports.map((p) => p.sent[0]), [
    { type: "FRAME_HELLO", token: "fake0" }, { type: "FRAME_HELLO", token: "fake1" }, { type: "FRAME_HELLO", token: "fake2" },
  ]);
  assert.deepEqual(t.ports.map((p) => p.info.name), ["pi-frame", "pi-frame", "pi-frame"]);
  // background closes each false port
  t.ports.forEach((p) => p.onDisc.forEach((fn) => fn()));
  assert.deepEqual(t.statuses, ["Panel not connected; close and start again"]);
  t.token("real");
  assert.equal(t.ports.length, 3, "no fourth port");
});

test("frame: the real token after two false ones binds, and a bound close asks for a new token", () => {
  const t = frameBoot();
  t.token("fake0");
  t.token("fake1");
  t.token("real");
  t.ports[0].onDisc.forEach((fn) => fn());
  t.ports[1].onDisc.forEach((fn) => fn());
  t.ports[2].onMsg.forEach((fn) => fn({ type: "HELLO_ACK" }));
  assert.equal(t.bound.length, 1);
  assert.equal(t.bound[0], t.ports[2]);
  assert.deepEqual(t.statuses, []);
  // STATE from the bound port reaches the view; from an unbound port it does not
  t.ports[2].onMsg.forEach((fn) => fn({ type: "STATE", generation: 1 }));
  t.ports[0].onMsg.forEach((fn) => fn({ type: "STATE", generation: 9 }));
  assert.deepEqual(t.handled.map((m) => m.generation), [1]);
  // a message after binding does not open another port
  t.token("late");
  assert.equal(t.ports.length, 3);
  // a service-worker restart closes the bound port
  t.ports[2].onDisc.forEach((fn) => fn());
  assert.deepEqual(t.parent.posted, [[{ type: "PI_FRAME_UNBOUND" }, "*"]]);
  assert.equal(t.bound.at(-1), null);
  // the counter was reset: a new token opens a new port
  t.token("again");
  assert.equal(t.ports.length, 4);
});

test("frame: a token message that does not come from window.parent is ignored", () => {
  const t = frameBoot();
  t.token("x", { not: "parent" });
  assert.equal(t.ports.length, 0);
});
