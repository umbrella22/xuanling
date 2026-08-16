#!/usr/bin/env node
// Session-log analyzer for the filesystem evaluation (C-07).
//
// Reads raw newline-delimited session transcripts (the common overlay pins
// compression 'none' and packChunks false) plus any sibling oracle verdicts,
// and aggregates per-trial: tool-family routing, errors, and provider usage.
//
// Fail-closed rules:
//   - a log with no provider usage records reports usage: "unknown", never 0;
//   - an unparseable or truncated log marks the trial incomplete;
//   - --verify exits non-zero when any trial is incomplete or route-invalid.
//
// Usage: node analyze-filesystem-evaluation.mjs --root <eval-root> [--verify]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ANALYZER_VERSION = 8;
const REQUEST_PREFIX_PROJECTION = "deepseek-role-content-v1";
// DSH canonical TokenUsage (packages/llm/llm/src/types.ts): inputTokens is
// UNCACHED input only. The cache buckets are disjoint but OPTIONAL; absence
// means zero, exactly as token-meter's bucketsFrom() projection defines.
const USAGE_REQUIRED_KEYS = ["inputTokens", "outputTokens"];
const USAGE_OPTIONAL_KEYS = ["cacheReadTokens", "cacheWriteTokens"];
const NATIVE_FS_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "str_replace_editor"]);
const SHELL_TOOLS = new Set(["bash", "pwsh"]);
// Log-only control state is measured separately. It does not provide another
// file, process, delegation, or code-execution path around the tested families.
const BENIGN_CONTROL_TOOLS = new Set(["todo_write"]);
// Closed allowlist (C-02): file families, the on-demand skill loader, and the
// explicitly classified log-only control tools. Everything else a model can
// name — run_code, terminal, jobs, subagents, workflow — is a bypass.
const NATIVE_DENY_TOOLS = new Set([
  "run_code", "terminal", "jobs",
  "subagent", "subagent_fork", "subagent_codex", "subagent_claude_code",
  "subagent_list_agents", "subagent_control", "report", "send_message",
  "workflow", "workflow_run", "ralph", "goal_write",
  "cordis_mount", "cordis_unmount",
]);
const FROZEN_PROVIDER = "deepseek-official";
const FROZEN_MODEL = "deepseek-v4-pro";
const FROZEN_EFFORT = "max";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const root = argValue("--root");
const verify = process.argv.includes("--verify");
if (!root || !existsSync(root)) {
  console.error("analyze-filesystem-evaluation: --root <existing eval-root> is required");
  process.exit(2);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function jsonSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * DSH persists a Message id/source for inbox and transcript ownership, while
 * the DeepSeek adapter serializes only the user role and flattened text.
 * This is deliberately strict: an unsupported initial block makes the cache
 * prefix unverifiable instead of silently dropping model-visible content.
 */
function modelFacingInitialUserMessage(value) {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) return null;
  let content = "";
  for (const block of value.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    content += block.text;
  }
  return { role: "user", content };
}

/**
 * Extract the one canonical usage sample carried by a session event.
 * assistant/chunk and assistant/message intentionally repeat a step's final
 * sample; callers replace by (turn, step), matching DSH token-meter semantics.
 */
function canonicalUsageSample(event) {
  if (!isRecord(event.data)) return { kind: "none" };
  let usage;
  if (event.type === "assistant/chunk") {
    const chunk = event.data.chunk;
    if (!isRecord(chunk) || chunk.type !== "usage") return { kind: "none" };
    usage = chunk.usage;
  } else if (event.type === "assistant/message") {
    if (event.data.usage === undefined) return { kind: "none" };
    usage = event.data.usage;
  } else {
    return { kind: "none" };
  }
  if (!isRecord(usage) || !nonNegativeInteger(event.data.turn) || !nonNegativeInteger(event.data.step)) {
    return { kind: "invalid", reason: `${event.type} carries malformed turn/step/usage` };
  }
  for (const key of USAGE_REQUIRED_KEYS) {
    if (!nonNegativeInteger(usage[key])) return { kind: "invalid", reason: `${event.type} usage.${key} is invalid` };
  }
  for (const key of USAGE_OPTIONAL_KEYS) {
    if (usage[key] !== undefined && !nonNegativeInteger(usage[key])) {
      return { kind: "invalid", reason: `${event.type} usage.${key} is invalid` };
    }
  }
  return {
    kind: "sample",
    key: `${event.data.turn}:${event.data.step}`,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
  };
}

