# Full-page capture

Pi Annotate can capture a page that is longer than the screen. The service
worker scrolls the page, takes a picture of each step, and keeps the pictures.
A result tab joins the pictures into one image. The result tab can download the
image as PNG or JPG, copy it, or export it as a PDF. Code:
`chrome-extension/capture/` and `chrome-extension/lib/capture-plan.js`,
`chrome-extension/lib/pdf-writer.js`.

## How to use

Click **Capture full page** in the popup, or set a key for the command
"Capture the full page" in `chrome://extensions/shortcuts`. The command has no
default key. The page scrolls to the end and goes back to its position. The
result tab opens next to the page.

Press Escape during a capture to stop it. Nothing is stored in that case.

## Method

1. Find the scroll target: the document when it is taller than the viewport.
   Otherwise the largest visible element that scrolls on the vertical axis
   (for example a chat pane). For an inner scroller, the output is the content
   of that element without the frame around it.
2. Prepare the page: hide the scrollbars, set `scroll-behavior: auto`, and
   record the scroll position.
3. For each step: scroll the target, wait for two animation frames and 150 ms,
   take a picture of the viewport, and keep the rectangle of the picture that
   holds new rows. The planner works from the scroll position that the page
   reports, so a page that clamps a scroll, or a list that grows, is handled.
4. After the first picture, hide each `position: fixed` and `position: sticky`
   element, so that a header or a floating button appears one time.
5. Restore the page: styles, hidden elements, and the scroll position.
6. The result page joins the pictures in a canvas.

## Contract

1. The page is restored on each exit path: success, abort, error, tab switch,
   and navigation away.
2. At least 550 ms pass between two tab captures (Chrome allows 2 each second).
3. Before and after each picture, the captured tab is the active tab of its
   window. If it is not, the capture stops and stores nothing.
4. No new permission. No network request. No message to the native host.
5. The planners and the PDF writer have no browser API; Node tests run them.
6. The result page works only from the stored capture.
7. The annotation session and its `CAPTURE_SCREENSHOT` path do not change.

## Decisions

- **No history.** A capture is stored so that the result tab can read it. A
  capture older than 24 hours is deleted when a capture starts and when the
  service worker starts. No page lists captures.
- **Limits.** At most 60 pictures and 60000 CSS px of height. After that the
  capture stops, and the result page says the image is partial.
- **Canvas limit.** A canvas side is at most 16384 px. A taller page gives
  more than one image, each with a part number in the file name.
- **PDF.** A4 and Letter (the image fills the page width and is split at the
  page height) and One page (one page as tall as the image, up to 14400
  points; above that, split). No live links and no text-aware split.
- **No capture during an annotation session.** The capture refuses and says
  so.
- **Copy.** Copy puts one PNG on the clipboard. With more than one image, it
  copies the first.
- **No editor.** For crop and draw, use an annotation session.

## Session screenshots (plan 1170)

The annotation session uses the same engine, through the message
`CAPTURE_PAGE`. The background runs the capture loop under the router guard
(the session generation, and the active tab before and after each picture). It
opens no tab and writes nothing to disk. The content script joins the pictures
with the join planner, then crops and badges with content coordinates.

One runtime message must stay below 64 MiB, and 60 tiles can be about 120 MB
(plan 1173). So `CAPTURE_PAGE` does not return the pictures. It returns the run
id, the tile count, the metrics, and the tile records (`src`, `destY`). The
background keeps the pictures in memory (`lib/tile-store.js`). The content
script then reads them with `CAPTURE_PAGE_TILE` (run id and index), one picture
for each message (`lib/page-capture-client.js`). The background refuses an
unknown run id, a bad index, an old generation, and a request from another tab.
It frees the pictures of a run:

- after the last tile (index = count - 1) is read;
- on a tab change: the tab is closed or navigates, or another tab becomes
  active in its window;
- at the end of the session (`PANEL_SESSION_END`, `CANCEL`,
  `ANNOTATIONS_COMPLETE`);
- after 120 seconds with no read.

If the service worker restarts during a run, the memory is gone. The tile
request fails, and rule 5 (fallback) applies. There is no disk storage.

Rules:

1. **Crop.** When each selected element with a screenshot is fully inside the
   viewport, the one-picture path runs as before, and the page does not
   scroll. Otherwise a page capture runs, and each element is cropped whole
   from the page image.
2. **Full.** Always a page capture. The button title is "Capture the entire
   page".
3. **Limits.** The capture stops at the limits above. The result then has
   `screenshotPartial` ("tiles", "height", or "canvas"), and the agent output
   says that the screenshot is partial.
4. **Size.** Before the send, an image above 12 MB as PNG is encoded again as
   JPEG (quality 0.85). If it is still above 12 MB, it is scaled down by steps
   of 0.75. The result has `screenshotReduced`, and the agent output says so.
   The 12 MB rule is below the host limit of 15 MB on purpose. Change both
   together. A reduced image is also in the Copy images (plan 1172): the
   PREPARED message accepts PNG or JPEG data URLs (and refuses WebP and every
   other type), and the panel page converts a JPEG to PNG with a canvas,
   because the clipboard takes only `image/png`. The Copy button is disabled
   until the conversion ends. If the conversion fails, the button stays
   disabled and the status shows an error.
5. **Fallback.** A failed page capture in a final submit falls back to the
   viewport picture. The result has `screenshotPartial: "viewport"`. Text and
   selections are never lost because of a screenshot.

A capture from the popup or the command is still refused during a session. The
mode None and the edit capture screenshots do not change.

Session smoke checklist:

1. Mode Crop, one element inside the viewport: the output is the same as
   before, and the page does not scroll.
2. Mode Crop, one element taller than the viewport and one below the fold: each
   screenshot shows the whole element.
3. Mode Full on a long page: the screenshot shows the whole page with the
   numbered badges at the right elements.
4. Mode Full on a very long page: the agent output says "partial", and no
   "Screenshot capture failed" line appears.
5. After each submit the page is at its earlier scroll position, and the
   Pi Annotate UI is gone as today.
6. Prepare output (the Copy path) gives the same screenshots as Submit.

## Limits

- Pages that load content only while they scroll can give a short image.
- Cross-origin iframes are captured as painted.
- Restricted pages (`chrome://`, the Web Store) cannot be captured.
- Deferred: live links in the PDF, a text-aware page split, the frame around an
  inner scroller, horizontal scrolling, and a default key.

## Operator smoke checklist

1. Reload the extension. On a long article, click "Capture full page". The
   page scrolls to the end and returns to the position it had. The result tab
   shows one image of the whole page. A sticky header appears one time, at the
   top.
2. Download PNG, Download JPG, and Copy each work. The pasted image is the same
   picture.
3. Download PDF with A4, Letter, and One page. Each file opens in a PDF reader,
   and the pages in order show the whole image.
4. On a chat application whose document does not scroll, the capture holds the
   conversation pane from the first loaded message to the last.
5. Press Escape during a capture. The page is restored (scroll position,
   scrollbars, fixed elements) and no result tab opens.
6. Switch to another tab during a capture. The capture stops, and the first
   tab is restored when you return.
7. Start a capture during an annotation session. The capture refuses, and the
   session is not changed.
8. Reopen a result tab URL after 24 hours. It shows "This capture is no longer
   stored."
