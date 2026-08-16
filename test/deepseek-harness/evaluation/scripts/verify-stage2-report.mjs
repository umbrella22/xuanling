#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const scriptDir = import.meta.dirname;
const analyzerPath = path.join(scriptDir, "analyze-filesystem-evaluation.mjs");
const fixtureVerifierPath = path.join(scriptDir, "verify-filesystem-fixture.mjs");
const REPORT_SCHEMA = "xuanling-dsh-filesystem-safety-stage2-report/v2";
const EVALUATION_SCHEMA = "xuanling-dsh-filesystem-safety-stage2/v2";
const EXPECTED_POPULATION = { arms: ["A", "B", "C"], quality_runs: 3, cache_pairs: 1 };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} does not match recomputed current-policy evidence`);
  }
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function jsonFile(file, label) {
  if (!existsSync(file)) throw new Error(`${label} missing: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function runJson(script, args, label) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 1600);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function assertWithin(root, file, label) {
  const relative = path.relative(root, file);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes the supplied evidence root`);
}

function oneDecimal(value) {
  return Number(value.toFixed(1));
}

function emptyToolResults() {
  return {
    count: 0,
    model_visible_bytes: 0,
    error_count: 0,
    retry_after_error_count: 0,
    error_codes: {},
    by_family: {},
  };
}

function mergeToolResults(target, source) {
  target.count += source.count;
  target.model_visible_bytes += source.model_visible_bytes;
  target.error_count += source.error_count;
  target.retry_after_error_count += source.retry_after_error_count;
  for (const [code, count] of Object.entries(source.error_codes)) {
    target.error_codes[code] = (target.error_codes[code] ?? 0) + count;
  }
  for (const [family, metrics] of Object.entries(source.by_family)) {
    target.by_family[family] ??= {
      count: 0,
      model_visible_bytes: 0,
      error_count: 0,
      retry_after_error_count: 0,
    };
    for (const key of ["count", "model_visible_bytes", "error_count", "retry_after_error_count"]) {
      target.by_family[family][key] += metrics[key];
    }
  }
}

function reportManifest(text) {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const manifests = [];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.schema === REPORT_SCHEMA) manifests.push(parsed);
    } catch {
      // Other JSON examples do not participate in the report contract.
    }
  }
  if (manifests.length === 0) throw new Error("current-policy Stage 2 v2 evidence manifest missing");
  if (manifests.length > 1) throw new Error("more than one current-policy Stage 2 v2 evidence manifest found");
  return manifests[0];
}

function verifyTrialWorkspace(root, trial) {
  const workspace = path.join(
    path.dirname(trial.session_log),
    trial.label.startsWith("cache/") ? "workspace-snapshot" : "workspace",
  );
  assertWithin(root, workspace, `${trial.label} fixture workspace`);
  const verdict = runJson(
    fixtureVerifierPath,
    ["--workspace", workspace],
    `independent fixture oracle for ${trial.label}`,
  );
  if (verdict.pass !== true) throw new Error(`${trial.label} fails the independent fixture oracle`);
  return workspace;
}

function routeFor(trials) {
  const routes = new Set();
  for (const trial of trials) {
    if (trial.observed_providers?.length !== 1 || trial.observed_models?.length !== 1
      || trial.observed_efforts?.length !== 1) {
      throw new Error(`${trial.label} has ambiguous route metadata`);
    }
    routes.add(canonical({
      provider: trial.observed_providers[0],
      model: trial.observed_models[0],
      reasoning_effort: trial.observed_efforts[0],
    }));
  }
  if (routes.size !== 1) throw new Error("current-policy population contains more than one model route");
  return JSON.parse([...routes][0]);
}

function derive(rootArg) {
  const root = path.resolve(rootArg);
  if (!existsSync(root)) throw new Error(`evidence root missing: ${root}`);
  const analyzed = runJson(
    analyzerPath,
    ["--root", root, "--verify", "--arms", "A,B,C", "--quality-runs", "3", "--cache-pairs", "1"],
    "strict analyzer v8",
  );
  if (analyzed.analyzer_version !== 8) throw new Error("current-policy evidence requires analyzer version 8");
  if (!Array.isArray(analyzed.trials) || analyzed.trials.length !== 15) {
    throw new Error("strict analyzer did not produce the required 15 current-policy trials");
  }

  const runSummary = jsonFile(path.join(root, "run-summary.json"), "run summary");
  if (runSummary.evaluation_schema !== EVALUATION_SCHEMA) {
    throw new Error(`current-policy run schema must be ${EVALUATION_SCHEMA}`);
  }
  if (runSummary.credential_source !== "file_reference" && runSummary.credential_source !== "environment") {
    throw new Error("run summary has no typed current-policy credential source");
  }
  if (!/^[0-9a-f]{64}$/.test(runSummary.strict_overwrite_policy_sha256 ?? "")) {
    throw new Error("run summary has no strict overwrite policy hash");
  }
  if (!Array.isArray(runSummary.trials) || runSummary.trials.length !== analyzed.trials.length) {
    throw new Error("run summary does not contain the analyzer trial population");
  }
  const summaryByLabel = new Map(runSummary.trials.map((trial) => [trial.label, trial]));
  const metaByLabel = new Map();
  const policyKeys = new Set();
  const credentialSources = new Set();
  const taskHashes = new Set();
  const workspaces = new Set();
  let secretRedactions = 0;

  for (const trial of analyzed.trials) {
    const summary = summaryByLabel.get(trial.label);
    if (summary === undefined) throw new Error(`run summary missing ${trial.label}`);
    if (summary.incomplete || summary.exit?.code !== 0 || summary.exit?.signal !== null
      || summary.exit?.spawnError !== null || summary.oracle_pass !== true) {
      throw new Error(`${trial.label} was not a complete successful runner collection`);
    }
    if (!trial.complete || trial.oracle?.pass !== true || trial.route_problems.length !== 0
      || trial.usage === "unknown" || trial.tool_result_problems.length !== 0) {
      throw new Error(`${trial.label} does not satisfy the analyzer v8 completion contract`);
    }
    assertWithin(root, trial.session_log, `${trial.label} session log`);
    const meta = jsonFile(path.join(path.dirname(trial.session_log), "meta.json"), `${trial.label} metadata`);
    if (meta.evaluation_schema !== EVALUATION_SCHEMA || meta.label !== trial.label || meta.incomplete !== false) {
      throw new Error(`${trial.label} metadata is not current-policy Stage 2 evidence`);
    }
    if (!Number.isFinite(meta.duration_ms) || meta.duration_ms < 0 || meta.secret_redactions !== 0) {
      throw new Error(`${trial.label} metadata has invalid duration or credential redaction evidence`);
    }
    if (meta.credential_source !== "file_reference" && meta.credential_source !== "environment") {
      throw new Error(`${trial.label} metadata has no typed credential source`);
    }
    const expectedScanMode = meta.credential_source === "file_reference" ? "credential_shape" : "exact_value";
    if (meta.secret_scan_mode !== expectedScanMode) {
      throw new Error(`${trial.label} credential scan mode does not match its source kind`);
    }
    const policy = {
      evaluation_schema: meta.evaluation_schema,
      skills_bundle_sha256: meta.skills_bundle_sha256,
      strict_overwrite_policy_sha256: meta.strict_overwrite_policy_sha256,
      common_patch_sha256: meta.common_patch_sha256,
      arm_patch_sha256: meta.arm_patch_sha256,
      arm: trial.arm,
    };
    for (const [key, value] of Object.entries(policy)) {
      if (key !== "evaluation_schema" && key !== "arm" && !/^[0-9a-f]{64}$/.test(value ?? "")) {
        throw new Error(`${trial.label} metadata has invalid ${key}`);
      }
    }
    policyKeys.add(canonical(policy));
    credentialSources.add(meta.credential_source);
    taskHashes.add(meta.task_sha256);
    secretRedactions += meta.secret_redactions;
    metaByLabel.set(trial.label, meta);
    const workspace = verifyTrialWorkspace(root, trial);
    if (workspaces.has(workspace)) throw new Error(`${trial.label} reuses another trial's retained workspace`);
    workspaces.add(workspace);
  }
  if (credentialSources.size !== 1) throw new Error("current-policy population mixes credential source kinds");
  if (!credentialSources.has(runSummary.credential_source)) {
    throw new Error("run summary credential source does not match trial metadata");
  }
  if (taskHashes.size !== 1 || !/^[0-9a-f]{64}$/.test([...taskHashes][0] ?? "")) {
    throw new Error("current-policy population has inconsistent task hashes");
  }

  const policyByArm = {};
  let sharedPolicy = null;
  for (const serialized of policyKeys) {
    const entry = JSON.parse(serialized);
    policyByArm[entry.arm] ??= new Set();
    policyByArm[entry.arm].add(entry.arm_patch_sha256);
    const common = {
      evaluation_schema: entry.evaluation_schema,
      skills_bundle_sha256: entry.skills_bundle_sha256,
      strict_overwrite_policy_sha256: entry.strict_overwrite_policy_sha256,
      common_patch_sha256: entry.common_patch_sha256,
    };
    if (sharedPolicy === null) sharedPolicy = common;
    else equal(common, sharedPolicy, "shared policy hashes");
  }
  const armPatchSha256 = {};
  for (const arm of EXPECTED_POPULATION.arms) {
    if (policyByArm[arm]?.size !== 1) throw new Error(`${arm} has inconsistent arm patch hashes`);
    armPatchSha256[arm] = [...policyByArm[arm]][0];
  }
  if (sharedPolicy.strict_overwrite_policy_sha256 !== runSummary.strict_overwrite_policy_sha256) {
    throw new Error("run summary strict overwrite policy hash does not match trial metadata");
  }

  const arms = {};
  const allToolResults = emptyToolResults();
  const cachePairs = [];
  for (const arm of EXPECTED_POPULATION.arms) {
    const trials = analyzed.trials.filter((trial) => trial.arm === arm);
    const quality = trials.filter((trial) => trial.label.startsWith(`quality/${arm}/`));
    const cold = trials.find((trial) => trial.label === `cache/${arm}/pair-1/cold`);
    const warm = trials.find((trial) => trial.label === `cache/${arm}/pair-1/warm`);
    if (trials.length !== 5 || quality.length !== 3 || cold === undefined || warm === undefined) {
      throw new Error(`${arm} does not contain the required quality and cache population`);
    }
    const durationTotal = trials.reduce((total, trial) => total + metaByLabel.get(trial.label).duration_ms, 0);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const toolResults = emptyToolResults();
    for (const trial of trials) {
      for (const key of Object.keys(usage)) usage[key] += trial.usage[key];
      mergeToolResults(toolResults, trial.tool_results);
      mergeToolResults(allToolResults, trial.tool_results);
    }
    arms[arm] = {
      total_trials: trials.length,
      quality_trials: quality.length,
      quality_oracle_passed: quality.filter((trial) => trial.oracle?.pass === true).length,
      complete: trials.filter((trial) => trial.complete).length,
      oracle_passed: trials.filter((trial) => trial.oracle?.pass === true).length,
      route_valid: trials.filter((trial) => trial.route_problems.length === 0).length,
      usage_known: trials.filter((trial) => trial.usage !== "unknown").length,
      duration_ms: { total: durationTotal, average: oneDecimal(durationTotal / trials.length) },
      usage,
      tool_calls: analyzed.arms[arm].tool_calls,
      tool_results: toolResults,
    };
    cachePairs.push({
      arm,
      request_prefix_sha256: cold.request_prefix_sha256,
      cold_usage: cold.usage,
      warm_usage: warm.usage,
    });
  }

  return {
    schema: REPORT_SCHEMA,
    evidence_root: root,
    population: EXPECTED_POPULATION,
    analyzer_version: analyzed.analyzer_version,
    frozen_route: routeFor(analyzed.trials),
    credential_source: [...credentialSources][0],
    fixture: { task_sha256: [...taskHashes][0] },
    policy: { ...sharedPolicy, arm_patch_sha256: armPatchSha256 },
    coverage: {
      total_trials: analyzed.trials.length,
      oracle_passed: analyzed.trials.filter((trial) => trial.oracle?.pass === true).length,
      route_valid: analyzed.trials.filter((trial) => trial.route_problems.length === 0).length,
      usage_known: analyzed.trials.filter((trial) => trial.usage !== "unknown").length,
      cache_read_share: analyzed.cache_read_share,
      secret_redactions: secretRedactions,
      tool_results: allToolResults,
    },
    arms,
    cache_pairs: cachePairs,
  };
}

