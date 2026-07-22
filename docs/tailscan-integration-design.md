# Tailscan-style Editor Integration Design (pi-annotate)

> **Independent design.** This document specifies how pi-annotate builds its
> *own* Tailwind-class visual editor. It consumes the behavior catalog in
> `docs/tailscan-teardown.md` (plan 281). No Tailscan source, dataset, icon, or
> asset informs any decision here; every capability is re-derived from the
> public web platform and open-source Tailwind tooling. This is a design plan —
> the deliverable is interfaces, decisions, and a phase list, not code.

**Fork base commit this design was written against:** `a9575d2`
(`perf(etch): memoize parentRule context to fix O(n^2) freeze on nested sheets`).
Plan 283's drift check reads this value.

**pi-annotate baseline (verified at `a9575d2`, `chrome-extension/`):**
MV3, single `content.js` IIFE (3115 lines), `popup.js`, no build step, raw DOM
APIs. UI mounted in the **light DOM** under `document.body` (`#pi-panel`,
`#pi-highlight`, `#pi-tooltip`, `#pi-markers`, `#pi-notes`, `#pi-styles`);
`grep -c attachShadow content.js` → `0` (no shadow DOM today). Etch capture is a
`MutationObserver` on `document.documentElement` (subtree) driven by
`startEtchCapture` / `processEtchMutations`. Manifest permissions:
`activeTab`, `nativeMessaging`, `scripting`; `host_permissions: <all_urls>`.
Only existing keydown handler is `onKeyDown` → `Escape` (line 1625); **Space is
unused and free** for pin-to-edit.

---

## 1. Goal + non-goals

### Goal (the parity slice we are building)

A first-party, in-page **visual Tailwind class editor** that lets the user
hover-inspect any host element, pin it (Space), and add/remove/edit its utility
classes with autocomplete and live apply — where **every class change is a real
DOM mutation that pi-annotate's existing Etch `MutationObserver` already
captures**, so the visual editor becomes an *input* to pi-annotate's core value
(structured edit reports handed to the Pi agent), not a parallel silo.

Concretely in scope across phases A–D:

- Hover-inspect that lists an element's current Tailwind classes.
- Pin-to-edit on **Space**; editable class list; live apply; copy classlist.
- Autocomplete sourced from an **open** Tailwind class dataset (Section 4).
- Breakpoint readout and variant prefixes (`sm:`, `hover:`, `dark:`).
- Toggle/hide a class without deleting it; per-session undo.
- Later: categorized visual controls (spacing/typography/color) that emit
  classes; box-model guideline overlay; copy/persist within an Etch session.

### Non-goals (explicitly out)

- **AI natural-language styling** (Tailscan AI). pi-annotate's entire purpose is
  to hand annotations to *its own* coding agent (Pi); an in-panel LLM styling
  assistant is redundant. Out — see decision D8.
- **Component / template marketplace, non-tech "no-code" persona product.**
- **Chrome DevTools-panel surface** (`devtools_page`). Materially different
  extension surface than pi-annotate's in-page overlay; out unless a later plan
  explicitly adds it (D8).
- **Custom `tailwind.config.js` / `@theme` source-file ingestion** as a hard
  guarantee. pi-annotate runs on arbitrary `<all_urls>` pages and has no path to
  the project's source config; config-aware accuracy is best-effort only (D3, D6).
- **Component conversion** (computed-CSS → nearest-utility matcher). Deferred
  beyond this design's phases; noted as future work, not committed here.
- **Persistence across page reload / navigation.** Edits live only for the
  current Etch session (D7).
- **CSS-in-JS / non-Tailwind styling systems.** Editor targets Tailwind utility
  classes on `class` attributes only.

---

## 2. UI isolation decision

**Decision: Shadow DOM overlay (open mode).** A single injected host element
`<div id="pi-tailedit-root">` is appended to `document.body`, and
`hostEl.attachShadow({ mode: "open" })` creates an isolated shadow tree that
holds the entire editor surface: the edit panel, the autocomplete dropdown, the
inspect highlight, the breakpoint readout, and any swatch previews. All editor
CSS is injected as a single `<style>` **inside the shadow root**, so:

