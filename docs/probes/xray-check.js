/**
 * Pi Annotate - X-ray core source check (plan 1168)
 *
 * NODE SCRIPT. Loads chrome-extension/xray/measure.js and asserts the source
 * rules of the core: it exports the pure functions, it makes no computed-style
 * call, and it has no extension API or network reference. Comments are
 * stripped before the text checks, so a comment may name a rule.
 *
 * Run: node docs/probes/xray-check.js
 * Exit code 0 = all assertions passed. Non-zero = at least one failed.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = "chrome-extension/xray/measure.js";
const src = fs.readFileSync(path.join(root, file), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const sandbox = {};
vm.runInContext(src, vm.createContext(sandbox), { filename: file });
const m = sandbox.__piXray && sandbox.__piXray.measure;

assert.ok(m, "measure.js did not register __piXray.measure");
["snapFrame", "chooseRoot", "isBlock", "gapsOf", "paddingsOf", "radiiOf", "toCss", "isOnGrid", "measure"].forEach((name) => {
  assert.equal(typeof m[name], "function", `${name} missing`);
});

const banned = [
  [/getComputedStyle/, "a computed-style call"],
  [/\bchrome\./, "an extension API reference"],
  [/\bdocument\b/, "a document reference"],
  [/\bwindow\b/, "a window reference"],
  [/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, "a network API"],
  [/\brequestAnimationFrame|setTimeout|setInterval/, "a timer or frame callback"],
];
banned.forEach(([re, what]) => assert.ok(!re.test(code), `core source holds ${what}`));

console.log("all assertions passed");
