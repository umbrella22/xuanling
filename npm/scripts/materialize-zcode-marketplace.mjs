import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  NPM_ROOT,
  parseArgs,
  readJson,
  requiredArg,
  run,
} from "./shared.mjs";

function digest(algorithm, data, encoding = "hex") {
  return createHash(algorithm).update(data).digest(encoding);
}

async function requireMissing(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Materialized output already exists: ${target}`);
}

const args = parseArgs(process.argv.slice(2));
const artifactRoot = path.resolve(requiredArg(args, "artifact-root"));
const outputRoot = path.resolve(requiredArg(args, "out"));
const version = requiredArg(args, "version");
const sourceCommit = requiredArg(args, "commit");

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Invalid source commit: ${sourceCommit}`);
}
if (path.dirname(outputRoot) !== artifactRoot || path.basename(outputRoot) !== "marketplace") {
  throw new Error("--out must be the marketplace child of --artifact-root");
}

const packName = "zcode-marketplace.pack.json";
const archiveName = `xuanling-zcode-marketplace-${version}.tar.gz`;
const entries = await readdir(artifactRoot, { withFileTypes: true });
assert.deepEqual(
  entries.map((entry) => entry.name).sort(),
  [archiveName, packName].sort(),
  "transported ZCode artifact contains only its archive and pack manifest",
);
for (const entry of entries) {
  assert.equal(entry.isFile(), true, `transported artifact entry must be a file: ${entry.name}`);
}

const pack = await readJson(path.join(artifactRoot, packName));
assert.equal(pack.schema_version, 1);
assert.equal(pack.version, version);
assert.equal(pack.source_commit, sourceCommit);
assert.equal(pack.filename, archiveName);
assert.match(pack.sha256, /^[0-9a-f]{64}$/);
assert.match(pack.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
assert.match(pack.tree_sha256, /^[0-9a-f]{64}$/);
assert.equal(Number.isSafeInteger(pack.size), true);
assert.ok(pack.size > 0 && pack.size < 50 * 1024 * 1024);

const archivePath = path.join(artifactRoot, archiveName);
const archive = await readFile(archivePath);
assert.equal(archive.length, pack.size);
assert.equal(digest("sha256", archive), pack.sha256);
assert.equal(`sha512-${digest("sha512", archive, "base64")}`, pack.integrity);

const [{ stdout: memberOutput }, { stdout: verboseOutput }] = await Promise.all([
  run("tar", ["-tzf", archivePath]),
  run("tar", ["-tvzf", archivePath]),
]);
const members = memberOutput.split(/\r?\n/).filter(Boolean);
const verboseMembers = verboseOutput.split(/\r?\n/).filter(Boolean);
assert.ok(members.length > 0, "ZCode archive must not be empty");
assert.equal(verboseMembers.length, members.length, "tar member listings must agree");
for (const line of verboseMembers) {
  assert.match(line, /^-/, "ZCode archive may contain regular files only");
}
const seen = new Set();
for (const member of members) {
  assert.equal(member, path.posix.normalize(member), `non-canonical tar path: ${member}`);
  assert.equal(path.posix.isAbsolute(member), false, `absolute tar path: ${member}`);
  assert.equal(member.includes("\\"), false, `backslash tar path: ${member}`);
  assert.equal(member.endsWith("/"), false, `directory tar entry: ${member}`);
  assert.equal(seen.has(member), false, `duplicate tar entry: ${member}`);
  seen.add(member);
  const [topLevel, ...segments] = member.split("/");
  assert.ok(
    ["marketplace.json", "plugins", "release-manifest.json"].includes(topLevel),
    `unexpected tar root: ${member}`,
  );
  assert.equal(segments.includes(".."), false, `parent traversal tar path: ${member}`);
}

await requireMissing(outputRoot);
const stagingRoot = `${outputRoot}.materializing-${process.pid}`;
await rm(stagingRoot, { force: true, recursive: true });
await mkdir(stagingRoot);
try {
  await run("tar", ["-xzf", archivePath, "-C", stagingRoot]);
  await run(process.execPath, [
    path.join(NPM_ROOT, "scripts", "verify-zcode-marketplace.mjs"),
    "--root", stagingRoot,
    "--version", version,
    "--commit", sourceCommit,
    "--require-release-trust",
  ]);
  await rename(stagingRoot, outputRoot);
} finally {
  await rm(stagingRoot, { force: true, recursive: true });
}

console.log(`ZCode marketplace materialized: ${version} ${pack.tree_sha256}`);
