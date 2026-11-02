import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessRuntime, decodeToolResult, subagentResult } from "../bridge-client.mjs";
import { createProvider, createRunTool } from "../index.mjs";

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "bridge.json");
  writeFileSync(configPath, JSON.stringify({ workspaces: { test: root } }));
  const config = { command: process.execPath, configPath, adapter: "codex", workspaceId: "test" };
  const calls = [];
  const state = { closed: 0, identity: undefined };
  const connection = {
    connect: async () => {},
    async call(name, args) {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](args, state);
      if (name === "harness_health")
        return {
          contract_version: 1,
          instance_id: "inst-test",
          adapters: [
            {
              id: "codex",
              configured: true,
              compatible: true,
              native_session_persistence_disabled: true,
            },
          ],
        };
      if (name === "harness_submit") {
        state.identity = args;
        return { accepted: true, instance_id: "inst-test", job_id: "job-test" };
      }
      if (name === "harness_wait")
        return { state: "final", job_id: "job-test", result: final(state) };
      if (name === "harness_cancel")
        return {
          job_id: "job-test",
          cancelled: true,
          result: final(state, {
            status: "cancelled",
            output_complete: false,
            worker_final_output: undefined,
          }),
        };
      assert.fail(name);
    },
    close: async () => {
      state.closed++;
    },
  };
  const runtime = new HarnessRuntime(config, () => connection);
  const controller = new AbortController();
  const request = {
    prompt: [{ type: "text", text: "  工作任务\n`$() / 🦊  " }],
    cwd: root,
    signal: controller.signal,
  };
  return { root, config, runtime, calls, connection, request, controller, state };
}

function final(state, extra = {}) {
  return {
    job_id: "job-test",
    instance_id: "inst-test",
    request_id: state.identity.request_id,
    harness: "codex",
    status: "completed",
    worker_final_output: "FINAL",
    output_complete: true,
    redacted: false,
    cleanup: { confirmed: true },
    ...extra,
  };
}

test("pending wait windows repeat without a task deadline or resubmission", async (t) => {
  let waits = 0;
  const h = fixture(t, {
    harness_wait: (_args, state) =>
      ++waits < 3
        ? { state: "pending", job_id: "job-test" }
        : { state: "final", job_id: "job-test", result: final(state) },
  });
  const run = await h.runtime.start(h.request);
  assert.equal((await run.result).worker_final_output, "FINAL");
  await run.dispose();
  await run.dispose();
  assert.equal(h.state.closed, 1);
  const submits = h.calls.filter((call) => call.name === "harness_submit");
  assert.equal(submits.length, 1);
  assert.deepEqual(Object.keys(submits[0].args).sort(), [
    "adapter",
    "instance_id",
    "prompt",
    "request_id",
    "save_result",
    "workspace_id",
  ]);
  assert.equal(submits[0].args.prompt, h.request.prompt[0].text);
  assert.equal(submits[0].args.save_result, false);
  assert.equal(waits, 3);
  assert.equal(
    h.calls.some((call) => call.name === "harness_cancel"),
    false,
  );
});

for (const action of ["abort", "dispose"])
  test(`${action} during acceptance cancels the accepted id before startup rejects`, async (t) => {
    const submitted = Promise.withResolvers();
    const accepted = Promise.withResolvers();
    const h = fixture(t, {
      harness_submit: async (args, state) => {
        state.identity = args;
        submitted.resolve();
        await accepted.promise;
        return { job_id: "job-test", instance_id: "inst-test", accepted: true };
      },
    });
    const start = h.runtime.start(h.request);
    await submitted.promise;
    let dispose;
    if (action === "abort") h.controller.abort();
    else dispose = h.runtime.dispose();
    assert.equal(h.state.closed, 0, "in-flight acceptance must retain its transport");
    accepted.resolve();
    await assert.rejects(start, { code: "ABORTED" });
    await dispose;
    assert.deepEqual(
      h.calls.filter((call) => call.name === "harness_cancel").map((call) => call.args),
      [{ job_id: "job-test" }],
    );
    assert.equal(h.state.closed, 1);
  });

