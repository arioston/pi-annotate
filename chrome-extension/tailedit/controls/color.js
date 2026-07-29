/**
 * Pi Annotate — Tailedit color control (Phase C2, plan 409; Phase E, plan 421)
 *
 * text / bg / border swatch grid for the Controls pane, built from the
 * bundled default palette (ns.data.colors) the typed-input autocomplete
 * already uses (tw-default-classes.js), OR from the page's own live
 * `--color-*` theme values when available. Per plan 409 Step 4:
 *   - target selector chooses which prefix (`text-`, `bg-`, `border-`) a
 *     swatch click writes;
 *   - the family regex for a target is restricted to KNOWN colour tokens
 *     (the active palette's keys, plus the standalone `transparent` keyword)
 *     so it can never mistake a non-colour utility (`text-lg`, `border-2`)
 *     for the current colour — the same membership discipline as
 *     controls/typography.js;
 *   - swatch `style.background` writes are shadow-root-only (allowed); no
 *     `.style` write ever targets the pinned page element.
 *
 * Phase E (plan 421): `ctx.theme.family("color")` supplies the live palette
 * when the page's `--color-blue-500` canonical anchor resolves; otherwise
 * this falls back to `ctx.data.colors` exactly as before — this file is the
 * design's own model for "ask the resolver, don't call getComputedStyle
 * yourself." Live values may be `oklch()`/`lab()` strings; they are set on
 * `style.background` as-is and left for the browser to parse, same as any
 * other colour value here.
 *
 * Loaded raw (no bundler) BEFORE editor.js, AFTER tw-default-classes.js.
 * Registers onto the single window.__piTailedit namespace; no other globals.
 */
(() => {
  "use strict";
  const ns = (window.__piTailedit = window.__piTailedit || {});
  ns.controls = ns.controls || {};

  const TARGETS = ["text", "bg", "border"];

  function escapeToken(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Group the flat colors map (family-shade -> hex, plus standalone
  // "black"/"white") into ordered family rows, each with its shades in
  // ascending order. "transparent" is not a real palette entry (no hex) —
  // added as its own one-swatch row.
  function buildFamilies(colors) {
    const order = [];
    const byFamily = {};
    for (const key of Object.keys(colors)) {
      const cut = key.lastIndexOf("-");
      const family = cut === -1 ? key : key.slice(0, cut);
      const shade = cut === -1 ? "" : key.slice(cut + 1);
      if (!byFamily[family]) {
        byFamily[family] = [];
        order.push(family);
      }
      byFamily[family].push({ shade, token: key, hex: colors[key] });
    }
    order.push("transparent");
    byFamily.transparent = [{ shade: "", token: "transparent", hex: null }];
    return order.map((family) => ({ family, shades: byFamily[family] }));
  }

  ns.controls.color = {
    title: "Color",
    create(ctx) {
      const doc = ctx.doc;
      const theme = ctx.theme;
      // Live palette when the page's own `--color-*` theme resolves,
      // falling back to the bundled default otherwise (plan 421 per-family
      // gating — resolved once here, ctx.theme itself is cached per mount).
      const colorFamily = theme ? theme.family("color") : null;
      const colors =
        (colorFamily && colorFamily.live && colorFamily.values) || (ctx.data && ctx.data.colors) || {};
      const families = buildFamilies(colors);
      // Membership-only token list: every string a swatch can ever apply.
      const COLOR_TOKENS = families.reduce((acc, f) => acc.concat(f.shades.map((s) => s.token)), []);

      const root = doc.createElement("div");
      root.className = "te-ctl-body";

      const seg = doc.createElement("div");
      seg.className = "te-ctl-seg";
      let target = "bg";
      const segButtons = TARGETS.map((t) => {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.textContent = t;
        btn.classList.toggle("active", t === target);
        btn.addEventListener("click", () => {
          target = t;
          segButtons.forEach((b, i) => b.classList.toggle("active", TARGETS[i] === target));
          sync();
        });
        seg.appendChild(btn);
        return btn;
      });
      root.appendChild(seg);

      const grid = doc.createElement("div");
      root.appendChild(grid);

      // Regex restricted to known colour tokens only — never matches a
      // non-colour utility sharing the same prefix (e.g. "text-lg", "border-2").
      function targetRegex(t) {
        const alt = COLOR_TOKENS.map(escapeToken).join("|");
        return new RegExp("^" + escapeToken(t) + "-(?:" + alt + ")$");
      }

      const swatchButtons = []; // { token, btn }

      const clearBtn = doc.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "te-sw clear";
      clearBtn.title = "clear";
      clearBtn.textContent = "—";
      clearBtn.addEventListener("click", () => {
        ctx.applyFamily(targetRegex(target), null);
      });
      grid.appendChild(clearBtn);
      swatchButtons.push({ token: null, btn: clearBtn });

      for (const { family, shades } of families) {
        const famLabel = doc.createElement("div");
        famLabel.className = "te-ctl-fam";
        famLabel.textContent = family;
        grid.appendChild(famLabel);
        const row = doc.createElement("div");
        row.className = "te-ctl-swatches";
        for (const { token, hex } of shades) {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "te-sw";
          btn.title = token;
          if (hex) btn.style.background = hex; // shadow-root node — allowed
          btn.addEventListener("click", () => {
            ctx.applyFamily(targetRegex(target), target + "-" + token);
          });
          row.appendChild(btn);
          swatchButtons.push({ token, btn });
        }
        grid.appendChild(row);
      }

      function sync() {
        const current = ctx.readFamily(targetRegex(target));
        const currentToken = current ? current.slice(target.length + 1) : null;
        // Re-validate by membership before highlighting — the regex already
        // guarantees this, but data.colors is the single source of truth for
        // "is this actually a colour token".
        const known = currentToken && COLOR_TOKENS.includes(currentToken) ? currentToken : null;
        for (const { token, btn } of swatchButtons) {
          btn.classList.toggle("active", token === known);
        }
      }

      return { root, sync };
    },
  };
})();
