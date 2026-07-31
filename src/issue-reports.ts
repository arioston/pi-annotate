import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { AnnotationResult, NetworkRequestContext } from "../types.js";

const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const REPORT_REF_PATTERN = /^PIA-\d{8}-\d{6}-[A-F0-9]{8}$/;

export const ISSUE_REPORTS_DIR = process.env.PI_ANNOTATE_DATA_DIR
  ? path.resolve(process.env.PI_ANNOTATE_DATA_DIR, "issues")
  : path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
      "pi-annotate",
      "issues",
    );

export type IssueReportAsset = {
  kind: "full" | "element" | "reference" | "before" | "after";
  path: string;
  elementIndex?: number;
  attachmentIndex?: number;
};

export type StoredIssueReport = {
  schemaVersion: 1;
  ref: string;
  title: string;
  createdAt: string;
  browser?: { id: string; name: string; browser: string };
  result: AnnotationResult;
  assets: IssueReportAsset[];
};

export type IssueReportSummary = {
  ref: string;
  title: string;
  createdAt: string;
  url?: string;
  browser?: string;
  requestCount: number;
  directory: string;
};

export type SaveIssueReportOptions = {
  title?: string;
  reportsDir?: string;
  browser?: { id: string; name: string; browser: string } | null;
};

function createRef(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `PIA-${stamp}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function inferTitle(result: AnnotationResult): string {
  const prompt = result.prompt?.trim();
  if (prompt) return prompt.slice(0, 160);
  const comment = result.elements?.find((element) => element.comment?.trim())?.comment?.trim();
  if (comment) return comment.slice(0, 160);
  try {
    return `Issue on ${new URL(result.url || "").hostname || "annotated page"}`;
  } catch {
    return "Annotated UI issue";
  }
}

function decodeImage(dataUrl: string): { bytes: Buffer; extension: string } {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid screenshot data URL");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot exceeds 15MB limit");
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  return { bytes, extension };
}

async function persistImage(
  dataUrl: string | undefined,
  baseName: string,
  kind: IssueReportAsset["kind"],
  directory: string,
  assets: IssueReportAsset[],
  elementIndex?: number,
  attachmentIndex?: number,
) {
  if (!dataUrl) return;
  const { bytes, extension } = decodeImage(dataUrl);
  const relativePath = path.join("assets", `${baseName}.${extension}`);
  await fs.promises.writeFile(path.join(directory, relativePath), bytes, { mode: 0o600 });
  assets.push({
    kind,
    path: relativePath,
    ...(elementIndex ? { elementIndex } : {}),
    ...(attachmentIndex ? { attachmentIndex } : {}),
  });
}

function stripEmbeddedImages(result: AnnotationResult, assets: IssueReportAsset[]): AnnotationResult {
  return {
    ...result,
    screenshot: undefined,
    screenshots: undefined,
    elements: result.elements?.map((element, elementOffset) => ({
      ...element,
      attachments: element.attachments?.map((attachment, attachmentOffset) => {
        const asset = assets.find(
          (candidate) => candidate.kind === "reference" &&
            candidate.elementIndex === elementOffset + 1 &&
            candidate.attachmentIndex === attachmentOffset + 1,
        );
        const { dataUrl: _embeddedImage, ...metadata } = attachment;
        return asset ? { ...metadata, path: asset.path } : metadata;
      }),
    })),
    editCapture: result.editCapture
      ? {
          ...result.editCapture,
          beforeScreenshot: undefined,
          afterScreenshot: undefined,
        }
      : undefined,
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatNetworkRow(request: NetworkRequestContext): string {
  const status = request.error ? `Error: ${request.error}` : request.statusCode ?? "pending";
  return `| ${markdownCell(request.method)} | ${markdownCell(status)} | ${markdownCell(request.type)} | ${request.durationMs ?? "—"} | ${markdownCell(request.url)} |`;
}

export function formatIssueReportMarkdown(report: StoredIssueReport): string {
  const { result } = report;
  let output = `# ${report.title}\n\n`;
  output += `- **Reference:** \`${report.ref}\`\n`;
  output += `- **Created:** ${report.createdAt}\n`;
  if (result.url) output += `- **URL:** ${result.url}\n`;
  if (report.browser) output += `- **Browser:** ${report.browser.name} (${report.browser.browser})\n`;
  if (result.viewport) output += `- **Viewport:** ${result.viewport.width}×${result.viewport.height}\n`;
  output += "\n";

  if (result.prompt) output += `## Context\n\n${result.prompt}\n\n`;

  output += `## Annotated areas (${result.elements?.length || 0})\n\n`;
  for (const [index, element] of (result.elements || []).entries()) {
    output += `### ${index + 1}. \`${element.selector}\`\n\n`;
    if (element.comment) output += `${element.comment}\n\n`;
    output += `- Element: \`${element.tag}\`${element.id ? ` with id \`${element.id}\`` : ""}\n`;
    if (element.text) output += `- Text: ${element.text}\n`;
    output += `- Bounds: ${element.rect.width}×${element.rect.height} at (${element.rect.x}, ${element.rect.y})\n`;
    const screenshot = report.assets.find(
      (asset) => asset.kind === "element" && asset.elementIndex === index + 1,
    );
    if (screenshot) output += `\n![Annotated element ${index + 1}](${screenshot.path})\n`;
    const references = report.assets.filter(
      (asset) => asset.kind === "reference" && asset.elementIndex === index + 1,
    );
    if (references.length) {
      output += "\n#### Reference images\n\n";
      for (const [referenceIndex, reference] of references.entries()) {
        const label = result.elements?.[index]?.attachments?.[referenceIndex]?.name || `Reference ${referenceIndex + 1}`;
        output += `![${markdownCell(label)}](${reference.path})\n\n`;
      }
    }
    output += "\n";
  }

  const otherAssets = report.assets.filter((asset) => asset.kind !== "element" && asset.kind !== "reference");
  if (otherAssets.length > 0) {
    output += "## Screenshots\n\n";
    for (const asset of otherAssets) {
      output += `### ${asset.kind}\n\n![${asset.kind} screenshot](${asset.path})\n\n`;
    }
    output += "\n";
  }

  if (result.network) {
    const network = result.network;
    output += `## Network context (${network.requests.length} requests, ${network.durationMs}ms)\n\n`;
    output += "Request and response headers, cookies, and bodies are intentionally not captured. Sensitive query values are redacted.\n\n";
    if (network.truncated) output += `> Capture was limited to the first ${network.requests.length} requests.\n\n`;
    output += "| Method | Status | Type | Duration (ms) | URL |\n";
    output += "|---|---:|---|---:|---|\n";
    for (const request of network.requests) output += `${formatNetworkRow(request)}\n`;
    output += "\n";
  }

  output += `Raw structured data: [report.json](report.json)\n`;
  return output;
}

