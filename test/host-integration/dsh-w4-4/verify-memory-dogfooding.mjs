#!/usr/bin/env node

// Independent oracle for run-memory-dogfooding.mjs. It does not trust the
// runner summary, model final text, or the recorded workspace manifests.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { snapshotDatabase } from "../../deepseek-harness/evaluation/memory-retrieval/sqlite-oracle.mjs";

const FROZEN_PROVIDER = "deepseek-official";
const FROZEN_MODEL = "deepseek-v4-pro";
const FROZEN_EFFORT = "max";
const CASES = ["case-1", "case-2", "case-3", "case-4"];
const NATIVE_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "str_replace_editor"]);
const BENIGN_TOOLS = new Set(["skill", "todo_write"]);
const FORBIDDEN_TOOLS = new Set([
  "bash", "pwsh", "run_code", "terminal", "jobs", "subagent", "subagent_fork",
  "subagent_codex", "subagent_claude_code", "subagent_list_agents", "subagent_control",
  "report", "send_message", "workflow", "workflow_run", "ralph", "goal_write",
  "cordis_mount", "cordis_unmount",
]);
const MEMORY_READ_TOOLS = new Set(["memory_search", "memory_get"]);
const MEMORY_WRITE_TOOLS = new Set([
  "memory_candidate_create", "memory_candidate_replace", "memory_candidate_archive",
  "memory_review", "memory_feedback",
]);
const FACT = "All merge commits must include a 'Reviewed-by: xuanling-team' trailer.";

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

function canonicalPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function resultBlocks(event) {
  if (event.type !== "tool/result" || event.surfaceOp !== "append") return [];
  const message = isRecord(event.data) ? event.data.message : undefined;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => isRecord(block) && block.type === "tool-result");
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function memoryShortName(name) {
  return name.startsWith("mcp__xuanling__") ? name.slice("mcp__xuanling__".length) : name;
}

function treeManifest(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const childRelative = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) visit(absolute, childRelative);
      else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        const hash = createHash("sha256").update(bytes).digest("hex");
        entries.push({ path: childRelative, bytes: bytes.length, sha256: hash });
      } else throw new Error(`unsupported workspace entry: ${absolute}`);
    }
  };
  visit(root);
  return {
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}

function manifestEqual(left, right) {
  return jsonEqual(left.entries, right.entries);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readProposal(database) {
  const stats = lstatSync(database);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Memory database is not a regular file");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT proposal_id, idempotency_key, operation, namespace, scope_type, scope_key, payload_json, proposer_id, status, revision FROM memory_proposals ORDER BY proposal_id",
    ).all();
    return rows;
  } finally {
    db.close();
  }
}

