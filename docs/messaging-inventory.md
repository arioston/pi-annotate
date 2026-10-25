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

Before plan 1055 the five `chrome.runtime.sendMessage` calls were not guarded
(three captures, one complete) or partly guarded (the cancel call sat in a
`try` block that cannot catch a rejected promise).

## background.js

| Call | Status |
|---|---|
| `chrome.runtime.connectNative`, `port.postMessage` | partly guarded (`sendToNative` has a `try`; `registerBrowser` posts without one) |
| `chrome.tabs.sendMessage` in `sendToContentScript` | guarded (`try`/`catch`, then inject and retry) |
| `chrome.runtime.onMessage` listener | not a send; responses use `sendResponse` |
| `chrome.scripting.executeScript` | guarded (`try`/`catch`) |

The service worker is not subject to context invalidation.

## popup.js (not edited by this plan)

| Call | Status |
|---|---|
| `chrome.runtime.sendMessage` GET_BROWSER_IDENTITY | not guarded (popup page; a closed popup has no page to protect) |
| `chrome.runtime.sendMessage` SET_PROFILE_LABEL, SET_BROWSER_NAME | not guarded (same) |
| `chrome.runtime.sendMessage` TOGGLE_PICKER | not guarded (same) |
| `chrome.runtime.sendMessage` CHECK_CONNECTION | guarded (`try`/`catch`) |

## tailedit/*.js (not edited by this plan)

No `chrome.*` call. The editor talks to `content.js` through callbacks.
