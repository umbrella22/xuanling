#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const EXPECTED_CONTENT = "zcode-candidate-read-only-fixture-v1\n";
const RESULT_PREFIX = "Result available in structuredContent.\n\nStructured content:\n";
const EXPECTED_RESULT = {
  content: EXPECTED_CONTENT,
  end_line: null,
  newline_style: "lf",
  start_line: null,
  total_lines: 1,
  truncated: false,
};
const EXPECTED_COUNTS = {
  proposals: 0,
  heads: 0,
  versions: 0,
  reviews: 0,
  feedback: 0,
};

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileSha256(file) {
  return sha256(readFileSync(file));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function occurrenceCount(value, needle) {
  return value.split(needle).length - 1;
}

function parseArgs(argv) {
  const allowed = new Set([
    "--baseline",
    "--transcript",
    "--workspace",
    "--memory-db",
    "--installed-mcp",
    "--default-memory-db",
    "--expected-default-db-sha256",
    "--expected-host-version",
  ]);
  if (argv.length % 2 !== 0) fail("arguments must be --name value pairs");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name)) fail(`unsupported argument: ${name}`);
    if (Object.hasOwn(values, name)) fail(`duplicate argument: ${name}`);
    if (!value) fail(`missing value for ${name}`);
    values[name] = value;
  }
  for (const name of allowed) {
    if (!Object.hasOwn(values, name)) fail(`missing required argument: ${name}`);
  }
  return values;
}

