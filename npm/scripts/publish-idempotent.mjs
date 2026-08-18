import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyIntegrityLookup,
  reconcilePublishedIntegrity,
} from "./registry-release.mjs";
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
const reconciliation = await reconcilePublishedIntegrity({
  expectedIntegrity: manifest.integrity,
  lookup: () => run(
    "npm",
    ["view", specifier, "dist.integrity", "--json", "--registry", registry],
    { allowFailure: true },
  ),
  onRetry: ({ attempt, delayMs, totalAttempts }) => {
    console.log(
      `${specifier} is not visible yet; retrying lookup ${attempt}/${totalAttempts} `
        + `in ${delayMs / 1_000} seconds`,
    );
  },
  specifier,
});
console.log(
  `published and reconciled ${specifier} with dist-tag ${tag} `
    + `after ${reconciliation.attempts} lookup(s)`,
);
