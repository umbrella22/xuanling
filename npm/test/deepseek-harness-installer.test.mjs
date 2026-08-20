import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  INSTALLER_CONTRACT,
  TranscriptContractError,
  verifyTranscript,
} from "../../test/host-integration/verify-dsh-conversational-install.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const installerPath = path.join(
  repoRoot,
  ".agents",
  "skills",
  "xuanling-dsh-install",
  "SKILL.md",
);
const fixtureRoot = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "dsh-conversational-install",
);
const verifierPath = path.join(
  repoRoot,
  "test",
  "host-integration",
  "verify-dsh-conversational-install.mjs",
);

const expectedSkillContract = {
  schema_version: 1,
  canonical_repository: INSTALLER_CONTRACT.canonicalRepository,
  skill_path: INSTALLER_CONTRACT.skillPath,
  model_orchestrated: true,
  source_acquisition: {
    method: INSTALLER_CONTRACT.sourceAcquisition.method,
    repository: INSTALLER_CONTRACT.sourceAcquisition.repository,
    allowed_document_paths: INSTALLER_CONTRACT.sourceAcquisition.allowedDocumentPaths,
    require_root_readme: true,
    require_installer_skill: true,
    path_discovery: {
      methods_allowed: INSTALLER_CONTRACT.sourceAcquisition.pathDiscovery.methodsAllowed,
      model_visible_output: "relative_paths_only",
      non_document_content_exposure: false,
    },
    pin_immutable_ref: true,
    execute_repository_code: false,
    install_from_checkout: false,
    cleanup_before_questions: true,
  },
  profiles: [
    { id: "web", recommended: true },
    { id: "headless", recommended: false },
  ],
  presets: {
    recommended: {
      add: INSTALLER_CONTRACT.presets.recommended.add,
      remove: INSTALLER_CONTRACT.presets.recommended.remove,
    },
    "full-additive": {
      add: INSTALLER_CONTRACT.presets["full-additive"].add,
      remove: INSTALLER_CONTRACT.presets["full-additive"].remove,
    },
    "filesystem-replacement": {
      add: INSTALLER_CONTRACT.presets["filesystem-replacement"].add,
      remove: INSTALLER_CONTRACT.presets["filesystem-replacement"].remove,
    },
  },
  questions: [
    {
      id: "xuanling_target_profile",
      options: ["web", "headless"],
      recommended: "web",
    },
    {
      id: "xuanling_install_preset",
      options: ["recommended", "full-additive", "filesystem-replacement"],
      recommended: "recommended",
    },
    {
      id: "xuanling_install_confirm",
      options: ["proceed", "cancel"],
      recommended: "proceed",
    },
  ],
  version_resolution: {
    registry: "https://registry.npmjs.org",
    resolve_once: true,
    stable_semver_only: true,
    exact_mutation_specs: true,
  },
  mutation: {
    cli: "dsh plugin",
    snapshot_before_mutation: true,
    rollback_via_cli: true,
    manual_profile_edits: false,
  },
  verification: [
    "plugin_list",
    "dump_config",
    "cold_start_web",
    "restart_handoff",
    "tool_discovery",
    "harmless_tool_call",
  ],
};

function readText(relative) {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(candidate, code) {
  assert.throws(
    () => verifyTranscript(candidate),
    (error) => error instanceof TranscriptContractError && error.code === code,
    `expected verifier error ${code}`,
  );
}

function parseInstallerContract(markdown) {
  const match = /<!-- xuanling-dsh-installer-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- xuanling-dsh-installer-contract:end -->/.exec(markdown);
  assert.ok(match, "installer_contract_missing: Skill must contain the marked JSON contract block");
  return JSON.parse(match[1]);
}

function readFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, "installer_frontmatter_missing: Skill must start with YAML frontmatter");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((parts) => [parts[1], parts[2]]),
  );
}

