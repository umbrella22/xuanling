import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

const REQUIRED_SERVER_NAME = "xuanling";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MUTATION_TOOLS = new Set(["write", "edit", "edit_batch"]);
const REQUIRED_RAW_TOOLS = [
  "fs_read_text",
  "fs_hash",
  "fs_write_text",
  "fs_edit",
  "fs_edit_batch",
];
const NATIVE_TOOL_CONFIG = {
  readLimit: 2000,
  readMaxLineLength: 20_000,
  readMaxBytes: 65_536,
  readStreamMinSize: 10 * 1024 * 1024,
};

export const name = "xuanling-filesystem-facade";
export const inject = ["tools", "fs", "systemPrompt"];

function bindMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`[XUANLING_FACADE_INVALID_SHA256] ${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function sessionFromExecution(exec, operation) {
  const session = exec?.agent?.session;
  if (!isRecord(session)) {
    throw new Error(
      `[XUANLING_FACADE_SESSION_REQUIRED] ${operation} requires an agent session so its preimage observation cannot cross sessions`,
    );
  }
  return session;
}

function stateMapFor(observations, exec, operation) {
  const session = sessionFromExecution(exec, operation);
  let state = observations.get(session);
  if (state === undefined) {
    state = new Map();
    observations.set(session, state);
  }
  return state;
}

function targetKey(target) {
  if (!isRecord(target) || typeof target.displayPath !== "string") {
    throw new Error("[XUANLING_FACADE_INVALID_TARGET] ctx.fs.resolve returned an invalid target");
  }
  return String(target.targetKey);
}

async function resolveHostTarget(ctx, config, filePath, exec) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("file_path must be a non-empty string");
  }
  return ctx.fs.resolve(filePath, { cwd: config.workspaceRoot, signal: exec.signal });
}

async function regularFileInfo(ctx, target, exec, allowAbsent = false) {
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) {
    if (allowAbsent) return undefined;
    throw new Error(`[XUANLING_FACADE_NOT_FOUND] ${target.displayPath} is not present`);
  }
  if (info.type !== "file") {
    throw new Error(`[XUANLING_FACADE_NOT_REGULAR_FILE] ${target.displayPath} is not a regular file`);
  }
  return info;
}

function rawNameFromPublicName(serverName, publicName) {
  const prefix = `mcp__${serverName}__`;
  if (typeof publicName !== "string" || !publicName.startsWith(prefix)) {
    throw new Error(
      `[XUANLING_FACADE_NAME_MISMATCH] bridge registered ${JSON.stringify(publicName)} outside ${prefix}`,
    );
  }
  const rawName = publicName.slice(prefix.length);
  if (rawName.length === 0 || `${prefix}${rawName}` !== publicName) {
    throw new Error(
      `[XUANLING_FACADE_NAME_MISMATCH] bridge public name is not reversibly qualified: ${publicName}`,
    );
  }
  return rawName;
}

async function callStructured(definitions, rawName, args, exec) {
  const record = definitions.get(rawName);
  if (record === undefined) {
    throw new Error(`[XUANLING_FACADE_TOOL_UNAVAILABLE] private MCP tool ${rawName} is unavailable`);
  }
  const result = await record.definition.execute(args, exec);
  if (!isRecord(result) || !isRecord(result.structuredContent)) {
    throw new Error(
      `[XUANLING_FACADE_RESULT_INVALID] private MCP tool ${rawName} returned no structuredContent`,
    );
  }
  return result.structuredContent;
}

async function hashTarget(definitions, target, exec) {
  const result = await callStructured(definitions, "fs_hash", { path: target.displayPath }, exec);
  if (result.algorithm !== "sha256") {
    throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_hash returned unsupported algorithm for ${target.displayPath}`);
  }
  return {
    digest: assertSha256(result.digest, "fs_hash.digest"),
    bytes: result.bytes,
  };
}

async function hostBoundHash(ctx, definitions, target, exec) {
  const info = await regularFileInfo(ctx, target, exec);
  const fingerprint = await hashTarget(definitions, target, exec);
  const confirmedInfo = await regularFileInfo(ctx, target, exec);
  if (info.version !== confirmedInfo.version) {
    throw new Error(
      `[XUANLING_FACADE_OBSERVATION_RACE] ${target.displayPath} changed while its host version was being bound`,
    );
  }
  return { info: confirmedInfo, fingerprint };
}

