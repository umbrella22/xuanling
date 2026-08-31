#!/usr/bin/env node

import { createRequire } from "node:module";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, requiredArg } from "../../npm/scripts/shared.mjs";

const args = parseArgs(process.argv.slice(2));
const profileRoot = path.resolve(requiredArg(args, "profile-root"));
const bundleName = requiredArg(args, "bundle");
const expectedVersion = requiredArg(args, "expected-version");
const workspaceRoot = await realpath(path.resolve(requiredArg(args, "workspace-root")));
if (!(await stat(workspaceRoot)).isDirectory()) {
  throw new Error(`--workspace-root must name a directory: ${workspaceRoot}`);
}
const binaryOverride = args.binary === undefined
  ? undefined
  : await realpath(path.resolve(requiredArg(args, "binary")));
if (binaryOverride !== undefined && !(await stat(binaryOverride)).isFile()) {
  throw new Error(`--binary must name a file: ${binaryOverride}`);
}

const profileRequire = createRequire(pathToFileURL(path.join(profileRoot, "package.json")));
const wrapperPath = profileRequire.resolve(`${bundleName}/lazy-mcp-client.mjs`);
const adapterPath = profileRequire.resolve(`${bundleName}/mcp-result-adapter.mjs`);
const launcherPath = profileRequire.resolve("@xuanling-rs/xuanling-mcp/bin/xuanling-mcp.js");
const officialBridgePath = profileRequire.resolve("@deepseek-ai/dsh-mcp-client");
const wrapper = await import(pathToFileURL(wrapperPath).href);
const officialBridge = await import(pathToFileURL(officialBridgePath).href);

const registered = new Map();
const effectDisposers = [];
const ctx = {
  root: {},
  logger: {
    error() {},
    info() {},
    warn() {},
  },
  tools: {
    register(definition) {
      if (registered.has(definition.name)) {
        throw new Error(`duplicate DSH tool registration: ${definition.name}`);
      }
      registered.set(definition.name, definition);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (registered.get(definition.name) === definition) registered.delete(definition.name);
      };
    },
  },
  effect(setup) {
    const dispose = setup();
    if (typeof dispose === "function") effectDisposers.push(dispose);
    return dispose;
  },
};

let report;
try {
  await wrapper.applyWithOfficialBridge(
    ctx,
    {
      serverName: "xuanling",
      transport: "stdio",
      command: process.execPath,
      args: [
        adapterPath,
        "--binary",
        binaryOverride ?? process.execPath,
        "--",
        ...(binaryOverride === undefined ? [launcherPath] : []),
        "--workspace-root",
        workspaceRoot,
        "--memory-db",
        path.join(workspaceRoot, "memory.db"),
      ],
      toolCallTimeoutMs: 120000,
    },
    officialBridge.apply,
  );

  const initialTools = [...registered.keys()].sort();
  if (initialTools.length !== 1 || initialTools[0] !== "mcp_catalog__xuanling") {
    throw new Error(`lazy DSH surface mismatch: ${JSON.stringify(initialTools)}`);
  }
  const catalog = registered.get("mcp_catalog__xuanling");
  const activation = await catalog.execute({ query: "system_info", activate: "system_info" });
  const systemInfoTool = registered.get("mcp__xuanling__system_info");
  if (systemInfoTool === undefined) {
    throw new Error("catalog activation did not register mcp__xuanling__system_info");
  }
  const execution = { signal: new AbortController().signal };
  const systemInfo = await systemInfoTool.execute({}, execution);
  const identity = systemInfo?.structuredContent;
  if (identity?.xuanling_version !== expectedVersion) {
    throw new Error(
      `system_info version mismatch: expected ${expectedVersion}, got ${JSON.stringify(identity?.xuanling_version)}`,
    );
  }
  if (identity?.mcp_contract_version !== "3") {
    throw new Error(
      `system_info contract mismatch: expected 3, got ${JSON.stringify(identity?.mcp_contract_version)}`,
    );
  }

  report = {
    schema_version: 1,
    bundle: bundleName,
    runtime_source: binaryOverride === undefined ? "profile_launcher" : "candidate_binary",
    initial_tools: initialTools,
    catalog_total: activation.total_tools,
    activated: activation.activated,
    active_tools: activation.active_tools,
    final_tools: [...registered.keys()].sort(),
    xuanling_version: identity.xuanling_version,
    mcp_contract_version: identity.mcp_contract_version,
  };
} finally {
  for (const dispose of effectDisposers.reverse()) await dispose();
}

if (registered.size !== 0) {
  throw new Error(`DSH lazy verifier leaked registrations: ${JSON.stringify([...registered.keys()])}`);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
