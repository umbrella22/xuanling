#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dsh-root") options.dshRoot = value;
    else if (flag === "--xuanling-mcp-bin") options.binary = value;
    else throw new Error(`unknown or incomplete argument: ${flag ?? "<missing>"}`);
  }
  if (typeof options.dshRoot !== "string" || typeof options.binary !== "string") {
    throw new Error("usage: verify-deepseek-filesystem-facade.mjs --dsh-root <path> --xuanling-mcp-bin <path>");
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function importResolved(requireFromDsh, packageName) {
  return import(pathToFileURL(requireFromDsh.resolve(packageName)).href);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dshRoot = path.resolve(options.dshRoot);
  const binary = path.resolve(options.binary);
  const requireFromDsh = createRequire(path.join(dshRoot, "apps", "cli", "package.json"));
  const requireFromToolFs = createRequire(path.join(dshRoot, "packages", "fs", "tool-fs", "package.json"));
  const facadeUrl = new URL(
    "../../integrations/deepseek-harness/xuanling-tools-replace/filesystem-facade.mjs",
    import.meta.url,
  );

  const [cordis, toolsModule, promptModule, fsModule, policyModule, attachmentModule, bridge, nativeFs, facade] =
    await Promise.all([
      importResolved(requireFromDsh, "@deepseek-ai/cordis"),
      importResolved(requireFromDsh, "@deepseek-ai/dsh-tools"),
      importResolved(requireFromDsh, "@deepseek-ai/dsh-system-prompt"),
      importResolved(requireFromDsh, "@deepseek-ai/dsh-fs-local"),
      importResolved(requireFromToolFs, "@deepseek-ai/dsh-fs-observation-policy"),
      import(pathToFileURL(path.join(dshRoot, "packages", "attachment", "attachment-local", "lib", "index.js")).href),
      importResolved(requireFromDsh, "@deepseek-ai/dsh-mcp-client"),
      importResolved(requireFromDsh, "@deepseek-ai/dsh-tool-fs"),
      import(facadeUrl.href),
    ]);

  const workspace = await mkdtemp(path.join(os.tmpdir(), "xuanling-dsh-facade-workspace-"));
  const dshHome = await mkdtemp(path.join(os.tmpdir(), "xuanling-dsh-facade-home-"));
  const filePath = path.join(workspace, "contract.txt");
  const before = "alpha\nbeta\n";
  const after = "alpha\ngamma\n";
  await writeFile(filePath, before, "utf8");

  const ctx = new cordis.Context();
  try {
    await ctx.plugin(promptModule.default);
    await ctx.plugin(toolsModule.default);
    await ctx.plugin(fsModule.default, { cwd: workspace });
    await ctx.plugin(policyModule);
    await ctx.plugin(attachmentModule.default, { dshHome });
    const facadeFiber = await ctx.plugin({
      name: facade.name,
      inject: facade.inject,
      apply(scope, config) {
        return facade.applyWithHost(scope, config, bridge.apply, nativeFs.apply);
      },
    }, {
      serverName: "xuanling",
      workspaceRoot: workspace,
      transport: "stdio",
      command: binary,
      args: ["--workspace-root", workspace, "--memory-db", path.join(workspace, "memory.db")],
      toolCallTimeoutMs: 60_000,
    });

    const names = ctx.tools.schemas().map((schema) => schema.name).sort();
    assert.deepEqual(names, ["edit", "edit_batch", "file_hash", "read", "read_image", "write"]);
    assert.equal(names.some((toolName) => toolName.startsWith("mcp__xuanling__")), false);
    assert.equal(ctx.tools.get("read_image").presentCall({ file_path: "image.png" }).card, "generic");

    const session = { header: { cwd: workspace } };
    const signal = new AbortController().signal;
    const readExec = {
      signal,
      callId: "facade-read-1",
      rootCallId: "facade-read-1",
      token: {},
      name: "read",
      arguments: { file_path: "contract.txt" },
      agent: { session },
    };
    const readResult = await ctx.tools.execute(readExec);
    assert.equal(readResult.isError, false);
    assert.equal(readResult.value.path, filePath);
    assert.equal(ctx.tools.get("read").presentResult({ file_path: "contract.txt" }, readResult).card, "read");
    const observedTarget = await ctx.fs.resolve("contract.txt", { cwd: workspace, signal });
    const observedIntent = await ctx.waterfall(
      "fs/edit-intent",
      observedTarget,
      readExec,
      () => undefined,
    );
    assert.equal(observedIntent.version, (await ctx.fs.stat(observedTarget, signal)).version);

    const editDefinition = ctx.tools.get("edit");
    const editValue = await editDefinition.execute({
      file_path: "contract.txt",
      old_string: "beta",
      new_string: "gamma",
    }, { ...readExec, name: "edit", arguments: {} });
    assert.equal(editValue.before_sha256, sha256(before));
    assert.equal(editValue.after_sha256, sha256(after));
    assert.equal(await readFile(filePath, "utf8"), after);

    const denied = await ctx.tools.execute({
      signal,
      callId: "facade-edit-denied",
      name: "edit",
      arguments: {
        file_path: "contract.txt",
        old_string: "gamma",
        new_string: "delta",
      },
      agent: { session },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.error.message, "XuanLing filesystem mutation via edit");
    assert.equal(await readFile(filePath, "utf8"), after, "failed approval must not mutate the file");

    await facadeFiber.dispose();
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), []);
    const nativeFiber = await ctx.plugin(nativeFs);
    assert.deepEqual(
      ctx.tools.schemas().map((schema) => schema.name).sort(),
      ["edit", "read", "read_image", "write"],
      "disabling replacement restores the native filesystem surface",
    );
    await nativeFiber.dispose();

    process.stdout.write(`${JSON.stringify({
      dsh_revision: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
      tools: names,
      read_card: true,
      diff_card: editDefinition.presentResult(
        { file_path: "contract.txt" },
        { isError: false, meta: { diffs: editValue.diffs }, content: [] },
      )?.card === "diff",
      observation_policy_bound: true,
      approval_fail_closed: true,
      replacement_disable_restores_native: true,
      before_sha256: sha256(before),
      after_sha256: sha256(after),
    })}\n`);
  } finally {
    await ctx.fiber.dispose();
    await rm(workspace, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
}

await main();