async function verifyHostSha(ctx, definitions, target, expectedSha256, exec) {
  const verified = await hostBoundHash(ctx, definitions, target, exec);
  if (verified.fingerprint.digest !== expectedSha256) {
    throw new Error(
      `[XUANLING_FACADE_OBSERVATION_RACE] ${target.displayPath} changed before its host observation was recorded`,
    );
  }
  return verified;
}

function splitLines(content) {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/u);
  if (/\r\n$|[\n\r]$/u.test(content)) lines.pop();
  return lines;
}

function readWindow(content, offset, limit, path) {
  if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const source = splitLines(content);
  if (offset > source.length && !(source.length === 0 && offset === 1)) {
    throw new Error(`[XUANLING_FACADE_READ_RANGE] offset ${offset} is out of range for ${path}`);
  }
  const selected = source.slice(offset - 1, offset - 1 + limit);
  return {
    offset,
    lines: selected.map((text, index) => ({ number: offset + index, text })),
    totalLines: source.length,
  };
}

function formatReadOutput(value) {
  const body = value.lines.map(({ number, text }) => `${String(number).padStart(6)}\t${text}`).join("\n");
  const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
  const footer = end < value.totalLines
    ? `(Showing lines ${value.offset}-${end} of ${value.totalLines}. Use offset=${end + 1} to continue.)`
    : `(End of file - total ${value.totalLines} lines)`;
  return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}${body.length === 0 ? "" : "\n"}${footer}\n</content>`;
}

function applyLiteralEdits(content, edits, path) {
  let working = content;
  const results = [];
  for (const [index, edit] of edits.entries()) {
    if (!isRecord(edit) || typeof edit.old !== "string" || edit.old.length === 0 || typeof edit.new !== "string") {
      throw new Error(`[XUANLING_FACADE_INVALID_EDIT] ${path} edit ${index} requires non-empty old and string new`);
    }
    const replaceAll = edit.replace_all ?? false;
    if (typeof replaceAll !== "boolean") {
      throw new Error(`[XUANLING_FACADE_INVALID_EDIT] ${path} edit ${index} replace_all must be boolean`);
    }
    let cursor = 0;
    let replacements = 0;
    while (true) {
      const found = working.indexOf(edit.old, cursor);
      if (found < 0) break;
      replacements += 1;
      cursor = found + edit.old.length;
    }
    if (replacements === 0) {
      throw new Error(`[XUANLING_FACADE_EDIT_NOT_FOUND] ${path} edit ${index} did not match`);
    }
    if (!replaceAll && replacements !== 1) {
      throw new Error(`[XUANLING_FACADE_AMBIGUOUS_EDIT] ${path} edit ${index} matched ${replacements} times`);
    }
    working = replaceAll
      ? working.split(edit.old).join(edit.new)
      : working.replace(edit.old, edit.new);
    results.push({ index, replacements: replaceAll ? replacements : 1 });
  }
  return { content: working, edits: results };
}

function observationForTarget(observations, exec, target, operation, requireContent) {
  const state = stateMapFor(observations, exec, operation).get(targetKey(target));
  if (state === undefined || (requireContent && typeof state.content !== "string")) {
    const remedy = requireContent ? "read" : "read or file_hash";
    throw new Error(
      `[XUANLING_FACADE_NOT_OBSERVED] ${target.displayPath} must be observed with ${remedy} in this session before ${operation}`,
    );
  }
  return state;
}

function recordObservation(observations, exec, target, value) {
  stateMapFor(observations, exec, "observation").set(targetKey(target), value);
}

function readDefinition(ctx, config, definitions, observations) {
  return {
    name: "read",
    description: "Read a UTF-8 text file through XuanLing and retain its full SHA-guarded preimage for later exact edits.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: config.readLimit },
      },
      required: ["file_path"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{ type: "text", text: formatReadOutput(value) }],
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = await resolveHostTarget(ctx, config, args.file_path, exec);
      await regularFileInfo(ctx, target, exec);
      const result = await callStructured(definitions, "fs_read_text", {
        path: target.displayPath,
        format: "raw",
        include_sha256: true,
        output: { mode: "complete" },
      }, exec);
      if (typeof result.content !== "string") {
        throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_read_text returned no content for ${target.displayPath}`);
      }
      const sha256 = assertSha256(result.sha256, "fs_read_text.sha256");
      if (sha256Text(result.content) !== sha256) {
        throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_read_text content hash mismatch for ${target.displayPath}`);
      }
      const verified = await verifyHostSha(ctx, definitions, target, sha256, exec);
      recordObservation(observations, exec, target, { sha256, content: result.content });
      ctx.emit("fs/observed", target, { kind: "present", version: verified.info.version }, exec);
      return {
        path: target.displayPath,
        ...readWindow(result.content, args.offset ?? 1, args.limit ?? config.readLimit, target.displayPath),
      };
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Read ${args.file_path}`,
        kind: "read",
        locations: [{ path: args.file_path, line: args.offset ?? 1 }],
      };
    },
    presentResult(_args, result) {
      if (result.isError || !isRecord(result.meta)) return undefined;
      return { card: "read", ...result.meta, content: result.content };
    },
  };
}

