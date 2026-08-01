import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  AnnotateClient,
  ConnectionFailureError,
  createConnectionNotificationGate,
  formatConnectionFailure,
  formatResult,
  formatToolResult,
} from "./src/core.js";
import {
  listIssueReports,
  readIssueReport,
  saveIssueReport,
} from "./src/issue-reports.js";

type AnnotationContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: "info" | "error") => void;
    setStatus?: (source: string, message: string) => void;
  };
};

export default function (pi: ExtensionAPI) {
  let currentCtx: AnnotationContext | null = null;
  const issueRequestIds = new Set<number>();
  const connectionNoticeGate = createConnectionNotificationGate(
    5_000,
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now(),
  );

  const notifyConnectionError = (ctx: AnnotationContext, message: string) => {
    if (!connectionNoticeGate.shouldNotify(message)) return;
    ctx.ui?.notify?.(message, "error");
  };

  const clients = new Map<string, AnnotateClient>();
  const getClient = (browser?: string) => {
    const selector = browser?.trim() || process.env.PI_ANNOTATE_BROWSER?.trim() || "";
    let client = clients.get(selector);
    if (!client) {
      client = new AnnotateClient({
        browser: selector || undefined,
        onStatus: (message) => {
          currentCtx?.ui?.setStatus?.("pi-annotate", message);
        },
        onUnmanagedComplete: async (result, requestId) => {
          if (requestId && issueRequestIds.delete(requestId) && result.success) {
            try {
              const target = client?.getBrowserTarget();
              const report = await saveIssueReport(result, {
                browser: target
                  ? { id: target.id, name: target.name, browser: target.browser }
                  : null,
              });
              currentCtx?.ui?.setStatus?.("pi-annotate", `Issue report saved: ${report.ref}`);
              pi.sendUserMessage(
                `Saved local issue report **${report.ref}**: ${report.title}\n\n` +
                `Report: ${report.directory}/report.md`,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              currentCtx?.ui?.setStatus?.("pi-annotate", "Issue report save failed");
              pi.sendUserMessage(`Could not save the local issue report: ${message}`);
            }
            return;
          }
          const text = await formatResult(result);
          currentCtx?.ui?.setStatus?.("pi-annotate", "Annotation complete");
          pi.sendUserMessage(text);
        },
      });
      clients.set(selector, client);
    }
    return client;
  };

  // ─────────────────────────────────────────────────────────────────────
  // /annotate Command
  // ─────────────────────────────────────────────────────────────────────

  const annotateHandler = async (args: string, ctx: AnnotationContext) => {
    currentCtx = ctx;
    const url = args.trim() || undefined;

    try {
      const client = getClient();
      await client.startAnnotation(url);
      connectionNoticeGate.reset();
    } catch (err) {
      const message = err instanceof ConnectionFailureError
        ? formatConnectionFailure(err.failure)
        : `Could not start annotation: ${err instanceof Error ? err.message : String(err)}`;
      notifyConnectionError(ctx, message);
      return;
    }

    ctx.ui?.notify(
      url ? `Opening annotation mode on ${url}` : "Annotation mode started on current browser tab",
      "info",
    );
  };

  pi.registerCommand("annotate", {
    description: "Start visual annotation mode in the browser. Optionally provide a URL.",
    handler: annotateHandler,
  });

  pi.registerCommand("issue", {
    description: "Annotate and persist a local issue report with sanitized network context.",
    handler: async (args: string, ctx: AnnotationContext) => {
      currentCtx = ctx;
      const url = args.trim() || undefined;
      try {
        const client = getClient();
        const requestId = await client.startAnnotation(url, { captureNetwork: true });
        issueRequestIds.add(requestId);
        ctx.ui?.notify("Issue annotation started; the completed report will be saved locally", "info");
      } catch (err) {
        const message = err instanceof ConnectionFailureError
          ? formatConnectionFailure(err.failure)
          : `Could not start issue annotation: ${err instanceof Error ? err.message : String(err)}`;
        notifyConnectionError(ctx, message);
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────
  // Tool Registration
  // ─────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "annotate",
    label: "Annotate",
    description:
      "Open visual annotation mode in the browser so the user can click/select elements and add comments. " +
      "Only use when the user explicitly asks to annotate, visually point something out, or show you UI issues. " +
      "Returns structured annotations with CSS selectors and element info. " +
      "If no URL is provided, uses the current active browser tab.",
    promptSnippet:
      "Use only when the user explicitly asks for visual annotation or UI pointing. Call with {url?} and return selected element annotations.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          description: "URL to annotate. If omitted, uses the current browser tab.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Max seconds to wait for annotations. Default: 300 (5 min)",
        }),
      ),
      browser: Type.Optional(
        Type.String({
          description: "Browser profile name or id. Required when multiple profiles are connected unless PI_ANNOTATE_BROWSER is set.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      currentCtx = ctx;
      const { browser, url, timeout = 300 } = params as { browser?: string; url?: string; timeout?: number };

      try {
        const client = getClient(browser);
        const result = await client.annotate({
          url,
          timeout,
          signal,
          onStarted: () => {
            if (ctx.hasUI) {
              ctx.ui?.notify?.("Annotation mode started in the browser", "info");
            }
          },
        });
        return {
          content: [{ type: "text", text: await formatToolResult(result, { timeoutSeconds: timeout }) }],
          details: result.reason === "aborted"
            ? { aborted: true }
            : result.timeout || result.reason === "timeout"
              ? { timeout: true }
              : result,
        };
      } catch (err) {
        const message = err instanceof ConnectionFailureError
          ? formatConnectionFailure(err.failure)
          : err instanceof Error
            ? err.message
            : String(err);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "create_issue_report",
    label: "Create Local Issue Report",
    description:
      "Open annotation mode and persist the selected areas, comments, screenshots, and optional sanitized network metadata as a local report. Does not upload or create an external ticket.",
    promptSnippet:
      "Use when the user explicitly asks to capture, save, or draft a local UI issue report from browser annotations.",
    parameters: Type.Object({
      browser: Type.Optional(Type.String({ description: "Browser profile name or id." })),
      url: Type.Optional(Type.String({ description: "URL to annotate. Defaults to the active tab." })),
      title: Type.Optional(Type.String({ description: "Optional issue title." })),
      timeout: Type.Optional(Type.Number({ description: "Max seconds to wait. Default: 300." })),
      captureNetwork: Type.Optional(Type.Boolean({ description: "Capture sanitized request metadata. Default: true." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      currentCtx = ctx;
      const {
        browser,
        url,
        title,
        timeout = 300,
        captureNetwork = true,
      } = params as {
        browser?: string;
        url?: string;
        title?: string;
        timeout?: number;
        captureNetwork?: boolean;
      };
      try {
        const client = getClient(browser);
        const result = await client.annotate({ url, timeout, captureNetwork, signal });
        if (!result.success) {
          return {
            content: [{ type: "text", text: await formatToolResult(result, { timeoutSeconds: timeout }) }],
            details: result,
          };
        }
        const target = client.getBrowserTarget();
        const report = await saveIssueReport(result, {
          title,
          browser: target
            ? { id: target.id, name: target.name, browser: target.browser }
            : null,
        });
        return {
          content: [{
            type: "text",
            text:
              `Saved local issue report ${report.ref}: ${report.title}\n` +
              `Report: ${report.directory}/report.md\n` +
              `Network requests captured: ${report.requestCount}`,
          }],
          details: report,
        };
      } catch (err) {
        const message = err instanceof ConnectionFailureError
          ? formatConnectionFailure(err.failure)
          : err instanceof Error
            ? err.message
            : String(err);
        return {
          content: [{ type: "text", text: `Could not create local issue report: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "list_issue_reports",
    label: "List Local Issue Reports",
    description: "List locally persisted Pi Annotate issue reports.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum reports. Default: 20." })),
    }),
    async execute(_toolCallId, params) {
      const { limit = 20 } = params as { limit?: number };
      const reports = await listIssueReports({ limit });
      return {
        content: [{
          type: "text",
          text: reports.length
            ? reports.map((report) => `${report.ref} — ${report.title}\n${report.directory}/report.md`).join("\n\n")
            : "No local Pi Annotate issue reports found.",
        }],
        details: { reports },
      };
    },
  });

  pi.registerTool({
    name: "get_issue_report",
    label: "Get Local Issue Report",
    description: "Read a locally persisted Pi Annotate issue report by reference.",
    parameters: Type.Object({
      ref: Type.String({ description: "Stable PIA issue report reference." }),
    }),
    async execute(_toolCallId, params) {
      const { ref } = params as { ref: string };
      try {
        const stored = await readIssueReport(ref);
        return {
          content: [{ type: "text", text: `${stored.markdown}\n\nLocal report directory: ${stored.directory}` }],
          details: stored.report,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Issue report ${ref} could not be read: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
