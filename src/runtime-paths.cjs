"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

class RuntimePathConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimePathConfigurationError";
    this.code = "ERR_PI_ANNOTATE_RUNTIME_PATH";
  }
}

function isWindowsPlatform(platform) {
  return platform === "win32";
}

function isAbsolutePath(platform, value) {
  return isWindowsPlatform(platform) ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function joinForPlatform(platform, ...parts) {
  return isWindowsPlatform(platform) ? path.win32.join(...parts) : path.posix.join(...parts);
}

function toConfiguredPathError(name, reason) {
  return new RuntimePathConfigurationError(`${name} ${reason}`);
}

function validateConfiguredPath(name, value, platform) {
  if (typeof value !== "string" || value.length === 0) {
    throw toConfiguredPathError(name, "must be a non-empty absolute path");
  }
  if (value.includes("\0")) {
    throw toConfiguredPathError(name, "must not contain NUL bytes");
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw toConfiguredPathError(name, "must not contain newlines");
  }
  if (!isAbsolutePath(platform, value)) {
    throw toConfiguredPathError(name, "must be an absolute path");
  }
  return value;
}

function resolveRuntimeDirectory(options = {}) {
  const {
    env = process.env,
    tmpdir = os.tmpdir(),
    platform = process.platform,
    userId = typeof process.getuid === "function" ? process.getuid() : "user",
  } = options;

  if (Object.prototype.hasOwnProperty.call(env, "PI_ANNOTATE_REGISTRY_DIR")) {
    return {
      registryDir: validateConfiguredPath("PI_ANNOTATE_REGISTRY_DIR", env.PI_ANNOTATE_REGISTRY_DIR, platform),
      source: "explicit",
    };
  }

  if (!isWindowsPlatform(platform) && Object.prototype.hasOwnProperty.call(env, "XDG_RUNTIME_DIR")) {
    return {
      registryDir: joinForPlatform(
        platform,
        validateConfiguredPath("XDG_RUNTIME_DIR", env.XDG_RUNTIME_DIR, platform),
        "pi-annotate",
      ),
      source: "xdg",
    };
  }

  return {
    registryDir: joinForPlatform(platform, tmpdir, `pi-annotate-${String(userId)}`),
    source: "temp",
  };
}

function resolveHostPaths(options = {}) {
  const {
    instanceId = crypto.randomBytes(12).toString("hex"),
  } = options;
  const runtime = resolveRuntimeDirectory(options);
  const baseName = `pi-annotate-${instanceId}`;
  return {
    ...runtime,
    socketPath: joinForPlatform(options.platform ?? process.platform, runtime.registryDir, `${baseName}.sock`),
    tokenPath: joinForPlatform(options.platform ?? process.platform, runtime.registryDir, `${baseName}.token`),
    metadataPath: joinForPlatform(options.platform ?? process.platform, runtime.registryDir, `${baseName}.json`),
    logPath: joinForPlatform(options.platform ?? process.platform, runtime.registryDir, `${baseName}.log`),
  };
}

module.exports = {
  RuntimePathConfigurationError,
  resolveRuntimeDirectory,
  resolveHostPaths,
};
