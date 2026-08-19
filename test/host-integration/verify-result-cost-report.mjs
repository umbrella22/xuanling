#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stderr.write(`result-cost-verifier: ${message}\n`);
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(value, allowed, location) {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${location} has unsupported fields: ${extras.join(", ")}`);
}

function parseArgs(argv) {
  if (argv.length !== 2 || !["--analyze", "--verify"].includes(argv[0]) || !argv[1]) {
    throw new Error("usage: verify-result-cost-report.mjs --analyze <evidence> | --verify <report>");
  }
  return { mode: argv[0], path: argv[1] };
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

function validateEvidence(evidence) {
  assertExactFields(
    evidence,
    ["schema_version", "evidence_id", "evidence_kind", "host", "host_version", "source_contract", "catalog", "trials"],
    "evidence",
  );
  if (evidence.schema_version !== 1) throw new Error("evidence.schema_version must be 1");
  for (const field of ["evidence_id", "evidence_kind", "host", "host_version"]) {
    if (typeof evidence[field] !== "string" || evidence[field].length === 0) {
      throw new Error(`evidence.${field} must be a non-empty string`);
    }
  }
  if (evidence.source_contract !== undefined) {
    assertExactFields(
      evidence.source_contract,
      [
        "snapshot_sha256",
        "installed_mcp_json_sha256",
        "formatter_source_sha256",
        "dsh_revision",
        "catalog_projection",
      ],
      "evidence.source_contract",
    );
    for (const field of Object.keys(evidence.source_contract)) {
      if (typeof evidence.source_contract[field] !== "string") {
        throw new Error(`evidence.source_contract.${field} must be a string`);
      }
    }
  }

  assertExactFields(evidence.catalog, ["tools", "schema_tokens", "prefix_digests"], "catalog");
  if (!Array.isArray(evidence.catalog.tools) || evidence.catalog.tools.length === 0) {
    throw new Error("catalog.tools must be a non-empty array");
  }
  for (const [index, tool] of evidence.catalog.tools.entries()) {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new Error(`catalog.tools[${index}] must be an object with a string name`);
    }
  }
  assertExactFields(evidence.catalog.schema_tokens, ["value", "source"], "catalog.schema_tokens");
  if (
    evidence.catalog.schema_tokens.value !== null &&
    (!Number.isInteger(evidence.catalog.schema_tokens.value) || evidence.catalog.schema_tokens.value < 0)
  ) {
    throw new Error("catalog.schema_tokens.value must be null or a non-negative integer");
  }
  if (typeof evidence.catalog.schema_tokens.source !== "string" || evidence.catalog.schema_tokens.source.length === 0) {
    throw new Error("catalog.schema_tokens.source must be a non-empty string");
  }
  if (
    !Array.isArray(evidence.catalog.prefix_digests) ||
    evidence.catalog.prefix_digests.length < 3 ||
    evidence.catalog.prefix_digests.some((digest) => !/^[0-9a-f]{64}$/.test(digest))
  ) {
    throw new Error("catalog.prefix_digests must contain at least three SHA-256 values");
  }

  if (!Array.isArray(evidence.trials) || evidence.trials.length === 0) {
    throw new Error("evidence.trials must be a non-empty array");
  }
  for (const [trialIndex, trial] of evidence.trials.entries()) {
    assertExactFields(
      trial,
      ["trial_id", "task_id", "phase", "usage_candidates", "tool_results"],
      `trials[${trialIndex}]`,
    );
    if (typeof trial.trial_id !== "string" || typeof trial.task_id !== "string") {
      throw new Error(`trials[${trialIndex}] ids must be strings`);
    }
    if (!["cold", "warm"].includes(trial.phase)) {
      throw new Error(`trials[${trialIndex}].phase must be cold or warm`);
    }
    if (!Array.isArray(trial.usage_candidates)) {
      throw new Error(`trials[${trialIndex}].usage_candidates must be an array`);
    }
    for (const [usageIndex, usage] of trial.usage_candidates.entries()) {
      assertExactFields(
        usage,
        ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
        `trials[${trialIndex}].usage_candidates[${usageIndex}]`,
      );
      for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
        if (!Number.isInteger(usage[field]) || usage[field] < 0) {
          throw new Error(`trials[${trialIndex}].usage_candidates[${usageIndex}].${field} must be a non-negative integer`);
        }
      }
    }
    if (!Array.isArray(trial.tool_results)) {
      throw new Error(`trials[${trialIndex}].tool_results must be an array`);
    }
    for (const [resultIndex, result] of trial.tool_results.entries()) {
      assertExactFields(
        result,
        ["call_id", "tool_name", "retry_of", "wire_payload", "model_text", "structured_payload", "ui_text"],
        `trials[${trialIndex}].tool_results[${resultIndex}]`,
      );
      for (const field of ["call_id", "tool_name", "model_text"]) {
        if (typeof result[field] !== "string") {
          throw new Error(`trials[${trialIndex}].tool_results[${resultIndex}].${field} must be a string`);
        }
      }
      if (result.ui_text !== null && typeof result.ui_text !== "string") {
        throw new Error(`trials[${trialIndex}].tool_results[${resultIndex}].ui_text must be null or a string`);
      }
      if (result.retry_of !== null && typeof result.retry_of !== "string") {
        throw new Error(`trials[${trialIndex}].tool_results[${resultIndex}].retry_of must be null or a string`);
      }
      if (!isRecord(result.wire_payload) || !isRecord(result.structured_payload)) {
        throw new Error(`trials[${trialIndex}].tool_results[${resultIndex}] lacks wire/structured evidence`);
      }
      if (!isDeepStrictEqual(result.wire_payload.structuredContent, result.structured_payload)) {
        throw new Error(`trials[${trialIndex}].tool_results[${resultIndex}] structured projection drift`);
      }
    }
  }
}

function analyzeUsage(trials, problems) {
  const phases = { cold: [], warm: [] };
  for (const trial of trials) {
    if (trial.usage_candidates.length !== 1) {
      problems.push(`${trial.trial_id}:usage_candidates=${trial.usage_candidates.length}`);
      continue;
    }
    phases[trial.phase].push(trial.usage_candidates[0]);
  }
  if (problems.some((problem) => problem.includes("usage_candidates="))) {
    return {
      status: "unknown",
      reason: "missing_or_ambiguous_provider_usage",
      cold_input_tokens: null,
      warm_input_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      output_tokens: null,
    };
  }
  const sum = (entries, field) => entries.reduce((total, entry) => total + entry[field], 0);
  return {
    status: "known",
    reason: null,
    cold_input_tokens: sum(phases.cold, "inputTokens"),
    warm_input_tokens: sum(phases.warm, "inputTokens"),
    cache_read_tokens: sum([...phases.cold, ...phases.warm], "cacheReadTokens"),
    cache_write_tokens: sum([...phases.cold, ...phases.warm], "cacheWriteTokens"),
    output_tokens: sum([...phases.cold, ...phases.warm], "outputTokens"),
  };
}

function analyzePairing(trials, problems) {
  const taskPhases = new Map();
  for (const trial of trials) {
    const phases = taskPhases.get(trial.task_id) ?? [];
    phases.push(trial.phase);
    taskPhases.set(trial.task_id, phases);
  }
  for (const [task, phases] of taskPhases) {
    if (phases.filter((phase) => phase === "cold").length !== 1 || phases.filter((phase) => phase === "warm").length !== 1) {
      problems.push(`${task}:requires_one_cold_and_one_warm`);
    }
  }
}

export function buildResultCostReport(evidence, evidenceBytes) {
  validateEvidence(evidence);
  const problems = [];
  const prefixStable = evidence.catalog.prefix_digests.every(
    (digest) => digest === evidence.catalog.prefix_digests[0],
  );
  if (!prefixStable) problems.push("catalog:prefix_digest_drift");
  const schemaTokensKnown = evidence.catalog.schema_tokens.value !== null;
  analyzePairing(evidence.trials, problems);
  const usage = analyzeUsage(evidence.trials, problems);
  const results = evidence.trials.flatMap((trial) => trial.tool_results);
  const calledTools = [...new Set(results.map((result) => result.tool_name))].sort();
  const toolCount = evidence.catalog.tools.length;
  const knownMetric = (value) => ({ status: "known", value, reason: null });
  const uiKnown = results.every((result) => result.ui_text !== null);
  if (!uiKnown) problems.push("result_layers:ui_bytes_unknown");

  return {
    schema_version: 1,
    report_id: evidence.evidence_id,
    evidence_kind: evidence.evidence_kind,
    evidence_sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    host: evidence.host,
    host_version: evidence.host_version,
    ...(evidence.source_contract === undefined ? {} : { source_contract: evidence.source_contract }),
    catalog: {
      tool_count: toolCount,
      schema_bytes: byteLength(evidence.catalog.tools),
      schema_tokens: {
        status: schemaTokensKnown ? "known" : "unknown",
        value: evidence.catalog.schema_tokens.value,
        source: evidence.catalog.schema_tokens.source,
        reason: schemaTokensKnown ? null : "token_measurement_unavailable",
      },
      prefix_digest: evidence.catalog.prefix_digests[0],
      stable_digest_repeats: evidence.catalog.prefix_digests.length,
      prefix_stable: prefixStable,
    },
    result_layers: {
      wire_bytes: knownMetric(results.reduce((total, result) => total + byteLength(result.wire_payload), 0)),
      model_visible_text_bytes: knownMetric(
        results.reduce((total, result) => total + byteLength(result.model_text), 0),
      ),
      structured_bytes: knownMetric(
        results.reduce((total, result) => total + byteLength(result.structured_payload), 0),
      ),
      ui_bytes: uiKnown
        ? knownMetric(results.reduce((total, result) => total + byteLength(result.ui_text), 0))
        : { status: "unknown", value: null, reason: "ui_projection_not_collected" },
    },
    tool_usage: {
      available_tools: toolCount,
      called_tools: calledTools,
      call_count: results.length,
      retry_count: results.filter((result) => result.retry_of !== null).length,
      distinct_tool_call_rate: calledTools.length / toolCount,
    },
    provider_usage: usage,
    verification: {
      status: problems.length === 0 ? "pass" : "fail",
      problems,
    },
  };
}

function validateReport(report) {
  assertExactFields(
    report,
    [
      "schema_version",
      "report_id",
      "evidence_kind",
    "evidence_sha256",
    "host",
    "host_version",
      "source_contract",
      "catalog",
      "result_layers",
      "tool_usage",
      "provider_usage",
      "verification",
    ],
    "report",
  );
  if (report.schema_version !== 1) throw new Error("report.schema_version must be 1");
  for (const field of ["report_id", "evidence_kind", "host", "host_version"]) {
    if (typeof report[field] !== "string" || report[field].length === 0) {
      throw new Error(`report.${field} must be a non-empty string`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(report.evidence_sha256)) {
    throw new Error("report.evidence_sha256 must be a SHA-256 value");
  }
  if (report.source_contract !== undefined) {
    assertExactFields(
      report.source_contract,
      [
        "snapshot_sha256",
        "installed_mcp_json_sha256",
        "formatter_source_sha256",
        "dsh_revision",
        "catalog_projection",
      ],
      "report.source_contract",
    );
  }
  assertExactFields(
    report.catalog,
    ["tool_count", "schema_bytes", "schema_tokens", "prefix_digest", "stable_digest_repeats", "prefix_stable"],
    "report.catalog",
  );
  assertExactFields(
    report.catalog.schema_tokens,
    ["status", "value", "source", "reason"],
    "report.catalog.schema_tokens",
  );
  assertExactFields(
    report.result_layers,
    ["wire_bytes", "model_visible_text_bytes", "structured_bytes", "ui_bytes"],
    "report.result_layers",
  );
  assertExactFields(
    report.tool_usage,
    ["available_tools", "called_tools", "call_count", "retry_count", "distinct_tool_call_rate"],
    "report.tool_usage",
  );
  assertExactFields(
    report.provider_usage,
    [
      "status",
      "reason",
      "cold_input_tokens",
      "warm_input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "output_tokens",
    ],
    "report.provider_usage",
  );
  assertExactFields(report.verification, ["status", "problems"], "report.verification");
  if (!isRecord(report.verification) || !Array.isArray(report.verification.problems)) {
    throw new Error("report.verification is malformed");
  }
  if (report.verification.status !== "pass" || report.verification.problems.length !== 0) {
    throw new Error(`report verification failed: ${report.verification.problems.join(",")}`);
  }
  if (report.provider_usage?.status !== "known") {
    throw new Error("provider usage is unknown");
  }
  if (report.catalog?.prefix_stable !== true || report.catalog?.stable_digest_repeats < 3) {
    throw new Error("catalog prefix is not stable across at least three reads");
  }
  for (const field of ["tool_count", "schema_bytes", "stable_digest_repeats"]) {
    if (!Number.isInteger(report.catalog[field]) || report.catalog[field] < 0) {
      throw new Error(`report.catalog.${field} is invalid`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(report.catalog.prefix_digest)) {
    throw new Error("report.catalog.prefix_digest must be a SHA-256 value");
  }
  if (!Array.isArray(report.tool_usage.called_tools) || report.tool_usage.called_tools.some((tool) => typeof tool !== "string")) {
    throw new Error("report.tool_usage.called_tools is invalid");
  }
  if (
    typeof report.catalog.schema_tokens.source !== "string" ||
    report.catalog.schema_tokens.source.length === 0
  ) {
    throw new Error("report.catalog.schema_tokens.source is invalid");
  }
  if (report.catalog.schema_tokens.status === "known") {
    if (
      !Number.isInteger(report.catalog.schema_tokens.value) ||
      report.catalog.schema_tokens.value < 0 ||
      report.catalog.schema_tokens.reason !== null
    ) {
      throw new Error("report.catalog.schema_tokens known metric is invalid");
    }
  } else if (report.catalog.schema_tokens.status === "unknown") {
    if (
      report.catalog.schema_tokens.value !== null ||
      report.catalog.schema_tokens.reason !== "token_measurement_unavailable"
    ) {
      throw new Error("report.catalog.schema_tokens unknown metric is invalid");
    }
  } else {
    throw new Error("report.catalog.schema_tokens.status is invalid");
  }
  const validateKnownMetric = (metric, location) => {
    assertExactFields(metric, ["status", "value", "reason"], location);
    if (metric.status !== "known" || !Number.isInteger(metric.value) || metric.value < 0 || metric.reason !== null) {
      throw new Error(`${location} is unknown or invalid`);
    }
  };
  for (const field of ["wire_bytes", "model_visible_text_bytes", "structured_bytes", "ui_bytes"]) {
    validateKnownMetric(report.result_layers?.[field], `report.result_layers.${field}`);
  }
  for (const field of ["cold_input_tokens", "warm_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"]) {
    if (!Number.isInteger(report.provider_usage[field]) || report.provider_usage[field] < 0) {
      throw new Error(`report.provider_usage.${field} is invalid`);
    }
  }
  return report;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bytes = readFileSync(args.path);
    const value = JSON.parse(bytes.toString("utf8"));
    const report = args.mode === "--analyze"
      ? buildResultCostReport(value, bytes)
      : validateReport(value);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.verification.status !== "pass") {
      fail(`report_incomplete: ${report.verification.problems.join(",")}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
