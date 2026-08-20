#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const INSTALLER_CONTRACT = Object.freeze({
  canonicalRepository: "https://github.com/umbrella22/xuanling",
  skillPath: ".agents/skills/xuanling-dsh-install/SKILL.md",
  sourceAcquisition: Object.freeze({
    method: "temporary_git_checkout",
    repository: "https://github.com/umbrella22/xuanling.git",
    allowedDocumentPaths: Object.freeze([
      "README.md",
      "README-ZH.md",
      ".agents/skills/xuanling-dsh-install/SKILL.md",
      "integrations/deepseek-harness/README.md",
      "integrations/deepseek-harness/README-ZH.md",
    ]),
  }),
  questions: Object.freeze({
    profile: Object.freeze({
      id: "xuanling_target_profile",
      options: Object.freeze(["web", "headless"]),
      recommended: "web",
    }),
    preset: Object.freeze({
      id: "xuanling_install_preset",
      options: Object.freeze(["recommended", "full-additive", "filesystem-replacement"]),
      recommended: "recommended",
    }),
    confirm: Object.freeze({
      id: "xuanling_install_confirm",
      options: Object.freeze(["proceed", "cancel"]),
      recommended: "proceed",
    }),
  }),
  packages: Object.freeze({
    launcher: "@xuanling-rs/xuanling-mcp",
    memory: "@xuanling-rs/xuanling-dsh-memory",
    skills: "@xuanling-rs/xuanling-dsh-skills",
    tools: "@xuanling-rs/xuanling-dsh-tools",
    toolsReplace: "@xuanling-rs/xuanling-dsh-tools-replace",
  }),
  presets: Object.freeze({
    recommended: Object.freeze({
      add: Object.freeze([
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-skills",
      ]),
      remove: Object.freeze([
        "@xuanling-rs/xuanling-dsh-tools",
        "@xuanling-rs/xuanling-dsh-tools-replace",
      ]),
    }),
    "full-additive": Object.freeze({
      add: Object.freeze([
        "@xuanling-rs/xuanling-dsh-tools",
        "@xuanling-rs/xuanling-dsh-skills",
      ]),
      remove: Object.freeze([
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-tools-replace",
      ]),
    }),
    "filesystem-replacement": Object.freeze({
      add: Object.freeze([
        "@xuanling-rs/xuanling-dsh-tools-replace",
        "@xuanling-rs/xuanling-dsh-skills",
      ]),
      remove: Object.freeze([
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-tools",
      ]),
    }),
  }),
});

const stableSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const canonicalSourcePattern = /^https:\/\/github\.com\/umbrella22\/xuanling\/?$/;
const immutableSourcePattern = /^https:\/\/github\.com\/umbrella22\/xuanling\/(?:tree|commit)\/([0-9a-f]{40})\/?$/;
const terminalStatuses = new Set([
  "cancelled_before_side_effect",
  "verified_noop",
  "installed_verified",
  "rolled_back",
]);
const runtimePackages = new Set([
  INSTALLER_CONTRACT.packages.memory,
  INSTALLER_CONTRACT.packages.tools,
  INSTALLER_CONTRACT.packages.toolsReplace,
]);
const relevantPackages = new Set([
  ...runtimePackages,
  INSTALLER_CONTRACT.packages.skills,
]);

