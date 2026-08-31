const GUARDED_TOOL = "mcp__xuanling__fs_write_text";
const REVIEW_TOOL = "mcp__xuanling__memory_review";

export const STRICT_OVERWRITE_DENIAL =
  "[XUANLING_FS_OVERWRITE_REQUIRES_SHA256] " +
  "mcp__xuanling__fs_write_text mode=overwrite requires a non-empty " +
  "expected_sha256; for content-derived changes, read with " +
  "mcp__xuanling__fs_read_text include_sha256=true; for an independently " +
  "authoritative whole replacement, mcp__xuanling__fs_hash supplies a " +
  "fingerprint-only CAS precondition; then retry";

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

export function decideMemoryReview(toolName, argumentsValue) {
  if (toolName !== REVIEW_TOOL) return { kind: "delegate" };
  const args = typeof argumentsValue === "object" && argumentsValue !== null &&
      !Array.isArray(argumentsValue)
    ? argumentsValue
    : {};
  const proposalId = typeof args.proposal_id === "string" && args.proposal_id.length > 0
    ? args.proposal_id
    : "unknown proposal";
  const decision = args.decision === "approve" || args.decision === "reject"
    ? args.decision
    : "review";
  return {
    kind: "ask",
    reason: `XuanLing Memory ${decision} requires one-time user approval for ${proposalId}`,
  };
}

export function apply(ctx) {
  ctx.on("tools/pre-execute", (exec, next) => {
    const review = decideMemoryReview(exec.name, exec.arguments);
    if (review.kind === "ask") return Promise.resolve(review);
    const overwrite = decideStrictOverwrite(exec.name, exec.arguments);
    if (overwrite.kind === "deny") return Promise.resolve(overwrite);
    return next();
  });
}
