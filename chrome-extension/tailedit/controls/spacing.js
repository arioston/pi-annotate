/**
 * Pi Annotate — Tailedit spacing control (Phase C2, plan 409)
 *
 * Padding / margin / gap widget for the Controls pane. Per the design
 * (docs/tailscan-integration-design.md §Phase C) and plan 409:
 *   - one mutation per value swap, via ctx.applyFamily (classList.replace);
 *   - unprefixed classes only — variant-scoped editing stays on the typed
 *     input (Phase E carries the variant-target model);
 *   - default-theme scale only, kept in exactly one const, replaced by Phase E.
 *
 * Loaded raw (no bundler) BEFORE editor.js, AFTER tw-default-classes.js.
 * Registers onto the single window.__piTailedit namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});
  ns.controls = ns.controls || {};

  // Default-theme spacing scale (subset). One const; Phase E replaces this
  // with the project's own resolved theme.
  const SCALE = [
    "0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6",
    "8", "10", "12", "16", "20", "24",
  ];

  const ROWS = [
    { label: "Padding", prefix: "p" },
    { label: "Padding X", prefix: "px" },
    { label: "Padding Y", prefix: "py" },
    { label: "Padding T", prefix: "pt" },
    { label: "Padding R", prefix: "pr" },
    { label: "Padding B", prefix: "pb" },
    { label: "Padding L", prefix: "pl" },
    { label: "Margin", prefix: "m" },
    { label: "Margin X", prefix: "mx" },
    { label: "Margin Y", prefix: "my" },
    { label: "Margin T", prefix: "mt" },
    { label: "Margin R", prefix: "mr" },
    { label: "Margin B", prefix: "mb" },
    { label: "Margin L", prefix: "ml" },
    { label: "Gap", prefix: "gap" },
  ];

  function escapeToken(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Each row's regex is anchored at BOTH ends against the full scale
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

  ns.controls.spacing = {
    title: "Spacing",
    create(ctx) {
      const doc = ctx.doc;
      const root = doc.createElement("div");
      root.className = "te-ctl-body";

      const rows = ROWS.map((def) => {
        const rx = familyRegex(def.prefix);
        const row = doc.createElement("div");
        row.className = "te-ctl-row";
        const label = doc.createElement("label");
        label.textContent = def.label;
        const select = doc.createElement("select");
        select.className = "te-ctl-select";
        const clearOpt = doc.createElement("option");
        clearOpt.value = "";
        clearOpt.textContent = "—";
        select.appendChild(clearOpt);
        for (const value of SCALE) {
          const opt = doc.createElement("option");
          opt.value = value;
          opt.textContent = value;
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          const value = select.value;
          ctx.applyFamily(rx, value ? def.prefix + "-" + value : null);
        });
        row.appendChild(label);
        row.appendChild(select);
        root.appendChild(row);
        return { def, rx, select };
      });

      function sync() {
        for (const { def, rx, select } of rows) {
          const current = ctx.readFamily(rx);
          select.value = current ? current.slice(def.prefix.length + 1) : "";
        }
      }

      return { root, sync };
    },
  };
})();
