import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TARGETS } from "../packages/xuanling-mcp/lib/targets.js";
import { describeProjection } from "../scripts/zcode-promotion-lib.mjs";

// ZCode plugin marketplace contract:
//   - plugin.json / .mcp.json / npm package / Cargo workspace versions agree;
//   - .mcp.json is the sole launch contract;
//   - integration documentation contains installed-runtime guidance only;
//   - the Skill carries no legacy tool names, no hardcoded tool count, and
//     states the omitted-output=complete semantics.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pluginRoot = path.join(repoRoot, "integrations", "zcode-plugin");
const pluginPackageRoot = path.join(pluginRoot, "plugins", "xuanling-mcp");
const skillPath = path.join(pluginPackageRoot, "skills", "xuanling-mcp-tools", "SKILL.md");

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
}

function runNode(args) {
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

test("plugin manifest references the sole .mcp.json launch contract", () => {
  const plugin = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json");
  const launch = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.mcp.json");
  assert.equal(plugin.mcpServers, ".mcp.json");
  assert.ok(launch.mcpServers?.xuanling, ".mcp.json defines the xuanling server");
});

test(".mcp.json is the sole ZCode launch contract", () => {
  const plugin = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json");
  const launch = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.mcp.json");
  assert.equal(plugin.mcpServers, ".mcp.json", "plugin.json names the sole MCP component path");
  assert.deepEqual(launch.mcpServers?.xuanling?.command, "node");
  assert.ok(
    launch.mcpServers.xuanling.args.includes(
      "${ZCODE_PLUGIN_ROOT}/bin/node_modules/@xuanling-rs/xuanling-mcp/bin/xuanling-mcp.js",
    ),
    "launcher path is rooted at the installed ZCode plugin",
  );
  assert.ok(launch.mcpServers.xuanling.args.includes("${ZCODE_PROJECT_DIR}"));
  assert.doesNotMatch(JSON.stringify({ plugin, launch }), /CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR/);
});

test("ZCode source is a runtime template, not a checked-in host staging tree", () => {
  assert.equal(existsSync(path.join(pluginPackageRoot, "bin")), false, "native bytes are generated for release");
  assert.equal(
    existsSync(path.join(pluginPackageRoot, "scripts", "sync-binary.mjs")),
    false,
    "release staging lives outside integrations",
  );
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  const entry = marketplace.plugins.find((candidate) => candidate.name === "xuanling-mcp");
  assert.deepEqual(entry.source, {
    source: "github",
    repo: "umbrella22/xuanling-zcode-marketplace",
    path: "plugins/xuanling-mcp",
    ref: `xuanling-mcp-v${entry.version}`,
  });
});

test("ZCode plugin READMEs contain installed-runtime guidance only", () => {
  for (const name of ["README.md", "README-ZH.md"]) {
    const readme = readFileSync(path.join(pluginPackageRoot, name), "utf8");
    assert.match(readme, /umbrella22\/xuanling-zcode-marketplace/);
    assert.match(readme, /Node\.js 18\.17/);
    assert.match(readme, /does not require a global npm|不依赖全局 npm/);
    assert.doesNotMatch(
      readme,
      /npm\/scripts|stage-zcode-marketplace|sync-binary|Updating the Runtime|更新 Runtime|source template/i,
      `${name} must not expose repository staging procedures to installed agents`,
    );
  }
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

test("ZCode runtime payload is generated outside the source integration", () => {
  for (const relative of ["bin", "scripts/sync-binary.mjs"]) {
    assert.equal(
      existsSync(path.join(pluginPackageRoot, relative)),
      false,
      `${relative} must be release-generated rather than checked into integrations`,
    );
  }

  for (const script of ["stage-zcode-marketplace.mjs", "verify-zcode-marketplace.mjs"]) {
    assert.equal(
      existsSync(path.join(repoRoot, "npm", "scripts", script)),
      true,
      `${script} owns the generated marketplace contract`,
    );
  }
});

test("ZCode marketplace generation is deterministic and fails closed", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-zcode-contract-"));
  const commit = "0".repeat(40);
  const payload = path.join(repoRoot, "test", "release", "fixtures", "synthetic-payload.txt");
  const stageRoot = path.join(temporary, "stage");
  const releaseRoot = path.join(temporary, "release");

  try {
    runNode([
      "npm/scripts/stage-main.mjs",
      "--out", path.join(stageRoot, "main"),
      "--commit", commit,
    ]);
    runNode([
      "npm/scripts/pack-package.mjs",
      "--package", path.join(stageRoot, "main"),
      "--out", path.join(releaseRoot, "npm-main"),
      "--label", "main",
      "--kind", "main",
    ]);

    for (const targetId of Object.keys(TARGETS)) {
      const packageRoot = path.join(stageRoot, targetId);
      runNode([
        "npm/scripts/stage-platform.mjs",
        "--target", targetId,
        "--binary", payload,
        "--notices", payload,
        "--out", packageRoot,
        "--commit", commit,
      ]);
      runNode([
        "npm/scripts/pack-package.mjs",
        "--package", packageRoot,
        "--out", path.join(releaseRoot, `npm-${targetId}`),
        "--label", targetId,
        "--kind", "platform",
      ]);
    }

    const generated = [];
    for (const label of ["first", "second"]) {
      const parent = path.join(temporary, label);
      const root = path.join(parent, "marketplace");
      runNode([
        "npm/scripts/stage-zcode-marketplace.mjs",
        "--release-root", releaseRoot,
        "--out", root,
        "--version", "0.2.3",
        "--commit", commit,
        "--require-release-trust",
      ]);
      runNode([
        "npm/scripts/verify-zcode-marketplace.mjs",
        "--root", root,
        "--version", "0.2.3",
        "--commit", commit,
        "--require-release-trust",
      ]);
      generated.push({
        pack: JSON.parse(await readFile(path.join(parent, "zcode-marketplace.pack.json"), "utf8")),
        root,
      });
    }
    assert.deepEqual(generated[0].pack, generated[1].pack, "repeated staging is byte-identical");
    const releaseManifest = JSON.parse(
      await readFile(path.join(generated[0].root, "release-manifest.json"), "utf8"),
    );
    assert.equal(releaseManifest.schema_version, 2);
    for (const target of Object.values(releaseManifest.targets)) {
      assert.deepEqual(target.release_trust, {
        npmProvenance: { status: "required-at-publish" },
        publisherSigning: { status: "not-provided" },
      });
    }
    assert.equal(
      (await describeProjection(generated[0].root, { strictRoot: true })).sha256,
      generated[0].pack.tree_sha256,
      "target promotion computes the generator's canonical tree identity",
    );

    const transportedRoot = path.join(temporary, "transported");
    const materializedRoot = path.join(transportedRoot, "marketplace");
    await mkdir(transportedRoot, { recursive: true });
    for (const name of [
      generated[0].pack.filename,
      "zcode-marketplace.pack.json",
    ]) {
      await cp(path.join(path.dirname(generated[0].root), name), path.join(transportedRoot, name));
    }
    runNode([
      "npm/scripts/materialize-zcode-marketplace.mjs",
      "--artifact-root", transportedRoot,
      "--out", materializedRoot,
      "--version", "0.2.3",
      "--commit", commit,
    ]);
    runNode([
      "npm/scripts/verify-zcode-marketplace.mjs",
      "--root", materializedRoot,
      "--version", "0.2.3",
      "--commit", commit,
      "--require-release-trust",
    ]);

    const tamperedTransport = path.join(temporary, "tampered-transport");
    await mkdir(tamperedTransport);
    for (const name of [generated[0].pack.filename, "zcode-marketplace.pack.json"]) {
      await cp(path.join(path.dirname(generated[0].root), name), path.join(tamperedTransport, name));
    }
    const tamperedArchive = path.join(tamperedTransport, generated[0].pack.filename);
    await writeFile(
      tamperedArchive,
      Buffer.concat([await readFile(tamperedArchive), Buffer.from("tampered")]),
    );
    assert.throws(() => runNode([
      "npm/scripts/materialize-zcode-marketplace.mjs",
      "--artifact-root", tamperedTransport,
      "--out", path.join(tamperedTransport, "marketplace"),
      "--version", "0.2.3",
      "--commit", commit,
    ]), "a transported archive with a mismatched digest must be rejected before extraction");
    assert.equal(existsSync(path.join(tamperedTransport, "marketplace")), false);

    const extraTransport = path.join(temporary, "extra-transport");
    await mkdir(extraTransport);
    for (const name of [generated[0].pack.filename, "zcode-marketplace.pack.json"]) {
      await cp(path.join(path.dirname(generated[0].root), name), path.join(extraTransport, name));
    }
    await writeFile(path.join(extraTransport, "unexpected.txt"), "unexpected\n");
    assert.throws(() => runNode([
      "npm/scripts/materialize-zcode-marketplace.mjs",
      "--artifact-root", extraTransport,
      "--out", path.join(extraTransport, "marketplace"),
      "--version", "0.2.3",
      "--commit", commit,
    ]), "an extra transported artifact file must be rejected");
    assert.equal(existsSync(path.join(extraTransport, "marketplace")), false);

    const extraFileRoot = path.join(temporary, "negative-extra", "marketplace");
    await cp(generated[0].root, extraFileRoot, { recursive: true });
    await writeFile(path.join(extraFileRoot, "unexpected.txt"), "unexpected\n");
    assert.throws(() => runNode([
      "npm/scripts/verify-zcode-marketplace.mjs",
      "--root", extraFileRoot,
      "--version", "0.2.3",
      "--commit", commit,
    ]), "an extra release file must be rejected");

    const mutableRefRoot = path.join(temporary, "negative-ref", "marketplace");
    await cp(generated[0].root, mutableRefRoot, { recursive: true });
    const marketplacePath = path.join(mutableRefRoot, "marketplace.json");
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    marketplace.plugins[0].source.ref = "main";
    await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
    assert.throws(() => runNode([
      "npm/scripts/verify-zcode-marketplace.mjs",
      "--root", mutableRefRoot,
      "--version", "0.2.3",
      "--commit", commit,
    ]), "a mutable marketplace source ref must be rejected");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
