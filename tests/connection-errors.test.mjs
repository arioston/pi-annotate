import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ConnectionFailureError,
  formatConnectionFailure,
  inspectBrowserRegistryState,
  resolveBrowserTarget,
} from "../src/core.ts";

function makeFsError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

test("real missing registry is reported as registry-missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-missing-"));
  const missingDir = path.join(tempRoot, "registry");
  const inspection = inspectBrowserRegistryState(missingDir);
  assert.equal(inspection.kind, "registry-missing");
  assert.equal(inspection.registryDir, missingDir);
  const message = formatConnectionFailure({
    category: "registry-missing",
    registryDir: missingDir,
    filesystemCode: "ENOENT",
  });
  assert.match(message, /Selected registry directory/);
  assert.match(message, /PI_ANNOTATE_REGISTRY_DIR/);
  assert.doesNotMatch(message, /service worker/i);
  await rm(tempRoot, { recursive: true, force: true });
});

for (const filesystemCode of ["EACCES", "EPERM"]) {
  test(`permission denied seam reports registry-permission-denied for ${filesystemCode}`, () => {
    const registryDir = path.join(os.tmpdir(), ".pi-annotate-permission");
    const inspection = inspectBrowserRegistryState(registryDir, {
      readdirSync() {
        throw makeFsError(filesystemCode);
      },
      readFileSync() {
        throw makeFsError(filesystemCode);
      },
      existsSync() {
        return false;
      },
    });

    assert.equal(inspection.kind, "registry-permission-denied");
    assert.equal(inspection.filesystemCode, filesystemCode);

    const message = formatConnectionFailure({
      category: "registry-permission-denied",
      registryDir,
      filesystemCode,
    });
    assert.match(message, /Selected registry directory/);
    assert.match(message, /PI_ANNOTATE_REGISTRY_DIR/);
    assert.doesNotMatch(message, /service worker/i);
  });
}

test("empty registry remains browser-advice only", async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-empty-"));
  const inspection = inspectBrowserRegistryState(registryDir);
  assert.equal(inspection.kind, "registry-empty");
  const message = formatConnectionFailure({
    category: "registry-empty",
    registryDir,
  });
  assert.match(message, /Click the Pi Annotate icon in the browser to wake the service worker/);
  await rm(registryDir, { recursive: true, force: true });
});

test("vanished metadata is reported as endpoint-disappeared", async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-endpoint-"));
  const metadataPath = path.join(registryDir, "browser.json");
  await writeFile(metadataPath, JSON.stringify({
    id: "browser-1",
    name: "Browser",
    browser: "Chromium",
    socketPath: path.join(registryDir, "browser.sock"),
    tokenPath: path.join(registryDir, "browser.token"),
    pid: process.pid,
    connectedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
  }), "utf8");
  const inspection = inspectBrowserRegistryState(registryDir);
  assert.equal(inspection.kind, "endpoint-disappeared");
  const message = formatConnectionFailure({
    category: "endpoint-disappeared",
    registryDir,
  });
  assert.match(message, /disappeared before AUTH completed/);
  assert.doesNotMatch(message, /service worker/i);
  await rm(registryDir, { recursive: true, force: true });
});

test("legacy selector without legacy files reports legacy-endpoint-disappeared", async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-legacy-"));
  assert.throws(
    () => resolveBrowserTarget("legacy", registryDir),
    (err) => {
      assert.ok(err instanceof ConnectionFailureError);
      assert.equal(err.failure.category, "legacy-endpoint-disappeared");
      assert.equal(err.failure.registryDir, registryDir);
      return true;
    },
  );
  const message = formatConnectionFailure({
    category: "legacy-endpoint-disappeared",
    registryDir,
  });
  assert.match(message, /Legacy \/tmp\/pi-annotate\.sock and \/tmp\/pi-annotate\.token disappeared before AUTH completed/);
  await rm(registryDir, { recursive: true, force: true });
});

async function importCoreInChild(envOverrides, keysToDelete = []) {
  const env = { ...process.env, ...envOverrides };
  for (const key of keysToDelete) delete env[key];
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "-e", "import('./src/core.ts').then(m => console.log('IMPORT_OK', m.REGISTRY_DIR))"],
    {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("invalid explicit PI_ANNOTATE_REGISTRY_DIR fails core.ts import instead of silently falling back to temp", async () => {
  const { code, stdout, stderr } = await importCoreInChild(
    { PI_ANNOTATE_REGISTRY_DIR: "relative/not-absolute" },
    ["XDG_RUNTIME_DIR"],
  );
  assert.notEqual(code, 0);
  assert.doesNotMatch(stdout, /IMPORT_OK/);
  assert.match(stderr, /RuntimePathConfigurationError/);
  assert.match(stderr, /PI_ANNOTATE_REGISTRY_DIR/);
  assert.match(stderr, /absolute/);
});

test("invalid explicit XDG_RUNTIME_DIR fails core.ts import instead of silently falling back to temp", async () => {
  const { code, stdout, stderr } = await importCoreInChild(
    { XDG_RUNTIME_DIR: "relative/xdg" },
    ["PI_ANNOTATE_REGISTRY_DIR"],
  );
  assert.notEqual(code, 0);
  assert.doesNotMatch(stdout, /IMPORT_OK/);
  assert.match(stderr, /RuntimePathConfigurationError/);
  assert.match(stderr, /XDG_RUNTIME_DIR/);
  assert.match(stderr, /absolute/);
});

test("valid explicit PI_ANNOTATE_REGISTRY_DIR still resolves core.ts REGISTRY_DIR normally", async () => {
  const explicitDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-explicit-"));
  try {
    const { code, stdout } = await importCoreInChild(
      { PI_ANNOTATE_REGISTRY_DIR: explicitDir },
      ["XDG_RUNTIME_DIR"],
    );
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`IMPORT_OK ${explicitDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(explicitDir, { recursive: true, force: true });
  }
});
