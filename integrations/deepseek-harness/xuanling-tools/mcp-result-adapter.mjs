#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const TEXT_RESULT_DUPLICATE_LIMIT = 1;
const CHILD_TERMINATION_GRACE_MS = 500;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function parseFrame(line) {
  try {
    const frame = JSON.parse(line);
    return isRecord(frame) ? frame : undefined;
  } catch {
    return undefined;
  }
}

function validateChildFrame(line) {
  if (!parseFrame(line)) throw new Error("invalid JSON or malformed child frame");
}

export function requestMethodAndId(line) {
  const frame = parseFrame(line);
  if (!frame || typeof frame.method !== "string" || !Object.hasOwn(frame, "id")) return undefined;
  return { id: requestIdKey(frame.id), method: frame.method };
}

function parsedJsonText(text) {
  if (typeof text !== "string") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function matchesStructuredContent(block, structuredContent) {
  if (!isRecord(block) || block.type !== "text") return false;
  const parsed = parsedJsonText(block.text);
  return parsed.ok && isDeepStrictEqual(parsed.value, structuredContent);
}

/**
 * DSH keeps the complete text projection for Native/model rendering. If a
 * server or an intermediate bridge accidentally emits the same structured
 * JSON text block more than once, retain one copy and preserve the canonical
 * structured value for Code Mode and output validation.
 */
export function projectDshCallResult(result) {
  if (!isRecord(result) || !Array.isArray(result.content) || !Object.hasOwn(result, "structuredContent")) {
    return result;
  }

  const matching = result.content.filter((block) =>
    matchesStructuredContent(block, result.structuredContent),
  );
  if (matching.length <= TEXT_RESULT_DUPLICATE_LIMIT) return result;

  let retained = false;
  const content = result.content.filter((block) => {
    if (!matchesStructuredContent(block, result.structuredContent)) return true;
    if (retained) return false;
    retained = true;
    return true;
  });
  return { ...result, content };
}

export function projectDshResponseFrame(line, pendingToolCallIds) {
  const frame = parseFrame(line);
  if (
    !frame ||
    !Object.hasOwn(frame, "id") ||
    Object.hasOwn(frame, "method") ||
    (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))
  ) return line;
  const key = requestIdKey(frame.id);
  if (!pendingToolCallIds.delete(key)) return line;
  if (!isRecord(frame.result)) return line;
  const projected = projectDshCallResult(frame.result);
  return projected === frame.result ? line : JSON.stringify({ ...frame, result: projected });
}

function usageError(message) {
  throw new Error(`${message}; usage: mcp-result-adapter.mjs --binary <server> -- [args...]`);
}

function parseAdapterArgs(argv) {
  if (argv[0] !== "--binary" || typeof argv[1] !== "string" || argv[1].length === 0) {
    usageError("--binary is required");
  }
  if (argv[2] !== "--") usageError("expected -- before MCP server arguments");
  return { binary: argv[1], childArgs: argv.slice(3) };
}

export function runAdapter(argv = process.argv.slice(2)) {
  const { binary, childArgs } = parseAdapterArgs(argv);
  const child = spawn(binary, childArgs, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
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
    process.stderr.write(
      `xuanling-dsh-result-adapter: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    clientLines.close();
    serverLines.close();
    terminateChild("SIGTERM");
  }

  clientLines.on("line", (line) => {
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
      const projected = projectDshResponseFrame(line, pendingToolCallIds);
      if (!process.stdout.write(`${projected}\n`)) serverLines.pause();
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
    if (pendingToolCallIds.size > 0) {
      failAdapter(new Error(`child exited with ${pendingToolCallIds.size} unresolved tools/call request(s)`));
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
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runAdapter();
