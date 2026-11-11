# X-ray

X-ray shows the spacing, sizes, corner radii, and 4 px grid fit of a part of
any page. It needs no annotation session and no native host. It sends no
data. Code: `chrome-extension/xray/`.

## How to use

1. Press `Alt+Shift+S`, or click **Toggle X-ray** in the popup.
2. Hold Shift and drag over the part of the page to measure.
3. Release. The frame stays. Move the pointer onto the page to see a hover
   change in the specs.
4. Press Escape to close the frame. Press `Alt+Shift+S` again to turn X-ray
   off.

A Shift+click with no drag is a normal page click.

For a `file://` page, turn on "Allow access to file URLs" in the extension
details.

## Contract

1. When X-ray is off, the X-ray scripts hold no listener, no timer, no
   animation frame callback, and no DOM node.
2. X-ray never writes to a page element. One exception: during a drag, it sets
   one inline `user-select` value on the root element, and it restores the
   earlier value on release.
3. The X-ray files call no extension API and no network API.
4. The measurement core (`measure.js`) has no access to the document or the
   window. Node can run it.
5. One scan visits at most 1500 elements. A frame that reaches the cap shows
   "partial" on its size label.
6. When no frame is open, there is no work on each frame.
7. The annotation session works as before. Escape closes an open X-ray frame
   first. Without an open frame, Escape cancels the session.

## How it works

- **Overlay.** One SVG, fixed to the viewport, with `pointer-events: none`,
  inside a shadow root. The page is not changed.
- **Frame.** Shift+drag. The frame starts after the pointer moves 4 px. The
  corners snap to a 4 px grid. The grid origin is the top-left corner of the
  measured root.
- **Root.** The innermost element under the frame centre whose box holds the
  whole frame. The fallback is `body`.
- **Scan.** The reader walks the root in document order. It skips hidden
  elements. It goes through `display: contents` and open shadow roots. It
  turns each element into a plain record.
- **Core.** `measure.js` classifies the records (block or measured) and makes
  the specs: gaps, paddings, content boxes, sizes, and radii. A spec has its
  value in CSS px, its geometry in screen px, and an off-grid flag.
- **Draw.** The page shows as a placeholder: fills, borders, blocks, and text
  bars, with the grid lines on top. Labels take the first free spot. An
  off-grid value has a different label colour.
- **Live.** While a frame is open, each animation frame reads rectangles
  again. The element walk and the style reads run when the frame changes and
  at most one time in 200 ms. A scan that takes more than 12 ms makes the next
  scans smaller.

## Limits

- A closed shadow root and a cross-origin iframe are drawn as one block.
- Over 1500 elements the result is partial.
- Pages such as `chrome://` pages and the Web Store are restricted. The
  extension cannot run there.
- The crosshair cursor on Shift is not shown. The overlay cannot change the
  page cursor without a write to a page element.

## Operator smoke checklist

1. Reload the extension. On `tests/fixtures/xray/card.html` opened as a
   `file://` page, press `Alt+Shift+S`, hold Shift, and drag over the card.
   The numbers match the comment in the fixture. The padding of 15 has the
   off-grid colour.
2. Release. The frame stays. Hover the button: a hover style change appears
   in the specs within about 200 ms. Press Escape: the frame closes.
3. With X-ray on, Shift+click a link with no drag: the browser acts on the
   click as before.
4. Turn X-ray off. In DevTools, the page has no X-ray host element, and the
   Performance panel shows no repeating frame callback from the extension.
5. Start an annotation session with X-ray on: the picker, Shift+click
   multi-select, and Escape cancel work as before when no frame is open.
6. On a large page (for example a long article), drag a frame over the whole
   viewport: the page stays responsive, and the size label shows "partial" if
   the cap was reached.
