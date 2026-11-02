import { BridgeFailure, HarnessRuntime, subagentResult } from "./bridge-client.mjs";

export const name = "xuanling-harness";
export const inject = ["subagents", "tools"];
export const capabilities = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
});

export function createProvider(runtime) {
  return {
    name: runtime.config.providerName,
    capabilities,
    inheritsParentContext: false,
    async start(request) {
      if (
        ["agentOptions", "agentPreset", "outputSchema", "maxDepth"].some(
          (key) => request[key] !== undefined,
        )
      )
        throw new BridgeFailure("UNSUPPORTED_CAPABILITY");
      const run = await runtime.start(request);
      return {
        id: run.id,
        result: run.result.then(subagentResult, () => ({
          output: [],
          stopReason: "error",
          diagnostic: "Harness Bridge: BRIDGE_TRANSPORT_FAILED",
        })),
        dispose: () => run.dispose(),
      };
    },
  };
}

/** A blocking call for scoped Blueprint nodes. A returned final always carries
 * status/output_complete/cleanup/delivery facts for controller acceptance. */
export function createRunTool(runtime, workingDirectory) {
  return {
    name: runtime.config.toolName,
    description:
      "Run one self-contained task through Harness Bridge and wait for its final result. No parent history is inherited. Check status, output_complete, cleanup and delivery errors before accepting the answer. Cancellation stops this worker. Model and permissions come from the trusted worker configuration.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Complete worker task, including all required context.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          output_complete: { type: "boolean" },
          cleanup: {
            type: "object",
            properties: { confirmed: { type: "boolean" } },
            required: ["confirmed"],
            additionalProperties: true,
          },
        },
        required: ["status", "output_complete", "cleanup"],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (typeof args?.prompt !== "string") throw new BridgeFailure("INVALID_REQUEST");
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal);
      const run = await runtime.start({
        prompt: [{ type: "text", text: args.prompt }],
        cwd,
        signal: exec.signal,
      });
      let final;
      try {
        final = await run.result;
        return final;
      } finally {
        try {
          await run.dispose();
        } catch (error) {
          // Preserve a delivered terminal with explicit unconfirmed cleanup.
          if (!final || final.cleanup.confirmed) throw error;
        }
      }
    },
  };
}

export function apply(ctx, config) {
  const runtime = new HarnessRuntime(config);
  ctx.effect(() => () => runtime.dispose());
  ctx.subagents.registerProvider(createProvider(runtime));
  ctx.tools.register(
    createRunTool(runtime, {
      ensure(agent, signal) {
        const workingDirectory = ctx.get("workingDirectory");
        if (typeof workingDirectory?.ensure !== "function")
          throw new BridgeFailure("WORKSPACE_UNAVAILABLE");
        return workingDirectory.ensure(agent, signal);
      },
    }),
  );
}
