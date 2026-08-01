import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeDirectory } from "../src/runtime-paths.cjs";

test("explicit registry directory wins over XDG and reports explicit source", () => {
  const result = resolveRuntimeDirectory({
    env: {
      PI_ANNOTATE_REGISTRY_DIR: "/var/lib/pi-annotate-explicit",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    platform: "linux",
    tmpdir: "/tmp",
    userId: 42,
  });

  assert.equal(result.registryDir, "/var/lib/pi-annotate-explicit");
  assert.equal(result.source, "explicit");
});

test("absolute XDG runtime directory is used on Unix", () => {
  const result = resolveRuntimeDirectory({
    env: {
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    platform: "linux",
    tmpdir: "/tmp",
    userId: 42,
  });

  assert.equal(result.registryDir, "/run/user/1000/pi-annotate");
  assert.equal(result.source, "xdg");
});

test("temp fallback uses the tmpdir and user id", () => {
  const result = resolveRuntimeDirectory({
    env: {},
    platform: "linux",
    tmpdir: "/tmp/pi-annotate-tests",
    userId: 1234,
  });

  assert.equal(result.registryDir, "/tmp/pi-annotate-tests/pi-annotate-1234");
  assert.equal(result.source, "temp");
});

test("Windows skips XDG and falls back to temp", () => {
  const result = resolveRuntimeDirectory({
    env: {
      XDG_RUNTIME_DIR: "C:\\Users\\user\\AppData\\Local\\Temp",
    },
    platform: "win32",
    tmpdir: "C:\\Temp",
    userId: "user",
  });

  assert.equal(result.registryDir, "C:\\Temp\\pi-annotate-user");
  assert.equal(result.source, "temp");
});

test("relative and invalid runtime directory values fail deterministically", () => {
  assert.throws(
    () => resolveRuntimeDirectory({
      env: { PI_ANNOTATE_REGISTRY_DIR: "relative/path" },
      platform: "linux",
      tmpdir: "/tmp",
      userId: 1,
    }),
    /PI_ANNOTATE_REGISTRY_DIR must be an absolute path/,
  );

  assert.throws(
    () => resolveRuntimeDirectory({
      env: { PI_ANNOTATE_REGISTRY_DIR: "/tmp/pi-annotate\nline" },
      platform: "linux",
      tmpdir: "/tmp",
      userId: 1,
    }),
    /PI_ANNOTATE_REGISTRY_DIR must not contain newlines/,
  );

  assert.throws(
    () => resolveRuntimeDirectory({
      env: { XDG_RUNTIME_DIR: "/run/user/\0bad" },
      platform: "linux",
      tmpdir: "/tmp",
      userId: 1,
    }),
    /XDG_RUNTIME_DIR must not contain NUL bytes/,
  );
});
