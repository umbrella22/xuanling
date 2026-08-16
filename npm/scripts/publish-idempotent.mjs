import path from "node:path";

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
const lookup = await run(
  "npm",
  ["view", specifier, "dist.integrity", "--json", "--registry", registry],
  { allowFailure: true },
);

if (lookup.exitCode === undefined) {
  const publishedIntegrity = JSON.parse(lookup.stdout);
  if (typeof publishedIntegrity !== "string" || publishedIntegrity.length === 0) {
    throw new Error(
      `${specifier} registry lookup returned an invalid integrity: ${lookup.stdout.trim()}`,
    );
  }
  if (publishedIntegrity !== manifest.integrity) {
    throw new Error(
      `${specifier} already exists with integrity ${publishedIntegrity}; local tarball is ${manifest.integrity}`,
    );
  }
  console.log(`${specifier} already exists with matching integrity; publish skipped`);
  process.exit(0);
}
if (!`${lookup.stdout}\n${lookup.stderr}`.includes("E404")) {
  throw new Error(`Unable to query ${specifier}:\n${lookup.stderr || lookup.stdout}`);
}

const tarballPath = path.join(path.dirname(manifestPath), manifest.filename);
await run("npm", [
  "publish",
  tarballPath,
  "--access",
  "public",
  "--tag",
  tag,
  "--registry",
  registry,
]);
console.log(`published ${specifier} with dist-tag ${tag}`);