- Host-page Tailwind utilities cannot style editor internals (no inheritance
  across the shadow boundary except inherited properties, which we reset at
  `:host`).
- Editor styles cannot leak onto the host page.

This ties to plan 278's deferred "shadow-DOM UI isolation retrofit" and
subsumes it (see Maintenance notes).

### Why shadow DOM over iframe / web component

- **iframe** gives the strongest isolation but the worst ergonomics for this
  tool: hit-testing and live positioning against host elements requires
  continuous cross-document coordinate translation, and pointer events over the
  host page would have to be proxied. Rejected as first choice (D1).
- A **web component / custom element** still needs a shadow root for style
  isolation, so it reduces to "shadow DOM plus a registration ceremony"; the raw
  `attachShadow` path is simpler in a no-build IIFE. Rejected as unnecessary
  ceremony (D1).

### Inspect-highlight positioning across the shadow boundary (STOP-condition check)

Shadow DOM does **not** impede measurement — this was the explicit feasibility
gate. The highlight element renders *inside* the shadow root, but it measures and
tracks the **host** element via APIs that are unaffected by the shadow boundary:

- `document.elementFromPoint(x, y)` (and `elementsFromPoint`) return **host-page**
  elements for pointer coordinates; the shadow host is `pointer-events: none` on
  its non-interactive layers so inspection reaches through to the page. Interactive
  editor chrome (the panel) sits in its own `pointer-events: auto` layer.
- `hostElement.getBoundingClientRect()` returns viewport coordinates regardless of
  where the *measuring* code lives; the highlight box inside the shadow root is
  positioned with `position: fixed` using those same viewport coordinates. No
  cross-document transform is needed (unlike the iframe case).
- Scroll/resize tracking reuses pi-annotate's existing `handleScroll` /
  `handleResize` recompute pattern.

**Feasibility: confirmed.** Shadow DOM is viable for the inspect-highlight and
measurement needs; the STOP condition (shadow DOM infeasible for measurement)
did **not** fire. No iframe/light-DOM fallback is required.

### Migration of the existing toolbar

**Decision: leave the existing `#pi-panel` / `#pi-highlight` / `#pi-tooltip` /
`#pi-markers` / `#pi-notes` in the light DOM as-is for now; mount only the new
editor surface in the shadow root** (D2). Rationale: the existing UI lives inside
a 3115-line no-build IIFE and works today; a full migration is a large,
blast-radius-heavy refactor that this feature does not require. The new editor is
additive and self-contained behind its own shadow host. Migrating the legacy
toolbar into the same shadow root is recorded as **desirable follow-up**, not a
prerequisite — Phase A must not be gated on it. (Cleaner long-term; larger now.)

Note the `isPiElement` guard (`content.js:44`) already treats any element whose
`id` or class starts with `pi-` as pi-owned; naming the host `#pi-tailedit-root`
means Etch's own capture path automatically ignores it (Section 3).

---

## 3. Editor ↔ Etch integration contract

### The single-mutation rule (unambiguous)

The editor **never** maintains a private, shadow copy of the element's classes as
the source of truth for applying styles. To apply a class it calls, on the **real
host element**, exactly one of:

- `hostElement.classList.add(cls)` / `hostElement.classList.remove(cls)`, or
- one assignment `hostElement.className = nextClassString` per user-visible edit.

Each such call produces **exactly one** `attributes` mutation with
`attributeName === "class"` on that element. Etch's `processEtchMutations`
(`content.js:2257`) handles it by recording the element's `oldValue` **once** in
`etchClassInitials` (keyed by the target element) and incrementing
`etchChangeCount` **once** on the first class change to that element; subsequent
class edits to the same element update the live DOM but do **not** re-increment
(the original pre-edit value is the diff baseline, and the final class string is
read at capture stop). This is exactly the desired semantics: **one element
edited via the panel = one entry in Etch's class diff, no double count**, no
matter how many keystrokes produced the final class string.

Two structural facts make double-counting impossible:

