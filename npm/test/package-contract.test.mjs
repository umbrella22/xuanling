import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("published package has no install-time code execution", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "packages", "xuanling-mcp", "package.json"), "utf8"),
  );
  for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
    assert.equal(packageJson.scripts?.[script], undefined);
  }
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
