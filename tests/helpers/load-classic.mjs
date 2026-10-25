import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Load a classic extension script in a fresh context and return the sandbox.
 * The script sets its global on `globalThis`; read it from the sandbox.
 */
export function loadClassic(relativePath, sandbox = {}) {
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), "utf8"), context, { filename: relativePath });
  return sandbox;
}

export function loadClassicGlobal(relativePath, name, sandbox = {}) {
  return loadClassic(relativePath, sandbox)[name];
}

export { root as repoRoot };
