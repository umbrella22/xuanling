#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { parseArgs, requiredArg, stableJson } from "../../npm/scripts/shared.mjs";

const args = parseArgs(process.argv.slice(2));
const zcodeCli = path.resolve(requiredArg(args, "zcode-cli"));
const pluginRoot = await realpath(path.resolve(requiredArg(args, "plugin-root")));
const expectedVersion = requiredArg(args, "expected-version");
const userConfigPath = path.join(os.homedir(), ".zcode", "cli", "config.json");
const nativeDeniedMarker = "XUANLING_REPLACEMENT_NATIVE_TOOL_DISABLED";
const casDeniedMarker = "XUANLING_REPLACEMENT_CAS_REQUIRED";
const replacementMcpPrefix = "mcp__plugin_xuanling-mcp-replace_xuanling__";
const scenarioMarkers = Object.freeze({
  nativeDenied: "zcode-fixture:replacement-enabled-native-denied",
  casDenied: "zcode-fixture:replacement-enabled-cas-denied",
  validEdit: "zcode-fixture:replacement-enabled-valid-edit",
  nativeRestored: "zcode-fixture:replacement-disabled-native-restored",
});

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function fileDigestOrNone(file) {
  try {
    return sha256(await readFile(file));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "none";
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolNames(body) {
  return (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string");
}

function requireTool(names, name, scenario) {
  if (!names.includes(name)) {
    throw new Error(`${scenario} missing tool ${name}; received ${JSON.stringify(names)}`);
  }
  return name;
}

function replacementTool(name) {
  return `${replacementMcpPrefix}${name}`;
}

function summarizeMessage(message) {
  if (!isRecord(message)) return { type: Array.isArray(message) ? "array" : typeof message };
  const content = message.content;
  return {
    role: typeof message.role === "string" ? message.role : undefined,
    name: typeof message.name === "string" ? message.name : undefined,
    tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
    content: typeof content === "string"
      ? { type: "string", bytes: Buffer.byteLength(content, "utf8") }
      : { type: Array.isArray(content) ? "array" : typeof content },
  };
}

function completionChunk(responseId, model, delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-zcode-replacement-${responseId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sendToolCall(response, responseId, model, callId, name, input) {
  sendSse(response, [
    completionChunk(responseId, model, {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: callId,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    }),
    completionChunk(
      responseId,
      model,
      {},
      "tool_calls",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ),
  ]);
}

function sendFinal(response, responseId, model, text) {
  sendSse(response, [
    completionChunk(responseId, model, { role: "assistant", content: text }),
    completionChunk(
      responseId,
      model,
      {},
      "stop",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ),
  ]);
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 8 * 1024 * 1024) {
      throw new Error("mock provider request exceeds 8 MiB");
    }
  }
  const parsed = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("mock provider request body must be an object");
  return parsed;
}

function scenarioFor(messages) {
  const serialized = JSON.stringify(messages ?? []);
  for (const [name, marker] of Object.entries(scenarioMarkers)) {
    if (serialized.includes(marker)) return { name, serialized };
  }
  return undefined;
}

function createMockProvider({ samplePath, beforeSha }) {
  let responseCount = 0;
  const states = Object.fromEntries(
    Object.keys(scenarioMarkers).map((name) => [name, { complete: false, requests: 0 }]),
  );
  const observedToolNames = new Set();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "xuanling-zcode-verifier", object: "model" }],
        }));
        return;
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }

      const body = await readJsonBody(request);
      if (body.stream !== true) throw new Error("ZCode verifier requires streaming chat completions");
      const model = typeof body.model === "string" ? body.model : "xuanling-zcode-verifier";
      const responseId = ++responseCount;
      const scenario = scenarioFor(body.messages);
      const names = toolNames(body);
      for (const name of names) observedToolNames.add(name);

      if (scenario === undefined || names.length === 0) {
        sendFinal(response, responseId, model, "XuanLing ZCode replacement verification");
        return;
      }

      const state = states[scenario.name];
      state.requests += 1;
      const stage = state.requests;

      if (scenario.name === "nativeDenied") {
        if (stage === 1) {
          sendToolCall(response, responseId, model, "call_native_edit_denied", requireTool(
            names,
            "Edit",
            scenario.name,
          ), {
            file_path: samplePath,
            old_string: "alpha",
            new_string: "native-denied",
          });
          return;
        }
        if (!scenario.serialized.includes(nativeDeniedMarker)) {
          throw new Error("native Edit denial was not returned to the model");
        }
        state.complete = true;
        sendFinal(response, responseId, model, "native denial observed");
        return;
      }

      if (scenario.name === "casDenied") {
        if (stage === 1) {
          sendToolCall(response, responseId, model, "call_xuanling_overwrite_without_cas", requireTool(
            names,
            replacementTool("fs_write_text"),
            scenario.name,
          ), {
            path: "sample.txt",
            content: "cas-denied\n",
            mode: "overwrite",
          });
          return;
        }
        if (!scenario.serialized.includes(casDeniedMarker)) {
          throw new Error(
            "missing-CAS denial was not returned to the model; last_message="
            + JSON.stringify(summarizeMessage(body.messages?.at(-1))),
          );
        }
        state.complete = true;
        sendFinal(response, responseId, model, "CAS denial observed");
        return;
      }

      if (scenario.name === "validEdit") {
        if (stage === 1) {
          sendToolCall(response, responseId, model, "call_xuanling_hash", requireTool(
            names,
            replacementTool("fs_hash"),
            scenario.name,
          ), { path: "sample.txt" });
          return;
        }
        if (stage === 2) {
          if (!scenario.serialized.includes(beforeSha)) {
            throw new Error("fs_hash result did not expose the current SHA to the model");
          }
          sendToolCall(response, responseId, model, "call_xuanling_edit_with_cas", requireTool(
            names,
            replacementTool("fs_edit"),
            scenario.name,
          ), {
            path: "sample.txt",
            old: "alpha",
            new: "xuanling-applied",
            expected_sha256: beforeSha,
            include_diff: true,
          });
          return;
        }
        if (!scenario.serialized.includes("xuanling-applied")) {
          throw new Error("CAS-protected fs_edit result did not return to the model");
        }
        state.complete = true;
        sendFinal(response, responseId, model, "XuanLing edit observed");
        return;
      }

      if (scenario.name === "nativeRestored") {
        const xuanlingTools = names.filter((name) => name.startsWith(replacementMcpPrefix));
        if (xuanlingTools.length > 0) {
          throw new Error(`disabled replacement still exposed tools: ${JSON.stringify(xuanlingTools)}`);
        }
        if (stage === 1) {
          sendToolCall(response, responseId, model, "call_native_read_restored", requireTool(
            names,
            "Read",
            scenario.name,
          ), { file_path: samplePath });
          return;
        }
        if (stage === 2) {
          if (!scenario.serialized.includes("alpha")) {
            throw new Error("native Read did not return sample content after replacement disable");
          }
          sendToolCall(response, responseId, model, "call_native_edit_restored", requireTool(
            names,
            "Edit",
            scenario.name,
          ), {
            file_path: samplePath,
            old_string: "alpha",
            new_string: "native-restored",
          });
          return;
        }
        state.complete = true;
        sendFinal(response, responseId, model, "native tools restored");
        return;
      }

      throw new Error(`unexpected scenario: ${scenario.name}`);
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { message: error instanceof Error ? error.message : String(error) },
      }));
    }
  });

  return { observedToolNames, server, states };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!isRecord(address) || typeof address.port !== "number") {
    throw new Error("mock provider did not expose a TCP port");
  }
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function runZcode(workspace, commandArgs, timeoutMs = 90_000) {
  const child = spawn(process.execPath, [zcodeCli, ...commandArgs], {
    cwd: workspace,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      ZCODE_STORAGE_DIR: storageDir,
      no_proxy: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `ZCode exited unsuccessfully (${result.code ?? result.signal}); `
      + `stdout_tail=${stdout.slice(-16000)}; stderr_tail=${stderr.slice(-16000)}`,
    );
  }
  return { stderr, stdout };
}

