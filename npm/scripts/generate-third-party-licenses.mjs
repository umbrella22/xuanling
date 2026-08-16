import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT, parseArgs, requiredArg, run } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const target = requiredArg(args, "target");
const output = path.resolve(requiredArg(args, "output"));

const { stdout: treeOutput } = await run("cargo", [
  "tree",
  "--locked",
  "-p",
  "xuanling-mcp",
  "--target",
  target,
  "-e",
  "normal",
  "--prefix",
  "none",
  "--format",
  "{p}",
]);

// `cargo metadata --filter-platform` still contains workspace and optional
// dependency nodes that are not in the selected binary's normal graph. Cargo
// tree is the source of truth for the package set shipped by this target.
const dependencyKeys = new Set();
for (const line of treeOutput.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) {
    continue;
  }
  const match = trimmed.match(/^(\S+)\s+v(\d[^\s(]*)/);
  if (!match) {
    throw new Error(`Unable to parse cargo tree package line: ${trimmed}`);
  }
  dependencyKeys.add(`${match[1]}@${match[2]}`);
}

const { stdout } = await run("cargo", [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--filter-platform",
  target,
]);
const metadata = JSON.parse(stdout);
const packagesByKey = new Map();
for (const pkg of metadata.packages) {
  const key = `${pkg.name}@${pkg.version}`;
  const candidates = packagesByKey.get(key) ?? [];
  candidates.push(pkg);
  packagesByKey.set(key, candidates);
}

const thirdPartyPackages = [...dependencyKeys]
  .map((key) => {
    const candidates = packagesByKey.get(key) ?? [];
    if (candidates.length !== 1) {
      throw new Error(
        `cargo metadata has ${candidates.length} candidates for cargo tree package ${key}`,
      );
    }
    return candidates[0];
  })
  .filter((pkg) => pkg.source !== null)
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );

const sections = [
  "XuanLing MCP third-party software notices",
  `Rust target: ${target}`,
  "",
  "Generated from the target's Cargo normal dependency tree and Cargo metadata.",
  "License texts are copied from exact Cargo package sources when present and are de-duplicated by SHA-256.",
  "Packages with SPDX metadata but no archive text are listed with metadata only; canonical MIT/Apache texts ship as LICENSE-MIT and LICENSE-APACHE.",
];

const textByHash = new Map();
for (const pkg of thirdPartyPackages) {
  if (!pkg.license && !pkg.license_file) {
    throw new Error(`${pkg.name}@${pkg.version} has no Cargo license metadata`);
  }
  const packageDirectory = path.dirname(pkg.manifest_path);
  const directoryEntries = await readdir(packageDirectory);
  const licensePaths = directoryEntries
    .filter((name) => /^(LICENSE|LICENCE|COPYING|NOTICE)([-._].*)?$/i.test(name))
    .map((name) => path.join(packageDirectory, name));
  if (pkg.license_file) {
    const declaredPath = path.resolve(packageDirectory, pkg.license_file);
    const packagePrefix = `${packageDirectory}${path.sep}`;
    if (declaredPath.startsWith(packagePrefix)) {
      licensePaths.push(declaredPath);
    }
  }

  const texts = [];
  for (const filePath of [...new Set(licensePaths)].sort()) {
    try {
      if ((await stat(filePath)).isFile()) {
        const content = await readFile(filePath, "utf8");
        const hash = createHash("sha256").update(content).digest("hex");
        texts.push({
          content,
          fileName: path.relative(packageDirectory, filePath),
          hash,
        });
      }
    } catch {
      // A registry archive can omit a license_file named by metadata.
    }
  }

  sections.push(
    "",
    "================================================================================",
    `${pkg.name} ${pkg.version}`,
    `SPDX license: ${pkg.license ?? "see license file"}`,
    `Source: ${pkg.repository ?? pkg.source}`,
  );
  if (texts.length === 0) {
    sections.push(
      "",
      "No distributable license file was present in the Cargo archive; SPDX metadata above is authoritative.",
    );
    continue;
  }
  for (const { content, fileName, hash } of texts) {
    sections.push("", `License file: ${fileName}`, `License SHA-256: ${hash}`);
    if (textByHash.has(hash)) {
      sections.push(`License text: duplicate of ${textByHash.get(hash)}`);
      continue;
    }
    textByHash.set(hash, `${pkg.name}@${pkg.version} ${fileName}`);
    sections.push(`--- ${fileName} ---`, content.trimEnd());
  }
}

await writeFile(output, `${sections.join("\n")}\n`);
console.log(
  `wrote ${thirdPartyPackages.length} third-party notices to ${path.relative(REPO_ROOT, output)}`,
);
