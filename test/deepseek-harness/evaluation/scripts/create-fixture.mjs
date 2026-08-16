#!/usr/bin/env node
// Deterministic fixture materializer for the fs-workload benchmark (C-06).
//
// Every trial must start from byte-identical state restored from the same
// checked-in path. This script copies the frozen fixture tree into a fresh
// destination and verifies every pinned manifest hash; any drift — in the
// source tree or the copy — exits non-zero before a session can start.
//
// Usage: node create-fixture.mjs --dest <fresh-directory>
//   --dest must not exist; it is created. Prints one JSON summary.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const fixtureRoot = path.resolve(import.meta.dirname, "..", "fixtures", "fs-workload");
const destination = argValue("--dest");
if (!destination) {
  console.error("create-fixture: --dest <fresh-directory> is required");
  process.exit(2);
}
if (existsSync(destination)) {
  console.error(`create-fixture: destination already exists: ${destination} (never reuse a workspace)`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Verify the frozen source before copying anything.
const problems = [];
for (const [rel, hash] of Object.entries(manifest.files)) {
  if (sha256(path.join(fixtureRoot, "files", rel)) !== hash) {
    problems.push(`source drift: files/${rel}`);
  }
}
if (sha256(path.join(fixtureRoot, manifest.task)) !== manifest.task_sha256) {
  problems.push("source drift: task.md");
}
if (problems.length > 0) {
  console.error(`create-fixture: refusing to materialize a drifted fixture:\n${problems.join("\n")}`);
  process.exit(1);
}

mkdirSync(destination, { recursive: true });
cpSync(path.join(fixtureRoot, "files"), destination, { recursive: true });

// Verify the copy landed byte-identical.
for (const [rel, hash] of Object.entries(manifest.files)) {
  if (sha256(path.join(destination, rel)) !== hash) {
    problems.push(`copy drift: ${rel}`);
  }
}
if (problems.length > 0) {
  console.error(`create-fixture: copy verification failed:\n${problems.join("\n")}`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({ fixture: manifest.fixture, dest: destination, files: Object.keys(manifest.files).length, task_sha256: manifest.task_sha256 }, null, 2)}\n`,
);
