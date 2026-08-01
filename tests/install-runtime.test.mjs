import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function prepareFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-install-fixture-"));
  await cp(path.join(process.cwd(), "chrome-extension/native"), fixtureRoot, { recursive: true });
  const home = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-home-"));
  const configHome = await mkdtemp(path.join(os.tmpdir(), ".pi-annotate-config-"));
  return { fixtureRoot, home, configHome };
}

function runInstall(fixtureRoot, env, args) {
  return spawnSync("bash", ["install.sh", ...args], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

test("installer writes a shell-safe wrapper and JSON manifests with quoted registry paths", async (t) => {
  const { fixtureRoot, home, configHome } = await prepareFixture();
  const registryDir = path.join(home, "shared registry 'quoted'");
  await mkdir(registryDir, { recursive: true });
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  });

  const result = runInstall(fixtureRoot, {
    HOME: home,
    CHROME_CONFIG_HOME: configHome,
  }, [extensionId, "--registry-dir", registryDir]);
  assert.equal(result.status, 0, result.stderr);

  const wrapperPath = path.join(fixtureRoot, "host-wrapper.sh");
  const wrapper = await readFile(wrapperPath, "utf8");
  assert.match(wrapper, /export PI_ANNOTATE_REGISTRY_DIR='.*shared registry '\\''quoted'\\'''.*/);
  assert.match(wrapper, /exec '/);
  assert.match(wrapper, /host\.cjs'/);
  assert.match(wrapper, /"\$@"/);
  assert.doesNotMatch(wrapper, /pi-annotate\.sock/i);
  assert.doesNotMatch(wrapper, /pi-annotate\.token/i);

  const manifestPath = path.join(configHome, "google-chrome", "NativeMessagingHosts", "com.pi.annotate.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "com.pi.annotate");
  assert.equal(manifest.path, wrapperPath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
});

test("installer rejects malformed arguments and works without a registry override", async (t) => {
  const { fixtureRoot, home, configHome } = await prepareFixture();
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  });

  const noFlag = runInstall(fixtureRoot, {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
  }, [extensionId]);
  assert.equal(noFlag.status, 0, noFlag.stderr);

  const wrapper = await readFile(path.join(fixtureRoot, "host-wrapper.sh"), "utf8");
  assert.doesNotMatch(wrapper, /PI_ANNOTATE_REGISTRY_DIR/);

  const manifestPath = path.join(configHome, "google-chrome", "NativeMessagingHosts", "com.pi.annotate.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.path, path.join(fixtureRoot, "host-wrapper.sh"));

  const missingRegistry = runInstall(fixtureRoot, {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
  }, [extensionId, "--registry-dir"]);
  assert.notEqual(missingRegistry.status, 0);
  assert.match(missingRegistry.stderr, /requires an absolute path/);

  const relativeRegistry = runInstall(fixtureRoot, {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
  }, [extensionId, "--registry-dir", "relative/path"]);
  assert.notEqual(relativeRegistry.status, 0);
  assert.match(relativeRegistry.stderr, /must be an absolute path/);

  const newlineRegistry = runInstall(fixtureRoot, {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
  }, [extensionId, "--registry-dir", "/tmp/pi-annotate\nbad"]);
  assert.notEqual(newlineRegistry.status, 0);
  assert.match(newlineRegistry.stderr, /must not contain newlines/);
});
