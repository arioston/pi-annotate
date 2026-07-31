#!/usr/bin/env node
/**
 * Launcher for the Pi Annotate MCP server (TypeScript entry via tsx).
 * Keeps stdout reserved for MCP JSON-RPC.
 *
 * Requires the `tsx` runtime dependency (always installed with this package).
 * Native --experimental-strip-types is intentionally not used: source imports
 * use .js specifiers that only resolve under tsx's TypeScript loader.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const entry = join(root, "src", "mcp-server.ts");

function resolveTsxImport() {
  const require = createRequire(join(root, "package.json"));
  try {
    // Prefer the ESM loader entry
    return pathToFileURL(require.resolve("tsx/esm")).href;
  } catch {
    try {
      return pathToFileURL(require.resolve("tsx")).href;
    } catch {
      return null;
    }
  }
}

const tsxImport = resolveTsxImport();
if (!tsxImport) {
  console.error(
    "pi-annotate-mcp requires the tsx package. Run: npm install (or reinstall pi-annotate).",
  );
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", tsxImport, entry], {
  stdio: "inherit",
  env: process.env,
  cwd: root,
});

let shuttingDown = false;

function forwardSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.killed && child.exitCode === null) {
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => forwardSignal(signal));
}

// If the parent stdin closes (common MCP host shutdown), stop the child.
process.stdin?.on?.("end", () => forwardSignal("SIGTERM"));
process.stdin?.on?.("close", () => forwardSignal("SIGTERM"));

child.on("error", (err) => {
  console.error("Failed to start pi-annotate MCP server:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Prefer exiting with the same signal so hosts see a clean shutdown reason.
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(code ?? 1);
});
