import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PACKAGE_NAME,
  TARGETS,
  expectedOptionalDependencies,
  platformVersion,
} from "../packages/xuanling-mcp/lib/targets.js";
import {
  parseArgs,
  readJson,
  requiredArg,
  run,
  sha256File,
} from "./shared.mjs";
import { verifyReleaseTrust } from "./release-signature.mjs";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function walkFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`ZCode tree cannot contain links or special files: ${child}`);
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

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(requiredArg(args, "root"));
const version = requiredArg(args, "version");
const sourceCommit = requiredArg(args, "commit");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`Invalid source commit: ${sourceCommit}`);

assert.deepEqual(
  (await readdir(root)).sort(),
  ["marketplace.json", "plugins", "release-manifest.json"],
  "generated marketplace has an exact top-level tree",
);
const pluginRoot = path.join(root, "plugins", "xuanling-mcp");
assert.deepEqual(
  (await readdir(pluginRoot)).sort(),
  [".mcp.json", ".zcode-plugin", "LICENSE", "README-ZH.md", "README.md", "bin", "mcp-result-adapter.mjs", "skills"],
  "plugin tree contains only runtime components",
);

const marketplace = await readJson(path.join(root, "marketplace.json"));
const entry = marketplace.plugins.find((candidate) => candidate.name === "xuanling-mcp");
assert.equal(entry.version, version);
assert.deepEqual(entry.source, {
  source: "github",
  repo: "umbrella22/xuanling-zcode-marketplace",
  path: "plugins/xuanling-mcp",
  ref: `xuanling-mcp-v${version}`,
});

const plugin = await readJson(path.join(pluginRoot, ".zcode-plugin", "plugin.json"));
assert.equal(plugin.version, version);
assert.equal(plugin.license, "MIT");
assert.equal(plugin.mcpServers, ".mcp.json");
assert.equal(typeof plugin.mcpServers, "string", "inline MCP definitions are forbidden");
const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
assert.deepEqual(mcp.mcpServers?.xuanling, {
  command: "node",
  args: [
    "${ZCODE_PLUGIN_ROOT}/mcp-result-adapter.mjs",
    "--binary",
    "node",
    "--",
    "${ZCODE_PLUGIN_ROOT}/bin/node_modules/@xuanling-rs/xuanling-mcp/bin/xuanling-mcp.js",
    "--workspace-root",
    "${ZCODE_PROJECT_DIR}",
    "--compat-lenient-object-params",
  ],
});

const nodeModules = path.join(pluginRoot, "bin", "node_modules");
assert.deepEqual(
  (await readdir(nodeModules)).sort(),
  ["@xuanling-rs", ...Object.values(TARGETS).map((target) => target.alias)].sort(),
  "plugin contains the launcher and exactly three native aliases",
);
const mainPackageRoot = path.join(nodeModules, ...PACKAGE_NAME.split("/"));
const mainPackage = await readJson(path.join(mainPackageRoot, "package.json"));
assert.equal(mainPackage.name, PACKAGE_NAME);
assert.equal(mainPackage.version, version);
assert.equal(mainPackage.xuanlingRelease?.sourceCommit, sourceCommit);
assert.deepEqual(mainPackage.optionalDependencies, expectedOptionalDependencies(version));
assert.deepEqual(
  (await walkFiles(mainPackageRoot)).sort(),
  [
    "LICENSE",
    "README-ZH.md",
    "README.md",
    "bin/xuanling-mcp.js",
    "lib/launcher.js",
    "lib/targets.js",
    "package.json",
  ].sort(),
  "launcher package has an exact runtime tree",
);
for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
  assert.equal(mainPackage.scripts?.[script], undefined);
}

