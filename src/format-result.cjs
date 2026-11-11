"use strict";
// Result formatter (plan 1055). Plain CommonJS with node: modules only, so both
// src/core.ts and the native host (chrome-extension/native/host.cjs) can load it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB
// Why a screenshot is partial (result.screenshotPartial, plan 1170).
const PARTIAL_REASONS = {
  tiles: "the page needed more than 60 pictures",
  height: "the page is longer than 60000 CSS px",
  canvas: "the page is taller than one image can be",
  viewport: "the page capture failed, so this is the visible part only",
};

// One line each for a partial or reduced screenshot (plan 1170).
function screenshotNotes(result) {
  let notes = "";
  if (result.screenshotPartial) {
    notes += `*Screenshot is partial: ${PARTIAL_REASONS[result.screenshotPartial] || "the capture stopped early"}*\n`;
  }
  if (result.screenshotReduced) notes += "*Screenshot was reduced to fit the size limit*\n";
  return notes;
}

// A reduced screenshot (plan 1170) can be a JPEG. The file name follows the data.
function imageExtension(dataUrl) {
  return /^data:image\/jpe?g[;,]/.test(dataUrl) ? "jpg" : "png";
}

function formatEditCapture(capture) {
  let output = "";

  if (capture.warnings?.length) {
    for (const w of capture.warnings) {
      output += `> **Note:** ${w}\n`;
    }
    output += "\n";
  }

  // Inline style changes
  if (capture.inlineStyles.length > 0) {
    output += `### Inline Style Changes\n\n`;
    for (const change of capture.inlineStyles) {
      output += `**\`${change.selector}\`**\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // Stylesheet rule changes
  if (capture.rules.length > 0) {
    output += `### CSS Rule Changes\n\n`;
    for (const change of capture.rules) {
      output += `**\`${change.ruleSelector}\`** (${change.sheet})\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // DOM changes
  if (capture.dom.length > 0) {
    output += `### DOM Changes\n\n`;
    for (const change of capture.dom) {
      output += `- **\`${change.selector}\`** — ${change.detail}\n`;
    }
    output += "\n";
  }

  return output;
}

async function formatResult(result) {
  if (!result.success) {
    if (result.cancelled) {
      if (result.reason?.includes("Another terminal") || result.reason?.includes("Another client")) {
        return `Annotation session ended: ${result.reason}`;
      }
      if (result.reason && result.reason !== "user") {
        return `Annotation cancelled: ${result.reason}`;
      }
      return "Annotation cancelled by user.";
    }
    return `Annotation failed: ${result.reason || "Unknown error"}`;
  }

  let output = `## Page Annotation: ${result.url || "Unknown"}\n`;
  if (result.viewport) {
    output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
  }

  // Show overall context if provided (uses existing 'prompt' field for backwards compat)
  if (result.prompt) {
    output += `**Context:** ${result.prompt}\n\n`;
  }

  // Check if any element has debug data (to show header)
  const hasDebugData = result.elements?.some(el => el.computedStyles || el.parentContext || el.cssVariables);
  if (hasDebugData) {
    output += `**Debug Mode:** Enabled\n\n`;
  }

  if (result.elements && result.elements.length > 0) {
    output += `### Selected Elements (${result.elements.length})\n\n`;
    result.elements.forEach((el, i) => {
      output += `${i + 1}. **${el.tag}**\n`;
      output += `   - Selector: \`${el.selector}\`\n`;
      if (el.id) output += `   - ID: \`${el.id}\`\n`;
      if (el.classes?.length) output += `   - Classes: \`${el.classes.join(", ")}\`\n`;
      if (el.text) {
        output += `   - Text: "${el.text}"\n`;
      }

      // Box model (v0.3.0) - compact format
      if (el.boxModel) {
        const bm = el.boxModel;
        const padStr = `${bm.padding.top} ${bm.padding.right} ${bm.padding.bottom} ${bm.padding.left}`;
        const borderStr = bm.border.top || bm.border.right || bm.border.bottom || bm.border.left
          ? `${bm.border.top} ${bm.border.right} ${bm.border.bottom} ${bm.border.left}` : "0";
        const marginStr = `${bm.margin.top} ${bm.margin.right} ${bm.margin.bottom} ${bm.margin.left}`;
        output += `   - **Box Model:** ${el.rect.width}×${el.rect.height} (content: ${bm.content.width}×${bm.content.height}, padding: ${padStr}, border: ${borderStr}, margin: ${marginStr})\n`;
      } else {
        output += `   - Size: ${el.rect.width}×${el.rect.height}px\n`;
      }

      // Attributes (v0.3.0) - fix: was captured but never output
      if (el.attributes && Object.keys(el.attributes).length > 0) {
        const attrStr = Object.entries(el.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ");
        output += `   - **Attributes:** ${attrStr}\n`;
      }

      // Accessibility (v0.3.0) - compact format, omit undefined booleans
      if (el.accessibility) {
        const a11y = el.accessibility;
        const parts = [];
        if (a11y.role) parts.push(`role=${a11y.role}`);
        if (a11y.name) parts.push(`name="${a11y.name}"`);
        parts.push(`focusable=${a11y.focusable}`);
        parts.push(`disabled=${a11y.disabled}`);
        if (a11y.expanded !== undefined) parts.push(`expanded=${a11y.expanded}`);
        if (a11y.pressed !== undefined) parts.push(`pressed=${a11y.pressed}`);
        if (a11y.checked !== undefined) parts.push(`checked=${a11y.checked}`);
        if (a11y.selected !== undefined) parts.push(`selected=${a11y.selected}`);
        if (a11y.description) parts.push(`description="${a11y.description}"`);
        output += `   - **Accessibility:** ${parts.join(", ")}\n`;
      }

      // Key styles - compact format (suppressed when full computedStyles is present)
      const hasComputedStyles = el.computedStyles && Object.keys(el.computedStyles).length > 0;
      if (!hasComputedStyles && el.keyStyles && Object.keys(el.keyStyles).length > 0) {
        const styleStr = Object.entries(el.keyStyles).map(([k, v]) => `${k}: ${v}`).join(", ");
        output += `   - **Styles:** ${styleStr}\n`;
      }

      // Comment
      if (el.comment) {
        output += `   - **Comment:** ${el.comment}\n`;
      }

      // Debug mode data (v0.3.0) - verbose format
      if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
        output += `   - **Computed Styles:**\n`;
        for (const [key, value] of Object.entries(el.computedStyles)) {
          output += `     - ${key}: ${value}\n`;
        }
      }

      if (el.parentContext) {
        const pc = el.parentContext;
        const pcLabel = pc.id ? `${pc.tag}#${pc.id}` : `${pc.tag}${pc.classes[0] ? "." + pc.classes[0] : ""}`;
        const pcStyles = Object.entries(pc.styles).map(([k, v]) => `${k}: ${v}`).join(", ");
        output += `   - **Parent Context:** ${pcLabel} (${pcStyles})\n`;
      }

      if (el.cssVariables && Object.keys(el.cssVariables).length > 0) {
        output += `   - **CSS Variables:**\n`;
        for (const [name, value] of Object.entries(el.cssVariables)) {
          output += `     - ${name}: ${value}\n`;
        }
      }

      output += `\n`;
    });
  } else {
    output += "*No elements selected*\n\n";
  }

  // Handle screenshots
  const timestamp = Date.now();

  if (result.screenshot) {
    // Full page screenshot
    try {
      if (!result.screenshot.startsWith("data:image/")) throw new Error("Invalid screenshot data");
      const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-full.${imageExtension(result.screenshot)}`);
      const base64Data = result.screenshot.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
      await fs.promises.writeFile(screenshotPath, buffer);
      output += `**Screenshot (full page):** ${screenshotPath}\n`;
    } catch (err) {
      output += `*Screenshot capture failed: ${err}*\n`;
    }
    output += screenshotNotes(result);
  }

  if (result.screenshots && result.screenshots.length > 0) {
    // Individual element screenshots
    output += `### Screenshots\n\n`;
    for (let i = 0; i < result.screenshots.length; i++) {
      const shot = result.screenshots[i];
      try {
        if (!shot?.dataUrl?.startsWith("data:image/")) throw new Error("Invalid screenshot data");
        const safeIndex = Number.isFinite(shot.index) ? Math.max(1, Math.floor(shot.index)) : i + 1;
        const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-el${safeIndex}.${imageExtension(shot.dataUrl)}`);
        const base64Data = shot.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
        await fs.promises.writeFile(screenshotPath, buffer);
        output += `- Element ${safeIndex}: ${screenshotPath}\n`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `- Element ${shot?.index ?? i + 1}: *capture failed (${message})*\n`;
      }
    }
    if (!result.screenshot) output += screenshotNotes(result);
    output += "\n";
  } else if (!result.screenshot) {
    const notes = screenshotNotes(result);
    if (notes) output += notes + "\n";
  }

  if (result.elements?.some((element) => element.attachments?.length)) {
    output += "### Reference images\n\n";
    for (let elementIndex = 0; elementIndex < result.elements.length; elementIndex++) {
      const attachments = result.elements[elementIndex].attachments || [];
      for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex++) {
        const attachment = attachments[attachmentIndex];
        try {
          if (!attachment.dataUrl?.startsWith("data:image/")) throw new Error("Invalid attachment data");
          const extension = attachment.mimeType === "image/jpeg" ? "jpg" : attachment.mimeType.split("/")[1];
          const attachmentPath = path.join(
            os.tmpdir(),
            `pi-annotate-${timestamp}-el${elementIndex + 1}-ref${attachmentIndex + 1}.${extension}`,
          );
          const buffer = Buffer.from(attachment.dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Attachment too large");
          await fs.promises.writeFile(attachmentPath, buffer);
          output += `- Element ${elementIndex + 1} — ${attachment.name}: ${attachmentPath}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- Element ${elementIndex + 1} — ${attachment.name}: *capture failed (${message})*\n`;
        }
      }
    }
    output += "\n";
  }

  if (result.editCapture && result.editCapture.changeCount > 0) {
    const ec = result.editCapture;
    output += `## Edit Capture (${ec.changeCount} changes, ${Math.round(ec.duration / 1000)}s)\n\n`;
    output += formatEditCapture(ec);

    // Before/after screenshots
    if (ec.beforeScreenshot || ec.afterScreenshot) {
      output += `### Before/After Screenshots\n\n`;
      if (ec.beforeScreenshot) {
        try {
          const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-before.png`);
          const buf = Buffer.from(ec.beforeScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
          await fs.promises.writeFile(p, buf);
          output += `- Before: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- Before: *capture failed (${message})*\n`;
        }
      }
      if (ec.afterScreenshot) {
        try {
          const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-after.png`);
          const buf = Buffer.from(ec.afterScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
          await fs.promises.writeFile(p, buf);
          output += `- After: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- After: *capture failed (${message})*\n`;
        }
      }
      output += "\n";
    }
  }

  return output;
}

/** Format with tool-oriented messages for abort/timeout (matches original Pi tool wording). */
async function formatToolResult(result, options = {}) {
  if (!result.success && result.cancelled) {
    if (result.reason === "aborted") {
      return "Annotation was aborted.";
    }
    if (result.timeout || result.reason === "timeout") {
      const seconds = options.timeoutSeconds ?? 300;
      return `Annotation timed out after ${seconds}s`;
    }
  }
  return formatResult(result);
}

module.exports = { formatResult, formatToolResult, formatEditCapture };