export async function saveIssueReport(
  result: AnnotationResult,
  options: SaveIssueReportOptions = {},
): Promise<IssueReportSummary> {
  if (!result.success) throw new Error("Only completed annotations can be saved as issue reports");
  const reportsDir = path.resolve(options.reportsDir || ISSUE_REPORTS_DIR);
  await fs.promises.mkdir(reportsDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(reportsDir, 0o700);

  const ref = createRef();
  const temporaryDirectory = path.join(reportsDir, `.${ref}.tmp-${process.pid}`);
  const reportDirectory = path.join(reportsDir, ref);
  await fs.promises.mkdir(path.join(temporaryDirectory, "assets"), { recursive: true, mode: 0o700 });

  try {
    const assets: IssueReportAsset[] = [];
    await persistImage(result.screenshot, "full-page", "full", temporaryDirectory, assets);
    for (const screenshot of result.screenshots || []) {
      await persistImage(
        screenshot.dataUrl,
        `element-${Math.max(1, Math.floor(screenshot.index))}`,
        "element",
        temporaryDirectory,
        assets,
        screenshot.index,
      );
    }
    for (const [elementOffset, element] of (result.elements || []).entries()) {
      for (const [attachmentOffset, attachment] of (element.attachments || []).entries()) {
        await persistImage(
          attachment.dataUrl,
          `element-${elementOffset + 1}-reference-${attachmentOffset + 1}`,
          "reference",
          temporaryDirectory,
          assets,
          elementOffset + 1,
          attachmentOffset + 1,
        );
      }
    }
    await persistImage(
      result.editCapture?.beforeScreenshot,
      "before",
      "before",
      temporaryDirectory,
      assets,
    );
    await persistImage(
      result.editCapture?.afterScreenshot,
      "after",
      "after",
      temporaryDirectory,
      assets,
    );

    const report: StoredIssueReport = {
      schemaVersion: 1,
      ref,
      title: options.title?.trim().slice(0, 160) || inferTitle(result),
      createdAt: new Date().toISOString(),
      ...(options.browser ? { browser: options.browser } : {}),
      result: stripEmbeddedImages(result, assets),
      assets,
    };
    await fs.promises.writeFile(
      path.join(temporaryDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.promises.writeFile(
      path.join(temporaryDirectory, "report.md"),
      formatIssueReportMarkdown(report),
      { mode: 0o600 },
    );
    await fs.promises.rename(temporaryDirectory, reportDirectory);

    return {
      ref,
      title: report.title,
      createdAt: report.createdAt,
      url: report.result.url,
      browser: report.browser?.name,
      requestCount: report.result.network?.requests.length || 0,
      directory: reportDirectory,
    };
  } catch (err) {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    throw err;
  }
}

function validateRef(ref: string): string {
  const normalized = ref.trim().toUpperCase();
  if (!REPORT_REF_PATTERN.test(normalized)) throw new Error(`Invalid issue report reference: ${ref}`);
  return normalized;
}

export async function readIssueReport(
  ref: string,
  reportsDir = ISSUE_REPORTS_DIR,
): Promise<{ report: StoredIssueReport; markdown: string; directory: string }> {
  const normalized = validateRef(ref);
  const directory = path.join(path.resolve(reportsDir), normalized);
  const [json, markdown] = await Promise.all([
    fs.promises.readFile(path.join(directory, "report.json"), "utf8"),
    fs.promises.readFile(path.join(directory, "report.md"), "utf8"),
  ]);
  return { report: JSON.parse(json) as StoredIssueReport, markdown, directory };
}

export async function listIssueReports(
  options: { reportsDir?: string; limit?: number } = {},
): Promise<IssueReportSummary[]> {
  const reportsDir = path.resolve(options.reportsDir || ISSUE_REPORTS_DIR);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 20)));
  let entries: string[];
  try {
    entries = await fs.promises.readdir(reportsDir);
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }

  const summaries: IssueReportSummary[] = [];
  for (const ref of entries.filter((entry) => REPORT_REF_PATTERN.test(entry)).sort().reverse()) {
    try {
      const { report, directory } = await readIssueReport(ref, reportsDir);
      summaries.push({
        ref: report.ref,
        title: report.title,
        createdAt: report.createdAt,
        url: report.result.url,
        browser: report.browser?.name,
        requestCount: report.result.network?.requests.length || 0,
        directory,
      });
      if (summaries.length >= limit) break;
    } catch {
      // Ignore incomplete/corrupt directories rather than hiding valid reports.
    }
  }
  return summaries;
}
