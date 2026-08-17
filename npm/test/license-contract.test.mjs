import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const canonicalLicense = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
const packageRoots = [
  "npm/packages/xuanling-mcp",
  "integrations/deepseek-harness/xuanling-memory",
  "integrations/deepseek-harness/xuanling-skills",
  "integrations/deepseek-harness/xuanling-tools",
  "integrations/deepseek-harness/xuanling-tools-replace",
];
const zcodePluginRoot = "integrations/zcode-plugin/plugins/xuanling-mcp";
const zcodeMarketplaceTemplate = "test/release/target-repo-template";

test("first-party release surfaces use the canonical MIT license", () => {
  assert.match(canonicalLicense, /^MIT License\n/);
  assert.match(canonicalLicense, /Copyright \(c\) 2026 umbrella22 and XuanLing contributors/);

  const cargoToml = readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
  const workspacePackage = cargoToml.match(
    /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/,
  )?.[1];
  assert.match(workspacePackage ?? "", /^license\s*=\s*"MIT"$/m);

  for (const relative of packageRoots) {
    const root = path.join(repoRoot, relative);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(manifest.license, "MIT", `${relative}: SPDX license`);
    assert.ok(manifest.files.includes("LICENSE"), `${relative}: LICENSE is packaged`);
    assert.equal(
      readFileSync(path.join(root, "LICENSE"), "utf8"),
      canonicalLicense,
      `${relative}: license text matches the repository root`,
    );
    for (const obsolete of ["LICENSE-APACHE", "LICENSE-MIT"]) {
      assert.equal(
        existsSync(path.join(root, obsolete)),
        false,
        `${relative}: obsolete dual-license file ${obsolete} is absent`,
      );
    }
  }

  const zcodeRoot = path.join(repoRoot, zcodePluginRoot);
  const zcodeManifest = JSON.parse(
    readFileSync(path.join(zcodeRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(zcodeManifest.license, "MIT", `${zcodePluginRoot}: SPDX license`);
  assert.equal(
    readFileSync(path.join(zcodeRoot, "LICENSE"), "utf8"),
    canonicalLicense,
    `${zcodePluginRoot}: license text matches the repository root`,
  );
  assert.equal(
    existsSync(path.join(zcodeRoot, "bin")),
    false,
    `${zcodePluginRoot}: release-generated npm packages are absent from source`,
  );
  assert.equal(
    readFileSync(path.join(repoRoot, zcodeMarketplaceTemplate, "LICENSE"), "utf8"),
    canonicalLicense,
    `${zcodeMarketplaceTemplate}: license text matches the repository root`,
  );
});