function canonicalRoute(event) {
  if (event.type !== "request/header" || !isRecord(event.data)
    || !isRecord(event.data.header) || !isRecord(event.data.header.config)) return null;
  const config = event.data.header.config;
  return {
    provider: typeof config.provider === "string" ? config.provider : undefined,
    model: typeof config.model === "string" ? config.model : undefined,
    reasoningEffort: typeof config.reasoningEffort === "string" ? config.reasoningEffort : undefined,
  };
}

function canonicalToolError(event) {
  if (event.type !== "tool/result" || !isRecord(event.data) || !isRecord(event.data.message)) return false;
  const content = event.data.message.content;
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "tool-result" && block.isError === true);
}

function toolFamily(name) {
  if (name.startsWith("mcp__xuanling__fs_")) return "xuanling_fs";
  if (NATIVE_FS_TOOLS.has(name)) return "native_fs";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (name === "skill") return "skill";
  if (BENIGN_CONTROL_TOOLS.has(name)) return "control";
  if (NATIVE_DENY_TOOLS.has(name)) return "denied";
  return "other";
}

function emptyToolResultMetrics() {
  return {
    count: 0,
    model_visible_bytes: 0,
    error_count: 0,
    retry_after_error_count: 0,
    error_codes: {},
    by_family: {},
  };
}

function addToolResultMetric(metrics, family, bytes, isError, retryAfterError, errorCode) {
  metrics.count += 1;
  metrics.model_visible_bytes += bytes;
  if (isError) metrics.error_count += 1;
  if (retryAfterError) metrics.retry_after_error_count += 1;
  if (errorCode !== null) metrics.error_codes[errorCode] = (metrics.error_codes[errorCode] ?? 0) + 1;
  metrics.by_family[family] ??= {
    count: 0,
    model_visible_bytes: 0,
    error_count: 0,
    retry_after_error_count: 0,
  };
  const familyMetrics = metrics.by_family[family];
  familyMetrics.count += 1;
  familyMetrics.model_visible_bytes += bytes;
  if (isError) familyMetrics.error_count += 1;
  if (retryAfterError) familyMetrics.retry_after_error_count += 1;
}

function mergeToolResultMetrics(target, source) {
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
    const aggregate = target.by_family[family];
    aggregate.count += metrics.count;
    aggregate.model_visible_bytes += metrics.model_visible_bytes;
    aggregate.error_count += metrics.error_count;
    aggregate.retry_after_error_count += metrics.retry_after_error_count;
  }
}

function toolResultErrorCode(event, block) {
  const textBlocks = block.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  const text = textBlocks.join("\n");
  const xuanling = text.match(/\[([A-Z][A-Z0-9_]*XUANLING[A-Z0-9_]*|XUANLING_[A-Z0-9_]+)\]/)?.[1];
  if (xuanling !== undefined) return xuanling;
  const fsCode = text.match(/\b(FS_[A-Z0-9_]+)\b/)?.[1];
  if (fsCode !== undefined) return fsCode;
  const durableCode = isRecord(event.data?.error) && typeof event.data.error.code === "string"
    ? event.data.error.code
    : undefined;
  if (durableCode !== undefined && durableCode.length > 0) return durableCode;

  const jsonCodes = new Set();
  for (const blockText of textBlocks) {
    const candidates = new Set([
      blockText.trim(),
      ...blockText.split(/\r?\n/u).map((line) => line.trim()),
    ]);
    for (const candidate of candidates) {
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (isRecord(parsed) && typeof parsed.code === "string" && parsed.code.length > 0) {
          jsonCodes.add(parsed.code);
        }
      } catch {
        // Prose and partial JSON remain unclassified instead of being guessed.
      }
    }
  }
  return jsonCodes.size === 1 ? [...jsonCodes][0] : null;
}

