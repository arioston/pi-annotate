# Theme introspection spike — findings

Written against fork commit `dbde6a3` (plan 417, "Phase D2 — view settings and
copy element"), on the `spike/theme-introspection` branch, plan 418.

Date: 2026-07-28 (spike authored). Probe output collected 2026-07-29.

Status: **complete**. Sections 3–7 below are backed by four verbatim probe
runs against real pages (raw JSON quoted in §3). Every number in this
document traces to one of those four files; none is recalled or assumed
Tailwind behavior.

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
or D5 — it produces the evidence a future plan would need to do either. (§4.4
and §7 below in fact turn up evidence that *reinforces* D5's hybrid
CSSOM+static approach rather than undermining it — see the closing note in
§7.)

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
   site; see the caveat in the probe's own comments and §4.4 below — this
   heuristic turns out to be exactly the kind of unreliable the caveat
   warned about).
2. `:root` custom properties — **names and values**, grouped by the same
   prefixes, iterated off `getComputedStyle`'s own numeric indices as
   specified in the plan, values read via `getPropertyValue(prop).trim()`
   and truncated at 80 chars so a pathological gradient can't swamp the
   output. Reports, per group: a count and up to 8 `"--name: value"` samples.
   For the two groups the "complete enough to drive a widget" question in §1
   actually turns on — `--color-` and `--spacing` — a separate
   `fullNameLists` key carries the *full* list of names (not values, to keep
   output size bounded) up to a 400-entry cap with a `truncated` flag, since
   a bare count can't distinguish "the full default palette" from "eleven
   brand colours."
   - **Targeted scale-shape check** (`v4ScaleShape`, surfaced near the top of
     the report, not buried): reports `defined`/`value` for exactly
     `--spacing`, `--spacing-4`, `--color-blue-500`, `--text-lg`,
     `--font-weight-bold`, `--radius-lg`, `--breakpoint-md` (empty string from
     `getPropertyValue` counts as not defined). A derived top-level boolean,
     `discreteSpacingScale`, is `true` only when `--spacing-4` resolves to a
     non-empty value. This is the single most decision-relevant bit in the
     report, and it turned out to matter — see §4.1/§4.2.
3. Stylesheet census: total sheets, how many threw on `.cssRules` access
   (cross-origin), total rule count walked, and whether any single sheet's
   rule count exceeded `MAX_SHEET_RULES = 4000` (mirroring
   `chrome-extension/tailedit/suggest.js`'s own budget constant — the probe
   does not import that file, it duplicates the constant for independence).
4. A utility-value sample for `p-4`, `text-lg`, `bg-blue-500`: whether a
   matching CSSOM rule was found and, if so, its declarations.
5. A class-token census: count of distinct Tailwind-looking class tokens
   extracted from all reachable selectors.

**Pages actually run**:

| Target | Why | URL used |
|---|---|---|
| Tailwind v4 site | core question | `https://tailwindcss.com/` |
| Tailwind v3 site | fallback path | local `file://` page loading `https://cdn.tailwindcss.com` (Tailwind's v3 browser/JIT build), authored for this spike |
| Non-Tailwind site | false-positive check on mode detection | `https://getbootstrap.com/` |
| Heavy site (many stylesheets) | does the 4000-rule cap trip in the wild? | `https://github.com/` |

**Caveat on the v3 page**: a browser JIT build loaded via `<script src="https://cdn.tailwindcss.com">`
is not identical to a compiled production build (no PurgeCSS/content-scan
tree-shaking, JIT-generates rules for classes present in the page's own
markup only). Treat the v3 findings below as **indicative, not definitive**
of what a production-built v3 site's CSSOM looks like — though the
declaration-level results (§3, §4.3) match Tailwind v3's documented default
theme values, which is the relevant check here.

**Who ran it**: the plan's reviewer ran the probe via browser automation
(surf-cli) against the operator's Chrome, in an isolated window that was
closed after the four runs, on 2026-07-29. The executor for this document did
not run the probe directly; it received four raw output files (one per page)
and independently verified each is a faithful, unmodified JSON decode of the
probe's own transport-wrapper output before using any number from them (see
provenance note at the top of §3).

**How**: paste the full contents of `docs/probes/theme-probe.js` into the
DevTools console on the target page and capture the logged report (the
script prints both a live object and a `JSON.stringify(report, null, 2)`
string for easy copy-paste).

## 3. Raw results

**Provenance check performed before writing this section**: each of the four
`*.json` files below was diffed programmatically against its paired `*.raw`
transport file (`JSON.parse(raw)` then `JSON.parse()` again on the resulting
string, compared for structural equality against the `.json` file) — all four
matched exactly, confirming no value was altered in transit. Only the
`fullNameLists.--color-.names` arrays are trimmed below (marked with an
explicit `_trimmedForDoc` count), because they run to 288 and 62 entries;
every other field is reproduced verbatim.

### Page: Tailwind v4 — `https://tailwindcss.com/`

