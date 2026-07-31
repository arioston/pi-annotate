import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

test("one browser host routes concurrent agent clients by request owner", async (t) => {
  const registryDir = await mkdtemp(path.join(process.cwd(), ".pi-annotate-test-"));
  const hostEnv = {
    ...process.env,
    PI_ANNOTATE_REGISTRY_DIR: registryDir,
  };
  delete hostEnv.NODE_TEST_CONTEXT;
  const host = spawn(process.execPath, ["chrome-extension/native/host.cjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: hostEnv,
  });
  let hostError = "";
  host.stderr.on("data", (chunk) => { hostError += chunk.toString(); });
  t.after(async () => {
    if (host.exitCode === null) host.kill("SIGTERM");
    if (host.exitCode === null) await once(host, "exit");
    await rm(registryDir, { recursive: true, force: true });
  });

  const browserId = `test-${process.pid}-${Date.now()}`;
  host.stdin.write(nativeFrame({
    type: "REGISTER_BROWSER",
    id: browserId,
    name: "Integration Test Browser",
    browser: "Chromium Test",
  }));

  const target = await waitFor(
    () => listBrowserTargets(registryDir).find((item) => item.id === browserId),
    async () => {
      const files = await readdir(registryDir);
      const contents = await Promise.all(files.filter((file) => file.endsWith(".json")).map(
        async (file) => readFile(path.join(registryDir, file), "utf8"),
      ));
      return `native host did not publish its browser endpoint (exit=${host.exitCode}, stderr=${hostError}, metadata=${contents.join(";")})`;
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
  const secondResultPromise = second.annotate({ timeout: 3 });
  const secondStart = await waitFor(
    () => extensionMessages.find(
      (message) => message.type === "START_ANNOTATION" && message.requestId !== firstStart.requestId,
    ),
    "second client did not start annotation",
  );

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
    },
  }));
  const secondResult = await secondResultPromise;
  assert.equal(secondResult.success, true);
  assert.equal(secondResult.url, "https://example.test");
});
