import { parseArgs, run, stableJson } from "./shared.mjs";

const PACKAGE_NAMES = Object.freeze([
  "xuanling-mcp",
  "xuanling-dsh-memory",
  "xuanling-dsh-skills",
  "xuanling-dsh-tools",
  "xuanling-dsh-tools-replace",
]);

const args = parseArgs(process.argv.slice(2));
const registry = args.registry ?? "https://registry.npmjs.org";
if (!/^https?:\/\/[^\s/]+(?:\/.*)?$/.test(registry)) {
  throw new Error(`Invalid npm registry URL: ${registry}`);
}

const missing = [];
for (const name of PACKAGE_NAMES) {
  const lookup = await run(
    "npm",
    ["view", name, "name", "--json", "--registry", registry],
    { allowFailure: true },
  );
  if (lookup.exitCode === undefined) {
    if (JSON.parse(lookup.stdout) !== name) {
      throw new Error(`${name} registry lookup returned unexpected metadata`);
    }
    continue;
  }
  if (`${lookup.stdout}\n${lookup.stderr}`.includes("E404")) {
    missing.push(name);
    continue;
  }
  throw new Error(`Unable to query ${name}:\n${lookup.stderr || lookup.stdout}`);
}

const bootstrapConfigured = Boolean(process.env.NPM_BOOTSTRAP_TOKEN);
if (missing.length > 0 && !bootstrapConfigured) {
  throw new Error(
    `First publication requires NPM_BOOTSTRAP_TOKEN for missing package names: ${missing.join(", ")}`,
  );
}
console.log(stableJson({
  bootstrap_configured: bootstrapConfigured,
  missing_package_names: missing,
  registry,
}).trim());
