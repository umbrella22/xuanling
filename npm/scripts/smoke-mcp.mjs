import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
if ((args.binary === undefined) === (args.launcher === undefined)) {
  throw new Error("Pass exactly one of --binary <path> or --launcher <path>");
}

const command =
  args.binary !== undefined ? path.resolve(requiredArg(args, "binary")) : process.execPath;
const commandPrefix =
  args.launcher !== undefined ? [path.resolve(requiredArg(args, "launcher"))] : [];
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-mcp-npm-smoke-"));
const child = spawn(
  command,
  [
    ...commandPrefix,
    "--workspace-root",
    temporaryDirectory,
    "--memory-db",
    path.join(temporaryDirectory, "memory.db"),
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

const childSettled = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    resolve({ code, signal });
  });
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
  rejectPending(new Error(`MCP smoke timed out; stderr:\n${stderr}`));
}, 30_000);

try {
  const initialized = await request(1, "initialize", {
    capabilities: {},
    clientInfo: { name: "npm-release-smoke", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const tools = await request(2, "tools/list", {});
  const toolCount = tools.result?.tools?.length;
  // The count follows the source catalog and is never hardcoded here (plan
  // W7.4, C-12): the verifier script checks the full contract; the smoke only
  // pins that the catalog is non-empty and consistent with the server's own
  // `_meta` tool count.
  const metaToolCount = initialized.result?._meta?.["xuanling.tool_count"];
  if (tools.error || !Number.isInteger(toolCount) || toolCount <= 0) {
    throw new Error(`tools/list returned no tools: ${JSON.stringify(tools)}`);
  }
  if (metaToolCount !== toolCount) {
    throw new Error(
      `_meta xuanling.tool_count (${metaToolCount}) disagrees with tools/list (${toolCount})`,
    );
  }

  const systemInfo = await request(3, "tools/call", {
    arguments: {},
    name: "system_info",
  });
  if (systemInfo.error || !systemInfo.result?.structuredContent) {
    throw new Error(`system_info failed: ${JSON.stringify(systemInfo)}`);
  }

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
  console.log(`npm MCP smoke OK: initialize, ${toolCount} tools, system_info`);
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
