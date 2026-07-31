import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  AnnotateClient,
  formatResult,
  formatToolResult,
  NOT_CONNECTED_MESSAGE,
} from "./src/core.js";

type AnnotationContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: "info" | "error") => void;
    setStatus?: (source: string, message: string) => void;
  };
};

export default function (pi: ExtensionAPI) {
  let currentCtx: AnnotationContext | null = null;

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
        onUnmanagedComplete: async (result) => {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify(
        `Browser extension not connected. ${message}. Click the Pi Annotate icon in the browser to wake the service worker, then retry.`,
        "error",
      );
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
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: NOT_CONNECTED_MESSAGE }],
          details: { error: message },
        };
      }
    },
  });
}