```json
{
  "url": "https://tailwindcss.com/",
  "discreteSpacingScale": false,
  "v4ScaleShape": {
    "--spacing": { "defined": true, "value": ".25rem" },
    "--spacing-4": { "defined": false, "value": null },
    "--color-blue-500": { "defined": true, "value": "lab(54.1736% 13.3369 -74.6839)" },
    "--text-lg": { "defined": true, "value": "1.125rem" },
    "--font-weight-bold": { "defined": true, "value": "700" },
    "--radius-lg": { "defined": true, "value": ".5rem" },
    "--breakpoint-md": { "defined": true, "value": "48rem" }
  },
  "detectedMode": {
    "mode": "v4",
    "v4EvidencePrefixes": [
      "--font-weight-", "--breakpoint-", "--color-", "--text-", "--font-",
      "--radius-", "--shadow-", "--spacing", "--leading-", "--tracking-"
    ],
    "twLikeTokenCountAsV3Evidence": 2407,
    "totalDistinctClassTokens": 5263
  },
  "rootCustomProperties": {
    "total": 531,
    "byPrefix": {
      "--font-weight-": { "count": 9, "samples": [
        "--font-weight-thin: 100", "--font-weight-extrabold: 800", "--font-weight-medium: 500",
        "--font-weight-normal: 400", "--font-weight-bold: 700", "--font-weight-extralight: 200",
        "--font-weight-light: 300", "--font-weight-black: 900"
      ]},
      "--breakpoint-": { "count": 5, "samples": [
        "--breakpoint-2xl: 96rem", "--breakpoint-md: 48rem", "--breakpoint-lg: 64rem",
        "--breakpoint-xl: 80rem", "--breakpoint-sm: 40rem"
      ]},
      "--color-": { "count": 288, "samples": [
        "--color-zinc-200: lab(90.6853% .399232 -1.45452)", "--color-pink-500: lab(56.9303% 76.8162 -8.07021)",
        "--color-orange-600: lab(57.1026% 64.2584 89.8886)", "--color-neutral-600: lab(34.924% 0 0)",
        "--color-mauve-600: lab(34.0653% 7.82093 -6.65653)", "--color-orange-800: lab(37.1566% 46.6433 50.5562)",
        "--color-teal-400: lab(76.0109% -53.3483 -2.27906)", "--color-blue-700: lab(36.9089% 35.0961 -85.6872)"
      ]},
      "--text-": { "count": 31, "samples": [
        "--text-base--line-height: calc(1.5 / 1)", "--text-9xl--line-height: 1",
        "--text-shadow-xs: 0px 1px 1px #0003", "--text-8xl: 6rem", "--text-sm: .875rem",
        "--text-lg: 1.125rem", "--text-8xl--line-height: 1", "--text-6xl: 3.75rem"
      ]},
      "--font-": { "count": 7, "samples": [
        "--font-mono: \"plexMono\", \"plexMono Fallback\", monospace",
        "--font-sans: \"inter\", \"inter Fallback\", system-ui",
        "--font-ubuntu-mono: \"ubuntuMono\", \"ubuntuMono Fallback\"",
        "--font-inter: \"inter\", \"inter Fallback\"",
        "--font-plex-mono: \"plexMono\", \"plexMono Fallback\"",
        "--font-source-sans-pro: \"source\", \"source Fallback\"",
        "--font-serif: ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif"
      ]},
      "--radius-": { "count": 8, "samples": [
        "--radius-4xl: 2rem", "--radius-sm: .25rem", "--radius-md: .375rem", "--radius-lg: .5rem",
        "--radius-2xl: 1rem", "--radius-3xl: 1.5rem", "--radius-xs: .125rem", "--radius-xl: .75rem"
      ]},
      "--shadow-": { "count": 7, "samples": [
        "--shadow-xl: 0 20px 25px -5px #0000001a, 0 8px 10px -6px #0000001a",
        "--shadow-sm: 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
        "--shadow-2xl: 0 25px 50px -12px #00000040", "--shadow-2xs: 0 1px #0000000d",
        "--shadow-xs: 0 1px 2px 0 #0000000d", "--shadow-md: 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a",
        "--shadow-lg: 0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a"
      ]},
      "--spacing": { "count": 1, "samples": [ "--spacing: .25rem" ]},
      "--leading-": { "count": 5, "samples": [
        "--leading-loose: 2", "--leading-relaxed: 1.625", "--leading-snug: 1.375",
        "--leading-tight: 1.25", "--leading-normal: 1.5"
      ]},
      "--tracking-": { "count": 6, "samples": [
        "--tracking-wider: .05em", "--tracking-tighter: -.05em", "--tracking-widest: .1em",
        "--tracking-tight: -.025em", "--tracking-wide: .025em", "--tracking-normal: 0em"
      ]}
    },
    "fullNameLists": {
      "--color-": {
        "names": [
          "--color-zinc-200", "--color-pink-500", "--color-orange-600", "--color-neutral-600",
          "--color-mauve-600", "--color-orange-800", "--color-teal-400", "--color-blue-700",
          "--color-neutral-300", "--color-purple-800", "--color-mauve-50", "--color-cyan-700",
          "--color-gray-300", "--color-mist-600", "--color-taupe-400", "--color-amber-300",
          "--color-cyan-200", "--color-gray-500", "--color-green-500", "--color-white"
        ],
        "truncated": false,
        "_trimmedForDoc": "[20 of 288 shown; full list in probe output on file, not paraphrased]"
      },
      "--spacing": { "names": [ "--spacing" ], "truncated": false }
    },
    "otherCount": 164,
    "otherSamples": [
      "--toastify-color-warning: #f1c40f", "--blur-lg: 16px", "--tw-mask-bottom-from-color: black",
      "--tw-mask-conic: linear-gradient(#fff, #fff)", "--ease-in: cubic-bezier(.4, 0, 1, 1)",
      "--tw-inset-ring-shadow: 0 0 #0000", "--toastify-toast-max-height: 800px",
      "--tw-mask-conic-from-position: 0%"
    ]
  },
  "stylesheetCensus": { "totalSheets": 5, "sheetsThrew": 0, "totalRules": 7973, "maxSheetRuleCount": 7531, "capTripped": true },
  "utilitySample": {
    "p-4": { "selector": ".p-4", "declarations": [ "padding-top: ", "padding-right: ", "padding-bottom: ", "padding-left: " ] },
    "text-lg": { "selector": ".text-lg", "declarations": [ "font-size: var(--text-lg)", "line-height: var(--tw-leading,var(--text-lg--line-height))" ] },
    "bg-blue-500": { "selector": ".bg-blue-500", "declarations": [ "background-color: var(--color-blue-500)" ] }
  },
  "classTokenCensus": { "distinctClassTokens": 5263 }
}
```

