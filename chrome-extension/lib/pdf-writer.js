/**
 * Pi Annotate - minimal PDF writer (classic script, global PiPdfWriter).
 *
 * Pure logic for the capture result page (plan 1169). It builds a PDF 1.4 file
 * in which each page holds one JPEG picture. It also plans how an image is
 * split into pages. It makes no browser call and has no DOM access, so Node
 * tests can run it.
 *
 * File layout: header, catalog, page tree, information dictionary, then three
 * objects for each page (page, image XObject with /DCTDecode, content stream),
 * the xref table with exact byte offsets, and the trailer. The JPEG bytes are
 * copied into the file unchanged.
 *
 * No live links and no text. Page sizes are in points (1/72 inch).
 */
(function (root) {
  var A4 = { width: 595.28, height: 841.89 };
  var LETTER = { width: 612, height: 792 };
  var MAX_PAGE_SIDE = 14400; // points, the PDF limit
  var POINTS_PER_CSS_PX = 0.75;

  function fmt(n) {
    var s = (Math.round(n * 100) / 100).toFixed(2);
    return s.replace(/\.?0+$/, "");
  }

  // ── bytes ─────────────────────────────────────────────────────────────

  function latin1(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function concat(chunks, total) {
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  // A PDF text string: a literal with (, ), and \ escaped; UTF-16BE hex when
  // the text holds a character above 126.
  function textString(value) {
    var s = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ");
    if (/[^ -~]/.test(s)) {
      var hex = "FEFF";
      for (var i = 0; i < s.length; i++) hex += ("0000" + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
      return "<" + hex + ">";
    }
    return "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
  }

  function pdfDate(date) {
    var d = date instanceof Date ? date : new Date(date || 0);
    if (isNaN(d.getTime())) d = new Date(0);
    function p(n, w) { return ("0000" + n).slice(-(w || 2)); }
    return "D:" + p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
  }

  // ── writer ────────────────────────────────────────────────────────────

  /**
   * buildPdf(pages, info) -> Uint8Array
   *   pages: [{ width, height, drawWidth?, drawHeight?, jpeg: { bytes, width, height } }]
   *          width and height are the page size in points; the picture is
   *          drawn at the top-left, drawWidth x drawHeight (default: the page).
   *   info:  { title, url, created }
   */
  function buildPdf(pages, info) {
    var meta = info || {};
    var chunks = [];
    var total = 0;
    var offsets = [];

    function put(bytes) { chunks.push(bytes); total += bytes.length; }
    function putText(str) { put(latin1(str)); }
    function beginObject(n) { offsets[n] = total; putText(n + " 0 obj\n"); }
    function endObject() { putText("endobj\n"); }

    putText("%PDF-1.4\n");
    put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    var first = 4; // objects 1-3 are the catalog, the page tree, and the info
    var kids = pages.map(function (_, i) { return (first + i * 3) + " 0 R"; });

    beginObject(1);
    putText("<< /Type /Catalog /Pages 2 0 R >>\n");
    endObject();

    beginObject(2);
    putText("<< /Type /Pages /Count " + pages.length + " /Kids [" + kids.join(" ") + "] >>\n");
    endObject();

    beginObject(3);
    putText("<< /Title " + textString(meta.title) + " /Subject " + textString(meta.url) +
      " /Producer (Pi Annotate) /CreationDate (" + pdfDate(meta.created) + ") >>\n");
    endObject();

    pages.forEach(function (page, i) {
      var pageObj = first + i * 3;
      var imageObj = pageObj + 1;
      var contentObj = pageObj + 2;
      var drawW = page.drawWidth == null ? page.width : page.drawWidth;
      var drawH = page.drawHeight == null ? page.height : page.drawHeight;
      var stream = "q\n" + fmt(drawW) + " 0 0 " + fmt(drawH) + " 0 " + fmt(page.height - drawH) + " cm\n/Im0 Do\nQ\n";

      beginObject(pageObj);
      putText("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + fmt(page.width) + " " + fmt(page.height) +
        "] /Resources << /XObject << /Im0 " + imageObj + " 0 R >> >> /Contents " + contentObj + " 0 R >>\n");
      endObject();

      beginObject(imageObj);
      putText("<< /Type /XObject /Subtype /Image /Width " + page.jpeg.width + " /Height " + page.jpeg.height +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + page.jpeg.bytes.length + " >>\nstream\n");
      put(page.jpeg.bytes);
      putText("\nendstream\n");
      endObject();

      beginObject(contentObj);
      putText("<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream\n");
      endObject();
    });

    var count = first + pages.length * 3;
    var xrefAt = total;
    var xref = "xref\n0 " + count + "\n0000000000 65535 f \n";
    for (var n = 1; n < count; n++) xref += ("0000000000" + offsets[n]).slice(-10) + " 00000 n \n";
    putText(xref);
    putText("trailer\n<< /Size " + count + " /Root 1 0 R /Info 3 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF");
    return concat(chunks, total);
  }

  // ── layout ────────────────────────────────────────────────────────────

  /**
   * layoutPages(imageWidth, imageHeight, paper) -> [{ width, height, drawWidth,
   * drawHeight, y0, y1 }]. The image size is in CSS px (any one unit works;
   * y0 and y1 are in that unit). `paper` is "a4", "letter", or "one-page".
   * The image fills the page width. Pages are split at the page height with
   * cumulative rounding, so no row is missing or repeated.
   */
  function layoutPages(imageWidth, imageHeight, paper) {
    var pageW;
    var pageH;
    if (paper === "letter") { pageW = LETTER.width; pageH = LETTER.height; }
    else if (paper === "one-page") {
      pageW = Math.min(imageWidth * POINTS_PER_CSS_PX, MAX_PAGE_SIDE);
      pageH = Math.min(imageHeight * (pageW / imageWidth), MAX_PAGE_SIDE);
    } else { pageW = A4.width; pageH = A4.height; }
    var scale = pageW / imageWidth; // points for each image unit
    var rowsPerPage = pageH / scale;
    var count = Math.max(1, Math.ceil(imageHeight / rowsPerPage - 1e-9));
    var pages = [];
    for (var i = 0; i < count; i++) {
      var y0 = Math.round(i * rowsPerPage);
      var y1 = i === count - 1 ? imageHeight : Math.min(imageHeight, Math.round((i + 1) * rowsPerPage));
      pages.push({ width: pageW, height: pageH, drawWidth: pageW, drawHeight: (y1 - y0) * scale, y0: y0, y1: y1 });
    }
    return pages;
  }

  root.PiPdfWriter = {
    MAX_PAGE_SIDE: MAX_PAGE_SIDE,
    buildPdf: buildPdf,
    layoutPages: layoutPages,
    textString: textString,
  };
})(globalThis);
