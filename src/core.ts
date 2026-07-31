import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomInt } from "node:crypto";
import type { AnnotationResult, ElementSelection, EditCapture } from "../types.js";

/** Legacy single-browser paths, retained as a fallback for older native hosts. */
export const SOCKET_PATH = "/tmp/pi-annotate.sock";
export const TOKEN_PATH = "/tmp/pi-annotate.token";
export const REGISTRY_DIR = process.env.PI_ANNOTATE_REGISTRY_DIR
  ? path.resolve(process.env.PI_ANNOTATE_REGISTRY_DIR)
  : path.join(
      os.tmpdir(),
      `pi-annotate-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    );
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

export const NOT_CONNECTED_MESSAGE =
  "Browser extension not connected. Click the Pi Annotate icon in the browser to wake the service worker, then retry.";

export type AnnotateParams = {
  url?: string;
  /** Max seconds to wait for annotations. Default: 300 */
  timeout?: number;
  signal?: AbortSignal;
  /** Called after START_ANNOTATION is sent (session open in browser). */
  onStarted?: () => void;
};

export type AnnotateClientOptions = {
  onStatus?: (message: string) => void;
  /**
   * Called when an annotation completes that was not started via annotate()
   * (e.g. Pi /annotate command fire-and-forget flow).
   */
  onUnmanagedComplete?: (result: AnnotationResult) => void | Promise<void>;
  /** Override native-host socket path (tests / custom installs). Default: SOCKET_PATH */
  socketPath?: string;
  /** Override auth token path. Default: TOKEN_PATH */
  tokenPath?: string;
  /** Browser profile id or friendly name. Defaults to PI_ANNOTATE_BROWSER. */
  browser?: string;
  /** Override the browser endpoint registry directory (primarily for tests). */
  registryDir?: string;
};

export type BrowserTarget = {
  id: string;
  name: string;
  browser: string;
  socketPath: string;
  tokenPath: string;
  pid: number;
  connectedAt: string;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAnnotationResult(value: unknown): value is AnnotationResult {
  if (!isRecord(value)) return false;
  if (typeof value.success !== "boolean") return false;
  return true;
}

function cancelledResult(reason: string, extra: Partial<AnnotationResult> = {}): AnnotationResult {
  return {
    success: false,
    cancelled: true,
    reason,
    elements: [],
    url: "",
    viewport: { width: 0, height: 0 },
    ...extra,
  };
}

function isLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === "EPERM";
  }
}

function parseBrowserTarget(value: unknown, registryDir: string): BrowserTarget | null {
  if (!isRecord(value)) return null;
  const requiredStrings = ["id", "name", "browser", "socketPath", "tokenPath", "connectedAt", "updatedAt"];
  if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
  if (typeof value.pid !== "number" || !isLiveProcess(value.pid)) return null;

  const socketPath = path.resolve(value.socketPath as string);
  const tokenPath = path.resolve(value.tokenPath as string);
  const registryRoot = `${path.resolve(registryDir)}${path.sep}`;
  if (!socketPath.startsWith(registryRoot) || !tokenPath.startsWith(registryRoot)) return null;
  if (!fs.existsSync(socketPath) || !fs.existsSync(tokenPath)) return null;

  return {
    id: value.id as string,
    name: value.name as string,
    browser: value.browser as string,
    socketPath,
    tokenPath,
    pid: value.pid,
    connectedAt: value.connectedAt as string,
    updatedAt: value.updatedAt as string,
  };
}

/** Discover live browser/profile endpoints published by native host instances. */
export function listBrowserTargets(registryDir = REGISTRY_DIR): BrowserTarget[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(registryDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }

  const newestById = new Map<string, BrowserTarget>();
  for (const entry of entries) {
    try {
      const parsed = parseBrowserTarget(
        JSON.parse(fs.readFileSync(path.join(registryDir, entry), "utf8")),
        registryDir,
      );
      if (!parsed) continue;
      const existing = newestById.get(parsed.id);
      if (!existing || parsed.updatedAt > existing.updatedAt) newestById.set(parsed.id, parsed);
    } catch {
      // A host may be atomically replacing its metadata while we scan.
    }
  }

  return [...newestById.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.browser.localeCompare(b.browser) || a.id.localeCompare(b.id),
  );
}

export function formatBrowserTargets(targets: BrowserTarget[]): string {
  return targets.map((target) => `${target.name} (${target.browser}, id: ${target.id})`).join(", ");
}

export function resolveBrowserTarget(
  selector: string | undefined,
  registryDir = REGISTRY_DIR,
): BrowserTarget {
  const targets = listBrowserTargets(registryDir);
  if (targets.length === 0) {
    const wanted = selector?.trim();
    const acceptsLegacy = !wanted || ["legacy", "legacy browser"].includes(wanted.toLocaleLowerCase());
    if (acceptsLegacy && fs.existsSync(SOCKET_PATH) && fs.existsSync(TOKEN_PATH)) {
      return {
        id: "legacy",
        name: "Legacy browser",
        browser: "Chrome/Chromium",
        socketPath: SOCKET_PATH,
        tokenPath: TOKEN_PATH,
        pid: 0,
        connectedAt: "",
        updatedAt: "",
      };
    }
    throw new Error("No browser profiles are connected");
  }

  const wanted = selector?.trim();
  if (!wanted) {
    if (targets.length === 1) return targets[0];
    throw new Error(
      `Multiple browser profiles are connected. Choose one with the browser argument or PI_ANNOTATE_BROWSER: ${formatBrowserTargets(targets)}`,
    );
  }

  const lower = wanted.toLocaleLowerCase();
  const exact = targets.filter(
    (target) => target.id === wanted || target.name.toLocaleLowerCase() === lower,
  );
  if (exact.length === 1) return exact[0];

  const partial = targets.filter(
    (target) => target.id.startsWith(wanted) || target.name.toLocaleLowerCase().includes(lower),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1 || exact.length > 1) {
    throw new Error(`Browser selector "${wanted}" is ambiguous: ${formatBrowserTargets([...exact, ...partial])}`);
  }
  throw new Error(`Browser profile "${wanted}" was not found. Connected: ${formatBrowserTargets(targets)}`);
}

/**
 * Agent-agnostic client for the Pi Annotate native host socket protocol.
 *
 * Connection lifecycle is serialized and socket handlers are bound to a
 * specific socket instance so reconnect/close races cannot clobber a newer
 * connection or resolve the wrong pending requests.
 */
export class AnnotateClient {
  private browserSocket: net.Socket | null = null;
  private pendingRequests = new Map<number, (result: AnnotationResult) => void | Promise<void>>();
  private dataBuffer = "";
  private authToken: string | null = null;
  /** True only after AUTH has been sent on the current live socket. */
  private ready = false;
  /** In-flight connect() promise — shared so concurrent callers await one AUTH. */
  private connectPromise: Promise<void> | null = null;
  /** Monotonic request ids (avoids Date.now() collisions under concurrent calls). */
  private nextRequestId = 0;
  /** Guards tool-style annotate() against overlapping sessions on this client. */
  private annotateInFlight = false;
  private connectedTarget: BrowserTarget | null = null;
  private readonly configuredSocketPath?: string;
  private readonly configuredTokenPath?: string;
  private readonly browserSelector?: string;
  private readonly registryDir: string;
  private onStatus?: (message: string) => void;
  private onUnmanagedComplete?: (result: AnnotationResult) => void | Promise<void>;

  constructor(options: AnnotateClientOptions = {}) {
    this.onStatus = options.onStatus;
    this.onUnmanagedComplete = options.onUnmanagedComplete;
    this.configuredSocketPath = options.socketPath;
    this.configuredTokenPath = options.tokenPath;
    this.browserSelector = options.browser ?? process.env.PI_ANNOTATE_BROWSER;
    this.registryDir = options.registryDir ?? REGISTRY_DIR;
    // A random safe-integer range prevents collisions across concurrent clients.
    this.nextRequestId = randomInt(1_000_000_000, 8_000_000_000) * 1_000_000;
  }

  setStatusHandler(handler?: (message: string) => void) {
    this.onStatus = handler;
  }

  setUnmanagedCompleteHandler(handler?: (result: AnnotationResult) => void | Promise<void>) {
    this.onUnmanagedComplete = handler;
  }

  private setStatus(message: string) {
    this.onStatus?.(message);
  }

  private allocateRequestId(): number {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }

  isConnected(): boolean {
    return this.ready && !!this.browserSocket && !this.browserSocket.destroyed;
  }

  getBrowserTarget(): BrowserTarget | null {
    return this.connectedTarget;
  }

  private resolveEndpoint(): { socketPath: string; tokenPath: string; target: BrowserTarget | null } {
    if (this.configuredSocketPath || this.configuredTokenPath) {
      if (!this.configuredSocketPath || !this.configuredTokenPath) {
        throw new Error("socketPath and tokenPath must be provided together");
      }
      return {
        socketPath: this.configuredSocketPath,
        tokenPath: this.configuredTokenPath,
        target: null,
      };
    }
    const target = resolveBrowserTarget(this.browserSelector, this.registryDir);
    return { socketPath: target.socketPath, tokenPath: target.tokenPath, target };
  }

  /**
   * Ensure a live, authenticated socket. Concurrent callers share one attempt.
   */
  connect(): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      let endpoint: ReturnType<AnnotateClient["resolveEndpoint"]>;
      try {
        endpoint = this.resolveEndpoint();
      } catch (err) {
        reject(err);
        return;
      }
      this.connectedTarget = endpoint.target;

      let token: string;
      try {
        token = fs.readFileSync(endpoint.tokenPath, "utf8").trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(
          new Error(`Failed to read auth token at ${endpoint.tokenPath}: ${message}`, { cause: err }),
        );
        return;
      }

      this.authToken = token;
      this.ready = false;
      this.dataBuffer = "";

      const socket = net.createConnection(endpoint.socketPath);
      this.browserSocket = socket;

      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        this.ready = true;
        resolve();
      };
      const settleErr = (err: Error) => {
        if (settled) return;
        settled = true;
        this.ready = false;
        if (this.browserSocket === socket) {
          this.browserSocket = null;
          this.authToken = null;
          this.dataBuffer = "";
        }
        reject(err);
      };

      socket.on("connect", () => {
        // Ignore events from a socket that is no longer current.
        if (this.browserSocket !== socket) return;
        const label = this.connectedTarget ? ` ${this.connectedTarget.name}` : " native host";
        this.setStatus(`Connected to${label}`);
        // AUTH must go out before any caller sends START_ANNOTATION.
        this.sendOn(socket, { type: "AUTH", token: this.authToken });
        settleOk();
      });

      socket.on("data", (data) => {
        if (this.browserSocket !== socket) return;

        this.dataBuffer += data.toString();
        if (this.dataBuffer.length > MAX_SOCKET_BUFFER) {
          this.setStatus("Error: Socket buffer overflow");
          socket.destroy();
          this.dataBuffer = "";
          return;
        }
        const lines = this.dataBuffer.split("\n");

        // Keep the last incomplete line in the buffer
        this.dataBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            void this.handleMessage(msg);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setStatus(`Error: Failed to parse message: ${message}`);
          }
        }
      });

      socket.on("error", (err) => {
        if (this.browserSocket !== socket && settled) return;
        this.setStatus(`Error: ${err.message}`);
        settleErr(err);
      });

      socket.on("close", () => {
        // Stale close must not null a newer socket or cancel its requests.
        if (this.browserSocket !== socket) return;

        this.setStatus("Disconnected from native host");
        this.browserSocket = null;
        this.connectedTarget = null;
        this.authToken = null;
        this.dataBuffer = "";
        this.ready = false;

        for (const [, resolvePending] of this.pendingRequests) {
          void resolvePending(cancelledResult("connection_lost"));
        }
        this.pendingRequests.clear();

        if (!settled) {
          settleErr(new Error("Connection closed before ready"));
        }
      });
    });
  }

  /** Write on a specific socket (used during connect before ready flag is set). */
  private sendOn(socket: net.Socket, msg: object) {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + "\n");
    }
  }

  sendToHost(msg: object) {
    if (this.browserSocket && !this.browserSocket.destroyed) {
      this.sendOn(this.browserSocket, msg);
    }
  }

  private async handleMessage(msg: unknown) {
    if (!isRecord(msg) || typeof msg.type !== "string") return;

    this.setStatus(`Received: ${msg.type}`);

    const requestId = typeof msg.requestId === "number" ? msg.requestId : null;

    if (msg.type === "SESSION_REPLACED") {
      // Another client took over the annotation session in this browser.
      this.setStatus("Session replaced by another client");
      const reason = typeof msg.reason === "string" ? msg.reason : "Session replaced by another terminal";

      if (requestId !== null && this.pendingRequests.has(requestId)) {
        const resolvePending = this.pendingRequests.get(requestId);
        this.pendingRequests.delete(requestId);
        if (resolvePending) await resolvePending(cancelledResult(reason));
      } else {
        for (const [, resolvePending] of this.pendingRequests) {
          await resolvePending(cancelledResult(reason));
        }
        this.pendingRequests.clear();
      }
      return;
    }

    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (!isAnnotationResult(msg.result)) return;
      if (requestId !== null && this.pendingRequests.has(requestId)) {
        const resolvePending = this.pendingRequests.get(requestId);
        if (!resolvePending) return;
        this.pendingRequests.delete(requestId);
        await resolvePending(msg.result);
      } else if (this.onUnmanagedComplete) {
        await this.onUnmanagedComplete(msg.result);
      }
      return;
    }

    if (msg.type === "CANCEL") {
      if (requestId !== null && this.pendingRequests.has(requestId)) {
        const resolvePending = this.pendingRequests.get(requestId);
        if (!resolvePending) return;
        this.pendingRequests.delete(requestId);
        await resolvePending(
          cancelledResult(typeof msg.reason === "string" ? msg.reason : "user"),
        );
      }
      // For command flow, cancel is just ignored (UI already closed)
    }
  }

  /**
   * Fire-and-forget start for command-style UX. Completion is delivered via
   * onUnmanagedComplete (not through a returned promise).
   */
  async startAnnotation(url?: string): Promise<number> {
    await this.connect();
    const requestId = this.allocateRequestId();
    this.sendToHost({
      type: "START_ANNOTATION",
      requestId,
      url,
    });
    return requestId;
  }

  /**
   * Tool-style annotate: connect, start session, wait for result/cancel/timeout/abort.
   * Only one tool-style annotation may be in flight per client (native host is single-session).
   */
  async annotate(params: AnnotateParams = {}): Promise<AnnotationResult> {
    const { url, timeout = 300, signal, onStarted } = params;

    if (this.annotateInFlight || this.pendingRequests.size > 0) {
      return cancelledResult("An annotation session is already in progress");
    }
    this.annotateInFlight = true;

    try {
      const requestId = this.allocateRequestId();

      await this.connect();

      if (signal?.aborted) {
        return cancelledResult("aborted");
      }

      return await new Promise<AnnotationResult>((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let settled = false;

        const settle = (result: AnnotationResult) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          this.pendingRequests.delete(requestId);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const onAbort = () => {
          this.sendToHost({ type: "CANCEL", requestId, reason: "aborted" });
          settle(cancelledResult("aborted"));
        };

        signal?.addEventListener("abort", onAbort);

        this.pendingRequests.set(requestId, async (result) => {
          settle(result);
        });

        timeoutId = setTimeout(() => {
          this.sendToHost({ type: "CANCEL", requestId, reason: "timeout" });
          settle(cancelledResult("timeout", { timeout: true }));
        }, timeout * 1000);

        this.sendToHost({
          type: "START_ANNOTATION",
          requestId,
          url,
        });
        onStarted?.();
      });
    } finally {
      this.annotateInFlight = false;
    }
  }

  cancel(requestId: number, reason = "cancelled") {
    this.sendToHost({ type: "CANCEL", requestId, reason });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Format Result (preserved from original Pi extension)
// ─────────────────────────────────────────────────────────────────────

function formatEditCapture(capture: EditCapture): string {
  let output = "";

  if (capture.warnings?.length) {
    for (const w of capture.warnings) {
      output += `> **Note:** ${w}\n`;
    }
    output += "\n";
  }

  // Inline style changes
  if (capture.inlineStyles.length > 0) {
    output += `### Inline Style Changes\n\n`;
    for (const change of capture.inlineStyles) {
      output += `**\`${change.selector}\`**\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // Stylesheet rule changes
  if (capture.rules.length > 0) {
    output += `### CSS Rule Changes\n\n`;
    for (const change of capture.rules) {
      output += `**\`${change.ruleSelector}\`** (${change.sheet})\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // DOM changes
  if (capture.dom.length > 0) {
    output += `### DOM Changes\n\n`;
    for (const change of capture.dom) {
      output += `- **\`${change.selector}\`** — ${change.detail}\n`;
    }
    output += "\n";
  }

  return output;
}

export async function formatResult(result: AnnotationResult): Promise<string> {
  if (!result.success) {
    if (result.cancelled) {
      if (result.reason?.includes("Another terminal") || result.reason?.includes("Another client")) {
        return `Annotation session ended: ${result.reason}`;
      }
      if (result.reason && result.reason !== "user") {
        return `Annotation cancelled: ${result.reason}`;
      }
      return "Annotation cancelled by user.";
    }
    return `Annotation failed: ${result.reason || "Unknown error"}`;
  }

  let output = `## Page Annotation: ${result.url || "Unknown"}\n`;
  if (result.viewport) {
    output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
  }

  // Show overall context if provided (uses existing 'prompt' field for backwards compat)
  if (result.prompt) {
    output += `**Context:** ${result.prompt}\n\n`;
  }

  // Check if any element has debug data (to show header)
  const hasDebugData = result.elements?.some(el => el.computedStyles || el.parentContext || el.cssVariables);
  if (hasDebugData) {
    output += `**Debug Mode:** Enabled\n\n`;
  }

  if (result.elements && result.elements.length > 0) {
    output += `### Selected Elements (${result.elements.length})\n\n`;
    result.elements.forEach((el: ElementSelection, i: number) => {
      output += `${i + 1}. **${el.tag}**\n`;
      output += `   - Selector: \`${el.selector}\`\n`;
      if (el.id) output += `   - ID: \`${el.id}\`\n`;
      if (el.classes?.length) output += `   - Classes: \`${el.classes.join(", ")}\`\n`;
      if (el.text) {
        output += `   - Text: "${el.text}"\n`;
      }

      // Box model (v0.3.0) - compact format
      if (el.boxModel) {
        const bm = el.boxModel;
        const padStr = `${bm.padding.top} ${bm.padding.right} ${bm.padding.bottom} ${bm.padding.left}`;
        const borderStr = bm.border.top || bm.border.right || bm.border.bottom || bm.border.left
          ? `${bm.border.top} ${bm.border.right} ${bm.border.bottom} ${bm.border.left}` : "0";
        const marginStr = `${bm.margin.top} ${bm.margin.right} ${bm.margin.bottom} ${bm.margin.left}`;
        output += `   - **Box Model:** ${el.rect.width}×${el.rect.height} (content: ${bm.content.width}×${bm.content.height}, padding: ${padStr}, border: ${borderStr}, margin: ${marginStr})\n`;
      } else {
        output += `   - Size: ${el.rect.width}×${el.rect.height}px\n`;
      }

      // Attributes (v0.3.0) - fix: was captured but never output
      if (el.attributes && Object.keys(el.attributes).length > 0) {
        const attrStr = Object.entries(el.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ");
        output += `   - **Attributes:** ${attrStr}\n`;
      }

      // Accessibility (v0.3.0) - compact format, omit undefined booleans
      if (el.accessibility) {
        const a11y = el.accessibility;
        const parts: string[] = [];
        if (a11y.role) parts.push(`role=${a11y.role}`);
        if (a11y.name) parts.push(`name="${a11y.name}"`);
        parts.push(`focusable=${a11y.focusable}`);
        parts.push(`disabled=${a11y.disabled}`);
        if (a11y.expanded !== undefined) parts.push(`expanded=${a11y.expanded}`);
        if (a11y.pressed !== undefined) parts.push(`pressed=${a11y.pressed}`);
        if (a11y.checked !== undefined) parts.push(`checked=${a11y.checked}`);
        if (a11y.selected !== undefined) parts.push(`selected=${a11y.selected}`);
        if (a11y.description) parts.push(`description="${a11y.description}"`);
        output += `   - **Accessibility:** ${parts.join(", ")}\n`;
      }

      // Key styles - compact format (suppressed when full computedStyles is present)
      const hasComputedStyles = el.computedStyles && Object.keys(el.computedStyles).length > 0;
      if (!hasComputedStyles && el.keyStyles && Object.keys(el.keyStyles).length > 0) {
        const styleStr = Object.entries(el.keyStyles).map(([k, v]) => `${k}: ${v}`).join(", ");
        output += `   - **Styles:** ${styleStr}\n`;
      }

      // Comment
      if (el.comment) {
        output += `   - **Comment:** ${el.comment}\n`;
      }

      // Debug mode data (v0.3.0) - verbose format
      if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
        output += `   - **Computed Styles:**\n`;
        for (const [key, value] of Object.entries(el.computedStyles)) {
          output += `     - ${key}: ${value}\n`;
        }
      }

      if (el.parentContext) {
        const pc = el.parentContext;
        const pcLabel = pc.id ? `${pc.tag}#${pc.id}` : `${pc.tag}${pc.classes[0] ? "." + pc.classes[0] : ""}`;
        const pcStyles = Object.entries(pc.styles).map(([k, v]) => `${k}: ${v}`).join(", ");
        output += `   - **Parent Context:** ${pcLabel} (${pcStyles})\n`;
      }

      if (el.cssVariables && Object.keys(el.cssVariables).length > 0) {
        output += `   - **CSS Variables:**\n`;
        for (const [name, value] of Object.entries(el.cssVariables)) {
          output += `     - ${name}: ${value}\n`;
        }
      }

      output += `\n`;
    });
  } else {
    output += "*No elements selected*\n\n";
  }

  // Handle screenshots
  const timestamp = Date.now();

  if (result.screenshot) {
    // Full page screenshot
    try {
      if (!result.screenshot.startsWith("data:image/")) throw new Error("Invalid screenshot data");
      const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-full.png`);
      const base64Data = result.screenshot.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
      await fs.promises.writeFile(screenshotPath, buffer);
      output += `**Screenshot (full page):** ${screenshotPath}\n`;
    } catch (err) {
      output += `*Screenshot capture failed: ${err}*\n`;
    }
  }

  if (result.screenshots && result.screenshots.length > 0) {
    // Individual element screenshots
    output += `### Screenshots\n\n`;
    for (let i = 0; i < result.screenshots.length; i++) {
      const shot = result.screenshots[i];
      try {
        if (!shot?.dataUrl?.startsWith("data:image/")) throw new Error("Invalid screenshot data");
        const safeIndex = Number.isFinite(shot.index) ? Math.max(1, Math.floor(shot.index)) : i + 1;
        const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-el${safeIndex}.png`);
        const base64Data = shot.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
        await fs.promises.writeFile(screenshotPath, buffer);
        output += `- Element ${safeIndex}: ${screenshotPath}\n`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `- Element ${shot?.index ?? i + 1}: *capture failed (${message})*\n`;
      }
    }
    output += "\n";
  }

  if (result.editCapture && result.editCapture.changeCount > 0) {
    const ec = result.editCapture;
    output += `## Edit Capture (${ec.changeCount} changes, ${Math.round(ec.duration / 1000)}s)\n\n`;
    output += formatEditCapture(ec);

    // Before/after screenshots
    if (ec.beforeScreenshot || ec.afterScreenshot) {
      output += `### Before/After Screenshots\n\n`;
      if (ec.beforeScreenshot) {
        try {
          const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-before.png`);
          const buf = Buffer.from(ec.beforeScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
          await fs.promises.writeFile(p, buf);
          output += `- Before: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- Before: *capture failed (${message})*\n`;
        }
      }
      if (ec.afterScreenshot) {
        try {
          const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-after.png`);
          const buf = Buffer.from(ec.afterScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
          await fs.promises.writeFile(p, buf);
          output += `- After: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- After: *capture failed (${message})*\n`;
        }
      }
      output += "\n";
    }
  }

  return output;
}

/** Format with tool-oriented messages for abort/timeout (matches original Pi tool wording). */
export async function formatToolResult(
  result: AnnotationResult,
  options: { timeoutSeconds?: number } = {},
): Promise<string> {
  if (!result.success && result.cancelled) {
    if (result.reason === "aborted") {
      return "Annotation was aborted.";
    }
    if (result.timeout || result.reason === "timeout") {
      const seconds = options.timeoutSeconds ?? 300;
      return `Annotation timed out after ${seconds}s`;
    }
  }
  return formatResult(result);
}
