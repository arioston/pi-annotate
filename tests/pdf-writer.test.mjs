import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
loadClassic("chrome-extension/lib/pdf-writer.js", sandbox);
const W = sandbox.PiPdfWriter;

// A 2 x 2 px JPEG (built once with an image tool).
const JPEG_HEX = "ffd8ffe000104a46494600010100000100010000ffdb0043000d090a0b0a080d0b0a0b0e0e0d0f13201513121213271c1e17202e2931302e292d2c333a4a3e333646372c2d405741464c4e525352323e5a615a50604a51524fffdb0043010e0e0e131113261515264f352d354f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4fffc00011080002000203012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00c2a28a2bce3ec4ffd9";
const JPEG = new Uint8Array(JPEG_HEX.match(/../g).map((h) => parseInt(h, 16)));
const jpeg = { bytes: JPEG, width: 2, height: 2 };
const text = (bytes) => Buffer.from(bytes).toString("latin1");
const page = (extra = {}) => ({ width: 595.28, height: 841.89, jpeg, ...extra });
const info = { title: "T", url: "https://example.com/", created: new Date(Date.UTC(2026, 10, 11, 12, 0, 0)) };

test("the output starts with %PDF-1.4 and ends with %%EOF", () => {
  const out = W.buildPdf([page()], info);
  const s = text(out);
  assert.ok(s.startsWith("%PDF-1.4"));
  assert.ok(s.endsWith("%%EOF"));
});

test("each xref offset points at the byte where its object starts", () => {
  const out = W.buildPdf([page(), page()], info);
  const s = text(out);
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(s)[1]);
  assert.equal(s.slice(xrefAt, xrefAt + 4), "xref");
  const lines = s.slice(xrefAt).split("\n");
  const size = Number(/^0 (\d+)$/.exec(lines[1])[1]);
  assert.equal(size, 3 + 2 * 3 + 1);
  for (let n = 1; n < size; n++) {
    const entry = lines[2 + n];
    const offset = Number(entry.slice(0, 10));
    assert.ok(entry.endsWith(" 00000 n "), entry);
    assert.equal(s.slice(offset, offset + String(n).length + 7), n + " 0 obj\n");
  }
});

test("/Count equals the page count and each page has a /MediaBox", () => {
  const s = text(W.buildPdf([page(), page(), page()], info));
  assert.match(s, /\/Count 3 /);
  assert.equal((s.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, 3);
});

test("the JPEG bytes are in the file unchanged and /Length matches", () => {
  const out = W.buildPdf([page()], info);
  const s = text(out);
  assert.match(s, new RegExp("/Length " + JPEG.length + " >>\\nstream\\n"));
  const at = s.indexOf(text(JPEG));
  assert.ok(at > 0);
  assert.deepEqual([...out.slice(at, at + JPEG.length)], [...JPEG]);
});

test("a title with ( ) and a backslash is escaped", () => {
  const s = text(W.buildPdf([page()], { ...info, title: "a(b)c\\d" }));
  assert.ok(s.includes("/Title (a\\(b\\)c\\\\d)"));
});

test("layout: 1200 x 5000 on A4 covers every row once", () => {
  const pages = W.layoutPages(1200, 5000, "a4");
  const rowsPerPage = 841.89 / (595.28 / 1200);
  assert.equal(pages.length, Math.ceil(5000 / rowsPerPage));
  let next = 0;
  for (const p of pages) {
    assert.equal(p.y0, next);
    assert.ok(p.y1 > p.y0);
    next = p.y1;
  }
  assert.equal(next, 5000);
  assert.equal(W.layoutPages(1200, 5000, "letter")[0].width, 612);
});

test("layout: one-page above 14400 points gives more than one page", () => {
  const tall = W.layoutPages(800, 40000, "one-page");
  assert.ok(tall.length > 1);
  assert.ok(tall.every((p) => p.height <= 14400 && p.width <= 14400));
  assert.equal(tall[tall.length - 1].y1, 40000);
  const short = W.layoutPages(800, 4000, "one-page");
  assert.equal(short.length, 1);
  assert.equal(short[0].y1, 4000);
});

test("pdfinfo accepts the output (skipped when not installed)", (t) => {
  const probe = spawnSync("pdfinfo", ["-v"]);
  if (probe.error) return t.skip("pdfinfo not installed");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pdfw-")), "t.pdf");
  fs.writeFileSync(file, W.buildPdf([page(), page()], info));
  const r = spawnSync("pdfinfo", [file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pages:\s+2/);
});
