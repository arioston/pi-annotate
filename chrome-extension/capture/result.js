/**
 * Pi Annotate - full-page capture result page (plan 1169)
 *
 * Works only from the stored capture (invariant 6): it never reads the
 * captured tab and never uses the network. It joins the stored tiles into one
 * canvas for each output image (PiCapturePlan.planJoin), shows them, and
 * offers: download PNG or JPG, copy, and export as PDF (PiPdfWriter).
 */
(function () {
  "use strict";

  var JPEG_QUALITY = 0.9;
  var ids = ["source", "facts", "partial", "actions", "images", "status", "paper"];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });

  var capture = null;
  var canvases = [];

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle("error", !!isError);
  }

  function showMissing() {
    el.images.replaceChildren();
    var p = document.createElement("p");
    p.className = "empty";
    p.textContent = "This capture is no longer stored.";
    el.images.appendChild(p);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function stamp(ms) {
    var d = new Date(ms);
    return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function hostOf(url) {
    try { return new URL(url).hostname || "page"; } catch (err) { return "page"; }
  }

  function fileName(part, ext) {
    var base = hostOf(capture.url) + "-" + stamp(capture.created) + (part ? "-part" + part : "");
    return base.replace(/[^A-Za-z0-9._-]/g, "-") + "." + ext;
  }

  function reasonText(reason) {
    return reason === "height"
      ? "The page is longer than 60000 CSS px. The image holds the first part."
      : "The capture reached 60 pictures. The image holds the first part.";
  }

  function build(bitmaps) {
    var tiles = capture.tiles.map(function (t) { return { src: t.src, destY: t.destY }; });
    return PiCapturePlan.planJoin(tiles).map(function (img) {
      var canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext("2d");
      img.parts.forEach(function (p) {
        ctx.drawImage(bitmaps[p.tile], p.srcX, p.srcY, p.w, p.h, 0, p.destY, p.w, p.h);
      });
      return canvas;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error("Could not encode the image")); }, type, quality);
    });
  }

  // JPEG has no alpha: draw on white first.
  function flatten(canvas) {
    var flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    var ctx = flat.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat;
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function downloadImages(type, ext, quality) {
    var chain = Promise.resolve();
    canvases.forEach(function (canvas, i) {
      chain = chain.then(function () {
        var source = type === "image/jpeg" ? flatten(canvas) : canvas;
        return toBlob(source, type, quality).then(function (blob) {
          save(blob, fileName(canvases.length > 1 ? i + 1 : 0, ext));
        });
      });
    });
    return chain.then(function () {
      setStatus("Downloaded " + canvases.length + " " + ext.toUpperCase() + " file" + (canvases.length > 1 ? "s" : "") + ".");
    });
  }

  function copyImage() {
    return toBlob(canvases[0], "image/png").then(function (blob) {
      return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }).then(function () {
      setStatus(canvases.length > 1 ? "Copied the first of " + canvases.length + " images." : "Copied the image.");
    });
  }

  // Rows y0..y1 of the whole image, drawn from the output canvases in order.
  function drawRows(ctx, y0, y1) {
    var offset = 0;
    canvases.forEach(function (canvas) {
      var top = Math.max(y0, offset);
      var bottom = Math.min(y1, offset + canvas.height);
      if (bottom > top) ctx.drawImage(canvas, 0, top - offset, canvas.width, bottom - top, 0, top - y0, canvas.width, bottom - top);
      offset += canvas.height;
    });
  }

  function exportPdf() {
    var width = canvases.reduce(function (m, c) { return Math.max(m, c.width); }, 0);
    var height = canvases.reduce(function (s, c) { return s + c.height; }, 0);
    var layout = PiPdfWriter.layoutPages(width, height, el.paper.value);
    var pages = [];
    var chain = Promise.resolve();
    layout.forEach(function (page) {
      chain = chain.then(function () {
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = page.y1 - page.y0;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawRows(ctx, page.y0, page.y1);
        return toBlob(canvas, "image/jpeg", JPEG_QUALITY).then(function (blob) { return blob.arrayBuffer(); }).then(function (buf) {
          pages.push({
            width: page.width,
            height: page.height,
            drawWidth: page.drawWidth,
            drawHeight: page.drawHeight,
            jpeg: { bytes: new Uint8Array(buf), width: canvas.width, height: canvas.height },
          });
        });
      });
    });
    return chain.then(function () {
      var bytes = PiPdfWriter.buildPdf(pages, { title: capture.title || capture.url, url: capture.url, created: new Date(capture.created) });
      save(new Blob([bytes], { type: "application/pdf" }), fileName(0, "pdf"));
      setStatus("Saved a PDF with " + pages.length + " page" + (pages.length > 1 ? "s" : "") + ".");
    });
  }

  function action(id, run) {
    document.getElementById(id).addEventListener("click", function () {
      setStatus("Working...");
      Promise.resolve().then(run).catch(function (err) {
        setStatus(err && err.message ? err.message : String(err), true);
      });
    });
  }

  function show() {
    el.source.textContent = capture.url;
    var w = canvases.reduce(function (m, c) { return Math.max(m, c.width); }, 0);
    var h = canvases.reduce(function (s, c) { return s + c.height; }, 0);
    el.facts.textContent = new Date(capture.created).toLocaleString() + " · " + w + " × " + h + " px" +
      (canvases.length > 1 ? " · " + canvases.length + " images" : "");
    if (capture.partial) {
      el.partial.hidden = false;
      el.partial.textContent = "Partial. " + reasonText(capture.partial);
    }
    el.images.replaceChildren.apply(el.images, canvases);
    el.actions.hidden = false;
    action("dl-png", function () { return downloadImages("image/png", "png"); });
    action("dl-jpg", function () { return downloadImages("image/jpeg", "jpg", JPEG_QUALITY); });
    action("copy", copyImage);
    action("dl-pdf", exportPdf);
  }

  function start() {
    var id = new URLSearchParams(location.search).get("id");
    if (!id) return showMissing();
    PiCaptureStore.read(id).then(function (found) {
      if (!found || !found.tiles || !found.tiles.length) return showMissing();
      capture = found;
      return Promise.all(found.tiles.map(function (t) { return createImageBitmap(t.blob); })).then(function (bitmaps) {
        canvases = build(bitmaps);
        bitmaps.forEach(function (b) { b.close(); });
        show();
      });
    }).catch(function (err) {
      showMissing();
      setStatus(err && err.message ? err.message : String(err), true);
    });
  }

  start();
})();
