import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import manifest from "./package.json" with { type: "json" };

// A window bounds one RPC, never the worker's runtime. Pending windows repeat
// until a terminal result; transport faults never resubmit a task.
const WAIT_WINDOW_MS = 30_000;
const RPC_TIMEOUT_MS = 60_000;
const TERMINALS = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "needs_input",
  "interrupted",
]);
const BRIDGE_CODES = new Set([
  "INVALID_REQUEST",
  "INSTANCE_CHANGED",
  "REQUEST_CONFLICT",
  "BUSY",
  "MEMORY_CAPACITY",
  "PATH_OUTSIDE_ROOT",
  "TASK_READ_FAILED",
  "ADAPTER_UNAVAILABLE",
  "INCOMPATIBLE_CLI",
  "NATIVE_SESSION_PERSISTENCE_UNSUPPORTED",
  "AUTH_REQUIRED",
  "RATE_LIMIT",
  "WORKER_FAILED",
  "NEEDS_INPUT",
  "STREAM_INCOMPLETE",
  "SPAWN_FAILED",
  "CLEANUP_UNCONFIRMED",
  "JOB_NOT_FOUND",
  "JOB_CONTEXT_LOST",
  "RESULT_TOO_LARGE",
  "REPORT_WRITE_FAILED",
  "SENSITIVE_PAYLOAD",
  "CONFIG_INVALID",
  "DEADLINE_EXCEEDED",
  "INTERRUPTED",
]);

export class BridgeFailure extends Error {
  constructor(code) {
    super(`Harness Bridge: ${code}`);
    this.code = code;
  }
}

// An ordinary MCP domain rejection proves this call was rejected. A transport
// failure during submit cannot prove whether the worker was accepted.
class BridgeToolFailure extends BridgeFailure {}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code) => {
  throw new BridgeFailure(code);
};

export function configure(config) {
  if (
    !record(config) ||
    typeof config.command !== "string" ||
    typeof config.configPath !== "string" ||
    !isAbsolute(config.command) ||
    !isAbsolute(config.configPath)
  )
    fail("CONFIG_INVALID");
  if (!["codex", "claude", "dsh", "zcode"].includes(config.adapter)) fail("CONFIG_INVALID");
  if (typeof config.workspaceId !== "string" || config.workspaceId.length === 0)
    fail("CONFIG_INVALID");
  for (const value of [config.providerName ?? "harness-bridge", config.toolName ?? "harness_run"]) {
    if (typeof value !== "string" || value.length === 0) fail("CONFIG_INVALID");
  }
  if (config.saveResult !== undefined && typeof config.saveResult !== "boolean")
    fail("CONFIG_INVALID");
  if (
    config.env !== undefined &&
    (!record(config.env) || Object.values(config.env).some((value) => typeof value !== "string"))
  )
    fail("CONFIG_INVALID");
  return Object.freeze({
    command: config.command,
    configPath: config.configPath,
    adapter: config.adapter,
    workspaceId: config.workspaceId,
    providerName: config.providerName ?? "harness-bridge",
    toolName: config.toolName ?? "harness_run",
    saveResult: config.saveResult ?? false,
    env: Object.freeze({ ...config.env }),
  });
}

function assertWorkspace(config, cwd) {
  // The trusted Bridge config supplies the workspace mapping. A subdirectory
  // must never silently execute at a different root; the MCP API has no cwd.
  try {
    const source = JSON.parse(readFileSync(config.configPath, "utf8"));
    const root = source.workspaces?.[config.workspaceId];
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      !isAbsolute(cwd) ||
      realpathSync(root) !== realpathSync(cwd)
    )
      fail("WORKSPACE_MISMATCH");
  } catch (error) {
    if (error instanceof BridgeFailure) throw error;
    fail("CONFIG_INVALID");
  }
}