test("published cancellation reaches a terminal and disposal is idempotent", async (t) => {
  const waiting = Promise.withResolvers();
  const ended = Promise.withResolvers();
  const h = fixture(t, {
    harness_wait: async () => {
      waiting.resolve();
      return ended.promise;
    },
    harness_cancel: (_args, state) => {
      const value = final(state, { status: "cancelled", output_complete: false });
      ended.resolve({ state: "final", job_id: "job-test", result: value });
      return { result: value };
    },
  });
  const run = await createProvider(h.runtime).start(h.request);
  await waiting.promise;
  h.controller.abort();
  assert.equal((await run.result).stopReason, "aborted");
  await Promise.all([run.dispose(), run.dispose()]);
  assert.equal(h.calls.filter((call) => call.name === "harness_cancel").length, 1);
  assert.equal(h.state.closed, 1);
});

for (const phase of ["published", "accepting"])
  test(`failed cancellation during ${phase} reports fixed cleanup failure and closes transport`, async (t) => {
    const submitted = Promise.withResolvers();
    const accepted = Promise.withResolvers();
    const ended = Promise.withResolvers();
    // Startup can reject before a wait is published.
    void ended.promise.catch(() => {});
    const h = fixture(t, {
      harness_submit: async (args, state) => {
        state.identity = args;
        submitted.resolve();
        if (phase === "accepting") await accepted.promise;
        return { job_id: "job-test", instance_id: "inst-test", accepted: true };
      },
      harness_wait: () => ended.promise,
      harness_cancel: () => {
        ended.reject(new Error("RAW_WAIT_SECRET"));
        throw new Error("RAW_CANCEL_SECRET");
      },
    });
    const start = createProvider(h.runtime).start(h.request);
    await submitted.promise;
    let rejection;
    if (phase === "accepting") {
      h.controller.abort();
      rejection = start;
      accepted.resolve();
    } else {
      const run = await start;
      rejection = run.dispose();
      assert.equal((await run.result).stopReason, "error");
    }
    await assert.rejects(rejection, {
      code: "CLEANUP_UNCONFIRMED",
      message: "Harness Bridge: CLEANUP_UNCONFIRMED",
    });
    assert.equal(h.state.closed, 1);
    assert.equal(h.calls.filter((call) => call.name === "harness_cancel").length, 1);
    assert.equal(h.calls.filter((call) => call.name === "harness_submit").length, 1);
  });

test("unsupported capabilities, prompt blocks, and cwd reject before bridge startup", async (t) => {
  const h = fixture(t);
  const provider = createProvider(h.runtime);
  assert.equal(provider.inheritsParentContext, false);
  assert.deepEqual(provider.capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  });
  for (const key of ["agentOptions", "agentPreset", "outputSchema", "maxDepth"])
    await assert.rejects(provider.start({ ...h.request, [key]: {} }), {
      code: "UNSUPPORTED_CAPABILITY",
    });
  await assert.rejects(
    h.runtime.start({ ...h.request, prompt: [{ type: "image", data: "SECRET" }] }),
    { code: "UNSUPPORTED_PROMPT" },
  );
  await assert.rejects(h.runtime.start({ ...h.request, cwd: tmpdir() }), {
    code: "WORKSPACE_MISMATCH",
  });
  assert.deepEqual(h.calls, []);
});

test("old or persistence-enabled Bridge cannot accept a task", async (t) => {
  const h = fixture(t, {
    harness_health: () => ({
      contract_version: 1,
      instance_id: "old",
      adapters: [{ id: "codex", configured: true, compatible: true }],
    }),
  });
  await assert.rejects(h.runtime.start(h.request), {
    code: "NATIVE_SESSION_PERSISTENCE_UNSUPPORTED",
  });
  assert.equal(
    h.calls.some((call) => call.name === "harness_submit"),
    false,
  );
  assert.equal(h.state.closed, 1);
});