function usageSample(event) {
  if (!isRecord(event.data)) return null;
  let usage;
  if (event.type === "assistant/chunk") {
    if (!isRecord(event.data.chunk) || event.data.chunk.type !== "usage") return null;
    usage = event.data.chunk.usage;
  } else if (event.type === "assistant/message" && event.data.usage !== undefined) {
    usage = event.data.usage;
  } else return null;
  if (!isRecord(usage) || !nonNegativeInteger(event.data.turn) || !nonNegativeInteger(event.data.step)) {
    throw new Error(`${event.type} carries malformed usage ownership`);
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

function analyzeSession(file, expectedCwd) {
  const problems = [];
  const rawLines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const events = [];
  for (const [index, line] of rawLines.entries()) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      problems.push(`line ${index + 1} is not JSON: ${error}`);
    }
  }
  const header = events.shift();
  if (!isRecord(header) || header.type !== "session") {
    problems.push("session header missing or malformed");
  } else if (typeof header.cwd !== "string" || canonicalPath(header.cwd) !== canonicalPath(expectedCwd)) {
    problems.push("session header cwd does not identify trial workspace");
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
  const finalTexts = [];
  const ordered = [];
  const typedErrors = [];

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== "string") {
      problems.push("non-object session event");
      continue;
    }
    ordered.push(event);
    if (!nonNegativeInteger(event.seq) || event.seq !== expectedSeq) {
      problems.push(`event sequence expected ${expectedSeq}, got ${String(event.seq ?? "?")}`);
      expectedSeq = nonNegativeInteger(event.seq) ? event.seq + 1 : expectedSeq + 1;
    } else expectedSeq += 1;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "turn/start") {
      lastTurnEvent = event.type;
      if (!nonNegativeInteger(data.turn) || openTurn !== null || data.turn !== nextTurn) problems.push(`invalid turn/start at ${event.seq}`);
      else {
        openTurn = data.turn;
        openStep = null;
        nextStep = 1;
      }
    } else if (event.type === "turn/end") {
      lastTurnEvent = event.type;
      if (!nonNegativeInteger(data.turn) || data.turn !== openTurn || openStep !== null) problems.push(`invalid turn/end at ${event.seq}`);
      else {
        openTurn = null;
        nextTurn += 1;
      }
    } else if (event.type === "step/start") {
      if (!nonNegativeInteger(data.turn) || !nonNegativeInteger(data.step)
        || data.turn !== openTurn || openStep !== null || data.step !== nextStep) problems.push(`invalid step/start at ${event.seq}`);
      else openStep = data.step;
    } else if (event.type === "step/end") {
      if (!nonNegativeInteger(data.turn) || !nonNegativeInteger(data.step)
        || data.turn !== openTurn || data.step !== openStep) problems.push(`invalid step/end at ${event.seq}`);
      else {
        completedSteps.add(`${data.turn}:${data.step}`);
        openStep = null;
        nextStep += 1;
      }
    }
    if (event.type === "request/header") {
      const config = isRecord(data.header) && isRecord(data.header.config) ? data.header.config : {};
      routes.push({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort });
    }
    if (event.type === "tool/call") {
      if (typeof data.callId !== "string" || typeof data.name !== "string") problems.push(`malformed tool/call at ${event.seq}`);
      else if (calls.has(data.callId)) problems.push(`duplicate tool/call ${data.callId}`);
      else {
        try {
          calls.set(data.callId, { name: data.name, arguments: parseArguments(data.arguments, data.name), seq: event.seq });
        } catch (error) {
          problems.push(String(error));
          calls.set(data.callId, { name: data.name, arguments: {}, seq: event.seq });
        }
      }
    }
    for (const block of resultBlocks(event)) {
      const callId = block.toolCallId;
      if (typeof callId !== "string" || !Array.isArray(block.content) || typeof block.isError !== "boolean") {
        problems.push(`malformed tool/result at ${event.seq}`);
      } else if (results.has(callId)) {
        problems.push(`duplicate tool/result ${callId}`);
      } else {
        results.set(callId, { isError: block.isError, text: textBlocks(block.content), seq: event.seq });
        if (block.isError) typedErrors.push({ callId, text: textBlocks(block.content) });
      }
    }
    if (event.type === "assistant/message" && isRecord(data.message)) finalTexts.push(textBlocks(data.message.content));
    try {
      const sample = usageSample(event);
      if (sample !== null) {
        const previous = usageByStep.get(sample.key);
        if (previous !== undefined && !jsonEqual(previous, sample.value)) problems.push(`conflicting usage for ${sample.key}`);
        usageByStep.set(sample.key, sample.value);
      }
    } catch (error) {
      problems.push(String(error));
    }
  }
  if (openTurn !== null || openStep !== null || lastTurnEvent !== "turn/end") problems.push("canonical final turn/end missing");
  for (const step of completedSteps) if (!usageByStep.has(step)) problems.push(`usage missing for completed step ${step}`);
  for (const step of usageByStep.keys()) if (!completedSteps.has(step)) problems.push(`orphan usage for ${step}`);
  if (routes.length === 0) problems.push("no request/header route evidence");
  for (const route of routes) {
    if (route.provider !== FROZEN_PROVIDER || route.model !== FROZEN_MODEL || route.reasoningEffort !== FROZEN_EFFORT) {
      problems.push(`route drift: ${JSON.stringify(route)}`);
    }
  }
  for (const callId of calls.keys()) if (!results.has(callId)) problems.push(`missing result for ${callId}`);
  for (const callId of results.keys()) if (!calls.has(callId)) problems.push(`orphan result for ${callId}`);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const sample of usageByStep.values()) for (const key of Object.keys(usage)) usage[key] += sample[key];
  return {
    problems,
    calls: [...calls.entries()].map(([callId, call]) => ({ callId, ...call, result: results.get(callId) })),
    ordered,
    typed_errors: typedErrors,
    routes,
    final_text: finalTexts.at(-1) ?? "",
    usage: completedSteps.size === usageByStep.size && completedSteps.size > 0 ? usage : "unknown",
    session_id: isRecord(header) && typeof header.id === "string" ? header.id : null,
  };
}

