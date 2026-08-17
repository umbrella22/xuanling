import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DSH_BUNDLES } from "../packages/xuanling-mcp/lib/targets.js";
import {
  REPO_ROOT,
  parseArgs,
  readJson,
  requiredArg,
  run,
} from "./shared.mjs";

const BUNDLES = DSH_BUNDLES;
const TOOL_BUNDLES = new Set(BUNDLES.filter(({ id }) => id !== "xuanling-dsh-skills").map(({ id }) => id));

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(requiredArg(args, "root"));
const version = requiredArg(args, "version");
const sourceCommit = args.commit;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid DSH release version: ${version}`);
}
if (sourceCommit !== undefined && !/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Invalid DSH source commit: ${sourceCommit}`);
}

assert.deepEqual(
  (await readdir(root)).sort(),
  BUNDLES.map(({ id }) => id).sort(),
  "DSH release root must contain exactly the four public bundle directories",
);

const canonicalLicense = await readFile(path.join(REPO_ROOT, "LICENSE"));
for (const { id, packageName } of BUNDLES) {
  const directory = path.join(root, id);
  const entries = (await readdir(directory)).sort();
  const manifestName = `${id}.pack.json`;
  assert.ok(entries.includes(manifestName), `${packageName}: pack manifest`);
  const manifest = await readJson(path.join(directory, manifestName));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, version);
  assert.match(manifest.source_commit ?? "", /^[0-9a-f]{40}$/);
  if (sourceCommit !== undefined) assert.equal(manifest.source_commit, sourceCommit);
  assert.deepEqual(entries, [manifest.filename, manifestName].sort(), `${packageName}: exact release files`);

  const tarballPath = path.join(directory, manifest.filename);
  const tarball = await readFile(tarballPath);
  assert.equal(createHash("sha1").update(tarball).digest("hex"), manifest.shasum);
  assert.equal(
    `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    manifest.integrity,
  );

  const extracted = await mkdtemp(path.join(os.tmpdir(), "xuanling-dsh-release-"));
  try {
    await run("tar", ["-xzf", tarballPath, "-C", extracted]);
    const packageRoot = path.join(extracted, "package");
    const packageJson = await readJson(path.join(packageRoot, "package.json"));
    assert.equal(packageJson.name, packageName);
    assert.equal(packageJson.version, version);
    assert.equal(packageJson.xuanlingRelease?.sourceCommit, manifest.source_commit);
    assert.equal(packageJson.private, false);
    assert.equal(packageJson.license, "MIT");
    assert.equal(packageJson.dsh?.bundle?.patch, "./cordis.patch.yml");
    assert.equal(packageJson.publishConfig?.access, "public");
    assert.equal(packageJson.publishConfig?.provenance, true);
    assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org");
    assert.equal(
      packageJson.repository?.directory,
      `integrations/deepseek-harness/${id.replace("xuanling-dsh-", "xuanling-")}`,
    );
    assert.deepEqual(packageJson.scripts, undefined, `${packageName}: no lifecycle scripts`);
    assert.equal(
      packageJson.dependencies?.["@xuanling-rs/xuanling-mcp"],
      TOOL_BUNDLES.has(id) ? version : undefined,
      `${packageName}: exact local runtime dependency matrix`,
    );
    assert.deepEqual(
      await readFile(path.join(packageRoot, "LICENSE")),
      canonicalLicense,
      `${packageName}: canonical MIT license bytes`,
    );
    assert.deepEqual(
      manifest.files,
      [...packageJson.files, "package.json"].sort(),
      `${packageName}: manifest allowlist matches package.json`,
    );
  } finally {
    await rm(extracted, { force: true, recursive: true });
  }
}

console.log(`complete DSH release set OK: four bundles at ${version}`);
