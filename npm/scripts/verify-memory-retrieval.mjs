#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { REPO_ROOT, parseArgs, requiredArg, run } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(requiredArg(args, "binary"));
const mode = requiredArg(args, "mode");
if (mode !== "direct") {
  throw new Error(`Unsupported --mode ${JSON.stringify(mode)}; expected "direct"`);
}

const corpusPath = path.join(
  REPO_ROOT,
  "crates",
  "xuanling-memory",
  "tests",
  "fixtures",
  "retrieval-corpus-v1.jsonl",
);
const corpusBytes = await readFile(corpusPath);
const corpusSha256 = createHash("sha256").update(corpusBytes).digest("hex");
const expectedCorpusSha256 =
  "70b15f5ef901a29fa8a66a0c3d2b2705d6c1f860f91bd2dce153ef9c8338968d";
if (corpusSha256 !== expectedCorpusSha256) {
  throw new Error(`retrieval corpus digest drifted: ${corpusSha256}`);
}

const rows = corpusBytes
  .toString("utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid corpus JSON on line ${index + 1}: ${error}`);
    }
  });
const meta = rows.find((row) => row.type === "meta");
const records = rows.filter((row) => row.type === "record");
const queries = rows.filter((row) => row.type === "query");
if (
  meta?.version !== "retrieval-corpus-v1" ||
  records.length !== 60 ||
  queries.length !== 40 ||
  records.filter((record) => record.state === "active").length !== 48
) {
  throw new Error("retrieval corpus shape does not match the frozen v1 contract");
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "xuanling-memory-retrieval-"),
);
const database = path.join(temporaryDirectory, "memory.db");
const beforeExport = path.join(temporaryDirectory, "before.jsonl");
const afterExport = path.join(temporaryDirectory, "after.jsonl");
const child = spawn(
  binary,
  ["--memory-db", database, "--tool-profile", "memory"],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

const childSettled = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const pending = new Map();
let protocolFailure;
function rejectPending(error) {
  protocolFailure ??= error;
  for (const waiter of pending.values()) {
    waiter.reject(error);
  }
  pending.clear();
}
childSettled.then(
  (exit) => {
    if (pending.size > 0) {
      rejectPending(
        new Error(
          `MCP server exited as ${JSON.stringify(exit)} before responding; stderr:\n${stderr}`,
        ),
      );
    }
  },
  (error) => rejectPending(error),
);

const lineReader = readline.createInterface({ input: child.stdout });
lineReader.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    rejectPending(new Error(`non-JSON MCP stdout frame ${JSON.stringify(line)}: ${error}`));
    return;
  }
  const waiter = pending.get(frame.id);
  if (waiter) {
    pending.delete(frame.id);
    waiter.resolve(frame);
  }
});

function send(frame) {
  if (protocolFailure) throw protocolFailure;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const response = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  try {
    send({ jsonrpc: "2.0", id, method, params });
  } catch (error) {
    pending.delete(id);
    throw error;
  }
  return response;
}

async function call(tool, arguments_) {
  const response = await request("tools/call", {
    name: tool,
    arguments: arguments_,
  });
  if (response.error) {
    throw new Error(`${tool} protocol error: ${JSON.stringify(response.error)}`);
  }
  if (response.result?.isError) {
    const text = response.result.content?.map((part) => part.text ?? "").join("") ?? "";
    throw new Error(`${tool} domain error: ${text}`);
  }
  return response.result?.structuredContent ?? response.result;
}

const timeout = setTimeout(() => {
  try {
    child.kill("SIGKILL");
  } catch {
    // The server may have exited just before the timeout fired.
  }
  rejectPending(new Error(`memory retrieval verifier timed out; stderr:\n${stderr}`));
}, 120_000);

function payload(record, source = record) {
  const value = {
    kind: record.kind,
    content: source.content,
    tags: source.tags ?? [],
    applicability: source.applicability ?? {},
    pinned: source.pinned ?? false,
  };
  if (source.title !== undefined) value.title = source.title;
  if (source.summary !== undefined) value.summary = source.summary;
  return value;
}

async function review(record, proposalId, decision) {
  return call("memory_review", {
    idempotency_key: `retrieval-review-${proposalId}`,
    reviewer_id: "retrieval-direct-verifier",
    namespace: record.namespace,
    scope: record.scope,
    proposal_id: proposalId,
    expected_proposal_revision: 1,
    decision,
  });
}

