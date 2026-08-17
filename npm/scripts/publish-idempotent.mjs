import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { classifyIntegrityLookup } from "./registry-release.mjs";
import { parseArgs, readJson, requiredArg, run } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(requiredArg(args, "manifest"));
const tag = requiredArg(args, "tag");
const registry = args.registry ?? "https://registry.npmjs.org";
if (!/^https?:\/\/[^\s/]+(?:\/.*)?$/.test(registry)) {
  throw new Error(`Invalid npm registry URL: ${registry}`);
}
if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
  throw new Error(`Invalid npm dist-tag: ${tag}`);
}
const manifest = await readJson(manifestPath);
const specifier = `${manifest.name}@${manifest.version}`;
const tarballPath = path.join(path.dirname(manifestPath), manifest.filename);
const tarball = await readFile(tarballPath);
const localIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (localIntegrity !== manifest.integrity) {
  throw new Error(`${specifier} local tarball integrity does not match its pack manifest`);
}
const lookup = await run(
  "npm",
  ["view", specifier, "dist.integrity", "--json", "--registry", registry],
  { allowFailure: true },
);

const decision = classifyIntegrityLookup(lookup, {
  expectedIntegrity: manifest.integrity,
  specifier,
});
if (decision.action === "skip") {
  console.log(`${specifier} already exists with matching integrity; publish skipped`);
  process.exit(0);
}

await run("npm", [
  "publish",
  tarballPath,
  "--access",
  "public",
  "--tag",
  tag,
  "--provenance",
  "--registry",
  registry,
]);
let reconciled = false;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const published = await run(
    "npm",
    ["view", specifier, "dist.integrity", "--json", "--registry", registry],
    { allowFailure: true },
  );
  const reconciliation = classifyIntegrityLookup(published, {
    expectedIntegrity: manifest.integrity,
    specifier,
  });
  if (reconciliation.action === "skip") {
    reconciled = true;
    break;
  }
  if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!reconciled) throw new Error(`${specifier} did not become visible after publish reconciliation`);
console.log(`published and reconciled ${specifier} with dist-tag ${tag}`);
