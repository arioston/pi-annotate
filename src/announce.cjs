"use strict";

// Browser rendezvous registry: announce records and label claims (Dalinar
// plan 971). The record and claim contracts are shared with Dalinar's
// skills/surf-target/bin/announce.mjs; tests/fixtures/announce/ is a byte
// copy of that skill's fixture directory, and both suites must classify
// every fixture the same way. src/announce.ts is the typed entry point; this
// CommonJS body exists so the native host (plain Node, no loader) shares the
// exact same writer.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$(?![\s\S])/;
const INSTANCE_PATTERN = /^[A-Za-z0-9._-]{1,128}$(?![\s\S])/;
const CAPABILITIES = ["surf", "annotate"];

function announceDir(env = process.env) {
  if (env.DALINAR_BROWSER_ANNOUNCE_DIR) return env.DALINAR_BROWSER_ANNOUNCE_DIR;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "dalinar", "browser-announce");
  return path.join(os.homedir(), ".cache", "dalinar", "browser-announce");
}

function surfTargetsConfigDir(env = process.env) {
  return env.SURF_TARGETS_CONFIG_DIR || path.join(os.homedir(), ".config", "surf-targets");
}

function claimsPath(env = process.env) {
  return path.join(surfTargetsConfigDir(env), "claims.json");
}

/**
 * Validate one parsed record. Returns { record } for a valid version-1
 * record, { skip } for an unknown (newer) version, or { error } for anything
 * malformed. The file name must equal `<instanceId>.json`.
 */
function validateRecord(parsed, fileName) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not an object" };
  if (parsed.version !== 1) {
    if (typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version > 1) return { skip: `unknown version ${parsed.version}` };
    return { error: "invalid version" };
  }
  if (typeof parsed.instanceId !== "string" || !INSTANCE_PATTERN.test(parsed.instanceId)) return { error: "invalid instanceId" };
  if (`${parsed.instanceId}.json` !== fileName) return { error: "instanceId does not match file name" };
  if (parsed.label !== undefined && (typeof parsed.label !== "string" || !LABEL_PATTERN.test(parsed.label))) return { error: "invalid label" };
  if (!CAPABILITIES.includes(parsed.capability)) return { error: "invalid capability" };
  if (typeof parsed.browser !== "string" || !parsed.browser.trim() || parsed.browser !== parsed.browser.toLowerCase()) return { error: "invalid browser" };
  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return { error: "invalid pid" };
  if (parsed.endpoint === null || typeof parsed.endpoint !== "object" || Array.isArray(parsed.endpoint)) return { error: "invalid endpoint" };
  if (parsed.capability === "surf" && (typeof parsed.endpoint.socketPath !== "string" || !parsed.endpoint.socketPath.startsWith("/"))) return { error: "surf endpoint needs an absolute socketPath" };
  if (parsed.capability === "annotate" && (typeof parsed.endpoint.browserId !== "string" || !parsed.endpoint.browserId.trim())) return { error: "annotate endpoint needs a browserId" };
  if (typeof parsed.startedAt !== "string" || typeof parsed.updatedAt !== "string") return { error: "invalid timestamps" };
  if (parsed.endpointDeadSince !== undefined && (typeof parsed.endpointDeadSince !== "string" || !Number.isFinite(Date.parse(parsed.endpointDeadSince)))) return { error: "invalid endpointDeadSince" };
  return { record: parsed };
}

/** Classify one record file: { file, record? , skip?, error? }. */
function readRecordFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { file: path.basename(file), error: "malformed JSON" }; }
  return { file: path.basename(file), ...validateRecord(parsed, path.basename(file)) };
}

/** Read every *.json in the registry directory. Absent directory = none. */
function listRecords(directory = announceDir()) {
  let entries;
  try { entries = fs.readdirSync(directory); }
  catch (error) { if (error && error.code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => readRecordFile(path.join(directory, entry)));
}

/**
 * The registry trusts the uid boundary (contract 9): refuse a directory or
 * file another user owns or can write, never repair it.
 */
function assertPrivatePath(target, what) {
  let stats;
  try { stats = fs.statSync(target); } catch { return; }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error(`${what} ${target} is not owned by this user; refusing to touch it`);
  if ((stats.mode & 0o022) !== 0) throw new Error(`${what} ${target} is writable by other users (mode ${(stats.mode & 0o777).toString(8)}); inspect it, remove anything you do not recognize, then run: chmod go-w '${target}'`);
}

/**
 * Write (or overwrite) this announcer's record atomically: temp + rename,
 * mode 0600, directory 0700. A re-announce of the same instance keeps the
 * original startedAt.
 */
function writeRecord(input, directory = announceDir()) {
  const now = new Date().toISOString();
  const record = {
    version: 1,
    instanceId: input.instanceId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    capability: input.capability,
    browser: input.browser || "chrome",
    pid: input.pid,
    endpoint: input.endpoint,
    startedAt: now,
    updatedAt: now,
  };
  const file = `${record.instanceId}.json`;
  const checked = validateRecord(record, file);
  if (!checked.record) throw new Error(`announce: ${checked.error}`);
  assertPrivatePath(directory, "announce registry");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (previous && typeof previous.startedAt === "string") record.startedAt = previous.startedAt;
  } catch { /* first announce for this instance */ }
  const temp = path.join(directory, `.${file}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, path.join(directory, file));
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* already renamed */ }
  }
  return record;
}

/**
 * Best-effort removal on disconnect. Removes the record only while it is
 * still ours (same pid), so a newer host for the same instance keeps its
 * fresh record.
 */
function removeRecord(instanceId, pid, directory = announceDir()) {
  if (typeof instanceId !== "string" || !INSTANCE_PATTERN.test(instanceId)) return false;
  const file = path.join(directory, `${instanceId}.json`);
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!current || current.pid !== pid) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Validate a parsed claims document; throws on any contract violation. */
function parseClaims(input) {
  if (!input || input.version !== 1 || !input.claims || typeof input.claims !== "object" || Array.isArray(input.claims)) throw new Error("Invalid claims format");
  const ids = new Set();
  for (const [label, entry] of Object.entries(input.claims)) {
    if (!LABEL_PATTERN.test(label) || entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid claim: ${label}`);
    for (const [capability, id] of Object.entries(entry)) {
      if (!CAPABILITIES.includes(capability) || typeof id !== "string" || !INSTANCE_PATTERN.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate claim: ${label}.${capability}`);
      ids.add(id);
    }
  }
  return input;
}

/**
 * Read claims.json. Returns null when the file is absent (an install that
 * never ran `surf-target claim import`); throws when it is malformed or not
 * private.
 */
function readClaims(file = claimsPath()) {
  assertPrivatePath(path.dirname(file), "claims directory");
  assertPrivatePath(file, "claims file");
  let input;
  try { input = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid claims format: ${file} is not JSON`);
    throw error;
  }
  return parseClaims(input);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && error.code === "EPERM"; }
}

module.exports = {
  LABEL_PATTERN,
  INSTANCE_PATTERN,
  CAPABILITIES,
  announceDir,
  surfTargetsConfigDir,
  claimsPath,
  validateRecord,
  readRecordFile,
  listRecords,
  assertPrivatePath,
  writeRecord,
  removeRecord,
  parseClaims,
  readClaims,
  pidAlive,
};