function checkSearch(call, result, problems, label, options = {}) {
  const args = call.arguments;
  if (args.namespace !== "team-conventions" || !jsonEqual(args.scope, { type: "global" })) {
    problems.push(`${label}: memory_search namespace/scope drift`);
  }
  if (typeof args.query !== "string" || args.query.trim() === "") problems.push(`${label}: memory_search query missing`);
  if (result?.isError) {
    if (!options.allowUnavailable) problems.push(`${label}: memory_search returned an error`);
    return;
  }
  const body = parseJsonText(result?.text ?? "");
  if (!isRecord(body) || !Array.isArray(body.items)) problems.push(`${label}: memory_search result is not an empty JSON item list`);
  else if (body.items.length !== 0) problems.push(`${label}: expected empty shared Memory search result`);
}

function checkTrial(trialDir, expectedCase, expectedRepetition) {
  const problems = [];
  const meta = readJson(path.join(trialDir, "meta.json"));
  if (meta.case !== expectedCase || meta.repetition !== expectedRepetition) problems.push("trial identity metadata drift");
  if (meta.incomplete !== false || !Array.isArray(meta.collection_problems) || meta.collection_problems.length !== 0) {
    problems.push(`collector incomplete: ${JSON.stringify(meta.collection_problems)}`);
  }
  if (meta.credential_source !== "file_reference") problems.push("credential source was not an external file reference");
  if (!path.isAbsolute(meta.memory_db) || canonicalPath(meta.memory_db) === canonicalPath("/Users/ikaros/.xuanling/memory.db")) {
    problems.push("trial database is not isolated from the default database");
  }
  const beforeRecorded = readJson(path.join(trialDir, "workspace-before.json"));
  const afterRecorded = readJson(path.join(trialDir, "workspace-after.json"));
  const actualAfter = treeManifest(path.join(trialDir, "workspace"));
  // The after manifest must match the current workspace exactly; case-specific
  // checks compare the recorded before state against the frozen contract.
  if (!manifestEqual(afterRecorded, actualAfter)) problems.push("recorded after workspace manifest is stale");
  const beforeMemory = snapshotDatabase(meta.memory_db);
  const afterMemory = snapshotDatabase(meta.memory_db);
  const recordedBeforeMemory = readJson(path.join(trialDir, "memory-before.json"));
  const recordedAfterMemory = readJson(path.join(trialDir, "memory-after.json"));
  // SQLite snapshots are immutable evidence files; compare their shape and
  // independently query the live database for the final state.
  if (beforeMemory.schema_version !== "2" || afterMemory.schema_version !== "2") problems.push("Memory schema version is not 2");
  if (!jsonEqual(recordedAfterMemory.counts, afterMemory.counts)
    || recordedAfterMemory.canonical_sha256 !== afterMemory.canonical_sha256) problems.push("recorded after Memory snapshot is stale");
  if (meta.secret_redactions !== 0) problems.push("credential material was observed in child output");

  const session = analyzeSession(path.join(trialDir, "session.jsonl"), meta.cwd);
  problems.push(...session.problems);
  const calls = session.calls;
  const names = calls.map((call) => call.name);
  for (const call of calls) {
    const short = memoryShortName(call.name);
    if (call.name.startsWith("mcp__xuanling__fs_")) problems.push(`forbidden XuanLing filesystem call ${call.name}`);
    else if (MEMORY_READ_TOOLS.has(short) || MEMORY_WRITE_TOOLS.has(short) || BENIGN_TOOLS.has(call.name) || NATIVE_TOOLS.has(call.name)) {
      // A typed tool error may be a valid observation followed by a corrected
      // retry. Case-specific checks decide whether it was recoverable.
    } else if (FORBIDDEN_TOOLS.has(call.name)) problems.push(`forbidden bypass call ${call.name}`);
    else problems.push(`unexpected tool ${call.name}`);
  }
  const memoryCalls = calls.filter((call) => MEMORY_READ_TOOLS.has(memoryShortName(call.name)) || MEMORY_WRITE_TOOLS.has(memoryShortName(call.name)));
  const searchCalls = calls.filter((call) => memoryShortName(call.name) === "memory_search");
  const reviewCalls = calls.filter((call) => memoryShortName(call.name) === "memory_review");
  const candidateCalls = calls.filter((call) => memoryShortName(call.name) === "memory_candidate_create");
  if (reviewCalls.length !== 0) problems.push("memory_review was called without explicit user approval");

  const beforeEntries = beforeRecorded.entries ?? [];
  const afterEntries = actualAfter.entries ?? [];
  if (expectedCase === "case-1") {
    if (memoryCalls.length !== 0) problems.push("case-1 used XuanLing Memory despite L1-only routing");
    const agents = path.join(meta.cwd, "AGENTS.md");
    if (!existsSync(agents) || readFileSync(agents, "utf8") !== `${FACT}\n`) problems.push("case-1 AGENTS.md does not contain the exact convention");
    const readme = path.join(meta.cwd, "README.md");
    if (beforeEntries.length !== 1 || afterEntries.length !== 2 || !afterEntries.some((entry) => entry.path === "AGENTS.md")
      || !existsSync(readme) || readFileSync(readme, "utf8") !== "# DSH W4.4 Memory case 1\n\nFresh project workspace for a project-local instruction test.\n") {
      problems.push("case-1 workspace changed outside the new instruction file");
    }
    if (afterMemory.counts.proposals !== 0 || afterMemory.counts.heads !== 0 || afterMemory.counts.versions !== 0) {
      problems.push("case-1 Memory canonical state changed");
    }
  } else if (expectedCase === "case-2") {
    if (searchCalls.length < 1 || candidateCalls.length !== 1) problems.push("case-2 requires search then one candidate create");
    for (const search of searchCalls) checkSearch(search, search.result, problems, "case-2");
    if (searchCalls.length > 0 && candidateCalls.length === 1 && searchCalls.at(-1).seq >= candidateCalls[0].seq) problems.push("case-2 candidate was created before the final search");
    if (candidateCalls.length === 1) {
      const args = candidateCalls[0].arguments;
      const payload = args.payload;
      if (args.proposal_id !== "dsh-w4-4-case-2-team-trailer"
        || args.idempotency_key !== "dsh-w4-4-case-2-20260819-0001"
        || args.proposer_id !== "dsh-w4-4-primary-agent"
        || args.namespace !== "team-conventions"
        || !jsonEqual(args.scope, { type: "global" })
        || !isRecord(payload)
        || payload.kind !== "fact"
        || payload.title !== "Team merge trailer convention"
        || payload.content !== FACT) {
        problems.push("case-2 candidate payload drifted");
      }
    }
    if (beforeEntries.length !== 0 || afterEntries.length !== 0) problems.push("case-2 modified the workspace");
    if (afterMemory.counts.proposals !== 1 || afterMemory.counts.reviews !== 0
      || afterMemory.counts.heads !== 0 || afterMemory.counts.versions !== 0
      || afterMemory.counts.tags !== 0 || afterMemory.counts.feedback !== 0) {
      problems.push(`case-2 canonical counts are not pending-only: ${JSON.stringify(afterMemory.counts)}`);
    }
    const proposals = readProposal(meta.memory_db);
    if (proposals.length !== 1 || proposals[0].status !== "pending" || proposals[0].revision !== 1
      || proposals[0].proposal_id !== "dsh-w4-4-case-2-team-trailer") problems.push("case-2 pending proposal row is incorrect");
    if (proposals.length === 1) {
      const payload = parseJsonText(proposals[0].payload_json);
      if (!isRecord(payload) || payload.content !== FACT || payload.kind !== "fact") problems.push("case-2 stored payload is incorrect");
    }
  } else if (expectedCase === "case-3") {
    if (searchCalls.length !== 1) problems.push(`case-3 expected one scoped search, got ${searchCalls.length}`);
    if (searchCalls.length === 1) checkSearch(searchCalls[0], searchCalls[0].result, problems, "case-3");
    if (MEMORY_WRITE_TOOLS.size > 0 && memoryCalls.some((call) => MEMORY_WRITE_TOOLS.has(memoryShortName(call.name)))) problems.push("case-3 performed a Memory write");
    if (!manifestEqual(beforeRecorded, afterRecorded) || !manifestEqual(beforeRecorded, actualAfter)) problems.push("case-3 changed the workspace");
    if (afterMemory.counts.proposals !== 0 || afterMemory.counts.heads !== 0 || afterMemory.counts.versions !== 0) problems.push("case-3 Memory state changed");
  } else if (expectedCase === "case-4") {
    if (searchCalls.length !== 1) problems.push(`case-4 expected one recall search, got ${searchCalls.length}`);
    if (searchCalls.length === 1) checkSearch(searchCalls[0], searchCalls[0].result, problems, "case-4", { allowUnavailable: true });
    if (memoryCalls.some((call) => MEMORY_WRITE_TOOLS.has(memoryShortName(call.name)))) problems.push("case-4 performed a Memory write");
    const readSeq = calls.filter((call) => call.name === "read" && call.arguments.file_path?.endsWith("README.md")).map((call) => call.seq);
    const edit = calls.find((call) => call.name === "edit" && call.arguments.file_path?.endsWith("README.md"));
    if (edit === undefined) problems.push("case-4 did not edit README.md with native edit");
    else {
      if (edit.arguments.old_string !== "Tagline: pending" || edit.arguments.new_string !== "Tagline: release notes stay concise.") problems.push("case-4 README edit payload drifted");
      if (!readSeq.some((seq) => seq < edit.seq)) problems.push("case-4 edited README without a preceding read");
    }
    if (readFileSync(path.join(meta.cwd, "README.md"), "utf8") !== "# DSH W4.4 Memory case 4\n\nTagline: release notes stay concise.\n") {
      problems.push("case-4 README final content is incorrect");
    }
    if (afterMemory.counts.proposals !== 0 || afterMemory.counts.heads !== 0 || afterMemory.counts.versions !== 0) problems.push("case-4 Memory state changed");
  }
  return {
    case: expectedCase,
    repetition: expectedRepetition,
    session_id: session.session_id,
    tool_calls: names,
    usage: session.usage,
    before_memory: recordedBeforeMemory,
    after_memory: afterMemory,
    workspace_before_sha256: beforeRecorded.sha256,
    workspace_after_sha256: actualAfter.sha256,
    problems,
  };
}

