<p>
  <img src="banner.png" alt="Pi Annotate" width="1100">
</p>

# Pi Annotate

**Visual annotation for AI. Click elements, capture screenshots, fix code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Browser](https://img.shields.io/badge/Browser-Chrome%20%7C%20Chromium-blue?style=for-the-badge)]()

```
/annotate
```

Figma-like annotation experience with floating inline note cards. DevTools-like element picker in vanilla JS.

Click elements, add comments, submit. The agent gets selectors, box model, accessibility, screenshots — everything it needs to fix your UI.

Works with **Pi** (extension), and with **Junie / Claude Code / Codex** (MCP server) — same browser extension and native host.

https://github.com/user-attachments/assets/115b10ca-86e8-4b1c-b8a4-492c68759c58

## Quick Start

### 1. Install agent integration

**Pi:**
```bash
pi install npm:pi-annotate
```

**Junie / Claude Code / Codex (MCP):** install the package and point your MCP config at `pi-annotate-mcp` (see [MCP setup](#use-with-junie--claude-code--codex-mcp) below). Browser steps 2–3 are the same.
```bash
npm install -g pi-annotate
```

Restart pi to load the extension.

### 2. Load Supported Browser Extension

1. Open the extensions page in Google Chrome, Google Chrome for Testing, or Chromium, and enable **Developer mode**
2. Click **Load unpacked** → select the `chrome-extension/` folder inside the installed package
3. Click the **Pi Annotate icon** in the toolbar

### 3. Install Native Host

The popup shows your extension ID. Click **Copy** next to the install command, then run it from `chrome-extension/native/` in the installed package:

```bash
./install.sh <extension-id>
```

This installs the native messaging manifest for Google Chrome, Google Chrome for Testing, and Chromium on macOS, plus the default/current config-home locations for those browsers on Linux. Fully quit and reopen that browser. The popup will show **Connected** when ready.

If the browser and agent run in different sandboxes or temp namespaces, pass an explicit shared registry directory:

```bash
./install.sh <extension-id> --registry-dir /absolute/path/to/shared-registry
```

`PI_ANNOTATE_REGISTRY_DIR` is the authoritative runtime-directory override, and the native host and agent must use the same absolute path when they do not share a temp namespace. The registry directory itself uses `0700` permissions; the socket, token, and metadata files use `0600`. Older hosts using `/tmp/pi-annotate.sock` and `/tmp/pi-annotate.token` remain supported as a legacy fallback. Reinstall the host and fully quit/reopen the browser after changing the registry path. A relative, empty, or otherwise invalid `PI_ANNOTATE_REGISTRY_DIR` (or `XDG_RUNTIME_DIR`) fails immediately with a configuration error instead of silently falling back to a temp directory the other side may not share.

If you use Pi Annotate in more than one browser or profile, give each one a unique **Browser profile name** in its extension popup (for example, `Work Chrome` and `Personal Chromium`). Each profile publishes an independent connection.


## Use with Junie / Claude Code / Codex (MCP)

The browser extension and native host are shared. For agents other than Pi, run the **MCP server** which exposes the same `annotate` tool over stdio.

### Install package (for MCP binary)

```bash
npm install -g pi-annotate
# or use npx without global install
```

Browser setup is unchanged: load `chrome-extension/`, run `./install.sh <extension-id>`, click the extension icon once.

### MCP config

**Junie** — `~/.junie/mcp/mcp.json` or project `.junie/mcp/mcp.json`:

```json
{
  "mcpServers": {
    "pi-annotate": {
      "command": "pi-annotate-mcp"
    }
  }
}
```

**Claude Code** — project `.mcp.json` or `claude mcp add`:

```bash
claude mcp add pi-annotate -- pi-annotate-mcp
```

```json
{
  "mcpServers": {
    "pi-annotate": {
      "command": "pi-annotate-mcp"
    }
  }
}
```

**Codex** — `~/.codex/config.toml` (or project config):

```toml
[mcp_servers.pi-annotate]
command = "pi-annotate-mcp"
```

To pin a client instance to one profile, set `PI_ANNOTATE_BROWSER` to its popup name or connection id. This is useful when several Codex/Claude/Junie instances run at once:

```toml
[mcp_servers.pi-annotate-work]
command = "pi-annotate-mcp"
env = { PI_ANNOTATE_BROWSER = "Work Chrome" }
```

From a local checkout without global install:

```json
{
  "mcpServers": {
    "pi-annotate": {
      "command": "node",
      "args": ["/absolute/path/to/pi-annotate/bin/pi-annotate-mcp.js"]
    }
  }
}
```

### MCP tool

| Tool | Args | Returns |
|------|------|---------|
| `list_browsers` | none | Connected browser/profile names and ids |
| `annotate` | `browser?`, `url?`, `timeout?` (seconds, default 300) | Markdown annotations + paths to any screenshots under the temp dir |
| `create_issue_report` | `browser?`, `url?`, `title?`, `timeout?`, `captureNetwork?` | A stable local `PIA-…` reference and report paths |
| `list_issue_reports` | `limit?` | Recently saved local reports |
| `get_issue_report` | `ref` | Markdown and structured data for a saved report |

The call blocks until you submit or cancel in the browser (or the timeout fires). With one connected profile, selection is automatic. With several, pass `browser`, call `list_browsers` first, or set `PI_ANNOTATE_BROWSER`. Multiple agent clients can remain connected to the same profile; if two start annotation there simultaneously, the newer session replaces only the older request. Different profiles can annotate independently.


## Usage

```bash
/annotate                  # Current browser tab
/annotate https://x.com    # Opens URL first
/issue                     # Annotate and save a local issue report
/issue https://x.com       # Open a URL, annotate it, and save the report
```

| Action | How |
|--------|-----|
| Select element | Click on page |
| Cycle ancestors | Alt/⌥+scroll while hovering |
| Multi-select | Toggle "Multi" or Shift+click |
| Add comment | Type in note card textarea |
| Toggle screenshot | 📷 button in note card header |
| Reposition note | Drag by header |
| Scroll to element | Click selector in note card |
| Toggle note | Click numbered badge |
| Expand/collapse all | ▼/▲ buttons in toolbar |
| Toggle edit capture | "Etch" toggle in toolbar |
| Toggle annotation UI | `⌘/Ctrl+Shift+P` |
| Close | `ESC` |

## Features

**Context Capture** — Each element automatically gets box model breakdown (padding, border, margin), accessibility info (role, name, focusable, ARIA states), all HTML attributes, and key CSS styles (display, position, overflow, colors, typography). Enable **Debug mode** for computed styles (40+ properties), parent context, and CSS variables.

**Inline Note Cards** — Draggable floating cards with per-element comments, SVG connectors linking notes to elements, click-to-scroll, and per-element screenshot toggles.

**Screenshots** — Individual crops per element (20px padding) or full-page mode with numbered badges drawn on the screenshot to identify elements. Toggle per element with the 📷 button.

**Edit Capture** — Toggle "Etch" in the toolbar to record DevTools edits. Change inline styles, modify CSS rules, add/remove classes, edit text — everything is tracked via MutationObserver. A pulsing red dot and badge counter show recording status. At submit, the extension takes before/after screenshots by briefly undoing visual changes, and produces structured property-level diffs the agent can map to source code. Works alongside element selection or standalone.

**Local Issue Reports** — Use `/issue` in Pi or the MCP `create_issue_report` tool to persist the annotated areas, comments, screenshots, page context, and sanitized network metadata. Reports receive stable references such as `PIA-20260731-120000-A1B2C3D4`; nothing is uploaded and no external ticket is created.

Each note card also has a **📎 Reference** action. Attach PNG, JPEG, or WebP design references directly to the selected element; thumbnails stay with the note, and saved reports render the captured UI beside the reference image. Images are normalized locally, stripped of metadata, resized to 2048px maximum, and limited to 3 per element / 8 per report.

### Local issue report storage

Reports are stored under:

```text
~/.local/share/pi-annotate/issues/<PIA-reference>/
├── report.md
├── report.json
└── assets/
    ├── element-1.png
    └── full-page.png
```

Set `PI_ANNOTATE_DATA_DIR` on the Pi or MCP process to choose another local data directory. Each report folder contains portable relative links, so it can be attached to or referenced from Jira, GitHub, Linear, or another ticket system later.

Network capture is active only for the annotated tab and only for the lifetime of an issue annotation session. It records at most 200 request URLs, methods, resource types, status/error state, cache state, and timings. Sensitive query parameters are redacted. Request/response headers, authorization data, cookies, and bodies are never collected.

**Restricted Tabs** — If the current tab is `chrome://` or other restricted URLs, providing a URL opens a new tab automatically. Popup button and keyboard shortcut auto-inject the content script on fresh tabs.

## Output

```markdown
## Page Annotation: https://example.com
**Viewport:** 1440×900

**Context:** Fix the styling issues

### Selected Elements (2)

1. **button**
   - Selector: `#submit-btn`
   - ID: `submit-btn`
   - Classes: `btn, btn-primary`
   - Text: "Submit"
   - **Box Model:** 120×40 (content: 96×24, padding: 8 16, border: 1, margin: 0 8)
   - **Attributes:** type="submit", data-testid="submit"
   - **Styles:** display: flex, backgroundColor: rgb(59, 130, 246)
   - **Accessibility:** role=button, name="Submit", focusable=true, disabled=false
   - **Comment:** Make this blue with rounded corners

2. **div**
   - Selector: `.error-message`
   - Classes: `error-message, hidden`
   - Text: "Please fill required fields"
   - **Box Model:** 300×20 (content: 300×20, padding: 0, border: 0, margin: 0 0 8)
   - **Accessibility:** focusable=false, disabled=false
   - **Comment:** This should appear in red, not hidden

### Screenshots

- Element 1: /var/folders/.../pi-annotate-...-el1.png
- Element 2: /var/folders/.../pi-annotate-...-el2.png

## Edit Capture (2 changes, 35s)

### Inline Style Changes

**`#submit-btn`**
- `background-color`: `rgb(59, 130, 246)` → `rgb(37, 99, 235)`
- `border-radius`: added `8px`

### CSS Rule Changes

**`.btn-primary:hover`** (styles.css)
- `background-color`: `rgb(37, 99, 235)` → `rgb(29, 78, 216)`

### Before/After Screenshots

- Before: /var/folders/.../pi-annotate-...-before.png
- After: /var/folders/.../pi-annotate-...-after.png
```

Debug mode adds computed styles, parent context, and CSS variables per element. Edit capture appears when the Etch toggle is enabled and changes are detected.

## Architecture

```
Pi adapter / MCP clients
          ↕
Browser registry (/tmp/pi-annotate-<uid>/*.json)
          ↕ one authenticated socket per selected profile
Native Host A ── Chrome work profile
Native Host B ── Chromium personal profile
```

| Piece | Role |
|-------|------|
| `src/core.ts` | Socket client, auth, `annotate()`, markdown `formatResult` |
| `src/issue-reports.ts` | Private local report persistence, assets, listing, and lookup |
| `index.ts` | Pi extension: `/annotate` command + `annotate` tool |
| `src/mcp-server.ts` / `pi-annotate-mcp` | MCP stdio server for Junie, Claude Code, Codex, etc. |
| `chrome-extension/*` | Picker UI, Etch, screenshots (agent-agnostic) |
| `native/host.cjs` | Bridge socket ↔ native messaging |

| File | Purpose |
|------|---------|
| `index.ts` | Pi extension — `/annotate` command + tool |
| `types.ts` | TypeScript interfaces |
| `chrome-extension/content.js` | Element picker UI (vanilla JS) |
| `chrome-extension/background.js` | Native messaging, screenshots, tab routing |
| `chrome-extension/native/host.cjs` | Socket ↔ native messaging bridge |
| `chrome-extension/popup.html` | Connection status + setup |

Each native host publishes its metadata, socket, token, and log under `/tmp/pi-annotate-<uid>/`. The directory uses 0700 permissions; endpoint files use 0600. Older hosts using `/tmp/pi-annotate.sock` and `/tmp/pi-annotate.token` remain supported as a single-browser fallback.

When browser and agent sandboxes do not share temp namespaces, set the same `PI_ANNOTATE_REGISTRY_DIR` for both sides, or install the native host with `--registry-dir`. If the browser sandbox cannot reach the host socket directly, run `pi-annotate-mcp` on the host side instead and point it at the same shared registry.

## Development

No build step. Edit `content.js` or `background.js` directly, reload at `chrome://extensions`. Pi extension (TypeScript) loads via jiti — restart pi after changes.

```bash
tail -f /tmp/pi-annotate-$(id -u)/*.log              # Native host logs
# chrome://extensions → Pi Annotate → service worker  # Background logs
# DevTools on target page                              # Content script logs
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| UI doesn't appear | Refresh page, check service worker console |
| "restricted URL" error | Provide a URL: `/annotate https://example.com` |
| Native host not connecting | Click extension icon → check status, re-run install, fully restart the supported browser |
| "Extension ID mismatch" | Copy install command from popup, re-run |
| Socket/profile errors | `ls -la /tmp/pi-annotate-$(id -u)/`, compare `PI_ANNOTATE_REGISTRY_DIR` on host and agent, and call MCP `list_browsers` |

**Verify native host:**
- macOS Google Chrome: `cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.pi.annotate.json`
- macOS Google Chrome for Testing: `cat ~/Library/Application\ Support/Google/ChromeForTesting/NativeMessagingHosts/com.pi.annotate.json`
- macOS Chromium: `cat ~/Library/Application\ Support/Chromium/NativeMessagingHosts/com.pi.annotate.json`
- Linux Google Chrome (default path): `cat ~/.config/google-chrome/NativeMessagingHosts/com.pi.annotate.json`
- Linux Google Chrome for Testing (default path): `cat ~/.config/google-chrome-for-testing/NativeMessagingHosts/com.pi.annotate.json`
- Linux Chromium (default path): `cat ~/.config/chromium/NativeMessagingHosts/com.pi.annotate.json`
- Linux with custom config home: `echo "${CHROME_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"`

If your Linux browser uses a different XDG config root, export `CHROME_CONFIG_HOME` or `XDG_CONFIG_HOME` before running `./install.sh <extension-id>`. Custom `--user-data-dir` layouts are not handled by this installer.

## License

MIT

## Shared Surf workspace profile

Keep Surf and Pi Annotate, with both extensions and native hosts. Register each
Surf profile with `surf-target add <label> --profile <selector>`. In each
profile, open the Pi Annotate popup and enter the same label in **Profile
label** (for example `work`). On its next connect, the native host announces
that profile to the device rendezvous registry (Dalinar plan 971). Run
`surf-target claim list`. Approve each pending announcer once with
`surf-target claim approve work --capability annotate --instance <id>`.
Set `processEnv.BROWSER_PROFILE` to `work` in the workspace entry. Start a new
client session and run `surf-target doctor --announce`. Use
`surf-target run --workspace -- surf tab.list` for Surf commands. Plain Surf
keeps its existing default.

The annotation `browser` argument wins over a nonempty `PI_ANNOTATE_BROWSER`.
Next, `BROWSER_PROFILE=work` selects `surf:work`. Without these values, existing
browser discovery stays active. Pi and local MCP clients use the same resolver.
Remove old overrides only by operator choice.

A `surf:<label>` selector resolves at connect time through `claims.json` and
the live announce records. The claim for the label must name exactly one live
announcer: a valid record with that label, a live host pid, and a browser ID
that the native-host registry publishes exactly once. If no claim exists, if
the announcer is not running, if two live profiles use the label, or if a
different browser ID now uses the label, the request is refused with a
named repair. It never selects a different profile. Names, account email,
partial matches, and legacy endpoints are never fallbacks.

Records live in `DALINAR_BROWSER_ANNOUNCE_DIR`, else
`$XDG_RUNTIME_DIR/dalinar/browser-announce`, else
`~/.cache/dalinar/browser-announce`. `claims.json` sits beside `targets.tsv`
in `SURF_TARGETS_CONFIG_DIR` or `~/.config/surf-targets`. Its format is
`{"version":1,"claims":{"work":{"annotate":"example-browser-id"}}}`. Do not
sync either file. An extension storage reset gives the profile a new browser
ID. Re-approve it with `surf-target claim approve work --capability annotate
--instance <new-id> --replace`. An absent label announces the profile
unlabeled; it is listed but never resolved. Setup does not write claims or
workspace settings.

Installs without `claims.json` keep reading the legacy
`annotate-bindings.json` until the operator runs `surf-target claim import`.
After `claims.json` exists, it is the only source; the bindings file is not
read again.

Install the updated Pi Annotate fork first, then the updated Dalinar setup.
Set workspace `BROWSER_PROFILE` only after both updates. Older forks lack strict
discovery; the shared annotation doctor rejects them and asks for an update.
