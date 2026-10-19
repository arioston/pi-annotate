import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AnnotateClient, listBrowserTargets, resolveBrowserTarget } from "../src/core.ts";

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

async function startHost({ registryDir, tmpdir, announceDir = path.join(tmpdir, "announce") }) {
  // Every spawned host announces into a per-test directory, never into the
  // operator's real rendezvous registry.
  const hostEnv = {
    ...process.env,
    TMPDIR: tmpdir,
    PI_ANNOTATE_REGISTRY_DIR: registryDir,
    DALINAR_BROWSER_ANNOUNCE_DIR: announceDir,
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

  const oldConfig = process.env.SURF_TARGETS_CONFIG_DIR;
  process.env.SURF_TARGETS_CONFIG_DIR = registryDir;
  t.after(() => { if (oldConfig === undefined) delete process.env.SURF_TARGETS_CONFIG_DIR; else process.env.SURF_TARGETS_CONFIG_DIR = oldConfig; });
  await writeFile(path.join(registryDir, "targets.tsv"), "work\text\tdata\tprofile\taccount\textdir\n");
  await writeFile(path.join(registryDir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: browserId } }));
  const first = new AnnotateClient({ browser: "surf:work", registryDir });
  const second = new AnnotateClient({ browser: "surf:work", registryDir });
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

  const childEnv = { ...process.env, TMPDIR: clientTmpdir };
  delete childEnv.XDG_RUNTIME_DIR;
  delete childEnv.PI_ANNOTATE_REGISTRY_DIR;
  const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
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

test("Pi and MCP adapters use the same bound ID and preserve request ownership", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-adapters-"));
  const hostTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-adapter-host-"));
  const { host, ready } = await startHost({ registryDir, tmpdir: hostTmpdir });
  const previous = { BROWSER_PROFILE: process.env.BROWSER_PROFILE, PI_ANNOTATE_BROWSER: process.env.PI_ANNOTATE_BROWSER, PI_ANNOTATE_REGISTRY_DIR: process.env.PI_ANNOTATE_REGISTRY_DIR, SURF_TARGETS_CONFIG_DIR: process.env.SURF_TARGETS_CONFIG_DIR };
  const browserId = `adapter-${process.pid}-${Date.now()}`;
  host.stdin.write(nativeFrame({ type: "REGISTER_BROWSER", id: browserId, name: "surf:work", browser: "Chromium Test" }));
  await ready;
  await writeFile(path.join(registryDir, "targets.tsv"), "work\text\tdata\tprofile\t\textdir\n");
  await writeFile(path.join(registryDir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: browserId } }));
  Object.assign(process.env, { BROWSER_PROFILE: "work", SURF_TARGETS_CONFIG_DIR: registryDir });
  delete process.env.PI_ANNOTATE_BROWSER;
  const mcp = new Client({ name: "binding-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["bin/pi-annotate-mcp.js"], cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PI_ANNOTATE_REGISTRY_DIR: registryDir } });
  t.after(async () => {
    await mcp.close(); await stopProcess(host);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(registryDir, { recursive: true, force: true }); await rm(hostTmpdir, { recursive: true, force: true });
  });
  await mcp.connect(transport);
  assert.ok((await mcp.listTools()).tools.some((tool) => tool.name === "annotate"));
  const messages = [];
  readNativeMessages(host.stdout, (message) => messages.push(message));
  const resultPromise = mcp.callTool({ name: "annotate", arguments: { timeout: 3 } });
  const start = await waitFor(() => messages.find((message) => message.type === "START_ANNOTATION"), "MCP did not reach the bound ID");
  const piScript = `
    import extension from "./index.ts";
    const tools = new Map();
    extension({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, sendUserMessage() {} });
    const result = await tools.get("annotate").execute("test", { timeout: 3 }, undefined, undefined, { hasUI: false });
    console.log(JSON.stringify(result));
    process.exit(0);
  `;
  const pi = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", piScript], { cwd: new URL("..", import.meta.url), env: { ...process.env, PI_ANNOTATE_REGISTRY_DIR: registryDir }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stopProcess(pi));
  let piOutput = "";
  let piError = "";
  pi.stdout.on("data", (chunk) => { piOutput += chunk; });
  pi.stderr.on("data", (chunk) => { piError += chunk; });
  const piExit = once(pi, "exit");
  const piStart = await waitFor(() => messages.find((message) => message.type === "START_ANNOTATION" && message.requestId !== start.requestId), "Pi did not reach the same bound ID");
  const cancelled = await resultPromise;
  assert.match(JSON.stringify(cancelled), /Another client/);
  host.stdin.write(nativeFrame({ type: "ANNOTATIONS_COMPLETE", requestId: piStart.requestId, result: { success: true, elements: [], url: "https://example.test", viewport: { width: 1, height: 1 } } }));
  const [piCode] = await piExit;
  assert.equal(piCode, 0, piError);
  const result = JSON.parse(piOutput.trim());
  assert.equal(result.details.success, true);
});

