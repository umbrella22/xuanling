import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { expectedOptionalDependencies } from "../packages/xuanling-mcp/lib/targets.js";
import {
  MAIN_PACKAGE_DIR,
  REPO_ROOT,
  readJson,
  readWorkspaceLicense,
  readWorkspaceVersion,
} from "./shared.mjs";

const [workspaceVersion, workspaceLicense] = await Promise.all([
  readWorkspaceVersion(),
  readWorkspaceLicense(),
]);
const packageJson = await readJson(path.join(MAIN_PACKAGE_DIR, "package.json"));

assert.match(workspaceVersion, /^\d+\.\d+\.\d+$/, "release version must be stable semver");
assert.equal(workspaceLicense, "MIT", "Cargo workspace must use the MIT license");
assert.equal(
  packageJson.license,
  workspaceLicense,
  "Cargo workspace and npm package licenses must match",
);
assert.equal(
  packageJson.version,
  workspaceVersion,
  "Cargo workspace and npm package versions must match",
);
assert.deepEqual(
  packageJson.optionalDependencies,
  expectedOptionalDependencies(workspaceVersion),
  "npm platform aliases must match the release version and target map",
);

for (const directory of [
  "npm",
  ...["xuanling-memory", "xuanling-skills", "xuanling-tools", "xuanling-tools-replace", "xuanling-blueprint"]
    .map((name) => `integrations/deepseek-harness/${name}`),
  ...["xuanling-mcp", "xuanling-mcp-replace"]
    .map((name) => `integrations/zcode-plugin/plugins/${name}/.zcode-plugin`),
]) {
  const filename = directory.endsWith(".zcode-plugin") ? "plugin.json" : "package.json";
  const manifest = await readJson(path.join(REPO_ROOT, directory, filename));
  assert.equal(manifest.version, workspaceVersion, `${directory}: release version must match Cargo`);
}

const blueprintSource = await readFile(
  path.join(REPO_ROOT, "integrations/deepseek-harness/xuanling-blueprint/src/index.ts"),
  "utf8",
);
assert.equal(
  blueprintSource.match(/^export const PLUGIN_VERSION = ['"]([^'"]+)['"]$/m)?.[1],
  workspaceVersion,
  "Blueprint runtime version must match the release version",
);

const expectedVersion = process.env.XUANLING_VERSION;
if (expectedVersion && expectedVersion !== workspaceVersion) {
  throw new Error(
    `XUANLING_VERSION=${expectedVersion} does not match repository version ${workspaceVersion}`,
  );
}

console.log(`version contract OK: ${workspaceVersion}`);
