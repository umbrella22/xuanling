import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const facadePath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "integrations",
  "deepseek-harness",
  "xuanling-tools-replace",
  "filesystem-facade.mjs",
);
const facade = await import(`${pathToFileURL(facadePath).href}?contract`);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function applyEdits(content, edits) {
  let working = content;
  const results = [];
  for (const [index, edit] of edits.entries()) {
    const matches = working.split(edit.old).length - 1;
    if (matches === 0) throw new Error("not_found");
    if (!edit.replace_all && matches !== 1) throw new Error("conflict");
    working = edit.replace_all
      ? working.split(edit.old).join(edit.new)
      : working.replace(edit.old, edit.new);
    results.push({ index, replacements: edit.replace_all ? matches : 1 });
  }
  return { content: working, edits: results };
}

function structured(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function createHarness(initialFiles = {}) {
  const workspaceRoot = path.resolve("facade-contract-workspace");
  const files = new Map();
  let revision = 0;
  for (const [relative, content] of Object.entries(initialFiles)) {
    files.set(path.resolve(workspaceRoot, relative), { content, version: `v${++revision}` });
  }
  const rawCalls = [];
  const registered = new Map();
  const registrationDisposers = [];
  const listeners = new Map();
  const observed = [];

  const resolvePath = (candidate, cwd = workspaceRoot) => path.resolve(cwd, candidate);
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(typeof definition?.name, "string");
        if (registered.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
        registered.set(definition.name, definition);
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (registered.get(definition.name) === definition) registered.delete(definition.name);
        };
        registrationDisposers.push(dispose);
        return dispose;
      },
    },
    fs: {
      async resolve(candidate, options = {}) {
        const absolute = resolvePath(candidate, options.cwd);
        return { targetKey: absolute, displayPath: absolute };
      },
      async stat(target) {
        const file = files.get(String(target.targetKey));
        return file === undefined
          ? undefined
          : { type: "file", version: file.version, size: Buffer.byteLength(file.content) };
      },
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    inject(_services, callback) {
      return callback(ctx);
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    emit(event, target, observation, exec) {
      if (event === "fs/observed") observed.push({ target, observation, exec });
    },
  };

  function fileFor(args) {
    const absolute = resolvePath(args.path);
    return { absolute, file: files.get(absolute) };
  }

  const rawExecutors = {
    fs_read_text(args) {
      const { file } = fileFor(args);
      if (file === undefined) throw new Error("not_found");
      return {
        content: file.content,
        sha256: sha256(file.content),
        total_lines: file.content.length === 0 ? 0 : file.content.split(/\r\n|\n|\r/u).length,
        newline_style: "lf",
      };
    },
    fs_hash(args) {
      const { file } = fileFor(args);
      if (file === undefined) throw new Error("not_found");
      return { algorithm: "sha256", digest: sha256(file.content), bytes: Buffer.byteLength(file.content) };
    },
    fs_write_text(args) {
      const { absolute, file } = fileFor(args);
      if (args.mode === "create") {
        if (file !== undefined) throw new Error("already_exists");
      } else {
        if (file === undefined || sha256(file.content) !== args.expected_sha256) throw new Error("conflict");
      }
      const beforeSha = file === undefined ? null : sha256(file.content);
      files.set(absolute, { content: args.content, version: `v${++revision}` });
      return {
        created: file === undefined,
        bytes: Buffer.byteLength(args.content),
        before_sha256: beforeSha,
        after_sha256: sha256(args.content),
      };
    },
    fs_edit(args) {
      const { absolute, file } = fileFor(args);
      if (file === undefined || sha256(file.content) !== args.expected_sha256) throw new Error("conflict");
      const planned = applyEdits(file.content, [{ old: args.old, new: args.new, replace_all: args.replace_all }]);
      files.set(absolute, { content: planned.content, version: `v${++revision}` });
      return {
        replacements: planned.edits[0].replacements,
        before_sha256: args.expected_sha256,
        after_sha256: sha256(planned.content),
        change_id: args.reversible ? "change-1" : null,
        change_state: args.reversible ? "applied_awaiting_completion" : null,
        diff: "contract diff",
      };
    },
    fs_edit_batch(args) {
      const planned = args.files.map((request) => {
        const { absolute, file } = fileFor(request);
        if (file === undefined || sha256(file.content) !== request.expected_sha256) throw new Error("conflict");
        return { absolute, before: file.content, request, ...applyEdits(file.content, request.edits) };
      });
      if (!args.dry_run) {
        for (const item of planned) {
          files.set(item.absolute, { content: item.content, version: `v${++revision}` });
        }
      }
      return {
        files: planned.map((item) => ({
          path: item.absolute,
          before_sha256: sha256(item.before),
          after_sha256: sha256(item.content),
          replacements: item.edits.reduce((sum, edit) => sum + edit.replacements, 0),
          edits: item.edits,
          diff: "contract diff",
        })),
        replacements: planned.reduce(
          (sum, item) => sum + item.edits.reduce((inner, edit) => inner + edit.replacements, 0),
          0,
        ),
        change_id: args.reversible ? "group-1" : null,
        change_state: args.reversible ? "applied_awaiting_completion" : null,
      };
    },
  };

  const applyOfficialBridge = async (projectedCtx, config) => {
    assert.equal(config.serverName, "xuanling");
    assert.equal(config.failOnStartupError, true);
    for (const [rawName, execute] of Object.entries(rawExecutors)) {
      projectedCtx.tools.register({
        name: `mcp__xuanling__${rawName}`,
        description: rawName,
        parameters: { type: "object" },
        output: { schema: { type: "object" }, render: () => [] },
        async execute(args, exec) {
          rawCalls.push({ name: rawName, args, exec });
          return structured(execute(args));
        },
      });
    }
  };

  const applyNativeToolFs = async (projectedCtx) => {
    for (const nativeName of ["read", "write", "edit", "read_image"]) {
      projectedCtx.tools.register({
        name: nativeName,
        description: `native ${nativeName}`,
        parameters: { type: "object" },
        output: { schema: { type: "object" }, render: () => [] },
        async execute() {
          return { native: nativeName };
        },
      });
    }
  };

  const mutateExternally = (relative, content) => {
    const absolute = resolvePath(relative);
    files.set(absolute, { content, version: `v${++revision}` });
  };
  const contentOf = (relative) => files.get(resolvePath(relative))?.content;
  const dispose = () => {
    for (const remove of registrationDisposers.reverse()) remove();
  };

  return {
    workspaceRoot,
    ctx,
    files,
    registered,
    listeners,
    observed,
    rawCalls,
    applyOfficialBridge,
    applyNativeToolFs,
    mutateExternally,
    contentOf,
    dispose,
  };
}

