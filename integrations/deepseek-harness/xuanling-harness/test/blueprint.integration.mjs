/** Real Blueprint driver + scoped DSH Tools + Bridge process + fake native
 * worker. Only the model's tool choice/turn is scripted. No provider call. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { HarnessRuntime } from "../bridge-client.mjs";
import * as plugin from "../index.mjs";
import { bridgeConfig } from "./support.mjs";
import {
  harness,
  definition,
  agentNode,
  runSaved,
  executeTool,
} from "../../xuanling-blueprint/test/runtime-contracts/agent-fixtures.mjs";
const { createRunTool } = plugin;
const fromBlueprint = createRequire(
  new URL("../../xuanling-blueprint/package.json", import.meta.url),
);
const { SubagentRuntime } = await import(
  pathToFileURL(fromBlueprint.resolve("@deepseek-ai/dsh-subagent"))
);

test("Blueprint binding waits for the Bridge terminal and exposes no process activity", async (t) => {
  const h = await harness(t, {
    config: { toolBindings: { nativeWorker: { tools: ["harness_run"] } } },
    onTurn: async (call) => {
      call.worker = await executeTool(call, "harness_run", {
        prompt: JSON.stringify({ scenario: "success", text: "BLUEPRINT WORKER FINAL" }),
      });
      assert.equal(call.worker.isError, false);
      assert.equal(call.worker.value.status, "completed");
      assert.equal(call.worker.value.cleanup.confirmed, true);
      call.finish(undefined, call.worker.value.worker_final_output);
    },
  });
  const runtime = new HarnessRuntime(bridgeConfig(h.root));
  t.after(() => runtime.dispose());
  h.nativeTools.register(createRunTool(runtime, h.ctx.get("workingDirectory")));
  const graph = definition([agentNode({ toolsetRefs: ["workerTool"] })], {
    worker: { kind: "agent", path: "lib/agents/worker.md" },
    workerTool: { kind: "mcp", bindingId: "nativeWorker" },
  });
  const { record } = await runSaved(h, graph);
  assert.equal(record.state, "succeeded");
  assert.equal(h.host.calls[0].worker.value.worker_final_output, "BLUEPRINT WORKER FINAL");
  assert.equal(JSON.stringify(record).includes("PROCESS-ONLY-MARKER"), false);
});

test("Blueprint node without the explicit binding cannot dispatch a native worker", async (t) => {
  let dispatched = 0;
  const h = await harness(t, {
    onTurn: async (call) => {
      call.worker = await executeTool(call, "harness_run", { prompt: "work" });
      call.finish();
    },
  });
  h.nativeTools.register(
    createRunTool(
      {
        config: { toolName: "harness_run" },
        start: async () => {
          dispatched++;
          assert.fail("undeclared native worker dispatched");
        },
      },
      h.ctx.get("workingDirectory"),
    ),
  );
  await runSaved(h);
  assert.equal(h.host.calls[0].worker.isError, true);
  assert.equal(dispatched, 0);
});

test("Cordis plugin settles through actual DSH subagents and sends one final parent notice", async (t) => {
  let activation;
  const notices = [];
  const h = await harness(t, {
    onTurn: async (call) => {
      call.agent.steer = (message) => notices.push(message);
      activation = await h.ctx.subagents.startActivation({
        provider: "harness-bridge",
        label: "Native result",
        request: {
          parent: call.agent,
          cwd: h.root,
          prompt: [
            { type: "text", text: JSON.stringify({ scenario: "success", text: "EXTERNAL FINAL" }) },
          ],
        },
        signal: new AbortController().signal,
        delivery: "parent",
      });
      const result = await activation.result;
      assert.equal(result.stopReason, "completed");
      assert.deepEqual(result.output, [{ type: "text", text: "EXTERNAL FINAL" }]);
      await activation.dispose();
      call.finish();
    },
  });
  // The existing fixture scripts the Agent factory. Supply its public lookup
  // too so DSH can check the exact live parent and reserve child identities.
  h.host.registry.get = (id) => h.host.calls.find((call) => call.agent.id === id)?.agent;
  const subagents = await h.ctx.plugin(SubagentRuntime, {});
  const fiber = await h.ctx.plugin(plugin, bridgeConfig(h.root));
  assert.equal(h.ctx.subagents.getProvider("harness-bridge").inheritsParentContext, false);
  await runSaved(h);
  assert.ok(activation.childId.startsWith("harness-"));
  assert.equal(notices.length, 1);
  assert.ok(JSON.stringify(notices).includes("EXTERNAL FINAL"));
  assert.equal(JSON.stringify(notices).includes("PROCESS-ONLY-MARKER"), false);
  await fiber.dispose();
  assert.equal(h.ctx.subagents.getProvider("harness-bridge"), undefined);
  await subagents.dispose();
});
