import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { parseArgs, requiredArg } from "../../../npm/scripts/shared.mjs";
import { projectInputSchemaForDsh } from "../../../integrations/deepseek-harness/xuanling-memory/schema-projection.mjs";

// DeepSeek Harness bridge verifier.
//
// The integration mounts xuanling-mcp through @deepseek-ai/dsh-mcp-client
// (verified against harness source packages/mcp/mcp-client and
// packages/core/tools/src/json-schema.ts). Four wire contracts must hold:
//
//   1. Public names: the bridge registers each tool as
//      `mcp__<serverName>__<rawName>` under the DeepSeek function-name
//      contract (64 chars, [A-Za-z0-9_-]); lossy normalization would append a
//      deterministic hash. Our names must need NO suffix.
//
//   2. Canonical input schemas are self-contained. For the recommended Memory
//      profile, its DSH-only adapter projects those schemas into the harness
//      vocabulary without changing the canonical server contract.
//
//   3. Output schemas split into two paths:
//      - Advertised schemas using vocabulary outside the harness's enforced
//        JSON Schema subset ($ref/$defs, ...) hit the bridge's documented
//        fallback: structuredContent becomes unconstrained and registration
//        never fails. Safe by construction.
//      - Advertised schemas INSIDE the subset take the validated path: the
//        harness enforces them on every successful call's structuredContent
//        (validateJsonSchemaValue) — a shape drift turns calls into errors.
//        This verifier ports the harness subset faithfully and, for every
//        validated-path tool, performs a real call and validates the live
//        structuredContent against the advertised schema.
//
//   4. Model arguments are forwarded verbatim (JSON.parse of model output):
//      an object-typed parameter must round-trip as an object WITHOUT any
//      compat shim (the ZCode-only object-param shim stays out of this path).
//
// Starts the binary with an explicit unique temp `--memory-db` and temp
// workspace root (C-15: the real default databases are never opened by
// automation). Any drift exits non-zero.

const args = parseArgs(process.argv.slice(2));
const binary = path.resolve(requiredArg(args, "binary"));
const toolProfile = args["tool-profile"];
if (toolProfile !== undefined && (typeof toolProfile !== "string" || toolProfile.length === 0)) {
  throw new Error("--tool-profile requires a non-empty value");
}

const SERVER_NAME = "xuanling";
const PUBLIC_PREFIX = `mcp__${SERVER_NAME}__`;
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The canonical fs profile (locked by crates/xuanling-mcp/tests/snapshots/
// tools-list.json and the npm projection tests): exactly these 16 filesystem
// tools, nothing else — discovery and dispatch are both trimmed server-side.
const EXACT_FS_PROFILE_TOOLS = [
  "fs_copy",
  "fs_edit",
  "fs_edit_preview",
  "fs_glob",
  "fs_hash",
  "fs_list",
  "fs_mkdir",
  "fs_move",
  "fs_patch",
  "fs_read_bytes",
  "fs_read_text",
  "fs_remove",
  "fs_replace_text",
  "fs_search",
  "fs_stat",
  "fs_write_text",
];

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xuanling-dsh-bridge-"));
const childArgs = [
  "--workspace-root",
  temporaryDirectory,
  "--memory-db",
  path.join(temporaryDirectory, "memory.db"),
];
if (toolProfile !== undefined) {
  childArgs.push("--tool-profile", toolProfile);
}
const child = spawn(
  binary,
  childArgs,
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

const childSettled = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const pending = new Map();
let protocolFailure;

function rejectPending(error) {
  protocolFailure ??= error;
  for (const waiter of pending.values()) {
    waiter.reject(error);
  }
  pending.clear();
}

childSettled.then(
  (exit) => {
    if (pending.size > 0) {
      rejectPending(
        new Error(`MCP server exited as ${JSON.stringify(exit)} before responding; stderr:\n${stderr}`),
      );
    }
  },
  (error) => rejectPending(error),
);

const lineReader = readline.createInterface({ input: child.stdout });
lineReader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    rejectPending(new Error(`Non-JSON stdout frame ${JSON.stringify(line)}: ${error}`));
    return;
  }
  const waiter = pending.get(frame.id);
  if (waiter) {
    pending.delete(frame.id);
    waiter.resolve(frame);
  }
});

