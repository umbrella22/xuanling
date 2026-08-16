import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg } from "./shared.mjs";

// Structured MCP contract verifier (plan W7.4, C-12).
//
// Starts the binary as a stdio MCP server with an explicit unique temp
// `--memory-db` (C-15: the real default database is never opened), then
// checks every layer of the public host contract:
//   1. initialize `_meta` publishes xuanling.contract_version=2 and
//      xuanling.memory_contract_version=2;
//   2. the catalog count is DERIVED from tools/list (no literal total) and
//      matches `_meta.tool_count`;
//   3. the required core tool names are present;
//   4. forbidden names are absent (removed v1 memory tools, any semantic/
//      embedding surface);
//   5. the process_run stdout/stderr schema keeps the full tagged union
//      (string modes plus {file:{path}}).
// Any drift exits non-zero with a per-check report.

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(requiredArg(args, "binary"));

const REQUIRED_TOOLS = [
  "system_info",
  "path_resolve",
  "path_relative",
  "fs_stat",
  "fs_list",
  "fs_read_text",
  "fs_read_bytes",
  "fs_hash",
  "fs_search",
  "fs_glob",
  "fs_mkdir",
  "fs_write_text",
  "fs_replace_text",
  "fs_patch",
  "fs_edit",
  "fs_copy",
  "fs_move",
  "fs_remove",
  "process_which",
  "process_run",
  "process_pipeline",
  "project_detect",
  "project_command",
  "project_run",
  "session_open",
  "session_exec",
  "session_close",
  "artifact_read",
  "artifact_cleanup",
  "memory_candidate_create",
  "memory_candidate_replace",
  "memory_candidate_archive",
  "memory_candidate_get",
  "memory_candidate_list",
  "memory_review",
  "memory_get",
  "memory_search",
  "memory_feedback",
];

const FORBIDDEN_NAMES = [
  "memory_put",
  "memory_update",
  "memory_delete",
  "memory_compact",
  "memory_context",
];

const FORBIDDEN_FRAGMENTS = ["semantic", "embed", "hybrid", "vector"];

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-mcp-verify-"));
const child = spawn(
  binary,
  [
    "--workspace-root",
    temporaryDirectory,
    "--memory-db",
    path.join(temporaryDirectory, "memory.db"),
  ],
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
const frames = [];
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
        new Error(`MCP server exited as ${JSON.stringify(exit)} before responding; stderr:\n${stderr}`),
      );
    }
  },
  (error) => rejectPending(error),
);

const lineReader = readline.createInterface({ input: child.stdout });
lineReader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    rejectPending(new Error(`Non-JSON stdout frame ${JSON.stringify(line)}: ${error}`));
    return;
  }
  frames.push(frame);
  const waiter = pending.get(frame.id);
  if (waiter) {
    pending.delete(frame.id);
    waiter.resolve(frame);
  }
});

function send(frame) {
  if (protocolFailure) {
    throw protocolFailure;
  }
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(id, method, params) {
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  try {
    send({ jsonrpc: "2.0", id, method, params });
  } catch (error) {
    pending.delete(id);
    throw error;
  }
  return response;
}

const timeout = setTimeout(() => {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited before the timeout callback ran.
  }
  rejectPending(new Error(`MCP contract verifier timed out; stderr:\n${stderr}`));
}, 30_000);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

try {
  const initialized = await request(1, "initialize", {
    capabilities: {},
    clientInfo: { name: "npm-contract-verifier", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  const meta = initialized.result?._meta ?? {};
  check(
    "contract_version=2",
    meta["xuanling.contract_version"] === "2",
    String(meta["xuanling.contract_version"]),
  );
  check(
    "memory_contract_version=2",
    meta["xuanling.memory_contract_version"] === "2",
    String(meta["xuanling.memory_contract_version"]),
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const toolsResponse = await request(2, "tools/list", {});
  if (toolsResponse.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(toolsResponse)}`);
  }
  const tools = toolsResponse.result?.tools ?? [];
  const names = new Set(tools.map((tool) => tool.name));

  // The count is derived, never hardcoded (plan W7.4, C-12).
  const derivedCount = names.size;
  const metaToolCount = meta["xuanling.tool_count"];
  check(
    "tool_count matches derived list",
    metaToolCount === derivedCount,
    `meta.xuanling.tool_count=${metaToolCount} vs derived=${derivedCount}`,
  );

  const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
  check(
    "required tools present",
    missing.length === 0,
    missing.length === 0 ? "all required present" : `missing: ${missing.join(", ")}`,
  );

  const forbidden = [...FORBIDDEN_NAMES, ...FORBIDDEN_FRAGMENTS].filter((fragment) =>
    [...names].some((name) => name === fragment || name.includes(fragment)),
  );
  check(
    "forbidden tools absent",
    forbidden.length === 0,
    forbidden.length === 0 ? "none present" : `found: ${forbidden.join(", ")}`,
  );

  // process_run must keep the full stdout/stderr tagged union (string modes
  // plus {file:{path}}) — narrowing it breaks host deserialization (C-12).
  const processRun = tools.find((tool) => tool.name === "process_run");
  const inputSchema = processRun?.inputSchema ?? {};
  const defs = inputSchema.$defs ?? {};
  const rawStdout = inputSchema.properties?.stdout;
  const ref = rawStdout?.$ref;
  const resolved =
    ref === "#/$defs/ProcessStreamMode" && defs.ProcessStreamMode ? defs.ProcessStreamMode : rawStdout;
  const stdoutModes = resolved?.oneOf ?? resolved?.anyOf ?? [];
  const hasStringModes = stdoutModes.some(
    (variant) => variant?.type === "string" && (variant?.enum || variant?.const),
  );
  const hasFileObject = stdoutModes.some(
    (variant) => variant?.properties?.file?.properties?.path,
  );
  check(
    "process_run stdout keeps string+{file:{path}} union",
    hasStringModes && hasFileObject,
    `string modes=${hasStringModes}, file object=${hasFileObject}`,
  );

  child.stdin.end();
  const exit = await childSettled;
  if (protocolFailure) {
    throw protocolFailure;
  }
  if (exit.code !== 0 || exit.signal) {
    throw new Error(`server exited as ${JSON.stringify(exit)}; stderr:\n${stderr}`);
  }
  if (frames.some((frame) => frame.jsonrpc !== "2.0")) {
    throw new Error("stdout contained a non-JSON-RPC frame");
  }
} finally {
  clearTimeout(timeout);
  lineReader.close();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the state check and kill.
    }
  }
  await childSettled.catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}

const failed = checks.filter((checkEntry) => !checkEntry.ok);
for (const checkEntry of checks) {
  console.log(`${checkEntry.ok ? "PASS" : "FAIL"} ${checkEntry.name}: ${checkEntry.detail}`);
}
if (failed.length > 0) {
  console.error(`verify-mcp-contract: ${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`verify-mcp-contract OK: ${checks.length} checks, ${checks.length} passed`);
