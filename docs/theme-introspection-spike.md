# Theme introspection spike — findings

Written against fork commit `dbde6a3` (plan 417, "Phase D2 — view settings and
copy element"), on the `spike/theme-introspection` branch, plan 418.

Date: 2026-07-28.

Status: **incomplete** — sections 3–7 are awaiting operator-run probe output.
Nothing in this document was written from assumed or recalled Tailwind
behavior; every number in sections 3–7 must trace to a pasted console report.

## 1. Question

`plans/notes/tailscan-parity-map.md` §5 used to scope Phase E as "bring your
own Tailwind config." `docs/tailscan-integration-design.md` already closed
that door: **D3** fixes the target scope at arbitrary `<all_urls>` pages with
no source-config ingestion (a local-dev-only mode with file access was
considered and rejected), and **D5** fixes the class-data source as
host-CSSOM-first plus a bundled open static default theme plus an
arbitrary-value parser — v3 `resolveConfig()` enumeration was considered and
explicitly deferred, with the design doc stating pi-annotate stays
"version-tolerant via CSSOM introspection rather than committing to
programmatic v3-vs-v4 config recovery (v4 removed `resolveConfig()`)." Both
decisions are logged as resolved, not deferred, in the design doc's §9
decision log and coverage-check table.

Given that, "bring your own config" is not a live option to re-litigate here.
The only way TailEdit could ever show a page's *real* theme values (rather
than the bundled v3 defaults) is if the browser can observe them without
config access — i.e., runtime introspection, which D5 already endorses as a
direction but has not verified for the v4 case specifically.

The concrete, testable claim: Tailwind v4 moved `@theme` values into CSS
custom properties on `:root` (`--color-blue-500`, `--spacing`, `--text-lg`,
`--font-weight-bold`, etc.), readable via
`getComputedStyle(document.documentElement)`. If true, a v4 page's actual
palette and spacing scale are readable with zero config access, and Phase E
has a concrete "GO" path. If false or only partially true, Phase E either
stays static-only or needs a different mechanism, and that has to be decided
with evidence instead of assumption.

This spike does not decide Phase E's implementation, and does not reopen D3
or D5 — it produces the evidence a future plan would need to do either.

## 2. Method

**Probe**: `docs/probes/theme-probe.js` — a standalone, dependency-free IIFE,
not wired into the extension or manifest. Verified to parse with
`node --check docs/probes/theme-probe.js` (this only proves it parses; it
needs a DOM and cannot run under Node). It takes no arguments and only
`console.log`s a structured report; it does not mutate the page. It reports:

