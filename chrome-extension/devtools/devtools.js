// Pi Annotate - DevTools page (plan 1055).
// Registers a top-level DevTools panel, a peer of Elements, Console and
// Sources. The path starts at the extension root, not at devtools/. The panel
// binds itself to the inspected tab (panel.js).
chrome.devtools.panels.create(
  "Pi Annotate",
  "icons/icon48.png",
  "/panel/panel.html?host=devtools",
  function () {},
);
