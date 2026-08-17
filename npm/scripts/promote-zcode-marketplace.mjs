import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  PROJECTION_ENTRIES,
  compareSemver,
  describeProjection,
} from "./zcode-promotion-lib.mjs";
import { parseArgs, requiredArg } from "./shared.mjs";

function required(args, name) {
  return requiredArg(args, name);
}

const args = parseArgs(process.argv.slice(2));
const incoming = path.resolve(required(args, "incoming"));
const target = path.resolve(required(args, "target"));
const version = required(args, "version");
const sourceCommit = required(args, "source-commit");
const expectedTree = required(args, "tree-sha256");
const mode = args.mode ?? "promote";
if (!new Set(["promote", "compare-only"]).has(mode)) throw new Error(`Invalid mode: ${mode}`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`Invalid source commit: ${sourceCommit}`);
if (!/^[0-9a-f]{64}$/.test(expectedTree)) throw new Error(`Invalid tree SHA-256: ${expectedTree}`);
compareSemver(version, version);

const incomingManifest = JSON.parse(await readFile(path.join(incoming, "release-manifest.json"), "utf8"));
if (incomingManifest.version !== version || incomingManifest.source_commit !== sourceCommit) {
  throw new Error("Incoming release manifest does not match the promotion identity");
}
const incomingTree = await describeProjection(incoming, { strictRoot: true });
if (incomingTree.sha256 !== expectedTree) {
  throw new Error(`Incoming tree ${incomingTree.sha256} does not match ${expectedTree}`);
}

if (mode === "compare-only") {
  const targetTree = await describeProjection(target);
  if (targetTree.sha256 !== expectedTree) {
    throw new Error(`Existing immutable tag tree ${targetTree.sha256} does not match ${expectedTree}`);
  }
  console.log(`existing immutable projection matches ${version} ${expectedTree}`);
  process.exit(0);
}

let currentManifest;
try {
  currentManifest = JSON.parse(await readFile(path.join(target, "release-manifest.json"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (currentManifest) {
  const order = compareSemver(currentManifest.version, version);
  if (order > 0) {
    throw new Error(`Refusing stale promotion ${version}; main already contains ${currentManifest.version}`);
  }
  if (order === 0) {
    const currentTree = await describeProjection(target);
    if (currentTree.sha256 !== expectedTree) {
      throw new Error(`Version ${version} already exists on main with a different tree`);
    }
    console.log(`main already contains ${version} ${expectedTree}`);
    process.exit(0);
  }
}

await mkdir(target, { recursive: true });
for (const entry of PROJECTION_ENTRIES) {
  const destination = path.join(target, entry);
  await rm(destination, { force: true, recursive: true });
  await cp(path.join(incoming, entry), destination, { recursive: true });
}
const promoted = await describeProjection(target);
if (promoted.sha256 !== expectedTree) {
  throw new Error(`Promoted tree ${promoted.sha256} does not match ${expectedTree}`);
}
console.log(`promoted ${version} ${expectedTree}`);
