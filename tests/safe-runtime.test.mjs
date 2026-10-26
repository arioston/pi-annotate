import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

function load(sendMessage) {
  const sandbox = { chrome: { runtime: { sendMessage } } };
  sandbox.globalThis = sandbox;
  return loadClassic("chrome-extension/lib/safe-runtime.js", sandbox).PiSafeRuntime;
}

test("isInvalidationError matches the three invalidation messages", () => {
  const api = load(async () => {});
  assert.equal(api.isInvalidationError(new Error("Extension context invalidated.")), true);
  assert.equal(api.isInvalidationError(new Error("The message port closed before a response was received.")), true);
  assert.equal(api.isInvalidationError(new Error("Could not establish connection. Receiving end does not exist.")), true);
  assert.equal(api.isInvalidationError(new Error("something else")), false);
});

test("invalidation resolves unavailable", async () => {
  const api = load(async () => { throw new Error("Extension context invalidated."); });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.sendMessageSafe({ type: "X" }))), { ok: false, reason: "unavailable" });
});

test("another error resolves error with the message", async () => {
  const api = load(async () => { throw new Error("boom"); });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.sendMessageSafe({ type: "X" }))), { ok: false, reason: "error", message: "boom" });
});

test("success resolves ok with the value", async () => {
  const api = load(async (payload) => ({ echoed: payload.type }));
  assert.deepEqual(JSON.parse(JSON.stringify(await api.sendMessageSafe({ type: "X" }))), { ok: true, value: { echoed: "X" } });
});

test("a synchronous throw never reaches the caller", async () => {
  const api = load(() => { throw new Error("Extension context invalidated."); });
  const result = await api.sendMessageSafe({ type: "X" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
});

test("a missing chrome object resolves an error, not a throw", async () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const api = loadClassic("chrome-extension/lib/safe-runtime.js", sandbox).PiSafeRuntime;
  const result = await api.sendMessageSafe({ type: "X" });
  assert.equal(result.ok, false);
});
