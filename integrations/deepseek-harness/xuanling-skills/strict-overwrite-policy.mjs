const GUARDED_TOOL = "mcp__xuanling__fs_write_text";

export const STRICT_OVERWRITE_DENIAL =
  "[XUANLING_FS_OVERWRITE_REQUIRES_SHA256] " +
  "mcp__xuanling__fs_write_text mode=overwrite requires a non-empty " +
  "expected_sha256; read with include_sha256=true or call " +
  "mcp__xuanling__fs_hash, then retry";

export const name = "xuanling-strict-overwrite-policy";

/**
 * Decide only the DSH-specific precondition. XuanLing remains responsible for
 * canonical schema validation, hash format, current-file CAS, and filesystem
 * effects.
 */
export function decideStrictOverwrite(toolName, argumentsValue) {
  if (toolName !== GUARDED_TOOL) return { kind: "delegate" };
  if (
    typeof argumentsValue !== "object" ||
    argumentsValue === null ||
    Array.isArray(argumentsValue)
  ) {
    return { kind: "delegate" };
  }

  const mode = argumentsValue.mode;
  if (mode === "create") return { kind: "delegate" };
  if (mode !== undefined && mode !== "overwrite") {
    return { kind: "delegate" };
  }

  const expectedSha256 = argumentsValue.expected_sha256;
  if (typeof expectedSha256 === "string" && expectedSha256.length > 0) {
    return { kind: "delegate" };
  }
  return { kind: "deny", reason: STRICT_OVERWRITE_DENIAL };
}

export function apply(ctx) {
  ctx.on("tools/pre-execute", (exec, next) => {
    const decision = decideStrictOverwrite(exec.name, exec.arguments);
    if (decision.kind === "deny") return Promise.resolve(decision);
    return next();
  });
}
