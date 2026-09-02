import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TARGETS } from "../packages/xuanling-mcp/lib/targets.js";
import { readWorkspaceVersion } from "../scripts/shared.mjs";
import { describeProjection } from "../scripts/zcode-promotion-lib.mjs";

// ZCode plugin marketplace contract:
//   - plugin.json / .mcp.json / npm package / Cargo workspace versions agree;
//   - .mcp.json is the sole launch contract;
//   - integration documentation contains installed-runtime guidance only;
//   - the Skill carries no legacy tool names, no hardcoded tool count, and
//     states the v3 bounded-output and cross-host request policy.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const routingVerifier = path.join(repoRoot, "test", "host-integration", "verify-skill-routing.mjs");
const routingFixture = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "skill-routing",
  "cases.json",
);
const pluginRoot = path.join(repoRoot, "integrations", "zcode-plugin");
const pluginPackageRoot = path.join(pluginRoot, "plugins", "xuanling-mcp");
const replacementPluginRoot = path.join(pluginRoot, "plugins", "xuanling-mcp-replace");
const skillPath = path.join(pluginPackageRoot, "skills", "xuanling-mcp-tools", "SKILL.md");
const replacementSkillPath = path.join(
  replacementPluginRoot,
  "skills",
  "xuanling-mcp-replacement",
  "SKILL.md",
);
const replacementHookPath = path.join(replacementPluginRoot, "hooks", "pretooluse.mjs");
const replacementVerifierPath = path.join(
  repoRoot,
  "test",
  "host-integration",
  "verify-zcode-filesystem-replacement.mjs",
);
const workspaceVersion = await readWorkspaceVersion();
const validSha = "0".repeat(64);
const qualifiedMcpPrefix = "mcp__plugin_xuanling-mcp-replace_xuanling__";

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

function runReplacementHook(event) {
  return spawnSync(process.execPath, [replacementHookPath], {
    input: typeof event === "string" ? event : JSON.stringify(event),
    encoding: "utf8",
  });
}

