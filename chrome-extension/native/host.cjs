#!/usr/bin/env node
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  resolveRuntimeDirectory,
} = require("../../src/runtime-paths.cjs");
const announce = require("../../src/announce.cjs");
const { formatResult } = require("../../src/format-result.cjs");

const INSTANCE_ID = crypto.randomBytes(12).toString("hex");
let REGISTRY_PATHS;
try {
  REGISTRY_PATHS = resolveRuntimeDirectory({
    env: process.env,
    platform: process.platform,
    tmpdir: os.tmpdir(),
    userId: typeof process.getuid === "function" ? process.getuid() : "user",
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const REGISTRY_DIR = REGISTRY_PATHS.registryDir;
const SOCKET_PATH = path.join(REGISTRY_DIR, `pi-annotate-${INSTANCE_ID}.sock`);
const TOKEN_PATH = path.join(REGISTRY_DIR, `pi-annotate-${INSTANCE_ID}.token`);
const METADATA_PATH = path.join(REGISTRY_DIR, `pi-annotate-${INSTANCE_ID}.json`);
const LOG_FILE = path.join(REGISTRY_DIR, `pi-annotate-${INSTANCE_ID}.log`);
const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB

process.umask(0o077);

fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(REGISTRY_DIR, 0o700);

function reportFsError(action, err) {
  const code = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "";
  if (code === "ENOENT") return;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${new Date().toISOString()} ${action}: ${message}`);
}

function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (err) {
    reportFsError(`Failed to rotate log ${LOG_FILE}`, err);
  }
}

const log = (msg) => {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
};

log(`Host starting (instance ${INSTANCE_ID})...`);

// Clean up old socket
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (err) {
  reportFsError(`Failed to remove old socket ${SOCKET_PATH}`, err);
}

// Multiple agent clients may share this browser profile. Requests are routed
// back only to the socket that initiated them.
const piClients = new Set();
const requestOwners = new Map();
let activeRequestId = null;
let lastAgentClient = null;
const connectedAt = new Date().toISOString();
let browserMetadata = {
  id: INSTANCE_ID,
  name: `Browser ${INSTANCE_ID.slice(0, 6)}`,
  browser: "Chrome/Chromium",
};

function publishMetadata() {
  const metadata = {
    ...browserMetadata,
    socketPath: SOCKET_PATH,
    tokenPath: TOKEN_PATH,
    pid: process.pid,
    connectedAt,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${METADATA_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, METADATA_PATH);
}

// Device rendezvous (Dalinar plan 971): announce this profile on the
// connect handshake so sessions can resolve surf:<label> through approved
// claims. Announcing is best-effort and must never break native messaging.
let announcedId = null;

function announceBrowser(id, label, browser) {
  try {
    if (announcedId && announcedId !== id) announce.removeRecord(announcedId, process.pid);
    const browserName = typeof browser === "string" && browser.trim() ? browser.trim().toLowerCase() : "chrome";
    announce.writeRecord({
      instanceId: id,
      ...(label ? { label } : {}),
      capability: "annotate",
      browser: browserName,
      pid: process.pid,
      endpoint: { browserId: id },
    });
    announcedId = id;
    log(`Announced instance ${id} (${label ? `label ${label}` : "unlabeled"})`);
  } catch (err) {
    log(`Announce failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureToken() {
  try {
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  } catch (err) {
    log(`Failed to create token: ${err.message}`);
    return null;
  }
}

const AUTH_TOKEN = ensureToken();

// Native messaging I/O
let inputBuffer = Buffer.alloc(0);

// Chrome rejects a single host-to-extension message above 1 MB.
const MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;

// Returns true after a write, false when the message is too large to send.
// The length prefix counts bytes, not UTF-16 code units.
function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_HOST_TO_EXTENSION_BYTES) return false;
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  process.stdout.write(len);
  process.stdout.write(body);
  return true;
}

// Capabilities this host announces to the extension. The extension sends
// FORMAT_RESULT only to a host that lists "format-result".
const HOST_CAPABILITIES = ["format-result"];
const COPY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// FORMAT_RESULT (plan 1055): format a prepared result for the clipboard.
// This message never reaches an agent client, and its content is never logged.
async function handleFormatResult(msg) {
  const copyId = msg.copyId;
  if (typeof copyId !== "string" || !COPY_ID_PATTERN.test(copyId)) {
    log("FORMAT_RESULT rejected invalid-copy-id");
    return;
  }
  const reply = (fields, outcome) => {
    const sent = writeMessage({ type: "FORMATTED_RESULT", copyId, ...fields });
    if (sent) {
      log(`FORMAT_RESULT ${copyId} ${outcome}`);
      return;
    }
    // The formatted text is over the host-to-extension limit.
    writeMessage({ type: "FORMATTED_RESULT", copyId, error: "too-large" });
    log(`FORMAT_RESULT ${copyId} too-large`);
  };
  if (!msg.result || typeof msg.result !== "object" || Array.isArray(msg.result)) {
    reply({ error: "format-failed" }, "format-failed");
    return;
  }
  let text;
  try {
    text = await formatResult(msg.result);
  } catch {
    reply({ error: "format-failed" }, "format-failed");
    return;
  }
  reply({ text }, "ok");
}

function processInput() {
  while (inputBuffer.length >= 4) {
    const len = inputBuffer.readUInt32LE(0);
    if (len > MAX_NATIVE_MESSAGE_BYTES) {
      log(`Native message too large: ${len}`);
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (inputBuffer.length < 4 + len) break;

    const json = inputBuffer.slice(4, 4 + len).toString();
    inputBuffer = inputBuffer.slice(4 + len);

    try {
      const msg = JSON.parse(json);
      handleExtensionMessage(msg);
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
  }
}

function redactForLog(msg) {
  return JSON.stringify(msg, (key, value) => {
    if (key === "screenshot" || key === "beforeScreenshot" || key === "afterScreenshot") return "[redacted]";
    if (key === "screenshots") return Array.isArray(value) ? `[${value.length} screenshots]` : "[redacted]";
    if (key === "dataUrl") return "[redacted]";
    if (key === "network") {
      const count = Array.isArray(value?.requests) ? value.requests.length : 0;
      return `[${count} sanitized network requests]`;
    }
    return value;
  });
}

function sendToClient(socket, msg) {
  if (!socket || socket.destroyed || !socket.piAuthed) return false;
  socket.write(JSON.stringify(msg) + "\n");
  return true;
}

// Messages from Chrome extension → route to the initiating agent client.
function handleExtensionMessage(msg) {
  // Handled before the log line: a prepared result holds comments and selectors.
  if (msg?.type === "FORMAT_RESULT") {
    handleFormatResult(msg).catch(() => log("FORMAT_RESULT failed"));
    return;
  }

  log(`From extension: ${redactForLog(msg)}`);

  if (msg?.type === "REGISTER_BROWSER") {
    const id = typeof msg.id === "string" && msg.id.trim() ? msg.id.trim() : INSTANCE_ID;
    const name = typeof msg.name === "string" && msg.name.trim()
      ? msg.name.trim().slice(0, 80)
      : `Browser ${id.slice(0, 6)}`;
    const browser = typeof msg.browser === "string" && msg.browser.trim()
      ? msg.browser.trim().slice(0, 80)
      : "Chrome/Chromium";
    let label;
    if (typeof msg.label === "string" && msg.label.trim()) {
      if (announce.LABEL_PATTERN.test(msg.label.trim())) label = msg.label.trim();
      else log("Ignoring invalid profile label; announcing unlabeled");
    }
    browserMetadata = { id, name, browser };
    try {
      publishMetadata();
    } catch (err) {
      log(`Failed to publish browser metadata: ${err.message}`);
      return;
    }
    announceBrowser(id, label, browser);
    try {
      writeMessage({ type: "BROWSER_REGISTERED", id, name, browser, ...(label ? { label } : {}), capabilities: HOST_CAPABILITIES });
    } catch (err) {
      log(`Failed to acknowledge browser registration: ${err.message}`);
    }
    return;
  }

  // Health check - respond immediately without forwarding
  if (msg?.type === "PING") {
    writeMessage({ type: "PONG", timestamp: Date.now(), capabilities: HOST_CAPABILITIES });
    return;
  }

  const requestId = typeof msg?.requestId === "number" ? msg.requestId : null;
  if (requestId !== null && requestOwners.has(requestId)) {
    const owner = requestOwners.get(requestId);
    sendToClient(owner, msg);
    if (msg.type === "ANNOTATIONS_COMPLETE" || msg.type === "CANCEL") {
      requestOwners.delete(requestId);
      if (activeRequestId === requestId) activeRequestId = null;
    }
    return;
  }

  // A popup/shortcut session has no request owner. Deliver it to the most
  // recently active client only, so multiple Pi instances do not all inject
  // the same annotation as a user message.
  if (!sendToClient(lastAgentClient, msg)) {
    log("No authenticated agent client connected, message dropped");
  }
}

process.stdin.on("readable", () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    processInput();
  }
});

process.stdin.on("end", () => {
  log("Extension disconnected");
  cleanup();
});

function cleanup() {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    reportFsError(`Failed to remove socket ${SOCKET_PATH}`, err);
  }

  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch (err) {
    reportFsError(`Failed to remove token ${TOKEN_PATH}`, err);
  }

  try {
    fs.unlinkSync(METADATA_PATH);
  } catch (err) {
    reportFsError(`Failed to remove metadata ${METADATA_PATH}`, err);
  }

  if (announcedId) {
    try {
      announce.removeRecord(announcedId, process.pid);
    } catch (err) {
      reportFsError(`Failed to remove announce record ${announcedId}`, err);
    }
  }

  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  cleanup();
});

