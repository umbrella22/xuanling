#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const adapters = [
  {
    host: "zcode",
    path: path.join(repoRoot, "integrations", "zcode-plugin", "plugins", "xuanling-mcp", "mcp-result-adapter.mjs"),
    childArgs: ["--compat-lenient-object-params"],
    projection: "marker",
  },
  {
    host: "dsh-result",
    path: path.join(repoRoot, "integrations", "deepseek-harness", "xuanling-tools", "mcp-result-adapter.mjs"),
    childArgs: [],
    projection: "complete-text",
  },
  {
    host: "dsh-schema",
    path: path.join(repoRoot, "integrations", "deepseek-harness", "xuanling-memory", "schema-adapter.mjs"),
    childArgs: [],
    projection: "complete-text",
  },
];

function requiredBinary(argv) {
  if (argv.length !== 2 || argv[0] !== "--binary" || argv[1].length === 0) {
    throw new Error("usage: verify-adapter-real-binary.mjs --binary <xuanling-mcp>");
  }
  return path.resolve(argv[1]);
}

function requestIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function equivalentTextBlocks(result) {
  return (result.content ?? []).filter((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return false;
    try {
      return isDeepStrictEqual(JSON.parse(block.text), result.structuredContent);
    } catch {
      return false;
    }
  });
}

async function runAdapter({ host, path: adapterPath, childArgs, projection }, binary, root) {
  const workspace = path.join(root, host, "workspace");
  const memoryDb = path.join(root, host, "memory.db");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "real adapter projection\n");

  const adapter = spawn(
    process.execPath,
    [
      adapterPath,
      "--binary",
      binary,
      "--",
      "--workspace-root",
      workspace,
      "--memory-db",
      memoryDb,
      "--tool-profile",
      "fs",
      ...childArgs,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  let protocolError;

  adapter.stderr.setEncoding("utf8");
  adapter.stderr.on("data", (chunk) => { stderr += chunk; });

  function rejectPending(error) {
    protocolError ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  const lines = readline.createInterface({ input: adapter.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        throw new Error("frame is not an object");
      }
    } catch (error) {
      rejectPending(new Error(`${host} emitted malformed stdout ${JSON.stringify(line)}: ${error.message}`));
      return;
    }
    if (!Object.hasOwn(frame, "id")) return;
    const waiter = pending.get(requestIdKey(frame.id));
    if (!waiter) return;
    pending.delete(requestIdKey(frame.id));
    waiter.resolve(frame);
  });

  const closePromise = new Promise((resolve, reject) => {
    adapter.once("error", reject);
    adapter.once("close", (code, signal) => {
      if (pending.size > 0) {
        rejectPending(new Error(`${host} exited before ${pending.size} response(s); stderr: ${stderr}`));
      }
      resolve({ code, signal });
    });
  });
  adapter.stdin.on("error", rejectPending);

  function send(frame) {
    if (protocolError) throw protocolError;
    adapter.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      pending.set(requestIdKey(id), { resolve, reject });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  const timeout = setTimeout(() => {
    rejectPending(new Error(`${host} real-binary verification timed out; stderr: ${stderr}`));
    if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill("SIGTERM");
  }, 15_000);

  try {
    const initialized = await request("initialize", {
      capabilities: {},
      clientInfo: { name: "xuanling-host-adapter-verifier", version: "0" },
      protocolVersion: "2024-11-05",
    });
    assert.equal(initialized.result?.serverInfo?.name, "xuanling-mcp", `${host}: initialize`);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const listed = await request("tools/list", {});
    assert.equal(listed.error, undefined, `${host}: ${JSON.stringify(listed.error)}`);
    assert.equal(listed.result?.tools?.length, 16, `${host}: fs catalog`);

    const called = await request("tools/call", {
      name: "fs_hash",
      arguments: { path: "fixture.txt" },
    });
    assert.equal(called.error, undefined, `${host}: ${JSON.stringify(called.error)}`);
    assert.equal(called.result?.isError, false, `${host}: fs_hash domain result`);
    assert.equal(called.result?.structuredContent?.algorithm, "sha256", `${host}: structured value`);
    assert.match(called.result?.structuredContent?.digest ?? "", /^[0-9a-f]{64}$/, `${host}: digest`);

    const equivalent = equivalentTextBlocks(called.result);
    if (projection === "marker") {
      assert.equal(equivalent.length, 0, `${host}: duplicate structured text removed`);
      assert.deepEqual(called.result.content, [
        { type: "text", text: "Result available in structuredContent." },
      ]);
    } else {
      assert.equal(equivalent.length, 1, `${host}: one complete text projection`);
      assert.equal(called.result.content.length, 1, `${host}: no duplicate text block`);
    }

    adapter.stdin.end();
    const exit = await closePromise;
    assert.deepEqual(exit, { code: 0, signal: null }, `${host}: ${stderr}`);
    return {
      host,
      catalog_tools: listed.result.tools.length,
      model_text_blocks: called.result.content.length,
      equivalent_structured_text_blocks: equivalent.length,
      structured_content_preserved: true,
    };
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (adapter.exitCode === null && adapter.signalCode === null) {
      adapter.kill("SIGTERM");
      await Promise.race([
        closePromise,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  }
}

const binary = requiredBinary(process.argv.slice(2));
const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-real-adapter-"));
try {
  const results = [];
  for (const adapter of adapters) results.push(await runAdapter(adapter, binary, temporary));
  process.stdout.write(`${JSON.stringify({ status: "pass", binary, results }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`verify-adapter-real-binary: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporary, { force: true, recursive: true });
}
