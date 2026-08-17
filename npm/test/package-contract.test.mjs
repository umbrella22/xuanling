import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as releaseTrustModule from "../scripts/release-signature.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("published package has no install-time code execution", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "packages", "xuanling-mcp", "package.json"), "utf8"),
  );
  for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
    assert.equal(packageJson.scripts?.[script], undefined);
  }
  assert.equal(packageJson.license, "MIT");
  assert.ok(packageJson.files.includes("LICENSE"));
  assert.ok(!packageJson.files.includes("LICENSE-APACHE"));
  assert.ok(!packageJson.files.includes("LICENSE-MIT"));
  assert.equal(packageJson.publishConfig.registry, "https://registry.npmjs.org");
  assert.equal(packageJson.publishConfig.provenance, true);
  assert.ok(packageJson.files.includes("README.md"));
  assert.ok(packageJson.files.includes("README-ZH.md"));
});

test("launcher entrypoint is a small ESM shim", async () => {
  const source = await readFile(
    path.join(root, "packages", "xuanling-mcp", "bin", "xuanling-mcp.js"),
    "utf8",
  );
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
  assert.match(source, /import \{ launch \}/);
  assert.doesNotMatch(source, /child_process|execSync|curl|fetch/);
});

test("launcher recovery never recommends a global or floating install", async () => {
  const source = await readFile(
    path.join(root, "packages", "xuanling-mcp", "lib", "launcher.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /npm\s+(?:i|install)\s+(?:--global|-g)|@latest/i);
  assert.match(source, /reinstall the current [^\n]+ package|reinstall[^\n]+profile/i);
});

test("release trust requires npm provenance and records publisher signing explicitly", () => {
  assert.equal(
    typeof releaseTrustModule.releaseTrustFromArgs,
    "function",
    "release trust staging must classify provenance separately from publisher signing",
  );
  assert.equal(
    typeof releaseTrustModule.verifyReleaseTrust,
    "function",
    "release trust verification must reject malformed trust metadata",
  );
  const {
    releaseTrustFromArgs,
    verifyReleaseTrust,
  } = releaseTrustModule;
  const unsignedDarwin = releaseTrustFromArgs({}, "darwin-arm64");
  const unsignedWindows = releaseTrustFromArgs({}, "win32-x64-msvc");
  const signedDarwin = releaseTrustFromArgs({
    "publisher-signature-kind": "developer-id-application",
    "publisher-signature-identity": "Developer ID Application: Example (TEAMID)",
  }, "darwin-arm64");
  const linux = releaseTrustFromArgs({}, "linux-x64-gnu");
  const signedWindows = releaseTrustFromArgs({
    "publisher-signature-kind": "authenticode",
    "publisher-signature-identity": "CN=Example",
    "publisher-signature-timestamped": "true",
  }, "win32-x64-msvc");

  assert.deepEqual(unsignedDarwin, {
    npmProvenance: { status: "required-at-publish" },
    publisherSigning: { status: "not-provided" },
  });
  assert.deepEqual(unsignedWindows, unsignedDarwin);
  for (const [trust, targetId] of [
    [unsignedDarwin, "darwin-arm64"],
    [linux, "linux-x64-gnu"],
    [unsignedWindows, "win32-x64-msvc"],
    [signedDarwin, "darwin-arm64"],
    [signedWindows, "win32-x64-msvc"],
  ]) {
    assert.doesNotThrow(() => verifyReleaseTrust(trust, targetId));
  }
  assert.throws(
    () => verifyReleaseTrust({
      ...signedWindows,
      publisherSigning: { ...signedWindows.publisherSigning, timestamped: false },
    }, "win32-x64-msvc"),
    /timestamped/,
  );
  assert.throws(
    () => releaseTrustFromArgs({ "publisher-signature-kind": "authenticode" }, "darwin-arm64"),
    /requires signature kind/,
  );
  assert.throws(
    () => verifyReleaseTrust(undefined, "darwin-arm64"),
    /missing release trust metadata/,
  );
  assert.throws(
    () => releaseTrustFromArgs({}, "future-target"),
    /Unknown release trust target/,
  );
});