1. **The shadow boundary hides editor-internal churn.** Etch observes
   `document.documentElement` with `subtree: true`, but a `MutationObserver` does
   **not** descend into shadow trees. All the editor's own DOM activity
   (typing in the input, opening the autocomplete dropdown, redrawing the
   highlight) happens *inside* `#pi-tailedit-root`'s shadow root and is therefore
   **invisible** to Etch. Only the class write on the actual host element crosses
   into Etch's view.
2. **The host element itself is `pi-`-prefixed and pre-excluded.** Even the
   shadow *host* node's own attribute mutations are skipped by
   `processEtchMutations` via `isPiElement(m.target)` (`content.js:2247` +
   `:44`). The editor writes classes to **host-page** elements, not to any
   `pi-`-prefixed node, so its intended edits are captured while its own chrome
   is not.

The editor must **not** set a private marker attribute on the target that would
itself register as a mutation-of-interest. It relies solely on the class write.
(Etch already ignores its own `data-pi-changed` bookkeeping attribute at
`content.js:2250`; the editor adds no competing marker.)

### Enable / disable interplay

**Decision: enabling the editor does NOT auto-enable Etch (D4), but the editor
surfaces Etch state and offers one-click enable.**

- Editor active + Etch active → edits captured live, as above. This is the
  primary intended mode.
- Editor active + Etch **off** → edits still apply to the page (live DOM
  mutation is inherently independent of Etch), but they are **not** recorded into
  a diff. To avoid silent data loss, the editor panel shows a persistent
  "Etch off — changes not being captured" affordance with an inline **"Start
  capture"** control that calls the existing `startEtchCapture()`. Edits made
  *before* capture starts are **not** retroactively captured (Etch's baseline is
  the DOM state at `startEtchCapture` time; there is no reliable pre-edit
  snapshot for elements already changed). This is stated as expected behavior,
  not a bug: the mitigation is the visible warning + one-click start, and the
  recommendation that users start capture before editing.

Rationale for not auto-enabling: `startEtchCapture()` clears markers, snapshots
all stylesheets, and resets counters — a side-effecting operation the user may
not want triggered merely by opening an inspector. Keeping them orthogonal
preserves the existing Etch toggle semantics and avoids surprising resets.

**Ordering guarantee:** the editor imposes no ordering requirement on Etch — it
works whether Etch is started before or after the editor is opened. The only
guarantee it makes is the single-mutation rule above.

### Dependency on the pi-side agent contract (`index.ts`)

This design requires **no change** to the pi-side `index.ts` agent tool surface.
Editor class-writes flow through the *existing* Etch capture → diff → report
pipeline unchanged; the agent receives the same structured class/style diffs it
already receives from DevTools-originated edits. Per the plan's STOP condition,
if a later phase (e.g. persistence beyond a session, D7) needs a new agent
protocol field, that is flagged as a **plan-283 dependency to raise**, not
designed here. The teardown shows no unavoidable agent-contract change for
Phases A–D.

---

## 4. Class model + autocomplete

### Open data source (no Tailscan asset)

**Decision (D5): hybrid, host-CSSOM-first with a bundled static default-theme
class list, built lazily.**

1. **Primary, zero-dependency: host-page CSSOM introspection.** The content
   script already runs on the live page; it enumerates class selectors actually
   present in `document.styleSheets` to offer "classes in use on this page" as an
   always-in-sync suggestion source. This is incomplete (won't suggest a *new*
   unused utility) but requires no dataset and adapts to the page's real
   (possibly customized) Tailwind build.
2. **Supplementary: a bundled static list of Tailwind's documented default-theme
   utility names** (derived from Tailwind's own public docs / MIT-licensed
   `tailwindcss` package theme, not from Tailscan). This gives new-class
   suggestions for the common default scale. It is a plain shipped `.json`/JS
   array in the extension bundle — no remote fetch, no build step required to
   consume it.
3. **Arbitrary values** (`w-[13px]`, `bg-[#1da1f2]`) are handled by a **small
   parser**, not a list: when the typed token matches `prefix-[…]`, the editor
   accepts it verbatim and (for color/length) previews the value directly. This
   is required regardless of data source (teardown §4 risk c).

