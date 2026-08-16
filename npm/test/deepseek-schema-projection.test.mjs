import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

import {
  DshSchemaProjectionError,
  projectInputSchemaForDsh,
} from "../../integrations/deepseek-harness/xuanling-memory/schema-projection.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const snapshotPath = path.join(repoRoot, "crates", "xuanling-mcp", "tests", "snapshots", "tools-list.json");
const adapterPath = path.join(
  repoRoot,
  "integrations",
  "deepseek-harness",
  "xuanling-memory",
  "schema-adapter.mjs",
);
const supportedKeywords = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

function assertDshSubset(schema, location = "schema") {
  assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema), location);
  for (const key of Object.keys(schema)) {
    assert.ok(supportedKeywords.has(key), `${location}: unsupported keyword ${key}`);
  }
  assert.ok(!Array.isArray(schema.type), `${location}: type arrays are not supported`);
  if (schema.oneOf !== undefined) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${location}.oneOf`);
    schema.oneOf.forEach((branch, index) => assertDshSubset(branch, `${location}.oneOf[${index}]`));
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertDshSubset(child, `${location}.properties.${name}`);
  }
  if (schema.items !== undefined) assertDshSubset(schema.items, `${location}.items`);
}

function collectSchemaKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSchemaKeys(entry, keys));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectSchemaKeys(entry, keys);
    }
  }
  return keys;
}

test("all Memory v2 input schemas project to the DSH subset without mutating canonical schemas", () => {
  const catalog = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const memoryTools = catalog.filter((tool) => tool.name.startsWith("memory_"));
  assert.equal(memoryTools.length, 9);

  for (const tool of memoryTools) {
    const before = structuredClone(tool.input_schema);
    const projected = projectInputSchemaForDsh(tool.input_schema);
    assert.deepEqual(tool.input_schema, before, `${tool.name}: canonical schema remains unchanged`);
    assert.equal(projected.type, "object", `${tool.name}: object parameter root`);
    assertDshSubset(projected, tool.name);
    if (projected.properties.scope !== undefined) {
      assert.equal(projected.properties.scope.type, "object", `${tool.name}: scope stays object-valued`);
      assert.deepEqual(
        projected.properties.scope.properties.type.enum,
        ["global", "project", "workspace"],
        `${tool.name}: all scope variants remain visible`,
      );
    }
    const allKeys = collectSchemaKeys(projected);
    for (const forbidden of ["$schema", "$defs", "$ref", "anyOf", "format", "minimum"]) {
      assert.ok(!allKeys.has(forbidden), `${tool.name}: ${forbidden} projected away`);
    }
  }

  const search = projectInputSchemaForDsh(
    memoryTools.find((tool) => tool.name === "memory_search").input_schema,
  );
  assert.deepEqual(
    search.properties.scope.properties.type.enum,
    ["global", "project", "workspace"],
    "scope remains a tagged object instead of becoming a string",
  );
  assert.equal(search.properties.scope.type, "object");
  assert.deepEqual(search.properties.scope.required, ["type"]);
  assert.match(search.properties.scope.properties.project_id.description, /project.*workspace/);
  assert.match(search.properties.scope.properties.workspace_id.description, /workspace/);
  assert.match(search.properties.candidate_limit.description, /format=uint64, minimum=0/);

  const create = projectInputSchemaForDsh(
    memoryTools.find((tool) => tool.name === "memory_candidate_create").input_schema,
  );
  assert.equal(create.properties.payload.type, "object");
  assert.deepEqual(create.properties.payload.properties.summary.oneOf, [
    { type: "string" },
    { type: "null" },
  ]);
});

test("all 16 fs input schemas project to the DSH subset with object semantics preserved", () => {
  const catalog = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const fsTools = catalog.filter((tool) => tool.name.startsWith("fs_"));
  assert.equal(fsTools.length, 16);

  const uncovered = [];
  for (const tool of fsTools) {
    const before = structuredClone(tool.input_schema);
    let projected;
    try {
      projected = projectInputSchemaForDsh(tool.input_schema);
    } catch (error) {
      uncovered.push(`${tool.name}: ${error.message}`);
      continue;
    }
    assert.deepEqual(tool.input_schema, before, `${tool.name}: canonical schema remains unchanged`);
    assert.equal(projected.type, "object", `${tool.name}: object parameter root`);
    assertDshSubset(projected, tool.name);
    const allKeys = collectSchemaKeys(projected);
    for (const forbidden of ["$schema", "$defs", "$ref", "anyOf", "format", "minimum"]) {
      assert.ok(!allKeys.has(forbidden), `${tool.name}: ${forbidden} projected away`);
    }
  }
  assert.deepEqual(uncovered, [], `every fs tool schema must project; unsupported: ${uncovered.join("; ")}`);

  const byName = (name) =>
    projectInputSchemaForDsh(fsTools.find((tool) => tool.name === name).input_schema);

  // The two schema gotchas that broke object parameters elsewhere stay objects here.
  const search = byName("fs_search");
  assert.equal(search.properties.literal.type, "boolean", "fs_search literal stays a boolean");
  const glob = byName("fs_glob");
  assert.equal(glob.properties.patterns.type, "array", "fs_glob takes the plural patterns array");
  const patchTool = byName("fs_patch");
  assert.equal(patchTool.properties.unified_diff.type, "string");
  assert.equal(patchTool.properties.expected_preimage_sha256.type, "string");

  // The output selector stays an object-valued tagged union with its
  // canonical numeric constraint surfaced in the description.
  const readBytes = byName("fs_read_bytes");
  const branches = readBytes.properties.output.oneOf;
  assert.ok(Array.isArray(branches) && branches.length === 2, "output selector keeps both variants");
  const [bounded, complete] = branches;
  assert.equal(bounded.properties.mode.const, "bounded");
  assert.equal(complete.properties.mode.const, "complete");
  assert.deepEqual(bounded.required, ["mode", "max_bytes"]);
  assert.equal(bounded.properties.max_bytes.type, "integer");
  assert.match(bounded.properties.max_bytes.description ?? "", /format=uint64, minimum=0/);
});

test("projection fails loud rather than guessing on unresolved or lossy schema constructs", () => {
  assert.throws(
    () => projectInputSchemaForDsh({ type: "object", properties: { value: { $ref: "#/$defs/Missing" } } }),
    DshSchemaProjectionError,
  );
  assert.throws(
    () => projectInputSchemaForDsh({
      $defs: { Loop: { $ref: "#/$defs/Loop" } },
      type: "object",
      properties: { value: { $ref: "#/$defs/Loop" } },
    }),
    /cyclic reference/,
  );
  assert.throws(
    () => projectInputSchemaForDsh({
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "string", const: "x" }] } },
    }),
    /branches overlap/,
  );
  assert.throws(
    () => projectInputSchemaForDsh({ type: "object", properties: { value: { type: "string", maxLength: 5 } } }),
    /maxLength.*not supported/,
  );
});

test("stdio adapter projects discovery while forwarding tools/call arguments unchanged", async () => {
  const fixture = String.raw`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.method === "tools/list") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            tools: [{
              name: "memory_search",
              inputSchema: {
                $defs: {
                  Scope: {
                    oneOf: [
                      { type: "object", properties: { type: { type: "string", const: "global" } }, required: ["type"] },
                      { type: "object", properties: { type: { type: "string", const: "project" }, project_id: { type: "string" } }, required: ["type", "project_id"] }
                    ]
                  }
                },
                type: "object",
                properties: { scope: { $ref: "#/$defs/Scope" } },
                required: ["scope"]
              }
            }]
          }
        }) + "\n");
      } else if (frame.method === "tools/call") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { content: [], structuredContent: { arguments: frame.params.arguments } }
        }) + "\n");
      }
    }
  `;
  const child = spawn(
    process.execPath,
    [
      adapterPath,
      "--binary",
      process.execPath,
      "--",
      "--input-type=module",
      "-e",
      fixture,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const scope = { type: "project", project_id: "project-alpha" };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "memory_search", arguments: { scope } },
  })}\n`);
  child.stdin.end();

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 2, stdout);
  const projectedScope = responses[0].result.tools[0].inputSchema.properties.scope;
  assert.equal(projectedScope.type, "object");
  assert.deepEqual(projectedScope.properties.type.enum, ["global", "project"]);
  assert.ok(!JSON.stringify(responses[0]).includes("$ref"));
  assert.deepEqual(responses[1].result.structuredContent.arguments.scope, scope);
});
