// Pi Annotate - DevTools page (plan 1055).
// Registers a top-level DevTools panel, a peer of Elements, Console and
// Sources. The path starts at the extension root, not at devtools/. The panel
// binds itself to the inspected tab (panel.js).
chrome.devtools.panels.create(
  "Pi Annotate",
  "icons/icon48.png",
  "/panel/panel.html?host=devtools",
  function (panel) {
    // Forward show and hide to the page, so it asks for a session when it is
    // opened and stays quiet while hidden. On the first show the page may
    // still be loading; it then asks by itself when it connects.
    var win = null;
    panel.onShown.addListener(function (w) {
      win = w;
      if (w && typeof w.__piPanelShown === "function") w.__piPanelShown();
    });
    panel.onHidden.addListener(function () {
      if (win && typeof win.__piPanelHidden === "function") win.__piPanelHidden();
    });
  },
);
