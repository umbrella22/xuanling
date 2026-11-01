import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  PACKAGE_BASENAME,
  PACKAGE_NAME,
  TARGETS,
  platformVersion,
} from "../packages/harness-bridge/lib/targets.js";
import {
  NPM_ROOT,
  readJson,
  readWorkspaceLicense,
  readWorkspaceVersion,
} from "./shared.mjs";

const directory = path.join(NPM_ROOT, "packages", "harness-bridge");
const packageJson = await readJson(path.join(directory, "package.json"));
const [workspaceVersion, workspaceLicense] = await Promise.all([
  readWorkspaceVersion(),
  readWorkspaceLicense(),
]);

assert.equal(packageJson.name, PACKAGE_NAME);
assert.equal(packageJson.license, workspaceLicense);
assert.equal(packageJson.version, workspaceVersion);
assert.equal(packageJson.bin?.[PACKAGE_BASENAME], "bin/harness-bridge.js");
assert.equal(packageJson.repository?.directory, "npm/packages/harness-bridge");
assert.equal(
  packageJson.optionalDependencies,
  undefined,
  "platform packages are not published yet; keep optionalDependencies absent",
);
for (const script of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
  assert.equal(packageJson.scripts?.[script], undefined, `${script} must not run on install`);
}

for (const file of [
  "bin/harness-bridge.js",
  "lib/launcher.js",
  "lib/targets.js",
  "LICENSE",
  "README.md",
  "README-ZH.md",
]) {
  await stat(path.join(directory, file));
}
const bin = await readFile(path.join(directory, "bin", "harness-bridge.js"), "utf8");
assert.match(bin, /^#!\/usr\/bin\/env node/);

for (const target of Object.values(TARGETS)) {
  assert.equal(platformVersion(workspaceVersion, target.id), `${workspaceVersion}-${target.id}`);
  assert.match(target.rustTarget, /^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/);
}

console.log(`harness-bridge npm launcher OK: ${PACKAGE_NAME}@${packageJson.version}`);
