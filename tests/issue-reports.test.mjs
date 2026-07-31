import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  listIssueReports,
  readIssueReport,
  saveIssueReport,
} from "../src/issue-reports.ts";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("persists a self-contained local issue report without embedded image data", async (t) => {
  const reportsDir = await mkdtemp(path.join(process.cwd(), ".pi-annotate-issues-test-"));
  t.after(() => rm(reportsDir, { recursive: true, force: true }));

  const summary = await saveIssueReport({
    success: true,
    url: "https://example.test/dashboard",
    prompt: "The save button fails after editing a profile",
    viewport: { width: 1280, height: 720 },
    elements: [{
      selector: "#save",
      tag: "button",
      id: "save",
      classes: ["primary"],
      text: "Save",
      rect: { x: 100, y: 200, width: 120, height: 40 },
      attributes: { type: "submit" },
      comment: "Clicking this leaves the form in a loading state",
      attachments: [{
        id: "reference-1",
        name: "design-reference.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        size: 68,
        dataUrl: ONE_PIXEL_PNG,
      }],
    }],
    screenshots: [{ index: 1, dataUrl: ONE_PIXEL_PNG }],
    network: {
      startedAt: "2026-07-31T12:00:00.000Z",
      endedAt: "2026-07-31T12:00:01.000Z",
      durationMs: 1000,
      truncated: false,
      requests: [{
        url: "https://example.test/api/profile?token=%5Bredacted%5D",
        method: "POST",
        type: "xmlhttprequest",
        startedAtMs: 100,
        durationMs: 240,
        statusCode: 500,
        fromCache: false,
      }],
    },
  }, {
    reportsDir,
    title: "Profile save remains loading",
    browser: { id: "work", name: "Work Chrome", browser: "Google Chrome" },
  });

  assert.match(summary.ref, /^PIA-\d{8}-\d{6}-[A-F0-9]{8}$/);
  assert.equal(summary.requestCount, 1);
  const markdown = await readFile(path.join(summary.directory, "report.md"), "utf8");
  const json = await readFile(path.join(summary.directory, "report.json"), "utf8");
  assert.match(markdown, /Profile save remains loading/);
  assert.match(markdown, /Network context \(1 requests/);
  assert.match(markdown, /POST/);
  assert.match(markdown, /!\[Annotated element 1\]\(assets\/element-1\.png\)/);
  assert.match(markdown, /Reference images/);
  assert.match(markdown, /element-1-reference-1\.png/);
  assert.doesNotMatch(json, /base64/);
  assert.equal((await stat(path.join(summary.directory, "assets", "element-1.png"))).isFile(), true);
  assert.equal((await stat(path.join(summary.directory, "assets", "element-1-reference-1.png"))).isFile(), true);

  const listed = await listIssueReports({ reportsDir });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ref, summary.ref);
  const stored = await readIssueReport(summary.ref.toLowerCase(), reportsDir);
  assert.equal(stored.report.title, "Profile save remains loading");
  assert.equal(stored.report.result.network.requests[0].statusCode, 500);
});

test("rejects traversal-like report references", async () => {
  await assert.rejects(() => readIssueReport("../../etc/passwd"), /Invalid issue report reference/);
});
