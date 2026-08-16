import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const evaluationRoot = path.join(
  repoRoot,
  "test",
  "deepseek-harness",
  "evaluation",
  "memory-retrieval",
);
const runner = path.join(evaluationRoot, "run.ts");
const verifier = path.join(evaluationRoot, "verify-transcripts.mjs");
const oracle = path.join(evaluationRoot, "sqlite-oracle.mjs");
const fixtureFile = path.join(evaluationRoot, "fixture.json");

function mustExist(file, label) {
  assert.ok(existsSync(file), `${label} missing: ${file}`);
  return file;
}

function cleanEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    LANG: process.env.LANG ?? "",
    LC_ALL: process.env.LC_ALL ?? "",
    TERM: process.env.TERM ?? "",
    ...extra,
  };
}

function fakeDshRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-memory-fake-dsh-"));
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const cli = path.join(root, "apps", "cli", "src", "bin.ts");
  mkdirSync(path.dirname(tsx), { recursive: true });
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(tsx, "#!/bin/sh\nexit 99\n");
  writeFileSync(cli, "");
  chmodSync(tsx, 0o755);
  return root;
}

function fakeBinary(root) {
  const binary = path.join(root, "xuanling-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 98\n");
  chmodSync(binary, 0o755);
  return binary;
}

function createSyntheticDatabase(database, fixture) {
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE memory_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memory_record_versions (
      record_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY (record_id, revision)
    );
    CREATE TABLE memory_record_heads (
      record_id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE memory_record_tags (
      record_id TEXT NOT NULL, revision INTEGER NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY (record_id, revision, tag)
    );
    CREATE TABLE memory_proposals (proposal_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE memory_reviews (proposal_id TEXT PRIMARY KEY, decision TEXT NOT NULL);
    CREATE TABLE memory_feedback_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2_unicode (record_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2_trigram (record_id TEXT PRIMARY KEY);
    INSERT INTO memory_schema_meta VALUES ('schema_version', '2');
  `);
  const version = db.prepare("INSERT INTO memory_record_versions VALUES (?, 1, ?)");
  const head = db.prepare("INSERT INTO memory_record_heads VALUES (?, 1, 'active')");
  const tag = db.prepare("INSERT INTO memory_record_tags VALUES (?, 1, ?)");
  const proposal = db.prepare("INSERT INTO memory_proposals VALUES (?, 'approved')");
  const review = db.prepare("INSERT INTO memory_reviews VALUES (?, 'approve')");
  const unicode = db.prepare("INSERT INTO memory_fts_v2_unicode VALUES (?)");
  const trigram = db.prepare("INSERT INTO memory_fts_v2_trigram VALUES (?)");
  for (const record of fixture.records) {
    version.run(record.id, record.content);
    head.run(record.id);
    for (const value of record.tags) tag.run(record.id, value);
    proposal.run(record.id);
    review.run(record.id);
    unicode.run(record.id);
    trigram.run(record.id);
  }
  db.close();
}

function oracleSnapshot(database) {
  const result = spawnSync(process.execPath, [oracle, "--database", database], {
    encoding: "utf8",
    env: cleanEnv({ NODE_NO_WARNINGS: "1" }),
  });
  assert.equal(result.status, 0, `oracle failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function writeSession(file, fixture, { forbiddenWrite = false, incomplete = false } = {}) {
  const events = [{
    type: "session",
    version: 0,
    id: `session-${path.basename(path.dirname(file))}`,
    createdAt: 1,
    cwd: path.join(path.dirname(file), "workspace"),
    delegationDepth: 0,
  }];
  let seq = 0;
  const push = (type, data, extra = {}) => events.push({ type, seq: seq++, data, ...extra });
  const route = {
    reason: "initial",
    header: {
      config: {
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        reasoningEffort: "max",
      },
      system: "synthetic memory evaluation",
      tools: [],
    },
  };

  push("turn/start", { turn: 1 });
  push("user/message", {
    role: "user",
    source: { kind: "direct" },
    content: [{ type: "text", text: fixture.task }],
  });
  push("step/start", { turn: 1, step: 1 });
  push("request/header", route);
  push("tool/call", {
    turn: 1,
    step: 1,
    callId: "search-call",
    name: "mcp__xuanling__memory_search",
    arguments: JSON.stringify({
      namespace: fixture.namespace,
      scope: fixture.scope,
      scope_mode: "exact",
      query: fixture.query,
      candidate_limit: 20,
      limit: 5,
    }),
  });
  push(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: {
        source: { kind: "tool", callId: "search-call" },
        content: [{
          type: "tool-result",
          toolCallId: "search-call",
          content: [{
            type: "text",
            text: JSON.stringify({
              scope_mode: "exact",
              items: [{
                record: {
                  id: fixture.expected_record_id,
                  revision: "1",
                  content: fixture.expected_content,
                },
                score: 1,
                reasons: ["phrase"],
                scope_distance: 0,
              }],
            }),
          }],
          isError: false,
        }],
      },
    },
    { surfaceOp: "append" },
  );
  if (forbiddenWrite) {
    push("tool/call", {
      turn: 1,
      step: 1,
      callId: "write-call",
      name: "mcp__xuanling__memory_candidate_create",
      arguments: "{}",
    });
    push(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "write-call" },
          content: [{
            type: "tool-result",
            toolCallId: "write-call",
            content: [{ type: "text", text: "{}" }],
            isError: false,
          }],
        },
      },
      { surfaceOp: "append" },
    );
  }
  push("assistant/message", {
    turn: 1,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "" }] },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  push("step/end", { turn: 1, step: 1 });
  push("step/start", { turn: 1, step: 2 });
  push("request/header", route);
  push("assistant/message", {
    turn: 1,
    step: 2,
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: `${fixture.expected_record_id}: ${fixture.expected_content}`,
      }],
    },
    usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 0 },
  });
  push("step/end", { turn: 1, step: 2 });
  if (!incomplete) push("turn/end", { turn: 1, reason: { kind: "completed" } });
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function writeTrial(root, index, fixture, options = {}) {
  const trial = path.join(root, `trial-${index}`);
  const workspace = path.join(trial, "workspace");
  mkdirSync(workspace, { recursive: true });
  const database = path.join(trial, "memory.db");
  createSyntheticDatabase(database, fixture);
  const before = oracleSnapshot(database);
  writeFileSync(path.join(trial, "oracle-before.json"), `${JSON.stringify(before, null, 2)}\n`);
  writeFileSync(
    path.join(trial, "meta.json"),
    `${JSON.stringify({
      trial: index,
      incomplete: false,
      collection_problems: [],
      exit: { code: 0, signal: null, spawnError: null },
      cwd: workspace,
      credential_source: "file_reference",
    }, null, 2)}\n`,
  );
  writeSession(path.join(trial, "session.jsonl"), fixture, options);
  if (options.mutateCanonical) {
    const db = new DatabaseSync(database);
    db.prepare("INSERT INTO memory_feedback_events VALUES ('unexpected-feedback')").run();
    db.close();
  }
  return trial;
}