function hashDefinition(ctx, config, definitions, observations) {
  return {
    name: "file_hash",
    description: "Compute a SHA-256 file fingerprint through XuanLing. This does not count as reading the file body.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{ type: "text", text: `${value.algorithm}:${value.digest}  ${value.path}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = await resolveHostTarget(ctx, config, args.file_path, exec);
      const verified = await hostBoundHash(ctx, definitions, target, exec);
      const fingerprint = verified.fingerprint;
      const state = stateMapFor(observations, exec, "file_hash");
      const previous = state.get(targetKey(target));
      state.set(targetKey(target), {
        sha256: fingerprint.digest,
        ...(previous?.sha256 === fingerprint.digest && typeof previous.content === "string"
          ? { content: previous.content }
          : {}),
      });
      return { path: target.displayPath, algorithm: "sha256", ...fingerprint };
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Hash ${args.file_path}`,
        kind: "read",
        locations: [{ path: args.file_path }],
      };
    },
  };
}

function writeDefinition(ctx, config, definitions, observations) {
  return {
    name: "write",
    description: "Create or fully replace a UTF-8 file through XuanLing. Existing files require a same-session read or file_hash preimage.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{
        type: "text",
        text: `<path>${value.path}</path>\n<type>file</type>\n<content>\n${value.operation === "create" ? "Created" : "Updated"} file\n</content>`,
      }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      if (typeof args.content !== "string") throw new Error("content must be a string");
      const target = await resolveHostTarget(ctx, config, args.file_path, exec);
      const info = await regularFileInfo(ctx, target, exec, true);
      const before = info === undefined
        ? undefined
        : observationForTarget(observations, exec, target, "write", false);
      const result = await callStructured(definitions, "fs_write_text", {
        path: target.displayPath,
        content: args.content,
        mode: info === undefined ? "create" : "overwrite",
        expected_sha256: before?.sha256 ?? null,
        newline_mode: "raw",
        create_parents: true,
      }, exec);
      const expectedAfter = sha256Text(args.content);
      const afterSha256 = assertSha256(result.after_sha256, "fs_write_text.after_sha256");
      if (afterSha256 !== expectedAfter || (before !== undefined && result.before_sha256 !== before.sha256)) {
        throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_write_text hashes did not match the planned write for ${target.displayPath}`);
      }
      const verified = await verifyHostSha(ctx, definitions, target, afterSha256, exec);
      recordObservation(observations, exec, target, { sha256: afterSha256, content: args.content });
      ctx.emit("fs/observed", target, { kind: "present", version: verified.info.version }, exec);
      return {
        path: target.displayPath,
        operation: result.created ? "create" : "update",
        before_sha256: result.before_sha256 ?? null,
        after_sha256: afterSha256,
        diffs: [{ path: target.displayPath, oldText: before?.content ?? null, newText: args.content }],
      };
    },
    presentCall(args) {
      return {
        card: "diff",
        title: `Write ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      };
    },
    presentResult(args, result) {
      if (result.isError || !isRecord(result.meta) || !Array.isArray(result.meta.diffs)) return undefined;
      return { card: "diff", title: `Write ${args.file_path}`, diffs: result.meta.diffs };
    },
  };
}

function editDefinition(ctx, config, definitions, observations) {
  return {
    name: "edit",
    description: "Apply one exact UTF-8 replacement through XuanLing using the latest same-session read preimage.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        reversible: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{
        type: "text",
        text: `The file ${value.path} has been updated successfully (${value.replacements} replacement${value.replacements === 1 ? "" : "s"}).`,
      }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      const target = await resolveHostTarget(ctx, config, args.file_path, exec);
      await regularFileInfo(ctx, target, exec);
      const before = observationForTarget(observations, exec, target, "edit", true);
      const planned = applyLiteralEdits(before.content, [{
        old: args.old_string,
        new: args.new_string,
        replace_all: args.replace_all ?? false,
      }], target.displayPath);
      const result = await callStructured(definitions, "fs_edit", {
        path: target.displayPath,
        old: args.old_string,
        new: args.new_string,
        replace_all: args.replace_all ?? false,
        expected_sha256: before.sha256,
        reversible: args.reversible ?? false,
        include_diff: true,
      }, exec);
      const afterSha256 = assertSha256(result.after_sha256, "fs_edit.after_sha256");
      if (result.before_sha256 !== before.sha256 || afterSha256 !== sha256Text(planned.content)) {
        throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_edit hashes did not match the planned edit for ${target.displayPath}`);
      }
      const verified = await verifyHostSha(ctx, definitions, target, afterSha256, exec);
      recordObservation(observations, exec, target, { sha256: afterSha256, content: planned.content });
      ctx.emit("fs/observed", target, { kind: "present", version: verified.info.version }, exec);
      return {
        path: target.displayPath,
        replacements: result.replacements,
        before_sha256: before.sha256,
        after_sha256: afterSha256,
        change_id: result.change_id ?? null,
        change_state: result.change_state ?? null,
        diffs: [{ path: target.displayPath, oldText: before.content, newText: planned.content }],
      };
    },
    presentCall(args) {
      return {
        card: "diff",
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      };
    },
    presentResult(args, result) {
      if (result.isError || !isRecord(result.meta) || !Array.isArray(result.meta.diffs)) return undefined;
      return { card: "diff", title: `Edit ${args.file_path}`, diffs: result.meta.diffs };
    },
  };
}