const rootArg = argValue("--root");
const expectedRepetitions = Number(argValue("--repetitions") ?? 1);
if (rootArg === undefined || !path.isAbsolute(rootArg) || !existsSync(rootArg)
  || !Number.isSafeInteger(expectedRepetitions) || expectedRepetitions < 1 || expectedRepetitions > 10) {
  console.error("verify-memory-dogfooding: --root <absolute existing path> and --repetitions <1..10> are required");
  process.exit(2);
}
const root = path.resolve(rootArg);
const problems = [];
const trials = [];
const expected = new Set();
for (let index = 1; index <= CASES.length * expectedRepetitions; index += 1) {
  const caseId = CASES[Math.floor((index - 1) / expectedRepetitions)];
  const repetition = ((index - 1) % expectedRepetitions) + 1;
  expected.add(`trial-${String(index).padStart(2, "0")}-${caseId}-r${repetition}`);
}
const actual = readdirSync(root).filter((name) => name.startsWith("trial-"));
for (const name of actual) if (!expected.has(name)) problems.push(`unexpected trial directory ${name}`);
for (const name of expected) {
  const match = /^trial-(\d+)-(case-[1-4])-r(\d+)$/.exec(name);
  if (!match) {
    problems.push(`invalid trial name ${name}`);
    continue;
  }
  const trialDir = path.join(root, name);
  if (!existsSync(trialDir)) {
    problems.push(`missing trial directory ${name}`);
    continue;
  }
  try {
    const result = checkTrial(trialDir, match[2], Number(match[3]));
    problems.push(...result.problems.map((problem) => `${name}: ${problem}`));
    trials.push(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`${name}: verifier exception: ${message}`);
    trials.push({ case: match[2], repetition: Number(match[3]), problems: [message] });
  }
}
const report = {
  schema_version: 1,
  root,
  expected_trials: expected.size,
  verified_trials: trials.length,
  pass: problems.length === 0 && trials.length === expected.size,
  trials,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) {
  console.error(`verify-memory-dogfooding: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
