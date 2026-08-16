#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { assertExpectedSeed, snapshotDatabase } from "./sqlite-oracle.mjs";

const FROZEN_PROVIDER = "deepseek-official";
const FROZEN_MODEL = "deepseek-v4-pro";
const FROZEN_EFFORT = "max";
const ALLOWED_TOOLS = new Set([
  "skill",
  "mcp__xuanling__memory_search",
  "mcp__xuanling__memory_get",
]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error}`);
  }
}

function parseArguments(value, label) {
  if (isRecord(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} arguments are not JSON text`);
  const parsed = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(`${label} arguments are not an object`);
  return parsed;
}

function textBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function canonicalSnapshotView(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    counts: snapshot.counts,
    projection_rows: snapshot.projection_rows,
    canonical_sha256: snapshot.canonical_sha256,
  };
}

function snapshotsEqual(left, right) {
  return JSON.stringify(canonicalSnapshotView(left)) === JSON.stringify(canonicalSnapshotView(right));
}

function usageSample(event) {
  if (!isRecord(event.data)) return null;
  let usage;
  if (event.type === "assistant/chunk") {
    if (!isRecord(event.data.chunk) || event.data.chunk.type !== "usage") return null;
    usage = event.data.chunk.usage;
  } else if (event.type === "assistant/message") {
    if (event.data.usage === undefined) return null;
    usage = event.data.usage;
  } else {
    return null;
  }
  if (!isRecord(usage) || !nonNegativeInteger(event.data.turn) || !nonNegativeInteger(event.data.step)) {
    throw new Error(`${event.type} has malformed usage ownership`);
  }
  for (const key of ["inputTokens", "outputTokens"]) {
    if (!nonNegativeInteger(usage[key])) throw new Error(`${event.type} usage.${key} is invalid`);
  }
  for (const key of ["cacheReadTokens", "cacheWriteTokens"]) {
    if (usage[key] !== undefined && !nonNegativeInteger(usage[key])) {
      throw new Error(`${event.type} usage.${key} is invalid`);
    }
  }
  return {
    key: `${event.data.turn}:${event.data.step}`,
    value: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
  };
}

