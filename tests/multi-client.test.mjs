import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AnnotateClient, listBrowserTargets } from "../src/core.ts";

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function readNativeMessages(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4).toString("utf8");
      buffer = buffer.subarray(length + 4);
      onMessage(JSON.parse(body));
    }
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(typeof message === "function" ? await message() : message);
}

async function startHost({ registryDir, tmpdir }) {
  const hostEnv = {
    ...process.env,
    TMPDIR: tmpdir,
    PI_ANNOTATE_REGISTRY_DIR: registryDir,
  };
  delete hostEnv.NODE_TEST_CONTEXT;
  const host = spawn(process.execPath, ["chrome-extension/native/host.cjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: hostEnv,
  });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let resolveReady;
  let rejectReady;
  let resolved = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readNativeMessages(host.stdout, (message) => {
    if (resolved || message?.type !== "BROWSER_REGISTERED") return;
    resolved = true;
    resolveReady(message);
  });
  host.once("exit", () => {
    if (resolved) return;
    rejectReady(new Error(`native host exited before publishing browser metadata (exit=${host.exitCode}, stderr=${stderr})`));
  });
  return { host, stderr: () => stderr, ready };
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await once(proc, "exit");
}

test("one browser host routes concurrent agent clients by request owner", async (t) => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-registry-"));
  const hostTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-host-tmp-"));
  const clientTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-client-tmp-"));
  const { host, stderr, ready } = await startHost({ registryDir, tmpdir: hostTmpdir });

  t.after(async () => {
    await stopProcess(host);
    await rm(registryDir, { recursive: true, force: true });
    await rm(hostTmpdir, { recursive: true, force: true });
    await rm(clientTmpdir, { recursive: true, force: true });
  });

  const browserId = `test-${process.pid}-${Date.now()}`;
  host.stdin.write(nativeFrame({
    type: "REGISTER_BROWSER",
    id: browserId,
    name: "Integration Test Browser",
    browser: "Chromium Test",
  }));

  await ready;
  const target = await waitFor(
    () => listBrowserTargets(registryDir).find((item) => item.id === browserId),
    async () => {
      const files = await readdir(registryDir);
      const contents = await Promise.all(files.filter((file) => file.endsWith(".json")).map(
        async (file) => readFile(path.join(registryDir, file), "utf8"),
      ));
      return `native host did not publish its browser endpoint (exit=${host.exitCode}, stderr=${stderr()}, metadata=${contents.join(";")})`;
    },
  );
  assert.equal(target.name, "Integration Test Browser");

  const extensionMessages = [];
  readNativeMessages(host.stdout, (message) => extensionMessages.push(message));

  const first = new AnnotateClient({ browser: browserId, registryDir });
  const second = new AnnotateClient({ browser: browserId, registryDir });
  const firstResultPromise = first.annotate({ timeout: 3 });

  const firstStart = await waitFor(
    () => extensionMessages.find((message) => message.type === "START_ANNOTATION"),
    "first client did not start annotation",
  );
  const secondResultPromise = second.annotate({ timeout: 3, captureNetwork: true });
  const secondStart = await waitFor(
    () => extensionMessages.find(
      (message) => message.type === "START_ANNOTATION" && message.requestId !== firstStart.requestId,
    ),
    "second client did not start annotation",
  );
  assert.equal(secondStart.captureNetwork, true);

  const firstResult = await firstResultPromise;
  assert.equal(firstResult.cancelled, true);
  assert.match(firstResult.reason, /Another client/);

  host.stdin.write(nativeFrame({
    type: "ANNOTATIONS_COMPLETE",
    requestId: secondStart.requestId,
    result: {
      success: true,
      elements: [],
      url: "https://example.test",
      viewport: { width: 1280, height: 720 },
      network: {
        startedAt: "2026-07-31T12:00:00.000Z",
        endedAt: "2026-07-31T12:00:01.000Z",
        durationMs: 1000,
        truncated: false,
        requests: [],
      },
    },
  }));
  const secondResult = await secondResultPromise;
  assert.equal(secondResult.success, true);
  assert.equal(secondResult.url, "https://example.test");
  assert.equal(secondResult.network.durationMs, 1000);
});

test("isolated TMPDIR clients report the shared registry diagnostic instead of legacy token lookup", async (t) => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-shared-"));
  const hostTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-host-tmp-"));
  const clientTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-isolated-tmp-"));
  const { host, ready } = await startHost({ registryDir, tmpdir: hostTmpdir });

  t.after(async () => {
    await stopProcess(host);
    await rm(registryDir, { recursive: true, force: true });
    await rm(hostTmpdir, { recursive: true, force: true });
    await rm(clientTmpdir, { recursive: true, force: true });
  });

  const browserId = `test-${process.pid}-${Date.now()}-isolated`;
  host.stdin.write(nativeFrame({
    type: "REGISTER_BROWSER",
    id: browserId,
    name: "Shared Registry Browser",
    browser: "Chromium Test",
  }));

  await ready;
  await waitFor(
    () => listBrowserTargets(registryDir).find((item) => item.id === browserId),
    "host did not publish endpoint",
  );

  const coreModuleUrl = new URL("../src/core.ts", import.meta.url).href;
  const childScript = `
    import { AnnotateClient } from ${JSON.stringify(coreModuleUrl)};
    try {
      const client = new AnnotateClient({ browser: ${JSON.stringify(browserId)} });
      await client.annotate({ timeout: 1 });
      console.log(JSON.stringify({ ok: true }));
    } catch (err) {
      console.log(JSON.stringify({
        ok: false,
        category: err instanceof Error && "failure" in err && err.failure ? err.failure.category : null,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  `;

  const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TMPDIR: clientTmpdir,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.category, "registry-missing");
  assert.match(payload.message, /Selected registry directory/);
  assert.doesNotMatch(payload.message, /pi-annotate\.token/i);
});
