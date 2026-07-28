/**
 * Pi Annotate — Tailedit shared spacing vocabulary (Phase D1, plan 416)
 *
 * The default-theme spacing scale, the family-regex builder, and the
 * per-side class-prefix priority table, extracted out of
 * `controls/spacing.js` so the Controls-tab spacing widget and the box-model
 * overlay (`overlay.js`) consume exactly one copy. Duplicating the scale
 * const in a second file would let the two drift apart at Phase E — see the
 * design note in plan 416 ("One source of truth for the spacing vocabulary").
 *
 * Loaded raw (no bundler) BEFORE controls/spacing.js and overlay.js, AFTER
 * tw-default-classes.js. Registers onto the single window.__piTailedit
 * namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});

  // Default-theme spacing scale (subset). One const; Phase E replaces this
  // with the project's own resolved theme.
  const SCALE = [
    "0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6",
    "8", "10", "12", "16", "20", "24",
  ];

  function escapeToken(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Each family's regex is anchored at BOTH ends against the full scale
  // alternation, so a family never swallows a sibling family's classes —
  // the collision cases called out in plan 409 all fail to match because the
  // anchored suffix requires an exact scale token, not merely a shared prefix:
  //   ^p-(?:0|px|...|24)$   matches "p-4"    but NOT "px-4"   ("px-4" has an
  //                         extra "x" before the dash — the pattern requires
  //                         "p-" immediately followed by a scale token).
  //   ^px-(?:0|px|...|24)$  matches "px-4"   but NOT "p-4"    (no "x-" segment).
  //   ^m-(?:0|px|...|24)$   matches "m-4"    but NOT "min-w-4" ("min-w-4" is
  //                         not "m-" + a scale token).
  //   ^gap-(?:0|px|...|24)$ matches "gap-4"  but NOT "gap-x-4"/"gap-y-4"
  //                         (those have an extra "x-"/"y-" segment, so the
  //                         full-string anchor never matches).
  function familyRegex(prefix) {
    const alt = SCALE.map(escapeToken).join("|");
    return new RegExp("^" + escapeToken(prefix) + "-(?:" + alt + ")$");
  }

  // For each physical side, the padding / margin class prefixes that can set
  // it, longest-specific first. `pt-2` beats `py-4` beats `p-8` for the top
  // side, mirroring Tailwind's own specificity — the overlay checks prefixes
  // in this order and takes the first class the element actually has.
  const SIDES = {
    top: { padding: ["pt", "py", "p"], margin: ["mt", "my", "m"] },
    right: { padding: ["pr", "px", "p"], margin: ["mr", "mx", "m"] },
    bottom: { padding: ["pb", "py", "p"], margin: ["mb", "my", "m"] },
    left: { padding: ["pl", "px", "p"], margin: ["ml", "mx", "m"] },
  };

  ns.spacing = {
    SCALE,
    familyRegex,
    SIDES,
  };
})();