function analyzeSession(file, fixture, expectedCwd) {
  const problems = [];
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const events = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      problems.push(`line ${index + 1} is not JSON: ${error}`);
    }
  }
  const header = events.shift();
  if (!isRecord(header) || header.type !== "session") {
    problems.push("session header missing or malformed");
  } else if (typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(expectedCwd)) {
    problems.push(`session cwd ${JSON.stringify(header.cwd)} does not match trial workspace`);
  }

  let expectedSeq = 0;
  let openTurn = null;
  let openStep = null;
  let nextTurn = 1;
  let nextStep = 1;
  let lastTurnEvent = null;
  const completedSteps = new Set();
  const usageByStep = new Map();
  const calls = new Map();
  const results = new Map();
  const routes = [];
  const assistantTexts = [];

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== "string") {
      problems.push("session contains a non-object event");
      continue;
    }
    if (!nonNegativeInteger(event.seq) || event.seq !== expectedSeq) {
      problems.push(`event seq expected ${expectedSeq}, got ${String(event.seq ?? "?")}`);
      expectedSeq = nonNegativeInteger(event.seq) ? event.seq + 1 : expectedSeq + 1;
    } else {
      expectedSeq += 1;
    }
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "turn/start") {
      lastTurnEvent = event.type;
      if (!nonNegativeInteger(data.turn) || openTurn !== null || data.turn !== nextTurn) {
        problems.push(`invalid turn/start at seq ${event.seq}`);
      } else {
        openTurn = data.turn;
        openStep = null;
        nextStep = 1;
      }
    } else if (event.type === "turn/end") {
      lastTurnEvent = event.type;
      if (!nonNegativeInteger(data.turn) || data.turn !== openTurn || openStep !== null) {
        problems.push(`unmatched turn/end at seq ${event.seq}`);
      } else {
        openTurn = null;
        nextTurn += 1;
      }
    } else if (event.type === "step/start") {
      if (!nonNegativeInteger(data.turn) || !nonNegativeInteger(data.step)
        || data.turn !== openTurn || openStep !== null || data.step !== nextStep) {
        problems.push(`invalid step/start at seq ${event.seq}`);
      } else {
        openStep = data.step;
      }
    } else if (event.type === "step/end") {
      if (!nonNegativeInteger(data.turn) || !nonNegativeInteger(data.step)
        || data.turn !== openTurn || data.step !== openStep) {
        problems.push(`unmatched step/end at seq ${event.seq}`);
      } else {
        completedSteps.add(`${data.turn}:${data.step}`);
        openStep = null;
        nextStep += 1;
      }
    }

    if (event.type === "request/header") {
      const config = isRecord(data.header) && isRecord(data.header.config)
        ? data.header.config
        : {};
      routes.push({
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      });
    }

    if (event.type === "tool/call") {
      if (typeof data.callId !== "string" || data.callId.length === 0
        || typeof data.name !== "string" || data.name.length === 0) {
        problems.push(`malformed tool/call at seq ${event.seq}`);
      } else if (calls.has(data.callId)) {
        problems.push(`duplicate tool/call ${data.callId}`);
      } else {
        let arguments_;
        try {
          arguments_ = parseArguments(data.arguments, data.name);
        } catch (error) {
          problems.push(error.message);
          arguments_ = {};
        }
        calls.set(data.callId, { name: data.name, arguments: arguments_ });
      }
    }

    if (event.type === "tool/result" && event.surfaceOp === "append") {
      const blocks = isRecord(data.message) && Array.isArray(data.message.content)
        ? data.message.content.filter((block) => isRecord(block) && block.type === "tool-result")
        : [];
      if (blocks.length === 0) problems.push(`malformed tool/result at seq ${event.seq}`);
      for (const block of blocks) {
        const callId = block.toolCallId;
        if (typeof callId !== "string" || !Array.isArray(block.content)
          || typeof block.isError !== "boolean") {
          problems.push(`malformed tool/result block at seq ${event.seq}`);
        } else if (results.has(callId)) {
          problems.push(`duplicate tool/result ${callId}`);
        } else {
          results.set(callId, { isError: block.isError, text: textBlocks(block.content) });
        }
      }
    }

    if (event.type === "assistant/message" && isRecord(data.message)) {
      assistantTexts.push(textBlocks(data.message.content));
    }
    try {
      const sample = usageSample(event);
      if (sample !== null) {
        const previous = usageByStep.get(sample.key);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(sample.value)) {
          problems.push(`conflicting usage for step ${sample.key}`);
        } else {
          usageByStep.set(sample.key, sample.value);
        }
      }
    } catch (error) {
      problems.push(error.message);
    }
  }

  if (openTurn !== null || openStep !== null || lastTurnEvent !== "turn/end") {
    problems.push("incomplete canonical lifecycle: final balanced turn/end missing");
  }
  for (const step of completedSteps) {
    if (!usageByStep.has(step)) problems.push(`provider usage missing for completed step ${step}`);
  }
  for (const step of usageByStep.keys()) {
    if (!completedSteps.has(step)) problems.push(`orphan provider usage for step ${step}`);
  }
  if (routes.length === 0) problems.push("no request/header route evidence");
  for (const route of routes) {
    if (route.provider !== FROZEN_PROVIDER || route.model !== FROZEN_MODEL
      || route.reasoningEffort !== FROZEN_EFFORT) {
      problems.push(`route drift: ${JSON.stringify(route)}`);
    }
  }

  let targetRank = null;
  let searchCalls = 0;
  for (const [callId, call] of calls) {
    if (!ALLOWED_TOOLS.has(call.name)) {
      problems.push(`forbidden tool call ${call.name}`);
    }
    const result = results.get(callId);
    if (result === undefined) {
      problems.push(`missing tool/result for ${callId}`);
      continue;
    }
    if (result.isError) problems.push(`tool call ${call.name} returned an error`);
    if (call.name === "skill") {
      if (call.arguments.name !== "xuanling-memory-workflow") {
        problems.push(`unexpected skill ${JSON.stringify(call.arguments.name)}`);
      }
      continue;
    }
    if (call.name === "mcp__xuanling__memory_search") {
      searchCalls += 1;
      const expected = {
        namespace: fixture.namespace,
        scope: fixture.scope,
        scope_mode: "exact",
        query: fixture.query,
        candidate_limit: 20,
        limit: 5,
      };
      if (!jsonEqual(call.arguments, expected)) {
        problems.push(`memory_search arguments drifted: ${JSON.stringify(call.arguments)}`);
      }
      let body;
      try {
        body = JSON.parse(result.text);
      } catch (error) {
        problems.push(`memory_search result is not JSON: ${error}`);
        continue;
      }
      const items = Array.isArray(body.items) ? body.items : [];
      const rank = items.findIndex((item) => item?.record?.id === fixture.expected_record_id);
      if (rank === -1 || rank >= 5) {
        problems.push(`target ${fixture.expected_record_id} absent from memory_search top 5`);
      } else {
        targetRank = targetRank === null ? rank + 1 : Math.min(targetRank, rank + 1);
        if (items[rank]?.record?.content !== fixture.expected_content) {
          problems.push("target search result content drifted");
        }
      }
    } else if (call.name === "mcp__xuanling__memory_get") {
      if (call.arguments.namespace !== fixture.namespace
        || !jsonEqual(call.arguments.scope, fixture.scope)
        || call.arguments.record_id !== fixture.expected_record_id) {
        problems.push(`memory_get arguments drifted: ${JSON.stringify(call.arguments)}`);
      }
    }
  }
  for (const callId of results.keys()) {
    if (!calls.has(callId)) problems.push(`orphan tool/result ${callId}`);
  }
  if (searchCalls === 0) problems.push("no memory_search call was observed");
  const finalText = assistantTexts.at(-1) ?? "";
  if (!finalText.includes(fixture.expected_record_id) || !finalText.includes(fixture.expected_content)) {
    problems.push("final assistant response does not contain the target id and exact content");
  }

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const sample of usageByStep.values()) {
    for (const key of Object.keys(usage)) usage[key] += sample[key];
  }
  return {
    problems,
    session_id: isRecord(header) && typeof header.id === "string" ? header.id : null,
    request_headers: routes.length,
    tool_calls: [...calls.values()].map((call) => call.name),
    target_rank: targetRank,
    usage: completedSteps.size > 0 && completedSteps.size === usageByStep.size ? usage : "unknown",
  };
}