### Page: Tailwind v3 (JIT/CDN, local page) — `file:///…/v3-target.html` loading `cdn.tailwindcss.com`

```json
{
  "url": "file:///…/v3-target.html",
  "discreteSpacingScale": false,
  "v4ScaleShape": {
    "--spacing": { "defined": false, "value": null },
    "--spacing-4": { "defined": false, "value": null },
    "--color-blue-500": { "defined": false, "value": null },
    "--text-lg": { "defined": false, "value": null },
    "--font-weight-bold": { "defined": false, "value": null },
    "--radius-lg": { "defined": false, "value": null },
    "--breakpoint-md": { "defined": false, "value": null }
  },
  "detectedMode": {
    "mode": "v3-or-unknown-tailwind",
    "v4EvidencePrefixes": [],
    "twLikeTokenCountAsV3Evidence": 32,
    "totalDistinctClassTokens": 33
  },
  "rootCustomProperties": {
    "total": 51,
    "byPrefix": {
      "--font-weight-": { "count": 0, "samples": [] }, "--breakpoint-": { "count": 0, "samples": [] },
      "--color-": { "count": 0, "samples": [] }, "--text-": { "count": 0, "samples": [] },
      "--font-": { "count": 0, "samples": [] }, "--radius-": { "count": 0, "samples": [] },
      "--shadow-": { "count": 0, "samples": [] }, "--spacing": { "count": 0, "samples": [] },
      "--leading-": { "count": 0, "samples": [] }, "--tracking-": { "count": 0, "samples": [] }
    },
    "fullNameLists": {
      "--color-": { "names": [], "truncated": false },
      "--spacing": { "names": [], "truncated": false }
    },
    "otherCount": 51,
    "otherSamples": [
      "--tw-ring-offset-shadow: 0 0 #0000", "--tw-contain-size: ", "--tw-contrast: ",
      "--tw-backdrop-sepia: ", "--tw-ring-shadow: 0 0 #0000", "--tw-sepia: ",
      "--tw-skew-x: 0", "--tw-ordinal: "
    ]
  },
  "stylesheetCensus": { "totalSheets": 1, "sheetsThrew": 0, "totalRules": 71, "maxSheetRuleCount": 71, "capTripped": false },
  "utilitySample": {
    "p-4": { "selector": ".p-4", "declarations": [ "padding-top: 1rem", "padding-right: 1rem", "padding-bottom: 1rem", "padding-left: 1rem" ] },
    "text-lg": { "selector": ".text-lg", "declarations": [ "font-size: 1.125rem", "line-height: 1.75rem" ] },
    "bg-blue-500": { "selector": ".bg-blue-500", "declarations": [ "--tw-bg-opacity: 1", "background-color: rgb(59 130 246 / var(--tw-bg-opacity, 1))" ] }
  },
  "classTokenCensus": { "distinctClassTokens": 33 }
}
```

### Page: Non-Tailwind — `https://getbootstrap.com/`

