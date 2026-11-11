# Messaging inventory (plan 1055, step 1)

Every `chrome.runtime.*`, `chrome.tabs.sendMessage` and port call in the
extension. "Guarded" means the call cannot throw or reject into the page when
the extension context is invalid (after an extension reload).

## content.js

| Site | Call | Status |
|---|---|---|
| `LOADED_KEY` line | `chrome.runtime.id` read at script start | guarded (runs only when Chrome injects the script, so the context is valid) |
| message listener | `chrome.runtime.onMessage.addListener` at script start | guarded (same reason; it is a registration, not a send) |
| `captureScreenshot()` (used by the annotation, before and after capture) | `PiSafeRuntime.sendMessageSafe({ type: "CAPTURE_SCREENSHOT" })` | guarded |
| `handleSubmit()` end | `PiSafeRuntime.sendMessageSafe({ type: "ANNOTATIONS_COMPLETE" })` | guarded |
| `handleCancel()` | `PiSafeRuntime.sendMessageSafe({ type: "CANCEL" })` | guarded |
| `publishState()` | `PiSafeRuntime.sendMessageSafe({ type: "STATE" })` | guarded |
| `announceSession()` and `deactivate()` | `PiSafeRuntime.sendMessageSafe({ type: "PANEL_SESSION" })` and `PANEL_SESSION_END` | guarded |
| `postFrameToken()` | `PiSafeRuntime.sendMessageSafe({ type: "FRAME_TOKEN_REQUEST" })` | guarded |
| `handlePrepareOutput()` | `PiSafeRuntime.sendMessageSafe({ type: "PREPARED_RESULT" })` | guarded |
| message listener, `TOGGLE_XRAY` branch (plan 1168) | no send; calls `window.__piXray.toggle()` |
| `createPanelFrame()` | `chrome.runtime.getURL` (page-side, no message) | guarded (returns a string; a throw falls back to the in-page panel) |

Before plan 1055 the five `chrome.runtime.sendMessage` calls had no
protection (three captures, one complete) or partial protection (the cancel
call sat in a `try` block that cannot catch a rejected promise).

## background.js

| Call | Status |
|---|---|
| `chrome.runtime.connectNative`, `port.postMessage` | partly guarded (`sendToNative` has a `try`; `registerBrowser` posts without one) |
| `chrome.tabs.sendMessage` in `sendToContentScript` | guarded (`try`/`catch`, then inject and retry) |
| `chrome.runtime.onMessage` listener | not a send; responses use `sendResponse` |
| `TOGGLE_XRAY` handler and `toggleXray()` (plan 1168) | `chrome.tabs.sendMessage` through `sendToContentScript`; guarded |
| `chrome.scripting.executeScript` | guarded (`try`/`catch`) |

The service worker is not subject to context invalidation. New in plan 1055:
`chrome.runtime.onConnect` ports (`pi-pane`, `pi-frame`), `port.postMessage`
and `chrome.tabs.sendMessage` with a `documentId` or `frameId` target; every
send is wrapped so a closed port or a missing document is ignored.

## Full-page capture (plan 1169)

| Message | Direction | Notes |
|---|---|---|
| `CAPTURE_FULL_PAGE` | popup to background | starts a capture of the active tab; not guarded (popup page) |
| `CAPTURE_PAGE_BEGIN` | background to content | `chrome.tabs.sendMessage` through `requestContentScript` (inject on a miss); the page answers with its metrics or a refusal |
| `CAPTURE_PAGE_STEP` | background to content | scroll to a position; the page answers with the reported scroll position |
| `CAPTURE_PAGE_END` | background to content | restore the page; sent from a `finally` block |
| `CAPTURE_PAGE_ABORT` | content to background | `PiSafeRuntime.sendMessageSafe`; guarded; sent on Escape |
| `CAPTURE_PAGE` (plan 1170) | content to background | `PiSafeRuntime.sendMessageSafe` from `requestPageCapture()`; guarded. The background runs `router.guardedCapture` around the whole multi-picture loop and answers with the tiles as data URLs (nothing is stored) |

## panel/panel.js (new in plan 1055)

| Call | Status |
|---|---|
| `chrome.runtime.connect` (`pi-pane`, `pi-frame`) and `port.postMessage` | guarded (a closed port is ignored; the pane connects again, the frame asks for a new token) |
| `chrome.devtools.inspectedWindow.eval` | guarded (the callback reports an exception) |

## popup.js (not edited by this plan)

| Call | Status |
|---|---|
| `chrome.runtime.sendMessage` GET_BROWSER_IDENTITY | not guarded (popup page; a closed popup has no page to protect) |
| `chrome.runtime.sendMessage` SET_PROFILE_LABEL, SET_BROWSER_NAME | not guarded (same) |
| `chrome.runtime.sendMessage` TOGGLE_PICKER | not guarded (same) |
| `chrome.runtime.sendMessage` TOGGLE_XRAY (plan 1168) | not guarded (same) |
| `chrome.runtime.sendMessage` CHECK_CONNECTION | guarded (`try`/`catch`) |

## xray/*.js (X-ray, plan 1168)

No `chrome.*` call. Controlled by `content.js` through `window.__piXray.toggle()`.

## tailedit/*.js (not edited by this plan)

No `chrome.*` call. The editor talks to `content.js` through callbacks.