1. Detected mode (v4 / v3-or-unknown-tailwind / unknown) and the evidence:
   v4 evidence is any `:root` custom property matching one of Tailwind v4's
   known prefixes (`--color-`, `--spacing`, `--text-`, `--font-`,
   `--font-weight-`, `--radius-`, `--shadow-`, `--breakpoint-`, `--leading-`,
   `--tracking-`); v3-or-unknown-tailwind evidence is >= 3 distinct
   utility-shaped class tokens found in stylesheet selectors (a curated
   prefix set — `p-`, `bg-`, `flex`, `rounded-`, etc. — not a bare "any class
   exists" check, precisely because that would false-positive on almost any
   site; see the caveat in the probe's own comments and in §4 below).
2. `:root` custom properties, grouped by the same prefixes, with count and up
   to 5 samples per group, iterated off `getComputedStyle`'s own numeric
   indices as specified in the plan.
3. Stylesheet census: total sheets, how many threw on `.cssRules` access
   (cross-origin), total rule count walked, and whether any single sheet's
   rule count exceeded `MAX_SHEET_RULES = 4000` (mirroring
   `chrome-extension/tailedit/suggest.js`'s own budget constant — the probe
   does not import that file, it duplicates the constant for independence).
4. A utility-value sample for `p-4`, `text-lg`, `bg-blue-500`: whether a
   matching CSSOM rule was found and, if so, its declarations.
5. A class-token census: count of distinct Tailwind-looking class tokens
   extracted from all reachable selectors.

**Pages** (operator's choice of exact URL per row — target categories per the
plan):

| Target | Why | URL used |
|---|---|---|
| Tailwind v4 site | core question | <!-- AWAITING OPERATOR: exact URL --> |
| Tailwind v3 site | fallback path | <!-- AWAITING OPERATOR: exact URL --> |
| Non-Tailwind site | false-positive check on mode detection | <!-- AWAITING OPERATOR: exact URL --> |
| Heavy site (many stylesheets) | does the 4000-rule cap trip in the wild? | <!-- AWAITING OPERATOR: exact URL --> |

**Who ran it**: <!-- AWAITING OPERATOR: name/role of whoever pasted the probe -->

**How**: paste the full contents of `docs/probes/theme-probe.js` into the
DevTools console on each target page, capture the logged report (the script
prints both a live object and a `JSON.stringify(report, null, 2)` string for
easy copy-paste), and return the raw output for each page.

## 3. Raw results

<!-- AWAITING OPERATOR OUTPUT -->

Per-page verbatim console output goes here once the operator returns it. Do
not paraphrase numbers — paste the raw JSON (or object dump) per page,
labeled with the URL actually used.

### Page: Tailwind v4 site

<!-- AWAITING OPERATOR OUTPUT -->

### Page: Tailwind v3 site

<!-- AWAITING OPERATOR OUTPUT -->

### Page: Non-Tailwind site

<!-- AWAITING OPERATOR OUTPUT -->

### Page: Heavy site

<!-- AWAITING OPERATOR OUTPUT -->

## 4. Answers to the five questions

<!-- AWAITING OPERATOR OUTPUT -->

1. **Does a real Tailwind v4 page expose its theme as readable `:root`
   custom properties? Which families, under exactly which names?**
   <!-- AWAITING OPERATOR OUTPUT -->

2. **Is what is exposed complete enough to drive a widget (a whole spacing
   scale, a whole palette), or only partial?**
   <!-- AWAITING OPERATOR OUTPUT -->

3. **What does a v3 page give us instead, via the CSSOM scan `suggest.js`
   already runs?**
   <!-- AWAITING OPERATOR OUTPUT -->

4. **Can the two be told apart reliably at runtime — i.e. can the editor
   know which mode it is in, rather than guessing?**
   <!-- AWAITING OPERATOR OUTPUT — in particular, evaluate the probe's
   twLikeTokenCount-based v3 heuristic against the non-Tailwind page's
   result: does it false-positive? -->

5. **What would it cost to route the five duplicated const sites through
   one introspected layer?**
   <!-- AWAITING OPERATOR OUTPUT — answered qualitatively in §6 below, but
   depends on whether §4.1/§4.2 come back GO or NO-GO. -->

## 5. Recommendation

<!-- AWAITING OPERATOR OUTPUT -->

Exactly one of: **GO-full** / **GO-partial** / **NO-GO**, with the shape of
that path sketched once real data is in hand. Cannot be written before
sections 3–4 are filled in — a recommendation without observed data would be
exactly the "invented result" this spike exists to avoid.

## 6. Cost estimate for the const consolidation

<!-- AWAITING OPERATOR OUTPUT -->

The five duplicated const sites are (unchanged in this spike, confirmed
present at `dbde6a3`):

| File | Constants |
|---|---|
| `chrome-extension/tailedit/suggest.js` | `SPACING_SCALE`, `SIZING_KEYWORDS`, `TEXT_SIZES`, `FONT_WEIGHTS`, `RADII` |
| `chrome-extension/tailedit/tw-default-classes.js` | `colors` (244 entries), `colorPrefixes`, `utilities`, `variantPrefixes` |
| `chrome-extension/tailedit/controls/typography.js` | `SIZE_TOKENS`, `WEIGHT_TOKENS`, `ALIGN_TOKENS`, `LEADING_TOKENS`, `TRACKING_TOKENS` |
| `chrome-extension/tailedit/tw-spacing.js` | `SCALE`, `SIDES` |
| `chrome-extension/tailedit/editor.js` | `BREAKPOINTS`, `VARIANTS`, plus 408's explainer tables |

The actual cost estimate depends on the GO/NO-GO call in §5 and is deferred
until that call is evidence-backed.

## 7. What this spike did NOT establish

- Whether the `:root` custom-property surface is stable across different v4
  build configurations (Vite plugin vs CLI vs PostCSS, `@theme` vs
  `@theme inline`, purge/minification behavior) — only whatever the operator's
  chosen pages happen to run.
- Cross-origin stylesheet behavior beyond what the four target pages exercise
  — a page could mix same-origin v4 theme CSS with cross-origin vendor CSS in
  ways not covered here.
- Performance cost of the `getComputedStyle(document.documentElement)` full
  property walk at scale (the probe measures the CSSOM walk's rule-count
  ceiling per the existing `MAX_SHEET_RULES` budget, but does not benchmark
  wall-clock time for either scan).
- Whether D3 or D5 should be revisited. If the raw results in §3 raise that
  question, the argument is recorded above in the relevant answer, not acted
  on — reopening either decision is explicitly out of scope for this plan.
- Any implementation of Phase E. This document is findings only.
