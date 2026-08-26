import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg, REPO_ROOT } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(REPO_ROOT, requiredArg(args, "binary"));
const rounds = positiveInteger(args.rounds, "rounds", 200);
const warmupRounds = positiveInteger(args.warmup, "warmup", 20);
const profile = typeof args.profile === "string" ? args.profile : null;

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new Error(`--${name} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-catalog-bench-"));
const childArgs = [
  "--workspace-root",
  temporaryDirectory,
  "--memory-db",
  path.join(temporaryDirectory, "memory.db"),
];
if (profile) childArgs.push("--tool-profile", profile);

const child = spawn(binary, childArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
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
let nextId = 1;

function rejectPending(error) {
  protocolFailure ??= error;
  for (const waiter of pending.values()) waiter.reject(error);
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
  rejectPending,
);

const lineReader = readline.createInterface({ input: child.stdout });
lineReader.on("line", (line) => {
  if (!line.trim()) return;
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
  if (protocolFailure) throw protocolFailure;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method, params) {
  const id = nextId++;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ jsonrpc: "2.0", id, method, params });
  return response;
}

async function drainCatalog() {
  let cursor;
  let pageCount = 0;
  let toolCount = 0;
  const started = process.hrtime.bigint();
  do {
    const response = await request("tools/list", cursor ? { cursor } : {});
    if (response.error || !Array.isArray(response.result?.tools)) {
      throw new Error(`tools/list failed: ${JSON.stringify(response)}`);
    }
    pageCount += 1;
    toolCount += response.result.tools.length;
    cursor = response.result.nextCursor;
  } while (cursor);
  return {
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    pageCount,
    toolCount,
  };
}

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
  rejectPending(new Error(`catalog benchmark timed out; stderr:\n${stderr}`));
}, 60_000);

try {
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "xuanling-catalog-benchmark", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  let expected;
  for (let index = 0; index < warmupRounds; index += 1) {
    expected = await drainCatalog();
  }

  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const sample = await drainCatalog();
    if (sample.toolCount !== expected.toolCount || sample.pageCount !== expected.pageCount) {
      throw new Error(
        `catalog changed during benchmark: expected ${JSON.stringify(expected)}, got ${JSON.stringify(sample)}`,
      );
    }
    samples.push(sample.elapsedMs);
  }
  samples.sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;

  console.log(
    JSON.stringify({
      benchmark: "mcp_catalog_roundtrip",
      binary,
      catalogSha256: initialized.result?._meta?.["xuanling.catalog_sha256"] ?? null,
      profile: profile ?? "all",
      toolCount: expected.toolCount,
      pageCount: expected.pageCount,
      warmupRounds,
      rounds,
      latencyMs: {
        min: samples[0],
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        mean,
        max: samples.at(-1),
      },
    }),
  );

  child.stdin.end();
  const exit = await childSettled;
  if (protocolFailure) throw protocolFailure;
  if (exit.code !== 0 || exit.signal) {
    throw new Error(`MCP server exited as ${JSON.stringify(exit)}; stderr:\n${stderr}`);
  }
} finally {
  clearTimeout(timeout);
  lineReader.close();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await childSettled.catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}
