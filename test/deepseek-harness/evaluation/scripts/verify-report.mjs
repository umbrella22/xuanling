#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const analyzerPath = path.join(scriptDir, "analyze-filesystem-evaluation.mjs");
const fixtureVerifierPath = path.join(scriptDir, "verify-filesystem-fixture.mjs");
const reportSchema = "xuanling-dsh-filesystem-evaluation-report/v1";
const expectedPopulation = { arms: ["A", "B", "C"], quality_runs: 3, cache_pairs: 1 };
const profileNames = new Set(["memory_native_fs", "memory_xuanling_fs", "memory_hybrid"]);

function fail(message) {
  process.stderr.write(`verify-report: ${message}\n`);
  process.exit(1);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} does not match the recomputed evidence`);
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

function reportManifest(text) {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const manifests = [];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.schema === reportSchema) manifests.push(parsed);
    } catch {
      // Other JSON examples in the report do not participate in this contract.
    }
  }
  if (manifests.length === 0) throw new Error("v1 evidence manifest missing");
  if (manifests.length > 1) throw new Error("more than one v1 evidence manifest found");
  return manifests[0];
}

function runJson(script, args, label) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 1200);
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

function verifyTrialWorkspaces(root, trials) {
  const workspaces = new Set();
  const verdicts = [];
  for (const trial of trials) {
    const workspace = path.join(
      path.dirname(trial.session_log),
      trial.label.startsWith("cache/") ? "workspace-snapshot" : "workspace",
    );
    assertWithin(root, workspace, `${trial.label} fixture workspace`);
    if (workspaces.has(workspace)) throw new Error(`${trial.label} reuses another trial's fixture workspace`);
    workspaces.add(workspace);
    const verdict = runJson(fixtureVerifierPath, ["--workspace", workspace], `independent fixture oracle for ${trial.label}`);
    verdicts.push({ ...verdict, label: trial.label, workspace });
  }
  return {
    total: verdicts.length,
    passed: verdicts.filter((verdict) => verdict.pass === true).length,
    failed: verdicts.filter((verdict) => verdict.pass !== true).length,
    verdicts,
  };
}

