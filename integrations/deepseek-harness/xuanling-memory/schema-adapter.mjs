#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  projectDshResponseFrame,
  requestMethodAndId,
} from "./mcp-result-adapter.mjs";
import { projectInputSchemaForDsh } from "./schema-projection.mjs";

const CHILD_TERMINATION_GRACE_MS = 500;

function usageError(message) {
  throw new Error(`${message}; usage: schema-adapter.mjs --binary <xuanling-mcp> -- [args...]`);
}

function parseAdapterArgs(argv) {
  if (argv[0] !== "--binary" || typeof argv[1] !== "string" || argv[1].length === 0) {
    usageError("--binary is required");
  }
  if (argv[2] !== "--") usageError("expected -- before xuanling-mcp arguments");
  return { binary: argv[1], childArgs: argv.slice(3) };
}

function requestIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function validateChildFrame(line) {
  try {
    const frame = JSON.parse(line);
    if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) return;
  } catch {
    // Fall through to the boundary error below.
  }
  throw new Error("invalid JSON or malformed child frame");
}

function toolsListRequestId(line) {
  try {
    const frame = JSON.parse(line);
    if (
      typeof frame === "object" &&
      frame !== null &&
      !Array.isArray(frame) &&
      frame.method === "tools/list" &&
      Object.hasOwn(frame, "id")
    ) {
      return requestIdKey(frame.id);
    }
  } catch {
    // The canonical MCP server owns malformed-request diagnostics.
  }
  return undefined;
}

function projectToolsListResponse(line, pendingToolsListIds) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (
    typeof frame !== "object" ||
    frame === null ||
    Array.isArray(frame) ||
    !Object.hasOwn(frame, "id") ||
    Object.hasOwn(frame, "method") ||
    (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))
  ) {
    return line;
  }
  const key = requestIdKey(frame.id);
  if (!pendingToolsListIds.delete(key) || !Array.isArray(frame.result?.tools)) return line;

  frame.result.tools = frame.result.tools.map((tool, index) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      throw new Error(`tools/list result.tools[${index}] is not an object`);
    }
    return {
      ...tool,
      inputSchema: projectInputSchemaForDsh(tool.inputSchema),
    };
  });
  return JSON.stringify(frame);
}

const { binary, childArgs } = parseAdapterArgs(process.argv.slice(2));
const child = spawn(binary, childArgs, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const pendingToolsListIds = new Set();
const pendingToolCallIds = new Set();
let adapterFailed = false;
let forwardedSignal;
let terminationTimer;

child.stderr.pipe(process.stderr);

const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const serverLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

function childIsRunning() {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(signal) {
  if (!childIsRunning()) return;
  child.kill(signal);
  if (terminationTimer !== undefined) return;
  terminationTimer = setTimeout(() => {
    terminationTimer = undefined;
    if (childIsRunning()) child.kill("SIGKILL");
  }, CHILD_TERMINATION_GRACE_MS);
}

function failAdapter(error) {
  if (adapterFailed) return;
  adapterFailed = true;
  process.exitCode = 1;
  process.stderr.write(`xuanling-dsh-schema-adapter: ${error instanceof Error ? error.message : String(error)}\n`);
  clientLines.close();
  serverLines.close();
  terminateChild("SIGTERM");
}

clientLines.on("line", (line) => {
  const id = toolsListRequestId(line);
  if (id !== undefined) pendingToolsListIds.add(id);
  const request = requestMethodAndId(line);
  if (request?.method === "tools/call") pendingToolCallIds.add(request.id);
  if (!child.stdin.write(`${line}\n`)) clientLines.pause();
});
clientLines.once("close", () => {
  if (!child.stdin.destroyed) child.stdin.end();
});
child.stdin.on("drain", () => clientLines.resume());
child.stdin.on("error", (error) => {
  if (child.exitCode === null && child.signalCode === null) failAdapter(error);
});

serverLines.on("line", (line) => {
  if (adapterFailed) return;
  try {
    validateChildFrame(line);
    const projected = projectToolsListResponse(line, pendingToolsListIds);
    const resultProjected = projectDshResponseFrame(projected, pendingToolCallIds);
    if (!process.stdout.write(`${resultProjected}\n`)) serverLines.pause();
  } catch (error) {
    failAdapter(error);
  }
});
process.stdout.on("drain", () => serverLines.resume());

child.once("error", failAdapter);
child.once("close", (code, signal) => {
  if (terminationTimer !== undefined) clearTimeout(terminationTimer);
  clientLines.close();
  serverLines.close();
  if (adapterFailed) return;
  if (forwardedSignal !== undefined) {
    process.exitCode = 1;
    return;
  }
  if (code !== 0 || signal !== null) {
    process.exitCode = code ?? 1;
    return;
  }
  if (pendingToolCallIds.size > 0 || pendingToolsListIds.size > 0) {
    failAdapter(new Error(
      `child exited with unresolved tools/call=${pendingToolCallIds.size}, tools/list=${pendingToolsListIds.size}`,
    ));
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (forwardedSignal !== undefined) return;
    forwardedSignal = signal;
    clientLines.close();
    terminateChild(signal);
  });
}