function batchDefinition(ctx, config, definitions, observations) {
  return {
    name: "edit_batch",
    description: "Apply ordered exact edits across existing UTF-8 files after every file was read in this session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              edits: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    old: { type: "string", minLength: 1 },
                    new: { type: "string" },
                    replace_all: { type: "boolean" },
                  },
                  required: ["old", "new"],
                },
              },
            },
            required: ["path", "edits"],
          },
        },
        dry_run: { type: "boolean" },
        reversible: { type: "boolean" },
      },
      required: ["files"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{
        type: "text",
        text: `${value.dry_run ? "Previewed" : "Updated"} ${value.files.length} file${value.files.length === 1 ? "" : "s"} with ${value.replacements} replacement${value.replacements === 1 ? "" : "s"}.`,
      }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      if (!Array.isArray(args.files) || args.files.length === 0) {
        throw new Error("files must be a non-empty array");
      }
      const state = stateMapFor(observations, exec, "edit_batch");
      const plannedFiles = [];
      const seenTargets = new Set();
      for (const [fileIndex, file] of args.files.entries()) {
        if (!isRecord(file) || typeof file.path !== "string" || !Array.isArray(file.edits) || file.edits.length === 0) {
          throw new Error(`[XUANLING_FACADE_INVALID_BATCH] file ${fileIndex} requires path and non-empty edits`);
        }
        const target = await resolveHostTarget(ctx, config, file.path, exec);
        await regularFileInfo(ctx, target, exec);
        const key = targetKey(target);
        if (seenTargets.has(key)) {
          throw new Error(`[XUANLING_FACADE_DUPLICATE_TARGET] file ${fileIndex} resolves to a duplicate target`);
        }
        seenTargets.add(key);
        const before = state.get(key);
        if (before === undefined || typeof before.content !== "string") {
          throw new Error(
            `[XUANLING_FACADE_NOT_OBSERVED] ${target.displayPath} must be observed with read in this session before edit_batch`,
          );
        }
        const planned = applyLiteralEdits(before.content, file.edits, target.displayPath);
        plannedFiles.push({ target, before, planned, requestedEdits: file.edits });
      }

      const dryRun = args.dry_run ?? false;
      const result = await callStructured(definitions, "fs_edit_batch", {
        files: plannedFiles.map(({ target, before, requestedEdits }) => ({
          path: target.displayPath,
          expected_sha256: before.sha256,
          edits: requestedEdits,
        })),
        dry_run: dryRun,
        reversible: args.reversible ?? false,
        include_diff: true,
      }, exec);
      if (!Array.isArray(result.files) || result.files.length !== plannedFiles.length) {
        throw new Error("[XUANLING_FACADE_RESULT_INVALID] fs_edit_batch returned the wrong file count");
      }
      for (const [index, planned] of plannedFiles.entries()) {
        const returned = result.files[index];
        if (!isRecord(returned)) throw new Error("[XUANLING_FACADE_RESULT_INVALID] fs_edit_batch returned an invalid file result");
        const afterSha256 = assertSha256(returned.after_sha256, `fs_edit_batch.files[${index}].after_sha256`);
        if (returned.before_sha256 !== planned.before.sha256 || afterSha256 !== sha256Text(planned.planned.content)) {
          throw new Error(`[XUANLING_FACADE_RESULT_INVALID] fs_edit_batch hashes did not match ${planned.target.displayPath}`);
        }
      }

      if (!dryRun) {
        const verified = [];
        for (const [index, planned] of plannedFiles.entries()) {
          verified.push(await verifyHostSha(ctx, definitions, planned.target, result.files[index].after_sha256, exec));
        }
        for (const [index, planned] of plannedFiles.entries()) {
          state.set(targetKey(planned.target), {
            sha256: result.files[index].after_sha256,
            content: planned.planned.content,
          });
        }
        for (const [index, planned] of plannedFiles.entries()) {
          ctx.emit("fs/observed", planned.target, { kind: "present", version: verified[index].info.version }, exec);
        }
      }

      return {
        files: plannedFiles.map((planned, index) => ({
          path: planned.target.displayPath,
          before_sha256: planned.before.sha256,
          after_sha256: result.files[index].after_sha256,
          replacements: result.files[index].replacements,
          edits: result.files[index].edits,
        })),
        replacements: result.replacements,
        change_id: result.change_id ?? null,
        change_state: result.change_state ?? null,
        dry_run: dryRun,
        diffs: plannedFiles.map((planned) => ({
          path: planned.target.displayPath,
          oldText: planned.before.content,
          newText: planned.planned.content,
        })),
      };
    },
    presentCall(args) {
      const files = Array.isArray(args.files) ? args.files : [];
      return {
        card: "diff",
        title: `Edit ${files.length} files`,
        diffs: files.flatMap((file) => Array.isArray(file?.edits)
          ? file.edits.map((edit) => ({ path: file.path, oldText: edit.old, newText: edit.new }))
          : []),
        locations: files.filter((file) => typeof file?.path === "string").map((file) => ({ path: file.path })),
      };
    },
    presentResult(args, result) {
      if (result.isError || !isRecord(result.meta) || !Array.isArray(result.meta.diffs)) return undefined;
      return { card: "diff", title: `Edit ${args.files?.length ?? 0} files`, diffs: result.meta.diffs };
    },
  };
}