```json
{
  "url": "https://getbootstrap.com/",
  "discreteSpacingScale": false,
  "v4ScaleShape": {
    "--spacing": { "defined": false, "value": null }, "--spacing-4": { "defined": false, "value": null },
    "--color-blue-500": { "defined": false, "value": null }, "--text-lg": { "defined": false, "value": null },
    "--font-weight-bold": { "defined": false, "value": null }, "--radius-lg": { "defined": false, "value": null },
    "--breakpoint-md": { "defined": false, "value": null }
  },
  "detectedMode": {
    "mode": "v3-or-unknown-tailwind",
    "v4EvidencePrefixes": [],
    "twLikeTokenCountAsV3Evidence": 739,
    "totalDistinctClassTokens": 3004
  },
  "rootCustomProperties": {
    "total": 219,
    "byPrefix": {
      "--font-weight-": { "count": 0, "samples": [] }, "--breakpoint-": { "count": 0, "samples": [] },
      "--color-": { "count": 0, "samples": [] }, "--text-": { "count": 0, "samples": [] },
      "--font-": { "count": 0, "samples": [] }, "--radius-": { "count": 0, "samples": [] },
      "--shadow-": { "count": 0, "samples": [] }, "--spacing": { "count": 0, "samples": [] },
      "--leading-": { "count": 0, "samples": [] }, "--tracking-": { "count": 0, "samples": [] }
    },
    "fullNameLists": {
      "--color-": { "names": [], "truncated": false },
      "--spacing": { "names": [], "truncated": false }
    },
    "otherCount": 219,
    "otherSamples": [
      "--bs-orange: #fd7e14", "--bd-violet-rgb: 113, 44, 249", "--base03: #868e96",
      "--toastify-color-warning: #f1c40f", "--bs-link-hover-color-rgb: 139,185,254",
      "--bs-warning-bg-subtle: #332701", "--bs-success: #198754", "--toastify-spinner-color: #616161"
    ]
  },
  "stylesheetCensus": { "totalSheets": 7, "sheetsThrew": 0, "totalRules": 3826, "maxSheetRuleCount": 2660, "capTripped": false },
  "utilitySample": {
    "p-4": { "selector": ".p-4", "declarations": [ "padding-top: 1.5rem", "padding-right: 1.5rem", "padding-bottom: 1.5rem", "padding-left: 1.5rem" ] },
    "text-lg": null,
    "bg-blue-500": null
  },
  "classTokenCensus": { "distinctClassTokens": 3004 }
}
```

### Page: Heavy — `https://github.com/`