`resolveConfig()`-based v3 enumeration and vendoring
`tailwindlabs/tailwindcss-intellisense` are **considered and deferred** (D5):
both are heavier and editor-LSP-shaped; the hybrid above ships value in Phase A
without a build step, and the richer source can be layered in later behind the
same suggestion-index interface.

### Suggestion index shape (interface, not code)

A lazily-built in-memory index, conceptually:

```
SuggestionIndex = {
  byPrefix: Map<string, ClassEntry[]>   // keyed by leading token, e.g. "bg", "text", "p"
  all: ClassEntry[]                     // flat, for fuzzy fallback
}
ClassEntry = {
  className: string        // "bg-blue-500", "p-4", "text-sm"
  source: "cssom" | "static"
  preview?: {
    kind: "color" | "length" | "computed" | "none"
    value?: string         // e.g. "#3b82f6" for a swatch, "1rem" for spacing
  }
}
```

- **Color-swatch previews:** for color-family entries the `preview.value` is the
  resolved color (from the default theme for static entries, or from
  `getComputedStyle` of a probe/element for CSSOM entries); the dropdown renders a
  swatch chip inside the shadow root. For arbitrary color values the bracket
  contents are the swatch directly.
- **Computed-CSS preview:** for non-color utilities, `preview.kind: "computed"`
  can show the declaration the class maps to (best-effort from the static map).

### Lazy build (respect plan 280 / 285 no-freeze principle)

The index is **built on first editor open, not at content-script load**, and the
build is bounded to stay off any O(n²) / full-CSSOM-walk hot path:

- The **static list is a preformed constant** — indexing it is O(n) over a small
  fixed array, done once and memoized.
- The **CSSOM pass reuses Etch's existing guardrails**: it must honor the same
  large-sheet budget concept as `exceedsEtchRuleBudget` / `ETCH_MAX_SHEET_RULES`
  (`content.js:2354`) and must **not** perform per-rule `parent.cssText` walks —
  exactly the pattern plan 285's `getParentRuleContext` memoization removed. The
  CSSOM scan collects class tokens from selector text only, skips oversized
  generated sheets, and is throttled/deferred (idle callback) so opening the
  editor never blocks the main thread on a large page. Suggestions degrade
  gracefully to the static list if the CSSOM scan is skipped for budget reasons.

---

## 5. Breakpoint + state model

**Detection:** `window.matchMedia()` evaluated against the **default Tailwind
breakpoint table** (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536 px). The
active breakpoint is the largest whose `min-width` query matches; it is displayed
as a small readout in the editor panel (inside the shadow root) and updates on a
`resize`-driven re-evaluation.

**Accuracy contract (D6):** pi-annotate promises breakpoint accuracy **only for
the default Tailwind scale**. When it cannot confirm the page uses defaults it
does **not** silently misreport a custom scale — the readout is labeled as
"default scale" and, where a mismatch is detectable, shows **"breakpoint
(unverified)"** rather than asserting a wrong value. Container-query-based
responsive state (Tailwind v4) is explicitly **not** reflected by this
viewport-only `matchMedia` model and is called out as a known limitation
(teardown §5). Recovering a custom `theme.screens` from an arbitrary third-party
page is not attempted (no source-config access; D3).

**Variant prefixes (`sm:`, `hover:`, `dark:`, …):** these are entered/edited as
**part of the class token itself** in the class editor — the editor treats
`sm:bg-blue-500` as one class string written verbatim to `classList`. The
autocomplete recognizes a leading `variant:` segment and continues suggesting the
utility portion after the colon. No special apply path is needed: a variant class
is just a class, so it is captured by Etch under the same single-mutation rule
(Section 3). Displaying *whether* a variant is currently "active" (e.g. is
`hover:` in effect right now) is a Phase-B nicety, not a correctness requirement.

---

## 6. Interaction model