async function seedRecord(record) {
  await call("memory_candidate_create", {
    proposal_id: record.id,
    idempotency_key: `retrieval-create-${record.id}`,
    proposer_id: "retrieval-direct-verifier",
    namespace: record.namespace,
    scope: record.scope,
    payload: payload(record),
  });
  if (record.state === "pending") return;
  if (record.state === "rejected") {
    await review(record, record.id, "reject");
    return;
  }

  await review(record, record.id, "approve");
  if (record.state === "archived") {
    const proposalId = `${record.id}-archive`;
    await call("memory_candidate_archive", {
      proposal_id: proposalId,
      idempotency_key: `retrieval-archive-${record.id}`,
      proposer_id: "retrieval-direct-verifier",
      namespace: record.namespace,
      scope: record.scope,
      target_record_id: record.id,
      target_revision: 1,
    });
    await review(record, proposalId, "approve");
  } else if (record.state === "historical") {
    if (!record.replacement) {
      throw new Error(`historical record ${record.id} lacks replacement`);
    }
    const proposalId = `${record.id}-replace`;
    await call("memory_candidate_replace", {
      proposal_id: proposalId,
      idempotency_key: `retrieval-replace-${record.id}`,
      proposer_id: "retrieval-direct-verifier",
      namespace: record.namespace,
      scope: record.scope,
      target_record_id: record.id,
      target_revision: 1,
      payload: payload(record, record.replacement),
    });
    await review(record, proposalId, "approve");
  } else if (record.state !== "active") {
    throw new Error(`unknown record state ${JSON.stringify(record.state)}`);
  }
}

function metricsAt5(relevant, rankedIds) {
  const entries = Object.entries(relevant);
  if (entries.length === 0) return null;
  const recall = (limit) =>
    rankedIds.slice(0, limit).filter((id) => Object.hasOwn(relevant, id)).length /
    entries.length;
  const first = rankedIds.slice(0, 5).findIndex((id) => Object.hasOwn(relevant, id));
  const gain = (grade) => 2 ** grade - 1;
  const dcg = rankedIds.slice(0, 5).reduce((sum, id, rank) => {
    return sum + gain(relevant[id] ?? 0) / Math.log2(rank + 2);
  }, 0);
  const ideal = entries
    .map(([, grade]) => grade)
    .sort((left, right) => right - left)
    .slice(0, 5)
    .reduce((sum, grade, rank) => sum + gain(grade) / Math.log2(rank + 2), 0);
  return {
    recallAt1: recall(1),
    recallAt5: recall(5),
    mrrAt5: first === -1 ? 0 : 1 / (first + 1),
    ndcgAt5: dcg / ideal,
  };
}

function average(metrics, key) {
  return metrics.reduce((sum, value) => sum + value[key], 0) / metrics.length;
}

function projectResult(query, result) {
  return {
    queryId: query.id,
    scopeMode: result.scope_mode,
    items: (result.items ?? []).map((item) => ({
      id: item.record?.id,
      revision: item.record?.revision,
      contentSha256: item.record?.content_sha256,
      score: item.score,
      reasons: item.reasons,
      scopeDistance: item.scope_distance,
    })),
  };
}

async function runQueries() {
  const projected = [];
  for (const query of queries) {
    const request_ = {
      namespace: query.namespace,
      scope: query.scope,
      scope_mode: query.scope_mode,
      query: query.query,
      candidate_limit: query.candidate_limit,
      limit: query.limit,
    };
    if (query.applicability !== undefined) {
      request_.applicability = query.applicability;
    }
    projected.push(projectResult(query, await call("memory_search", request_)));
  }
  return projected;
}

async function exportCanonical(output) {
  await run(binary, [
    "--memory-db",
    database,
    "memory",
    "export",
    "--output",
    output,
  ]);
  return readFile(output);
}

function canonicalSnapshot(exportBytes) {
  const lines = exportBytes.toString("utf8").trimEnd().split("\n");
  if (lines.length < 2) throw new Error("canonical export is missing header or trailer");
  const header = JSON.parse(lines[0]);
  const trailer = JSON.parse(lines.at(-1));
  if (
    header.type !== "xuanling_memory_export" ||
    header.format_version !== 1 ||
    header.schema_version !== 2 ||
    trailer.type !== "trailer"
  ) {
    throw new Error("canonical export header/trailer contract drifted");
  }
  return {
    entities: Buffer.from(`${lines.slice(1, -1).join("\n")}\n`),
    counts: trailer.counts,
  };
}