function createPrivateMcpContext(ctx, config, definitions) {
  function captureDefinition(definition) {
    const rawName = rawNameFromPublicName(config.serverName, definition?.name);
    if (definitions.has(rawName)) {
      throw new Error(`[XUANLING_FACADE_DUPLICATE_TOOL] duplicate raw tool name: ${rawName}`);
    }
    const record = { definition };
    definitions.set(rawName, record);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (definitions.get(rawName) === record) definitions.delete(rawName);
    };
  }

  const projectedTools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === "register") return captureDefinition;
      return bindMember(target, property);
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "tools") return projectedTools;
      return bindMember(target, property);
    },
  });
}

function createNativeReadImageContext(ctx) {
  const cache = new WeakMap();
  function project(scope) {
    const cached = cache.get(scope);
    if (cached !== undefined) return cached;
    let projected;
    const projectedTools = new Proxy(scope.tools, {
      get(target, property) {
        if (property === "register") {
          return (definition) => definition?.name === "read_image"
            ? target.register(definition)
            : () => {};
        }
        return bindMember(target, property);
      },
    });
    const projectedPrompt = new Proxy(scope.systemPrompt, {
      get(target, property) {
        if (property === "section") return () => () => {};
        return bindMember(target, property);
      },
    });
    projected = new Proxy(scope, {
      get(target, property) {
        if (property === "tools") return projectedTools;
        if (property === "systemPrompt") return projectedPrompt;
        if (property === "inject") {
          return (services, callback) => target.inject(services, (child) => callback(project(child)));
        }
        return bindMember(target, property);
      },
    });
    cache.set(scope, projected);
    return projected;
  }
  return project(ctx);
}

