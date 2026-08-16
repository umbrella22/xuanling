import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MAIN_PACKAGE_DIR,
  currentCommit,
  parseArgs,
  readJson,
  requiredArg,
  stableJson,
} from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const outputDirectory = path.resolve(requiredArg(args, "out"));
const sourceCommit =
  args.commit === undefined ? await currentCommit() : requiredArg(args, "commit");

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Invalid source commit: ${sourceCommit}`);
}

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(path.dirname(outputDirectory), { recursive: true });
await cp(MAIN_PACKAGE_DIR, outputDirectory, { recursive: true });

const packageJsonPath = path.join(outputDirectory, "package.json");
const packageJson = await readJson(packageJsonPath);
packageJson.xuanlingRelease = { sourceCommit };
await writeFile(packageJsonPath, stableJson(packageJson));

console.log(outputDirectory);
