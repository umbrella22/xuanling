import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg } from "./shared.mjs";

// Full memory-v2 lifecycle acceptance over raw MCP (plan W8.11 step 10, used
// pre-switch against the staged binary and again post-switch through ZCode):
// candidate create -> (invisible until review) -> approve -> get -> search ->
// feedback -> replace (CAS) -> approve -> get rev2 -> search -> archive ->
// approve -> archived no longer searchable, history still retrievable.
// The server always gets an explicit unique temp --memory-db (C-15).

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(requiredArg(args, "binary"));

const NS = `accept-${Date.now()}`;
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-mcp-workflow-"));
const child = spawn(
  binary,
  [
    "--workspace-root",
    temporaryDirectory,
    "--memory-db",
    path.join(temporaryDirectory, "memory.db"),
    "--default-namespace",
    NS,
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

let nextId = 1;
function request(method, params) {
  const id = nextId++;
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
  rejectPending(new Error(`memory workflow timed out; stderr:\n${stderr}`));
}, 30_000);

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? "" });
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`);
  }
}

async function call(tool, arguments_) {
  const response = await request("tools/call", { name: tool, arguments: arguments_ });
  if (response.error) {
    throw new Error(`${tool} protocol error: ${JSON.stringify(response.error)}`);
  }
  if (response.result?.isError) {
    const text = response.result.content?.map((part) => part.text ?? "").join("") ?? "";
    throw new Error(`${tool} domain error: ${text}`);
  }
  return response.result?.structuredContent ?? response.result;
}

const SCOPE = { type: "global" };
const PAYLOAD = (content) => ({
  kind: "fact",
  title: "acceptance",
  content,
  tags: ["workflow"],
  applicability: {},
  pinned: false,
});

try {
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "memory-workflow", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // 1. candidate_create p1 (pending proposal)
  const created = await call("memory_candidate_create", {
    proposal_id: "wf-1",
    idempotency_key: "wf-idem-1",
    proposer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    payload: PAYLOAD("first acceptance fact about cargo rust"),
  });
  step("candidate_create pending", created.proposal_id === "wf-1" && created.status === "pending", JSON.stringify(created.status));

  // 2. invisible until approved
  const invisible = await call("memory_search", {
    namespace: NS,
    scope: SCOPE,
    scope_mode: "exact",
    query: "acceptance fact",
    candidate_limit: 10,
    limit: 5,
  });
  step("candidate invisible before review", (invisible.items ?? []).length === 0, `items=${(invisible.items ?? []).length}`);

  // 3. approve
  const review = await call("memory_review", {
    idempotency_key: "wf-review-1",
    reviewer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    proposal_id: "wf-1",
    expected_proposal_revision: 1,
    decision: "approve",
  });
  step("review approve", review.proposal_id === "wf-1" && review.status === "approved", JSON.stringify(review.status));

  // 4. get current revision
  const got = await call("memory_get", {
    namespace: NS,
    scope: SCOPE,
    record_id: "wf-1",
    revision: null,
  });
  const gotRecord = got.record ?? got;
  step("memory_get rev1", gotRecord.content === "first acceptance fact about cargo rust" && gotRecord.revision === 1, `rev=${gotRecord.revision}`);

  // 5. search recalls it
  const found = await call("memory_search", {
    namespace: NS,
    scope: SCOPE,
    scope_mode: "exact",
    query: "cargo rust",
    candidate_limit: 10,
    limit: 5,
  });
  step("search recalls approved record", (found.items ?? []).some((i) => i.record?.id === "wf-1"), `items=${(found.items ?? []).length}`);

  // 6. feedback bound to revision 1
  const feedback = await call("memory_feedback", {
    event_id: "wf-e1",
    idempotency_key: "wf-fb-1",
    record_id: "wf-1",
    revision: 1,
    feedback: "helpful",
  });
  step("feedback accepted", feedback.event_id === "wf-e1" || feedback.ok === true || feedback.record_id === "wf-1", JSON.stringify(feedback));

  // 7. replace with CAS on revision 1
  await call("memory_candidate_replace", {
    proposal_id: "wf-2",
    idempotency_key: "wf-idem-2",
    proposer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    target_record_id: "wf-1",
    target_revision: 1,
    payload: PAYLOAD("replaced acceptance fact about cargo rust"),
  });
  await call("memory_review", {
    idempotency_key: "wf-review-2",
    reviewer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    proposal_id: "wf-2",
    expected_proposal_revision: 1,
    decision: "approve",
  });
  const replaced = await call("memory_get", { namespace: NS, scope: SCOPE, record_id: "wf-1", revision: null });
  const replacedRecord = replaced.record ?? replaced;
  step("replace advances to rev2", replacedRecord.revision === 2 && replacedRecord.content === "replaced acceptance fact about cargo rust", `rev=${replacedRecord.revision}`);

  // 8. archive with CAS on revision 2
  await call("memory_candidate_archive", {
    proposal_id: "wf-3",
    idempotency_key: "wf-idem-3",
    proposer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    target_record_id: "wf-1",
    target_revision: 2,
  });
  await call("memory_review", {
    idempotency_key: "wf-review-3",
    reviewer_id: "workflow",
    namespace: NS,
    scope: SCOPE,
    proposal_id: "wf-3",
    expected_proposal_revision: 1,
    decision: "approve",
  });

  // 9. archived: not searchable, history still retrievable
  const afterArchive = await call("memory_search", {
    namespace: NS,
    scope: SCOPE,
    scope_mode: "exact",
    query: "cargo rust",
    candidate_limit: 10,
    limit: 5,
  });
  step("archived not searchable", (afterArchive.items ?? []).length === 0, `items=${(afterArchive.items ?? []).length}`);
  const history = await call("memory_get", { namespace: NS, scope: SCOPE, record_id: "wf-1", revision: 2 });
  const historyRecord = history.record ?? history;
  step("history preserved after archive", historyRecord.content === "replaced acceptance fact about cargo rust", `rev=${historyRecord.revision}`);

  child.stdin.end();
  const exit = await childSettled;
  if (protocolFailure) {
    throw protocolFailure;
  }
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
      // The child may have exited between the state check and kill.
    }
  }
  await childSettled.catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}

const failed = steps.filter((entry) => !entry.ok);
for (const entry of steps.filter((s) => s.ok)) {
  console.log(`PASS ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`);
}
if (failed.length > 0) {
  console.error(`memory workflow: ${failed.length}/${steps.length} steps FAILED`);
  process.exit(1);
}
console.log(`memory workflow OK: ${steps.length}/${steps.length} steps passed`);