// --- Device rendezvous (Dalinar plan 971 step 3) ---------------------------

async function rendezvousFixture(t) {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-rv-registry-"));
  const hostTmpdir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-rv-host-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-rv-config-"));
  const announceDir = path.join(hostTmpdir, "announce");
  const hosts = [];
  const previous = { SURF_TARGETS_CONFIG_DIR: process.env.SURF_TARGETS_CONFIG_DIR, DALINAR_BROWSER_ANNOUNCE_DIR: process.env.DALINAR_BROWSER_ANNOUNCE_DIR };
  Object.assign(process.env, { SURF_TARGETS_CONFIG_DIR: configDir, DALINAR_BROWSER_ANNOUNCE_DIR: announceDir });
  t.after(async () => {
    for (const host of hosts) await stopProcess(host);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const dir of [registryDir, hostTmpdir, configDir]) await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path.join(configDir, "targets.tsv"), "work\text-work\tdata\tprofile\t\textdir\npersonal\text-personal\tdata\tprofile2\t\textdir2\n");
  const claim = (claims) => writeFile(path.join(configDir, "claims.json"), JSON.stringify({ version: 1, claims }), { mode: 0o600 });
  const launch = async (id, label) => {
    const started = await startHost({ registryDir, tmpdir: hostTmpdir, announceDir });
    hosts.push(started.host);
    started.host.stdin.write(nativeFrame({ type: "REGISTER_BROWSER", id, name: `Browser ${id}`, browser: "Google Chrome", ...(label ? { label } : {}) }));
    const registered = await started.ready;
    await waitFor(() => listBrowserTargets(registryDir).some((item) => item.id === id), `host for ${id} did not publish`);
    return { ...started, registered };
  };
  return { registryDir, configDir, announceDir, claim, launch };
}

