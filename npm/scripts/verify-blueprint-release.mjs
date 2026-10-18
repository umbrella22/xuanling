import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseArgs, readJson, requiredArg, run } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(requiredArg(args, "root"));
const version = requiredArg(args, "version");
const sourceCommit = requiredArg(args, "commit");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Blueprint release version: ${version}`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`Invalid Blueprint source commit: ${sourceCommit}`);

const entries = (await readdir(root)).sort();
const manifest = await readJson(path.join(root, "blueprint.pack.json"));
assert.equal(manifest.name, "@xuanling-rs/xuanling-dsh-blueprint");
assert.equal(manifest.version, version);
assert.equal(manifest.source_commit, sourceCommit);
assert.equal(manifest.filename, `xuanling-rs-xuanling-dsh-blueprint-${version}.tgz`);
assert.deepEqual(entries, [manifest.filename, "blueprint.pack.json"].sort(), "Blueprint release must contain only its tarball and receipt");

const tarballPath = path.join(root, manifest.filename);
const tarball = await readFile(tarballPath);
assert.equal(createHash("sha1").update(tarball).digest("hex"), manifest.shasum);
assert.equal(`sha512-${createHash("sha512").update(tarball).digest("base64")}`, manifest.integrity);
assert.equal(createHash("sha256").update(tarball).digest("hex"), manifest.sha256);

const extracted = await mkdtemp(path.join(os.tmpdir(), "xuanling-blueprint-release-"));
try {
  await run("tar", ["-xzf", tarballPath, "-C", extracted]);
  const packageRoot = path.join(extracted, "package");
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  assert.equal(packageJson.name, manifest.name);
  assert.equal(packageJson.version, version);
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.xuanlingRelease?.sourceCommit, sourceCommit);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.publishConfig?.provenance, true);
  assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org");
  assert.deepEqual(packageJson.scripts, {
    build: "vp pack",
    format: "vp fmt src test vite.config.ts package.json '!src/host/dsh-structured-compat.ts'",
    "format:check": "vp fmt src test vite.config.ts package.json '!src/host/dsh-structured-compat.ts' --check",
    typecheck: "tsc --noEmit -p tsconfig.json",
    lint: "vp lint",
    test: "node --experimental-transform-types --import ./scripts/test-tsx-register.mjs --test --test-concurrency=1 \"test/**/*.test.mjs\"",
    verify: "node scripts/verify.mjs",
  });
  assert.equal(manifest.distribution, "GitHub Release asset and npm registry");
  assert.equal(manifest.lifecycle_scripts, false);
  const metadata = ["LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "README-ZH.md", "cordis.patch.yml"];
  const assetPattern = "assets/readme/**/*.png";
  assert.deepEqual(
    packageJson.files,
    [...metadata.slice(0, 4), assetPattern, metadata[4], "lib/**/*.js"],
    "Blueprint package must retain its declared npm file globs",
  );
  const assets = (await readdir(path.join(packageRoot, "assets", "readme"), { withFileTypes: true }))
    .map((file) => {
      assert.ok(file.isFile() && file.name.endsWith(".png"), `unexpected Blueprint asset: ${file.name}`);
      return `assets/readme/${file.name}`;
    })
    .sort();
  const libraries = (await readdir(path.join(packageRoot, "lib"), { withFileTypes: true }))
    .map((file) => {
      assert.ok(file.isFile() && file.name.endsWith(".js"), `unexpected Blueprint lib entry: ${file.name}`);
      return `lib/${file.name}`;
    })
    .sort();
  assert.ok(libraries.length > 0, "Blueprint release must contain built lib files");
  assert.deepEqual(
    manifest.files,
    [...metadata, ...assets, ...libraries, "package.json"].sort(),
    "Blueprint receipt must list the expanded tarball file inventory",
  );
} finally {
  await rm(extracted, { recursive: true, force: true });
}

console.log(`complete Blueprint release item OK: ${manifest.name}@${version} from ${sourceCommit}`);
