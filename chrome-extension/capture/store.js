/**
 * Pi Annotate - capture store (classic script, global PiCaptureStore).
 *
 * Keeps one full-page capture so that the result tab can read it (plan 1169).
 * It uses IndexedDB only, so it works in the service worker and in the result
 * page. One database, one object store.
 *
 * NO HISTORY. The store has no function that lists captures for display. A
 * capture older than 24 hours is deleted by cleanup(), which the background
 * runs at the start of each capture and when the service worker starts.
 *
 * RECORD
 *   { id, url, title, created (ms), dpr, partial (null or "tiles"|"height"),
 *     tiles: [{ blob, src:{x,y,w,h}, destY }] }
 *
 * Writer: the service worker. Deleter: cleanup() only. Reader: the result page.
 */
(function (root) {
  var DB_NAME = "pi-annotate-capture";
  var STORE = "captures";
  var MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function request(mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var result;
        try { result = run(tx.objectStore(STORE)); } catch (err) { db.close(); reject(err); return; }
        tx.oncomplete = function () { db.close(); resolve(result && "result" in result ? result.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error("Capture store transaction aborted")); };
      });
    });
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Save a capture. Returns its id. */
  function save(capture) {
    var record = Object.assign({}, capture, { id: newId(), created: Date.now() });
    return request("readwrite", function (store) { store.put(record); }).then(function () { return record.id; });
  }

  /** Read one capture by id, or undefined. */
  function read(id) {
    return request("readonly", function (store) { return store.get(id); });
  }

  /** Delete each capture older than 24 hours. The only function that scans. */
  function cleanup() {
    var cutoff = Date.now() - MAX_AGE_MS;
    return request("readwrite", function (store) {
      var cursorReq = store.openCursor();
      cursorReq.onsuccess = function () {
        var cursor = cursorReq.result;
        if (!cursor) return;
        if (cursor.value.created < cutoff) cursor.delete();
        cursor.continue();
      };
    });
  }

  root.PiCaptureStore = { save: save, read: read, cleanup: cleanup, MAX_AGE_MS: MAX_AGE_MS };
})(globalThis);
