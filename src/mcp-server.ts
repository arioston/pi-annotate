#!/usr/bin/env node
/**
 * MCP stdio server exposing the `annotate` tool for Junie, Claude Code, Codex, etc.
 *
 * Prerequisites (same as Pi):
 * 1. Load the chrome-extension/ unpacked in Chrome/Chromium
 * 2. Run chrome-extension/native/install.sh <extension-id>
 * 3. Click the extension icon once to wake the native host
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AnnotateClient,
  formatBrowserTargets,
  formatToolResult,
  listBrowserTargets,
  NOT_CONNECTED_MESSAGE,
} from "./core.js";
import {
  listIssueReports,
  readIssueReport,
  saveIssueReport,
} from "./issue-reports.js";

const SERVER_NAME = "pi-annotate";
const SERVER_VERSION = "0.5.0";

const annotateInputShape = {
  browser: z
    .string()
    .optional()
    .describe("Browser profile name or id. Required when more than one profile is connected unless PI_ANNOTATE_BROWSER is set."),
  url: z
    .string()
    .optional()
    .describe("URL to annotate. If omitted, uses the current browser tab."),
  timeout: z
    .number()
    .optional()
    .describe("Max seconds to wait for annotations. Default: 300 (5 min)"),
};

async function main() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Keep a distinct connection per selector. This lets one MCP server target
  // different profiles without sharing request state, and lets many MCP
  // server processes connect to the same profile safely.
  const clients = new Map<string, AnnotateClient>();
  const getClient = (browser?: string) => {
    const selector = browser?.trim() || process.env.PI_ANNOTATE_BROWSER?.trim() || "";
    let client = clients.get(selector);
    if (!client) {
      client = new AnnotateClient({
        browser: selector || undefined,
        onStatus: (message) => {
          console.error(`[pi-annotate${selector ? `:${selector}` : ""}] ${message}`);
        },
      });
      clients.set(selector, client);
    }
    return client;
  };

  server.registerTool(
    "list_browsers",
    {
      title: "List connected browsers",
      description: "List browser profiles currently connected to Pi Annotate, including the names and ids accepted by the annotate tool.",
      inputSchema: {},
      outputSchema: {
        browsers: z.array(z.object({ id: z.string(), name: z.string(), browser: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const targets = listBrowserTargets();
      const text = targets.length > 0
        ? `Connected browser profiles: ${formatBrowserTargets(targets)}`
        : "No browser profiles are connected. Open the Pi Annotate extension popup in a browser profile.";
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          browsers: targets.map(({ id, name, browser }) => ({ id, name, browser })),
        },
      };
    },
  );

  server.registerTool(
    "annotate",
    {
      title: "Annotate",
      description:
        "Open visual annotation mode in the browser so the user can click/select elements and add comments. " +
        "Only use when the user explicitly asks to annotate, visually point something out, or show you UI issues. " +
        "Returns structured annotations with CSS selectors and element info. " +
        "If no URL is provided, uses the current active browser tab. " +
        "Requires the Pi Annotate browser extension and native host to be installed and running.",
      inputSchema: annotateInputShape,
      annotations: {
        // Opens browser UI, may navigate, and edit-capture can mutate the page.
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ browser, url, timeout }, extra) => {
      const timeoutSeconds = timeout ?? 300;

      try {
        const client = getClient(browser);
        const result = await client.annotate({
          url,
          timeout: timeoutSeconds,
          signal: extra.signal,
        });

        const text = await formatToolResult(result, { timeoutSeconds });
        const isError = !result.success;

        return {
          content: [{ type: "text" as const, text }],
          isError,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pi-annotate] connect error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `${NOT_CONNECTED_MESSAGE} (${message})`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "create_issue_report",
    {
      title: "Create local issue report",
      description:
        "Open annotation mode, capture selected areas, comments, screenshots, and optional sanitized network request metadata, then persist a local issue report. " +
        "The report is not uploaded and no external ticket is created.",
      inputSchema: {
        browser: annotateInputShape.browser,
        url: annotateInputShape.url,
        timeout: annotateInputShape.timeout,
        title: z.string().optional().describe("Issue title. If omitted, derives one from the annotation context or comments."),
        captureNetwork: z.boolean().optional().default(true).describe("Capture tab-scoped request metadata while annotating. Headers, cookies, and bodies are never captured."),
      },
      outputSchema: {
        ref: z.string(),
        title: z.string(),
        directory: z.string(),
        markdownPath: z.string(),
        jsonPath: z.string(),
        requestCount: z.number(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ browser, url, timeout, title, captureNetwork }, extra) => {
      const timeoutSeconds = timeout ?? 300;
      try {
        const client = getClient(browser);
        const result = await client.annotate({
          url,
          timeout: timeoutSeconds,
          captureNetwork: captureNetwork ?? true,
          signal: extra.signal,
        });
        if (!result.success) {
          return {
            content: [{ type: "text" as const, text: await formatToolResult(result, { timeoutSeconds }) }],
            isError: true,
          };
        }
        const target = client.getBrowserTarget();
        const summary = await saveIssueReport(result, {
          title,
          browser: target
            ? { id: target.id, name: target.name, browser: target.browser }
            : null,
        });
        const structuredContent = {
          ref: summary.ref,
          title: summary.title,
          directory: summary.directory,
          markdownPath: `${summary.directory}/report.md`,
          jsonPath: `${summary.directory}/report.json`,
          requestCount: summary.requestCount,
        };
        return {
          content: [{
            type: "text" as const,
            text:
              `Saved local issue report ${summary.ref}: ${summary.title}\n` +
              `Markdown: ${structuredContent.markdownPath}\n` +
              `JSON: ${structuredContent.jsonPath}\n` +
              `Network requests captured: ${summary.requestCount}`,
          }],
          structuredContent,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pi-annotate] issue report error: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Could not create local issue report: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_issue_reports",
    {
      title: "List local issue reports",
      description: "List recently persisted Pi Annotate issue reports and their local references.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum reports to return. Default: 20."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const reports = await listIssueReports({ limit });
      const text = reports.length
        ? reports.map((report) =>
            `${report.ref} — ${report.title}${report.url ? ` — ${report.url}` : ""}\n  ${report.directory}/report.md`,
          ).join("\n")
        : "No local Pi Annotate issue reports found.";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "get_issue_report",
    {
      title: "Get local issue report",
      description: "Read a persisted Pi Annotate issue report by its stable PIA reference.",
      inputSchema: { ref: z.string().describe("Issue report reference, for example PIA-20260731-120000-A1B2C3D4.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref }) => {
      try {
        const stored = await readIssueReport(ref);
        return {
          content: [{
            type: "text" as const,
            text: `${stored.markdown}\n\nLocal report directory: ${stored.directory}`,
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Issue report ${ref} could not be read: ${message}` }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[pi-annotate] MCP server ${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error("[pi-annotate] fatal:", err);
  process.exit(1);
});
