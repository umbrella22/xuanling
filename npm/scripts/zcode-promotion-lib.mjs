import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECTION_ENTRIES = Object.freeze([
  "marketplace.json",
  "plugins",
  "release-manifest.json",
]);

async function walkFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Marketplace projection cannot contain links or special files: ${child}`);
  }
  return files;
}

export async function describeProjection(root, { strictRoot = false } = {}) {
  if (strictRoot) {
    const entries = (await readdir(root)).sort();
    if (JSON.stringify(entries) !== JSON.stringify([...PROJECTION_ENTRIES].sort())) {
      throw new Error(`Incoming marketplace has unexpected top-level entries: ${entries.join(", ")}`);
    }
  }

  const files = [];
  for (const entry of PROJECTION_ENTRIES) {
    const absolute = path.join(root, entry);
    const info = await stat(absolute);
    const relativeFiles = info.isDirectory() ? await walkFiles(root, entry) : [entry];
    for (const relative of relativeFiles) {
      const file = path.join(root, ...relative.split("/"));
      const fileInfo = await stat(file);
      const data = await readFile(file);
      files.push({
        mode: fileInfo.mode & 0o111 ? "0755" : "0644",
        path: relative,
        sha256: createHash("sha256").update(data).digest("hex"),
        size: data.length,
      });
    }
  }
  const sha256 = createHash("sha256")
    .update(files.map((file) =>
      `${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return { files, sha256 };
}

export function compareSemver(left, right) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match) throw new Error(`Invalid stable semver: ${value}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}