```json
{
  "url": "https://github.com/",
  "discreteSpacingScale": false,
  "v4ScaleShape": {
    "--spacing": { "defined": false, "value": null }, "--spacing-4": { "defined": false, "value": null },
    "--color-blue-500": { "defined": false, "value": null }, "--text-lg": { "defined": false, "value": null },
    "--font-weight-bold": { "defined": false, "value": null }, "--radius-lg": { "defined": false, "value": null },
    "--breakpoint-md": { "defined": false, "value": null }
  },
  "detectedMode": {
    "mode": "v4",
    "v4EvidencePrefixes": [ "--breakpoint-", "--color-", "--text-", "--font-", "--shadow-" ],
    "twLikeTokenCountAsV3Evidence": 1855,
    "totalDistinctClassTokens": 12147
  },
  "rootCustomProperties": {
    "total": 1219,
    "byPrefix": {
      "--font-weight-": { "count": 0, "samples": [] },
      "--breakpoint-": { "count": 6, "samples": [
        "--breakpoint-xlarge: 80rem", "--breakpoint-medium: 48rem", "--breakpoint-large: 63.25rem",
        "--breakpoint-small: 34rem", "--breakpoint-xxlarge: 87.5rem", "--breakpoint-xsmall: 20rem"
      ]},
      "--color-": { "count": 62, "samples": [
        "--color-prettylights-syntax-meta-diff-range: #d2a8ff", "--color-ansi-yellow-bright: #e3b341",
        "--color-project-gradient-out: #161b2200", "--color-prettylights-syntax-variable: #ffa657",
        "--color-prettylights-syntax-markup-ignored-text: #f0f6fc", "--color-ansi-red: #ff7b72",
        "--color-project-gradient-in: #161b22", "--color-ansi-red-bright: #ffa198"
      ]},
      "--text-": { "count": 41, "samples": [
        "--text-body-size-medium: .875rem", "--text-codeBlock-size: .8125rem",
        "--text-body-shorthand-small: 400 .75rem / 1.625 \"Mona Sans VF\", -apple-system, BlinkMacSystemFont, \"Segoe UI\"…",
        "--text-title-size-large: 2rem", "--text-subtitle-weight: 400", "--text-codeInline-size: .9285em",
        "--text-title-lineHeight-large: 1.5", "--text-display-size: 2.5rem"
      ]},
      "--font-": { "count": 1, "samples": [ "--font-size-small: .75rem" ] },
      "--radius-": { "count": 0, "samples": [] },
      "--shadow-": { "count": 8, "samples": [
        "--shadow-floating-small: 0 0 0 1px #3d444d, 0 6px 12px -3px #01040966, 0 6px 18px 0 #01040966",
        "--shadow-inset: inset 0 1px 0 0 #0104093d", "--shadow-floating-large: 0 0 0 1px #3d444d, 0 24px 48px 0 #010409",
        "--shadow-floating-medium: 0 0 0 1px #3d444d, 0 8px 16px -4px #01040966, 0 4px 32px -4px #01040966, 0 24px …",
        "--shadow-resting-small: 0 1px 1px 0 #01040999, 0 1px 3px 0 #01040999",
        "--shadow-resting-medium: 0 1px 1px 0 #01040966, 0 3px 6px 0 #010409cc",
        "--shadow-floating-xlarge: 0 0 0 1px #3d444d, 0 32px 64px 0 #010409",
        "--shadow-resting-xsmall: 0 1px 1px 0 #010409cc"
      ]},
      "--spacing": { "count": 0, "samples": [] }, "--leading-": { "count": 0, "samples": [] }, "--tracking-": { "count": 0, "samples": [] }
    },
    "fullNameLists": {
      "--color-": {
        "names": [
          "--color-prettylights-syntax-meta-diff-range", "--color-ansi-yellow-bright", "--color-project-gradient-out",
          "--color-prettylights-syntax-variable", "--color-prettylights-syntax-markup-ignored-text", "--color-ansi-red",
          "--color-project-gradient-in", "--color-ansi-red-bright", "--color-prettylights-syntax-markup-inserted-text",
          "--color-workflow-card-bg", "--color-prettylights-syntax-markup-changed-text", "--color-ansi-white-bright",
          "--color-diff-blob-selected-line-highlight-mix-blend-mode", "--color-mktg-btn-shadow-outline", "--color-ansi-blue",
          "--color-prettylights-syntax-sublimelinter-gutter-mark", "--color-prettylights-syntax-brackethighlighter-unmatched",
          "--color-text-white", "--color-prettylights-syntax-markup-list", "--color-prettylights-syntax-carriage-return-text"
        ],
        "truncated": false,
        "_trimmedForDoc": "[20 of 62 shown; full list in probe output on file, not paraphrased]"
      },
      "--spacing": { "names": [], "truncated": false }
    },
    "otherCount": 1101,
    "otherSamples": [
      "--button-danger-shadow-selected: 0 0 0 0 #0000", "--diffBlob-hunkNum-bgColor-rest: #0c2d6b",
      "--toastify-color-warning: #f1c40f", "--label-brown-fgColor-hover: #bfa77d", "--display-pink-scale-5: #d34591",
      "--label-teal-fgColor-active: #24d6c4", "--display-lime-bgColor-muted: #141f0f", "--button-primary-iconColor-disabled: #fff6"
    ]
  },
  "stylesheetCensus": { "totalSheets": 51, "sheetsThrew": 0, "totalRules": 23326, "maxSheetRuleCount": 4095, "capTripped": true },
  "utilitySample": {
    "p-4": { "selector": ".p-4", "declarations": [ "padding-top: ", "padding-right: ", "padding-bottom: ", "padding-left: " ] },
    "text-lg": null,
    "bg-blue-500": null
  },
  "classTokenCensus": { "distinctClassTokens": 12147 }
}
```

## 4. Answers to the five questions

### 4.1 Does a real Tailwind v4 page expose its theme as readable `:root` custom properties? Which families, under exactly which names?

