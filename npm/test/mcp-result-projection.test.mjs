import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  projectDshCallResult,
} from "../../integrations/deepseek-harness/xuanling-memory/mcp-result-adapter.mjs";
import {
  projectZcodeCallResult,
} from "../../integrations/zcode-plugin/plugins/xuanling-mcp/mcp-result-adapter.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const dshAdapter = path.join(
  repoRoot,
  "integrations",
  "deepseek-harness",
  "xuanling-tools",
  "mcp-result-adapter.mjs",
);
const dshSchemaAdapter = path.join(
  repoRoot,
  "integrations",
  "deepseek-harness",
  "xuanling-memory",
  "schema-adapter.mjs",
);
const zcodeAdapter = path.join(
  repoRoot,
  "integrations",
  "zcode-plugin",
  "plugins",
  "xuanling-mcp",
  "mcp-result-adapter.mjs",
);
const runtimeAdapters = [
  ["ZCode", zcodeAdapter],
  ["DSH result", dshAdapter],
  ["DSH schema", dshSchemaAdapter],
];
const projectionVerifier = path.join(
  repoRoot,
  "test",
  "host-integration",
  "verify-result-projection.mjs",
);
const projectionFixtures = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "result-projection",
);
const costVerifier = path.join(
  repoRoot,
  "test",
  "host-integration",
  "verify-result-cost-report.mjs",
);
const costFixtures = path.join(
  repoRoot,
  "test",
  "host-integration",
  "fixtures",
  "result-cost",
);

const structured = { answer: 42, nested: { ok: true } };
const structuredText = JSON.stringify(structured);

function verifyProjectionFixture(name) {
  const result = spawnSync(
    process.execPath,
    [projectionVerifier, "--fixture", path.join(projectionFixtures, name)],
    { encoding: "utf8" },
  );
  const report = result.stdout ? JSON.parse(result.stdout) : undefined;
  return { ...result, report };
}

function analyzeCostFixture(name) {
  const result = spawnSync(
    process.execPath,
    [costVerifier, "--analyze", path.join(costFixtures, name)],
    { encoding: "utf8" },
  );
  const report = result.stdout ? JSON.parse(result.stdout) : undefined;
  return { ...result, report };
}

