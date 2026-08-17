import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  PACKAGE_NAME,
  TARGETS,
  expectedOptionalDependencies,
  platformVersion,
} from "../packages/xuanling-mcp/lib/targets.js";
import { parseArgs, readJson, requiredArg, sha256File } from "./shared.mjs";
import { verifyReleaseSignature } from "./release-signature.mjs";

const args = parseArgs(process.argv.slice(2));
if ((args.main === undefined) === (args.platform === undefined)) {
  throw new Error("Pass exactly one of --main <directory> or --platform <directory>");
}

const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepare",
];

if (args.main !== undefined) {
  const directory = path.resolve(requiredArg(args, "main"));
  const packageJson = await readJson(path.join(directory, "package.json"));
  assert.equal(packageJson.name, PACKAGE_NAME);
  assert.equal(packageJson.license, "MIT");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(
    packageJson.optionalDependencies,
    expectedOptionalDependencies(packageJson.version),
  );
  assert.equal(packageJson.bin?.[PACKAGE_NAME], "bin/xuanling-mcp.js");
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.publishConfig?.provenance, true);
  assert.equal(packageJson.repository?.directory, "npm/packages/xuanling-mcp");
  for (const script of forbiddenLifecycleScripts) {
    assert.equal(packageJson.scripts?.[script], undefined, `${script} must not run on install`);
  }
  await stat(path.join(directory, "bin", "xuanling-mcp.js"));
  await stat(path.join(directory, "lib", "launcher.js"));
  await stat(path.join(directory, "lib", "targets.js"));
  await stat(path.join(directory, "LICENSE"));
  await stat(path.join(directory, "README.md"));
  await stat(path.join(directory, "README-ZH.md"));
  console.log(`main npm package OK: ${packageJson.name}@${packageJson.version}`);
} else {
  const directory = path.resolve(requiredArg(args, "platform"));
  const targetId = requiredArg(args, "target");
  const releaseVersion = requiredArg(args, "version");
  const target = TARGETS[targetId];
  if (!target) {
    throw new Error(`Unknown XuanLing npm target: ${targetId}`);
  }
  const packageJson = await readJson(path.join(directory, "package.json"));
  assert.equal(packageJson.name, PACKAGE_NAME);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.version, platformVersion(releaseVersion, targetId));
  assert.deepEqual(packageJson.os, [target.os]);
  assert.deepEqual(packageJson.cpu, [target.cpu]);
  assert.deepEqual(packageJson.libc, target.libc ? [target.libc] : undefined);
  assert.equal(packageJson.xuanlingBinary?.target, target.rustTarget);
  assert.equal(packageJson.xuanlingBinary?.binary, target.binary);
  assert.match(packageJson.xuanlingBinary?.sourceCommit ?? "", /^[0-9a-f]{40}$/);
  assert.match(packageJson.xuanlingBinary?.sha256 ?? "", /^[0-9a-f]{64}$/);
  if (args["require-release-signature"] === true) {
    verifyReleaseSignature(packageJson.xuanlingBinary?.signature, targetId);
  }
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.optionalDependencies, undefined);
  assert.equal(packageJson.bin, undefined);
  for (const script of forbiddenLifecycleScripts) {
    assert.equal(packageJson.scripts?.[script], undefined, `${script} must not run on install`);
  }
  const binaryPath = path.join(directory, target.binary);
  assert.equal(await sha256File(binaryPath), packageJson.xuanlingBinary.sha256);
  await stat(path.join(directory, "LICENSE"));
  assert.ok((await stat(path.join(directory, "THIRD_PARTY_LICENSES.txt"))).size > 0);
  if (target.os !== "win32") {
    assert.notEqual((await stat(binaryPath)).mode & 0o111, 0, "native binary must be executable");
  }
  console.log(`platform npm package OK: ${packageJson.name}@${packageJson.version}`);
}
