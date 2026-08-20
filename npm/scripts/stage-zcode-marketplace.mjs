import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { PACKAGE_NAME, TARGETS } from "../packages/xuanling-mcp/lib/targets.js";
import {
  NPM_ROOT,
  REPO_ROOT,
  parseArgs,
  readJson,
  requiredArg,
  run,
  stableJson,
} from "./shared.mjs";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(`ZCode tree cannot contain links or special files: ${child}`);
    }
  }
  return files;
}

async function describeTree(root, excluded = new Set()) {
  const files = [];
  for (const relative of await walkFiles(root)) {
    if (excluded.has(relative)) continue;
    const absolute = path.join(root, ...relative.split("/"));
    const info = await stat(absolute);
    const data = await readFile(absolute);
    files.push({
      mode: info.mode & 0o111 ? "0755" : "0644",
      path: relative,
      sha256: sha256(data),
      size: data.length,
    });
  }
  return {
    files,
    sha256: sha256(Buffer.from(files.map((file) =>
      `${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\n`).join(""))),
  };
}

function writeString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`USTAR field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error(`USTAR number is too large: ${value}`);
  writeString(buffer, offset, length - 1, encoded);
  buffer[offset + length - 1] = 0;
}

function splitTarPath(relative) {
  if (Buffer.byteLength(relative) <= 100) return { name: relative, prefix: "" };
  const separators = [...relative.matchAll(/\//g)].map((match) => match.index);
  for (const separator of separators.reverse()) {
    const prefix = relative.slice(0, separator);
    const name = relative.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path cannot be represented in USTAR: ${relative}`);
}

function tarEntry(relative, data, mode) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(relative);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

async function createDeterministicArchive(root) {
  const chunks = [];
  for (const relative of await walkFiles(root)) {
    const absolute = path.join(root, ...relative.split("/"));
    const info = await stat(absolute);
    const data = await readFile(absolute);
    chunks.push(tarEntry(relative, data, info.mode & 0o111 ? 0o755 : 0o644));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  // Node inherits the gzip OS marker from the host (for example, macOS and
  // Linux emit different bytes). Canonicalize it so the release archive is
  // byte-identical across CI and local platforms.
  archive[9] = 0xff;
  return archive;
}

async function extractPackage(releaseRoot, artifactDirectory, manifestName, destination) {
  const manifestPath = path.join(releaseRoot, artifactDirectory, manifestName);
  const manifest = await readJson(manifestPath);
  const tarball = path.join(path.dirname(manifestPath), manifest.filename);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-zcode-package-"));
  try {
    await run("tar", ["-xzf", tarball, "-C", temporary]);
    await cp(path.join(temporary, "package"), destination, { recursive: true });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
  return manifest;
}

const args = parseArgs(process.argv.slice(2));
const releaseRoot = path.resolve(requiredArg(args, "release-root"));
const outputRoot = path.resolve(requiredArg(args, "out"));
const version = requiredArg(args, "version");
const sourceCommit = requiredArg(args, "commit");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`Invalid source commit: ${sourceCommit}`);

await run(process.execPath, [
  path.join(NPM_ROOT, "scripts", "verify-release-set.mjs"),
  "--root", releaseRoot,
  "--version", version,
  "--commit", sourceCommit,
  ...(args["require-release-trust"] === true ? ["--require-release-trust"] : []),
]);

const templateRoot = path.join(REPO_ROOT, "integrations", "zcode-plugin");
await rm(outputRoot, { force: true, recursive: true });
await mkdir(path.dirname(outputRoot), { recursive: true });
await cp(templateRoot, outputRoot, { recursive: true });

const pluginRoot = path.join(outputRoot, "plugins", "xuanling-mcp");
const nodeModules = path.join(pluginRoot, "bin", "node_modules");
await mkdir(nodeModules, { recursive: true });

const packageManifests = [];
packageManifests.push(await extractPackage(
  releaseRoot,
  "npm-main",
  "main.pack.json",
  path.join(nodeModules, ...PACKAGE_NAME.split("/")),
));

const targetFacts = {};
for (const [targetId, target] of Object.entries(TARGETS)) {
  const manifest = await extractPackage(
    releaseRoot,
    `npm-${targetId}`,
    `${targetId}.pack.json`,
    path.join(nodeModules, target.alias),
  );
  packageManifests.push(manifest);
  const packageJson = await readJson(path.join(nodeModules, target.alias, "package.json"));
  targetFacts[targetId] = {
    alias: target.alias,
    binary: target.binary,
    rust_target: target.rustTarget,
    sha256: packageJson.xuanlingBinary.sha256,
    release_trust: packageJson.xuanlingBinary.releaseTrust,
  };
}

const payload = await describeTree(outputRoot);
const releaseManifest = {
  schema_version: 2,
  version,
  source_commit: sourceCommit,
  payload_sha256: payload.sha256,
  packages: packageManifests
    .map(({ filename, integrity, name, shasum, version: packageVersion }) => ({
      filename,
      integrity,
      name,
      shasum,
      version: packageVersion,
    }))
    .sort((left, right) => left.version.localeCompare(right.version)),
  targets: targetFacts,
};
await writeFile(path.join(outputRoot, "release-manifest.json"), stableJson(releaseManifest));

const tree = await describeTree(outputRoot);
const archive = await createDeterministicArchive(outputRoot);
const archiveFilename = `xuanling-zcode-marketplace-${version}.tar.gz`;
const archivePath = path.join(path.dirname(outputRoot), archiveFilename);
await writeFile(archivePath, archive);
const packManifest = {
  schema_version: 1,
  filename: archiveFilename,
  integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  sha256: sha256(archive),
  size: archive.length,
  source_commit: sourceCommit,
  tree_sha256: tree.sha256,
  version,
};
await writeFile(
  path.join(path.dirname(outputRoot), "zcode-marketplace.pack.json"),
  stableJson(packManifest),
);

console.log(stableJson({ archive: archivePath, ...packManifest }).trim());
