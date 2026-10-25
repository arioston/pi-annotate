import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

test("host length prefix counts bytes, so non-ASCII text round-trips exactly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-wm-"));
  const env = {
    ...process.env,
    TMPDIR: root,
    PI_ANNOTATE_REGISTRY_DIR: path.join(root, "registry"),
    DALINAR_BROWSER_ANNOUNCE_DIR: path.join(root, "announce"),
  };
  delete env.NODE_TEST_CONTEXT;
  const host = spawn(process.execPath, ["chrome-extension/native/host.cjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  t.after(async () => {
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await once(host, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });

  const messages = [];
  readNativeMessages(host.stdout, (message) => messages.push(message));

  host.stdin.write(nativeFrame({ type: "REGISTER_BROWSER", id: `wm-${process.pid}`, name: "WM", browser: "Chromium Test" }));
  await waitFor(() => messages.find((m) => m.type === "BROWSER_REGISTERED"), "no BROWSER_REGISTERED");

  const comment = "ação ✓ 日本";
  host.stdin.write(nativeFrame({
    type: "FORMAT_RESULT",
    copyId: "wm1",
    result: {
      success: true,
      url: "https://example.test/",
      elements: [{
        selector: "#a", tag: "div", classes: [], text: "", rect: { x: 0, y: 0, width: 1, height: 1 },
        attributes: {}, comment,
      }],
    },
  }));
  const formatted = await waitFor(() => messages.find((m) => m.type === "FORMATTED_RESULT"), "no FORMATTED_RESULT");
  assert.equal(formatted.copyId, "wm1");
  assert.ok(formatted.text.includes(`**Comment:** ${comment}`), formatted.text);

  // The stream stayed in sync after the multi-byte frame.
  host.stdin.write(nativeFrame({ type: "PING" }));
  await waitFor(() => messages.find((m) => m.type === "PONG"), "no PONG after the non-ASCII frame");
});
