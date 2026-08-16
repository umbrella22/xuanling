import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TARGETS } from "../packages/xuanling-mcp/lib/targets.js";
import { parseArgs, requiredArg, run, stableJson } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const mainTarball = path.resolve(requiredArg(args, "main"));
const platformTarball = path.resolve(requiredArg(args, "platform"));
const targetId = requiredArg(args, "target");
const outputDirectory = path.resolve(requiredArg(args, "out"));
const target = TARGETS[targetId];
if (!target) {
  throw new Error(`Unknown XuanLing npm target: ${targetId}`);
}

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "package.json"),
  stableJson({ name: "xuanling-mcp-local-smoke", private: true, version: "0.0.0" }),
);
await run(
  "npm",
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--omit=optional",
    mainTarball,
  ],
  { cwd: outputDirectory },
);

const nativeInstall = path.join(outputDirectory, ".native-install");
await mkdir(nativeInstall, { recursive: true });
await writeFile(
  path.join(nativeInstall, "package.json"),
  stableJson({ name: "xuanling-mcp-native-smoke", private: true, version: "0.0.0" }),
);
await run(
  "npm",
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    platformTarball,
  ],
  { cwd: nativeInstall },
);

const aliasDirectory = path.join(outputDirectory, "node_modules", target.alias);
await rm(aliasDirectory, { force: true, recursive: true });
await cp(
  path.join(nativeInstall, "node_modules", "xuanling-mcp"),
  aliasDirectory,
  { recursive: true },
);
await rm(nativeInstall, { force: true, recursive: true });

console.log(path.join(outputDirectory, "node_modules", "xuanling-mcp", "bin", "xuanling-mcp.js"));