// Unix socket server for Pi and MCP clients
const server = net.createServer((socket) => {
  log("Agent client connected");
  piClients.add(socket);
  socket.piAuthed = false;

  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();
    if (buffer.length > MAX_SOCKET_BUFFER) {
      log("Pi socket buffer overflow, closing connection");
      socket.destroy();
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!socket.piAuthed) {
          if (msg?.type === "AUTH" && AUTH_TOKEN && msg.token === AUTH_TOKEN) {
            socket.piAuthed = true;
            lastAgentClient = socket;
            log("Agent client authenticated");
          } else {
            log("Agent client authentication failed");
            socket.destroy();
            return;
          }
        } else {
          lastAgentClient = socket;
          const requestId = typeof msg?.requestId === "number" ? msg.requestId : null;
          if (msg?.type === "START_ANNOTATION" && requestId !== null) {
            if (activeRequestId !== null && activeRequestId !== requestId) {
              const previousOwner = requestOwners.get(activeRequestId);
              sendToClient(previousOwner, {
                type: "SESSION_REPLACED",
                requestId: activeRequestId,
                reason: "Another client started annotation in this browser profile",
              });
              requestOwners.delete(activeRequestId);
            }
            activeRequestId = requestId;
            requestOwners.set(requestId, socket);
          } else if (msg?.type === "CANCEL" && requestId !== null) {
            const owner = requestOwners.get(requestId);
            if (owner !== socket) {
              log(`Ignoring CANCEL for request ${requestId} from a stale or non-owner client`);
              continue;
            }
            requestOwners.delete(requestId);
            if (activeRequestId === requestId) activeRequestId = null;
          }

          // Forward to Chrome extension.
          log(`From agent: ${redactForLog(msg)}`);
          if (!writeMessage(msg)) log("Agent message is over the 1 MB host-to-extension limit, dropped");
        }
      } catch (e) {
        log(`Pi parse error: ${e.message}`);
      }
    }
  });

  socket.on("close", () => {
    log("Agent client disconnected");
    piClients.delete(socket);
    if (lastAgentClient === socket) {
      lastAgentClient = [...piClients].find((client) => client.piAuthed && !client.destroyed) || null;
    }
    for (const [requestId, owner] of requestOwners) {
      if (owner !== socket) continue;
      requestOwners.delete(requestId);
      if (activeRequestId === requestId) {
        activeRequestId = null;
        writeMessage({ type: "CANCEL", requestId, reason: "client_disconnected" });
      }
    }
  });

  socket.on("error", (e) => log(`Socket error: ${e.message}`));
});

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH}`);
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (err) {
    reportFsError(`Failed to chmod socket ${SOCKET_PATH}`, err);
  }
  try {
    publishMetadata();
  } catch (err) {
    log(`Failed to publish initial metadata: ${err.message}`);
  }
});