export function promptText(prompt) {
  if (
    !Array.isArray(prompt) ||
    prompt.length === 0 ||
    prompt.some(
      (block) => !record(block) || block.type !== "text" || typeof block.text !== "string",
    )
  )
    fail("UNSUPPORTED_PROMPT");
  const text = prompt.map((block) => block.text).join("\n");
  if (!text.trim()) fail("INVALID_REQUEST");
  return text;
}

export function decodeToolResult(result) {
  if (!record(result) || !record(result.structuredContent)) fail("BRIDGE_PROTOCOL_ERROR");
  if (result.isError) {
    const code = result.structuredContent.code;
    throw new BridgeToolFailure(BRIDGE_CODES.has(code) ? code : "BRIDGE_TOOL_ERROR");
  }
  return result.structuredContent;
}

export function validateFinal(value, identity) {
  if (
    !record(value) ||
    !TERMINALS.has(value.status) ||
    value.job_id !== identity.job_id ||
    value.instance_id !== identity.instance_id ||
    value.request_id !== identity.request_id ||
    value.harness !== identity.adapter ||
    typeof value.output_complete !== "boolean" ||
    typeof value.redacted !== "boolean" ||
    !record(value.cleanup) ||
    typeof value.cleanup.confirmed !== "boolean" ||
    (value.worker_final_output !== undefined && typeof value.worker_final_output !== "string")
  )
    fail("BRIDGE_PROTOCOL_ERROR");
  return value;
}

export function subagentResult(final) {
  const output = final.worker_final_output
    ? [{ type: "text", text: final.worker_final_output }]
    : [];
  const complete =
    final.status === "completed" &&
    final.output_complete &&
    final.cleanup.confirmed &&
    !final.delivery_error &&
    !final.report_error &&
    !final.error &&
    final.worker_final_output?.trim();
  const stopReason = complete
    ? "completed"
    : final.status === "cancelled" && final.cleanup.confirmed
      ? "aborted"
      : "error";
  // Diagnostics contain only fixed protocol vocabulary, never raw messages,
  // stderr, paths, prompt text, or provider response bodies.
  const code = !final.cleanup.confirmed
    ? "CLEANUP_UNCONFIRMED"
    : (final.delivery_error?.code ??
      final.error?.code ??
      (final.report_error ? "REPORT_WRITE_FAILED" : "STREAM_INCOMPLETE"));
  return {
    output,
    stopReason,
    ...(complete
      ? {}
      : {
          diagnostic: `Harness Bridge: ${final.status}; ${BRIDGE_CODES.has(code) ? code : "WORKER_FAILED"}`,
        }),
  };
}

export function createConnection(config) {
  const client = new Client({ name: "xuanling-dsh-harness", version: manifest.version });
  const transport = new StdioClientTransport({
    command: config.command,
    args: ["--config", config.configPath],
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "ignore",
  });
  return {
    connect: () => client.connect(transport),
    async call(name, args) {
      return decodeToolResult(
        await client.callTool({ name, arguments: args }, { timeout: RPC_TIMEOUT_MS }),
      );
    },
    close: () => client.close(),
  };
}

/** One Bridge process per activation. Its shutdown cannot stop sibling jobs;
 * no shared job store, reconnect/resubmit, timers for inference, or scheduler. */
export class HarnessRuntime {
  #active = new Set();
  #disposed = false;
  #disposal;
  constructor(config, connect = createConnection) {
    this.config = configure(config);
    this.connect = connect;
  }