let nextId = 1;
function send(frame) {
  if (protocolFailure) {
    throw protocolFailure;
  }
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method, params) {
  const id = nextId++;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  try {
    send({ jsonrpc: "2.0", id, method, params });
  } catch (error) {
    pending.delete(id);
    throw error;
  }
  return response;
}

/** One tools/call; resolves { isError, structuredContent, content }. */
async function callTool(name, arguments_) {
  const response = await request("tools/call", { name, arguments: arguments_ });
  if (response.error) {
    throw new Error(`tools/call ${name} protocol error: ${JSON.stringify(response.error)}`);
  }
  const result = response.result ?? {};
  if (result.isError === true) {
    const text = (result.content ?? []).map((block) => block.text ?? "").join("\n");
    throw new Error(`tools/call ${name} returned isError: ${text}`);
  }
  return result;
}

const timeout = setTimeout(() => {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited before the timeout callback ran.
  }
  rejectPending(new Error(`DeepSeek bridge verifier timed out; stderr:\n${stderr}`));
}, 60_000);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// ---------------------------------------------------------------------------
// Faithful port of the harness's enforced JSON Schema subset (dsh-tools
// json-schema.ts): keyword whitelist, structural rules, and value validation.
// Wire-parsed schemas are plain JSON, so the realm/lossless guards of the
// original collapse to plain typeof/Array checks here.
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYWORDS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
]);
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const ONE_OF_SIBLING_KEYWORDS = [
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
];
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

function isScalarOfType(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
    case "integer":
      return (
        typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) && Number.isInteger(value)
      );
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** assertSupportedJsonSchema: every violation for one raw schema tree. */
function subsetAssertViolations(node, path = "schema", violations = [], depth = 0) {
  if (depth > 64) {
    violations.push(`${path} nested deeper than 64`);
    return violations;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`);
    return violations;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue;
    if (ANNOTATION_KEYWORDS.has(key)) {
      if (key === "description" && typeof node[key] !== "string") {
        violations.push(`${path}.${key} must be a string`);
      } else if (key === "title" && typeof node[key] !== "string") {
        violations.push(`${path}.${key} must be a string`);
      }
      continue;
    }
    violations.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
    );
  }
  const hasType = Object.hasOwn(node, "type");
  const hasOneOf = Object.hasOwn(node, "oneOf");
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    return violations;
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
    }
    return violations;
  }
  if (hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
    }
    const oneOf = node.oneOf;
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`);
    } else {
      oneOf.forEach((branch, index) =>
        subsetAssertViolations(branch, `${path}.oneOf[${index}]`, violations, depth + 1),
      );
    }
    return violations;
  }
  const type = node.type;
  if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
    violations.push(
      Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`,
    );
    return violations;
  }
  const allowedFor = {
    properties: ["object"],
    required: ["object"],
    additionalProperties: ["object"],
    items: ["array"],
    enum: [...SCALAR_TYPES],
    const: [...SCALAR_TYPES],
  };
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`);
    }
  }
  if (type === "object") {
    const properties = node.properties;
    if (Object.hasOwn(node, "properties")) {
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
        violations.push(`${path}.properties must be an object of schemas`);
      } else {
        for (const [key, child] of Object.entries(properties)) {
          subsetAssertViolations(child, `${path}.properties.${key}`, violations, depth + 1);
        }
      }
    }
    const required = node.required;
    if (Object.hasOwn(node, "required")) {
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
        violations.push(`${path}.required must be an array of strings`);
      } else {
        const declared = typeof properties === "object" && properties !== null ? properties : {};
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) {
            violations.push(`${path}.required names "${key}" which is not in properties`);
          }
        }
      }
    }
    if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
    return violations;
  }
  if (type === "array") {
    if (Object.hasOwn(node, "items")) {
      subsetAssertViolations(node.items, `${path}.items`, violations, depth + 1);
    }
    return violations;
  }
  // Scalar node.
  if (Object.hasOwn(node, "enum")) {
    const allowed = node.enum;
    if (
      !Array.isArray(allowed) ||
      allowed.length === 0 ||
      !allowed.every((entry) => isScalarOfType(type, entry))
    ) {
      violations.push(`${path}.enum must be a non-empty array of ${type} values`);
    }
  }
  if (Object.hasOwn(node, "const") && !isScalarOfType(type, node.const)) {
    violations.push(`${path}.const must be a ${type} value`);
  }
  return violations;
}

