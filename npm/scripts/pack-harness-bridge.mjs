import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TARGETS, platformVersion } from "../packages/harness-bridge/lib/targets.js";
import {
  NPM_ROOT,
  currentCommit,
  parseArgs,
  readJson,
  requiredArg,
  run,
  sha256File,
  stableJson,
} from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const outputDirectory = path.resolve(requiredArg(args, "out"));
const sourceCommit = args.commit ?? await currentCommit();
assert.match(sourceCommit, /^[0-9a-f]{40}$/);
const sourceDirectory = path.join(NPM_ROOT, "packages", "harness-bridge");
const launcher = await readJson(path.join(sourceDirectory, "package.json"));
const target = args.target === undefined ? undefined : TARGETS[requiredArg(args, "target")];
if (args.target !== undefined && !target) {
  throw new Error(`Unsupported bridge target: ${args.target}`);
}
const label = target?.id ?? "main";
const staging = path.join(outputDirectory, "package");
const packDirectory = path.join(outputDirectory, "pack");
const binary = target ? path.resolve(requiredArg(args, "binary")) : undefined;
const notices = target ? path.resolve(requiredArg(args, "notices")) : undefined;
await rm(staging, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
let expectedFiles;
if (target) {
  await mkdir(path.join(staging, "bin"), { recursive: true });
  await copyFile(binary, path.join(staging, target.binary));
  if (target.os !== "win32") await chmod(path.join(staging, target.binary), 0o755);
  await copyFile(path.join(sourceDirectory, "LICENSE"), path.join(staging, "LICENSE"));
  await copyFile(notices, path.join(staging, "THIRD_PARTY_LICENSES.txt"));
  const manifest = {
    name: target.packageName,
    version: platformVersion(launcher.version, target.id),
    description: `Native XuanLing Harness Bridge for ${target.rustTarget}.`,
    license: launcher.license,
    author: launcher.author,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ["bin", "LICENSE", "THIRD_PARTY_LICENSES.txt"],
    homepage: launcher.homepage,
    bugs: launcher.bugs,
    repository: launcher.repository,
    publishConfig: launcher.publishConfig,
    harnessBridgeBinary: {
      binary: target.binary,
      sha256: await sha256File(binary),
      sourceCommit,
      target: target.rustTarget,
    },
  };
  await writeFile(path.join(staging, "package.json"), stableJson(manifest));
  expectedFiles = [target.binary, "LICENSE", "THIRD_PARTY_LICENSES.txt", "package.json"];
} else {
  await cp(sourceDirectory, staging, { recursive: true });
  launcher.xuanlingRelease = { sourceCommit };
  await writeFile(path.join(staging, "package.json"), stableJson(launcher));
  expectedFiles = ["bin/harness-bridge.js", "lib/launcher.js", "lib/targets.js", "LICENSE", "README.md", "README-ZH.md", "package.json"];
}
const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], { cwd: staging });
const packed = JSON.parse(stdout);
assert.equal(packed.length, 1);
const result = packed[0];
const files = result.files.map((file) => file.path).sort();
assert.deepEqual(files, expectedFiles.sort(), "unexpected bridge tarball contents");
assert.ok(result.unpackedSize < (target ? 64 * 1024 * 1024 : 256 * 1024));
const manifest = {
  filename: result.filename,
  name: result.name,
  version: result.version,
  integrity: result.integrity,
  shasum: result.shasum,
  size: result.size,
  unpackedSize: result.unpackedSize,
  sourceCommit,
  files,
};
await writeFile(path.join(packDirectory, `${label}.pack.json`), stableJson(manifest));
console.log(path.join(packDirectory, result.filename));