test("cost analyzer keeps wire/model/structured/UI layers separate and deterministic", () => {
  const first = analyzeCostFixture("valid.json");
  const second = analyzeCostFixture("valid.json");
  const third = analyzeCostFixture("valid.json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout, third.stdout);
  assert.equal(first.report.verification.status, "pass");
  assert.equal(first.report.catalog.prefix_stable, true);
  assert.equal(first.report.tool_usage.available_tools, 2);
  assert.equal(first.report.tool_usage.call_count, 3);
  assert.equal(first.report.tool_usage.retry_count, 1);
  assert.equal(first.report.tool_usage.distinct_tool_call_rate, 0.5);
  assert.equal(first.report.provider_usage.cold_input_tokens, 120);
  assert.equal(first.report.provider_usage.warm_input_tokens, 45);
  assert.equal(first.report.catalog.schema_tokens.status, "known");
  assert.equal(first.report.result_layers.wire_bytes.status, "known");
  assert.equal(first.report.result_layers.ui_bytes.status, "known");
  assert.notEqual(
    first.report.result_layers.wire_bytes.value,
    first.report.result_layers.model_visible_text_bytes.value,
  );
  assert.notEqual(
    first.report.result_layers.wire_bytes.value,
    first.report.result_layers.structured_bytes.value,
  );
});

test("cost analyzer preserves unavailable schema tokenization as an explicit unknown", () => {
  const result = analyzeCostFixture("zcode-restart-live-0.2.4.json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.verification.status, "pass");
  assert.equal(result.report.catalog.schema_tokens.status, "unknown");
  assert.equal(result.report.catalog.schema_tokens.value, null);
  assert.equal(result.report.catalog.schema_tokens.reason, "token_measurement_unavailable");
  assert.equal(
    result.report.catalog.schema_tokens.source,
    "unknown-provider-tokenizer-not-exposed-by-ZCode",
  );
  assert.equal(result.report.provider_usage.status, "known");
});

test("cost report verification accepts complete reports and rejects unknown usage", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-cost-report-"));
  try {
    const valid = analyzeCostFixture("valid.json");
    const validPath = path.join(temporary, "valid-report.json");
    await writeFile(validPath, valid.stdout);
    const verified = spawnSync(process.execPath, [costVerifier, "--verify", validPath], {
      encoding: "utf8",
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout, valid.stdout);

    const unavailableTokenizer = analyzeCostFixture("zcode-restart-live-0.2.4.json");
    const unavailableTokenizerPath = path.join(temporary, "unavailable-tokenizer-report.json");
    await writeFile(unavailableTokenizerPath, unavailableTokenizer.stdout);
    const unavailableTokenizerVerified = spawnSync(
      process.execPath,
      [costVerifier, "--verify", unavailableTokenizerPath],
      { encoding: "utf8" },
    );
    assert.equal(unavailableTokenizerVerified.status, 0, unavailableTokenizerVerified.stderr);
    assert.equal(unavailableTokenizerVerified.stdout, unavailableTokenizer.stdout);

    const unknown = analyzeCostFixture("missing-usage.json");
    const unknownPath = path.join(temporary, "unknown-report.json");
    await writeFile(unknownPath, unknown.stdout);
    const rejected = spawnSync(process.execPath, [costVerifier, "--verify", unknownPath], {
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /report verification failed.*usage_candidates=0/);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("missing or ambiguous provider usage stays unknown and fails closed", () => {
  for (const name of ["missing-usage.json", "ambiguous-usage.json"]) {
    const result = analyzeCostFixture(name);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.equal(result.report.provider_usage.status, "unknown");
    assert.equal(result.report.provider_usage.cold_input_tokens, null);
    assert.equal(result.report.provider_usage.warm_input_tokens, null);
    assert.match(result.stderr, /report_incomplete.*usage_candidates=/);
  }
});

test("UI-only evidence cannot be promoted into model or provider cost", () => {
  const result = analyzeCostFixture("ui-only.json");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported fields|model_text.*must be a string/);
});

test("released ZCode 3.7.7/raw 0.2.3 baseline fails the unique model projection oracle", () => {
  const result = verifyProjectionFixture("zcode-3.7.7-raw-0.2.3.json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /projection_not_unique.*got 2/);
  assert.equal(result.report.wire.equivalent_structured_text_blocks, 1);
  assert.equal(result.report.model.equivalent_structured_value_count, 2);
  assert.equal(result.report.model.unique_structured_projection, false);
});

test("DSH canonical baseline keeps one Native text value and Code Mode structured content", () => {
  const result = verifyProjectionFixture("dsh-47f94385-canonical.json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.wire.equivalent_structured_text_blocks, 1);
  assert.equal(result.report.model.equivalent_structured_value_count, 1);
  assert.equal(result.report.model.unique_structured_projection, true);
  assert.equal(result.report.code_mode.structured_content_preserved, true);
});

test("DSH duplicate fixture fails for two Native-equivalent text values", () => {
  const result = verifyProjectionFixture("dsh-duplicate.json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /projection_not_unique.*got 2/);
  assert.equal(result.report.wire.equivalent_structured_text_blocks, 2);
  assert.equal(result.report.model.equivalent_structured_value_count, 2);
});

test("DSH result projection removes only duplicate structured text blocks", () => {
  const result = {
    content: [
      { type: "text", text: "human context" },
      { type: "text", text: structuredText },
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ],
    structuredContent: structured,
    isError: false,
  };
  const projected = projectDshCallResult(result);
  assert.deepEqual(projected.structuredContent, structured);
  assert.deepEqual(projected.content, [
    { type: "text", text: "human context" },
    { type: "text", text: structuredText },
  ]);
});

test("DSH result projection leaves a single full text projection unchanged", () => {
  const result = { content: [{ type: "text", text: structuredText }], structuredContent: structured };
  assert.strictEqual(projectDshCallResult(result), result);
});

test("ZCode result projection leaves structuredContent and emits one marker", () => {
  const result = {
    content: [{ type: "text", text: structuredText }],
    structuredContent: structured,
  };
  assert.deepEqual(projectZcodeCallResult(result), {
    content: [{ type: "text", text: "Result available in structuredContent." }],
    structuredContent: structured,
  });
});

test("ZCode error projection retains human text and removes duplicate JSON", () => {
  const result = {
    content: [
      { type: "text", text: "permission denied" },
      { type: "text", text: structuredText },
    ],
    structuredContent: structured,
    isError: true,
  };
  assert.deepEqual(projectZcodeCallResult(result), {
    content: [{ type: "text", text: "permission denied" }],
    structuredContent: structured,
    isError: true,
  });
});

test("ZCode error projection keeps a text marker when only non-text blocks remain", () => {
  const result = {
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: structuredText },
    ],
    structuredContent: structured,
    isError: true,
  };
  assert.deepEqual(projectZcodeCallResult(result), {
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "Tool returned an error; structured details follow." },
    ],
    structuredContent: structured,
    isError: true,
  });
});

async function runAdapter(adapterPath, resultContent) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-result-adapter-"));
  const fixture = path.join(temporary, "fixture.mjs");
  await writeFile(
    fixture,
    `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      result: ${JSON.stringify({ content: resultContent, structuredContent: structured })}
    }) + "\\n");
  } else {
    process.stdout.write(line + "\\n");
  }
}
`,
  );

  try {
    const child = spawn(process.execPath, [adapterPath, "--binary", process.execPath, "--", fixture], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "example", arguments: {} },
    }) + "\n");
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    return stdout.trim().split("\n").map((line) => JSON.parse(line));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function runAdapterCommand(
  adapterPath,
  binary,
  childArgs,
  requestFrames,
  { pauseStdoutMs = 0 } = {},
) {
  const child = spawn(process.execPath, [adapterPath, "--binary", binary, "--", ...childArgs], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resumeTimer;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  if (pauseStdoutMs > 0) {
    child.stdout.pause();
    resumeTimer = setTimeout(() => child.stdout.resume(), pauseStdoutMs);
  }
  try {
    for (const frame of requestFrames) {
      if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) await once(child.stdin, "drain");
    }
    child.stdin.end();
    const [code, signal] = await once(child, "close");
    return { exit: { code, signal }, stdout, stderr };
  } finally {
    if (resumeTimer !== undefined) clearTimeout(resumeTimer);
  }
}

async function runAdapterFixture(adapterPath, fixtureSource, requestFrames, options) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-result-adapter-state-"));
  const fixture = path.join(temporary, "fixture.mjs");
  await writeFile(fixture, fixtureSource);
  try {
    return await runAdapterCommand(adapterPath, process.execPath, [fixture], requestFrames, options);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runIgnoredTerminationFixture(adapterPath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-result-adapter-signal-"));
  const fixture = path.join(temporary, "fixture.mjs");
  await writeFile(
    fixture,
    `process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "fixture/ready",
  params: { pid: process.pid },
}) + "\\n");
setInterval(() => {}, 1000);
`,
  );

  const adapter = spawn(
    process.execPath,
    [adapterPath, "--binary", process.execPath, "--", fixture],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let fixturePid;
  adapter.stdout.setEncoding("utf8");
  adapter.stderr.setEncoding("utf8");
  adapter.stdout.on("data", (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf("\n");
    if (fixturePid === undefined && newline >= 0) {
      fixturePid = JSON.parse(stdout.slice(0, newline)).params.pid;
    }
  });
  adapter.stderr.on("data", (chunk) => { stderr += chunk; });
  const closePromise = once(adapter, "close").then(([code, signal]) => ({ code, signal }));

  try {
    adapter.stdin.end();
    const readyDeadline = Date.now() + 1500;
    while (fixturePid === undefined && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(Number.isInteger(fixturePid), `fixture did not become ready: ${stderr}`);

    adapter.kill("SIGTERM");
    const exit = await Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ]);
    const timedOut = exit === undefined;
    if (timedOut) {
      adapter.kill("SIGKILL");
      if (processExists(fixturePid)) process.kill(fixturePid, "SIGKILL");
      await closePromise;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { exit, timedOut, childAlive: processExists(fixturePid), stdout, stderr };
  } finally {
    if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill("SIGKILL");
    if (Number.isInteger(fixturePid) && processExists(fixturePid)) process.kill(fixturePid, "SIGKILL");
    await rm(temporary, { force: true, recursive: true });
  }
}

test("typed request ids remain distinct when tools/call responses arrive out of order", async () => {
  const fixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const calls = [];
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === "tools/call") calls.push(frame);
}
for (const frame of calls.reverse()) {
  const structuredContent = { request_id: frame.id };
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  }) + "\\n");
}
`;
  const run = await runAdapterFixture(zcodeAdapter, fixture, [
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "first", arguments: {} } },
    { jsonrpc: "2.0", id: "7", method: "tools/call", params: { name: "second", arguments: {} } },
  ]);
  assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr);
  const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((frame) => frame.id), ["7", 7]);
  for (const frame of responses) {
    assert.deepEqual(frame.result.content, [{ type: "text", text: "Result available in structuredContent." }]);
    assert.deepEqual(frame.result.structuredContent, { request_id: frame.id });
  }
});

const serverRequestCollisionFixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method !== "tools/call") continue;
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    method: "sampling/createMessage",
    params: { source: "fixture" },
  }) + "\\n");
  const structuredContent = { request_id: frame.id };
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    result: {
      content: [
        { type: "text", text: JSON.stringify(structuredContent) },
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      ],
      structuredContent,
    },
  }) + "\\n");
}
`;

const errorResponseFixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32603, message: "fixture failure" },
    }) + "\\n");
  }
}
`;

for (const [name, adapter] of runtimeAdapters) {
  test(`${name} does not settle tools/call from a colliding server request`, async () => {
    const run = await runAdapterFixture(adapter, serverRequestCollisionFixture, [
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "sample", arguments: {} } },
    ]);
    assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr);
    const frames = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].method, "sampling/createMessage");
    if (name === "ZCode") {
      assert.deepEqual(frames[1].result.content, [
        { type: "text", text: "Result available in structuredContent." },
      ]);
    } else {
      assert.equal(frames[1].result.content.length, 1);
      assert.deepEqual(JSON.parse(frames[1].result.content[0].text), { request_id: 9 });
    }
  });

  test(`${name} settles and preserves a JSON-RPC error response`, async () => {
    const run = await runAdapterFixture(adapter, errorResponseFixture, [
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "failure", arguments: {} } },
    ]);
    assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32603, message: "fixture failure" },
    });
  });
}

test("DSH schema keeps tools/list pending across a colliding server request", async () => {
  const fixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method !== "tools/list") continue;
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    method: "sampling/createMessage",
    params: { source: "fixture" },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    result: {
      tools: [{
        name: "fixture",
        inputSchema: {
          $defs: { Value: { type: "string" } },
          type: "object",
          properties: { value: { $ref: "#/$defs/Value" } },
        },
      }],
    },
  }) + "\\n");
}
`;
  const run = await runAdapterFixture(dshSchemaAdapter, fixture, [
    { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} },
  ]);
  assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr);
  const frames = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames[0].method, "sampling/createMessage");
  assert.deepEqual(frames[1].result.tools[0].inputSchema, {
    type: "object",
    properties: { value: { type: "string" } },
  });
});

const malformedOutputFixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === "tools/call") process.stdout.write("not-json\\n");
}
`;

const unresolvedCallFixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const _line of lines) {}
`;

const nonzeroExitFixture = `process.exit(23);\n`;
const signaledExitFixture = `process.kill(process.pid, "SIGTERM");\n`;
const backpressureFixture = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const calls = [];
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === "tools/call") calls.push(frame);
}
const humanText = "x".repeat(8192);
for (const frame of calls.reverse()) {
  const structuredContent = { request_id: frame.id };
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    result: {
      content: [
        { type: "text", text: humanText },
        { type: "text", text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    },
  }) + "\\n");
}
`;
const backpressureRequests = Array.from({ length: 192 }, (_, index) => ({
  jsonrpc: "2.0",
  id: index % 2 === 0 ? index : String(index),
  method: "tools/call",
  params: { name: "large-result", arguments: { index } },
}));

for (const [name, adapter] of runtimeAdapters) {
  test(`${name} reports a child spawn error exactly once`, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-result-adapter-missing-"));
    try {
      const missing = path.join(temporary, "missing-mcp-binary");
      const run = await runAdapterCommand(adapter, missing, [], []);
      assert.deepEqual(run.exit, { code: 1, signal: null }, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /ENOENT|spawn.*missing-mcp-binary/i);
      assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test(`${name} preserves a nonzero child exit`, async () => {
    const run = await runAdapterFixture(adapter, nonzeroExitFixture, []);
    assert.deepEqual(run.exit, { code: 23, signal: null }, run.stderr);
    assert.equal(run.stdout, "");
  });

  test(`${name} turns a child signal into a nonzero adapter exit`, async () => {
    const run = await runAdapterFixture(adapter, signaledExitFixture, []);
    assert.deepEqual(run.exit, { code: 1, signal: null }, run.stderr);
    assert.equal(run.stdout, "");
  });

  test(`${name} force-cleans a child that ignores forwarded termination`, async () => {
    const run = await runIgnoredTerminationFixture(adapter);
    assert.equal(run.timedOut, false, run.stderr);
    assert.deepEqual(run.exit, { code: 1, signal: null }, run.stderr);
    assert.equal(run.childAlive, false, `residual fixture process after adapter exit: ${run.stdout}`);
  });

  test(`${name} preserves all frames under delayed stdout backpressure`, async () => {
    const run = await runAdapterFixture(
      adapter,
      backpressureFixture,
      backpressureRequests,
      { pauseStdoutMs: 100 },
    );
    assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr);
    const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, backpressureRequests.length);
    assert.deepEqual(
      responses.map((frame) => frame.id),
      backpressureRequests.map((frame) => frame.id).reverse(),
    );
    for (const frame of responses) {
      assert.equal(frame.result.content[0].text.length, 8192);
      assert.deepEqual(frame.result.structuredContent, { request_id: frame.id });
    }
  });

  test(`${name} fails closed on non-JSON child stdout without a partial frame`, async () => {
    const run = await runAdapterFixture(adapter, malformedOutputFixture, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "broken", arguments: {} } },
    ]);
    assert.deepEqual(run.exit, { code: 1, signal: null }, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /invalid.*JSON|malformed.*frame/i);
  });

  test(`${name} rejects a clean child exit with an unresolved tools/call`, async () => {
    const run = await runAdapterFixture(adapter, unresolvedCallFixture, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing", arguments: {} } },
    ]);
    assert.deepEqual(run.exit, { code: 1, signal: null }, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /unresolved.*tools\/call|pending.*tools\/call/i);
  });
}

test("ZCode error projection treats empty text as no human-readable error", () => {
  const result = {
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "" },
      { type: "text", text: structuredText },
    ],
    structuredContent: structured,
    isError: true,
  };
  assert.deepEqual(projectZcodeCallResult(result), {
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "" },
      { type: "text", text: "Tool returned an error; structured details follow." },
    ],
    structuredContent: structured,
    isError: true,
  });
});

test("projection uses deep JSON equality and preserves similar non-equivalent text", () => {
  const result = {
    content: [
      { type: "text", text: '{"nested":{"ok":true},"answer":42}' },
      { type: "text", text: '{"answer":43,"nested":{"ok":true}}' },
    ],
    structuredContent: structured,
  };
  assert.deepEqual(projectZcodeCallResult(result), {
    content: [
      { type: "text", text: "Result available in structuredContent." },
      { type: "text", text: '{"answer":43,"nested":{"ok":true}}' },
    ],
    structuredContent: structured,
  });
});

test("ZCode adapter changes only tools/call results on the JSONL boundary", async () => {
  const responses = await runAdapter(zcodeAdapter, [{ type: "text", text: structuredText }]);
  assert.deepEqual(responses[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(responses[1].result, {
    content: [{ type: "text", text: "Result available in structuredContent." }],
    structuredContent: structured,
  });
});

test("DSH adapter keeps one complete model projection and structured value", async () => {
  const responses = await runAdapter(dshAdapter, [
    { type: "text", text: structuredText },
    { type: "text", text: JSON.stringify(structured, null, 2) },
  ]);
  assert.deepEqual(responses[1].result, {
    content: [{ type: "text", text: structuredText }],
    structuredContent: structured,
  });
});

test("all DSH bundles ship byte-identical result adapters", async () => {
  const adapters = await Promise.all([
    "xuanling-memory",
    "xuanling-tools",
    "xuanling-tools-replace",
  ].map((bundle) => readFile(path.join(
    repoRoot,
    "integrations",
    "deepseek-harness",
    bundle,
    "mcp-result-adapter.mjs",
  ), "utf8")));
  assert.ok(adapters.every((source) => source === adapters[0]));
});