function execution(session, name = "contract") {
  return {
    agent: { session },
    callId: `${name}-call`,
    name,
    arguments: {},
    signal: new AbortController().signal,
  };
}

async function mountHarness(harness) {
  await facade.applyWithHost(
    harness.ctx,
    {
      serverName: "xuanling",
      workspaceRoot: harness.workspaceRoot,
      transport: "stdio",
      command: process.execPath,
      args: [],
      toolCallTimeoutMs: 120_000,
    },
    harness.applyOfficialBridge,
    harness.applyNativeToolFs,
  );
}

test("replacement facade exposes only same-name filesystem tools and composes approval", async () => {
  const harness = createHarness({ "a.txt": "alpha\n" });
  await mountHarness(harness);

  assert.deepEqual(
    [...harness.registered.keys()].sort(),
    ["edit", "edit_batch", "file_hash", "read", "read_image", "write"],
  );
  assert.equal(
    [...harness.registered.keys()].some((toolName) => toolName.startsWith("mcp__xuanling__")),
    false,
    "private raw mutations are never model-visible",
  );
  assert.deepEqual(await harness.registered.get("read_image").execute({}, execution({})), {
    native: "read_image",
  });

  const preExecute = harness.listeners.get("tools/pre-execute");
  assert.deepEqual(
    await preExecute({ name: "edit" }, async () => ({ kind: "allow" })),
    { kind: "ask", reason: "XuanLing filesystem mutation via edit" },
  );
  assert.deepEqual(
    await preExecute({ name: "read" }, async () => ({ kind: "allow" })),
    { kind: "allow" },
  );
  assert.deepEqual(
    await preExecute({ name: "write" }, async () => ({ kind: "deny", reason: "policy" })),
    { kind: "deny", reason: "policy" },
    "the facade never overrides an existing denial",
  );

  harness.dispose();
  assert.equal(harness.registered.size, 0, "plugin disposal restores the native composition boundary");
});