/** validateJsonSchemaValue: violations for one value against a subset schema. */
function subsetValueViolations(node, value, path = "value", violations = [], depth = 0) {
  if (depth > 64) {
    violations.push(`"${path}" nested deeper than 64`);
    return violations;
  }
  if (Object.hasOwn(node, "oneOf")) {
    let matches = 0;
    for (const branch of node.oneOf) {
      const branchViolations = subsetValueViolations(branch, value, path, [], depth + 1);
      if (branchViolations.length === 0) matches++;
    }
    if (matches !== 1) {
      violations.push(`"${path}" must match exactly one oneOf branch (matched ${matches})`);
    }
    return violations;
  }
  if (!Object.hasOwn(node, "type")) {
    return violations; // Annotation-only: any JSON value accepted.
  }
  switch (node.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        violations.push(`"${path}" must be an object`);
        return violations;
      }
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${path === "value" ? key : `${path}.${key}`}"`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
        subsetValueViolations(child, value[key], `${path}.${key}`, violations, depth + 1);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(
              `"${path}.${key}" is not a declared property (additionalProperties: false)`,
            );
          }
        }
      }
      return violations;
    }
    case "array": {
      if (!Array.isArray(value)) {
        violations.push(`"${path}" must be an array`);
        return violations;
      }
      if (node.items !== undefined) {
        value.forEach((entry, index) =>
          subsetValueViolations(node.items, entry, `${path}[${index}]`, violations, depth + 1),
        );
      }
      return violations;
    }
    case "string":
      if (typeof value !== "string") violations.push(`"${path}" must be a string`);
      else if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`);
      } else if (Object.hasOwn(node, "const") && value !== node.const) {
        violations.push(`"${path}" must be ${JSON.stringify(node.const)}`);
      }
      return violations;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
        violations.push(`"${path}" must be a finite JSON number`);
      } else if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`);
      } else if (Object.hasOwn(node, "const") && value !== node.const) {
        violations.push(`"${path}" must be ${JSON.stringify(node.const)}`);
      }
      return violations;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        !Number.isFinite(value) ||
        Object.is(value, -0)
      ) {
        violations.push(`"${path}" must be an integer`);
      } else if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`);
      } else if (Object.hasOwn(node, "const") && value !== node.const) {
        violations.push(`"${path}" must be ${JSON.stringify(node.const)}`);
      }
      return violations;
    case "boolean":
      if (typeof value !== "boolean") violations.push(`"${path}" must be a boolean`);
      else if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`);
      }
      return violations;
    case "null":
      if (value !== null) violations.push(`"${path}" must be null`);
      return violations;
    default:
      return violations;
  }
}