function validateConfig(config) {
  if (config?.serverName !== REQUIRED_SERVER_NAME) {
    throw new Error(
      `[XUANLING_FACADE_INVALID_SERVER] expected serverName ${REQUIRED_SERVER_NAME}, got ${JSON.stringify(config?.serverName)}`,
    );
  }
  if (typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)) {
    throw new Error("[XUANLING_FACADE_INVALID_ROOT] workspaceRoot must be an absolute path");
  }
  if (config.transport !== "stdio" || typeof config.command !== "string" || config.command.length === 0) {
    throw new Error("[XUANLING_FACADE_INVALID_TRANSPORT] a stdio command is required");
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((value) => typeof value !== "string"))) {
    throw new Error("[XUANLING_FACADE_INVALID_TRANSPORT] args must contain only strings");
  }
  const readLimit = config.readLimit ?? NATIVE_TOOL_CONFIG.readLimit;
  if (!Number.isInteger(readLimit) || readLimit < 1) {
    throw new Error("[XUANLING_FACADE_INVALID_READ_LIMIT] readLimit must be a positive integer");
  }
  return {
    ...config,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd ?? "",
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60_000,
    toolExposure: "eager",
    readLimit,
  };
}

/**
 * Compose the facade with injectable official host plugins for deterministic
 * contract tests. Approval remains a ToolRuntime concern: the pre-execute ask
 * decision delegates to the mounted ApprovalService and therefore fails closed
 * when no approval channel exists.
 */
export async function applyWithHost(ctx, config, applyOfficialBridge, applyNativeToolFs) {
  const resolved = validateConfig(config);
  if (typeof applyOfficialBridge !== "function" || typeof applyNativeToolFs !== "function") {
    throw new Error("[XUANLING_FACADE_INVALID_HOST] official MCP and native filesystem apply exports are required");
  }

  const definitions = new Map();
  const observations = new WeakMap();
  await applyOfficialBridge(
    createPrivateMcpContext(ctx, resolved, definitions),
    { ...resolved, failOnStartupError: true },
  );
  for (const rawName of REQUIRED_RAW_TOOLS) {
    if (!definitions.has(rawName)) {
      throw new Error(`[XUANLING_FACADE_MISSING_TOOL] MCP server did not register ${rawName}`);
    }
  }

  await applyNativeToolFs(createNativeReadImageContext(ctx), {
    ...NATIVE_TOOL_CONFIG,
    readLimit: resolved.readLimit,
  });

  const facadeDefinitions = [
    readDefinition(ctx, resolved, definitions, observations),
    writeDefinition(ctx, resolved, definitions, observations),
    editDefinition(ctx, resolved, definitions, observations),
    hashDefinition(ctx, resolved, definitions, observations),
    batchDefinition(ctx, resolved, definitions, observations),
  ];
  const disposers = [];
  try {
    for (const definition of facadeDefinitions) disposers.push(ctx.tools.register(definition));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }

  ctx.on("tools/pre-execute", async (exec, next) => {
    const downstream = await next();
    if (downstream.kind !== "allow" || !MUTATION_TOOLS.has(exec.name)) return downstream;
    return { kind: "ask", reason: `XuanLing filesystem mutation via ${exec.name}` };
  });
}

export async function apply(ctx, config) {
  const [bridge, nativeToolFs] = await Promise.all([
    import("@deepseek-ai/dsh-mcp-client"),
    import("@deepseek-ai/dsh-tool-fs"),
  ]);
  return applyWithHost(ctx, config, bridge.apply, nativeToolFs.apply);
}