let report;
try {
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "memory-retrieval-verifier", version: "1" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  const memoryContractVersion =
    initialized.result?._meta?.["xuanling.memory_contract_version"];
  if (memoryContractVersion !== "2") {
    throw new Error(`expected memory contract version 2, got ${memoryContractVersion}`);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const tools = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const toolsResponse = await request("tools/list", cursor ? { cursor } : {});
    if (toolsResponse.error || !Array.isArray(toolsResponse.result?.tools)) {
      throw new Error(`tools/list failed: ${JSON.stringify(toolsResponse)}`);
    }
    tools.push(...toolsResponse.result.tools);
    cursor = toolsResponse.result.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error(`tools/list cursor loop: ${cursor}`);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "memory_candidate_create",
    "memory_candidate_replace",
    "memory_candidate_archive",
    "memory_candidate_get",
    "memory_candidate_list",
    "memory_review",
    "memory_get",
    "memory_search",
    "memory_feedback",
  ]) {
    if (!toolNames.has(name)) throw new Error(`memory profile is missing ${name}`);
  }

  for (const record of records) {
    await seedRecord(record);
  }
  const canonicalBefore = canonicalSnapshot(await exportCanonical(beforeExport));
  const first = await runQueries();
  const second = await runQueries();
  const firstBytes = Buffer.from(JSON.stringify(first));
  const secondBytes = Buffer.from(JSON.stringify(second));
  if (!firstBytes.equals(secondBytes)) {
    throw new Error("two direct MCP query matrices were not byte-identical");
  }
  const canonicalAfter = canonicalSnapshot(await exportCanonical(afterExport));
  if (
    !canonicalBefore.entities.equals(canonicalAfter.entities) ||
    JSON.stringify(canonicalBefore.counts) !== JSON.stringify(canonicalAfter.counts)
  ) {
    throw new Error("memory_search changed canonical JSONL entities or counts");
  }

  const positiveMetrics = [];
  const criticalMetrics = [];
  let visibilityViolations = 0;
  let noMatchFalsePositiveCount = 0;
  let emptyResultCount = 0;
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const rankedIds = first[index].items.map((item) => item.id);
    visibilityViolations += (query.forbidden_ids ?? []).filter((id) =>
      rankedIds.includes(id),
    ).length;
    if (rankedIds.length === 0) emptyResultCount += 1;
    const metrics = metricsAt5(query.relevant, rankedIds);
    if (metrics) {
      positiveMetrics.push(metrics);
      if (query.critical) criticalMetrics.push(metrics);
    } else if (rankedIds.length > 0) {
      noMatchFalsePositiveCount += 1;
    }
  }

  const aggregate = {
    recallAt1: average(positiveMetrics, "recallAt1"),
    recallAt5: average(positiveMetrics, "recallAt5"),
    mrrAt5: average(positiveMetrics, "mrrAt5"),
    ndcgAt5: average(positiveMetrics, "ndcgAt5"),
  };
  const criticalRecallAt5 = average(criticalMetrics, "recallAt5");
  if (
    aggregate.recallAt5 < 0.9 ||
    aggregate.mrrAt5 < 0.75 ||
    aggregate.ndcgAt5 < 0.8 ||
    criticalRecallAt5 !== 1 ||
    visibilityViolations !== 0 ||
    noMatchFalsePositiveCount !== 0 ||
    emptyResultCount !== 4
  ) {
    throw new Error(
      `direct MCP retrieval thresholds failed: ${JSON.stringify({
        aggregate,
        criticalRecallAt5,
        visibilityViolations,
        noMatchFalsePositiveCount,
        emptyResultCount,
      })}`,
    );
  }

  report = {
    schemaVersion: 1,
    mode,
    corpusSha256,
    memoryContractVersion,
    recordCount: records.length,
    queryCount: queries.length,
    aggregate,
    criticalRecallAt5,
    visibilityViolations,
    noMatchFalsePositiveCount,
    emptyResultCount,
    responseSha256: createHash("sha256").update(firstBytes).digest("hex"),
    canonicalSha256: createHash("sha256")
      .update(canonicalBefore.entities)
      .digest("hex"),
  };

  child.stdin.end();
  const exit = await childSettled;
  if (protocolFailure) throw protocolFailure;
  if (exit.code !== 0 || exit.signal) {
    throw new Error(`server exited as ${JSON.stringify(exit)}; stderr:\n${stderr}`);
  }
} finally {
  clearTimeout(timeout);
  lineReader.close();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The server may have exited between the state check and kill.
    }
  }
  await childSettled.catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log(JSON.stringify(report));
