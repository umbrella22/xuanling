import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBinary } from "../packages/harness-bridge/lib/launcher.js";
import { TARGETS, detectTarget } from "../packages/harness-bridge/lib/targets.js";

const darwin = TARGETS["darwin-arm64"];
const noPackage = () => {
  throw new Error("not installed");
};

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("HARNESS_BRIDGE_BIN takes precedence", async () => {
  const directory = await tempDir("hb-env-");
  const binary = path.join(directory, "custom-bridge");
  await writeFile(binary, "");
  const resolved = resolveBinary({
    env: { HARNESS_BRIDGE_BIN: binary },
    cwd: directory,
    target: darwin,
    resolvePackageJson: noPackage,
    repoRoots: [],
  });
  assert.equal(resolved, binary);
});

test("a local Cargo debug binary is resolved", async () => {
  const root = await tempDir("hb-repo-");
  await mkdir(path.join(root, "crates", "xuanling-harness-bridge"), { recursive: true });
  await writeFile(path.join(root, "Cargo.toml"), "");
  await writeFile(path.join(root, "crates", "xuanling-harness-bridge", "Cargo.toml"), "");
  await mkdir(path.join(root, "target", "debug"), { recursive: true });
  const binary = path.join(root, "target", "debug", "harness-bridge");
  await writeFile(binary, "");
  const resolved = resolveBinary({
    env: {},
    cwd: root,
    target: darwin,
    resolvePackageJson: noPackage,
    repoRoots: [root],
  });
  assert.equal(resolved, binary);
});

test("PATH is the last fallback", async () => {
  const root = await tempDir("hb-path-");
  const binDirectory = path.join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const binary = path.join(binDirectory, "harness-bridge");
  await writeFile(binary, "");
  const resolved = resolveBinary({
    env: { PATH: binDirectory },
    cwd: root,
    target: darwin,
    resolvePackageJson: noPackage,
    repoRoots: [],
  });
  assert.equal(resolved, binary);
});

test("a missing binary has an actionable error", async () => {
  assert.throws(
    () =>
      resolveBinary({
        env: {},
        cwd: os.tmpdir(),
        target: darwin,
        resolvePackageJson: noPackage,
        repoRoots: [],
      }),
    /Cannot find the harness-bridge binary/,
  );
});

test("target mapping covers the supported release targets", () => {
  assert.equal(detectTarget({ platform: "darwin", arch: "arm64" }).rustTarget, "aarch64-apple-darwin");
  assert.equal(detectTarget({ platform: "linux", arch: "x64" }).rustTarget, "x86_64-unknown-linux-gnu");
  assert.equal(detectTarget({ platform: "win32", arch: "x64" }).rustTarget, "x86_64-pc-windows-msvc");
  assert.throws(() => detectTarget({ platform: "freebsd", arch: "x64" }), /Unsupported platform/);
});

test("the package manifest exposes the launcher and no install scripts", async () => {
  const packagePath = fileURLToPath(
    new URL("../packages/harness-bridge/package.json", import.meta.url),
  );
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(manifest.name, "@xuanling-rs/harness-bridge");
  assert.equal(manifest.bin?.["harness-bridge"], "bin/harness-bridge.js");
  assert.ok(existsSync(fileURLToPath(new URL("../packages/harness-bridge/lib/launcher.js", import.meta.url))));
  for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
    assert.equal(manifest.scripts?.[script], undefined);
  }
});
