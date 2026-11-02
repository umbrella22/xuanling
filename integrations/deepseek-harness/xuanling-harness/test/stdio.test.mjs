import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HarnessRuntime } from "../bridge-client.mjs";
import { createProvider, createRunTool } from "../index.mjs";
import { bridgeConfig } from "./support.mjs";

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "bridge-stdio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function waitForFile(root, file) {
  const ready = Promise.withResolvers();
  const watcher = watch(root, () => {
    if (existsSync(file)) {
      watcher.close();
      ready.resolve();
    }
  });
  if (existsSync(file)) {
    watcher.close();
    ready.resolve();
  }
  return { promise: ready.promise, dispose: () => watcher.close() };
}

test("real stdio Bridge returns only the fake native worker final and no session files", async (t) => {
  const root = directory(t);
  const runtime = new HarnessRuntime(bridgeConfig(root));
  t.after(() => runtime.dispose());
  const run = await createProvider(runtime).start({
    cwd: root,
    signal: new AbortController().signal,
    prompt: [
      {
        type: "text",
        text: JSON.stringify({ scenario: "success", text: "  final 🦊 / `$()`\n完成  " }),
      },
    ],
  });
  const result = await run.result;
  assert.equal(result.stopReason, "completed");
  assert.equal(result.output[0].text, "  final 🦊 / `$()`\n完成  ");
  assert.equal(JSON.stringify(result).includes("PROCESS-ONLY-MARKER"), false);
  await run.dispose();
  assert.deepEqual(readdirSync(root), ["bridge.json"]);
});

test("blocking tool preserves complete terminal facts and optional final Markdown", async (t) => {
  const root = directory(t);
  const reports = join(root, "reports");
  mkdirSync(reports);
  const runtime = new HarnessRuntime({
    ...bridgeConfig(root, { results_dir: reports }),
    saveResult: true,
  });
  t.after(() => runtime.dispose());
  const tool = createRunTool(runtime, { ensure: async () => root });
  const result = await tool.execute(
    { prompt: JSON.stringify({ scenario: "success", text: "ONLY FINAL" }) },
    { agent: {}, signal: new AbortController().signal },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output_complete, true);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(readdirSync(reports).length, 1);
  const md = readFileSync(result.report_path, "utf8");
  assert.ok(md.includes("ONLY FINAL"));
  assert.equal(md.includes("PROCESS-ONLY-MARKER"), false);
});

test(
  "real cancellation kills the running fake worker; a sibling run still completes",
  { timeout: 15_000 },
  async (t) => {
    const root = directory(t);
    const runtime = new HarnessRuntime(bridgeConfig(root));
    t.after(() => runtime.dispose());
    const pidFile = join(root, "worker.pid");
    const ready = waitForFile(root, pidFile);
    t.after(ready.dispose);
    const controller = new AbortController();
    const cancelled = await runtime.start({
      cwd: root,
      signal: controller.signal,
      prompt: [{ type: "text", text: JSON.stringify({ scenario: "silent", pid_file: pidFile }) }],
    });
    await ready.promise;
    const sibling = await runtime.start({
      cwd: root,
      signal: new AbortController().signal,
      prompt: [{ type: "text", text: JSON.stringify({ scenario: "success", text: "SIBLING" }) }],
    });
    controller.abort();
    const result = await cancelled.result;
    assert.equal(result.status, "cancelled");
    assert.equal(result.cleanup.confirmed, true);
    await cancelled.dispose();
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
    assert.equal((await sibling.result).worker_final_output, "SIBLING");
    await sibling.dispose();
  },
);