test("delivery and cleanup failures preserve final output without claiming completed", () => {
  const complete = {
    status: "completed",
    worker_final_output: "FINAL",
    output_complete: true,
    cleanup: { confirmed: true },
  };
  assert.equal(subagentResult(complete).stopReason, "completed");
  for (const extra of [
    { output_complete: false },
    { cleanup: { confirmed: false } },
    { delivery_error: { code: "RESULT_TOO_LARGE", message: "SECRET" } },
    { report_error: "SECRET" },
    { error: { code: "AUTH_REQUIRED", message: "SECRET" } },
  ]) {
    const value = subagentResult({ ...complete, ...extra });
    assert.equal(value.stopReason, "error");
    assert.deepEqual(value.output, [{ type: "text", text: "FINAL" }]);
    assert.equal(JSON.stringify(value).includes("SECRET"), false);
  }
  assert.throws(
    () =>
      decodeToolResult({ isError: true, structuredContent: { code: "BUSY", message: "SECRET" } }),
    { code: "BUSY", message: "Harness Bridge: BUSY" },
  );
  assert.throws(() => decodeToolResult({ isError: true, structuredContent: { code: "SECRET" } }), {
    code: "BRIDGE_TOOL_ERROR",
  });
});

test("transport failure is never a completed result or an automatic resubmit", async (t) => {
  const h = fixture(t, {
    harness_wait: () => {
      throw new Error("RAW_SECRET_BODY");
    },
  });
  const run = await createProvider(h.runtime).start(h.request);
  const result = await run.result;
  assert.equal(result.stopReason, "error");
  assert.equal(JSON.stringify(result).includes("RAW_SECRET_BODY"), false);
  await run.dispose();
  assert.equal(h.calls.filter((call) => call.name === "harness_submit").length, 1);
  assert.equal(h.calls.filter((call) => call.name === "harness_cancel").length, 1);
});

test("lost acceptance response reports unconfirmed cleanup and never resubmits", async (t) => {
  const h = fixture(t, {
    harness_submit: () => {
      throw new Error("RAW_ACCEPTANCE_SECRET");
    },
  });
  await assert.rejects(h.runtime.start(h.request), { code: "CLEANUP_UNCONFIRMED" });
  assert.equal(h.state.closed, 1);
  assert.equal(h.calls.filter((call) => call.name === "harness_submit").length, 1);
});

test("an explicit submit rejection preserves the typed Bridge code", async (t) => {
  const h = fixture(t, {
    harness_submit: () =>
      decodeToolResult({
        isError: true,
        structuredContent: { code: "BUSY", message: "RAW_SECRET" },
      }),
  });
  await assert.rejects(h.runtime.start(h.request), {
    code: "BUSY",
    message: "Harness Bridge: BUSY",
  });
  assert.equal(h.state.closed, 1);
});

test("blocking tool waits for final instead of publishing an asynchronous child id", async (t) => {
  const waiting = Promise.withResolvers();
  const ended = Promise.withResolvers();
  const h = fixture(t, {
    harness_wait: () => {
      waiting.resolve();
      return ended.promise;
    },
  });
  const tool = createRunTool(h.runtime, { ensure: async () => h.root });
  let settled = false;
  const output = tool
    .execute({ prompt: "work" }, { agent: {}, signal: h.controller.signal })
    .then((result) => {
      settled = true;
      return result;
    });
  await waiting.promise;
  assert.equal(settled, false);
  ended.resolve({ state: "final", job_id: "job-test", result: final(h.state) });
  assert.equal((await output).worker_final_output, "FINAL");
  assert.equal(h.state.closed, 1);
});

test("mismatched terminal identity cannot deliver another job's answer", async (t) => {
  const h = fixture(t, {
    harness_wait: (_args, state) => ({
      state: "final",
      job_id: "job-test",
      result: final(state, { request_id: "unrelated" }),
    }),
  });
  const run = await createProvider(h.runtime).start(h.request);
  assert.equal((await run.result).stopReason, "error");
  await run.dispose();
});