function analyzeLog(file) {
  const trial = {
    session_log: file,
    complete: false,
    arm: undefined,
    header: null,
    lines: 0,
    parse_failures: 0,
    tool_calls: { xuanling_fs: 0, native_fs: 0, skill: 0, control: 0, shell: 0, denied: [], other: [] },
    tool_results: emptyToolResultMetrics(),
    errors: 0,
    usage: "unknown",
  };
  const usageByStep = new Map();
  const completedSteps = new Set();
  const conflictingUsageSteps = new Set();
  const usageInvalidReasons = [];
  const names = [];
  const callsById = new Map();
  const resultsById = new Set();
  const pendingErrorNames = new Set();
  const toolResultProblems = [];
  const routes = [];
  const lifecycleProblems = [];
  const initialUserMessages = [];
  let initialUserMessageInvalid = false;
  let firstRequestHeader;
  let toolCallParseFailures = 0;
  let sawTurnStart = false;
  let sawTurnEnd = false;
  let lastTurnEvent = null;
  let openTurn = null;
  let openStep = null;
  let nextTurn = 1;
  let nextStep = 1;
  let expectedSeq = 0;
  let firstLine = true;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    trial.lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      trial.parse_failures += 1;
      firstLine = false;
      continue;
    }
    let headerLine = false;
    if (firstLine) {
      firstLine = false;
      if (event !== null && typeof event === "object" && event.type === "session") {
        trial.header = event;
        headerLine = true;
      }
    }
    if (typeof event !== "object" || event === null) continue;
    const type = typeof event.type === "string" ? event.type : "";
    if (headerLine) continue;
    if (type === "session") {
      lifecycleProblems.push(`unexpected session header at line ${trial.lines}`);
      continue;
    }
    if (!nonNegativeInteger(event.seq) || event.seq !== expectedSeq) {
      lifecycleProblems.push(`event seq expected ${expectedSeq}, got ${String(event.seq ?? "?")}`);
      if (nonNegativeInteger(event.seq) && event.seq >= expectedSeq) expectedSeq = event.seq + 1;
    } else {
      expectedSeq += 1;
    }
    if (event.arm !== undefined && trial.arm === undefined && typeof event.arm === "string") {
      trial.arm = event.arm;
    }
    // Canonical completion (packages/core/session/src/types.ts): turns are
    // balanced start/end pairs. session.end is not a canonical event and a
    // bare turn/end without a matching turn/start is not valid evidence.
    if (type === "turn/start") {
      lastTurnEvent = type;
      const turn = isRecord(event.data) ? event.data.turn : undefined;
      if (!nonNegativeInteger(turn) || openTurn !== null || turn !== nextTurn) {
        lifecycleProblems.push(`invalid turn/start at event seq ${String(event.seq ?? "?")}`);
      } else {
        openTurn = turn;
        openStep = null;
        nextStep = 1;
        sawTurnStart = true;
      }
    } else if (type === "turn/end") {
      lastTurnEvent = type;
      const turn = isRecord(event.data) ? event.data.turn : undefined;
      if (!nonNegativeInteger(turn) || openTurn !== turn || openStep !== null) {
        lifecycleProblems.push(`unmatched turn/end at event seq ${String(event.seq ?? "?")}`);
      } else {
        openTurn = null;
        nextTurn += 1;
        sawTurnEnd = true;
      }
    } else if (type === "step/start") {
      const turn = isRecord(event.data) ? event.data.turn : undefined;
      const step = isRecord(event.data) ? event.data.step : undefined;
      if (!nonNegativeInteger(turn) || !nonNegativeInteger(step)
        || openTurn !== turn || openStep !== null || step !== nextStep) {
        lifecycleProblems.push(`invalid step/start at event seq ${String(event.seq ?? "?")}`);
      } else {
        openStep = step;
      }
    } else if (type === "step/end") {
      const turn = isRecord(event.data) ? event.data.turn : undefined;
      const step = isRecord(event.data) ? event.data.step : undefined;
      if (!nonNegativeInteger(turn) || !nonNegativeInteger(step)
        || openTurn !== turn || openStep !== step) {
        lifecycleProblems.push(`unmatched step/end at event seq ${String(event.seq ?? "?")}`);
      } else {
        completedSteps.add(`${turn}:${step}`);
        openStep = null;
        nextStep += 1;
      }
    } else if (["assistant/chunk", "assistant/message", "tool/call"].includes(type)
      || (type === "tool/result" && event.surfaceOp === "append")) {
      const turn = isRecord(event.data) ? event.data.turn : undefined;
      const step = isRecord(event.data) ? event.data.step : undefined;
      if (!nonNegativeInteger(turn) || !nonNegativeInteger(step)
        || openTurn !== turn || openStep !== step) {
        lifecycleProblems.push(`${type} names no open turn/step at event seq ${String(event.seq ?? "?")}`);
      }
    } else if (type === "tool/result" && openTurn === null) {
      lifecycleProblems.push(`tool/result replacement appended outside an open turn at event seq ${String(event.seq ?? "?")}`);
    } else if (["request/header", "request/context", "todo/write"].includes(type) && openTurn === null) {
      lifecycleProblems.push(`${type} appended outside an open turn at event seq ${String(event.seq ?? "?")}`);
    }
    const turnEndedInError = type === "turn/end" && isRecord(event.data)
      && isRecord(event.data.reason) && event.data.reason.kind === "error";
    if (canonicalToolError(event) || turnEndedInError || type.endsWith("/error") || type === "error") {
      trial.errors += 1;
    }

    if (type === "tool/call") {
      if (isRecord(event.data) && typeof event.data.callId === "string" && event.data.callId.length > 0
        && typeof event.data.name === "string" && event.data.name.length > 0) {
        const { callId, name } = event.data;
        names.push(name);
        if (callsById.has(callId)) {
          toolResultProblems.push(`duplicate tool/call ${callId}`);
        } else {
          const retryAfterError = pendingErrorNames.delete(name);
          callsById.set(callId, { name, family: toolFamily(name), retryAfterError });
        }
      } else {
        toolCallParseFailures += 1;
      }
    }

    if (type === "tool/result" && event.surfaceOp === "append") {
      const blocks = isRecord(event.data) && isRecord(event.data.message) && Array.isArray(event.data.message.content)
        ? event.data.message.content.filter((block) => isRecord(block) && block.type === "tool-result")
        : [];
      if (blocks.length === 0) {
        toolResultProblems.push(`malformed tool/result at event seq ${String(event.seq ?? "?")}`);
      }
      for (const block of blocks) {
        const callId = typeof block.toolCallId === "string" && block.toolCallId.length > 0
          ? block.toolCallId
          : null;
        if (callId === null || !Array.isArray(block.content) || typeof block.isError !== "boolean") {
          toolResultProblems.push(`malformed tool/result block at event seq ${String(event.seq ?? "?")}`);
          continue;
        }
        if (resultsById.has(callId)) {
          toolResultProblems.push(`duplicate tool/result for ${callId}`);
          continue;
        }
        resultsById.add(callId);
        const call = callsById.get(callId);
        if (call === undefined) {
          toolResultProblems.push(`orphan tool/result for ${callId}`);
          continue;
        }
        const serializedContent = JSON.stringify(block.content);
        if (serializedContent === undefined) {
          toolResultProblems.push(`unserializable tool/result content for ${callId}`);
          continue;
        }
        const errorCode = block.isError ? toolResultErrorCode(event, block) : null;
        if (block.isError && errorCode === null) {
          toolResultProblems.push(`tool/result error code is unclassified for ${callId}`);
        }
        addToolResultMetric(
          trial.tool_results,
          call.family,
          Buffer.byteLength(serializedContent),
          block.isError,
          call.retryAfterError,
          errorCode,
        );
        if (block.isError) pendingErrorNames.add(call.name);
      }
    }

    if (type === "user/message" && firstRequestHeader === undefined && isRecord(event.data)) {
      const modelFacing = modelFacingInitialUserMessage(event.data);
      if (modelFacing === null) initialUserMessageInvalid = true;
      else initialUserMessages.push(modelFacing);
    }

    if (type === "request/header") {
      const route = canonicalRoute(event);
      if (route === null) routes.push({});
      else routes.push(route);
      if (firstRequestHeader === undefined && isRecord(event.data) && isRecord(event.data.header)) {
        firstRequestHeader = event.data.header;
      }
    }

    const sample = canonicalUsageSample(event);
    if (sample.kind === "sample") {
      const previous = usageByStep.get(sample.key);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(sample.usage)) {
        conflictingUsageSteps.add(sample.key);
      } else {
        usageByStep.set(sample.key, sample.usage);
      }
    }
    else if (sample.kind === "invalid") usageInvalidReasons.push(sample.reason);
  }
  for (const callId of callsById.keys()) {
    if (!resultsById.has(callId)) toolResultProblems.push(`missing tool/result for ${callId}`);
  }
  trial.complete = sawTurnStart && sawTurnEnd && openTurn === null && openStep === null
    && lastTurnEvent === "turn/end" && lifecycleProblems.length === 0 && toolResultProblems.length === 0;
  trial.lifecycle_problems = lifecycleProblems;
  trial.tool_result_problems = toolResultProblems;
  trial.tool_call_parse_failures = toolCallParseFailures;
  for (const name of names) {
    const family = toolFamily(name);
    if (["xuanling_fs", "native_fs", "shell", "skill", "control"].includes(family)) {
      trial.tool_calls[family] += 1;
    } else if (family === "denied") trial.tool_calls.denied.push(name);
    else trial.tool_calls.other.push(name);
  }
  const missingUsageSteps = [...completedSteps].filter((key) => !usageByStep.has(key));
  const orphanUsageSteps = [...usageByStep.keys()].filter((key) => !completedSteps.has(key));
  trial.usage_expected_steps = completedSteps.size;
  trial.usage_missing_steps = missingUsageSteps.length;
  trial.usage_conflicting_steps = conflictingUsageSteps.size;
  trial.usage_orphan_steps = orphanUsageSteps.length;
  trial.usage_invalid_events = usageInvalidReasons.length;
  if (usageInvalidReasons.length > 0) trial.usage_invalid_reasons = usageInvalidReasons.slice(0, 5);
  if (completedSteps.size > 0 && missingUsageSteps.length === 0 && conflictingUsageSteps.size === 0
    && orphanUsageSteps.length === 0 && usageInvalidReasons.length === 0) {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const usage of usageByStep.values()) {
      for (const key of Object.keys(totals)) totals[key] += usage[key];
    }
    trial.usage = totals;
  }
  trial.request_headers = routes.length;
  trial.observed_providers = [...new Set(routes.map((route) => route.provider).filter((value) => value !== undefined))];
  trial.observed_models = [...new Set(routes.map((route) => route.model).filter((value) => value !== undefined))];
  trial.observed_efforts = [...new Set(routes.map((route) => route.reasoningEffort).filter((value) => value !== undefined))];
  trial.route_metadata_invalid = routes.filter((route) => route.provider === undefined
    || route.model === undefined || route.reasoningEffort === undefined).length;
  trial.request_prefix_projection = REQUEST_PREFIX_PROJECTION;
  trial.request_prefix_sha256 = firstRequestHeader !== undefined && !initialUserMessageInvalid && initialUserMessages.length > 0
    && typeof trial.header?.cwd === "string" && trial.header.cwd.length > 0
    ? jsonSha256({ cwd: trial.header.cwd, header: firstRequestHeader, initialUserMessages })
    : null;
  return trial;
}