| Action | Trigger | Maps to |
|---|---|---|
| Hover-inspect (show element + its classes) | mousemove | **Reuse** existing `#pi-highlight` / `#pi-tooltip` machinery, extended to list `element.classList` |
| Pin element for editing | **Space** (confirmed free — only `Escape` is bound today, `content.js:1625`) | **New** keydown branch in `onKeyDown`, active only in editor mode; must not fire while typing in the editor's own input |
| Open/focus edit panel | automatic on pin | **New** shadow-root panel |
| Add / remove / edit a class | type in class input + Enter / click chip ✕ | **New**; writes to real `classList` (Section 3) |
| Autocomplete a class | typing in class input | **New** (Section 4) |
| Live apply | inherent | **New (trivial)** — DOM mutation is live by construction |
| Toggle/hide a class without deleting | click a class chip's eye toggle | **New** (Phase B); keep the class in the editor model, strip from live `classList` while off, restore on toggle-on — each toggle is one class-attribute mutation Etch sees |
| Undo within edit session | Ctrl/Cmd+Z while panel focused | **New** (Phase B); per-element edit stack in the editor model, replays a `className` assignment (one mutation) |
| Copy classlist | copy button | **New (trivial)** — `navigator.clipboard.writeText(element.className)` |
| Cancel / close editor | **Escape** | **Reuse** existing `handleCancel` path (extended to also tear down the shadow editor) |
| Step to parent/child (element navigator) | panel buttons | **New**, later (out of committed phases; noted) |

Guardrail: because pin uses **Space** and edits use text input, the editor's
keydown handling must be **scoped** — when focus is inside the shadow-root input,
Space/Escape/Z must behave as normal text editing and not trigger pin/cancel/undo.

---

## 7. Phased build breakdown (executable slices for plan 283)

Each phase is independently shippable and testable. Phase A is a self-contained
MVP.

### Phase A — MVP: shadow-DOM editor + pin-to-edit + editable class list + autocomplete + live apply, captured by Etch

- **Scope:** inject `#pi-tailedit-root` shadow host; inspect highlight in shadow
  root measuring host `getBoundingClientRect`; Space-to-pin; class-list editor
  (add/remove, live apply via `classList`); autocomplete from host-CSSOM +
  bundled static list (lazy, budget-guarded); copy classlist. Edits captured by
  Etch under the single-mutation rule.
- **New files:** `chrome-extension/tailedit/editor.js` (shadow host + panel +
  interaction), `chrome-extension/tailedit/suggest.js` (lazy suggestion index),
  `chrome-extension/tailedit/tw-default-classes.json` (bundled open static list).
  (Wired into `content.js`; kept as separate files to bound blast radius on the
  3115-line IIFE.)
- **Risk:** shadow-boundary pointer/measurement correctness; lazy-index build
  cost on large pages (mitigated by the plan-280/285 budget rules).
- **Manual test:** on a Tailwind page, open editor, hover → highlight tracks
  element; Space pins it; type `bg-` → suggestions with color swatches appear;
  pick one → element background changes live; with Etch **on**, the Etch counter
  increments by exactly **1** for that element and the stop-capture diff shows the
  class change; opening the dropdown / typing does **not** increment the counter
  (shadow churn invisible). Copy button puts the classlist on the clipboard.

### Phase B — breakpoint readout + variant prefixes + toggle/hide + session undo

- **Scope:** `matchMedia` breakpoint readout with the D6 accuracy contract;
  variant-prefix-aware autocomplete (`sm:`, `hover:`, `dark:`); per-chip
  toggle/hide; Ctrl/Cmd+Z session undo.
- **New files:** `chrome-extension/tailedit/breakpoints.js`; extends
  `editor.js` / `suggest.js` (no new architectural file).
- **Risk:** custom-config breakpoint misreport (mitigated by "unverified"
  labeling); keydown scoping so Undo/Space don't leak while typing.
- **Manual test:** resize window → readout flips at 640/768/1024/1280/1536;
  type `hover:text-` → variant suggestions; toggle a class off → element style
  reverts and Etch sees one class mutation; Ctrl+Z restores the previous class
  string (one further mutation); toggling/undo never double-counts.

### Phase C — visual controls (spacing / typography / color) that write classes