async function pluginInventory(workspace) {
  const { stdout } = await runZcode(workspace, ["plugins", "list", "--json"]);
  const parsed = JSON.parse(stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("ZCode plugin inventory returned an unexpected shape");
  }
  return parsed;
}

function replacementInventory(inventory, enabled) {
  const plugin = inventory.plugins.find((candidate) => candidate.id === "xuanling-mcp-replace@inline");
  if (!plugin) {
    const pluginIds = inventory.plugins
      .map((candidate) => candidate?.id)
      .filter((id) => typeof id === "string");
    const diagnostics = inventory.diagnostics.map((diagnostic) => ({
      code: diagnostic?.code,
      pluginId: diagnostic?.pluginId,
      severity: diagnostic?.severity,
    }));
    throw new Error(
      `replacement inline plugin is absent; ids=${JSON.stringify(pluginIds)} `
      + `diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
  if (plugin.enabled !== enabled) throw new Error(`replacement enabled=${plugin.enabled}, expected ${enabled}`);
  const diagnostics = inventory.diagnostics.filter(
    (diagnostic) => diagnostic.pluginId === "xuanling-mcp-replace@inline",
  );
  if (diagnostics.length > 0) {
    throw new Error(`replacement diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  return plugin;
}

function workspaceConfig({ baseUrl, enabled, storageDir }) {
  const providerId = "zcode-replacement-fixture";
  const modelId = "xuanling-zcode-verifier";
  return {
    model: { main: `${providerId}/${modelId}` },
    provider: {
      [providerId]: {
        kind: "openai-compatible",
        name: "XuanLing ZCode verification fixture",
        options: {
          baseURL: baseUrl,
          apiKey: "fixture-local-only",
          apiKeyRequired: false,
        },
        models: { [modelId]: { name: "XuanLing ZCode verifier" } },
      },
    },
    permission: { mode: "yolo" },
    plugins: {
      enabled: true,
      dirs: [pluginRoot],
      enabledPlugins: {
        "xuanling-mcp@xuanling-zcode-marketplace": false,
        "xuanling-mcp-replace@inline": enabled,
      },
    },
    features: { skill: false, memory: false, mcp: true },
    storage: {
      dir: storageDir,
      sessionDbPath: path.join(storageDir, "cli", "db", "db.sqlite"),
    },
    network: { noProxy: "127.0.0.1,localhost" },
  };
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "xuanling-zcode-replacement-"));
const workspace = path.join(temporary, "workspace");
const configPath = path.join(workspace, ".zcode", "config.json");
const samplePath = path.join(workspace, "sample.txt");
const storageDir = path.join(temporary, "storage");
const beforeBody = "alpha\n";
const beforeSha = sha256(Buffer.from(beforeBody));
const userConfigBefore = await fileDigestOrNone(userConfigPath);
const mock = createMockProvider({ samplePath, beforeSha });

try {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(samplePath, beforeBody);
  const port = await listen(mock.server);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await writeFile(
    configPath,
    stableJson(workspaceConfig({ baseUrl, enabled: true, storageDir })),
  );

  const enabledInventory = replacementInventory(await pluginInventory(workspace), true);
  if (enabledInventory.hookDetails?.length !== 1 || enabledInventory.hookDetails[0].runnable !== true) {
    throw new Error("enabled replacement hook is not singular and runnable");
  }
  if (enabledInventory.skillCount !== 1 || enabledInventory.mcpServerNames?.length !== 1) {
    throw new Error("enabled replacement did not expose exactly one Skill and one MCP server");
  }

  await runZcode(workspace, ["--json", "--prompt", scenarioMarkers.nativeDenied]);
  if (await readFile(samplePath, "utf8") !== beforeBody || !mock.states.nativeDenied.complete) {
    throw new Error("native Edit denial did not preserve the file and complete the fixture");
  }

  await runZcode(workspace, ["--json", "--prompt", scenarioMarkers.casDenied]);
  if (await readFile(samplePath, "utf8") !== beforeBody || !mock.states.casDenied.complete) {
    throw new Error("missing-CAS denial did not preserve the file and complete the fixture");
  }

  await runZcode(workspace, ["--json", "--prompt", scenarioMarkers.validEdit]);
  if (await readFile(samplePath, "utf8") !== "xuanling-applied\n" || !mock.states.validEdit.complete) {
    throw new Error("valid XuanLing CAS edit did not reach the expected terminal content");
  }

  await writeFile(samplePath, beforeBody);
  await writeFile(
    configPath,
    stableJson(workspaceConfig({ baseUrl, enabled: false, storageDir })),
  );
  const disabledInventory = replacementInventory(await pluginInventory(workspace), false);
  if (
    disabledInventory.skillCount !== 0 ||
    disabledInventory.mcpServerNames?.length !== 0
  ) {
    throw new Error("disabled replacement still contributes Skills or MCP servers");
  }

  await runZcode(workspace, ["--json", "--prompt", scenarioMarkers.nativeRestored]);
  if (await readFile(samplePath, "utf8") !== "native-restored\n" || !mock.states.nativeRestored.complete) {
    throw new Error("native Read/Edit did not recover after replacement disable");
  }

  const userConfigAfter = await fileDigestOrNone(userConfigPath);
  if (userConfigAfter !== userConfigBefore) throw new Error("ZCode user config changed during isolation test");

  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  if (manifest.version !== expectedVersion) {
    throw new Error(`plugin version ${manifest.version} != expected ${expectedVersion}`);
  }

  process.stdout.write(stableJson({
    zcode_cli: zcodeCli,
    plugin_version: manifest.version,
    plugin_enabled_inventory: true,
    hook_runnable: true,
    native_edit_denied: true,
    missing_cas_denied: true,
    hash_then_cas_edit_applied: true,
    replacement_disable_deactivates_components: true,
    native_read_edit_restored: true,
    user_config_unchanged: true,
    observed_tool_names: [...mock.observedToolNames].sort(),
    host_capability_blockers: [
      "native tool names remain visible",
      "native diff card unverified",
      "native image rendering unavailable while Read is denied",
    ],
  }));
} finally {
  await close(mock.server).catch(() => {});
  await rm(temporary, { force: true, recursive: true });
}