/** Walk a schema node; collect $ref pointers for the input-schema check. */
function collectRefs(node, refs, depth = 0) {
  if (depth > 32 || node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs, depth + 1);
    return;
  }
  if (typeof node.$ref === "string") {
    refs.push(node.$ref);
  }
  for (const value of Object.values(node)) {
    collectRefs(value, refs, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Live checks.
// ---------------------------------------------------------------------------

try {
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "dsh-bridge-verifier", version: "0" },
    protocolVersion: "2024-11-05",
  });
  if (initialized.error || initialized.result?.serverInfo?.name !== "xuanling-mcp") {
    throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const toolsResponse = await request("tools/list", {});
  if (toolsResponse.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(toolsResponse)}`);
  }
  const tools = toolsResponse.result?.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  check("tools listed", tools.length > 0, `${tools.length} tools`);
  if (toolProfile === "memory") {
    const expected = [
      "memory_candidate_archive",
      "memory_candidate_create",
      "memory_candidate_get",
      "memory_candidate_list",
      "memory_candidate_replace",
      "memory_feedback",
      "memory_get",
      "memory_review",
      "memory_search",
    ];
    check(
      "memory profile exposes the complete memory workflow only",
      JSON.stringify([...toolNames].sort()) === JSON.stringify(expected),
      `${tools.length} tools: ${[...toolNames].sort().join(", ")}`,
    );
  }
  if (toolProfile === "fs") {
    check(
      "fs profile exposes the exact 16-tool filesystem family",
      JSON.stringify([...toolNames].sort()) === JSON.stringify(EXACT_FS_PROFILE_TOOLS),
      `${tools.length} tools: ${[...toolNames].sort().join(", ")}`,
    );
  }

  // 1. Public names must satisfy the DeepSeek function-name contract with NO
  //    normalization: `mcp__xuanling__<raw>` used verbatim.
  const badNames = tools.filter(
    (tool) =>
      !NAME_PATTERN.test(`${PUBLIC_PREFIX}${tool.name}`) ||
      `${PUBLIC_PREFIX}${tool.name}`.length > 64,
  );
  check(
    "public names fit DeepSeek contract verbatim",
    badNames.length === 0,
    badNames.length === 0
      ? `all ${tools.length} names clean (longest ${
          tools.reduce((max, tool) => Math.max(max, `${PUBLIC_PREFIX}${tool.name}`.length), 0)
        } chars)`
      : `offenders: ${badNames.map((tool) => tool.name).join(", ")}`,
  );

  // 2. Pass-through schemas must be self-contained: every $ref resolves inside
  //    the tool's own $defs; required stays within properties.
  const schemaProblems = [];
  for (const tool of tools) {
    const schema = tool.inputSchema;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      schemaProblems.push(`${tool.name}: inputSchema is not an object`);
      continue;
    }
    const defs = schema.$defs ?? {};
    const refs = [];
    collectRefs(schema, refs);
    for (const ref of refs) {
      if (!ref.startsWith("#/$defs/")) {
        schemaProblems.push(`${tool.name}: non-local $ref ${ref}`);
        continue;
      }
      const segments = ref.slice("#/$defs/".length).split("/");
      let node = defs;
      for (const segment of segments) {
        node = node?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      if (node === undefined) {
        schemaProblems.push(`${tool.name}: dangling $ref ${ref}`);
      }
    }
    const properties = Object.keys(schema.properties ?? {});
    for (const required of schema.required ?? []) {
      if (!properties.includes(required)) {
        schemaProblems.push(`${tool.name}: required "${required}" missing from properties`);
      }
    }
  }
  check(
    "canonical input schemas are self-contained",
    schemaProblems.length === 0,
    schemaProblems.length === 0
      ? "all $ref targets resolve, required ⊆ properties"
      : schemaProblems.join("; "),
  );

  if (toolProfile === "memory" || toolProfile === "fs") {
    const projectionProblems = [];
    for (const tool of tools) {
      try {
        const projected = projectInputSchemaForDsh(tool.inputSchema);
        const violations = subsetAssertViolations(projected);
        if (violations.length > 0) {
          projectionProblems.push(`${tool.name}: ${violations.join("; ")}`);
        }
        if (
          projected.properties?.scope !== undefined &&
          (projected.properties.scope.type !== "object" ||
            !Array.isArray(projected.properties.scope.properties?.type?.enum))
        ) {
          projectionProblems.push(`${tool.name}: scope did not project to an inline tagged object`);
        }
        if (projected.properties?.output !== undefined) {
          const output = projected.properties.output;
          const branches = output.oneOf ?? (output.type === "object" ? [output] : undefined);
          const modes = Array.isArray(branches)
            ? branches
                .filter((branch) => branch.properties?.mode !== undefined)
                .flatMap((branch) => branch.properties.mode.enum ?? [branch.properties.mode.const])
            : [];
          if (modes.length === 0) {
            projectionProblems.push(`${tool.name}: output selector lost its tagged-object shape`);
          } else if (!modes.includes("bounded") || !modes.includes("complete")) {
            projectionProblems.push(`${tool.name}: output selector lost its bounded/complete variants`);
          }
        }
      } catch (error) {
        projectionProblems.push(`${tool.name}: ${String(error)}`);
      }
    }
    check(
      `${toolProfile} input schemas project to the DSH subset`,
      projectionProblems.length === 0,
      projectionProblems.length === 0
        ? `all ${tools.length} schemas projected; tagged objects remain object-valued`
        : projectionProblems.join(" | "),
    );
  }

  // 3a. Classify advertised output schemas against the harness subset.
  const advertised = tools.filter((tool) => tool.outputSchema !== undefined);
  const validatedPath = advertised.filter(
    (tool) => subsetAssertViolations(structuredClone(tool.outputSchema)).length === 0,
  );
  const fallbackPath = advertised.filter((tool) => !validatedPath.includes(tool));
  check(
    "advertised output schemas classified (fallback or validated)",
    advertised.length === tools.length && advertised.length > 0,
    `${fallbackPath.length} fallback (subset-rejected, unconstrained structuredContent), ${validatedPath.length} validated (enforced on every call): ${
      validatedPath.map((tool) => tool.name).join(", ") || "(none)"
    }`,
  );

  // 3b. If ANY advertised schema lands inside the harness subset (validated
  //     path — enforced on every call), exercise each such tool once and
  //     validate the live structuredContent against its advertised schema.
  //     Today every schema carries subset-external vocabulary (schemars'
  //     $schema root keyword, $defs, $ref) and the bridge takes the fallback
  //     path for all of them; this branch is the tripwire for schema drift.
  const exerciseProblems = [];
  const validated = new Map(); // tool name -> live structuredContent
  if (validatedPath.length > 0 && !toolNames.has("fs_write_text")) {
    exerciseProblems.push(
      `validated-path profile has no complete non-destructive probe set: ${validatedPath
        .map((tool) => tool.name)
        .join(", ")}`,
    );
  }
  if (validatedPath.length > 0 && toolNames.has("fs_write_text")) {
    const probePath = path.join(temporaryDirectory, "probe.txt");
    const subDir = path.join(temporaryDirectory, "sub");
    const remember = (name, result) => {
      if (!validatedPath.some((tool) => tool.name === name)) return;
      validated.set(name, result.structuredContent);
    };

    const writeResult = await callTool("fs_write_text", {
      path: probePath,
      content: "alpha line\nbeta line\n",
    });
    remember("fs_write_text", writeResult);
    remember("fs_hash", await callTool("fs_hash", { path: probePath }));
    remember("fs_mkdir", await callTool("fs_mkdir", { path: subDir }));
    remember(
      "fs_copy",
      await callTool("fs_copy", { from: probePath, to: path.join(subDir, "copy.txt") }),
    );
    remember(
      "fs_move",
      await callTool("fs_move", {
        from: path.join(subDir, "copy.txt"),
        to: path.join(subDir, "moved.txt"),
      }),
    );
    remember("fs_remove", await callTool("fs_remove", { path: path.join(subDir, "moved.txt") }));
    remember(
      "fs_replace_text",
      await callTool("fs_replace_text", { path: probePath, old: "alpha", new: "ALPHA" }),
    );

    // Two reversible edits drive change_commit and change_rollback.
    const commitEdit = await callTool("fs_edit", {
      path: probePath,
      old: "beta",
      new: "BETA",
      reversible: true,
    });
    remember(
      "change_commit",
      await callTool("change_commit", { change_id: commitEdit.structuredContent.change_id }),
    );
    const rollbackEdit = await callTool("fs_edit", {
      path: probePath,
      old: "BETA",
      new: "beta",
      reversible: true,
    });
    remember(
      "change_rollback",
      await callTool("change_rollback", { change_id: rollbackEdit.structuredContent.change_id }),
    );

    // fs_patch needs the exact current preimage hash (file is
    // "ALPHA line\nBETA line\n" again after the rollback).
    const preHash = await callTool("fs_hash", { path: probePath });
    remember(
      "fs_patch",
      await callTool("fs_patch", {
        path: probePath,
        expected_preimage_sha256: preHash.structuredContent.digest,
        unified_diff:
          "--- file\n+++ file\n@@ -1,2 +1,3 @@\n ALPHA line\n BETA line\n+gamma line\n",
      }),
    );

    remember("path_resolve", await callTool("path_resolve", { path: "probe.txt" }));
    remember(
      "path_relative",
      await callTool("path_relative", { path: subDir, base_dir: temporaryDirectory }),
    );

    // A truncated process output produces an artifact with a read capability.
    if (validatedPath.some((tool) => tool.name === "artifact_read")) {
      const spill = await callTool("process_run", {
        program: "printf",
        args: ["abcdefghijklmnopqrstuvwxyz012345"],
        output: { mode: "bounded", max_bytes: 16 },
      });
      const spilled = Array.isArray(spill.structuredContent?.artifacts)
        ? spill.structuredContent.artifacts[0]
        : undefined;
      if (spilled?.id === undefined || spilled?.read_capability === undefined) {
        exerciseProblems.push("process_run truncation produced no artifact {id, read_capability}");
      } else {
        remember(
          "artifact_read",
          await callTool("artifact_read", {
            id: spilled.id,
            read_capability: spilled.read_capability,
            length: 4,
          }),
        );
      }
    }
    if (validatedPath.some((tool) => tool.name === "artifact_cleanup_preview")) {
      remember("artifact_cleanup_preview", await callTool("artifact_cleanup_preview", {}));
    }
    if (validatedPath.some((tool) => tool.name === "artifact_cleanup")) {
      remember("artifact_cleanup", await callTool("artifact_cleanup", {}));
    }
    if (validatedPath.some((tool) => tool.name === "session_close")) {
      const session = await callTool("session_open", { cwd: temporaryDirectory });
      if (session.structuredContent?.session_id === undefined) {
        exerciseProblems.push("session_open returned no session_id");
      } else {
        remember(
          "session_close",
          await callTool("session_close", { session_id: session.structuredContent.session_id }),
        );
      }
    }
    if (validatedPath.some((tool) => tool.name === "system_info")) {
      remember("system_info", await callTool("system_info", {}));
    }

    const missingExercises = validatedPath
      .filter((tool) => !validated.has(tool.name))
      .map((tool) => tool.name);
    if (missingExercises.length > 0) {
      exerciseProblems.push(`validated-path tools not exercised: ${missingExercises.join(", ")}`);
    }
    for (const tool of validatedPath) {
      const live = validated.get(tool.name);
      if (live === undefined) continue;
      const violations = subsetValueViolations(structuredClone(tool.outputSchema), live);
      if (violations.length > 0) {
        exerciseProblems.push(`${tool.name}: ${violations.join("; ")}`);
      }
    }
  }
  check(
    "validated-path tools (if any) exercised and conformant",
    exerciseProblems.length === 0,
    validatedPath.length === 0
      ? "none today (all fallback); tripwire active"
      : exerciseProblems.length === 0
        ? `${validated.size}/${validatedPath.length} exercised and conformant`
        : exerciseProblems.join(" | "),
  );

  // 4. Object-typed parameters round-trip verbatim (no host stringification,
  //    no compat shim on this path). Uses its own >64-byte probe.
  if (toolNames.has("fs_read_text")) {
    const objectProbePath = path.join(temporaryDirectory, "object-probe.txt");
    await writeFile(objectProbePath, `${"xuanling dsh bridge probe line\n".repeat(8)}\n`, "utf8");
    const bounded = await callTool("fs_read_text", {
      path: objectProbePath,
      output: { mode: "bounded", max_bytes: 64 },
    });
    check(
      "object param (output selector) round-trips verbatim",
      bounded.structuredContent?.truncated === true &&
        (bounded.structuredContent?.returned_bytes ?? 0) === 64,
      `truncated=${JSON.stringify(bounded.structuredContent?.truncated ?? null)}, returned_bytes=${JSON.stringify(
        bounded.structuredContent?.returned_bytes ?? null,
      )}`,
    );
  } else if (toolNames.has("memory_search")) {
    const search = await callTool("memory_search", {
      namespace: "dsh-bridge-verifier",
      scope: { type: "global" },
      query: "xuanling-dsh-bridge-deliberate-no-match",
      candidate_limit: 10,
      limit: 5,
    });
    check(
      "object param (memory scope) round-trips verbatim",
      search.structuredContent?.scope_mode === "exact" &&
        Array.isArray(search.structuredContent?.items),
      `scope_mode=${JSON.stringify(search.structuredContent?.scope_mode ?? null)}, items=${JSON.stringify(
        search.structuredContent?.items ?? null,
      )}`,
    );
  } else {
    check("object parameter round-trip probe available", false, "profile has no supported probe tool");
  }

  // 5. Domain failures surface as isError with BOTH a human line and a JSON
  //    text block (the bridge joins content blocks and throws, so the model
  //    sees the machine-readable payload too).
  const missing = toolNames.has("fs_stat")
    ? await request("tools/call", {
        name: "fs_stat",
        arguments: { path: path.join(temporaryDirectory, "definitely-missing") },
      })
    : await request("tools/call", {
        name: "memory_get",
        arguments: {
          namespace: "dsh-bridge-verifier",
          scope: { type: "global" },
          record_id: "definitely-missing",
        },
      });
  let failurePayload;
  for (const block of missing.result?.content ?? []) {
    try {
      const parsed = JSON.parse(block.text ?? "");
      if (typeof parsed.code === "string") failurePayload = parsed;
    } catch {
      // Not the JSON block.
    }
  }
  check(
    "domain failure: isError + structured JSON content block",
    missing.result?.isError === true && failurePayload !== undefined,
    `isError=${JSON.stringify(missing.result?.isError ?? null)}, code=${JSON.stringify(
      failurePayload?.code ?? null,
    )}`,
  );

  child.stdin.end();
  const exit = await childSettled;
  if (protocolFailure) {
    throw protocolFailure;
  }
  if (exit.code !== 0 || exit.signal) {
    throw new Error(`server exited as ${JSON.stringify(exit)}; stderr:\n${stderr}`);
  }
} finally {
  clearTimeout(timeout);
  lineReader.close();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the state check and kill.
    }
  }
  await childSettled.catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}

const failed = checks.filter((checkEntry) => !checkEntry.ok);
for (const checkEntry of checks) {
  console.log(`${checkEntry.ok ? "PASS" : "FAIL"} ${checkEntry.name}: ${checkEntry.detail}`);
}
if (failed.length > 0) {
  console.error(`verify-deepseek-bridge: ${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`verify-deepseek-bridge OK: ${checks.length} checks, ${checks.length} passed`);