test("read establishes semantic CAS state, edit updates it, and formatter races fail stale", async () => {
  const harness = createHarness({ "a.txt": "alpha\nbeta\n" });
  await mountHarness(harness);
  const session = {};
  const exec = execution(session, "edit");

  const read = await harness.registered.get("read").execute(
    { file_path: "a.txt", offset: 2, limit: 1 },
    exec,
  );
  assert.deepEqual(read.lines, [{ number: 2, text: "beta" }]);
  assert.equal(read.totalLines, 2);
  assert.equal(harness.observed.length, 1);
  assert.match(String(harness.observed[0].observation.version), /^v\d+$/);

  const edit = await harness.registered.get("edit").execute({
    file_path: "a.txt",
    old_string: "beta",
    new_string: "gamma",
    reversible: true,
  }, exec);
  assert.equal(harness.contentOf("a.txt"), "alpha\ngamma\n");
  assert.equal(edit.change_id, "change-1");
  const editCall = harness.rawCalls.findLast(({ name }) => name === "fs_edit");
  assert.equal(editCall.args.expected_sha256, sha256("alpha\nbeta\n"));
  assert.equal(editCall.args.include_diff, true);
  assert.equal(harness.observed.length, 2);

  harness.mutateExternally("a.txt", "alpha\nformatted\n");
  await assert.rejects(
    harness.registered.get("edit").execute({
      file_path: "a.txt",
      old_string: "gamma",
      new_string: "delta",
    }, exec),
    /conflict/,
  );
  assert.equal(harness.contentOf("a.txt"), "alpha\nformatted\n");

  await harness.registered.get("read").execute({ file_path: "a.txt" }, exec);
  await harness.registered.get("edit").execute({
    file_path: "a.txt",
    old_string: "formatted",
    new_string: "settled",
  }, exec);
  assert.equal(harness.contentOf("a.txt"), "alpha\nsettled\n");
});

test("file_hash is fingerprint-only: it permits guarded write but not edit", async () => {
  const harness = createHarness({ "hash-only.txt": "before\n" });
  await mountHarness(harness);
  const exec = execution({}, "write");

  const fingerprint = await harness.registered.get("file_hash").execute(
    { file_path: "hash-only.txt" },
    exec,
  );
  assert.equal(fingerprint.digest, sha256("before\n"));
  assert.equal(harness.observed.length, 0, "a fingerprint is not emitted as a semantic host observation");
  await assert.rejects(
    harness.registered.get("edit").execute({
      file_path: "hash-only.txt",
      old_string: "before",
      new_string: "after",
    }, exec),
    /must be observed with read/,
  );

  await harness.registered.get("write").execute({
    file_path: "hash-only.txt",
    content: "after\n",
  }, exec);
  const writeCall = harness.rawCalls.findLast(({ name }) => name === "fs_write_text");
  assert.equal(writeCall.args.expected_sha256, sha256("before\n"));
  assert.equal(writeCall.args.mode, "overwrite");
  assert.equal(harness.contentOf("hash-only.txt"), "after\n");

  await harness.registered.get("write").execute({ file_path: "created.txt", content: "new\n" }, exec);
  const createCall = harness.rawCalls.findLast(({ name }) => name === "fs_write_text");
  assert.equal(createCall.args.mode, "create");
  assert.equal(createCall.args.expected_sha256, null);
});

test("edit_batch injects every semantic preimage, preserves order, and keeps dry runs read-only", async () => {
  const harness = createHarness({
    "a.txt": "one two\n",
    "b.txt": "red blue\n",
  });
  await mountHarness(harness);
  const exec = execution({}, "edit_batch");
  await harness.registered.get("read").execute({ file_path: "a.txt" }, exec);
  await harness.registered.get("read").execute({ file_path: "b.txt" }, exec);

  const result = await harness.registered.get("edit_batch").execute({
    files: [
      {
        path: "a.txt",
        edits: [
          { old: "one", new: "ONE" },
          { old: "ONE two", new: "done" },
        ],
      },
      { path: "b.txt", edits: [{ old: "blue", new: "green" }] },
    ],
    reversible: true,
  }, exec);
  assert.equal(result.change_id, "group-1");
  assert.equal(result.replacements, 3);
  assert.equal(harness.contentOf("a.txt"), "done\n");
  assert.equal(harness.contentOf("b.txt"), "red green\n");
  const batchCall = harness.rawCalls.findLast(({ name }) => name === "fs_edit_batch");
  assert.deepEqual(
    batchCall.args.files.map(({ expected_sha256 }) => expected_sha256),
    [sha256("one two\n"), sha256("red blue\n")],
  );
  assert.equal(batchCall.args.include_diff, true);
  assert.equal(harness.observed.length, 4, "two reads and two applied files emit observations");

  const preview = await harness.registered.get("edit_batch").execute({
    files: [{ path: "a.txt", edits: [{ old: "done", new: "preview" }] }],
    dry_run: true,
  }, exec);
  assert.equal(preview.dry_run, true);
  assert.equal(harness.contentOf("a.txt"), "done\n");
  assert.equal(harness.observed.length, 4, "dry-run emits no mutation observation");
});
