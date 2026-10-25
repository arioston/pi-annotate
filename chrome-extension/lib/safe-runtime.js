/**
 * Pi Annotate - safe runtime messaging (classic script, global PiSafeRuntime).
 *
 * After the extension reloads, a content script that stays in a page loses its
 * runtime context. Every chrome.runtime call then throws or rejects. These
 * helpers turn that into a result value so the page never sees an exception.
 */
(function (root) {
  var INVALIDATION_PATTERNS = [
    "Extension context invalidated",
    "message port closed",
    "Could not establish connection",
  ];

  function messageOf(error) {
    if (error && typeof error === "object" && typeof error.message === "string") return error.message;
    return String(error);
  }

  function isInvalidationError(error) {
    var text = messageOf(error);
    for (var i = 0; i < INVALIDATION_PATTERNS.length; i++) {
      if (text.indexOf(INVALIDATION_PATTERNS[i]) !== -1) return true;
    }
    return false;
  }

  function failure(error) {
    if (isInvalidationError(error)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "error", message: messageOf(error) };
  }

  function sendMessageSafe(payload) {
    try {
      return Promise.resolve(root.chrome.runtime.sendMessage(payload)).then(
        function (value) { return { ok: true, value: value }; },
        failure,
      );
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  }

  root.PiSafeRuntime = { sendMessageSafe: sendMessageSafe, isInvalidationError: isInvalidationError };
})(globalThis);
