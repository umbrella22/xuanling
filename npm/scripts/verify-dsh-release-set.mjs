import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  parseArgs,
  readJson,
  requiredArg,
  run,
} from "./shared.mjs";

const BUNDLES = Object.freeze([
  "xuanling-dsh-memory",
  "xuanling-dsh-tools",
  "xuanling-dsh-tools-replace",
  "xuanling-dsh-skills",
]);
const TOOL_BUNDLES = new Set(BUNDLES.filter((name) => name !== "xuanling-dsh-skills"));

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
  [...BUNDLES].sort(),
  "DSH release root must contain exactly the four public bundle directories",
);

const canonicalLicense = await readFile(path.join(REPO_ROOT, "LICENSE"));
for (const name of BUNDLES) {
  const directory = path.join(root, name);
  const entries = (await readdir(directory)).sort();
  const manifestName = `${name}.pack.json`;
  assert.ok(entries.includes(manifestName), `${name}: pack manifest`);
  const manifest = await readJson(path.join(directory, manifestName));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.match(manifest.source_commit ?? "", /^[0-9a-f]{40}$/);
  if (sourceCommit !== undefined) assert.equal(manifest.source_commit, sourceCommit);
  assert.deepEqual(entries, [manifest.filename, manifestName].sort(), `${name}: exact release files`);

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
    assert.equal(packageJson.name, name);
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
      `integrations/deepseek-harness/${name.replace("xuanling-dsh-", "xuanling-")}`,
    );
    assert.deepEqual(packageJson.scripts, undefined, `${name}: no lifecycle scripts`);
    assert.equal(
      packageJson.dependencies?.["xuanling-mcp"],
      TOOL_BUNDLES.has(name) ? version : undefined,
      `${name}: exact local runtime dependency matrix`,
    );
    assert.deepEqual(
      await readFile(path.join(packageRoot, "LICENSE")),
      canonicalLicense,
      `${name}: canonical MIT license bytes`,
    );
    assert.deepEqual(
      manifest.files,
      [...packageJson.files, "package.json"].sort(),
      `${name}: manifest allowlist matches package.json`,
    );
  } finally {
    await rm(extracted, { force: true, recursive: true });
  }
}

console.log(`complete DSH release set OK: four bundles at ${version}`);
