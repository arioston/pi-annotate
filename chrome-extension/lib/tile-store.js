/**
 * Pi Annotate - tile store (classic script, global PiTileStore).
 *
 * Plan 1173. The session page capture keeps its pictures here, in memory, and
 * the content script reads them one at a time. One message then holds one
 * picture, not all pictures (Chrome refuses a runtime message above 64 MiB).
 * Nothing goes to disk. A service worker restart drops every run.
 *
 * A run is freed in four cases: after its last tile is read, on a tab change
 * (dropTab, dropOtherTabs), at the end of the session (dropTab), and after a
 * time limit with no read. It has no browser API; Node tests run it.
 */
(function (root) {
  var DEFAULT_TTL_MS = 120000;

  // deps: newId() -> string, setTimer(fn, ms), clearTimer(handle), ttlMs
  function create(deps) {
    var ttl = deps.ttlMs || DEFAULT_TTL_MS;
    var runs = Object.create(null);

    function drop(runId) {
      var run = runs[runId];
      if (!run) return;
      deps.clearTimer(run.timer);
      delete runs[runId];
    }

    function arm(runId) {
      var run = runs[runId];
      deps.clearTimer(run.timer);
      run.timer = deps.setTimer(function () { drop(runId); }, ttl);
    }

    // A new run of a tab replaces an older run of the same tab.
    function put(tabId, windowId, dataUrls) {
      dropTab(tabId);
      var runId = deps.newId();
      runs[runId] = { tabId: tabId, windowId: windowId, dataUrls: dataUrls.slice(), timer: null };
      arm(runId);
      return runId;
    }

    // Returns { dataUrl } or { error }. Only the tab of the run can read it.
    function take(runId, tabId, index) {
      var run = typeof runId === "string" ? runs[runId] : null;
      if (!run || run.tabId !== tabId) return { error: "The page capture is no longer available" };
      if (!Number.isInteger(index) || index < 0 || index >= run.dataUrls.length) return { error: "The tile does not exist" };
      var dataUrl = run.dataUrls[index];
      if (index === run.dataUrls.length - 1) drop(runId);
      else arm(runId);
      return { dataUrl: dataUrl };
    }

    function dropTab(tabId) {
      Object.keys(runs).forEach(function (id) { if (runs[id].tabId === tabId) drop(id); });
    }

    // The active tab of a window changed: runs of other tabs in that window end.
    function dropOtherTabs(windowId, activeTabId) {
      Object.keys(runs).forEach(function (id) {
        if (runs[id].windowId === windowId && runs[id].tabId !== activeTabId) drop(id);
      });
    }

    return { put: put, take: take, drop: drop, dropTab: dropTab, dropOtherTabs: dropOtherTabs, size: function () { return Object.keys(runs).length; } };
  }

  root.PiTileStore = { create: create, DEFAULT_TTL_MS: DEFAULT_TTL_MS };
})(globalThis);