  async start({ prompt, cwd, signal }) {
    if (this.#disposed) fail("ADAPTER_DISPOSED");
    if (signal.aborted) fail("ABORTED");
    const text = promptText(prompt);
    assertWorkspace(this.config, cwd);
    const connection = this.connect(this.config);
    const identity = { adapter: this.config.adapter, request_id: `dsh-${randomUUID()}` };
    let final;
    let cancelPromise;
    let disposal;
    let closing = false;
    let acceptanceUncertain = false;
    const startup = Promise.withResolvers();
    const cancel = () => {
      if (final || !identity.job_id) return Promise.resolve(final);
      return (cancelPromise ??= connection
        .call("harness_cancel", { job_id: identity.job_id })
        .then((response) => {
          final = validateFinal(response.result, identity);
          return final;
        }));
    };
    const onAbort = () => {
      void cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const operation = {
      async dispose() {
        closing = true;
        return (disposal ??= (async () => {
          // A submit in flight can still accept. Await its id before closing
          // transport, then explicitly settle that exact job.
          await startup.promise;
          try {
            await cancel();
            if (acceptanceUncertain || (identity.job_id && !final?.cleanup.confirmed))
              fail("CLEANUP_UNCONFIRMED");
          } catch {
            fail("CLEANUP_UNCONFIRMED");
          } finally {
            signal.removeEventListener("abort", onAbort);
            try {
              await connection.close();
            } catch {
              fail("CLEANUP_UNCONFIRMED");
            }
          }
        })());
      },
    };
    this.#active.add(operation);
    try {
      await connection.connect();
      if (signal.aborted || this.#disposed || closing) fail("ABORTED");
      const health = await connection.call("harness_health", {});
      const adapter = health.adapters?.find((row) => row.id === identity.adapter);
      if (
        health.contract_version !== 1 ||
        typeof health.instance_id !== "string" ||
        !adapter?.configured ||
        !adapter.compatible
      )
        fail("ADAPTER_UNAVAILABLE");
      if (!adapter.native_session_persistence_disabled)
        fail("NATIVE_SESSION_PERSISTENCE_UNSUPPORTED");
      identity.instance_id = health.instance_id;
      if (signal.aborted || this.#disposed || closing) fail("ABORTED");
      // Do not abort this RPC: if cancellation races acceptance, retain the
      // accepted job id and explicitly cancel it before rejecting startup.
      acceptanceUncertain = true;
      let accepted;
      try {
        accepted = await connection.call("harness_submit", {
          ...identity,
          workspace_id: this.config.workspaceId,
          prompt: text,
          save_result: this.config.saveResult,
        });
      } catch (error) {
        if (error instanceof BridgeToolFailure) acceptanceUncertain = false;
        throw error;
      }
      if (
        accepted.instance_id !== identity.instance_id ||
        accepted.accepted !== true ||
        typeof accepted.job_id !== "string"
      )
        fail("BRIDGE_PROTOCOL_ERROR");
      identity.job_id = accepted.job_id;
      acceptanceUncertain = false;
      if (signal.aborted || this.#disposed || closing) fail("ABORTED");
      const result = (async () => {
        try {
          while (!final) {
            const response = await connection.call("harness_wait", {
              job_id: identity.job_id,
              wait_ms: WAIT_WINDOW_MS,
            });
            if (response.job_id !== identity.job_id) fail("BRIDGE_PROTOCOL_ERROR");
            if (response.state === "final") final = validateFinal(response.result, identity);
            else if (response.state !== "pending") fail("BRIDGE_PROTOCOL_ERROR");
          }
          return final;
        } catch {
          if (final) return final;
          fail("BRIDGE_TRANSPORT_FAILED");
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      })();
      // A caller may dispose before observing result; contain the rejection.
      void result.catch(() => {});
      startup.resolve();
      return {
        id: `harness-${randomUUID()}`,
        result,
        dispose: async () => {
          try {
            await operation.dispose();
          } finally {
            this.#active.delete(operation);
          }
        },
      };
    } catch (error) {
      startup.resolve();
      try {
        await operation.dispose();
      } finally {
        this.#active.delete(operation);
      }
      throw error instanceof BridgeFailure ? error : new BridgeFailure("BRIDGE_STARTUP_FAILED");
    }
  }

  dispose() {
    this.#disposed = true;
    return (this.#disposal ??= (async () => {
      const results = await Promise.allSettled([...this.#active].map((run) => run.dispose()));
      this.#active.clear();
      if (results.some((result) => result.status === "rejected")) fail("CLEANUP_UNCONFIRMED");
    })());
  }
}
