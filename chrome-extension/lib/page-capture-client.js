/**
 * Pi Annotate - page capture client (classic script, global PiPageCaptureClient).
 *
 * The content script side of the session page capture (plans 1170 and 1173).
 * It asks the background for a page capture, then reads the pictures one at a
 * time, each in its own message (a runtime message above 64 MiB is refused).
 * It has no DOM access, so Node tests can run it with a fake runtime.
 * Any failure throws; the caller then uses the viewport picture.
 */
(function (root) {
  // send: PiSafeRuntime.sendMessageSafe or a fake with the same result shape.
  async function request(send, generation) {
    var sent = await send({ type: "CAPTURE_PAGE", generation: generation });
    if (!sent.ok) throw new Error("The extension is not available. Reload the page and try again.");
    var run = sent.value;
    if (run && run.error) throw new Error(run.error);
    if (!run || !run.count || !run.tiles || run.tiles.length !== run.count) throw new Error("The page capture returned no picture");
    var tiles = [];
    for (var i = 0; i < run.count; i++) {
      var got = await send({ type: "CAPTURE_PAGE_TILE", generation: generation, runId: run.runId, index: i });
      if (!got.ok) throw new Error("The extension is not available. Reload the page and try again.");
      if (!got.value || got.value.error) throw new Error((got.value && got.value.error) || "The page capture returned no picture");
      if (typeof got.value.dataUrl !== "string") throw new Error("The page capture returned no picture");
      tiles.push({ dataUrl: got.value.dataUrl, src: run.tiles[i].src, destY: run.tiles[i].destY });
    }
    return { metrics: run.metrics, partial: run.partial, tiles: tiles };
  }

  root.PiPageCaptureClient = { request: request };
})(globalThis);
