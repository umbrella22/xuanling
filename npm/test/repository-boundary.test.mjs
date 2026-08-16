// Repository boundary contract tests (memory-v2 plan W1).
//
// These tests are RED until Wave 2 extracts `xuanling-memory` from
// `xuanling-toolkit`. They assert the *target* crate topology from
// `cargo metadata --format-version 1 --no-deps` (structured JSON, not string
// search over manifests):
//
//   1. memory_is_an_independent_workspace_crate
//   2. toolkit_does_not_export_memory
//   3. mcp_depends_on_memory_and_toolkit_as_siblings
//   4. memory_does_not_depend_on_toolkit_or_host
//
// Contract source: docs/plans/memory-v2-extraction-development-plan.md (C-02).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function loadMetadata() {
  const stdout = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

function packageByName(metadata, name) {
  return metadata.packages.find((pkg) => pkg.name === name) ?? null;
}

function normalDependencyNames(pkg) {
  return (pkg?.dependencies ?? [])
    .filter((dep) => dep.kind === null || dep.kind === "normal")
    .map((dep) => dep.name);
}

test("memory_is_an_independent_workspace_crate", () => {
  const metadata = loadMetadata();
  const memory = packageByName(metadata, "xuanling-memory");
  assert.ok(
    memory,
    "workspace must contain a `xuanling-memory` package; found: " +
      metadata.packages.map((pkg) => pkg.name).join(", "),
  );
  const expectedManifest = path.join(
    repoRoot,
    "crates",
    "xuanling-memory",
    "Cargo.toml",
  );
  assert.equal(
    path.normalize(memory.manifest_path),
    expectedManifest,
    "xuanling-memory must live at crates/xuanling-memory/Cargo.toml",
  );
  assert.ok(
    metadata.workspace_members.includes(memory.id),
    "xuanling-memory must be a workspace member",
  );
});

test("toolkit_does_not_export_memory", () => {
  const metadata = loadMetadata();
  const toolkit = packageByName(metadata, "xuanling-toolkit");
  assert.ok(toolkit, "xuanling-toolkit package must exist");

  const memoryOnlyDeps = ["sqlx", "unicode-normalization"];
  const deps = normalDependencyNames(toolkit);
  const present = memoryOnlyDeps.filter((dep) => deps.includes(dep));
  assert.deepEqual(
    present,
    [],
    "xuanling-toolkit must not keep memory-only dependencies: " +
      `${present.join(", ")} still declared`,
  );

  const memoryModule = path.join(repoRoot, "crates", "xuanling-toolkit", "src", "memory");
  assert.equal(
    existsSync(memoryModule),
    false,
    "crates/xuanling-toolkit/src/memory must not exist after extraction",
  );
});

test("mcp_depends_on_memory_and_toolkit_as_siblings", () => {
  const metadata = loadMetadata();
  const mcp = packageByName(metadata, "xuanling-mcp");
  assert.ok(mcp, "xuanling-mcp package must exist");

  const deps = normalDependencyNames(mcp);
  assert.ok(
    deps.includes("xuanling-toolkit"),
    "xuanling-mcp must depend on xuanling-toolkit",
  );
  assert.ok(
    deps.includes("xuanling-memory"),
    "xuanling-mcp must depend on xuanling-memory as a sibling crate; " +
      `normal dependencies: ${deps.join(", ")}`,
  );
});

test("memory_does_not_depend_on_toolkit_or_host", () => {
  const metadata = loadMetadata();
  const memory = packageByName(metadata, "xuanling-memory");
  assert.ok(memory, "xuanling-memory package must exist");

  const deps = normalDependencyNames(memory);
  const forbidden = deps.filter((dep) =>
    ["xuanling-toolkit", "xuanling-mcp"].includes(dep),
  );
  assert.deepEqual(
    forbidden,
    [],
    "xuanling-memory must not depend on toolkit/host crates: " +
      forbidden.join(", "),
  );
});
