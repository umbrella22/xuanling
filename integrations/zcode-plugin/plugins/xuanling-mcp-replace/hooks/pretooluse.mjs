#!/usr/bin/env node

const SHA256 = /^[0-9a-f]{64}$/;
const NATIVE_TOOLS = new Set(["Read", "Write", "Edit", "ApplyPatch", "MultiEdit"]);
const PLUGIN_MCP_PREFIX = "mcp__plugin_xuanling-mcp-replace_xuanling__";
const PUBLIC_MCP_PREFIX = "mcp__xuanling__";
const XUANLING_TOOLS = new Set([
  "mcp__xuanling__fs_write_text",
  "mcp__xuanling__fs_replace_text",
  "mcp__xuanling__fs_edit",
  "mcp__xuanling__fs_edit_batch",
  "mcp__xuanling__fs_patch",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deny(code, toolName, field) {
  const target = typeof toolName === "string" && toolName.length > 0 ? toolName : "unknown";
  const suffix = field === undefined ? "" : ` (${field})`;
  process.stderr.write(`${code}: ${target}${suffix}\n`);
  process.exitCode = 2;
}

function isCanonicalSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function canonicalXuanlingToolName(toolName) {
  if (!toolName.startsWith(PLUGIN_MCP_PREFIX)) return toolName;
  return `${PUBLIC_MCP_PREFIX}${toolName.slice(PLUGIN_MCP_PREFIX.length)}`;
}

function enforceRequiredSha(toolName, input, field) {
  if (!Object.hasOwn(input, field)) {
    deny("XUANLING_REPLACEMENT_CAS_REQUIRED", toolName, field);
    return false;
  }
  if (!isCanonicalSha256(input[field])) {
    deny("XUANLING_REPLACEMENT_INVALID_CAS", toolName, field);
    return false;
  }
  return true;
}

function enforceMutationCas(toolName, input) {
  if (!isRecord(input)) {
    deny("XUANLING_REPLACEMENT_INVALID_HOOK_INPUT", toolName, "tool_input");
    return;
  }

  if (toolName === "mcp__xuanling__fs_write_text") {
    if (input.mode !== undefined && input.mode !== "create" && input.mode !== "overwrite") {
      deny("XUANLING_REPLACEMENT_INVALID_TOOL_INPUT", toolName, "mode");
      return;
    }
    if (input.mode === "create") {
      if (input.expected_sha256 !== undefined && !isCanonicalSha256(input.expected_sha256)) {
        deny("XUANLING_REPLACEMENT_INVALID_CAS", toolName, "expected_sha256");
      }
      return;
    }
    enforceRequiredSha(toolName, input, "expected_sha256");
    return;
  }

  if (toolName === "mcp__xuanling__fs_edit_batch") {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      deny("XUANLING_REPLACEMENT_INVALID_TOOL_INPUT", toolName, "files");
      return;
    }
    for (let index = 0; index < input.files.length; index += 1) {
      const file = input.files[index];
      if (!isRecord(file)) {
        deny("XUANLING_REPLACEMENT_INVALID_TOOL_INPUT", toolName, `files[${index}]`);
        return;
      }
      const field = `files[${index}].expected_sha256`;
      if (!Object.hasOwn(file, "expected_sha256")) {
        deny("XUANLING_REPLACEMENT_CAS_REQUIRED", toolName, field);
        return;
      }
      if (!isCanonicalSha256(file.expected_sha256)) {
        deny("XUANLING_REPLACEMENT_INVALID_CAS", toolName, field);
        return;
      }
    }
    return;
  }

  const field = toolName === "mcp__xuanling__fs_patch"
    ? "expected_preimage_sha256"
    : "expected_sha256";
  enforceRequiredSha(toolName, input, field);
}

let rawInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) rawInput += chunk;

let event;
try {
  event = JSON.parse(rawInput);
} catch {
  deny("XUANLING_REPLACEMENT_INVALID_HOOK_INPUT");
}

if (process.exitCode !== 2) {
  if (!isRecord(event) || typeof event.tool_name !== "string") {
    deny("XUANLING_REPLACEMENT_INVALID_HOOK_INPUT");
  } else if (NATIVE_TOOLS.has(event.tool_name)) {
    deny("XUANLING_REPLACEMENT_NATIVE_TOOL_DISABLED", event.tool_name);
  } else {
    const canonicalToolName = canonicalXuanlingToolName(event.tool_name);
    if (XUANLING_TOOLS.has(canonicalToolName)) {
      enforceMutationCas(canonicalToolName, event.tool_input);
    }
  }
}