test("root installer Skill exposes the structured conversational-install contract", () => {
  assert.equal(
    existsSync(installerPath),
    true,
    "installer_skill_missing: expected .agents/skills/xuanling-dsh-install/SKILL.md",
  );
  const skill = readFileSync(installerPath, "utf8");
  const frontmatter = readFrontmatter(skill);
  assert.equal(frontmatter.name, "xuanling-dsh-install");
  assert.match(frontmatter.description, /DSH/i);
  assert.match(frontmatter.description, /install/i);
  assert.match(frontmatter.description, /repository URL|GitHub URL/i);
  assert.deepEqual(parseInstallerContract(skill), expectedSkillContract);

  assert.match(skill, /not (?:a )?native DSH URL|不是 DSH 原生 URL/i);
  assert.match(skill, /temporary checkout/i);
  assert.match(skill, /remove that directory.*before asking/is);
  assert.match(skill, /cancelled_before_side_effect/);
  assert.match(skill, /verified_noop/);
  assert.match(skill, /rolled_back/);
  assert.match(skill, /rollback_failed/);
  assert.match(skill, /installed_verified/);
  assert.match(skill, /mcp__xuanling__system_info|mcp__xuanling__memory_(?:search|get)/);
  assert.match(skill, /restart/i);
  const executableBlocks = [...skill.matchAll(/```(?:sh|shell|bash|text)\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotMatch(
    executableBlocks,
    /\bgit\s+clone\b|\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b|npm\s+install\s+(?:--global|-g)/i,
  );
});

test("English and Chinese READMEs expose the same canonical lazy-install entry", () => {
  for (const relative of ["README.md", "README-ZH.md"]) {
    const readme = readText(relative);
    const match = /<!-- xuanling-dsh-conversational-install:start -->([\s\S]*?)<!-- xuanling-dsh-conversational-install:end -->/.exec(readme);
    assert.ok(match, `installer_readme_entry_missing: ${relative}`);
    const entry = match[1];
    assert.match(entry, /https:\/\/github\.com\/umbrella22\/xuanling/);
    assert.match(entry, /\.agents\/skills\/xuanling-dsh-install\/SKILL\.md/);
    assert.match(entry, /DeepSeek Harness|DSH/);
    assert.match(entry, /model-orchestrated|模型编排/i);
    assert.match(entry, /temporary checkout|临时 checkout/i);
    assert.doesNotMatch(entry, /native URL installer|原生 URL 安装器/i);
  }
});

test("transcript verifier accepts install, cancel, no-op, migration, and rollback evidence", () => {
  const expected = new Map([
    ["valid.json", "installed_verified"],
    ["valid-cancel.json", "cancelled_before_side_effect"],
    ["valid-noop-headless.json", "verified_noop"],
    ["valid-migration.json", "installed_verified"],
    ["valid-rollback.json", "rolled_back"],
  ]);
  for (const [fixture, terminalStatus] of expected) {
    const report = verifyTranscript(readFixture(fixture));
    assert.equal(report.terminal_status, terminalStatus, fixture);
    assert.match(report.transcript_sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.source_verified, true);
    assert.equal(report.redaction_verified, true);
  }
});

test("transcript verifier rejects pre-confirmation side effects with a typed failure", () => {
  expectCode(readFixture("invalid-side-effect-before-confirmation.json"), "side_effect_before_confirmation");
});

test("transcript verifier rejects wrong ordering, floating specs, forbidden commands, and incomplete runtime evidence", () => {
  const valid = readFixture("valid.json");

  const wrongQuestion = clone(valid);
  wrongQuestion.events.find((event) => event.question_id === "xuanling_target_profile").question_id =
    "xuanling_install_preset";
  expectCode(wrongQuestion, "question_order_invalid");

  const floating = clone(valid);
  const addCommand = floating.events.find((event) => event.kind === "command" && event.argv?.[4] === "add");
  addCommand.argv[5] = "@xuanling-rs/xuanling-dsh-memory@latest";
  expectCode(floating, "floating_package_spec");

  const forbidden = clone(valid);
  const listCommand = forbidden.events.find((event) => event.kind === "command" && event.argv?.[4] === "list");
  listCommand.argv = ["git", "clone", "https://github.com/umbrella22/xuanling"];
  expectCode(forbidden, "command_not_allowed");

  const unsafeSource = clone(valid);
  unsafeSource.source.acquisition.checkout_used_as_package_source = true;
  expectCode(unsafeSource, "source_checkout_unsafe");

  const sourceCodeRead = clone(valid);
  sourceCodeRead.source.acquisition.model_visible_document_paths.push("Cargo.toml");
  expectCode(sourceCodeRead, "source_checkout_unsafe");

  const sourceContentExposed = clone(valid);
  sourceContentExposed.source.acquisition.non_document_content_exposed = true;
  expectCode(sourceContentExposed, "source_checkout_unsafe");

  const locatorLinesExposed = clone(valid);
  locatorLinesExposed.source.acquisition.path_discovery_output = "matching_lines";
  expectCode(locatorLinesExposed, "source_checkout_unsafe");

  const unapprovedDiscovery = clone(valid);
  unapprovedDiscovery.source.acquisition.path_discovery_methods.push("manifest_parse");
  expectCode(unapprovedDiscovery, "source_checkout_unsafe");

  const lookalikeSource = clone(valid);
  lookalikeSource.source.url = "https://github.com/umbrella22/xuanling-malicious";
  expectCode(lookalikeSource, "installer_source_unavailable");

  const incompleteRuntime = clone(valid);
  incompleteRuntime.events = incompleteRuntime.events
    .filter((event) => event.kind !== "tool_call")
    .map((event, index) => ({ ...event, seq: index + 1 }));
  expectCode(incompleteRuntime, "runtime_verification_incomplete");

  const rollbackMismatch = readFixture("valid-rollback.json");
  rollbackMismatch.events.find((event) => event.kind === "inventory" && event.phase === "rollback")
    .config_sha256 = "f".repeat(64);
  expectCode(rollbackMismatch, "rollback_state_mismatch");
});

test("verifier CLI emits a bounded report without replaying raw commands", () => {
  const fixture = path.join(fixtureRoot, "valid.json");
  const result = spawnSync(process.execPath, [verifierPath, "--fixture", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(Buffer.byteLength(result.stdout) < 2048, "report remains bounded");
  assert.doesNotMatch(result.stdout, /plugin.*add|restart_handoff|github\.com/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.terminal_status, "installed_verified");
});

test("current release projections agree while historical 0.2.4 evidence remains historical", () => {
  const cargoVersion = /^version = "([^"]+)"/m.exec(readText("Cargo.toml"))?.[1];
  assert.match(cargoVersion ?? "", /^\d+\.\d+\.\d+$/);
  const currentVersions = [
    readJson("npm/package.json").version,
    readJson("npm/packages/xuanling-mcp/package.json").version,
    readJson("integrations/deepseek-harness/xuanling-memory/package.json").version,
    readJson("integrations/deepseek-harness/xuanling-skills/package.json").version,
    readJson("integrations/deepseek-harness/xuanling-tools/package.json").version,
    readJson("integrations/deepseek-harness/xuanling-tools-replace/package.json").version,
    readJson("integrations/zcode-plugin/marketplace.json").plugins[0].version,
    readJson("integrations/zcode-plugin/plugins/xuanling-mcp/.zcode-plugin/plugin.json").version,
  ];
  assert.deepEqual([...new Set(currentVersions)], [cargoVersion]);
  for (const relative of [
    "integrations/deepseek-harness/xuanling-memory/package.json",
    "integrations/deepseek-harness/xuanling-tools/package.json",
    "integrations/deepseek-harness/xuanling-tools-replace/package.json",
  ]) {
    assert.equal(readJson(relative).dependencies[INSTALLER_CONTRACT.packages.launcher], cargoVersion);
  }
  const marketplace = readJson("integrations/zcode-plugin/marketplace.json");
  assert.equal(marketplace.plugins[0].source.ref, `xuanling-mcp-v${cargoVersion}`);

  const historicalPath = path.join(
    repoRoot,
    "test/host-integration/fixtures/result-cost/zcode-restart-live-0.2.4.json",
  );
  const historicalBytes = readFileSync(historicalPath);
  const historical = JSON.parse(historicalBytes);
  assert.match(historical.evidence_id, /0\.2\.4/);
  assert.equal(
    createHash("sha256").update(historicalBytes).digest("hex"),
    "59b3b68839f829a5440b96084ed4b28e9cdbb75703737cdbba10f470fb78ef99",
    "historical 0.2.4 acceptance bytes must not change during the 0.2.5 release",
  );
});
