/**
 * Pi Annotate - full-page capture planners (classic script, global PiCapturePlan).
 *
 * Pure logic for the scroll-and-join capture (plans 1169 and 1170). It makes
 * no browser call and has no DOM access, so Node tests can run it.
 *
 * Three jobs:
 *   1. Plan the scroll positions, and say when a limit stops the capture.
 *   2. Turn one picture into a tile record: the rectangle of the picture that
 *      holds rows not covered yet, and where those rows go in the output.
 *   3. Plan the join: which tile parts go into which output image, so that no
 *      image is larger than the canvas limit.
 *
 * UNITS. Scroll positions and heights in CSS px. Everything that addresses a
 * picture or an output image is in device px (an integer). Row ranges are
 * rounded one time, in device px, so that two tiles never leave a gap or
 * repeat a row.
 *
 * The planners work from the scroll position that the page REPORTS, not from
 * the position that was asked for. A page can clamp a scroll early, and a
 * virtual list can grow or shrink while the capture runs.
 */
(function (root) {
  var MAX_TILES = 60;
  var MAX_HEIGHT = 60000; // CSS px
  var CANVAS_LIMIT = 16384; // device px, one side

  function px(v, dpr) { return Math.round(v * dpr); }

  function limitsOf(limits) {
    var l = limits || {};
    return {
      maxTiles: l.maxTiles || MAX_TILES,
      maxHeight: l.maxHeight || MAX_HEIGHT,
    };
  }

  /**
   * Why the capture must stop, or null. `coveredCss` is the height already
   * captured. A capture that has covered the whole content is complete and
   * gives null, even at a limit.
   */
  function stopReason(tileCount, coveredCss, contentCss, limits) {
    var l = limitsOf(limits);
    if (coveredCss >= contentCss) return null;
    if (coveredCss >= l.maxHeight) return "height";
    if (tileCount >= l.maxTiles) return "tiles";
    return null;
  }

  /**
   * The next scroll position, or null when the content is covered. The last
   * position is clamped to the end, so the last picture overlaps the one
   * before it.
   */
  function nextPosition(coveredDevice, visibleHeight, contentHeight, dpr) {
    var contentDevice = px(contentHeight, dpr);
    if (coveredDevice >= contentDevice) return null;
    var maxScroll = Math.max(0, contentHeight - visibleHeight);
    return Math.min(coveredDevice / dpr, maxScroll);
  }

  /**
   * The scroll positions for content that does not change. The result stops
   * at a limit and names it: { positions, partial: "tiles" | "height" | null }.
   */
  function planPositions(contentHeight, visibleHeight, dpr, limits) {
    var l = limitsOf(limits);
    var positions = [];
    var covered = 0;
    var partial = null;
    var content = Math.min(contentHeight, l.maxHeight);
    if (contentHeight > l.maxHeight) partial = "height";
    var pos;
    while ((pos = nextPosition(covered, visibleHeight, content, dpr)) !== null) {
      if (positions.length >= l.maxTiles) { partial = "tiles"; break; }
      positions.push(pos);
      covered = Math.min(px(pos + visibleHeight, dpr), px(content, dpr));
    }
    return { positions: positions, partial: partial };
  }

  /**
   * One tile from one picture.
   *   reported      scroll position the page reports after the scroll (CSS px)
   *   visible       the visible rectangle of the scroll target in the picture
   *                 (CSS px; the viewport for the document, an inner
   *                 rectangle for an inner scroller)
   *   contentHeight current content height (CSS px)
   *   covered       rows already covered (device px, from the content top)
   * Returns null when the picture adds no new row, else
   *   { src: {x, y, w, h}, destY, covered }   (device px)
   */
  function recordTile(input) {
    var dpr = input.dpr;
    var reportedD = px(input.reported, dpr);
    var visibleD = px(input.visible.height, dpr);
    var contentD = px(input.contentHeight, dpr);
    var start = Math.max(reportedD, input.covered);
    var end = Math.min(reportedD + visibleD, contentD);
    if (end <= start) return null;
    return {
      src: {
        x: px(input.visible.left, dpr),
        y: px(input.visible.top, dpr) + (start - reportedD),
        w: px(input.visible.width, dpr),
        h: end - start,
      },
      destY: start,
      covered: end,
    };
  }

  /**
   * Which tile parts go into which output image. `tiles` are tile records in
   * order. An image is never larger than `limit` on either side; a tile that
   * crosses an image boundary is split. A width above the limit is cropped.
   * Returns [{ width, height, parts: [{ tile, srcX, srcY, w, h, destY }] }]
   * where `tile` is the index in the input list and `destY` is inside the image.
   */
  function planJoin(tiles, limit) {
    var side = limit || CANVAS_LIMIT;
    var images = [];
    var current = null;
    tiles.forEach(function (tile, index) {
      var rowsLeft = tile.src.h;
      var srcY = tile.src.y;
      var destY = tile.destY;
      var w = Math.min(tile.src.w, side);
      while (rowsLeft > 0) {
        if (!current || current.height >= side) {
          current = { width: w, height: 0, top: destY, parts: [] };
          images.push(current);
        }
        var take = Math.min(rowsLeft, side - current.height);
        current.parts.push({ tile: index, srcX: tile.src.x, srcY: srcY, w: w, h: take, destY: destY - current.top });
        current.height += take;
        current.width = Math.max(current.width, w);
        srcY += take;
        destY += take;
        rowsLeft -= take;
      }
    });
    return images.map(function (img) {
      return { width: img.width, height: img.height, parts: img.parts };
    });
  }

  // ── session helpers (plan 1170) ──────────────────────────────────────

  var SCREENSHOT_PADDING = 20; // CSS px around a cropped element
  var REDUCE_LIMIT = 12 * 1024 * 1024; // below the host limit of 15 MB, on purpose
  var SCALE_STEP = 0.75;

  /**
   * True when one rectangle is not fully inside the viewport. The viewport is
   * { width, height, scrollX, scrollY }; the rectangles are in page CSS px
   * ({ left, top, width, height }). A list with no rectangle gives false.
   */
  function needsPageCapture(view, rects) {
    var x0 = view.scrollX || 0;
    var y0 = view.scrollY || 0;
    return rects.some(function (r) {
      return r.left < x0 || r.top < y0 ||
        r.left + r.width > x0 + view.width || r.top + r.height > y0 + view.height;
    });
  }

  /**
   * The crop rectangle in image px for an element rectangle in page CSS px.
   * Adds the padding, scales by the device pixel ratio, and clamps to the
   * image. Returns null when nothing is left.
   */
  function cropRect(rect, padding, dpr, image) {
    var x0 = Math.max(0, Math.round((rect.left - padding) * dpr));
    var y0 = Math.max(0, Math.round((rect.top - padding) * dpr));
    var x1 = Math.min(image.width, Math.round((rect.left + rect.width + padding) * dpr));
    var y1 = Math.min(image.height, Math.round((rect.top + rect.height + padding) * dpr));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * The next action for an image that is `bytes` big. `format` is the format
   * it has now ("png" or "jpeg"). A PNG above the limit is encoded again as
   * JPEG; a JPEG above the limit is scaled down by steps of 0.75.
   */
  function reducePlan(bytes, limit, format) {
    if (bytes <= (limit || REDUCE_LIMIT)) return { action: "keep" };
    if (format === "png") return { action: "jpeg" };
    return { action: "scale", factor: SCALE_STEP };
  }

  root.PiCapturePlan = {
    SCREENSHOT_PADDING: SCREENSHOT_PADDING,
    REDUCE_LIMIT: REDUCE_LIMIT,
    needsPageCapture: needsPageCapture,
    cropRect: cropRect,
    reducePlan: reducePlan,
    MAX_TILES: MAX_TILES,
    MAX_HEIGHT: MAX_HEIGHT,
    CANVAS_LIMIT: CANVAS_LIMIT,
    stopReason: stopReason,
    nextPosition: nextPosition,
    planPositions: planPositions,
    recordTile: recordTile,
    planJoin: planJoin,
  };
})(globalThis);
