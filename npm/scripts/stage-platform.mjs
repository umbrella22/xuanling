import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TARGETS, platformVersion } from "../packages/xuanling-mcp/lib/targets.js";
import { releaseTrustFromArgs } from "./release-signature.mjs";
import {
  MAIN_PACKAGE_DIR,
  currentCommit,
  parseArgs,
  readJson,
  requiredArg,
  sha256File,
  stableJson,
} from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const targetId = requiredArg(args, "target");
const binarySource = path.resolve(requiredArg(args, "binary"));
const outputDirectory = path.resolve(requiredArg(args, "out"));
const noticesSource = path.resolve(requiredArg(args, "notices"));
const sourceCommit =
  args.commit === undefined ? await currentCommit() : requiredArg(args, "commit");
const target = TARGETS[targetId];
if (!target) {
  throw new Error(`Unknown XuanLing npm target: ${targetId}`);
}
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Invalid source commit: ${sourceCommit}`);
}

const mainPackage = await readJson(path.join(MAIN_PACKAGE_DIR, "package.json"));
const releaseVersion = mainPackage.version;
const binarySha256 = await sha256File(binarySource);
const releaseTrust = releaseTrustFromArgs(args, targetId);

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(path.join(outputDirectory, "bin"), { recursive: true });

const binaryDestination = path.join(outputDirectory, target.binary);
await copyFile(binarySource, binaryDestination);
if (target.os !== "win32") {
  await chmod(binaryDestination, 0o755);
}
await copyFile(path.join(MAIN_PACKAGE_DIR, "LICENSE"), path.join(outputDirectory, "LICENSE"));
await copyFile(noticesSource, path.join(outputDirectory, "THIRD_PARTY_LICENSES.txt"));

const packageJson = {
  name: target.packageName,
  version: platformVersion(releaseVersion, targetId),
  description: `Native XuanLing MCP binary for ${target.rustTarget}.`,
  license: "MIT",
  author: "umbrella22 and XuanLing contributors",
  os: [target.os],
  cpu: [target.cpu],
  files: [
    "bin",
    "LICENSE",
    "THIRD_PARTY_LICENSES.txt",
  ],
  homepage: mainPackage.homepage,
  bugs: mainPackage.bugs,
  repository: mainPackage.repository,
  ...(target.libc ? { libc: [target.libc] } : {}),
  publishConfig: mainPackage.publishConfig,
  xuanlingBinary: {
    binary: target.binary,
    sha256: binarySha256,
    sourceCommit,
    target: target.rustTarget,
    releaseTrust,
  },
};
await writeFile(path.join(outputDirectory, "package.json"), stableJson(packageJson));

console.log(outputDirectory);