function routeProblems(trial) {
  const problems = [];
  const arm = trial.arm ?? "(unknown)";
  if (trial.tool_calls.shell > 0) problems.push(`${arm}: shell tool called (${trial.tool_calls.shell})`);
  if (trial.tool_calls.denied.length > 0) {
    problems.push(`${arm}: bypass tool called: ${[...new Set(trial.tool_calls.denied)].join(", ")}`);
  }
  if (arm === "A" && trial.tool_calls.xuanling_fs > 0) problems.push("A: XuanLing fs tool called");
  if (arm === "B" && trial.tool_calls.native_fs > 0) problems.push("B: native file tool called (no fallback allowed)");
  if (trial.tool_calls.other.length > 0) problems.push(`${arm}: unexpected tools ${trial.tool_calls.other.join(", ")}`);
  if (trial.tool_call_parse_failures > 0) problems.push(`${arm}: ${trial.tool_call_parse_failures} malformed tool/call event(s)`);
  if (trial.arm === undefined) problems.push("arm not recorded in the session log");
  if (trial.header === null) {
    problems.push(`${arm}: session header missing or malformed (trial identity unverifiable)`);
  } else if (typeof trial.header.cwd !== "string" || trial.header.cwd.length === 0) {
    problems.push(`${arm}: session header carries no cwd (trial identity unverifiable)`);
  }
  if (trial.request_headers === 0) {
    problems.push(`${arm}: no canonical request/header route evidence`);
  }
  if (trial.route_metadata_invalid > 0) {
    problems.push(`${arm}: ${trial.route_metadata_invalid} request/header event(s) lack provider/model/reasoningEffort`);
  }
  const wrongProviders = trial.observed_providers.filter((value) => value !== FROZEN_PROVIDER);
  const wrongModels = trial.observed_models.filter((value) => value !== FROZEN_MODEL);
  const wrongEfforts = trial.observed_efforts.filter((value) => value !== FROZEN_EFFORT);
  if (wrongProviders.length > 0) {
    problems.push(`${arm}: observed provider(s) ${wrongProviders.join(", ")} != frozen ${FROZEN_PROVIDER}`);
  }
  if (wrongModels.length > 0) {
    problems.push(`${arm}: observed model(s) ${wrongModels.join(", ")} != frozen ${FROZEN_MODEL}`);
  }
  if (wrongEfforts.length > 0) {
    problems.push(`${arm}: observed effort(s) ${wrongEfforts.join(", ")} != frozen ${FROZEN_EFFORT}`);
  }
  return problems;
}

