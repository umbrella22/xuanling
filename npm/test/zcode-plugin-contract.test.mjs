import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// ZCode plugin marketplace contract (plan W8.4-W8.8):
//   - plugin.json / .mcp.json / npm package / Cargo workspace versions agree;
//   - .mcp.json is a consistent compatibility mirror of plugin.json;
//   - the Skill carries no legacy tool names, no hardcoded tool count, and
//     states the omitted-output=complete semantics.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pluginRoot = path.join(repoRoot, "integrations", "zcode-plugin");
const pluginPackageRoot = path.join(pluginRoot, "plugins", "xuanling-mcp");
const skillPath = path.join(pluginPackageRoot, "skills", "xuanling-mcp-tools", "SKILL.md");

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
}

test("plugin/npm/cargo/marketplace versions agree", () => {
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  const plugin = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json");
  const npmMain = readJson("npm/package.json");
  const npmPackage = readJson("npm/packages/xuanling-mcp/package.json");
  const cargoText = readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
  const workspaceVersion = /^version = "([^"]+)"/m.exec(cargoText)?.[1];
  assert.equal(plugin.version, npmMain.version);
  assert.equal(plugin.version, npmPackage.version);
  assert.equal(plugin.version, workspaceVersion);
  assert.equal(
    marketplace.plugins.find((entry) => entry.name === "xuanling-mcp")?.version,
    plugin.version,
    "marketplace.json must pin the same plugin version",
  );
});

test(".mcp.json is a consistent compatibility mirror", () => {
  const plugin = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json");
  const mirror = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.mcp.json");
  const inline = plugin.mcpServers?.xuanling;
  const launcher = mirror.mcpServers?.xuanling;
  assert.ok(inline, "plugin.json must inline the xuanling mcpServer");
  assert.ok(launcher, ".mcp.json must define the xuanling mcpServer");
  // Same workspace capability contract through both launchers.
  assert.deepEqual(
    inline.args,
    [
      "--workspace-root",
      "${CLAUDE_PROJECT_DIR}",
      "--compat-lenient-object-params",
    ],
    "inline server args are the workspace root pair plus the ZCode compat shim",
  );
  assert.ok(
    launcher.args.includes("--workspace-root"),
    "mirror must pass --workspace-root",
  );
  assert.ok(
    launcher.args.includes("--compat-lenient-object-params"),
    "mirror must enable the same ZCode compat shim",
  );
  assert.ok(
    launcher.args.includes("${CLAUDE_PROJECT_DIR}"),
    "mirror must resolve the project dir the same way",
  );
});

test("Skill has no legacy memory tool names", () => {
  const skill = readFileSync(skillPath, "utf8");
  for (const legacy of [
    "memory_put",
    "memory_update",
    "memory_delete",
    "memory_compact",
    "memory_context",
  ]) {
    assert.ok(
      !skill.includes(legacy),
      `Skill must not reference the removed v1 tool ${legacy}`,
    );
  }
});

test("Skill has no hardcoded tool count", () => {
  const skill = readFileSync(skillPath, "utf8");
  const countClaims = [
    /\b\d{1,3}\s+typed tools\b/,
    /\b\d{1,3}\s+total\b/,
    /exposing \d{1,3}/,
  ];
  for (const pattern of countClaims) {
    assert.ok(
      !pattern.test(skill),
      `Skill must not hardcode a tool count (matched ${pattern})`,
    );
  }
});

test("Skill states omitted-output=complete and direct-argv", () => {
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /omitted[^\n]{0,80}complete/i, "omitted -> complete semantics");
  assert.match(skill, /no shell/i, "direct argv / no shell contract");
  assert.match(skill, /idempotency_key/, "proposal/review memory usage");
});

test("vendored runtime excludes package-manager and dependency documentation", () => {
  for (const relative of [
    "bin/node_modules/.package-lock.json",
    "bin/node_modules/xuanling-mcp/README.md",
    "bin/node_modules/xuanling-mcp/README-ZH.md",
  ]) {
    assert.equal(
      existsSync(path.join(pluginPackageRoot, relative)),
      false,
      `${relative} is not required by either ZCode launch path`,
    );
  }
  const syncScript = readFileSync(
    path.join(pluginPackageRoot, "scripts", "sync-binary.mjs"),
    "utf8",
  );
  assert.match(syncScript, /\.package-lock\.json/);
  assert.match(syncScript, /README-ZH\.md/);
});
