// Pi Annotate - DevTools page (plan 1055).
// Registers the Elements sidebar pane. The path starts at the extension root,
// not at devtools/. The pane binds itself to the inspected tab (panel.js).
chrome.devtools.panels.elements.createSidebarPane("Pi Annotate", function (pane) {
  pane.setPage("/panel/panel.html?host=devtools");
});