const logs = [];
const walk = (dir, depth) => {
  if (depth > 5) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, depth + 1);
    else if (name === "session.jsonl") logs.push(abs);
  }
};
walk(root, 0);

const trials = logs.map((file) => {
  const trial = analyzeLog(file);
  const label = path.relative(root, path.dirname(file));
  if (trial.arm === undefined) {
    const match = /(?:^|\/)([ABC])(?:\/|$)/.exec(path.dirname(file));
    if (match) trial.arm = match[1];
  }
  const verdictFile = path.join(path.dirname(file), "verdict.json");
  trial.label = label;
  trial.oracle = existsSync(verdictFile)
    ? (() => {
        try {
          return JSON.parse(readFileSync(verdictFile, "utf8"));
        } catch {
          return { pass: false, failures: ["verdict.json unparseable"] };
        }
      })()
    : null;
  trial.route_problems = routeProblems(trial);
  return trial;
});

const byArm = {};
for (const trial of trials) {
  const arm = trial.arm ?? "unknown";
  byArm[arm] ??= {
    trials: 0,
    complete: 0,
    oracle_passed: 0,
    route_valid: 0,
    usage_known: 0,
    tool_calls: { xuanling_fs: 0, native_fs: 0, skill: 0, control: 0, shell: 0 },
    tool_results: emptyToolResultMetrics(),
  };
  byArm[arm].trials += 1;
  if (trial.complete) byArm[arm].complete += 1;
  if (trial.oracle?.pass === true) byArm[arm].oracle_passed += 1;
  if (trial.route_problems.length === 0) byArm[arm].route_valid += 1;
  if (trial.usage !== "unknown") byArm[arm].usage_known += 1;
  for (const family of ["xuanling_fs", "native_fs", "skill", "control", "shell"]) {
    byArm[arm].tool_calls[family] += trial.tool_calls[family];
  }
  mergeToolResultMetrics(byArm[arm].tool_results, trial.tool_results);
}