function parseJsonLines(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`transcript line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

function resultValue(modelText, location) {
  if (typeof modelText !== "string" || !modelText.startsWith(RESULT_PREFIX)) {
    fail(`${location} does not use the structured-result marker`);
  }
  if (occurrenceCount(modelText, "Structured content:") !== 1) {
    fail(`${location} has a non-unique structured projection`);
  }
  let parsed;
  try {
    parsed = JSON.parse(modelText.slice(RESULT_PREFIX.length));
  } catch (error) {
    fail(`${location} structured projection is not JSON: ${error.message}`);
  }
  if (!jsonEqual(parsed, EXPECTED_RESULT)) fail(`${location} structured value drifted`);
  return parsed;
}

function verifyBaseline(file, installedMcpSha256, expectedHostVersion) {
  const baseline = JSON.parse(readFileSync(file, "utf8"));
  if (baseline.schema_version !== 1 || baseline.host !== "zcode") fail("baseline identity is invalid");
  if (!baseline.host_version.startsWith(`${expectedHostVersion}+`)) fail("baseline host version drifted");
  if (baseline.source_contract?.installed_mcp_json_sha256 !== installedMcpSha256) {
    fail("baseline and installed MCP launch contracts differ");
  }
  if (!Array.isArray(baseline.catalog?.prefix_digests) || baseline.catalog.prefix_digests.length < 3) {
    fail("baseline lacks three catalog prefix digests");
  }
  if (!baseline.catalog.prefix_digests.every((digest) => digest === baseline.catalog.prefix_digests[0])) {
    fail("baseline catalog prefix drifted");
  }
  if (!Array.isArray(baseline.trials) || baseline.trials.length !== 2) {
    fail("baseline must contain exactly two prior trials");
  }
  const phases = [];
  for (const [index, trial] of baseline.trials.entries()) {
    phases.push(trial.phase);
    if (!Array.isArray(trial.usage_candidates) || trial.usage_candidates.length !== 1) {
      fail(`baseline trial ${index + 1} has missing or ambiguous provider usage`);
    }
    if (!Array.isArray(trial.tool_results) || trial.tool_results.length !== 1) {
      fail(`baseline trial ${index + 1} must contain exactly one tool result`);
    }
    const result = trial.tool_results[0];
    if (result.tool_name !== "fs_read_text" || result.retry_of !== null) {
      fail(`baseline trial ${index + 1} tool route drifted`);
    }
    resultValue(result.model_text, `baseline trial ${index + 1}`);
    if (!jsonEqual(result.structured_payload, EXPECTED_RESULT)) {
      fail(`baseline trial ${index + 1} structured payload drifted`);
    }
    if (result.ui_text !== result.model_text) fail(`baseline trial ${index + 1} UI projection drifted`);
  }
  if (!jsonEqual(phases.sort(), ["cold", "warm"])) fail("baseline cold/warm pairing drifted");
  return {
    evidence_sha256: fileSha256(file),
    trial_ids: baseline.trials.map((trial) => trial.trial_id),
    catalog_prefix_sha256: baseline.catalog.prefix_digests[0],
  };
}

function callName(call) {
  return call?.name ?? call?.toolName;
}

function callId(call) {
  return call?.id ?? call?.toolCallId;
}

function callInput(call) {
  return call?.input ?? call?.args ?? call?.arguments;
}

function verifyTranscript(file, expectedHostVersion) {
  const records = parseJsonLines(file);
  if (records.length === 0 || records.some((record) => record.type !== "model_io")) {
    fail("transcript must contain only model_io records");
  }
  const sessionIds = [...new Set(records.map((record) => record.sessionId))];
  const turnIds = [...new Set(records.map((record) => record.turnId))];
  if (sessionIds.length !== 1 || turnIds.length !== 1) fail("transcript spans multiple sessions or turns");

  const hostVersions = new Set();
  for (const record of records) {
    const headers = record.request?.headers;
    if (typeof headers?.["x-zcode-app-version"] === "string") {
      hostVersions.add(headers["x-zcode-app-version"]);
    }
  }
  if (!jsonEqual([...hostVersions], [expectedHostVersion])) fail("transcript host version drifted");

  const main = records.filter((record) => record.model?.role === "main");
  if (main.length === 0) fail("transcript lacks main-model records");
  for (const [index, record] of main.entries()) {
    const usage = record.response?.usage;
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      if (!Number.isSafeInteger(usage?.[field]) || usage[field] < 0) {
        fail(`main record ${index + 1} has invalid provider usage.${field}`);
      }
    }
  }

  const calls = main.flatMap((record) => record.response?.toolCalls ?? []);
  const names = calls.map(callName);
  const expectedTool = "mcp__plugin_xuanling-mcp-w4_xuanling__fs_read_text";
  if (!jsonEqual(names, ["Skill", expectedTool])) fail(`unexpected tool sequence: ${names.join(",")}`);
  const candidateCall = calls[1];
  if (!callId(candidateCall) || !jsonEqual(callInput(candidateCall), { path: "fixture.txt" })) {
    fail("candidate fs_read_text call is malformed");
  }

  const projectedResults = main.flatMap((record) => (record.request?.messages ?? [])
    .filter((message) => message.role === "tool" && typeof message.content === "string")
    .map((message) => message.content)
    .filter((content) => content.startsWith(RESULT_PREFIX)));
  if (projectedResults.length !== 1) fail(`model-visible result count is ${projectedResults.length}, expected 1`);
  const structured = resultValue(projectedResults[0], "live trial");
  const finalText = main.at(-1)?.response?.text;
  if (finalText !== EXPECTED_CONTENT.trimEnd()) fail("live trial final response drifted");

  return {
    transcript_sha256: fileSha256(file),
    transcript_bytes: statSync(file).size,
    record_count: records.length,
    session_id: sessionIds[0],
    turn_id: turnIds[0],
    model_id: main.at(-1)?.model?.modelId,
    tool_call_id: callId(candidateCall),
    tool_name: expectedTool,
    model_projection_count: projectedResults.length,
    model_projection_sha256: sha256(projectedResults[0]),
    structured_sha256: sha256(JSON.stringify(structured)),
    final_text_sha256: sha256(finalText),
    provider_usage_records: main.length,
  };
}

function verifyDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const schemaVersion = database.prepare(
      "SELECT value FROM memory_schema_meta WHERE key = 'schema_version'",
    ).get()?.value;
    if (schemaVersion !== "2") fail(`Memory schema version is ${String(schemaVersion)}, expected 2`);
    const tables = {
      proposals: "memory_proposals",
      heads: "memory_record_heads",
      versions: "memory_record_versions",
      reviews: "memory_reviews",
      feedback: "memory_feedback_events",
    };
    const counts = {};
    for (const [name, table] of Object.entries(tables)) {
      counts[name] = database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    }
    if (!jsonEqual(counts, EXPECTED_COUNTS)) fail(`isolated Memory database is not empty: ${JSON.stringify(counts)}`);
    return { schema_version: 2, canonical_counts: counts };
  } finally {
    database.close();
  }
}

function verifyWorkspace(workspace, memoryDb) {
  const canonicalWorkspace = realpathSync(workspace);
  if (realpathSync(path.dirname(memoryDb)) !== canonicalWorkspace) {
    fail("Memory database is outside the isolated workspace");
  }
  const fixture = path.join(canonicalWorkspace, "fixture.txt");
  if (readFileSync(fixture, "utf8") !== EXPECTED_CONTENT) fail("fixture content drifted");
  const entries = readdirSync(canonicalWorkspace).sort();
  const expectedEntries = [
    ".xuanling-w4-memory.db",
    ".xuanling-w4-memory.db-shm",
    ".xuanling-w4-memory.db-wal",
    "fixture.txt",
  ];
  if (!jsonEqual(entries, expectedEntries)) fail(`unexpected isolated workspace entries: ${entries.join(",")}`);
  return {
    path: canonicalWorkspace,
    fixture_sha256: fileSha256(fixture),
    entries,
  };
}

function verifyNoResidue(repoRoot, installedMcp) {
  const rootResidue = readdirSync(repoRoot).filter((name) => name.startsWith(".xuanling-w4-memory.db"));
  if (rootResidue.length > 0) fail(`repository-root Memory residue: ${rootResidue.join(",")}`);
  const processList = spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  if (processList.status !== 0) fail(`process scan failed: ${processList.stderr.trim()}`);
  const installRoot = path.dirname(installedMcp);
  const residualProcesses = processList.stdout.split("\n").filter((line) =>
    line.includes(installRoot) &&
    (line.includes("mcp-result-adapter.mjs --binary") || line.includes("/bin/xuanling-mcp --workspace-root"))
  );
  if (residualProcesses.length > 0) fail(`candidate process residue count is ${residualProcesses.length}`);
  return { repository_root_files: rootResidue.length, candidate_processes: residualProcesses.length };
}

export function verifyLiveProjection(options) {
  const installedMcpSha256 = fileSha256(options.installedMcp);
  const baseline = verifyBaseline(options.baseline, installedMcpSha256, options.expectedHostVersion);
  const live = verifyTranscript(options.transcript, options.expectedHostVersion);
  const workspace = verifyWorkspace(options.workspace, options.memoryDb);
  const database = verifyDatabase(options.memoryDb);
  const defaultDbSha256 = fileSha256(options.defaultMemoryDb);
  if (defaultDbSha256 !== options.expectedDefaultDbSha256) fail("default Memory database hash drifted");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const residue = verifyNoResidue(repoRoot, options.installedMcp);
  return {
    schema_version: 1,
    evidence_id: "zcode-w4-2-projection-live-20260819",
    verification: { status: "pass", problems: [] },
    host: {
      name: "ZCode",
      version: options.expectedHostVersion,
      accepted_trial_count: 3,
      baseline_trial_count: 2,
      live_trial_count: 1,
    },
    candidate: {
      plugin: "xuanling-mcp-w4",
      version: "0.2.4",
      installed_mcp_json_sha256: installedMcpSha256,
    },
    baseline,
    live,
    storage: {
      workspace,
      memory_db: {
        path: realpathSync(options.memoryDb),
        main_sha256: fileSha256(options.memoryDb),
        wal_sha256: fileSha256(`${options.memoryDb}-wal`),
        ...database,
      },
      default_memory_db_sha256: defaultDbSha256,
    },
    residue,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const name of ["--baseline", "--transcript", "--workspace", "--memory-db", "--installed-mcp", "--default-memory-db"]) {
      if (!existsSync(args[name])) fail(`${name} does not exist: ${args[name]}`);
    }
    const report = verifyLiveProjection({
      baseline: args["--baseline"],
      transcript: args["--transcript"],
      workspace: args["--workspace"],
      memoryDb: args["--memory-db"],
      installedMcp: args["--installed-mcp"],
      defaultMemoryDb: args["--default-memory-db"],
      expectedDefaultDbSha256: args["--expected-default-db-sha256"],
      expectedHostVersion: args["--expected-host-version"],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`zcode-projection-live-verifier: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