function verifyStage3(manifest, derived) {
  const stage3 = object(manifest.stage3, "stage3 decision");
  const triggers = object(stage3.triggers, "stage3 triggers");
  const expectedNames = ["multi_host_strict_policy", "dispatch_bypass", "fs16_contract_gap"];
  const statuses = [];
  for (const name of expectedNames) {
    const trigger = object(triggers[name], `stage3 trigger ${name}`);
    if (!["triggered", "not_triggered", "unknown"].includes(trigger.status)) {
      throw new Error(`stage3 trigger ${name} has an invalid status`);
    }
    if (typeof trigger.evidence !== "string" || trigger.evidence.length === 0) {
      throw new Error(`stage3 trigger ${name} requires an evidence reference`);
    }
    statuses.push(trigger.status);
  }
  const expectedStatus = statuses.includes("triggered")
    ? "triggered"
    : statuses.includes("unknown")
      ? "unknown"
      : "not_triggered_deferred";
  if (stage3.status !== expectedStatus) throw new Error("stage3 overall status does not match its trigger statuses");
  const bOracleFailures = derived.arms.B.quality_trials - derived.arms.B.quality_oracle_passed;
  if (triggers.fs16_contract_gap.status === "not_triggered" && bOracleFailures >= 2) {
    throw new Error("fs16_contract_gap cannot be not_triggered with at least two B oracle failures");
  }
  return stage3.status;
}