const report = {
  analyzer_version: ANALYZER_VERSION,
  root,
  trials,
  arms: byArm,
  cache_read_share: "N/A",
};
// Cache read share (C-07): cacheRead / (uncached + cacheRead + cacheWrite),
// only over trials with complete usage; otherwise it stays N/A — never zeros.
const withUsage = trials.filter((trial) => trial.usage !== "unknown");
if (withUsage.length > 0) {
  let uncached = 0;
  let read = 0;
  let write = 0;
  for (const trial of withUsage) {
    uncached += trial.usage.inputTokens;
    read += trial.usage.cacheReadTokens;
    write += trial.usage.cacheWriteTokens;
  }
  const denominator = uncached + read + write;
  report.cache_read_share = denominator === 0 ? "N/A" : Number((read / denominator).toFixed(4));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (verify) {
  const problems = trials.flatMap((trial) => {
    const list = [];
    if (trial.parse_failures > 0) list.push(`${trial.label}: ${trial.parse_failures} unparseable log line(s)`);
    if (!trial.complete) list.push(`${trial.label}: incomplete canonical session evidence`);
    list.push(...trial.tool_result_problems.map((problem) => `${trial.label}: ${problem}`));
    list.push(...trial.route_problems.map((problem) => `${trial.label}: ${problem}`));
    if (trial.oracle === null) list.push(`${trial.label}: no oracle verdict.json beside the session log`);
    else if (trial.oracle.pass !== true) {
      list.push(`${trial.label}: oracle failed (${(trial.oracle.failures ?? []).slice(0, 3).join("; ")})`);
    }
    if (trial.usage === "unknown") {
      list.push(`${trial.label}: provider usage unknown (economy unverified)`);
    }
    if (trial.request_prefix_sha256 === null) {
      list.push(`${trial.label}: first request prefix cannot be fingerprinted`);
    }
    return list;
  });
  // Expected population: quality trials per arm plus complete cold/warm pairs.
  const expectedArms = (argValue("--arms") ?? "A,B,C").split(",").map((arm) => arm.trim()).filter(Boolean);
  const expectedQuality = Number(argValue("--quality-runs") ?? 3);
  const expectedPairs = Number(argValue("--cache-pairs") ?? 1);
  if (expectedArms.length === 0 || new Set(expectedArms).size !== expectedArms.length
    || !expectedArms.every((arm) => ["A", "B", "C"].includes(arm))) {
    problems.push(`--arms must be a non-empty unique A/B/C subset`);
  }
  if (!nonNegativeInteger(expectedQuality)) problems.push(`--quality-runs must be a non-negative integer`);
  if (!nonNegativeInteger(expectedPairs)) problems.push(`--cache-pairs must be a non-negative integer`);
  const byLabel = new Map(trials.map((trial) => [trial.label, trial]));
  const expectedLabels = new Set();
  for (const arm of expectedArms) {
    for (let index = 1; index <= expectedQuality; index += 1) {
      const label = `quality/${arm}/trial-${index}`;
      expectedLabels.add(label);
      if (!byLabel.has(label)) problems.push(`missing trial ${label}`);
    }
    for (let index = 1; index <= expectedPairs; index += 1) {
      for (const kind of ["cold", "warm"]) {
        const label = `cache/${arm}/pair-${index}/${kind}`;
        expectedLabels.add(label);
        if (!byLabel.has(label)) problems.push(`missing cache trial ${label}`);
      }
      const cold = byLabel.get(`cache/${arm}/pair-${index}/cold`);
      const warm = byLabel.get(`cache/${arm}/pair-${index}/warm`);
      if (cold !== undefined && warm !== undefined
        && cold.request_prefix_sha256 !== warm.request_prefix_sha256) {
        problems.push(`cache/${arm}/pair-${index}: cold/warm request prefix mismatch`);
      }
    }
  }
  for (const trial of trials) {
    if (!expectedLabels.has(trial.label)) problems.push(`unexpected trial ${trial.label}`);
  }
  if (trials.length === 0) problems.push(`no session logs found under ${root}`);
  if (problems.length > 0) {
    console.error(`analyze-filesystem-evaluation: ${problems.length} verification problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
}
process.exit(0);
