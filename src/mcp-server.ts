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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[pi-annotate] MCP server ${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error("[pi-annotate] fatal:", err);
  process.exit(1);
});
