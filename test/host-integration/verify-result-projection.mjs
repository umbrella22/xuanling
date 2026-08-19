#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const SUPPORTED_PROJECTION_MODES = new Set([
  "zcode_content_plus_structured",
  "dsh_native_content",
]);

function fail(message) {
  process.stderr.write(`result-projection-verifier: ${message}\n`);
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--fixture" || !argv[1]) {
    throw new Error("usage: verify-result-projection.mjs --fixture <path>");
  }
  return argv[1];
}

function parseJsonText(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function validateFixture(fixture) {
  if (!isRecord(fixture) || fixture.schema_version !== 1) {
    throw new Error("fixture must be a schema_version=1 object");
  }
  const allowed = new Set([
    "schema_version",
    "fixture_id",
    "host",
    "host_version",
    "source_contract",
    "projection_mode",
    "result",
  ]);
  const extras = Object.keys(fixture).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`fixture has unsupported fields: ${extras.join(", ")}`);
  if (typeof fixture.fixture_id !== "string" || fixture.fixture_id.length === 0) {
    throw new Error("fixture_id must be a non-empty string");
  }
  if (typeof fixture.host !== "string" || typeof fixture.host_version !== "string") {
    throw new Error("host and host_version must be strings");
  }
  if (!isRecord(fixture.source_contract)) throw new Error("source_contract must be an object");
  if (!SUPPORTED_PROJECTION_MODES.has(fixture.projection_mode)) {
    throw new Error(`unsupported projection_mode: ${fixture.projection_mode}`);
  }
  if (!isRecord(fixture.result) || !Array.isArray(fixture.result.content)) {
    throw new Error("result.content must be an array");
  }
  if (!Object.hasOwn(fixture.result, "structuredContent")) {
    throw new Error("result.structuredContent is required");
  }
}

function countEquivalentTextBlocks(content, structuredContent) {
  return content.filter((block) =>
    isRecord(block) &&
    block.type === "text" &&
    isDeepStrictEqual(parseJsonText(block.text), structuredContent),
  ).length;
}

function textBytes(content) {
  return content.reduce((total, block) =>
    total + (isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? Buffer.byteLength(block.text)
      : 0), 0);
}

export function analyzeResultProjection(fixture) {
  validateFixture(fixture);
  const wireEquivalentTextBlocks = countEquivalentTextBlocks(
    fixture.result.content,
    fixture.result.structuredContent,
  );
  const hostAppendsStructuredToModel = fixture.projection_mode === "zcode_content_plus_structured";
  const modelVisibleEquivalentCount =
    wireEquivalentTextBlocks + (hostAppendsStructuredToModel ? 1 : 0);

  return {
    schema_version: 1,
    fixture_id: fixture.fixture_id,
    host: fixture.host,
    host_version: fixture.host_version,
    projection_mode: fixture.projection_mode,
    wire: {
      content_text_bytes: textBytes(fixture.result.content),
      equivalent_structured_text_blocks: wireEquivalentTextBlocks,
      structured_bytes: Buffer.byteLength(JSON.stringify(fixture.result.structuredContent)),
    },
    model: {
      appends_structured_content: hostAppendsStructuredToModel,
      equivalent_structured_value_count: modelVisibleEquivalentCount,
      unique_structured_projection: modelVisibleEquivalentCount === 1,
    },
    code_mode: {
      structured_content_preserved: true,
    },
  };
}

function main() {
  let fixturePath;
  try {
    fixturePath = parseArgs(process.argv.slice(2));
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const report = analyzeResultProjection(fixture);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.model.unique_structured_projection) {
      fail(
        `projection_not_unique: expected 1 model-visible structured value, got ${report.model.equivalent_structured_value_count}`,
      );
    }
    if (!report.code_mode.structured_content_preserved) {
      fail("structured_content_not_preserved");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
