<!-- case: one element with a comment -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

**Context:** General context

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger



<!-- case: element screenshots -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

### Screenshots

- Element 1: <TMP>/pi-annotate-1700000000000-el1.png
- Element 2: *capture failed (Invalid screenshot data)*



<!-- case: full screenshot -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

**Screenshot (full page):** <TMP>/pi-annotate-1700000000000-full.png


<!-- case: screenshot partial -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

**Screenshot (full page):** <TMP>/pi-annotate-1700000000000-full.png
*Screenshot is partial: the page is longer than 60000 CSS px*


<!-- case: screenshot reduced -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

### Screenshots

- Element 1: <TMP>/pi-annotate-1700000000000-el1.png
*Screenshot was reduced to fit the size limit*



<!-- case: screenshot partial and reduced without a picture -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

*Screenshot is partial: the page capture failed, so this is the visible part only*
*Screenshot was reduced to fit the size limit*



<!-- case: attachment -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

### Reference images

- Element 1 — ref.webp: <TMP>/pi-annotate-1700000000000-el1-ref1.webp



<!-- case: etch capture -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

## Edit Capture (3 changes, 4s)

> **Note:** 1 cross-origin stylesheet(s) could not be tracked

### Inline Style Changes

**`#hero`**
- `color`: `red` → `blue`
- `margin`: added `0`
- `padding`: removed

### CSS Rule Changes

**`.a`** (inline)
- `color`: added `green`

### DOM Changes

- **`#hero`** — DOM structure modified (children added/removed)

### Before/After Screenshots

- Before: <TMP>/pi-annotate-1700000000000-before.png
- After: <TMP>/pi-annotate-1700000000000-after.png



<!-- case: debug data -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

**Debug Mode:** Enabled

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Comment:** Make it bigger
   - **Computed Styles:**
     - color: red
   - **Parent Context:** main.x (display: flex)
   - **CSS Variables:**
     - --a: 1



<!-- case: no elements -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

*No elements selected*



<!-- case: non-ascii comment -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** ação ✓ 日本



<!-- case: cancel by user -->
Annotation cancelled by user.

<!-- case: cancel with reason -->
Annotation session ended: Another client took over

<!-- case: cancel other reason -->
Annotation cancelled: navigation_timeout

<!-- case: failure -->
Annotation failed: boom

<!-- case: tool abort -->
Annotation was aborted.

<!-- case: tool timeout -->
Annotation timed out after 12s

<!-- case: tool timeout default -->
Annotation timed out after 300s

<!-- case: tool passthrough -->
## Page Annotation: https://example.test/page
**Viewport:** 1280×720

### Selected Elements (1)

1. **section**
   - Selector: `#hero`
   - ID: `hero`
   - Classes: `a, b`
   - Text: "Hello world"
   - **Box Model:** 300×200 (content: 280×180, padding: 10px 10px 10px 10px, border: 0px 0px 0px 0px, margin: 0px 0px 0px 0px)
   - **Attributes:** role="banner"
   - **Accessibility:** role=banner, name="Top", focusable=false, disabled=false, expanded=true
   - **Styles:** display: block, color: red
   - **Comment:** Make it bigger