function verifyRoot(root, trials = 3) {
  return spawnSync(process.execPath, [verifier, "--root", root, "--trials", String(trials)], {
    encoding: "utf8",
    env: cleanEnv({ NODE_NO_WARNINGS: "1" }),
  });
}

test("memory retrieval evaluation artifacts and fixed fixture exist", () => {
  mustExist(runner, "memory live runner");
  mustExist(verifier, "memory transcript verifier");
  mustExist(oracle, "independent SQLite oracle");
  const fixture = JSON.parse(readFileSync(mustExist(fixtureFile, "memory live fixture"), "utf8"));
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.namespace, "core");
  assert.deepEqual(fixture.scope, { type: "global" });
  assert.equal(fixture.query, "results independently filesystem verification");
  assert.equal(fixture.expected_record_id, "r-en-01");
  assert.equal(fixture.records.length, 8);
  assert.equal(
    fixture.records.find((record) => record.id === fixture.expected_record_id)?.content,
    fixture.expected_content,
  );
});

test("runner refuses billable execution and exposes a side-effect-free exact dry-run", () => {
  mustExist(runner, "memory live runner");
  const refused = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /billable|allow-billable-live/i);

  const root = fakeDshRoot();
  const credentialRoot = mkdtempSync(path.join(tmpdir(), "xuanling-memory-credential-"));
  const credential = path.join(credentialRoot, ".credentials.yaml");
  writeFileSync(credential, "synthetic: only\n");
  chmodSync(credential, 0o600);
  try {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--dry-run",
        "--dsh-root", root,
        "--binary", fakeBinary(root),
        "--trials", "3",
        "--credentials-file", credential,
      ],
      { encoding: "utf8", env: cleanEnv() },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.trials, 3);
    assert.equal(plan.credential_source, "file_reference");
    assert.ok(plan.argv.includes(path.join(root, "node_modules", ".bin", "tsx")));
    assert.ok(plan.argv.includes(path.join(root, "apps", "cli", "src", "bin.ts")));
    assert.ok(plan.argv.includes("<task text from memory-retrieval/task.md>"));
    assert.ok(plan.env_names.includes("XUANLING_TEST_MEMORY_DB"));
    assert.ok(!plan.env_names.includes("AWS_SECRET_ACCESS_KEY"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(credentialRoot, { recursive: true, force: true });
  }
});

test("transcript verifier accepts three complete read-only target hits", () => {
  mustExist(verifier, "memory transcript verifier");
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-memory-valid-"));
  try {
    for (let index = 1; index <= 3; index += 1) writeTrial(root, index, fixture);
    const result = verifyRoot(root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.pass, true);
    assert.equal(report.complete_trials, 3);
    assert.ok(report.trials.every((trial) => trial.target_rank === 1));
    assert.ok(report.trials.every((trial) => trial.canonical_unchanged === true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcript verifier fails closed on incomplete, write, and canonical drift evidence", async (t) => {
  mustExist(verifier, "memory transcript verifier");
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
  for (const scenario of [
    { name: "incomplete", options: { incomplete: true }, expected: /incomplete|turn\/end/i },
    { name: "write", options: { forbiddenWrite: true }, expected: /candidate_create|forbidden|write/i },
    { name: "drift", options: { mutateCanonical: true }, expected: /canonical|feedback|drift/i },
  ]) {
    await t.test(scenario.name, () => {
      const root = mkdtempSync(path.join(tmpdir(), `xuanling-memory-${scenario.name}-`));
      try {
        writeTrial(root, 1, fixture, scenario.options);
        const result = verifyRoot(root, 1);
        assert.notEqual(result.status, 0, `${scenario.name} unexpectedly passed`);
        assert.match(`${result.stdout}\n${result.stderr}`, scenario.expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
