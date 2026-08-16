#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const MEMORY_TOOLS = [
  "memory_candidate_archive",
  "memory_candidate_create",
  "memory_candidate_get",
  "memory_candidate_list",
  "memory_candidate_replace",
  "memory_feedback",
  "memory_get",
  "memory_review",
  "memory_search",
];

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

function childEnvironment() {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

async function terminateProcessGroup(child) {
  if (child.pid === undefined) return;
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
    } catch {
      // The process group may already be gone.
    }
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  signal("SIGKILL");
}

export async function seedDatabase({ binary, database, fixture }) {
  if (!path.isAbsolute(binary) || !existsSync(binary)) {
    throw new Error("seed binary must be an existing absolute path");
  }
  if (!path.isAbsolute(database)) throw new Error("seed database must be an absolute path");
  if (existsSync(database) || existsSync(`${database}-wal`) || existsSync(`${database}-shm`)) {
    throw new Error(`refusing to seed an existing database path: ${database}`);
  }

  const child = spawn(
    binary,
    [
      "--workspace-root", path.dirname(database),
      "--memory-db", database,
      "--tool-profile", "memory",
    ],
    {
      detached: true,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  let protocolError = null;
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    if (line.trim() === "") return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      protocolError = new Error(`seed server emitted non-JSON stdout: ${error}`);
      for (const waiter of pending.values()) waiter.reject(protocolError);
      pending.clear();
      return;
    }
    const waiter = pending.get(frame.id);
    if (waiter !== undefined) {
      pending.delete(frame.id);
      waiter.resolve(frame);
    }
  });
  const settled = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  let nextId = 1;
  const request = (method, params) => {
    if (protocolError !== null) throw protocolError;
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const call = async (name, arguments_) => {
    const response = await request("tools/call", { name, arguments: arguments_ });
    if (response.error !== undefined) {
      throw new Error(`${name} protocol error: ${JSON.stringify(response.error)}`);
    }
    if (response.result?.isError === true) {
      const text = response.result.content?.map((part) => part.text ?? "").join("") ?? "";
      throw new Error(`${name} domain error: ${text}`);
    }
    return response.result?.structuredContent ?? response.result;
  };
  const timeout = setTimeout(() => {
    protocolError = new Error(`seed timed out; stderr:\n${stderr}`);
    for (const waiter of pending.values()) waiter.reject(protocolError);
    pending.clear();
    void terminateProcessGroup(child);
  }, 120_000);

  try {
    const initialized = await request("initialize", {
      capabilities: {},
      clientInfo: { name: "xuanling-dsh-memory-seed", version: "1" },
      protocolVersion: "2024-11-05",
    });
    if (initialized.error !== undefined
      || initialized.result?._meta?.["xuanling.memory_contract_version"] !== "2") {
      throw new Error(`seed initialize failed: ${JSON.stringify(initialized)}`);
    }
    notify("notifications/initialized", {});
    const listed = await request("tools/list", {});
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(MEMORY_TOOLS)) {
      throw new Error(`seed memory profile drifted: ${JSON.stringify(names)}`);
    }

    for (const record of fixture.records) {
      await call("memory_candidate_create", {
        proposal_id: record.id,
        idempotency_key: `dsh-live-create-${record.id}`,
        proposer_id: "dsh-live-seeder",
        namespace: fixture.namespace,
        scope: fixture.scope,
        payload: {
          kind: record.kind,
          title: record.title,
          content: record.content,
          tags: record.tags,
          applicability: {},
          pinned: false,
        },
      });
      await call("memory_review", {
        idempotency_key: `dsh-live-review-${record.id}`,
        reviewer_id: "dsh-live-fixture-reviewer",
        namespace: fixture.namespace,
        scope: fixture.scope,
        proposal_id: record.id,
        expected_proposal_revision: 1,
        decision: "approve",
      });
    }
    child.stdin.end();
    const exit = await settled;
    if (protocolError !== null) throw protocolError;
    if (exit.error !== null || exit.code !== 0 || exit.signal !== null) {
      throw new Error(`seed server exited as ${JSON.stringify(exit)}; stderr:\n${stderr}`);
    }
    return { records: fixture.records.length, tools: names.length };
  } finally {
    clearTimeout(timeout);
    reader.close();
    if (child.exitCode === null && child.signalCode === null) child.stdin.destroy();
    await terminateProcessGroup(child);
    await settled;
  }
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  try {
    const argv = process.argv.slice(2);
    const binary = argValue(argv, "--binary");
    const database = argValue(argv, "--database");
    const fixtureFile = argValue(argv, "--fixture");
    if (binary === undefined || database === undefined || fixtureFile === undefined) {
      throw new Error("--binary, --database, and --fixture are required");
    }
    const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
    const report = await seedDatabase({
      binary: path.resolve(binary),
      database: path.resolve(database),
      fixture,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    console.error(`memory-seed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
