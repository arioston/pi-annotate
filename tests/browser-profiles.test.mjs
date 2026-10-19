import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBrowserSelector, parseBindings, boundBrowserId } from "../src/browser-profiles.ts";
import { resolveBrowserTarget, listBrowserTargets } from "../src/core.ts";

test("effective selector preserves explicit and legacy precedence", () => {
  const env = { BROWSER_PROFILE: "work", PI_ANNOTATE_BROWSER: "old" };
  assert.equal(effectiveBrowserSelector(" explicit ", env), "explicit");
  assert.equal(effectiveBrowserSelector("", env), "old");
  assert.equal(effectiveBrowserSelector(undefined, { BROWSER_PROFILE: "work" }), "surf:work");
  assert.equal(effectiveBrowserSelector(undefined, {}), "");
  assert.throws(() => effectiveBrowserSelector(undefined, { BROWSER_PROFILE: "" }));
  assert.equal(effectiveBrowserSelector("id", { BROWSER_PROFILE: "INVALID" }), "id");
});
test("binding parser rejects malformed and duplicate IDs", () => {
  assert.deepEqual(parseBindings({ version: 1, bindings: { work: "id" } }), { work: "id" });
  for (const value of [null, { version: 2, bindings: {} }, { version: 1, bindings: { Work: "id" } }, { version: 1, bindings: { work: "id", other: "id" } }, { version: 1, bindings: { work: "" } }]) assert.throws(() => parseBindings(value));
});
test("bindings read current data and reserved selectors never use legacy discovery", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "targets.tsv"), "work\text\tdata\tprofile\taccount\textdir\nmissing\text\tdata\tprofile\taccount\textdir\n");
  const file = join(dir, "annotate-bindings.json");
  writeFileSync(file, JSON.stringify({ version: 1, bindings: { work: "first" } }));
  assert.equal(boundBrowserId("surf:work", file), "first");
  writeFileSync(file, JSON.stringify({ version: 1, bindings: { work: "second" } }));
  assert.equal(boundBrowserId("surf:work", file), "second");
  assert.throws(() => boundBrowserId("surf:missing", file), /No annotation binding/);
  const old = process.env.SURF_TARGETS_CONFIG_DIR;
  process.env.SURF_TARGETS_CONFIG_DIR = dir;
  try { assert.throws(() => resolveBrowserTarget("surf:work", dir), /disconnected/); }
  finally { if (old === undefined) delete process.env.SURF_TARGETS_CONFIG_DIR; else process.env.SURF_TARGETS_CONFIG_DIR = old; }
});

test("shared binding uses IDs across same-account and signed-out profiles, and rejects duplicates", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "binding-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "targets.tsv"), "work\text\tdata\tprofile\t\textdir\n");
  writeFileSync(join(dir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: "exact-id" } }));
  const add = (key, id, name, account) => {
    const socketPath = join(dir, `${key}.sock`);
    const tokenPath = join(dir, `${key}.token`);
    writeFileSync(socketPath, ""); writeFileSync(tokenPath, "");
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ id, name, account, browser: "Test", pid: process.pid, socketPath, tokenPath, connectedAt: "now", updatedAt: "now" }));
  };
  add("first", "exact-id", "work", "same@example.test");
  add("collision", "other-id", "exact-id", "same@example.test");
  add("signedout", "signedout-id", "work");
  const old = process.env.SURF_TARGETS_CONFIG_DIR;
  process.env.SURF_TARGETS_CONFIG_DIR = dir;
  try {
    assert.equal(resolveBrowserTarget("surf:work", dir).id, "exact-id");
    writeFileSync(join(dir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: "signedout-id" } }));
    assert.equal(resolveBrowserTarget("surf:work", dir).id, "signedout-id");
    writeFileSync(join(dir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: "exact-id" } }));
    add("duplicate", "exact-id", "same account");
    assert.equal(listBrowserTargets(dir).filter((target) => target.id === "exact-id").length, 1);
    assert.throws(() => resolveBrowserTarget("surf:work", dir), /ambiguous/);
  } finally { if (old === undefined) delete process.env.SURF_TARGETS_CONFIG_DIR; else process.env.SURF_TARGETS_CONFIG_DIR = old; }
});

test("claims resolution refuses malformed, dead, and duplicated announcers and skips unknown versions", async (t) => {
  const { resolveSurfBrowserId } = await import("../src/browser-profiles.ts");
  const root = mkdtempSync(join(tmpdir(), "claims-resolve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const announce = join(root, "announce");
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(announce, { mode: 0o700 });
  const env = { SURF_TARGETS_CONFIG_DIR: config, DALINAR_BROWSER_ANNOUNCE_DIR: announce };
  writeFileSync(join(config, "claims.json"), JSON.stringify({ version: 1, claims: { work: { annotate: "claimed-id" } } }), { mode: 0o600 });
  const record = (id, fields = {}) => writeFileSync(join(announce, `${id}.json`), JSON.stringify({ version: 1, instanceId: id, label: "work", capability: "annotate", browser: "chrome", pid: process.pid, endpoint: { browserId: id }, startedAt: "t", updatedAt: "t", ...fields }));

  record("claimed-id");
  assert.equal(resolveSurfBrowserId("surf:work", ["claimed-id", "other"], env), "claimed-id");
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id", "claimed-id"], env), /published by 2 native hosts/);
  assert.throws(() => resolveSurfBrowserId("surf:work", [], env), /No live Pi Annotate announcer/);
  record("claimed-id", { pid: 999999999 });
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id"], env), /No live Pi Annotate announcer/);
  writeFileSync(join(announce, "claimed-id.json"), "{");
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id"], env), /claimed instance claimed-id is malformed/);
  writeFileSync(join(announce, "claimed-id.json"), JSON.stringify({ version: 2, instanceId: "claimed-id", label: "work", capability: "annotate" }));
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id"], env), /No live Pi Annotate announcer/);
  record("claimed-id", { capability: "surf", endpoint: { socketPath: "/x.sock" } });
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id"], env), /No live Pi Annotate announcer/);
  writeFileSync(join(config, "claims.json"), JSON.stringify({ version: 1, claims: { work: { surf: "a", annotate: "a" } } }));
  assert.throws(() => resolveSurfBrowserId("surf:work", ["claimed-id"], env), /Invalid or duplicate claim/);
  assert.throws(() => resolveSurfBrowserId("surf:Work", ["claimed-id"], env), /Invalid Surf label/);
});