- **Scope:** categorized widget panel (sliders/dropdowns/swatches) that emit
  Tailwind utility classes under the hood, reusing the Phase-A apply path so all
  emitted classes are captured identically by Etch.
- **New files:** `chrome-extension/tailedit/controls/spacing.js`,
  `controls/typography.js`, `controls/color.js` (each a widget that outputs a
  class token through the shared apply function).
- **Risk:** mapping widget values to the correct default-scale utility without a
  custom config; keeping widget-emitted edits on the single-mutation path.
- **Manual test:** drag the padding slider → element padding changes live via a
  `p-*` class; Etch records it as a class edit (not a raw `style` edit); switching
  a color swatch emits `bg-*`/`text-*` and is captured once per change.

### Phase D — guideline/computed overlays + copy/persist within session

- **Scope:** box-model guideline overlay (`getComputedStyle` +
  `getBoundingClientRect`) rendered in the shadow root; copy element `outerHTML`;
  "persist within Etch session" = ensure all panel edits are represented in the
  Etch diff artifact for the current session (no cross-reload storage — D7).
- **New files:** `chrome-extension/tailedit/overlay.js`;
  `chrome-extension/tailedit/session.js` (session-scoped edit ledger reconciled
  against Etch state).
- **Risk:** overlay redraw cost on scroll/resize (reuse existing throttled
  `handleScroll`/`handleResize`); making sure "persist" adds no new agent-contract
  field (if it must, raise as a plan-283 dependency, do not design here).
- **Manual test:** pin an element → margin/padding guides render and track on
  scroll; copy `outerHTML` lands on clipboard; after a full edit session, the
  Etch stop-capture report contains every class change made through the panel,
  with correct before/after, and nothing survives a page reload (expected).

---

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Host-CSS bleed** (page Tailwind styling editor chrome, or vice versa) | Shadow DOM (Section 2); reset inherited properties at `:host`; all editor CSS scoped inside the shadow `<style>`. |
| **MV3 CSP on injected styles/fonts** | Reuse the existing pattern: styles injected via `<style>.textContent` (as `#pi-styles` already does at `content.js:702`), which is not a remote resource and is allowed. **No remote fonts/CSS** — use system font stack or a bundled/data-URI font only; never a remote `@font-face` fetch, which a strict host CSP could block. |
| **Performance on large pages** (freeze regression) | Honor plan 280 (`exceedsEtchRuleBudget` / `ETCH_MAX_SHEET_RULES`) and plan 285 (no per-rule `parent.cssText` walks): suggestion index is lazy, CSSOM scan is budget-capped and idle-deferred, selector-text-only, and degrades to the static list. No full-CSSOM work on any hot path. |
| **Conflicts with the host's own Tailwind runtime** (e.g. JIT CDN rewriting `class`) | The editor writes real classes and reads them back on each open; if the host runtime rewrites `class`, Etch still captures the net mutation. Document that pages with a live class-rewriting runtime may show extra mutations (host-caused, not editor-caused). |
| **Double-counting edits in Etch** | Structural: shadow boundary hides editor churn; `isPiElement` excludes the host node; one class write = one mutation (Section 3). |
| **Hotkey collision** | Space is currently unbound (only `Escape` is handled); pin uses Space with keydown scoping so it never fires while the editor input has focus. |
| **Breakpoint misreport on custom configs** | Explicit accuracy contract (D6): default scale only, "unverified" label otherwise, no silent wrong value. |
| **Shadow-root migration blast radius** | Only the new editor mounts in shadow DOM; the legacy light-DOM toolbar stays as-is (D2), so the 3115-line IIFE is not rewritten. |

---

## 9. Decision log

Terse ADR-style record; each decision names the rejected alternative. This
section also **resolves or explicitly defers every open question from teardown
§7** (mapping shown as `[281 Qn]`).

- **D1 — UI isolation = Shadow DOM (open).** Rejected: iframe (positioning/
  hit-testing cost), web component (shadow root + registration ceremony with no
  extra benefit in a no-build IIFE). Resolves **[281 Q4]** partially (mechanism
  chosen). *Feasibility confirmed in Section 2 — STOP condition did not fire.*
