import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const bundleRoot = path.join(
  repoRoot,
  "integrations",
  "deepseek-harness",
  "xuanling-skills",
);
const policyPath = path.join(bundleRoot, "strict-overwrite-policy.mjs");
const guardedTool = "mcp__xuanling__fs_write_text";

function readBundle(relative) {
  return readFileSync(path.join(bundleRoot, relative), "utf8");
}

async function loadPolicy() {
  assert.ok(
    existsSync(policyPath),
    "strict overwrite policy module missing (RFC 0002 Stage 1)",
  );
  return import(`${pathToFileURL(policyPath).href}?test=${Date.now()}`);
}

function captureListener(apply) {
  let listener;
  const ctx = {
    on(event, candidate) {
      assert.equal(event, "tools/pre-execute");
      assert.equal(listener, undefined, "policy registers one listener");
      listener = candidate;
      return () => {};
    },
  };
  apply(ctx);
  assert.equal(typeof listener, "function");
  return listener;
}

test("the installed skills bundle ships a directly loadable strict overwrite policy", () => {
  assert.ok(existsSync(policyPath), "policy module is packaged with the skills bundle");

  const manifest = JSON.parse(readBundle("package.json"));
  assert.ok(manifest.files.includes("strict-overwrite-policy.mjs"));
  assert.equal(manifest.files.includes("policy.cordis.yml"), false);

  const patch = readBundle("cordis.patch.yml");
  assert.match(patch, /name:\s*['"]?@xuanling-rs\/xuanling-dsh-skills\/strict-overwrite-policy\.mjs/);
  assert.doesNotMatch(patch, /name:\s*cordis:include/);
  assert.doesNotMatch(patch, /XUANLING_DSH_POLICY_CONFIG/);
});

test("overwrite and default-overwrite calls require a non-empty preimage hash", async () => {
  const { decideStrictOverwrite } = await loadPolicy();
  for (const argumentsValue of [
    { path: "existing.txt", content: "next" },
    { path: "existing.txt", content: "next", mode: "overwrite" },
    { path: "existing.txt", content: "next", mode: "overwrite", expected_sha256: "" },
    { path: "existing.txt", content: "next", mode: "overwrite", expected_sha256: null },
  ]) {
    const decision = decideStrictOverwrite(guardedTool, argumentsValue);
    assert.equal(decision.kind, "deny", JSON.stringify(argumentsValue));
    assert.match(decision.reason, /XUANLING_FS_OVERWRITE_REQUIRES_SHA256/);
    assert.match(decision.reason, /expected_sha256/);
  }
});

test("overwrite recovery distinguishes content-derived reads from fingerprint-only CAS", async () => {
  const { STRICT_OVERWRITE_DENIAL } = await loadPolicy();
  assert.match(STRICT_OVERWRITE_DENIAL, /content-derived/i);
  assert.match(STRICT_OVERWRITE_DENIAL, /fingerprint-only/i);
  assert.match(STRICT_OVERWRITE_DENIAL, /fs_read_text/);
  assert.match(STRICT_OVERWRITE_DENIAL, /fs_hash/);
  assert.doesNotMatch(STRICT_OVERWRITE_DENIAL, /fs_hash[^;]*read(?:ing)? the content/i);
});

test("memory review asks the host approval service without exposing payload content", async () => {
  const { apply } = await loadPolicy();
  const listener = captureListener(apply);
  let nextCalls = 0;
  const decision = await listener({
    name: "mcp__xuanling__memory_review",
    arguments: {
      proposal_id: "proposal-17",
      decision: "approve",
      reviewer_id: "caller-attested",
      comment: "SECRET-PAYLOAD-MUST-NOT-LEAK",
    },
  }, async () => {
    nextCalls += 1;
    return { kind: "allow" };
  });
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /proposal-17/);
  assert.match(decision.reason, /approve/);
  assert.doesNotMatch(decision.reason, /SECRET-PAYLOAD-MUST-NOT-LEAK/);
  assert.equal(nextCalls, 0);
});

test("create, hash-bearing overwrite, and canonical malformed inputs delegate unchanged", async () => {
  const { decideStrictOverwrite } = await loadPolicy();
  const cases = [
    { path: "new.txt", content: "new", mode: "create" },
    { path: "existing.txt", content: "next", mode: "overwrite", expected_sha256: "a".repeat(64) },
    { path: "existing.txt", content: "next", expected_sha256: "b".repeat(64) },
    { path: "bad.txt", content: "bad", mode: "future-mode" },
    null,
    "not-an-object",
  ];
  for (const argumentsValue of cases) {
    assert.deepEqual(
      decideStrictOverwrite(guardedTool, argumentsValue),
      { kind: "delegate" },
      JSON.stringify(argumentsValue),
    );
  }
});

test("exact tool identity prevents native and foreign-provider false positives", async () => {
  const { decideMemoryReview, decideStrictOverwrite } = await loadPolicy();
  const unsafeArguments = { path: "existing.txt", content: "next", mode: "overwrite" };
  for (const name of [
    "write",
    "fs_write_text",
    "mcp__other__fs_write_text",
    "mcp__xuanling__fs_replace_text",
    "mcp__xuanling__fs_write_text_extra",
  ]) {
    assert.deepEqual(decideStrictOverwrite(name, unsafeArguments), { kind: "delegate" }, name);
  }
  for (const name of [
    "memory_review",
    "mcp__other__memory_review",
    "mcp__xuanling__memory_review_extra",
  ]) {
    assert.deepEqual(decideMemoryReview(name, { proposal_id: "p", decision: "approve" }), {
      kind: "delegate",
    }, name);
  }
});

test("the plugin denies before next and never mutates frozen arguments", async () => {
  const { apply } = await loadPolicy();
  const listener = captureListener(apply);
  const argumentsValue = Object.freeze({
    path: "existing.txt",
    content: "next",
    mode: "overwrite",
  });
  const snapshot = JSON.stringify(argumentsValue);
  let nextCalls = 0;
  const decision = await listener(
    Object.freeze({ name: guardedTool, arguments: argumentsValue }),
    async () => {
      nextCalls += 1;
      return { kind: "allow" };
    },
  );
  assert.equal(decision.kind, "deny");
  assert.equal(nextCalls, 0, "a denied call never reaches downstream policy or tool dispatch");
  assert.equal(JSON.stringify(argumentsValue), snapshot);
});

test("the same listener covers a Code Mode sub-dispatch and delegates safe calls", async () => {
  const { apply } = await loadPolicy();
  const listener = captureListener(apply);
  let nextCalls = 0;
  const next = async () => {
    nextCalls += 1;
    return { kind: "allow", marker: "downstream" };
  };

  const denied = await listener({
    name: guardedTool,
    arguments: { path: "existing.txt", content: "next", mode: "overwrite" },
    parent: Symbol("run-code-parent"),
  }, next);
  assert.equal(denied.kind, "deny");
  assert.equal(nextCalls, 0);

  const allowed = await listener({
    name: guardedTool,
    arguments: { path: "new.txt", content: "new", mode: "create" },
    parent: Symbol("run-code-parent"),
  }, next);
  assert.deepEqual(allowed, { kind: "allow", marker: "downstream" });
  assert.equal(nextCalls, 1);
});

test("the host policy preserves v3 selectors and never disables the tool diff", async () => {
  const { apply } = await loadPolicy();
  const listener = captureListener(apply);
  const argumentsValue = Object.freeze({
    path: "existing.txt",
    old: "before",
    new: "after",
    include_diff: true,
  });
  let observedArguments;
  const result = await listener({
    name: "mcp__xuanling__fs_edit",
    arguments: argumentsValue,
  }, async () => {
    observedArguments = argumentsValue;
    return { kind: "allow" };
  });
  assert.deepEqual(result, { kind: "allow" });
  assert.equal(observedArguments, argumentsValue, "request selectors pass through unchanged");
  assert.doesNotMatch(readBundle("strict-overwrite-policy.mjs"), /include_diff\s*[:=]\s*false/);
});