const targetPackageJson = {};
for (const [targetId, target] of Object.entries(TARGETS)) {
  const packageRoot = path.join(nodeModules, target.alias);
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  targetPackageJson[targetId] = packageJson;
  assert.equal(packageJson.name, target.packageName);
  assert.deepEqual(
    (await walkFiles(packageRoot)).sort(),
    ["LICENSE", "THIRD_PARTY_LICENSES.txt", target.binary, "package.json"].sort(),
    `${targetId} package has an exact runtime tree`,
  );
  assert.equal(packageJson.version, platformVersion(version, targetId));
  assert.equal(packageJson.xuanlingBinary?.sourceCommit, sourceCommit);
  assert.equal(packageJson.xuanlingBinary?.target, target.rustTarget);
  assert.equal(packageJson.xuanlingBinary?.binary, target.binary);
  assert.equal(
    await sha256File(path.join(packageRoot, target.binary)),
    packageJson.xuanlingBinary?.sha256,
  );
  if (args["require-release-trust"] === true) {
    verifyReleaseTrust(packageJson.xuanlingBinary?.releaseTrust, targetId);
  }
}

const releaseManifest = await readJson(path.join(root, "release-manifest.json"));
assert.equal(releaseManifest.schema_version, 2);
assert.equal(releaseManifest.version, version);
assert.equal(releaseManifest.source_commit, sourceCommit);
const payload = await describeTree(root, new Set(["release-manifest.json"]));
assert.equal(releaseManifest.payload_sha256, payload.sha256);
assert.deepEqual(Object.keys(releaseManifest.targets).sort(), Object.keys(TARGETS).sort());
assert.deepEqual(
  releaseManifest.packages.map((entry) => entry.version).sort(),
  [version, ...Object.keys(TARGETS).map((targetId) => platformVersion(version, targetId))].sort(),
  "release manifest lists the launcher and every native package version exactly once",
);
for (const entry of releaseManifest.packages) {
  assert.ok(
    [PACKAGE_NAME, ...Object.values(TARGETS).map((target) => target.packageName)].includes(entry.name),
    `unexpected package identity in release manifest: ${entry.name}`,
  );
  assert.match(entry.filename, /^xuanling-rs-xuanling-mcp-[^/]+\.tgz$/);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.match(entry.shasum, /^[0-9a-f]{40}$/);
}
for (const [targetId, target] of Object.entries(TARGETS)) {
  const binary = targetPackageJson[targetId].xuanlingBinary;
  assert.deepEqual(releaseManifest.targets[targetId], {
    alias: target.alias,
    binary: target.binary,
    rust_target: target.rustTarget,
    sha256: binary.sha256,
    release_trust: binary.releaseTrust,
  });
}

const tree = await describeTree(root);
const packPath = path.join(path.dirname(root), "zcode-marketplace.pack.json");
const pack = await readJson(packPath);
assert.equal(pack.schema_version, 1);
assert.equal(pack.version, version);
assert.equal(pack.source_commit, sourceCommit);
assert.equal(pack.tree_sha256, tree.sha256);
const archivePath = path.join(path.dirname(root), pack.filename);
const archive = await readFile(archivePath);
assert.equal(sha256(archive), pack.sha256);
assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, pack.integrity);
assert.equal(archive.length, pack.size);
assert.ok(archive.length < 50 * 1024 * 1024, "ZCode archive stays below the host sync limit");

const extracted = await mkdtemp(path.join(os.tmpdir(), "xuanling-zcode-archive-"));
try {
  await run("tar", ["-xzf", archivePath, "-C", extracted]);
  assert.equal((await describeTree(extracted)).sha256, tree.sha256, "archive reproduces the tree");
} finally {
  await rm(extracted, { force: true, recursive: true });
}

for (const relative of tree.files.map((file) => file.path)) {
  assert.doesNotMatch(relative, /(?:^|\/)(?:\.env|\.npmrc|credentials?|[^/]+\.(?:p12|pfx|pem|key))$/i);
}
for (const relative of tree.files
  .map((file) => file.path)
  .filter((file) => /\.(?:json|js|md|txt)$/.test(file))) {
  const text = await readFile(path.join(root, ...relative.split("/")), "utf8");
  assert.doesNotMatch(text, /BEGIN (?:RSA )?PRIVATE KEY|_authToken\s*=/);
}

console.log(`ZCode marketplace OK: ${version} ${tree.sha256}`);
