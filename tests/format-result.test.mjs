import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "format-result.md");
const cjsPath = path.join(here, "..", "src", "format-result.cjs");
const FIXED_NOW = 1700000000000;
// 1x1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WEBP = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const element = (over = {}) => ({
  selector: "#hero",
  tag: "section",
  id: "hero",
  classes: ["a", "b"],
  text: "Hello world",
  rect: { x: 0, y: 10, width: 300, height: 200 },
  attributes: { role: "banner" },
  boxModel: {
    content: { width: 280, height: 180 },
    padding: { top: "10px", right: "10px", bottom: "10px", left: "10px" },
    border: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
  },
  accessibility: { role: "banner", name: "Top", description: null, focusable: false, disabled: false, expanded: true },
  keyStyles: { display: "block", color: "red" },
  comment: "Make it bigger",
  ...over,
});

const base = (over = {}) => ({
  success: true,
  url: "https://example.test/page",
  viewport: { width: 1280, height: 720 },
  elements: [element()],
  ...over,
});

const cases = () => ({
  "one element with a comment": base({ prompt: "General context" }),
  "element screenshots": base({ screenshots: [{ index: 1, dataUrl: PNG }, { index: 2, dataUrl: "not-an-image" }] }),
  "full screenshot": base({ screenshot: PNG }),
  "attachment": base({
    elements: [element({ attachments: [{ id: "x", name: "ref.webp", mimeType: "image/webp", width: 1, height: 1, size: 10, dataUrl: WEBP }] })],
  }),
  "etch capture": base({
    editCapture: {
      inlineStyles: [{ selector: "#hero", changed: [{ property: "color", from: "red", to: "blue" }], added: { margin: "0" }, removed: ["padding"] }],
      rules: [{ ruleSelector: ".a", sheet: "inline", changed: [], added: { color: "green" }, removed: [] }],
      dom: [{ selector: "#hero", detail: "DOM structure modified (children added/removed)" }],
      beforeScreenshot: PNG,
      afterScreenshot: PNG,
      duration: 4200,
      changeCount: 3,
      warnings: ["1 cross-origin stylesheet(s) could not be tracked"],
    },
  }),
  "debug data": base({
    elements: [element({ computedStyles: { color: "red" }, parentContext: { tag: "main", id: null, classes: ["x"], styles: { display: "flex" } }, cssVariables: { "--a": "1" } })],
  }),
  "no elements": base({ elements: [] }),
  "non-ascii comment": base({ elements: [element({ comment: "ação ✓ 日本" })] }),
  "cancel by user": { success: false, cancelled: true, reason: "user" },
  "cancel with reason": { success: false, cancelled: true, reason: "Another client took over" },
  "cancel other reason": { success: false, cancelled: true, reason: "navigation_timeout" },
  "failure": { success: false, reason: "boom" },
});

async function render(impl, tmp) {
  const savedNow = Date.now;
  const savedTmp = process.env.TMPDIR;
  Date.now = () => FIXED_NOW;
  process.env.TMPDIR = tmp;
  try {
    const parts = [];
    for (const [name, result] of Object.entries(cases())) {
      parts.push(`<!-- case: ${name} -->\n${await impl.formatResult(result)}`);
    }
    parts.push(`<!-- case: tool abort -->\n${await impl.formatToolResult({ success: false, cancelled: true, reason: "aborted" })}`);
    parts.push(`<!-- case: tool timeout -->\n${await impl.formatToolResult({ success: false, cancelled: true, timeout: true }, { timeoutSeconds: 12 })}`);
    parts.push(`<!-- case: tool timeout default -->\n${await impl.formatToolResult({ success: false, cancelled: true, reason: "timeout" })}`);
    parts.push(`<!-- case: tool passthrough -->\n${await impl.formatToolResult(base())}`);
    return parts.join("\n\n").split(tmp).join("<TMP>");
  } finally {
    Date.now = savedNow;
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  }
}

async function implementations() {
  const impls = [["core.ts", await import("../src/core.ts")]];
  if (fs.existsSync(cjsPath)) impls.push(["format-result.cjs", createRequire(import.meta.url)(cjsPath)]);
  return impls;
}

for (const label of ["core.ts", "format-result.cjs"]) {
  test(`formatResult output matches the fixture (${label})`, async (t) => {
    const impl = (await implementations()).find(([name]) => name === label)?.[1];
    if (!impl) return t.skip(`${label} does not exist yet`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-fmt-"));
    try {
      const output = await render(impl, tmp);
      assert.equal(output.includes(os.tmpdir() + path.sep + "pi-annotate-fmt-"), false, "no machine path in output");
      if (process.env.UPDATE_FIXTURE === "1") fs.writeFileSync(fixturePath, output);
      assert.equal(output, fs.readFileSync(fixturePath, "utf8"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("the fixture carries no machine path", () => {
  const text = fs.readFileSync(fixturePath, "utf8");
  assert.equal(/\/home\/|\/Users\/|\/var\/folders/.test(text), false);
  assert.equal(text.includes("<TMP>"), true);
});