test("label handshake announces a record that surf: resolves end to end", async (t) => {
  const { registryDir, configDir, announceDir, claim, launch } = await rendezvousFixture(t);
  const browserId = `rv-${process.pid}-${Date.now()}`;
  const { host, registered } = await launch(browserId, "work");
  assert.equal(registered.label, "work");

  const record = JSON.parse(await readFile(path.join(announceDir, `${browserId}.json`), "utf8"));
  assert.deepEqual(
    { version: record.version, instanceId: record.instanceId, label: record.label, capability: record.capability, browser: record.browser, pid: record.pid, endpoint: record.endpoint },
    { version: 1, instanceId: browserId, label: "work", capability: "annotate", browser: "google chrome", pid: host.pid, endpoint: { browserId } },
  );

  // Before `claim import` (no claims.json) the legacy binding still decides,
  // and an announcement alone never selects a profile.
  await writeFile(path.join(configDir, "annotate-bindings.json"), JSON.stringify({ version: 1, bindings: { work: "legacy-other-id" } }));
  assert.throws(() => resolveBrowserTarget("surf:work", registryDir), /Bound browser "legacy-other-id" for surf:work is disconnected/);
  // Once claims.json exists it is authoritative: no claim refuses, and the
  // legacy binding is never consulted again.
  await claim({ personal: { annotate: "someone-else" } });
  assert.throws(() => resolveBrowserTarget("surf:work", registryDir), /No annotate claim for Surf label "work"/);
  await claim({ work: { annotate: browserId } });
  assert.equal(resolveBrowserTarget("surf:work", registryDir).id, browserId);

  const messages = [];
  readNativeMessages(host.stdout, (message) => messages.push(message));
  const client = new AnnotateClient({ browser: "surf:work", registryDir });
  const resultPromise = client.annotate({ timeout: 3 });
  const start = await waitFor(() => messages.find((message) => message.type === "START_ANNOTATION"), "surf:work did not reach the announced host");
  host.stdin.write(nativeFrame({ type: "ANNOTATIONS_COMPLETE", requestId: start.requestId, result: { success: true, elements: [], url: "https://example.test", viewport: { width: 1, height: 1 } } }));
  assert.equal((await resultPromise).success, true);

  await stopProcess(host);
  await assert.rejects(readFile(path.join(announceDir, `${browserId}.json`), "utf8"), { code: "ENOENT" }, "disconnect removes the host's own record");
  assert.throws(() => resolveBrowserTarget("surf:work", registryDir), /No live Pi Annotate announcer for surf:work/);
});

test("an unlabeled handshake announces unlabeled and never resolves", async (t) => {
  const { registryDir, announceDir, claim, launch } = await rendezvousFixture(t);
  const browserId = `rv-unlabeled-${process.pid}-${Date.now()}`;
  const { registered } = await launch(browserId, undefined);
  assert.equal(registered.label, undefined);
  const record = JSON.parse(await readFile(path.join(announceDir, `${browserId}.json`), "utf8"));
  assert.equal(record.label, undefined);
  await claim({ work: { annotate: browserId } });
  assert.throws(() => resolveBrowserTarget("surf:work", registryDir), /No live Pi Annotate announcer/);
});

test("two live announcers on one label refuse instead of choosing", async (t) => {
  const { registryDir, claim, launch } = await rendezvousFixture(t);
  const first = `rv-first-${process.pid}-${Date.now()}`;
  const second = `rv-second-${process.pid}-${Date.now()}`;
  await launch(first, "work");
  await launch(second, "work");
  await claim({ work: { annotate: first } });
  assert.throws(() => resolveBrowserTarget("surf:work", registryDir), /Ambiguous: 2 live Pi Annotate announcers use label "work"/);
  // Explicit selectors keep their precedence and untouched behavior.
  assert.equal(resolveBrowserTarget(second, registryDir).id, second);
});

test("a storage reset (new browser ID) gives the named re-approve refusal, never another profile", async (t) => {
  const { registryDir, claim, launch } = await rendezvousFixture(t);
  const original = `rv-original-${process.pid}-${Date.now()}`;
  const other = `rv-other-${process.pid}-${Date.now()}`;
  const { host } = await launch(original, "work");
  await launch(other, "personal");
  await claim({ work: { annotate: original }, personal: { annotate: other } });
  assert.equal(resolveBrowserTarget("surf:work", registryDir).id, original);
  await stopProcess(host);

  const reset = `rv-reset-${process.pid}-${Date.now()}`;
  await launch(reset, "work");
  assert.throws(
    () => resolveBrowserTarget("surf:work", registryDir),
    new RegExp(`Live announcer ${reset} for surf:work is not the claimed instance ${original}.*surf-target claim approve work --capability annotate --instance ${reset} --replace`),
  );
  assert.equal(resolveBrowserTarget("surf:personal", registryDir).id, other);
});
