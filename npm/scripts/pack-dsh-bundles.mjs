import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DSH_BUNDLES } from "../packages/xuanling-mcp/lib/targets.js";
import {
  REPO_ROOT,
  currentCommit,
  parseArgs,
  readJson,
  requiredArg,
  run,
  stableJson,
} from "./shared.mjs";

const sourceDirectories = Object.freeze({
  "xuanling-dsh-memory": "xuanling-memory",
  "xuanling-dsh-tools": "xuanling-tools",
  "xuanling-dsh-tools-replace": "xuanling-tools-replace",
  "xuanling-dsh-skills": "xuanling-skills",
});

const args = parseArgs(process.argv.slice(2));
const outputRoot = path.resolve(requiredArg(args, "out"));
const sourceCommit = args.commit === undefined ? await currentCommit() : requiredArg(args, "commit");
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Invalid DSH source commit: ${sourceCommit}`);
}
const integrationRoot = path.join(REPO_ROOT, "integrations", "deepseek-harness");

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });

for (const { id, packageName } of DSH_BUNDLES) {
  const packageRoot = path.join(integrationRoot, sourceDirectories[id]);
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  if (packageJson.name !== packageName) {
    throw new Error(`${packageRoot} declares ${packageJson.name}, expected ${packageName}`);
  }
  for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
    if (packageJson.scripts?.[script] !== undefined) {
      throw new Error(`${packageName} must not declare lifecycle script ${script}`);
    }
  }

  const destination = path.join(outputRoot, id);
  await mkdir(destination, { recursive: true });
  const stagingParent = await mkdtemp(path.join(os.tmpdir(), "xuanling-dsh-package-"));
  const stagingRoot = path.join(stagingParent, "package");
  let stdout;
  try {
    await cp(packageRoot, stagingRoot, { recursive: true });
    const stagedPackageJson = await readJson(path.join(stagingRoot, "package.json"));
    stagedPackageJson.xuanlingRelease = { sourceCommit };
    await writeFile(path.join(stagingRoot, "package.json"), stableJson(stagedPackageJson));
    ({ stdout } = await run(
      "npm",
      ["pack", "--json", "--pack-destination", destination],
      { cwd: stagingRoot },
    ));
  } finally {
    await rm(stagingParent, { force: true, recursive: true });
  }
  const results = JSON.parse(stdout);
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(`npm pack returned ${results.length} results for ${packageName}`);
  }
  const result = results[0];
  const files = result.files.map((file) => file.path).sort();
  const expected = [...packageJson.files, "package.json"].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected ${packageName} tarball contents:\n${files.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  if (result.unpackedSize > 512 * 1024) {
    throw new Error(`${packageName} unpacked size ${result.unpackedSize} exceeds 512 KiB`);
  }
  const manifest = {
    filename: result.filename,
    files,
    integrity: result.integrity,
    name: result.name,
    shasum: result.shasum,
    size: result.size,
    source_commit: sourceCommit,
    unpackedSize: result.unpackedSize,
    version: result.version,
  };
  await writeFile(path.join(destination, `${id}.pack.json`), stableJson(manifest));

  // Force an immediate read so a failed filesystem write cannot leave a
  // seemingly complete release directory.
  await readFile(path.join(destination, result.filename));
  console.log(`${packageName}: ${path.join(destination, result.filename)}`);
}
