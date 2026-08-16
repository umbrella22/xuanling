#!/usr/bin/env node
// Batch oracle runner (C-06): independently re-judges every trial workspace
// under an evaluation root WITHOUT trusting the runner or the model.
//
// Layout it understands (created by run-filesystem-evaluation.mjs):
//   <root>/quality/<arm>/trial-<n>/workspace
//   <root>/cache/<arm>/pair-<n>/<cold|warm>/workspace-snapshot
//
// Usage:
//   node verify-filesystem-fixture.mjs --workspace <dir>    one workspace
//   node verify-filesystem-fixture.mjs --all <root>         every workspace
// Prints one JSON summary; exit 0 only when every verdict passes.

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const oracle = path.join(import.meta.dirname, "..", "fixtures", "fs-workload", "oracle.mjs");
const WORKSPACE_NAMES = new Set(["workspace", "workspace-snapshot"]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function judge(label, workspace) {
  const result = spawnSync(process.execPath, [oracle, "--workspace", workspace], { encoding: "utf8" });
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    verdict = { pass: false, failures: [`oracle produced no verdict (exit ${result.status}): ${result.stderr}`] };
  }
  return {
    label,
    workspace,
    oracle_exit: result.status,
    pass: verdict.pass === true && result.status === 0,
    failures: verdict.failures ?? [],
  };
}

const workspace = argValue("--workspace");
const root = argValue("--all");

if (workspace !== undefined) {
  const verdict = judge("workspace", workspace);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(verdict.pass ? 0 : 1);
}

if (root === undefined) {
  console.error("verify-filesystem-fixture: --workspace <dir> or --all <root> is required");
  process.exit(2);
}

const workspaces = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (!statSync(abs).isDirectory()) continue;
    if (WORKSPACE_NAMES.has(name)) {
      workspaces.push(abs);
      continue;
    }
    walk(abs, depth + 1);
  }
};
if (!existsSync(root)) {
  console.error(`verify-filesystem-fixture: root does not exist: ${root}`);
  process.exit(2);
}
walk(root, 0);

const verdicts = workspaces.map((abs) => judge(path.relative(root, path.dirname(abs)), abs));
const summary = {
  root,
  total: verdicts.length,
  passed: verdicts.filter((entry) => entry.pass).length,
  failed: verdicts.filter((entry) => !entry.pass).length,
  verdicts,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(summary.failed === 0 && summary.total > 0 ? 0 : 1);
