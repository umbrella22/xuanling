#!/usr/bin/env node
// External oracle for the fs-workload fixture. Judges a trial workspace
// WITHOUT trusting the model: every check reads the final files and compares
// them against the checked-in manifest and explicit semantic expectations.
//
// Usage: node oracle.mjs --fixture <fs-workload-dir> --workspace <trial-dir>
//   --fixture defaults to this script's directory.
// Prints one JSON verdict object; exit 0 = pass, 1 = fail.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const fixtureDir = argValue("--fixture") ?? path.dirname(new URL(import.meta.url).pathname);
const workspace = argValue("--workspace");
const failures = [];

function fail(message) {
  failures.push(message);
}

if (!workspace || !existsSync(workspace)) {
  fail(`workspace missing or not a directory: ${String(workspace)}`);
} else {
  const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));

  const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

  const walk = (dir, prefix = "") => {
    const entries = [];
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) entries.push(...walk(abs, rel));
      else entries.push(rel);
    }
    return entries;
  };

  const present = walk(workspace);
  const allowed = new Set([...Object.keys(manifest.files), ...manifest.allowed_new]);

  // Workspace containment: exact final file set.
  for (const rel of present) {
    if (!allowed.has(rel)) fail(`unexpected file in workspace: ${rel}`);
  }
  for (const rel of allowed) {
    if (!present.includes(rel)) fail(`expected file missing from workspace: ${rel}`);
  }

  // Untouched files must stay byte-identical to the frozen fixture.
  for (const [rel, expectedHash] of Object.entries(manifest.untouched)) {
    const abs = path.join(workspace, rel);
    if (!existsSync(abs)) continue; // already reported as missing
    const actual = sha256(abs);
    if (actual !== expectedHash) fail(`forbidden modification to untouched file ${rel}`);
  }

  // src/config.json — semantic JSON expectations.
  const configPath = path.join(workspace, "src", "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.version !== "1.5.0") fail(`config.version expected 1.5.0, got ${JSON.stringify(config.version)}`);
      if (config.defaults?.strictMode !== true) fail("config.defaults.strictMode expected true");
      if (config.features?.legacyIndex !== false) fail("config.features.legacyIndex expected false");
      if (config.service !== "notes-service") fail("config.service must stay notes-service");
      if (config.defaults?.locale !== "en-US") fail("config.defaults.locale must stay en-US");
      if (config.features?.newEditor !== true) fail("config.features.newEditor must stay true");
    } catch (error) {
      fail(`src/config.json no longer parses as JSON: ${String(error)}`);
    }
  }

  // src/notes.md — exact-phrase replacement with a protected near-miss.
  const notesPath = path.join(workspace, "src", "notes.md");
  if (existsSync(notesPath)) {
    const notes = readFileSync(notesPath, "utf8");
    const legacyCount = notes.split("ACL legacy flag").length - 1;
    if (legacyCount !== 0) fail(`src/notes.md still has ${legacyCount} occurrence(s) of "ACL legacy flag"`);
    const hyphenCount = notes.split("ACL legacy-flag").length - 1;
    if (hyphenCount !== 1) fail(`src/notes.md hyphenated near-miss must appear exactly once, got ${hyphenCount}`);
    const renamedCount = notes.split("access-control flag").length - 1;
    if (renamedCount < 3) fail(`src/notes.md expected >=3 "access-control flag" occurrences, got ${renamedCount}`);
    const unchecked = notes.split("- [ ]").length - 1;
    // RELEASE.md's "Notes count" must be computed from the final notes file.
    const releasePath = path.join(workspace, "RELEASE.md");
    if (existsSync(releasePath)) {
      const release = readFileSync(releasePath, "utf8");
      if (!release.includes("# Release 1.5.0")) fail("RELEASE.md must contain the heading # Release 1.5.0");
      if (!release.includes("Access control")) fail("RELEASE.md must describe Access control");
      if (!release.includes("Retention window")) fail("RELEASE.md must describe Retention window");
      const match = /^Notes count: (\d+)$/m.exec(release);
      if (!match) fail("RELEASE.md must end with a line 'Notes count: N'");
      else if (Number(match[1]) !== unchecked) {
        fail(`RELEASE.md Notes count ${match[1]} != ${unchecked} unchecked items in src/notes.md`);
      }
    }
  }

  // src/deep/protocol.md — verification flip.
  const protocolPath = path.join(workspace, "src", "deep", "protocol.md");
  if (existsSync(protocolPath)) {
    const protocol = readFileSync(protocolPath, "utf8");
    if (!protocol.includes("checksums-verified: yes")) fail("protocol.md must end with checksums-verified: yes");
    if (protocol.includes("checksums-verified: no")) fail("protocol.md still contains checksums-verified: no");
    for (const line of protocol.split("\n")) {
      const listed = /^- (.+)$/m.exec(line);
      if (listed && !existsSync(path.join(workspace, listed[1]))) {
        fail(`protocol.md lists a path that does not exist: ${listed[1]}`);
      }
    }
  }
}

const verdict = { fixture: "fs-workload", oracle: "oracle.mjs", pass: failures.length === 0, failures };
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