function verify(reportArg, rootArg) {
  const reportPath = path.resolve(reportArg);
  const root = path.resolve(rootArg);
  if (!existsSync(reportPath)) throw new Error(`report missing: ${reportPath}`);
  const manifest = object(reportManifest(readFileSync(reportPath, "utf8")), "Stage 2 manifest");
  if (manifest.evidence_root !== root) throw new Error("evidence_root does not equal the supplied current-policy root");
  const derived = derive(root);
  for (const key of [
    "schema", "evidence_root", "population", "analyzer_version", "frozen_route",
    "credential_source", "fixture", "policy", "coverage", "arms", "cache_pairs",
  ]) {
    equal(manifest[key], derived[key], key);
  }
  const stage3Status = verifyStage3(manifest, derived);
  const decision = object(manifest.decision, "decision");
  if (decision.stage2_status !== "accepted" || decision.stage3_status !== stage3Status
    || decision.production_change !== false) {
    throw new Error("decision must accept verified Stage 2, match Stage 3, and apply no production change");
  }
  return {
    report: reportPath,
    evidence_root: root,
    verified: true,
    trials: derived.coverage.total_trials,
    analyzer_version: derived.analyzer_version,
    stage3_status: stage3Status,
  };
}

try {
  if (process.argv[2] === "--derive" && process.argv.length === 4) {
    process.stdout.write(`${JSON.stringify(derive(process.argv[3]), null, 2)}\n`);
  } else if (process.argv.length === 4) {
    process.stdout.write(`${JSON.stringify(verify(process.argv[2], process.argv[3]), null, 2)}\n`);
  } else {
    throw new Error("usage: verify-stage2-report.mjs <report.md> <evaluation-root> | --derive <evaluation-root>");
  }
} catch (error) {
  process.stderr.write(`verify-stage2-report: ${error.message}\n`);
  process.exit(1);
}
