import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TARGETS,
  expectedOptionalDependencies,
  platformVersion,
} from "../packages/xuanling-mcp/lib/targets.js";
import { parseArgs, readJson, requiredArg, run, sha256File } from "./shared.mjs";
import { verifyReleaseSignature } from "./release-signature.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(requiredArg(args, "root"));
const version = requiredArg(args, "version");
const commit = requiredArg(args, "commit");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid release version: ${version}`);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`Invalid release commit: ${commit}`);
}

const expectedArtifactDirectories = [
  "npm-main",
  ...Object.keys(TARGETS).map((targetId) => `npm-${targetId}`),
].sort();
const actualArtifactDirectories = (await readdir(root)).sort();
assert.deepEqual(
  actualArtifactDirectories,
  expectedArtifactDirectories,
  "release must contain exactly one launcher and every supported native package",
);

async function verifyTarball(manifestPath, expectedVersion) {
  const manifest = await readJson(manifestPath);
  assert.equal(manifest.name, "xuanling-mcp");
  assert.equal(manifest.version, expectedVersion);
  const tarballPath = path.join(path.dirname(manifestPath), manifest.filename);
  const tarball = await readFile(tarballPath);
  const sha1 = createHash("sha1").update(tarball).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  assert.equal(sha1, manifest.shasum, `${manifest.filename} sha1 mismatch`);
  assert.equal(integrity, manifest.integrity, `${manifest.filename} integrity mismatch`);

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "xuanling-release-set-"));
  try {
    await run("tar", ["-xzf", tarballPath, "-C", extractionRoot]);
    return {
      directory: path.join(extractionRoot, "package"),
      dispose: () => rm(extractionRoot, { force: true, recursive: true }),
      packageJson: await readJson(path.join(extractionRoot, "package", "package.json")),
    };
  } catch (error) {
    await rm(extractionRoot, { force: true, recursive: true });
    throw error;
  }
}

const mainManifest = path.join(root, "npm-main", "main.pack.json");
const main = await verifyTarball(mainManifest, version);
try {
  assert.equal(main.packageJson.xuanlingRelease?.sourceCommit, commit);
  assert.deepEqual(
    main.packageJson.optionalDependencies,
    expectedOptionalDependencies(version),
  );
} finally {
  await main.dispose();
}

for (const [targetId, target] of Object.entries(TARGETS)) {
  const manifestPath = path.join(
    root,
    `npm-${targetId}`,
    `${targetId}.pack.json`,
  );
  const platformPackage = await verifyTarball(
    manifestPath,
    platformVersion(version, targetId),
  );
  try {
    assert.equal(platformPackage.packageJson.xuanlingBinary?.sourceCommit, commit);
    assert.equal(platformPackage.packageJson.xuanlingBinary?.target, target.rustTarget);
    assert.equal(platformPackage.packageJson.xuanlingBinary?.binary, target.binary);
    assert.equal(
      await sha256File(path.join(platformPackage.directory, target.binary)),
      platformPackage.packageJson.xuanlingBinary?.sha256,
    );
    if (args["require-release-signatures"] === true) {
      verifyReleaseSignature(platformPackage.packageJson.xuanlingBinary?.signature, targetId);
    }
  } finally {
    await platformPackage.dispose();
  }
}

console.log(`complete npm release set OK: xuanling-mcp@${version} from ${commit}`);
