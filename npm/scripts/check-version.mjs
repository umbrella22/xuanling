import assert from "node:assert/strict";
import path from "node:path";

import { expectedOptionalDependencies } from "../packages/xuanling-mcp/lib/targets.js";
import {
  MAIN_PACKAGE_DIR,
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

const expectedVersion = process.env.XUANLING_VERSION;
if (expectedVersion && expectedVersion !== workspaceVersion) {
  throw new Error(
    `XUANLING_VERSION=${expectedVersion} does not match repository version ${workspaceVersion}`,
  );
}

console.log(`version contract OK: ${workspaceVersion}`);
