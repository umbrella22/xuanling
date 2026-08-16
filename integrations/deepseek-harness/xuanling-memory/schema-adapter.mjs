#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";

import { projectInputSchemaForDsh } from "./schema-projection.mjs";

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
  if (typeof frame !== "object" || frame === null || Array.isArray(frame) || !Object.hasOwn(frame, "id")) {
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
let adapterFailed = false;

child.stderr.pipe(process.stderr);

const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const serverLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

function failAdapter(error) {
  if (adapterFailed) return;
  adapterFailed = true;
  process.exitCode = 1;
  process.stderr.write(`xuanling-dsh-schema-adapter: ${error instanceof Error ? error.message : String(error)}\n`);
  clientLines.close();
  serverLines.close();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

clientLines.on("line", (line) => {
  const id = toolsListRequestId(line);
  if (id !== undefined) pendingToolsListIds.add(id);
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
  try {
    const projected = projectToolsListResponse(line, pendingToolsListIds);
    if (!process.stdout.write(`${projected}\n`)) serverLines.pause();
  } catch (error) {
    failAdapter(error);
  }
});
process.stdout.on("drain", () => serverLines.resume());

child.once("error", failAdapter);
child.once("close", (code, signal) => {
  clientLines.close();
  serverLines.close();
  if (!adapterFailed && (code !== 0 || signal !== null)) {
    process.exitCode = code ?? 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
