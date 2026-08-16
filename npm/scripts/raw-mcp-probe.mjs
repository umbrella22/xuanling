import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg } from "./shared.mjs";

// Raw MCP probe (plan W7.6/W7.7, C-12): run ONE binary as a stdio server with
// an explicit unique temp --memory-db (C-15: the real default database is
// never opened), then record raw-level facts used to localize responsibility
// across source/debug/installed/release artifacts:
//   - initialize contract version + derived tool count;
//   - fs_read_text with a bounded `output` OBJECT (the shape the host sends);
//   - process_run stdout schema union (string modes + {file:{path}});
//   - whether a tool result carries BOTH `content` and `structuredContent`
//     (raw duplication) and whether they carry equivalent text.
// Prints a single JSON report line; exits non-zero only on spawn/protocol
// failure (a probe ANSWER is never an error — W8 compares reports).

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(requiredArg(args, "binary"));

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-mcp-rawprobe-"));
const fixture = path.join(temporaryDirectory, "probe.txt");
await writeFile(
  fixture,
  "probe fixture line\n".repeat(20) + "the last line carries a unique tail token 7f3c9a\n",
);

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
  rejectPending(new Error(`raw probe timed out; stderr:\n${stderr}`));
}, 30_000);

const report = {
  binary,
  initialize: "failed",
  contractVersion: null,
  memoryContractVersion: null,
  toolCount: null,
  boundedOutputObject: "failed",
  stdoutUnion: { stringModes: false, fileObject: false },
  duplication: { content: false, structuredContent: false, equivalentText: null },
};

try {
  const initialized = await request(1, "initialize", {
    capabilities: {},
    clientInfo: { name: "raw-probe", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  report.initialize = "ok";
  report.contractVersion = initialized.result?._meta?.["xuanling.contract_version"] ?? null;
  report.memoryContractVersion =
    initialized.result?._meta?.["xuanling.memory_contract_version"] ?? null;
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const toolsResponse = await request(2, "tools/list", {});
  const tools = toolsResponse.result?.tools ?? [];
  report.toolCount = tools.length;
  const processRun = tools.find((tool) => tool.name === "process_run");
  const inputSchema = processRun?.inputSchema ?? {};
  const defs = inputSchema.$defs ?? {};
  const rawStdout = inputSchema.properties?.stdout;
  const resolved =
    rawStdout?.$ref === "#/$defs/ProcessStreamMode" && defs.ProcessStreamMode
      ? defs.ProcessStreamMode
      : rawStdout;
  const modes = resolved?.oneOf ?? resolved?.anyOf ?? [];
  report.stdoutUnion.stringModes = modes.some(
    (variant) => variant?.type === "string" && (variant?.enum || variant?.const),
  );
  report.stdoutUnion.fileObject = modes.some(
    (variant) => variant?.properties?.file?.properties?.path,
  );

  // The host-shaped request: fs_read_text with a bounded output OBJECT.
  const readResponse = await request(3, "tools/call", {
    name: "fs_read_text",
    arguments: { path: fixture, output: { mode: "bounded", max_bytes: 64 } },
  });
  if (readResponse.error) {
    report.boundedOutputObject = `error: ${JSON.stringify(readResponse.error)}`;
  } else {
    report.boundedOutputObject = "ok";
    const result = readResponse.result ?? {};
    report.duplication.content = Object.hasOwn(result, "content");
    report.duplication.structuredContent = Object.hasOwn(result, "structuredContent");
    const contentText = Array.isArray(result.content)
      ? result.content.map((part) => part.text ?? "").join("")
      : result.content ?? "";
    const structuredText = JSON.stringify(result.structuredContent ?? null);
    report.duplication.equivalentText = contentText === structuredText;
  }

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

console.log(JSON.stringify(report));