- **D2 — Legacy toolbar stays light-DOM; only the new editor mounts in the
  shadow root.** Rejected: full migration of `#pi-panel` et al. now (large
  blast radius on a 3115-line no-build IIFE, not required by this feature).
  Migration recorded as desirable follow-up. Resolves **[281 Q4]** (migration
  cost/scope decision).
- **D3 — Target scope = arbitrary `<all_urls>` pages, no source-config
  ingestion.** The editor does not assume access to the project's
  `tailwind.config.js` / `@theme`; config-dependent accuracy is best-effort only.
  Rejected: a "local-dev-only" mode with file access (narrows the tool and
  conflicts with the existing content-script scope). Resolves **[281 Q1]**.
- **D4 — Enabling the editor does NOT auto-enable Etch; the editor surfaces Etch
  state + one-click "Start capture", and edits made while Etch is off are not
  retroactively captured.** Rejected: auto-`startEtchCapture()` on editor open
  (surprising side effects: marker clearing, stylesheet snapshot, counter reset).
  Resolves **[281 Q2]** (integration model) — edits flow through the existing
  `MutationObserver` path unmodified; no second panel-native capture path, so no
  double-count question arises.
- **D5 — Class-data source = hybrid: host-CSSOM-first + bundled open static
  default-theme list + arbitrary-value parser; built lazily.** Rejected for now:
  vendoring `tailwindcss-intellisense` (heavy, LSP-shaped) and v3
  `resolveConfig()` enumeration (v3-only, needs config) — both deferred behind the
  same suggestion-index interface. **No Tailscan dataset used.** Resolves
  **[281 Q5]** (hybrid is the pick) and **[281 Q3]**: pi-annotate targets the
  **Tailwind default utility surface** and remains version-tolerant via CSSOM
  introspection rather than committing to programmatic v3-vs-v4 config recovery
  (v4 removed `resolveConfig()`); it does not promise custom-config parity.
- **D6 — Breakpoint accuracy contract = default scale only, `matchMedia`-based,
  labeled "unverified" when a custom scale can't be excluded; container queries
  out of scope.** Rejected: asserting a single breakpoint value unconditionally
  (silently wrong on custom configs). Resolves **[281 Q6]**.
- **D7 — Persistence = single Etch session only (tied to the existing
  diff/screenshot artifact); no cross-reload storage, no new agent-contract
  field.** Rejected: a new extension-storage/native-host persistence layer
  (unneeded for the agent-handoff value; would raise a new agent protocol
  question). If a later phase needs durable storage, raise it as a **plan-283
  dependency**, do not design it here. Resolves **[281 Q7]**.
- **D8 — AI natural-language styling and a Chrome DevTools-panel surface are
  explicitly OUT of scope.** AI styling is redundant with pi-annotate's core
  purpose (hand annotations to Pi); a `devtools_page` panel is a materially
  different extension surface. Rejected: building either now. Resolves
  **[281 Q8]**.

**Coverage check:** all eight teardown §7 open questions (Q1–Q8) are resolved
above — Q1→D3, Q2→D4, Q3→D5, Q4→D1+D2, Q5→D5, Q6→D6, Q7→D7, Q8→D8. None are left
merely deferred without a decision; where scope is cut (custom-config accuracy,
persistence, AI/devtools), the cut is the decision.

---

## Maintenance notes

- This design is the **input contract for plan 283**. Keep code out of it — only
  interfaces, decisions, and the phase list.
- **Subsumes plan 278's deferred "shadow-DOM UI isolation retrofit"** — Phase A
  delivers the shadow-DOM editor mount; 278's maintenance note can point here.
  (D2 intentionally does *not* migrate the legacy toolbar, so 278's broader
  retrofit of `#pi-panel` remains open follow-up.)
- Plan 283's drift check reads the **fork base commit `a9575d2`** recorded in the
  header, and should re-confirm Etch's `etchGroupingRulePrefix` /
  `exceedsEtchRuleBudget` guardrails still exist before building on them.
- Component conversion and the element navigator are catalogued in the teardown
  but deliberately left outside Phases A–D; add them as later phases if desired.
