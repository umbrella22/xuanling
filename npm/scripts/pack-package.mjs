import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { TARGETS } from "../packages/xuanling-mcp/lib/targets.js";
import { parseArgs, requiredArg, run, stableJson } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const packageDirectory = path.resolve(requiredArg(args, "package"));
const outputDirectory = path.resolve(requiredArg(args, "out"));
const label = requiredArg(args, "label");
const kind = requiredArg(args, "kind");
if (!/^[a-z0-9-]+$/.test(label)) {
  throw new Error(`Invalid pack label: ${label}`);
}
if (!new Set(["main", "platform"]).has(kind)) {
  throw new Error(`Invalid package kind: ${kind}`);
}
if (kind === "main" && label !== "main") {
  throw new Error(`Main package label must be main, received ${label}`);
}
const platformTarget = kind === "platform" ? TARGETS[label] : undefined;
if (kind === "platform" && !platformTarget) {
  throw new Error(`Platform package label must identify a supported target: ${label}`);
}

await mkdir(outputDirectory, { recursive: true });
const { stdout } = await run(
  "npm",
  ["pack", "--json", "--pack-destination", outputDirectory],
  { cwd: packageDirectory },
);
const results = JSON.parse(stdout);
if (!Array.isArray(results) || results.length !== 1) {
  throw new Error(`npm pack returned ${results.length} results`);
}
const result = results[0];
const paths = result.files.map((file) => file.path).sort();
const expectedPaths =
  kind === "main"
    ? [
        "LICENSE-APACHE",
        "LICENSE-MIT",
        "README-ZH.md",
        "README.md",
        "bin/xuanling-mcp.js",
        "lib/launcher.js",
        "lib/targets.js",
        "package.json",
      ]
    : [
        "LICENSE-APACHE",
        "LICENSE-MIT",
        "THIRD_PARTY_LICENSES.txt",
        platformTarget.binary,
        "package.json",
      ];
if (JSON.stringify(paths) !== JSON.stringify(expectedPaths.sort())) {
  throw new Error(
    `Unexpected ${kind} tarball contents:\n${paths.map((entry) => `- ${entry}`).join("\n")}`,
  );
}
const maxUnpackedBytes = kind === "main" ? 256 * 1024 : 64 * 1024 * 1024;
if (result.unpackedSize > maxUnpackedBytes) {
  throw new Error(
    `${kind} tarball unpacked size ${result.unpackedSize} exceeds release guard ${maxUnpackedBytes}`,
  );
}
const manifest = {
  filename: result.filename,
  integrity: result.integrity,
  files: paths,
  name: result.name,
  shasum: result.shasum,
  size: result.size,
  unpackedSize: result.unpackedSize,
  version: result.version,
};
await writeFile(path.join(outputDirectory, `${label}.pack.json`), stableJson(manifest));
console.log(path.join(outputDirectory, result.filename));