test("current ZCode Skill satisfies the frozen routing contract", () => {
  const result = spawnSync(
    process.execPath,
    [routingVerifier, "--fixture", routingFixture, "--host", "zcode"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.passed_case_ids, [
    "repeated_validation_deterministic",
    "existing_overwrite_cas",
    "ordered_multi_edit_batch",
    "compound_extension_exact",
    "project_local_l1_only",
    "shared_l2_pull_then_pending",
    "explicit_pointer_recall",
    "no_match_or_unavailable_continues",
    "v3_omitted_output_bounded",
    "v3_numbered_read_raw_resume",
    "v3_conditional_reread",
    "v3_diff_visibility_dependency",
    "v3_sha_not_semantic_validation",
    "v3_project_check_resolution",
    "v3_minimal_env_diagnostic",
  ]);
  assert.deepEqual(report.missing_case_ids, []);
  assert.equal(result.stderr, "");
  assert.equal(report.measurement.unique_skill_files, 1);
  assert.ok(report.measurement.total_skill_file_bytes > 0);
  assert.ok(report.measurement.trigger_catalog_bytes > 0);
  assert.match(report.measurement.trigger_catalog_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.measurement.token_count, null);
  assert.equal(report.measurement.token_count_status, "unknown_without_provider_tokenizer");
  assert.equal(report.measurement.documents.length, 1);
});

test("plugin/npm/cargo/marketplace versions agree", () => {
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  const plugin = readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json");
  const replacement = readJson(
    "integrations/zcode-plugin/plugins/xuanling-mcp-replace/.zcode-plugin/plugin.json",
  );
  const npmMain = readJson("npm/package.json");
  const npmPackage = readJson("npm/packages/xuanling-mcp/package.json");
  assert.equal(plugin.version, npmMain.version);
  assert.equal(replacement.version, plugin.version);
  assert.equal(plugin.version, npmPackage.version);
  assert.equal(plugin.version, workspaceVersion);
  for (const name of ["xuanling-mcp", "xuanling-mcp-replace"]) {
    assert.equal(
      marketplace.plugins.find((entry) => entry.name === name)?.version,
      plugin.version,
      `marketplace.json must pin the same ${name} version`,
    );
  }
});

test("replacement plugin ships a cross-platform PreToolUse CAS gate", () => {
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  const entry = marketplace.plugins.find((candidate) => candidate.name === "xuanling-mcp-replace");
  assert.ok(entry, "marketplace must expose the independent replacement plugin");

  const manifest = JSON.parse(
    readFileSync(path.join(replacementPluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "xuanling-mcp-replace");
  assert.equal(
    manifest.hooks,
    undefined,
    "the conventional hooks/hooks.json path must not also be declared in the manifest",
  );
  assert.equal(manifest.mcpServers, ".mcp.json");

  const hooks = JSON.parse(
    readFileSync(path.join(replacementPluginRoot, "hooks", "hooks.json"), "utf8"),
  );
  const registrations = hooks.hooks?.PreToolUse ?? [];
  assert.equal(registrations.length, 1, "replacement has one auditable PreToolUse gate");
  const matcher = new RegExp(registrations[0].matcher);
  for (const name of [
    "Read",
    "mcp__xuanling__fs_edit_batch",
    `${qualifiedMcpPrefix}fs_edit_batch`,
  ]) {
    assert.equal(matcher.test(name), true, `hook matcher must cover ${name}`);
  }
  for (const name of ["SomeReadHelper", "mcp__plugin_other_xuanling__fs_edit_batch"]) {
    assert.equal(matcher.test(name), false, `hook matcher must not capture ${name}`);
  }
  assert.deepEqual(registrations[0].hooks, [{
    type: "process",
    command: "node",
    args: ["${ZCODE_PLUGIN_ROOT}/hooks/pretooluse.mjs"],
    timeoutMs: 10000,
  }]);

  assert.deepEqual(
    readJson("integrations/zcode-plugin/plugins/xuanling-mcp-replace/.mcp.json"),
    readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.mcp.json"),
    "replacement and additive launch the same MCP v3 runtime",
  );
  assert.equal(
    readFileSync(path.join(replacementPluginRoot, "mcp-result-adapter.mjs"), "utf8"),
    readFileSync(path.join(pluginPackageRoot, "mcp-result-adapter.mjs"), "utf8"),
    "replacement preserves the additive result projection byte-for-byte",
  );
});

test("replacement hook denies exact native file tools without leaking input", () => {
  for (const toolName of ["Read", "Write", "Edit", "ApplyPatch", "MultiEdit"]) {
    const result = runReplacementHook({
      tool_name: toolName,
      tool_input: { content: "must-not-appear-in-errors" },
    });
    assert.equal(result.status, 2, `${toolName} must be denied`);
    assert.match(result.stderr, /XUANLING_REPLACEMENT_NATIVE_TOOL_DISABLED/);
    assert.doesNotMatch(result.stderr, /must-not-appear-in-errors/);
    assert.equal(result.stdout, "");
  }
});

test("replacement hook enforces each XuanLing mutation CAS contract", () => {
  const denied = [
    { tool_name: "mcp__xuanling__fs_write_text", tool_input: { mode: "overwrite" } },
    { tool_name: "mcp__xuanling__fs_write_text", tool_input: {} },
    { tool_name: "mcp__xuanling__fs_replace_text", tool_input: {} },
    { tool_name: "mcp__xuanling__fs_edit", tool_input: { expected_sha256: "A".repeat(64) } },
    { tool_name: "mcp__xuanling__fs_edit", tool_input: { expected_sha256: [validSha] } },
    { tool_name: "mcp__xuanling__fs_replace_text", tool_input: { expected_sha256: null } },
    { tool_name: "mcp__xuanling__fs_edit_batch", tool_input: {
      files: [
        { path: "a.txt", expected_sha256: validSha },
        { path: "b.txt", edits: [{ old: "a", new: "b" }] },
      ],
    } },
    { tool_name: "mcp__xuanling__fs_patch", tool_input: { expected_sha256: validSha } },
  ];
  for (const event of denied) {
    const result = runReplacementHook(event);
    assert.equal(result.status, 2, `${event.tool_name} missing/invalid CAS must be denied`);
    assert.match(result.stderr, /XUANLING_REPLACEMENT_(?:CAS_REQUIRED|INVALID_CAS)/);
  }

  const allowed = [
    { tool_name: "mcp__xuanling__fs_write_text", tool_input: { mode: "create" } },
    { tool_name: "mcp__xuanling__fs_write_text", tool_input: {
      mode: "overwrite", expected_sha256: validSha,
    } },
    { tool_name: "mcp__xuanling__fs_replace_text", tool_input: { expected_sha256: validSha } },
    { tool_name: "mcp__xuanling__fs_edit", tool_input: { expected_sha256: validSha } },
    { tool_name: "mcp__xuanling__fs_edit_batch", tool_input: {
      files: [
        { path: "a.txt", expected_sha256: validSha },
        { path: "b.txt", expected_sha256: validSha },
      ],
    } },
    { tool_name: "mcp__xuanling__fs_patch", tool_input: {
      expected_preimage_sha256: validSha,
    } },
  ];
  for (const event of allowed) {
    const result = runReplacementHook(event);
    assert.equal(result.status, 0, `${event.tool_name} with valid CAS must pass: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }

  const qualified = runReplacementHook({
    tool_name: `${qualifiedMcpPrefix}fs_edit`,
    tool_input: {},
  });
  assert.equal(qualified.status, 2, "the host-registered plugin tool name must enforce CAS");
  assert.match(qualified.stderr, /XUANLING_REPLACEMENT_CAS_REQUIRED/);
});

test("replacement hook fails closed for malformed relevant input and ignores foreign tools", () => {
  for (const input of ["not-json", "null", JSON.stringify({ tool_input: {} })]) {
    const result = runReplacementHook(input);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /XUANLING_REPLACEMENT_INVALID_HOOK_INPUT/);
  }

  for (const event of [
    { tool_name: "mcp__other__fs_edit", tool_input: {} },
    { tool_name: "mcp__plugin_other_xuanling__fs_edit", tool_input: {} },
    { tool_name: "SomeReadHelper", tool_input: {} },
    { tool_name: "mcp__xuanling__fs_hash", tool_input: { path: "a.txt" } },
  ]) {
    const result = runReplacementHook(event);
    assert.equal(result.status, 0, `foreign/read-only tool must not be denied: ${event.tool_name}`);
  }
});

test("replacement Skill keeps CAS, batch, diff, formatter, and host-limit guidance", () => {
  const skill = readFileSync(replacementSkillPath, "utf8");
  assert.match(skill, /fs_edit_batch/);
  assert.match(skill, /include_diff: true/);
  assert.match(skill, /formatter[\s\S]{0,200}read or hash/i);
  assert.match(skill, /expected_preimage_sha256/);
  assert.match(skill, /mcp__plugin_xuanling-mcp-replace_xuanling__/);
  assert.match(skill, /cannot hide native tool names/);
  assert.match(skill, /cannot guarantee a native ZCode diff[\s\S]{0,20}card or native image rendering/);
  assert.match(skill, /Disabling[\s\S]{0,100}restores native tool execution/);
});

test("replacement live verifier is syntactically valid and binds the real host namespace", () => {
  assert.equal(runNode(["--check", replacementVerifierPath]), "");
  const source = readFileSync(replacementVerifierPath, "utf8");
  assert.match(source, /realpath\(path\.resolve\(/);
  assert.match(source, /mcp__plugin_xuanling-mcp-replace_xuanling__/);
  assert.match(source, /user_config_unchanged: true/);
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
  assert.equal(
    launch.mcpServers.xuanling.args[0],
    "${ZCODE_PLUGIN_ROOT}/mcp-result-adapter.mjs",
    "ZCode routes MCP results through the host projection adapter",
  );
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
  for (const root of [pluginPackageRoot, replacementPluginRoot]) {
    assert.equal(existsSync(path.join(root, "bin")), false, "native bytes are generated for release");
    assert.equal(
      existsSync(path.join(root, "scripts", "sync-binary.mjs")),
      false,
      "release staging lives outside integrations",
    );
  }
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  for (const name of ["xuanling-mcp", "xuanling-mcp-replace"]) {
    const entry = marketplace.plugins.find((candidate) => candidate.name === name);
    assert.deepEqual(entry.source, {
      source: "github",
      repo: "umbrella22/xuanling-zcode-marketplace",
      path: `plugins/${name}`,
      ref: `${name}-v${entry.version}`,
    });
  }
});

test("ZCode plugin READMEs contain installed-runtime guidance only", () => {
  for (const root of [pluginPackageRoot, replacementPluginRoot]) {
    for (const name of ["README.md", "README-ZH.md"]) {
      const readme = readFileSync(path.join(root, name), "utf8");
      assert.match(readme, /umbrella22\/xuanling-zcode-marketplace/);
      assert.match(readme, /Node\.js 18\.17/);
      assert.match(readme, /does not require a global npm|不依赖全局 npm/);
      assert.doesNotMatch(
        readme,
        /npm\/scripts|stage-zcode-marketplace|sync-binary|Updating the Runtime|更新 Runtime|source template/i,
        `${path.basename(root)}/${name} must not expose repository staging procedures`,
      );
    }
  }
});

test("ZCode Skill exposes a stable package-relative locator", () => {
  assert.equal(
    path.relative(pluginPackageRoot, skillPath).replaceAll(path.sep, "/"),
    "skills/xuanling-mcp-tools/SKILL.md",
  );
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /stable packaged Skill path.*skills\/xuanling-mcp-tools\/SKILL\.md/s);
  assert.match(skill, /versioned plugin-cache directory/);
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

test("Skill states v3 bounded-output and direct-argv contracts", () => {
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /omitt(?:ed|ing)[^\n]{0,100}(?:65,536|64 KiB)[^\n]{0,100}bounded/i,
    "omitted output uses the v3 bounded default");
  assert.match(skill, /mode[^\n]{0,30}complete/i, "complete output is an explicit opt-in");
  assert.match(skill, /no shell/i, "direct argv / no shell contract");
  assert.match(skill, /idempotency_key/, "proposal/review memory usage");
  assert.match(skill, /host file memory\s+\(L1\)/i, "project-local memory stays on the host");
  assert.match(skill, /XuanLing L2/i, "shared memory routes to XuanLing");
  assert.match(skill, /not a lightweight\s+manifest/i, "memory_search full-record cost is explicit");
  assert.match(skill, /background\/job mechanism/i, "long-running work uses the host job surface");
});

test("ZCode runtime payload is generated outside the source integration", () => {
  for (const root of [pluginPackageRoot, replacementPluginRoot]) {
    for (const relative of ["bin", "scripts/sync-binary.mjs"]) {
      assert.equal(
        existsSync(path.join(root, relative)),
        false,
        `${path.basename(root)}/${relative} must be release-generated`,
      );
    }
  }

  for (const script of ["stage-zcode-marketplace.mjs", "verify-zcode-marketplace.mjs"]) {
    assert.equal(
      existsSync(path.join(repoRoot, "npm", "scripts", script)),
      true,
      `${script} owns the generated marketplace contract`,
    );
  }
});

test("ZCode source ships the result projection adapter", () => {
  const sources = [pluginPackageRoot, replacementPluginRoot].map((root) => {
    const adapter = path.join(root, "mcp-result-adapter.mjs");
    assert.equal(existsSync(adapter), true);
    const source = readFileSync(adapter, "utf8");
    assert.match(source, /projectZcodeCallResult/);
    assert.match(source, /structuredContent/);
    assert.match(source, /Result available in structuredContent/);
    return source;
  });
  assert.equal(sources[0], sources[1], "both variants use the identical projection adapter");
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
        "--version", workspaceVersion,
        "--commit", commit,
        "--require-release-trust",
      ]);
      runNode([
        "npm/scripts/verify-zcode-marketplace.mjs",
        "--root", root,
        "--version", workspaceVersion,
        "--commit", commit,
        "--require-release-trust",
      ]);
      generated.push({
        pack: JSON.parse(await readFile(path.join(parent, "zcode-marketplace.pack.json"), "utf8")),
        root,
      });
    }
    assert.deepEqual(generated[0].pack, generated[1].pack, "repeated staging is byte-identical");
    const generatedArchive = await readFile(
      path.join(path.dirname(generated[0].root), generated[0].pack.filename),
    );
    assert.deepEqual(
      [...generatedArchive.subarray(0, 10)],
      [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff],
      "gzip header must use zero mtime and a canonical cross-platform OS marker",
    );
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
      "--version", workspaceVersion,
      "--commit", commit,
    ]);
    runNode([
      "npm/scripts/verify-zcode-marketplace.mjs",
      "--root", materializedRoot,
      "--version", workspaceVersion,
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
      "--version", workspaceVersion,
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
      "--version", workspaceVersion,
      "--commit", commit,
    ]), "an extra transported artifact file must be rejected");
    assert.equal(existsSync(path.join(extraTransport, "marketplace")), false);

    const extraFileRoot = path.join(temporary, "negative-extra", "marketplace");
    await cp(generated[0].root, extraFileRoot, { recursive: true });
    await writeFile(path.join(extraFileRoot, "unexpected.txt"), "unexpected\n");
    assert.throws(() => runNode([
      "npm/scripts/verify-zcode-marketplace.mjs",
      "--root", extraFileRoot,
      "--version", workspaceVersion,
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
      "--version", workspaceVersion,
      "--commit", commit,
    ]), "a mutable marketplace source ref must be rejected");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
