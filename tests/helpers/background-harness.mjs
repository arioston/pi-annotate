import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { repoRoot } from "./load-classic.mjs";

// Loads chrome-extension/background.js in a vm context with a fake `chrome`.
// Anything the fake does not define is a stub that accepts every call.
const stub = new Proxy(function () {}, {
  get: (_t, key) => (key === "then" ? undefined : stub),
  apply: () => Promise.resolve(undefined),
});

export const TAB = 7;
export const WINDOW = 1;
export const SENDER = { tab: { id: TAB, windowId: WINDOW }, frameId: 0, url: "https://site.test/", documentId: "doc1" };

/**
 * options.limit      bytes; sendResponse rejects a serialized message above it
 * options.tiles      number of fake pictures the tab gives
 * options.tileBytes  size of each picture before base64
 */
export function loadBackground({ limit = Infinity, tiles = 3, tileBytes = 1000 } = {}) {
  const timers = [];
  const listeners = { message: null, removed: null, updated: null, activated: null };
  const picture = "data:image/png;base64," + Buffer.alloc(tileBytes, 7).toString("base64");
  const view = { left: 0, top: 0, width: 1000, height: 1000 };
  const content = tiles * 1000;
  let active = TAB;

  const chrome = {
    runtime: {
      id: "abc",
      lastError: undefined,
      getURL: (p) => "chrome-extension://abc/" + p,
      getManifest: () => ({ content_scripts: [{ js: [] }] }),
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      connectNative: () => ({ onMessage: stub, onDisconnect: stub, postMessage() {}, disconnect() {} }),
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
      onActivated: { addListener: (fn) => { listeners.activated = fn; } },
      query: async () => [{ id: active, windowId: WINDOW }],
      captureVisibleTab: (_w, _o, cb) => cb(picture),
      sendMessage: async (_tabId, msg) => {
        if (msg.type === "CAPTURE_PAGE_BEGIN") return { dpr: 1, contentHeight: content, visible: view, url: "https://site.test/", title: "t" };
        if (msg.type === "CAPTURE_PAGE_STEP") return { scrollTop: msg.position, contentHeight: content, visible: view };
        return {};
      },
    },
  };

  const withStubs = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : stub) });
  chrome.runtime = withStubs(chrome.runtime);
  chrome.tabs = withStubs(chrome.tabs);
  const context = vm.createContext({
    chrome: withStubs(chrome),
    console: { log() {}, error() {}, warn() {} },
    crypto: webcrypto, atob, Blob, URL, Uint8Array,
    // Short waits run at once. A wait of a minute or more waits for the test.
    setTimeout: (fn, ms) => {
      if (ms >= 60000) { timers.push({ fn, ms }); return timers.length; }
      return setImmediate(fn);
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    importScripts: (...files) => {
      for (const f of files) {
        if (f === "capture/store.js") {
          vm.runInContext("globalThis.PiCaptureStore = { cleanup: async () => {}, save: async () => 'id' };", context);
          continue;
        }
        vm.runInContext(fs.readFileSync(path.join(repoRoot, "chrome-extension", f), "utf8"), context, { filename: f });
      }
    },
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(repoRoot, "chrome-extension", "background.js"), "utf8"), context, { filename: "background.js" });

  const sizes = [];
  // Mimics chrome.runtime.sendMessage: the answer is serialized, and a message
  // above the limit is refused. Resolves like PiSafeRuntime.sendMessageSafe.
  function sendFrom(sender, msg) {
    return new Promise((resolve) => {
      const respond = (value) => {
        const size = Buffer.byteLength(JSON.stringify(value ?? null));
        sizes.push(size);
        if (size > limit) resolve({ ok: false, reason: "error", message: "Message length exceeded maximum allowed length" });
        else resolve({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
      };
      const keep = listeners.message(JSON.parse(JSON.stringify(msg)), sender, respond);
      if (keep !== true) setImmediate(() => resolve({ ok: true, value: undefined }));
    });
  }

  return {
    listeners, timers, sizes,
    send: (msg) => sendFrom(SENDER, msg),
    sendFrom,
    setActive: (id) => { active = id; },
    largest: () => Math.max(0, ...sizes),
  };
}
