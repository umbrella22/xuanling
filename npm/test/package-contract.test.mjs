import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  signatureFromArgs,
  verifyReleaseSignature,
} from "../scripts/release-signature.mjs";

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

test("release signature metadata is target-specific and fail-closed", () => {
  const darwin = signatureFromArgs({
    "signature-kind": "developer-id-application",
    "signature-identity": "Developer ID Application: Example (TEAMID)",
  }, "darwin-arm64");
  const linux = signatureFromArgs({
    "signature-kind": "npm-provenance",
  }, "linux-x64-gnu");
  const windows = signatureFromArgs({
    "signature-kind": "authenticode",
    "signature-identity": "CN=Example",
    "signature-timestamped": "true",
  }, "win32-x64-msvc");

  assert.doesNotThrow(() => verifyReleaseSignature(darwin, "darwin-arm64"));
  assert.doesNotThrow(() => verifyReleaseSignature(linux, "linux-x64-gnu"));
  assert.doesNotThrow(() => verifyReleaseSignature(windows, "win32-x64-msvc"));
  assert.throws(
    () => verifyReleaseSignature({ ...windows, timestamped: false }, "win32-x64-msvc"),
    /timestamped/,
  );
  assert.throws(
    () => signatureFromArgs({ "signature-kind": "authenticode" }, "darwin-arm64"),
    /requires signature kind/,
  );
});
