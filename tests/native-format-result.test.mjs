import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(message);
}

const goodResult = (comment) => ({
  success: true,
  url: "https://example.test/",
  elements: [{
    selector: "#a", tag: "div", classes: [], text: "", rect: { x: 0, y: 0, width: 1, height: 1 },
    attributes: {}, comment,
  }],
});

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-fr-"));
  const registryDir = path.join(root, "registry");
  const env = {
    ...process.env,
    TMPDIR: root,
    PI_ANNOTATE_REGISTRY_DIR: registryDir,
    DALINAR_BROWSER_ANNOUNCE_DIR: path.join(root, "announce"),
  };
  delete env.NODE_TEST_CONTEXT;
  const host = spawn(process.execPath, ["chrome-extension/native/host.cjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const extensionMessages = [];
  readNativeMessages(host.stdout, (message) => extensionMessages.push(message));
  const agentLines = [];
  let agent = null;
  t.after(async () => {
    agent?.destroy();
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await once(host, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });

  const browserId = `fr-${process.pid}-${Date.now()}`;
  host.stdin.write(nativeFrame({ type: "REGISTER_BROWSER", id: browserId, name: "FR", browser: "Chromium Test" }));
  const registered = await waitFor(() => extensionMessages.find((m) => m.type === "BROWSER_REGISTERED"), "no BROWSER_REGISTERED");

  let metadata;
  const deadline = Date.now() + 5_000;
  while (!metadata && Date.now() < deadline) {
    const files = (await readdir(registryDir)).filter((f) => f.endsWith(".json"));
    if (files.length) metadata = JSON.parse(await readFile(path.join(registryDir, files[0]), "utf8"));
    else await delay(20);
  }
  assert.ok(metadata, "host metadata missing");
  const token = (await readFile(metadata.tokenPath, "utf8")).trim();
  agent = net.createConnection(metadata.socketPath);
  await once(agent, "connect");
  let pending = "";
  agent.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) if (line.trim()) agentLines.push(JSON.parse(line));
  });
  agent.write(JSON.stringify({ type: "AUTH", token }) + "\n");
  await delay(150);

  const logText = async () => {
    const files = (await readdir(registryDir)).filter((f) => f.endsWith(".log") || f.endsWith(".log.1"));
    return (await Promise.all(files.map((f) => readFile(path.join(registryDir, f), "utf8")))).join("\n");
  };
  return { host, registered, extensionMessages, agent, agentLines, logText, root };
}

test("FORMAT_RESULT answers FORMATTED_RESULT only, never reaches an agent, and never logs content", async (t) => {
  const { host, extensionMessages, agent, agentLines, logText } = await setup(t);
  const before = extensionMessages.length;

  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "copy_1-A", result: goodResult("PRIVATE-MARKER-1055") }));
  const formatted = await waitFor(() => extensionMessages.find((m) => m.type === "FORMATTED_RESULT"), "no FORMATTED_RESULT");
  assert.equal(formatted.copyId, "copy_1-A");
  assert.ok(formatted.text.includes("PRIVATE-MARKER-1055"));
  await delay(200);

  assert.equal(extensionMessages.slice(before).length, 1, "exactly one host message");
  assert.equal(agentLines.length, 0, "no message reached the agent client");
  const log = await logText();
  assert.equal(log.includes("PRIVATE-MARKER-1055"), false, "marker in log");
  assert.equal(log.includes("#a"), false, "selector in log");
  assert.ok(log.includes("FORMAT_RESULT copy_1-A ok"));

  // A normal managed annotation still reaches its owner.
  agent.write(JSON.stringify({ type: "START_ANNOTATION", requestId: 42, url: "https://example.test/" }) + "\n");
  await waitFor(() => extensionMessages.find((m) => m.type === "START_ANNOTATION" && m.requestId === 42), "START_ANNOTATION not forwarded");
  host.stdin.write(nativeFrame({ type: "ANNOTATIONS_COMPLETE", requestId: 42, result: goodResult("owned") }));
  const owned = await waitFor(() => agentLines.find((m) => m.type === "ANNOTATIONS_COMPLETE"), "owner did not get the result");
  assert.equal(owned.requestId, 42);
});

test("FORMAT_RESULT rejects an invalid copyId, a non-object result and a formatter error", async (t) => {
  const { host, extensionMessages, agentLines, logText } = await setup(t);

  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "bad id!", result: goodResult("x") }));
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "x".repeat(65), result: goodResult("x") }));
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", result: goodResult("x") }));
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "notobj", result: "text" }));
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "arr", result: [1] }));
  // A formatter error: elements is not an array of objects with the fields it reads.
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "boom", result: { success: true, elements: [null] } }));
  await waitFor(() => extensionMessages.filter((m) => m.type === "FORMATTED_RESULT").length >= 3, "missing replies");
  await delay(200);

  const replies = extensionMessages.filter((m) => m.type === "FORMATTED_RESULT");
  assert.deepEqual(replies.map((m) => [m.copyId, m.error]), [
    ["notobj", "format-failed"],
    ["arr", "format-failed"],
    ["boom", "format-failed"],
  ]);
  assert.equal(agentLines.length, 0);
  assert.ok((await logText()).includes("invalid-copy-id"));
});

test("FORMAT_RESULT answers too-large when the text is over 1 MB", async (t) => {
  const { host, extensionMessages, agentLines } = await setup(t);
  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "big", result: goodResult("y".repeat(1_200_000)) }));
  const reply = await waitFor(() => extensionMessages.find((m) => m.type === "FORMATTED_RESULT"), "no reply");
  assert.deepEqual({ copyId: reply.copyId, error: reply.error, text: reply.text }, { copyId: "big", error: "too-large", text: undefined });
  assert.equal(agentLines.length, 0);
});

test("PONG and BROWSER_REGISTERED carry the format-result capability", async (t) => {
  const { host, registered, extensionMessages } = await setup(t);
  assert.deepEqual(registered.capabilities, ["format-result"]);
  host.stdin.write(nativeFrame({ type: "PING" }));
  const pong = await waitFor(() => extensionMessages.find((m) => m.type === "PONG"), "no PONG");
  assert.deepEqual(pong.capabilities, ["format-result"]);
});

test("FORMAT_RESULT prints one line for a partial and a reduced screenshot, and none when both are absent (plan 1170)", async (t) => {
  const { host, extensionMessages } = await setup(t);

  host.stdin.write(nativeFrame({ type: "FORMAT_RESULT", copyId: "plain", result: goodResult("p") }));
  host.stdin.write(nativeFrame({
    type: "FORMAT_RESULT",
    copyId: "flags",
    result: { ...goodResult("f"), screenshotPartial: "tiles", screenshotReduced: true },
  }));
  await waitFor(() => extensionMessages.filter((m) => m.type === "FORMATTED_RESULT").length >= 2, "missing replies");

  const byId = (id) => extensionMessages.find((m) => m.type === "FORMATTED_RESULT" && m.copyId === id);
  assert.equal(byId("plain").text.includes("Screenshot is partial"), false);
  assert.equal(byId("plain").text.includes("Screenshot was reduced"), false);
  assert.ok(byId("flags").text.includes("*Screenshot is partial: the page needed more than 60 pictures*"));
  assert.ok(byId("flags").text.includes("*Screenshot was reduced to fit the size limit*"));
});