function main() {
  const [reportArg, rootArg] = process.argv.slice(2);
  if (!reportArg || !rootArg || process.argv.length !== 4) {
    throw new Error("usage: verify-report.mjs <report.md> <evaluation-root>");
  }

  const reportPath = path.resolve(reportArg);
  const root = path.resolve(rootArg);
  if (!existsSync(reportPath)) throw new Error(`report missing: ${reportPath}`);
  const manifest = object(reportManifest(readFileSync(reportPath, "utf8")), "evidence manifest");
  equal(manifest.population, expectedPopulation, "population");
  if (manifest.evidence_root !== root) throw new Error("evidence_root does not equal the supplied evaluation root");

  const analyzed = runJson(
    analyzerPath,
    ["--root", root, "--verify", "--arms", "A,B,C", "--quality-runs", "3", "--cache-pairs", "1"],
    "strict analyzer",
  );
  const runSummary = jsonFile(path.join(root, "run-summary.json"), "run summary");

  if (manifest.analyzer_version !== analyzed.analyzer_version) {
    throw new Error("analyzer_version does not match the raw evidence");
  }
  if (!Array.isArray(analyzed.trials) || analyzed.trials.length !== 15) {
    throw new Error("strict analyzer did not produce the required 15 trials");
  }
  if (!Array.isArray(runSummary.trials) || runSummary.trials.length !== analyzed.trials.length) {
    throw new Error("run summary does not contain the analyzer trial population");
  }

  const summaryByLabel = new Map(runSummary.trials.map((trial) => [trial.label, trial]));
  const metaByLabel = new Map();
  const routeKeys = new Set();
  let metaSecretRedactions = 0;
  let toolErrors = 0;
  for (const trial of analyzed.trials) {
    const summary = summaryByLabel.get(trial.label);
    if (!summary) throw new Error(`run summary missing ${trial.label}`);
    if (summary.incomplete || summary.exit?.code !== 0 || summary.exit?.signal !== null || summary.exit?.spawnError !== null) {
      throw new Error(`${trial.label} was not a complete successful runner collection`);
    }
    if (summary.oracle_pass !== true || trial.oracle?.pass !== true) {
      throw new Error(`${trial.label} lacks a passing runner/oracle verdict`);
    }
    assertWithin(root, trial.session_log, `${trial.label} session log`);
    const metaPath = path.join(path.dirname(trial.session_log), "meta.json");
    const meta = jsonFile(metaPath, `${trial.label} metadata`);
    if (meta.label !== trial.label || meta.incomplete !== false || meta.secret_redactions !== 0) {
      throw new Error(`${trial.label} metadata does not satisfy the collection/redaction contract`);
    }
    metaByLabel.set(trial.label, meta);
    metaSecretRedactions += meta.secret_redactions;
    toolErrors += trial.errors + trial.tool_call_parse_failures;
    const route = {
      provider: trial.observed_providers?.[0],
      model: trial.observed_models?.[0],
      reasoning_effort: trial.observed_efforts?.[0],
    };
    if (trial.observed_providers?.length !== 1 || trial.observed_models?.length !== 1 || trial.observed_efforts?.length !== 1) {
      throw new Error(`${trial.label} has ambiguous route metadata`);
    }
    routeKeys.add(canonical(route));
  }
  if (routeKeys.size !== 1) throw new Error("raw evidence contains more than one model route");
  const route = JSON.parse([...routeKeys][0]);
  equal(manifest.frozen_route, route, "frozen route");
  const fixtures = verifyTrialWorkspaces(root, analyzed.trials);

  const arms = {};
  const cachePairs = [];
  const decisionReferences = new Set();
  for (const arm of expectedPopulation.arms) {
    const trials = analyzed.trials.filter((trial) => trial.arm === arm);
    const quality = trials.filter((trial) => trial.label.startsWith("quality/"));
    const cold = trials.find((trial) => trial.label === `cache/${arm}/pair-1/cold`);
    const warm = trials.find((trial) => trial.label === `cache/${arm}/pair-1/warm`);
    if (trials.length !== 5 || quality.length !== 3 || !cold || !warm || cold.usage === "unknown" || warm.usage === "unknown") {
      throw new Error(`${arm} does not contain the required quality and cache population`);
    }
    const duration = trials.reduce((total, trial) => total + metaByLabel.get(trial.label).duration_ms, 0) / trials.length;
    arms[arm] = {
      total_trials: trials.length,
      quality_trials: quality.length,
      complete: trials.filter((trial) => trial.complete).length,
      oracle_passed: trials.filter((trial) => trial.oracle?.pass === true).length,
      route_valid: trials.filter((trial) => trial.route_problems.length === 0).length,
      usage_known: trials.filter((trial) => trial.usage !== "unknown").length,
      average_duration_ms: oneDecimal(duration),
      tool_calls: analyzed.arms?.[arm]?.tool_calls,
    };
    cachePairs.push({
      arm,
      request_prefix_sha256: cold.request_prefix_sha256,
      cold_input_tokens: cold.usage.inputTokens,
      warm_input_tokens: warm.usage.inputTokens,
      cold_cache_read_tokens: cold.usage.cacheReadTokens,
      warm_cache_read_tokens: warm.usage.cacheReadTokens,
    });
    decisionReferences.add(`quality/${arm}/oracle_passed`);
    decisionReferences.add(`tools/${arm}/native_fs`);
    decisionReferences.add(`tools/${arm}/xuanling_fs`);
    decisionReferences.add(`cache/${arm}/prefix_match`);
  }
  equal(manifest.arms, arms, "arm aggregates");
  equal(manifest.cache_pairs, cachePairs, "cache pairs");
  equal(
    manifest.coverage,
    {
      total_trials: analyzed.trials.length,
      oracle_passed: fixtures.passed,
      cache_read_share: analyzed.cache_read_share,
      secret_redactions: metaSecretRedactions,
      tool_errors: toolErrors,
    },
    "coverage",
  );
  if (fixtures.total !== 15 || fixtures.passed !== 15 || fixtures.failed !== 0) {
    throw new Error("independent fixture oracle did not pass all 15 retained workspaces");
  }

  const decision = object(manifest.decision, "decision");
  if (decision.status !== "candidate_not_applied" || decision.production_change !== false) {
    throw new Error("decision must remain an unapplied candidate");
  }
  for (const field of ["default_profile", "conditional_profile", "hybrid_profile"]) {
    if (!profileNames.has(decision[field])) throw new Error(`decision.${field} is not a supported profile name`);
  }
  if (!Array.isArray(decision.evidence_refs) || decision.evidence_refs.length === 0) {
    throw new Error("decision requires at least one evidence reference");
  }
  for (const reference of decision.evidence_refs) {
    if (!decisionReferences.has(reference)) throw new Error(`decision reference is not an observed metric: ${reference}`);
  }

  process.stdout.write(`${JSON.stringify({
    report: reportPath,
    evidence_root: root,
    verified: true,
    trials: analyzed.trials.length,
    cache_read_share: analyzed.cache_read_share,
    decision_status: decision.status,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