export class TranscriptContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TranscriptContractError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new TranscriptContractError(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) reject("invalid_transcript_schema", `${path} must be an object`);
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    reject("invalid_transcript_schema", `${path} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    reject("invalid_transcript_schema", `${path} must be a string array`);
  }
  return value;
}

function sameMembers(actual, expected) {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function exactSpec(packageName, version) {
  return `${packageName}@${version}`;
}

function assertExactSpec(spec, packageName, version, code = "floating_package_spec") {
  if (spec !== exactSpec(packageName, version)) {
    reject(code, `expected exact package spec ${exactSpec(packageName, version)}, got ${spec}`);
  }
}

function validateSource(candidate) {
  const source = requireRecord(candidate, "fixture.source");
  const sourceUrl = requireString(source.url, "fixture.source.url");
  const immutableMatch = immutableSourcePattern.exec(sourceUrl);
  if (!canonicalSourcePattern.test(sourceUrl) && !immutableMatch) {
    reject("installer_source_unavailable", "source URL must be the canonical repository or one immutable commit URL");
  }
  if (source.skill_path !== INSTALLER_CONTRACT.skillPath || source.status !== "loaded") {
    reject("installer_source_unavailable", "installer Skill path and loaded status must match the contract");
  }

  const acquisition = requireRecord(source.acquisition, "fixture.source.acquisition");
  if (
    acquisition.method !== INSTALLER_CONTRACT.sourceAcquisition.method ||
    acquisition.repository !== INSTALLER_CONTRACT.sourceAcquisition.repository
  ) {
    reject("source_checkout_unsafe", "source acquisition must use the fixed temporary Git checkout contract");
  }
  const requestedRef = requireString(acquisition.requested_ref, "fixture.source.acquisition.requested_ref");
  const resolvedCommit = requireString(
    acquisition.resolved_commit,
    "fixture.source.acquisition.resolved_commit",
  );
  if (!commitPattern.test(resolvedCommit)) {
    reject("installer_source_unavailable", "source acquisition must resolve one lowercase 40-character commit");
  }
  if (immutableMatch && (requestedRef !== immutableMatch[1] || resolvedCommit !== immutableMatch[1])) {
    reject("installer_source_unavailable", "immutable source URL, requested ref, and resolved commit must match");
  }
  if (!immutableMatch && requestedRef !== "main") {
    reject("installer_source_unavailable", "canonical source URL must record main as the requested ref");
  }
  const readPaths = requireStringArray(
    acquisition.read_paths,
    "fixture.source.acquisition.read_paths",
  );
  const allowedDocumentPaths = new Set(INSTALLER_CONTRACT.sourceAcquisition.allowedDocumentPaths);
  const hasRootReadme = readPaths.includes("README.md") || readPaths.includes("README-ZH.md");
  const hasInstallerSkill = readPaths.includes(INSTALLER_CONTRACT.skillPath);
  if (
    new Set(readPaths).size !== readPaths.length ||
    readPaths.some((path) => !allowedDocumentPaths.has(path)) ||
    !hasRootReadme ||
    !hasInstallerSkill ||
    acquisition.directory_metadata_only !== true ||
    acquisition.target_existed_before !== false ||
    acquisition.repository_code_executed !== false ||
    acquisition.checkout_used_as_package_source !== false ||
    acquisition.cleanup_status !== "removed"
  ) {
    reject(
      "source_checkout_unsafe",
      "temporary source checkout must read the required allowlisted documents, limit other inspection to directory metadata, start absent, remain source-only, and be removed before questions",
    );
  }
  return { source, acquisition };
}

function validateSnapshot(candidate, path, profile) {
  const snapshot = requireRecord(candidate, path);
  if (snapshot.profile !== profile) {
    reject("profile_mismatch", `${path}.profile must remain ${profile}`);
  }
  for (const field of ["manifest_sha256", "config_sha256"]) {
    if (!sha256Pattern.test(snapshot[field] ?? "")) {
      reject("invalid_transcript_schema", `${path}.${field} must be a lowercase SHA-256`);
    }
  }
  const specs = requireRecord(snapshot.relevant_specs, `${path}.relevant_specs`);
  for (const [packageName, spec] of Object.entries(specs)) {
    if (!relevantPackages.has(packageName) || typeof spec !== "string") {
      reject("unexpected_profile_dependency", `${path} contains unexpected dependency ${packageName}`);
    }
    if (!spec.startsWith(`${packageName}@`) || !stableSemver.test(spec.slice(packageName.length + 1))) {
      reject("floating_package_spec", `${path} must record an exact stable spec for ${packageName}`);
    }
  }
  const installedRuntime = [...runtimePackages].filter((packageName) => packageName in specs);
  if (installedRuntime.length > 1) {
    reject("runtime_bundle_conflict", `${path} contains multiple xuanling-tools runtime bundles`);
  }
  return snapshot;
}

function validateQuestion(event, contract, path) {
  if (event.question_id !== contract.id) {
    reject("question_order_invalid", `${path}.question_id must be ${contract.id}`);
  }
  const options = requireStringArray(event.options, `${path}.options`);
  if (!sameMembers(options, contract.options) || options.join("\0") !== contract.options.join("\0")) {
    reject("question_options_invalid", `${path}.options must be ${contract.options.join(", ")}`);
  }
  if (event.recommended !== contract.recommended) {
    reject("question_options_invalid", `${path}.recommended must be ${contract.recommended}`);
  }
  if (event.status === "answered") {
    if (!options.includes(event.answer)) {
      reject("question_answer_invalid", `${path}.answer must be one listed option`);
    }
  } else if (event.status === "cancelled") {
    if (event.answer !== undefined) {
      reject("question_answer_invalid", `${path} must omit answer when cancelled`);
    }
  } else {
    reject("invalid_transcript_schema", `${path}.status must be answered or cancelled`);
  }
}

function classifyCommand(event, profile, version) {
  const argv = requireStringArray(event.argv, "command.argv");
  if (argv.length === 0 || argv.some((part) => part.length === 0)) {
    reject("command_not_allowed", "command argv must contain non-empty direct arguments");
  }
  if (!Number.isInteger(event.exit_code)) {
    reject("invalid_transcript_schema", "command.exit_code must be an integer");
  }
  if (!["inventory", "apply", "rollback", "verify", "runtime"].includes(event.phase)) {
    reject("invalid_transcript_schema", "command.phase is invalid");
  }

  let classification;
  if (argv[0] === "dsh" && argv[1] === "plugin") {
    if (argv[2] !== "--profile" || argv[3] !== profile) {
      reject("profile_mismatch", `dsh plugin command must target ${profile}`);
    }
    const operation = argv[4];
    const operands = argv.slice(5);
    if (operation === "list" && operands.length === 0) {
      classification = { mutation: false, kind: "plugin_list", packages: [] };
    } else if (operation === "remove" && operands.length > 0) {
      if (operands.some((name) => !relevantPackages.has(name))) {
        reject("command_not_allowed", "plugin remove may only target XuanLing integration packages");
      }
      classification = { mutation: true, kind: "plugin_remove", packages: operands };
    } else if (operation === "add" && operands.length > 0) {
      for (const spec of operands) {
        const separator = spec.lastIndexOf("@");
        const packageName = spec.slice(0, separator);
        const packageVersion = spec.slice(separator + 1);
        if (!relevantPackages.has(packageName) || !stableSemver.test(packageVersion)) {
          reject("floating_package_spec", "plugin add accepts only exact XuanLing package specs");
        }
        if (event.phase !== "rollback" && packageVersion !== version) {
          reject("floating_package_spec", "apply commands must use the frozen resolved version");
        }
      }
      classification = { mutation: true, kind: "plugin_add", packages: operands };
    } else {
      reject("command_not_allowed", `unsupported dsh plugin operation: ${operation ?? "missing"}`);
    }
  } else if (
    argv.length === 4 && argv[0] === "dsh" && argv[1] === "--profile" &&
    argv[2] === profile && argv[3] === "--dump-config"
  ) {
    classification = { mutation: false, kind: "dump_config", packages: [] };
  } else if (
    argv.length === 7 && argv[0] === "dsh" && argv[1] === "--profile" &&
    argv[2] === "web" && argv[3] === "--no-open" && argv[4] === "--port" && argv[5] === "0"
  ) {
    reject("command_not_allowed", "web cold-start argv contains an unexpected trailing argument");
  } else if (
    argv.length === 6 && argv[0] === "dsh" && argv[1] === "--profile" &&
    argv[2] === "web" && argv[3] === "--no-open" && argv[4] === "--port" && argv[5] === "0"
  ) {
    if (profile !== "web") reject("profile_mismatch", "web cold-start cannot validate headless");
    classification = { mutation: false, kind: "cold_start", packages: [] };
  } else {
    reject("command_not_allowed", `command is outside the direct-argv allowlist: ${argv.join(" ")}`);
  }

  if (event.mutation !== classification.mutation) {
    reject("mutation_classification_invalid", `command mutation flag is wrong for ${classification.kind}`);
  }
  return classification;
}

function validateRuntime(events, profile, afterIndex) {
  const pluginList = events.findIndex((event, index) =>
    index > afterIndex && event.kind === "command" && event.command_kind === "plugin_list" && event.exit_code === 0);
  const dumpConfig = events.findIndex((event, index) =>
    index > pluginList && event.kind === "command" && event.command_kind === "dump_config" && event.exit_code === 0);
  if (pluginList === -1 || dumpConfig === -1) {
    reject("runtime_verification_incomplete", "plugin list and dump-config must pass after state convergence");
  }
  let cursor = dumpConfig;
  if (profile === "web") {
    const coldStart = events.findIndex((event, index) =>
      index > cursor && event.kind === "command" && event.command_kind === "cold_start" && event.exit_code === 0);
    if (coldStart === -1) reject("runtime_verification_incomplete", "web cold-start probe is missing");
    cursor = coldStart;
  }
  const restart = events.findIndex((event, index) =>
    index > cursor && event.kind === "restart_handoff" && event.status === "passed");
  const discovery = events.findIndex((event, index) =>
    index > restart && event.kind === "tool_discovery" && event.status === "passed" &&
    Array.isArray(event.tools) && event.tools.some((name) => /^mcp__xuanling__/.test(name)));
  const toolCall = events.findIndex((event, index) =>
    index > discovery && event.kind === "tool_call" && event.status === "passed" &&
    event.read_only === true && [
      "mcp__xuanling__system_info",
      "mcp__xuanling__memory_search",
      "mcp__xuanling__memory_get",
    ].includes(event.tool));
  if (restart === -1 || discovery === -1 || toolCall === -1) {
    reject("runtime_verification_incomplete", "restart, tool discovery, and harmless tool call must pass in order");
  }
}

function stableObjectJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableObjectJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableObjectJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotIdentity(snapshot) {
  return {
    profile: snapshot.profile,
    manifest_sha256: snapshot.manifest_sha256,
    config_sha256: snapshot.config_sha256,
    relevant_specs: snapshot.relevant_specs,
  };
}

export function verifyTranscript(candidate) {
  const transcript = requireRecord(candidate, "fixture");
  if (transcript.schema_version !== 1) {
    reject("invalid_transcript_schema", "fixture.schema_version must be 1");
  }
  const scenarioId = requireString(transcript.scenario_id, "fixture.scenario_id");
  const { acquisition } = validateSource(transcript.source);

  const host = requireRecord(transcript.host, "fixture.host");
  requireString(host.dsh_version, "fixture.host.dsh_version");
  if (host.isolated_home !== true) {
    reject("unsafe_profile_home", "fixture must prove an isolated DSH_HOME");
  }
  const redaction = requireRecord(transcript.redaction, "fixture.redaction");
  if (redaction.contains_secret !== false || redaction.default_memory_db_touched !== false) {
    reject("evidence_rejected", "fixture must be redacted and must not touch the default Memory DB");
  }

  const selection = requireRecord(transcript.selection, "fixture.selection");
  const profile = requireString(selection.profile, "fixture.selection.profile");
  const preset = requireString(selection.preset, "fixture.selection.preset");
  const version = requireString(selection.resolved_version, "fixture.selection.resolved_version");
  if (!INSTALLER_CONTRACT.questions.profile.options.includes(profile)) {
    reject("invalid_profile", `unsupported DSH profile: ${profile}`);
  }
  if (!(preset in INSTALLER_CONTRACT.presets)) {
    reject("invalid_preset", `unsupported XuanLing preset: ${preset}`);
  }
  if (!stableSemver.test(version)) {
    reject("release_set_incoherent", `resolved version is not a stable semver: ${version}`);
  }

  if (!Array.isArray(transcript.events) || transcript.events.length === 0) {
    reject("invalid_transcript_schema", "fixture.events must be a non-empty array");
  }
  const events = transcript.events.map((value, index) => {
    const event = requireRecord(value, `fixture.events[${index}]`);
    if (event.seq !== index + 1) {
      reject("event_sequence_invalid", `fixture.events[${index}].seq must be ${index + 1}`);
    }
    requireString(event.kind, `fixture.events[${index}].kind`);
    return { ...event };
  });
  if (events[0].kind !== "source_loaded") {
    reject("question_order_invalid", "source_loaded must be the first event");
  }

  const questions = events.filter((event) => event.kind === "question");
  if (questions.length !== 3) {
    reject("question_order_invalid", "profile, preset, and final confirmation questions are required");
  }
  validateQuestion(questions[0], INSTALLER_CONTRACT.questions.profile, "profile question");
  validateQuestion(questions[1], INSTALLER_CONTRACT.questions.preset, "preset question");
  validateQuestion(questions[2], INSTALLER_CONTRACT.questions.confirm, "confirmation question");
  if (questions[0].answer !== profile || questions[1].answer !== preset) {
    reject("question_answer_invalid", "recorded selection must match the question answers");
  }
  const questionIndexes = questions.map((question) => events.indexOf(question));
  if (!(questionIndexes[0] < questionIndexes[1] && questionIndexes[1] < questionIndexes[2])) {
    reject("question_order_invalid", "questions must appear in profile, preset, confirmation order");
  }

  const registryEvents = events.filter((event) => event.kind === "registry_resolved");
  if (registryEvents.length !== 1) {
    reject("release_set_incoherent", "registry version must be resolved exactly once");
  }
  const registry = registryEvents[0];
  const registryIndex = events.indexOf(registry);
  if (!(questionIndexes[1] < registryIndex && registryIndex < questionIndexes[2])) {
    reject("question_order_invalid", "registry resolution must follow preset and precede confirmation");
  }
  if (registry.version !== version || registry.registry !== "https://registry.npmjs.org") {
    reject("release_set_incoherent", "registry source/version must match the frozen selection");
  }
  const presetContract = INSTALLER_CONTRACT.presets[preset];
  const registryPackages = requireRecord(registry.packages, "registry_resolved.packages");
  const queriedPackages = [INSTALLER_CONTRACT.packages.launcher, ...presetContract.add];
  if (!sameMembers(Object.keys(registryPackages), queriedPackages)) {
    reject("release_set_incoherent", "registry resolution must cover launcher and selected bundles exactly");
  }
  for (const packageVersion of Object.values(registryPackages)) {
    if (packageVersion !== version) reject("release_set_incoherent", "registry versions are incoherent");
  }

  const inventoryEvents = events.filter((event) => event.kind === "inventory" && event.phase === "before");
  if (inventoryEvents.length !== 1) {
    reject("invalid_transcript_schema", "one before inventory snapshot is required");
  }
  const before = validateSnapshot(inventoryEvents[0], "before inventory", profile);
  const inventoryIndex = events.indexOf(inventoryEvents[0]);
  if (!(registryIndex < inventoryIndex && inventoryIndex < questionIndexes[2])) {
    reject("question_order_invalid", "inventory must follow version resolution and precede confirmation");
  }

  const expectedAddSpecs = presetContract.add.map((name) => exactSpec(name, version));
  const expectedRemoveSpecs = presetContract.remove
    .filter((name) => name in before.relevant_specs)
    .map((name) => before.relevant_specs[name]);
  const targetAlreadyMatched = presetContract.add.every((name) =>
    before.relevant_specs[name] === exactSpec(name, version)) && expectedRemoveSpecs.length === 0;
  const confirmation = requireRecord(questions[2].plan, "confirmation question.plan");
  if (
    confirmation.profile !== profile || confirmation.preset !== preset ||
    confirmation.resolved_version !== version ||
    confirmation.changes_required !== !targetAlreadyMatched
  ) {
    reject("confirmation_plan_mismatch", "final confirmation does not match the frozen selection/inventory");
  }
  if (!sameMembers(requireStringArray(confirmation.remove, "confirmation.plan.remove"), expectedRemoveSpecs)) {
    reject("confirmation_plan_mismatch", "final confirmation remove list does not match inventory conflicts");
  }
  if (!sameMembers(requireStringArray(confirmation.add, "confirmation.plan.add"), expectedAddSpecs)) {
    reject("confirmation_plan_mismatch", "final confirmation add list does not match the selected preset");
  }

  for (const event of events) {
    if (event.kind === "command") {
      const classification = classifyCommand(event, profile, version);
      event.command_kind = classification.kind;
    }
  }
  const mutationEvents = events.filter((event) => event.kind === "command" && event.mutation === true);
  if (mutationEvents.some((event) => events.indexOf(event) < questionIndexes[2])) {
    reject("side_effect_before_confirmation", "profile mutation occurred before final confirmation");
  }

  const terminal = requireRecord(transcript.terminal, "fixture.terminal");
  if (!terminalStatuses.has(terminal.status)) {
    reject("terminal_status_invalid", `unsupported terminal status: ${terminal.status ?? "missing"}`);
  }
  if (terminal.profile_mutation_count !== mutationEvents.length) {
    reject("mutation_count_mismatch", "terminal profile_mutation_count does not match command evidence");
  }

  if (questions[2].status === "cancelled" || questions[2].answer === "cancel") {
    if (terminal.status !== "cancelled_before_side_effect" || mutationEvents.length !== 0) {
      reject("cancelled_with_side_effect", "cancelled flow must terminate with zero mutation");
    }
  } else {
    if (questions[2].status !== "answered" || questions[2].answer !== "proceed") {
      reject("question_answer_invalid", "final confirmation must be proceed or cancelled");
    }
    if (terminal.status === "cancelled_before_side_effect") {
      reject("terminal_status_invalid", "confirmed flow cannot use the cancelled terminal");
    }
  }

  const afterEvents = events.filter((event) => event.kind === "inventory" && event.phase === "after");
  if (["installed_verified", "verified_noop"].includes(terminal.status)) {
    if (afterEvents.length !== 1) reject("runtime_verification_incomplete", "one after snapshot is required");
    const after = validateSnapshot(afterEvents[0], "after inventory", profile);
    for (const packageName of presetContract.add) {
      assertExactSpec(after.relevant_specs[packageName], packageName, version, "target_state_mismatch");
    }
    for (const packageName of presetContract.remove) {
      if (packageName in after.relevant_specs) {
        reject("target_state_mismatch", `conflicting package remains installed: ${packageName}`);
      }
    }
    if (Object.keys(after.relevant_specs).some((name) => !presetContract.add.includes(name))) {
      reject("target_state_mismatch", "after state contains an unexpected XuanLing package");
    }
    if (terminal.status === "verified_noop") {
      if (!targetAlreadyMatched || mutationEvents.length !== 0) {
        reject("noop_mutated_profile", "verified_noop requires an already matched state and zero mutation");
      }
      if (stableObjectJson(snapshotIdentity(before)) !== stableObjectJson(snapshotIdentity(after))) {
        reject("noop_mutated_profile", "verified_noop changed the profile snapshot");
      }
    } else if (mutationEvents.length === 0 || mutationEvents.some((event) => event.exit_code !== 0)) {
      reject("target_state_mismatch", "installed_verified requires successful mutation evidence");
    }
    validateRuntime(events, profile, events.indexOf(afterEvents[0]));
  } else if (terminal.status === "rolled_back") {
    const failedApply = mutationEvents.find((event) => event.phase === "apply" && event.exit_code !== 0);
    const rollbackCommands = mutationEvents.filter((event) => event.phase === "rollback");
    const rollbackState = events.filter((event) => event.kind === "inventory" && event.phase === "rollback");
    if (!failedApply || rollbackCommands.length === 0 || rollbackCommands.some((event) => event.exit_code !== 0)) {
      reject("rollback_evidence_incomplete", "rolled_back requires failed apply and successful rollback commands");
    }
    if (rollbackState.length !== 1) {
      reject("rollback_evidence_incomplete", "rolled_back requires one restored snapshot");
    }
    const restored = validateSnapshot(rollbackState[0], "rollback inventory", profile);
    if (stableObjectJson(snapshotIdentity(before)) !== stableObjectJson(snapshotIdentity(restored))) {
      reject("rollback_state_mismatch", "rollback snapshot does not equal the before state");
    }
    if (events.some((event) => ["restart_handoff", "tool_discovery", "tool_call"].includes(event.kind))) {
      reject("rollback_evidence_incomplete", "rolled-back flow must not continue into runtime acceptance");
    }
  }

  const report = {
    schema_version: 1,
    scenario_id: scenarioId,
    transcript_sha256: createHash("sha256").update(stableObjectJson(transcript)).digest("hex"),
    profile,
    preset,
    resolved_version: version,
    terminal_status: terminal.status,
    event_count: events.length,
    profile_mutation_count: mutationEvents.length,
    source_acquisition: acquisition.method,
    source_verified: true,
    redaction_verified: true,
  };
  return report;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--fixture") {
    reject("invalid_arguments", "usage: verify-dsh-conversational-install.mjs --fixture <path>");
  }
  return argv[1];
}

function main() {
  try {
    const fixturePath = parseArgs(process.argv.slice(2));
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    process.stdout.write(`${JSON.stringify(verifyTranscript(fixture))}\n`);
  } catch (error) {
    const code = error instanceof TranscriptContractError ? error.code : "verifier_internal_error";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-conversational-install-verifier: ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
