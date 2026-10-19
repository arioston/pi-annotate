import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  announceDir,
  claimsPath,
  listRecords,
  parseClaims,
  readClaims,
  readRecordFile,
  removeRecord,
  writeRecord,
} from "../src/announce.ts";

// tests/fixtures/announce/ is a byte copy of Dalinar's
// skills/surf-target/test/fixtures/announce/. The recorded checksum list
// sits beside (not inside) the copy so the directory itself stays
// byte-identical to the Dalinar side.
const fixtures = new URL("./fixtures/announce/", import.meta.url).pathname;
const checksumList = new URL("./fixtures/announce.sha256sum", import.meta.url).pathname;

const fixture = (name) => readRecordFile(join(fixtures, `${name}.json`));
const claimsFixture = (name) => JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"));

test("shared fixtures match the recorded checksum list (drift fails here)", () => {
  const recorded = readFileSync(checksumList, "utf8").split("\n").filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, `malformed checksum line: ${line}`);
    return [match[2], match[1]];
  });
  const actual = readdirSync(fixtures).sort().map((file) => [file, createHash("sha256").update(readFileSync(join(fixtures, file))).digest("hex")]);
  assert.deepEqual(actual, recorded.sort(([a], [b]) => a.localeCompare(b)));
});

test("record fixtures classify exactly as the Dalinar selftest expects", () => {
  for (const name of ["valid-surf", "valid-annotate", "unlabeled", "dead-pid"]) {
    const entry = fixture(name);
    assert.ok(entry.record, `${name} should validate: ${entry.error ?? entry.skip}`);
  }
  assert.equal(fixture("unlabeled").record.label, undefined);
  assert.equal(fixture("valid-annotate").record.endpoint.browserId, "example-annotate-browser-id");
  assert.match(fixture("unknown-version").skip ?? "", /unknown version 2/);
  assert.equal(fixture("unknown-version").record, undefined);
  for (const name of ["malformed", "mismatched-filename", "bad-dead-since"]) {
    const entry = fixture(name);
    assert.ok(entry.error, `${name} should be malformed`);
    assert.equal(entry.record, undefined);
  }
  assert.equal(fixture("malformed").error, "malformed JSON");
  assert.equal(fixture("mismatched-filename").error, "instanceId does not match file name");
  assert.equal(fixture("bad-dead-since").error, "invalid endpointDeadSince");
});

test("claims fixtures classify exactly as the Dalinar selftest expects", () => {
  assert.deepEqual(parseClaims(claimsFixture("claims-valid")).claims.work, { surf: "example-surf-ext-id", annotate: "example-annotate-browser-id" });
  for (const name of ["claims-bad-version", "claims-duplicate-instance", "claims-unknown-capability", "claims-nonstring-id"]) {
    assert.throws(() => parseClaims(claimsFixture(name)), /Invalid/, name);
  }
});

test("registry and claims paths follow the contract precedence", () => {
  assert.equal(announceDir({ DALINAR_BROWSER_ANNOUNCE_DIR: "/x/announce", XDG_RUNTIME_DIR: "/run/user/1" }), "/x/announce");
  assert.equal(announceDir({ XDG_RUNTIME_DIR: "/run/user/1" }), "/run/user/1/dalinar/browser-announce");
  assert.match(announceDir({}), /\.cache\/dalinar\/browser-announce$/);
  assert.equal(claimsPath({ SURF_TARGETS_CONFIG_DIR: "/c" }), "/c/claims.json");
  assert.match(claimsPath({}), /\.config\/surf-targets\/claims\.json$/);
});

test("writer round-trips, overwrites one file per instance, and keeps startedAt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "announce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "registry");
  const first = writeRecord({ instanceId: "browser-1", label: "work", capability: "annotate", browser: "google chrome", pid: process.pid, endpoint: { browserId: "browser-1" } }, dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "browser-1.json")).mode & 0o777, 0o600);
  await new Promise((resolve) => setTimeout(resolve, 5));
  writeRecord({ instanceId: "browser-1", label: "personal", capability: "annotate", browser: "google chrome", pid: process.pid, endpoint: { browserId: "browser-1" } }, dir);
  const entries = listRecords(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.label, "personal");
  assert.equal(entries[0].record.startedAt, first.startedAt);
  assert.deepEqual(readdirSync(dir), ["browser-1.json"]);
  writeRecord({ instanceId: "unlabeled-1", capability: "annotate", browser: "chromium", pid: process.pid, endpoint: { browserId: "unlabeled-1" } }, dir);
  assert.equal(listRecords(dir).find((entry) => entry.file === "unlabeled-1.json").record.label, undefined);
  assert.throws(() => writeRecord({ instanceId: "bad id", capability: "annotate", pid: 1, endpoint: { browserId: "x" } }, dir), /invalid instanceId/);
  assert.throws(() => writeRecord({ instanceId: "b", label: "Work", capability: "annotate", pid: 1, endpoint: { browserId: "x" } }, dir), /invalid label/);
  assert.throws(() => writeRecord({ instanceId: "b", capability: "annotate", browser: "Google Chrome", pid: 1, endpoint: { browserId: "x" } }, dir), /invalid browser/);
  assert.equal(listRecords(join(root, "absent")).length, 0);
});

test("removal is best-effort and only removes the caller's own record", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "announce-remove-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeRecord({ instanceId: "browser-1", capability: "annotate", browser: "chrome", pid: process.pid, endpoint: { browserId: "browser-1" } }, dir);
  assert.equal(removeRecord("browser-1", process.pid + 1, dir), false);
  assert.equal(listRecords(dir).length, 1);
  assert.equal(removeRecord("browser-1", process.pid, dir), true);
  assert.equal(listRecords(dir).length, 0);
  assert.equal(removeRecord("browser-1", process.pid, dir), false);
  assert.equal(removeRecord("../escape", process.pid, dir), false);
});

test("writer and claims reader refuse a registry or config other users can write", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "announce-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o777);
  assert.throws(() => writeRecord({ instanceId: "b", capability: "annotate", pid: 1, endpoint: { browserId: "b" } }, dir), /writable by other users/);
  assert.throws(() => readClaims(join(dir, "claims.json")), /writable by other users/);
  chmodSync(dir, 0o700);
  assert.equal(readClaims(join(dir, "claims.json")), null);
  writeFileSync(join(dir, "claims.json"), "{", { mode: 0o600 });
  assert.throws(() => readClaims(join(dir, "claims.json")), /Invalid claims format/);
  writeFileSync(join(dir, "claims.json"), JSON.stringify({ version: 1, claims: { work: { annotate: "id-1" } } }));
  assert.equal(readClaims(join(dir, "claims.json")).claims.work.annotate, "id-1");
});