const rootArg = argValue("--root");
const trialCount = Number(argValue("--trials") ?? 3);
if (rootArg === undefined || !path.isAbsolute(rootArg) || !existsSync(rootArg)
  || !Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 20) {
  console.error("verify-transcripts: --root <absolute existing path> and --trials <1..20> are required");
  process.exit(2);
}

const root = path.resolve(rootArg);
const fixture = readJson(path.join(import.meta.dirname, "fixture.json"), "fixture.json");
const problems = [];
const trials = [];
const expectedNames = new Set(Array.from({ length: trialCount }, (_, index) => `trial-${index + 1}`));
const actualTrialNames = readdirSync(root).filter((name) => /^trial-\d+$/.test(name));
for (const name of actualTrialNames) {
  if (!expectedNames.has(name)) problems.push(`unexpected trial directory ${name}`);
}

for (let index = 1; index <= trialCount; index += 1) {
  const label = `trial-${index}`;
  const trialRoot = path.join(root, label);
  const trialProblems = [];
  if (!existsSync(trialRoot)) {
    problems.push(`missing trial directory ${label}`);
    continue;
  }
  let meta;
  let before;
  let current;
  let session = {
    problems: ["session evidence unavailable"],
    session_id: null,
    request_headers: 0,
    tool_calls: [],
    target_rank: null,
    usage: "unknown",
  };
  try {
    meta = readJson(path.join(trialRoot, "meta.json"), `${label}/meta.json`);
    if (meta.incomplete !== false || meta.exit?.code !== 0 || meta.exit?.signal !== null
      || !Array.isArray(meta.collection_problems) || meta.collection_problems.length !== 0) {
      trialProblems.push(`${label} collection metadata is incomplete`);
    }
    before = readJson(path.join(trialRoot, "oracle-before.json"), `${label}/oracle-before.json`);
    assertExpectedSeed(before, fixture);
    current = snapshotDatabase(path.join(trialRoot, "memory.db"));
    assertExpectedSeed(current, fixture);
    if (!snapshotsEqual(before, current)) {
      trialProblems.push(`${label} canonical or projection state drifted after search`);
    }
    const afterFile = path.join(trialRoot, "oracle-after.json");
    if (existsSync(afterFile)) {
      const recordedAfter = readJson(afterFile, `${label}/oracle-after.json`);
      if (!snapshotsEqual(recordedAfter, current)) {
        trialProblems.push(`${label} recorded after-oracle does not match independent current snapshot`);
      }
    }
    session = analyzeSession(
      path.join(trialRoot, "session.jsonl"),
      fixture,
      meta.cwd,
    );
    trialProblems.push(...session.problems.map((problem) => `${label}: ${problem}`));
  } catch (error) {
    trialProblems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  problems.push(...trialProblems);
  trials.push({
    label,
    session_id: session.session_id,
    target_rank: session.target_rank,
    tool_calls: session.tool_calls,
    request_headers: session.request_headers,
    usage: session.usage,
    canonical_unchanged: before !== undefined && current !== undefined
      ? snapshotsEqual(before, current)
      : false,
    canonical_sha256: current?.canonical_sha256 ?? null,
    problems: trialProblems,
  });
}

const report = {
  schema_version: 1,
  root,
  expected_trials: trialCount,
  complete_trials: trials.filter((trial) => trial.problems.length === 0).length,
  pass: problems.length === 0 && trials.length === trialCount,
  expected_record_id: fixture.expected_record_id,
  trials,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) {
  console.error(`verify-transcripts: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
