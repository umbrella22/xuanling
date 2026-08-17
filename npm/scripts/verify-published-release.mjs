import path from "node:path";

import {
  DSH_BUNDLES,
  TARGETS,
  platformVersion,
} from "../packages/xuanling-mcp/lib/targets.js";
import { classifyIntegrityLookup } from "./registry-release.mjs";
import { parseArgs, readJson, requiredArg, run, stableJson } from "./shared.mjs";

const DSH_PACKAGES = DSH_BUNDLES;

const args = parseArgs(process.argv.slice(2));
const coreRoot = path.resolve(requiredArg(args, "core-root"));
const dshRoot = path.resolve(requiredArg(args, "dsh-root"));
const version = requiredArg(args, "version");
const registry = args.registry ?? "https://registry.npmjs.org";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
if (!/^https?:\/\/[^\s/]+(?:\/.*)?$/.test(registry)) {
  throw new Error(`Invalid npm registry URL: ${registry}`);
}

const releaseItems = [
  { path: path.join(coreRoot, "npm-main", "main.pack.json"), version },
  ...Object.keys(TARGETS).map((targetId) => ({
    path: path.join(coreRoot, `npm-${targetId}`, `${targetId}.pack.json`),
    version: platformVersion(version, targetId),
  })),
  ...DSH_PACKAGES.map(({ id }) => ({
    path: path.join(dshRoot, id, `${id}.pack.json`),
    version,
  })),
];
const verified = [];
for (const item of releaseItems) {
  const manifest = await readJson(item.path);
  if (manifest.version !== item.version) {
    throw new Error(`${manifest.name} manifest version ${manifest.version} does not match ${item.version}`);
  }
  const specifier = `${manifest.name}@${manifest.version}`;
  const lookup = await run(
    "npm",
    ["view", specifier, "dist.integrity", "--json", "--registry", registry],
    { allowFailure: true },
  );
  const decision = classifyIntegrityLookup(lookup, {
    expectedIntegrity: manifest.integrity,
    specifier,
  });
  if (decision.action !== "skip") {
    throw new Error(`${specifier} is not published`);
  }
  verified.push({ integrity: decision.integrity, specifier });
}
if (verified.length !== 8) throw new Error(`Expected 8 release items, verified ${verified.length}`);
console.log(stableJson({ registry, verified }).trim());