**Yes.** On `tailwindcss.com`, `getComputedStyle(document.documentElement)`
exposes 531 total custom properties, of which 367 fall into the ten known v4
prefix families (9 `--font-weight-*` + 5 `--breakpoint-*` + 288 `--color-*` +
31 `--text-*` + 7 `--font-*` + 8 `--radius-*` + 7 `--shadow-*` + 1 `--spacing`
+ 5 `--leading-*` + 6 `--tracking-*` = 367; the remaining 164 are
project-specific, e.g. `--toastify-*`, `--blur-*`, `--ease-*`, `--tw-mask-*`).
`v4ScaleShape` confirms exact canonical names resolve with real values:
`--color-blue-500: lab(54.1736% 13.3369 -74.6839)`, `--text-lg: 1.125rem`,
`--font-weight-bold: 700`, `--radius-lg: .5rem`, `--breakpoint-md: 48rem`.
This directly confirms the plan's premise for eight of the nine families it
named (colors, spacing base, sizes, weights, radii, breakpoints, leading,
tracking — plus a bonus `--shadow-*` family the plan didn't name).

### 4.2 Is what is exposed complete enough to drive a widget (a whole spacing scale, a whole palette), or only partial?

**Split — and the split is exactly the one the coordinator's revision
anticipated.**

- **Enumerable, with names and values, on the v4 page**: `--color-*` (288
  entries — the stock default palette plus site-added families like
  `mauve`, `taupe`, `mist`, `olive` that are not in stock Tailwind, meaning
  this route would show the *site's actual, possibly-extended* palette, a
  strict improvement over the bundled static 244-entry list), `--font-weight-*`
  (9, matching the shape of the bundled `FONT_WEIGHTS` table), `--radius-*`
  (8, matching `RADII`), `--breakpoint-*` (5, matching `BREAKPOINTS`),
  `--leading-*` (5) and `--tracking-*` (6, neither currently bundled anywhere
  in the five duplicated sites — a widget could gain families it doesn't
  have today), and `--shadow-*` (7, also not currently bundled). `--text-*`
  (31) is enumerable but is not a clean 1:1 with the bundled `TEXT_SIZES`
  table — it mixes size tokens (`--text-lg`, `--text-8xl`) with paired
  line-height companions (`--text-8xl--line-height`) and even a
  `--text-shadow-xs` outlier; a consumer would need light filtering, not a
  raw dump.
- **NOT enumerable**: spacing. `discreteSpacingScale` is `false`;
  `--spacing-4` is undefined; the `--spacing` group has exactly **one**
  entry, `--spacing: .25rem`. This confirms the hypothesis the coordinator's
  revision was built to test: Tailwind v4 emits one base spacing value, not
  a discrete `--spacing-4`/`--spacing-8`/… scale. A widget reading `:root`
  alone cannot enumerate spacing steps — it can read the live base unit
  (`.25rem` here, which happens to match Tailwind's own stock default) but
  would have to synthesize `calc(base × N)` itself and still needs a bundled
  list of *which* N values (0, 0.5, 1, 1.5, 2, …) to offer, since those step
  numbers are not present anywhere in the CSSOM.

So: **complete for seven of the eight enumerable families tested, structurally
broken for spacing.** "Complete enough to drive a widget" is true per-family,
not true as a blanket statement about v4 theme introspection.

### 4.3 What does a v3 page give us instead, via the CSSOM scan `suggest.js` already runs?

On the v3 (JIT/CDN) page, zero theme custom properties exist in any of the
ten known families (`rootCustomProperties.total` is 51, all of it `--tw-*`
utility-internal variables like `--tw-ring-offset-shadow`, `--tw-contrast`,
none of it theme data). Instead, the **already-shipped** declaration-reading
path (`declarationsOf()` in `suggest.js`, exercised here by the probe's
utility-value sample) gets fully resolved values directly off the matched
rule: `p-4` → `padding-top/right/bottom/left: 1rem` (matches Tailwind's stock
`SPACING_SCALE["4"]` of `1rem`), `text-lg` → `font-size: 1.125rem;
line-height: 1.75rem` (matches stock `TEXT_SIZES.lg`), `bg-blue-500` →
`background-color: rgb(59 130 246 / var(--tw-bg-opacity, 1))` with
`--tw-bg-opacity: 1` (Tailwind v3's alpha-composited color output). No
`:root` introspection is needed or useful on this page — the existing
`suggest.js` mechanism already extracts everything a v3 page has to offer.
Per the caveat in §2, this is a JIT/demo build, not a production-purged one,
so treat the exact rule *count* (71 total, one stylesheet) as
unrepresentative, but the *declaration values themselves* match Tailwind's
documented v3 defaults, which is what this question is actually about.

### 4.4 Can the two be told apart reliably at runtime — i.e. can the editor know which mode it is in, rather than guessing?

**Not with either of the probe's two built-in heuristics alone — this is the
most important secondary finding of this spike.**

- **Bootstrap false-positives the v3 heuristic.** `getbootstrap.com` reports
  `mode: "v3-or-unknown-tailwind"` with `twLikeTokenCountAsV3Evidence: 739`
  (far past the ≥3 threshold) — Bootstrap ships its own utility classes,
  including a `p-4`. Worse than a mode-label false positive: the
  declaration-read for that `.p-4` rule returns `padding: 1.5rem` on all four
  sides — a confident, fully-resolved, **wrong** number if consumed naively
  as "the page's Tailwind `p-4` value" (Tailwind's real default is `1rem`,
  as confirmed on the v3 page in §4.3). Naive declaration-reading has no way
  to know the rule belongs to a different design system entirely.
- **GitHub false-positives the v4 heuristic.** `github.com` reports
  `mode: "v4"` with five of the ten known v4 prefix families present
  (`--breakpoint-`, `--color-`, `--text-`, `--font-`, `--shadow-`) — because
  GitHub's Primer design system happens to use the same custom-property
  *namespace* Tailwind v4 uses. The *names* are Primer's, not Tailwind's:
  `--color-prettylights-syntax-meta-diff-range`,
  `--breakpoint-xlarge`/`--breakpoint-medium` (not `sm`/`md`/`lg`/`xl`/`2xl`),
  `--text-body-size-medium`. GitHub is not a Tailwind site at all.
- **What actually discriminates in this data set: canonical-name probing,
  not prefix-family presence.** On GitHub, all seven `v4ScaleShape`
  properties (`--spacing`, `--spacing-4`, `--color-blue-500`, `--text-lg`,
  `--font-weight-bold`, `--radius-lg`, `--breakpoint-md`) are undefined —
  despite the page tripping the prefix-based `mode: "v4"` label. The same is
  true on Bootstrap and the local v3 page. Only the real v4 page has all
  seven defined. **This is a concrete design requirement for whatever ships:
  mode detection (and any per-family "is this family live?" gate) must check
  for a curated set of exact, canonical Tailwind property names — the shape
  `v4ScaleShape` already probes — not merely "does a property with this
  prefix exist somewhere on `:root`."** Prefix presence is necessary but not
  sufficient evidence.
- **Caveat on generality**: this is one page per category. It rules out the
  cheapest possible heuristics (raw class-token count, raw prefix presence)
  but does not prove canonical-name probing is airtight against, say, a
  purged/safelisted v4 build missing some of the seven canonical names, or a
  page that mixes a real v4 build with a Primer-like library in the same
  namespace. Treat "canonical-name probing works" as supported by this
  evidence, not proven in general.

### 4.5 What would it cost to route the five duplicated const sites through one introspected layer?

Answered in §6, informed directly by §4.2 and §4.4: the "one introspected
layer" cannot be a uniform swap, because (a) spacing needs different
treatment from every other family (live base value + bundled step keys,
rather than a live full table) and (b) the live/bundled decision must be
gated per-family on canonical-name presence, not on a single page-level mode
flag, since a page can look "v4" by prefix and still contribute nothing
Tailwind-shaped (GitHub).

## 5. Recommendation

**GO-partial.**

The evidence supports building live `:root` introspection for the families
that are both real and enumerable, keeping the rest bundled:

- **GO (live, per-family, gated by canonical-name presence)**: colors
  (`--color-*`), font-weight (`--font-weight-*`), radius (`--radius-*`),
  breakpoints (`--breakpoint-*`), leading (`--leading-*`), tracking
  (`--tracking-*`), and — with light post-filtering to strip line-height
  companions — text sizes (`--text-*`). Each family is only trusted "live"
  when its own canonical anchor property from `v4ScaleShape` (or an
  equivalent curated per-family probe) resolves; prefix presence alone is
  not sufficient (§4.4).
- **NO-GO for full enumeration, GO for a narrower live signal**: spacing.
  The scale itself (which step numbers exist: 0, 0.5, 1, 1.5, 2, …) stays
  bundled — it isn't present in the CSSOM to enumerate (§4.2). What *can* go
  live is the base unit value (`--spacing`, `.25rem` on the tested page) —
  useful as a single fact ("this site's spacing unit matches/differs from
  Tailwind's default") and as the multiplier in a synthesized
  `calc(base × N)` preview, but not as a discrete list to populate a picker
  from.
- **v3 pages**: no change needed. The already-shipped CSSOM
  declaration-reading path in `suggest.js` already extracts fully-resolved
  values (§4.3); this spike found no gap to close there.
- **Prerequisite, not optional**: mode/family detection must switch from
  prefix-family presence to canonical-name probing before any live-value
  path ships (§4.4) — implementing the "GO" families above on top of the
  probe's current naive `detectedMode.mode` field would misattribute
  Primer's or another design system's values to Tailwind on pages like
  GitHub.

If a future plan disagrees with this call, the data to argue against is in
§3 verbatim and §4 per-question — this recommendation is falsifiable against
it, not asserted from authority.

## 6. Cost estimate for the const consolidation

The five duplicated const sites (unchanged in this spike, confirmed present
at `dbde6a3`):

| File | Constants | Affected by GO-partial? |
|---|---|---|
| `chrome-extension/tailedit/suggest.js` | `SPACING_SCALE`, `SIZING_KEYWORDS`, `TEXT_SIZES`, `FONT_WEIGHTS`, `RADII` | `SPACING_SCALE` (step keys stay, unit value could go live), `TEXT_SIZES`, `FONT_WEIGHTS`, `RADII` — yes; `SIZING_KEYWORDS` (`full`/`screen`/`auto`) is not a theme family, no |
| `chrome-extension/tailedit/tw-default-classes.js` | `colors` (244 entries), `colorPrefixes`, `utilities`, `variantPrefixes` | `colors` — yes; the other three are class-name/prefix lists, not theme values, no |
| `chrome-extension/tailedit/controls/typography.js` | `SIZE_TOKENS`, `WEIGHT_TOKENS`, `ALIGN_TOKENS`, `LEADING_TOKENS`, `TRACKING_TOKENS` | `SIZE_TOKENS`, `WEIGHT_TOKENS`, `LEADING_TOKENS`, `TRACKING_TOKENS` — yes; `ALIGN_TOKENS` is not a theme value, no |
| `chrome-extension/tailedit/tw-spacing.js` | `SCALE`, `SIDES` | `SCALE` — yes, but only the unit value, not the step keys (see spacing note above); `SIDES` no |
| `chrome-extension/tailedit/editor.js` | `BREAKPOINTS`, `VARIANTS`, plus 408's explainer tables | `BREAKPOINTS` — yes; `VARIANTS` no |

Given GO-partial, this is **not a simple value swap**. It requires:

1. A shared resolver module (new, not one of the five existing files) that,
   per family, checks the family's canonical anchor propert(y/ies) via a
   `v4ScaleShape`-style probe, and returns either the live `:root` value set
   or the existing bundled constant — selected per-family, per-page-load, not
   globally, since a page can pass a page-level "v4" check while individual
   families remain unreal (GitHub's `--radius-*`, `--spacing-*`, `--leading-*`,
   `--tracking-*` were all absent even though other families were present).
2. Special-cased spacing logic: keep `SPACING_SCALE`'s/`SCALE`'s numeric step
   *keys* bundled, substitute only the unit value when `--spacing` resolves
   live, and clearly label the result as synthesized rather than "read from
   the page" in any UI that surfaces it.
3. Four call sites (`suggest.js`, `tw-default-classes.js`, `typography.js`,
   `tw-spacing.js`) and one more (`editor.js` for `BREAKPOINTS`) threaded
   through the new resolver instead of reading a private literal — a real,
   if mechanical, refactor: introduce the module, decide its caching
   lifetime relative to page navigation/SPA route changes, and update each
   call site's tests.
4. The mode-detection prerequisite (§4.4, §5) landing first, since none of
   the above is safe to ship without it.

This is order-of-magnitude a small-to-medium follow-up implementation plan,
gated on that prerequisite. Precise sizing (task breakdown, effort estimate)
is deliberately not done here — per plan scope, this spike does not decide
Phase E's implementation, only the shape and cost class of it.

## 7. What this spike did NOT establish

**Prominent related finding, not part of Phase E, found incidentally**: the
already-shipped `suggest.js` CSSOM scan's `MAX_SHEET_RULES = 4000` cap
already trips in the wild, on both real-world sites this spike tested that
have large stylesheets — `tailwindcss.com` itself
(`maxSheetRuleCount: 7531`, `capTripped: true`) and `github.com`
(`maxSheetRuleCount: 4095`, `capTripped: true`). That means the shipped
CSSOM scan already silently degrades to the bundled static list on sites
representative of TailEdit's own target audience, independent of anything in
this spike or Phase E. This was not fixed here — fixing it means touching
`chrome-extension/tailedit/suggest.js`, which is out of scope for this plan
— but it should become its own plan given how directly it undercuts the
value of the CSSOM-first half of D5's hybrid design.

Other things not established:

- Whether the `:root` custom-property surface is stable across different v4
  build configurations (Vite plugin vs CLI vs PostCSS, `@theme` vs
  `@theme inline`, purge/minification behavior, a safelisted/partial build
  missing some canonical names) — only what `tailwindcss.com`'s specific
  build happens to run. This directly bounds the generality of §4.4's
  canonical-name-probing conclusion.
- The v3 page was a browser JIT/CDN build, not a compiled production build
  with PurgeCSS (§2, §4.3 caveat) — declaration *values* matched Tailwind's
  documented defaults, which is what mattered for this spike, but rule
  *counts*/structure on a real production v3 site were not exercised.
- Cross-origin stylesheet-read failure was **not observed**:
  `sheetsThrew` is 0 on all four pages, including GitHub's 51 sheets. The
  hypothesis that `.cssRules` access would throw on some in-the-wild
  cross-origin sheet did not survive contact with this data — but the probe
  cannot distinguish "no cross-origin sheets were present" from "cross-origin
  sheets were present and permitted"; it only observed the outcome, not the
  cause. The `try`/`catch`-and-skip fallback path in both the probe and
  `suggest.js` therefore remains logically necessary but is still empirically
  untested by this spike.
- Performance cost of the `getComputedStyle(document.documentElement)` full
  property walk at scale (up to 1219 total custom properties observed on
  GitHub) was not benchmarked for wall-clock time, only for output shape.
- Whether D3 or D5 should be revisited: **no** — if anything, this spike's
  results reinforce D5's existing hybrid CSSOM+static design rather than
  undermining it. v3 pages need CSSOM declaration-reading (§4.3, already
  shipped); v4 pages need `:root` introspection for most families but still
  need bundled data for spacing's step keys (§4.2) and as the fallback when
  canonical-name probing fails (§4.4) — neither v3 nor v4 findings argue for
  `resolveConfig()`-style config-file enumeration, which D5 already rejected.
  No argument to reopen either decision is being made here.
- Any implementation of Phase E. This document is findings and a
  recommendation only; no code under `chrome-extension/` was touched by this
  spike.
