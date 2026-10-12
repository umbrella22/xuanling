import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, currentCommit, parseArgs, readJson, readWorkspaceVersion, requiredArg, run, stableJson } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(requiredArg(args, "out"));
const commit = args.commit ?? await currentCommit();
assert.match(commit, /^[0-9a-f]{40}$/);
const root = path.join(REPO_ROOT, "integrations/deepseek-harness/xuanling-blueprint");
const manifest = await readJson(path.join(root, "package.json"));
assert.equal(manifest.version, await readWorkspaceVersion());
assert.equal(manifest.name, "@xuanling-rs/xuanling-dsh-blueprint");
for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare", "prepack", "postpack"])
  assert.equal(manifest.scripts?.[script], undefined, `release forbids lifecycle script ${script}`);
const metadata = ["LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "README-ZH.md", "cordis.patch.yml"];
assert.deepEqual(manifest.files, [...metadata, "lib/**/*.js"]);
const libraries = (await readdir(path.join(root, "lib"), { withFileTypes: true }))
  .map((file) => { assert.ok(file.isFile() && file.name.endsWith(".js")); return `lib/${file.name}`; }).sort();
assert.ok(libraries.length > 0, "build the Blueprint plugin before packing");
const files = [...metadata, ...libraries, "package.json"].sort();
await mkdir(output, { recursive: true });
const staging = await mkdtemp(path.join(os.tmpdir(), "xuanling-blueprint-release-"));
try {
  for (const file of [...metadata, ...libraries]) {
    await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
    await cp(path.join(root, file), path.join(staging, file), { dereference: false });
  }
  await writeFile(path.join(staging, "package.json"), stableJson({ ...manifest, xuanlingRelease: { sourceCommit: commit } }));
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: staging });
  const [packed] = JSON.parse(stdout);
  assert.deepEqual(packed.files.map((file) => file.path).sort(), files);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const inventory = [];
  for (const file of files) inventory.push({ path: file, sha256: digest(await readFile(path.join(staging, file))) });
  const receipt = {
    name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity,
    shasum: packed.shasum, size: packed.size, unpackedSize: packed.unpackedSize, source_commit: commit,
    sha256: digest(await readFile(path.join(output, packed.filename))), files, file_inventory: inventory,
    distribution: "GitHub Release asset and npm registry", lifecycle_scripts: false,
  };
  await writeFile(path.join(output, "blueprint.pack.json"), stableJson(receipt), { flag: "wx" });
  console.log(stableJson({ filename: packed.filename, version: packed.version, files: files.length, sha256: receipt.sha256 }).trim());
} finally {
  await rm(staging, { recursive: true, force: true });
}
