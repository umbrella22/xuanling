import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Filesystem tool evaluation contract (C-04/C-06/C-07/C-08):
//   - the frozen fs-workload fixture is hash-pinned and its external oracle
//     discriminates: raw workspace fails, solved workspace passes;
//   - A/B/C overlays constrain BOTH discovery and dispatch: A keeps only the
//     native file family, B replaces it with the exact 16-tool XuanLing fs
//     profile (no native fallback), C keeps both; all arms disable the shell
//     tools and every bridge argument is fail-closed (no env fallback), with
//     an explicit isolated Memory DB even though the exposed profile is fs;
//   - the live runner refuses to start without --allow-billable-live;
//   - the analyzer reports `unknown` (never zero) for missing provider usage;
//   - the bridge verifier learns the fs profile's exact-16 catalog check.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const testRoot = path.join(repoRoot, "test", "deepseek-harness");
const evaluationRoot = path.join(testRoot, "evaluation");
const fixtureRoot = path.join(evaluationRoot, "fixtures", "fs-workload");
const fsProfileCount = 16;

function mustExist(absolute, what) {
  assert.ok(existsSync(absolute), `${what} missing: ${absolute}`);
  return absolute;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parsePatch(text) {
  const lines = text.split("\n");
  const contentLines = lines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (contentLines.length === 1 && contentLines[0].trim() === "[]") return [];
  const entries = [];
  let entry;
  let row;
  let inArgs = false;

  const value = (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    if (trimmed.startsWith("!!js ")) return { js: trimmed.slice(5) };
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const topEntry = /^- (\w+):(?: (.*))?$/.exec(line);
    const rowEntry = /^ {4}- (\w+): (.*)$/.exec(line);
    const argItem = /^ {6}(?: {4})?- (.*)$/.exec(line);
    const field = /^ {2,8}(\w+):(?: (.*))?$/.exec(line);
    const fail = (reason) => {
      throw new Error(`patch line ${index + 1}: ${reason}\n${line}`);
    };

    if (topEntry) {
      const [, key, rest] = topEntry;
      if (key === "insert") {
        entry = { insert: [] };
        entries.push(entry);
        row = null;
        inArgs = false;
      } else if (key === "id") {
        entry = { id: value(rest) };
        entries.push(entry);
        row = null;
        inArgs = false;
      } else {
        fail(`unexpected top-level key "${key}"`);
      }
      continue;
    }
    if (!entry) fail("content before the first top-level entry");

    if (rowEntry) {
      if (!entry.insert) fail("row entry outside an insert block");
      const [, key, rest] = rowEntry;
      if (key !== "id") fail(`unexpected row key "${key}"`);
      row = { id: value(rest) };
      entry.insert.push(row);
      inArgs = false;
      continue;
    }
    if (argItem) {
      if (!inArgs || !row?.config) fail("list item outside an args block");
      row.config.args.push(value(argItem[1]));
      continue;
    }
    if (field) {
      const indent = rawLine.length - rawLine.trimStart().length;
      const [, key, rest] = field;
      if (entry.insert && !row && indent === 6) {
        if (key === "name") continue;
        fail(`unexpected key "${key}" at insert level`);
      }
      if (entry.insert && row) {
        if (indent === 6) {
          if (key === "name") {
            row.name = value(rest ?? "");
            continue;
          }
          if (key === "config") {
            row.config = {};
            continue;
          }
          fail(`unexpected row key "${key}"`);
        }
        if (indent === 8 && row.config) {
          if (key === "args") {
            row.config.args = [];
            inArgs = true;
            continue;
          }
          row.config[key] = value(rest ?? "");
          continue;
        }
        fail(`unexpected indent ${indent} inside a row`);
      }
      if (!entry.insert) {
        if (indent === 2) {
          if (key === "name") {
            entry.name = value(rest ?? "");
            continue;
          }
          if (key === "disabled") {
            entry.disabled = value(rest ?? "");
            continue;
          }
          if (key === "config") {
            entry.config = {};
            continue;
          }
        }
        if (indent === 4 && entry.config) {
          entry.config[key] = value(rest ?? "");
          continue;
        }
      }
      fail(`unexpected key "${key}" on a top-level entry`);
    }
    fail("unrecognized line shape");
  }
  return entries;
}

function readOverlay(arm) {
  const file = mustExist(path.join(evaluationRoot, "overlays", arm, "cordis.patch.yml"), `arm ${arm} overlay`);
  return parsePatch(readFileSync(file, "utf8"));
}

function disabledRows(entries) {
  return new Map(entries.filter((e) => e.disabled === true).map((e) => [e.id, e.name]));
}

function assertXuanlingFsBridge(entries, arm) {
  const inserts = entries.filter((e) => e.insert);
  assert.equal(inserts.length, 1, `${arm}: exactly one bridge insert`);
  const row = inserts[0].insert[0];
  assert.equal(row.id, "xuanling-tools", `${arm}: bridge row id`);
  assert.equal(row.name, "@deepseek-ai/dsh-mcp-client", `${arm}: official bridge package`);
  const config = row.config ?? {};
  assert.equal(config.serverName, "xuanling");
  assert.equal(config.failOnStartupError, true, `${arm}: bridge startup failures fail the arm`);
  assert.equal(config.toolCallTimeoutMs, 120000);
  const args = config.args ?? [];
  const profileIndex = args.indexOf("--tool-profile");
  assert.ok(profileIndex !== -1, `${arm}: selects a server-side tool profile`);
  assert.equal(args[profileIndex + 1], "fs", `${arm}: the fs profile is the only mounted family`);
  const memoryDbIndex = args.indexOf("--memory-db");
  assert.ok(memoryDbIndex !== -1, `${arm}: explicitly isolates the store opened by xuanling-mcp`);
  assert.match(
    args[memoryDbIndex + 1]?.js ?? "",
    /XUANLING_TEST_MEMORY_DB.*process\.getBuiltinModule\('node:assert'\)\.fail\(/,
    `${arm}: the temporary Memory DB has no default-path fallback`,
  );
  for (const arg of args) {
    if (typeof arg === "object" && arg.js !== undefined) {
      assert.match(
        arg.js,
        /process\.getBuiltinModule\('node:assert'\)\.fail\(/,
        `${arm}: every bridge expression is fail-closed, no env fallback`,
      );
    }
  }
  const adapter = args.find((arg) => typeof arg === "object" && /XUANLING_DSH_SCHEMA_ADAPTER|schema-adapter/.test(arg.js ?? ""));
  assert.ok(adapter, `${arm}: discovery goes through the schema adapter`);
  return row;
}

function copyFixtureFiles(destination) {
  cpSync(path.join(fixtureRoot, "files"), destination, { recursive: true });
  return destination;
}

function fakeEvaluationDsh() {
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-rfc2-fake-dsh-"));
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const cli = path.join(root, "apps", "cli", "src", "bin.ts");
  mkdirSync(path.dirname(tsx), { recursive: true });
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, "");
  writeFileSync(tsx, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const sessions = path.join(process.env.DSH_HOME, 'sessions', 'synthetic');",
    "fs.mkdirSync(sessions, { recursive: true });",
    "fs.writeFileSync(path.join(process.env.DSH_HOME, 'credential-source-observed'), process.env.XUANLING_DSH_CREDENTIALS_FILE ?? 'missing');",
    "const header = { type: 'session', cwd: process.env.XUANLING_TEST_WORKSPACE_ROOT };",
    "fs.writeFileSync(path.join(sessions, 'session.jsonl'), JSON.stringify(header) + '\\n');",
  ].join("\n"));
  chmodSync(tsx, 0o755);
  return root;
}

function evaluationChildBaseEnv() {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function writeAnalyzerTrial(root, label, {
  system = "frozen system",
  usages = [{ inputTokens: 10, outputTokens: 2 }],
  duplicateUsage,
  initialMessageId,
  userText = "frozen task",
} = {}) {
  const trial = path.join(root, ...label.split("/"));
  mkdirSync(trial, { recursive: true });
  const events = [{ type: "session", cwd: "/tmp/frozen-workspace" }];
  let seq = 0;
  events.push({ type: "turn/start", seq: seq++, data: { turn: 1 } });
  events.push({
    type: "user/message",
    seq: seq++,
    data: {
      ...(initialMessageId === undefined ? {} : { id: initialMessageId }),
      role: "user",
      source: { kind: "direct" },
      content: [{ type: "text", text: userText }],
    },
  });
  for (const [index, usage] of usages.entries()) {
    const step = index + 1;
    events.push({ type: "step/start", seq: seq++, data: { turn: 1, step } });
    events.push({
      type: "request/header",
      seq: seq++,
      data: {
        reason: index === 0 ? "initial" : "change",
        header: {
          config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
          system,
          tools: [],
        },
      },
    });
    if (index === 0 && duplicateUsage !== undefined) {
      events.push({
        type: "assistant/chunk",
        seq: seq++,
        data: { turn: 1, step, chunk: { type: "usage", usage: duplicateUsage } },
      });
    }
    events.push({
      type: "assistant/message",
      seq: seq++,
      data: {
        turn: 1,
        step,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        ...(usage === null ? {} : { usage }),
      },
    });
    events.push({ type: "step/end", seq: seq++, data: { turn: 1, step } });
  }
  events.push({ type: "turn/end", seq: seq++, data: { turn: 1, reason: { kind: "completed" } } });
  writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);
}

test("the fs-workload fixture is complete and hash-pinned", () => {
  const manifest = JSON.parse(readFileSync(mustExist(path.join(fixtureRoot, "manifest.json"), "fixture manifest"), "utf8"));
  mustExist(path.join(fixtureRoot, "task.md"), "frozen task prompt");
  mustExist(path.join(fixtureRoot, "oracle.mjs"), "external oracle");
  mustExist(path.join(fixtureRoot, "solved.patch"), "canonical solution patch");
  assert.equal(manifest.task_sha256, sha256(path.join(fixtureRoot, "task.md")));
  assert.deepEqual(manifest.allowed_new, ["RELEASE.md"]);
  const filesRoot = path.join(fixtureRoot, "files");
  const walk = (dir, prefix = "") => {
    const found = [];
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(path.join(dir, name)).isDirectory()) found.push(...walk(path.join(dir, name), rel));
      else found.push(rel);
    }
    return found;
  };
  const onDisk = walk(filesRoot);
  assert.deepEqual(onDisk, Object.keys(manifest.files).sort(), "manifest lists exactly the fixture tree");
  for (const [rel, hash] of Object.entries(manifest.files)) {
    assert.equal(sha256(path.join(filesRoot, rel)), hash, `fixture file ${rel} matches its pinned hash`);
  }
  for (const [rel, hash] of Object.entries(manifest.untouched)) {
    assert.equal(manifest.files[rel], hash, `untouched file ${rel} is pinned to its initial hash`);
  }
});

test("the external oracle rejects the raw fixture and accepts the solved workspace", () => {
  const oracle = path.join(fixtureRoot, "oracle.mjs");
  const rawDir = copyFixtureFiles(mkdtempSync(path.join(tmpdir(), "xuanling-w1-raw-")));

  const raw = spawnSync(process.execPath, [oracle, "--workspace", rawDir], { encoding: "utf8" });
  assert.equal(raw.status, 1, "raw workspace fails the oracle");
  const rawVerdict = JSON.parse(raw.stdout);
  assert.equal(rawVerdict.pass, false);
  assert.ok(rawVerdict.failures.length >= 5, `raw verdict lists its failures, got ${rawVerdict.failures.length}`);

  const solvedDir = copyFixtureFiles(mkdtempSync(path.join(tmpdir(), "xuanling-w1-solved-")));
  const applied = spawnSync("patch", ["-p1", "--silent", "-i", path.join(fixtureRoot, "solved.patch")], {
    cwd: solvedDir,
    encoding: "utf8",
  });
  assert.equal(applied.status, 0, `solved.patch applies cleanly: ${applied.stdout}${applied.stderr}`);
  const solved = spawnSync(process.execPath, [oracle, "--workspace", solvedDir], { encoding: "utf8" });
  assert.equal(solved.status, 0, `solved workspace passes: ${solved.stdout}`);
  assert.equal(JSON.parse(solved.stdout).pass, true);
});

test("the batch oracle reaches every retained cache workspace snapshot", () => {
  const verifier = mustExist(
    path.join(evaluationRoot, "scripts", "verify-filesystem-fixture.mjs"),
    "batch oracle runner",
  );
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-w5-batch-oracle-"));
  const workspaces = [
    path.join(root, "quality", "A", "trial-1", "workspace"),
    path.join(root, "cache", "A", "pair-1", "cold", "workspace-snapshot"),
    path.join(root, "cache", "A", "pair-1", "warm", "workspace-snapshot"),
  ];
  for (const workspace of workspaces) {
    copyFixtureFiles(workspace);
    const applied = spawnSync("patch", ["-p1", "--silent", "-i", path.join(fixtureRoot, "solved.patch")], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, `solved fixture applies in ${workspace}: ${applied.stdout}${applied.stderr}`);
  }

  const result = spawnSync(process.execPath, [verifier, "--all", root], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.total, 3, "quality plus cold and warm snapshots are independently re-judged");
  assert.deepEqual(
    summary.verdicts.map((verdict) => verdict.label).sort(),
    ["cache/A/pair-1/cold", "cache/A/pair-1/warm", "quality/A/trial-1"],
  );
});

test("the common overlay disables the shell tools and pins raw session logs", () => {
  const entries = readOverlay("common");
  const disabled = disabledRows(entries);
  const credentials = entries.find((entry) => entry.id === "credentials");
  assert.equal(credentials?.name, "@deepseek-ai/dsh-credentials-local");
  assert.equal(credentials?.config?.watch, false, "external credential files are immutable during one trial");
  assert.match(
    credentials?.config?.path?.js ?? "",
    /XUANLING_DSH_CREDENTIALS_FILE.*process\.getBuiltinModule\('node:assert'\)\.fail\(/,
    "the provider path is an explicit fail-closed external reference",
  );
  const requiredDisabled = [
    "tool-bash",
    "tool-jobs",
    "tool-pwsh",
    "tool-ralph",
    "tool-subagent",
    "tool-subagent-control",
    "tool-subagent-fork",
    "tool-subagent-list-agents",
    "tool-subagent-report",
    "tool-workflow",
    "workflow-worker-thread",
    "code-runtime",
  ];
  assert.deepEqual(
    [...disabled.keys()].sort(),
    [...requiredDisabled].sort(),
    "every model-facing bypass row is disabled with a full-row restatement",
  );
  assert.equal(disabled.get("tool-bash"), "@deepseek-ai/dsh-tool-bash");
  assert.equal(disabled.get("tool-jobs"), "@deepseek-ai/dsh-tool-jobs");
  assert.equal(disabled.get("tool-subagent"), "@deepseek-ai/dsh-tool-subagent");
  assert.equal(disabled.get("tool-subagent-report"), "@deepseek-ai/dsh-tool-subagent-report");
  assert.equal(disabled.get("workflow-worker-thread"), "@deepseek-ai/dsh-workflow-worker-thread");
  assert.equal(disabled.get("tool-ralph"), "@deepseek-ai/dsh-tool-ralph");
  assert.equal(disabled.get("code-runtime"), "@deepseek-ai/dsh-code-runtime-worker-thread");
  assert.equal(entries.filter((e) => e.insert).length, 0, "the common overlay mounts nothing");
  const session = entries.find((e) => e.id === "session-persistence-jsonl");
  assert.ok(session && session.disabled === undefined, "the session override is config-only");
  assert.equal(session.config.compression, "none", "raw JSONL transcripts for the offline analyzer");
  assert.equal(session.config.packChunks, false, "one event per line");
  assert.deepEqual(
    session.config.root,
    { js: "dshHomePath('sessions')" },
    "a config override must restate the persistence backend's required isolated root",
  );
});

test("arm A keeps only the native file family and mounts no bridge", () => {
  const entries = readOverlay("A");
  assert.deepEqual(entries, [], "arm A is the untouched native composition");
});

test("arm B replaces the native file family with the exact fs profile and cannot fall back", () => {
  const entries = readOverlay("B");
  const disabled = disabledRows(entries);
  assert.deepEqual(
    [...disabled.keys()].sort(),
    ["tool-fs", "tool-fs-search", "tool-str-replace-editor"],
    "arm B disables the complete native file family",
  );
  assert.equal(disabled.get("tool-fs"), "@deepseek-ai/dsh-tool-fs");
  assert.equal(disabled.get("tool-fs-search"), "@deepseek-ai/dsh-tool-fs-search");
  assert.equal(disabled.get("tool-str-replace-editor"), "@deepseek-ai/dsh-tool-str-replace-editor");
  const row = assertXuanlingFsBridge(entries, "B");
  assert.ok(!row.config.args.includes("memory"), "arm B never mounts the memory tool profile");
});

test("arm C keeps both families side by side", () => {
  const entries = readOverlay("C");
  assert.equal(disabledRows(entries).size, 0, "arm C disables no native rows");
  assertXuanlingFsBridge(entries, "C");
});

test("the live runner refuses to start without --allow-billable-live", () => {
  const runner = mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner");
  const started = Date.now();
  const refused = spawnSync(process.execPath, [runner, "--arms", "A"], { encoding: "utf8", timeout: 30000 });
  const elapsed = Date.now() - started;
  assert.notEqual(refused.status, 0, "refusal exits nonzero");
  assert.match(
    `${refused.stdout}${refused.stderr}`,
    /--allow-billable-live/,
    "the refusal names the required explicit flag",
  );
  assert.ok(elapsed < 15000, `refusal happens before any model or network work (${elapsed}ms)`);
});

test("the dry-run rejects invalid trial counts instead of planning zero work", () => {
  const runner = mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner");
  const fakeDsh = mkdtempSync(path.join(tmpdir(), "xuanling-w4-fake-dsh-"));
  mkdirSync(path.join(fakeDsh, "node_modules", ".bin"), { recursive: true });
  mkdirSync(path.join(fakeDsh, "apps", "cli", "src"), { recursive: true });
  writeFileSync(path.join(fakeDsh, "node_modules", ".bin", "tsx"), "");
  writeFileSync(path.join(fakeDsh, "apps", "cli", "src", "bin.ts"), "");
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--dry-run",
      "--dsh-root", fakeDsh,
      "--binary", process.execPath,
      "--arms", "A",
      "--quality-runs", "not-a-number",
      "--cache-pairs", "0",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.problems.some((problem) => problem.includes("--quality-runs")), "the count error is explicit");
});

test("credential file mode reaches each isolated child without reading or copying the secret", () => {
  const runner = mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner");
  const fakeDsh = fakeEvaluationDsh();
  const credentialDir = mkdtempSync(path.join(tmpdir(), "xuanling-rfc2-credential-"));
  const credential = path.join(credentialDir, ".credentials.yaml");
  writeFileSync(credential, "SYNTHETIC_ONLY: not-a-provider-key\n", { mode: 0o600 });
  const runId = `credential-file-${process.pid}-${Date.now()}`;
  const evalRoot = path.join(tmpdir(), `xuanling-dsh-fs-eval.${runId}`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--allow-billable-live",
        "--dsh-root", fakeDsh,
        "--binary", process.execPath,
        "--arms", "A",
        "--quality-runs", "1",
        "--cache-pairs", "0",
        "--credentials-file", credential,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...evaluationChildBaseEnv(), XUANLING_DSH_RUN_ID: runId },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const trialHome = path.join(evalRoot, "quality", "A", "trial-1", "dsh-home");
    assert.equal(
      readFileSync(path.join(trialHome, "credential-source-observed"), "utf8"),
      credential,
      "the child receives only the external credential path",
    );
    assert.equal(existsSync(path.join(trialHome, ".credentials.yaml")), false, "the runner never copies the credential file");
    const meta = JSON.parse(readFileSync(path.join(evalRoot, "quality", "A", "trial-1", "meta.json"), "utf8"));
    assert.equal(meta.credential_source, "file_reference");
    assert.ok(!JSON.stringify(meta).includes("not-a-provider-key"), "metadata contains no credential body");
  } finally {
    rmSync(evalRoot, { recursive: true, force: true });
    rmSync(fakeDsh, { recursive: true, force: true });
    rmSync(credentialDir, { recursive: true, force: true });
  }
});

function assertCredentialFilePreflightRejects({ label, env, mode, pattern }) {
  const runner = mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner");
  const fakeDsh = fakeEvaluationDsh();
  const credentialDir = mkdtempSync(path.join(tmpdir(), `xuanling-rfc2-credential-${label}-`));
  const credential = path.join(credentialDir, ".credentials.yaml");
  writeFileSync(credential, "SYNTHETIC_ONLY: not-a-provider-key\n", { mode });
  const runId = `credential-deny-${label}-${process.pid}-${Date.now()}`;
  const evalRoot = path.join(tmpdir(), `xuanling-dsh-fs-eval.${runId}`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--allow-billable-live",
        "--dsh-root", fakeDsh,
        "--binary", process.execPath,
        "--arms", "A",
        "--quality-runs", "1",
        "--cache-pairs", "0",
        "--credentials-file", credential,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...env, XUANLING_DSH_RUN_ID: runId },
      },
    );
    assert.notEqual(result.status, 0, `${label} must fail before child startup`);
    assert.match(`${result.stdout}${result.stderr}`, pattern, label);
    assert.equal(
      existsSync(path.join(evalRoot, "quality", "A", "trial-1", "dsh-home", "credential-source-observed")),
      false,
      `${label}: child never starts`,
    );
  } finally {
    rmSync(evalRoot, { recursive: true, force: true });
    rmSync(fakeDsh, { recursive: true, force: true });
    rmSync(credentialDir, { recursive: true, force: true });
  }
}

test("credential file preflight rejects an ambiguous environment source before child startup", () => {
  assertCredentialFilePreflightRejects({
    label: "ambiguous",
    env: { ...evaluationChildBaseEnv(), DEEPSEEK_API_KEY: "synthetic-env-only" },
    mode: 0o600,
    pattern: /exactly one credential source|ambiguous/i,
  });
});

test("credential file preflight rejects a non-owner-only source before child startup", () => {
  assertCredentialFilePreflightRejects({
    label: "non-owner-only",
    env: evaluationChildBaseEnv(),
    mode: 0o644,
    pattern: /owner-only|0600|permission/i,
  });
});

test("the live runner collects synthetic sessions and snapshots each cache state", () => {
  const runner = mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner");
  const fakeDsh = mkdtempSync(path.join(tmpdir(), "xuanling-w4-live-fake-dsh-"));
  const fakeTsx = path.join(fakeDsh, "node_modules", ".bin", "tsx");
  const fakeCli = path.join(fakeDsh, "apps", "cli", "src", "bin.ts");
  mkdirSync(path.dirname(fakeTsx), { recursive: true });
  mkdirSync(path.dirname(fakeCli), { recursive: true });
  writeFileSync(fakeCli, "");
  writeFileSync(fakeTsx, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const bundle = path.join(process.env.DSH_HOME, 'profiles', 'headless', 'node_modules', '@xuanling-rs', 'xuanling-dsh-skills');",
    "for (const relative of ['package.json', 'strict-overwrite-policy.mjs', 'skills/xuanling-file-workflow/SKILL.md']) {",
    "  if (!fs.existsSync(path.join(bundle, relative))) {",
    "    console.error(`missing profile-local XuanLing bundle file: ${relative}`);",
    "    process.exit(7);",
    "  }",
    "}",
    "const dir = path.join(process.env.DSH_HOME, 'sessions', 'synthetic');",
    "fs.mkdirSync(dir, { recursive: true });",
    "const header = { type: 'session', version: 0, id: 'synthetic', createdAt: 0, cwd: fs.realpathSync(process.env.XUANLING_TEST_WORKSPACE_ROOT), delegationDepth: 0 };",
    "fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify(header) + '\\n');",
    "console.log('synthetic stdout');",
    "console.error('synthetic stderr');",
  ].join("\n"));
  chmodSync(fakeTsx, 0o755);

  const runId = `synthetic-${process.pid}-${Date.now()}`;
  const evalRoot = path.join(tmpdir(), `xuanling-dsh-fs-eval.${runId}`);
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--allow-billable-live",
        "--dsh-root", fakeDsh,
        "--binary", process.execPath,
        "--arms", "A",
        "--quality-runs", "1",
        "--cache-pairs", "1",
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...env, DEEPSEEK_API_KEY: "synthetic-only", XUANLING_DSH_RUN_ID: runId },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const summary = JSON.parse(readFileSync(path.join(evalRoot, "run-summary.json"), "utf8"));
    assert.equal(summary.trials.length, 3);
    assert.ok(summary.trials.every((trial) => trial.session_log_count === 1));
    assert.ok(summary.trials.every((trial) => trial.incomplete === false));
    assert.ok(existsSync(path.join(evalRoot, "quality", "A", "trial-1", "session.jsonl")));
    for (const trialHome of [
      path.join(evalRoot, "quality", "A", "trial-1", "dsh-home"),
      path.join(evalRoot, "cache", "A", "pair-1", "cold", "dsh-home"),
      path.join(evalRoot, "cache", "A", "pair-1", "warm", "dsh-home"),
    ]) {
      const installed = path.join(trialHome, "profiles", "headless", "node_modules", "@xuanling-rs", "xuanling-dsh-skills");
      assert.ok(existsSync(path.join(installed, "package.json")), "each fresh profile installs the bundle package");
      assert.ok(existsSync(path.join(installed, "strict-overwrite-policy.mjs")), "each fresh profile installs the policy module");
      assert.ok(existsSync(path.join(installed, "skills", "xuanling-file-workflow", "SKILL.md")), "each fresh profile installs the file Skill");
    }
    assert.equal(readFileSync(path.join(evalRoot, "quality", "A", "trial-1", "stdout.log"), "utf8"), "synthetic stdout\n");
    assert.equal(readFileSync(path.join(evalRoot, "quality", "A", "trial-1", "stderr.log"), "utf8"), "synthetic stderr\n");
    for (const kind of ["cold", "warm"]) {
      const trialDir = path.join(evalRoot, "cache", "A", "pair-1", kind);
      assert.ok(existsSync(path.join(trialDir, "workspace-snapshot")), `${kind} cache state is retained for batch oracle review`);
      assert.equal(
        JSON.parse(readFileSync(path.join(trialDir, "meta.json"), "utf8")).workspace_snapshot,
        path.join(trialDir, "workspace-snapshot"),
        `${kind} meta records the immutable cache-state snapshot`,
      );
    }
  } finally {
    rmSync(evalRoot, { recursive: true, force: true });
    rmSync(fakeDsh, { recursive: true, force: true });
  }
});

test("the analyzer reports unknown usage instead of filling zeros", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  const dir = mkdtempSync(path.join(tmpdir(), "xuanling-w1-analyzer-"));
  const sessionLog = path.join(dir, "session.jsonl");
  writeFileSync(sessionLog, `${JSON.stringify({ type: "session.end", arm: "A" })}\n`);
  const analyzed = spawnSync(
    process.execPath,
    [analyzer, "--root", dir],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 0, `${analyzed.stdout}${analyzed.stderr}`);
  const report = JSON.parse(analyzed.stdout);
  assert.equal(report.trials[0]?.usage, "unknown", "missing provider usage stays unknown, never zero");
});

test("the analyzer folds canonical usage by turn/step and counts actual calls only", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-fold-"));
  const trial = path.join(root, "quality", "A", "trial-1");
  mkdirSync(trial, { recursive: true });
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 };
  const events = [
    { type: "session", cwd: "/tmp/frozen-workspace" },
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    { type: "user/message", seq: 1, data: { role: "user", source: { kind: "direct" }, content: [{ type: "text", text: "frozen task" }] } },
    { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
    {
      type: "request/header",
      seq: 3,
      data: {
        reason: "initial",
        header: {
          config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
          // Catalog names are available tools, not calls. The old recursive
          // scanner incorrectly counted both of these as executed.
          tools: [{ name: "bash" }, { name: "mcp__xuanling__fs_read_text" }],
        },
      },
    },
    { type: "assistant/chunk", seq: 4, data: { turn: 1, step: 1, chunk: { type: "usage", usage } } },
    { type: "assistant/message", seq: 5, data: { turn: 1, step: 1, message: {}, usage } },
    { type: "tool/call", seq: 6, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" } },
    { type: "tool/call", seq: 7, data: { turn: 1, step: 1, callId: "c2", name: "todo_write", arguments: "{}" } },
    { type: "tool/result", surfaceOp: "append", seq: 8, data: { turn: 1, step: 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "read" }], isError: false }] } } },
    { type: "tool/result", surfaceOp: "append", seq: 9, data: { turn: 1, step: 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "todo" }], isError: false }] } } },
    { type: "step/end", seq: 10, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 11, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);

  const analyzed = spawnSync(
    process.execPath,
    [analyzer, "--root", root, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 0, `${analyzed.stdout}${analyzed.stderr}`);
  const report = JSON.parse(analyzed.stdout);
  assert.equal(report.analyzer_version, 8);
  assert.deepEqual(report.trials[0].usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
  }, "chunk + finalized message replace one step sample; optional cache write defaults to zero");
  assert.equal(report.trials[0].tool_calls.native_fs, 1, "only the actual tool/call is counted");
  assert.equal(report.trials[0].tool_calls.control, 1, "log-only todo state is measured but is not a file-family bypass");
  assert.equal(report.arms.A.tool_calls.control, 1, "control calls are preserved in the arm aggregate");
  assert.equal(report.trials[0].tool_calls.shell, 0, "request-header catalog names are not calls");
  assert.deepEqual(report.trials[0].route_problems, []);
  assert.equal(report.trials[0].complete, true);
});

test("analyzer v8 pairs tool results and reports bytes, typed errors, and retry-after-error", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-rfc2-analyzer-v8-"));
  const trial = path.join(root, "quality", "C", "trial-1");
  mkdirSync(trial, { recursive: true });
  const errorText = "[XUANLING_FS_OVERWRITE_REQUIRES_SHA256] expected_sha256 required";
  const results = [
    [{ type: "text", text: errorText }],
    [{ type: "text", text: "current bytes" }],
    [{ type: "text", text: "write complete" }],
  ];
  const calls = [
    { id: "write-1", name: "mcp__xuanling__fs_write_text", result: results[0], isError: true },
    { id: "read-1", name: "read", result: results[1], isError: false },
    { id: "write-2", name: "mcp__xuanling__fs_write_text", result: results[2], isError: false },
  ];
  const events = [{ type: "session", cwd: "/tmp/frozen-workspace" }];
  let seq = 0;
  events.push({ type: "turn/start", seq: seq++, data: { turn: 1 } });
  events.push({
    type: "user/message",
    seq: seq++,
    data: { role: "user", source: { kind: "direct" }, content: [{ type: "text", text: "frozen task" }] },
  });
  for (const [index, call] of calls.entries()) {
    const step = index + 1;
    events.push({ type: "step/start", seq: seq++, data: { turn: 1, step } });
    events.push({
      type: "request/header",
      seq: seq++,
      data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" }, system: "frozen", tools: [] } },
    });
    events.push({
      type: "assistant/message",
      seq: seq++,
      data: { turn: 1, step, message: {}, usage: { inputTokens: 10, outputTokens: 2 } },
    });
    events.push({ type: "tool/call", seq: seq++, data: { turn: 1, step, callId: call.id, name: call.name, arguments: "{}" } });
    events.push({
      type: "tool/result",
      surfaceOp: "append",
      seq: seq++,
      data: {
        turn: 1,
        step,
        message: {
          role: "user",
          content: [{ type: "tool-result", toolCallId: call.id, content: call.result, isError: call.isError }],
        },
      },
    });
    events.push({ type: "step/end", seq: seq++, data: { turn: 1, step } });
  }
  events.push({ type: "turn/end", seq: seq++, data: { turn: 1, reason: { kind: "completed" } } });
  writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);

  const analyzed = spawnSync(
    process.execPath,
    [analyzer, "--root", root, "--verify", "--arms", "C", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 0, `${analyzed.stdout}${analyzed.stderr}`);
  const report = JSON.parse(analyzed.stdout);
  const expectedBytes = results.reduce((sum, content) => sum + Buffer.byteLength(JSON.stringify(content)), 0);
  assert.equal(report.analyzer_version, 8);
  assert.deepEqual(report.trials[0].tool_results, {
    count: 3,
    model_visible_bytes: expectedBytes,
    error_count: 1,
    retry_after_error_count: 1,
    error_codes: { XUANLING_FS_OVERWRITE_REQUIRES_SHA256: 1 },
    by_family: {
      xuanling_fs: {
        count: 2,
        model_visible_bytes: Buffer.byteLength(JSON.stringify(results[0])) + Buffer.byteLength(JSON.stringify(results[2])),
        error_count: 1,
        retry_after_error_count: 1,
      },
      native_fs: {
        count: 1,
        model_visible_bytes: Buffer.byteLength(JSON.stringify(results[1])),
        error_count: 0,
        retry_after_error_count: 0,
      },
    },
  });
  assert.deepEqual(report.arms.C.tool_results, report.trials[0].tool_results);
});

test("analyzer v8 extracts a typed JSON code from a prefixed text result", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-rfc2-analyzer-text-json-code-"));
  const trial = path.join(root, "quality", "C", "trial-1");
  mkdirSync(trial, { recursive: true });
  const resultText = [
    "Error: not_found: No such file or directory",
    JSON.stringify({ code: "not_found", message: "No such file or directory" }),
  ].join("\n");
  const events = [
    { type: "session", cwd: "/tmp/frozen-workspace" },
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    { type: "user/message", seq: 1, data: { role: "user", source: { kind: "direct" }, content: [{ type: "text", text: "frozen task" }] } },
    { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
    { type: "request/header", seq: 3, data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" }, system: "frozen", tools: [] } } },
    { type: "assistant/message", seq: 4, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 2 } } },
    { type: "tool/call", seq: 5, data: { turn: 1, step: 1, callId: "stat-1", name: "mcp__xuanling__fs_stat", arguments: JSON.stringify({ path: "RELEASE.md" }) } },
    {
      type: "tool/result",
      surfaceOp: "append",
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: "stat-1",
            content: [{ type: "text", text: resultText }],
            isError: true,
          }],
        },
      },
    },
    { type: "step/end", seq: 7, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 8, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);

  const analyzed = spawnSync(
    process.execPath,
    [analyzer, "--root", root, "--verify", "--arms", "C", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 0, `${analyzed.stdout}${analyzed.stderr}`);
  const report = JSON.parse(analyzed.stdout);
  assert.deepEqual(report.trials[0].tool_results.error_codes, { not_found: 1 });
  assert.equal(report.trials[0].tool_results.retry_after_error_count, 0);
});

test("analyzer v8 rejects orphan and duplicate canonical tool results", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  for (const kind of ["orphan", "duplicate"]) {
    const root = mkdtempSync(path.join(tmpdir(), `xuanling-rfc2-analyzer-${kind}-`));
    const trial = path.join(root, "quality", "A", "trial-1");
    mkdirSync(trial, { recursive: true });
    const events = [
      { type: "session", cwd: "/tmp/frozen-workspace" },
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      { type: "user/message", seq: 1, data: { role: "user", source: { kind: "direct" }, content: [{ type: "text", text: "frozen task" }] } },
      { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
      { type: "request/header", seq: 3, data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" }, system: "frozen", tools: [] } } },
      { type: "assistant/message", seq: 4, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } } },
      ...(kind === "duplicate" ? [{ type: "tool/call", seq: 5, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" } }] : []),
    ];
    let seq = Math.max(...events.map((event) => event.seq ?? -1)) + 1;
    const resultEvent = (toolCallId) => ({
      type: "tool/result",
      surfaceOp: "append",
      seq: seq++,
      data: { turn: 1, step: 1, message: { role: "user", content: [{ type: "tool-result", toolCallId, content: [{ type: "text", text: "result" }], isError: false }] } },
    });
    events.push(resultEvent(kind === "orphan" ? "ghost" : "c1"));
    if (kind === "duplicate") events.push(resultEvent("c1"));
    events.push({ type: "step/end", seq: seq++, data: { turn: 1, step: 1 } });
    events.push({ type: "turn/end", seq: seq++, data: { turn: 1, reason: { kind: "completed" } } });
    writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);
    const analyzed = spawnSync(
      process.execPath,
      [analyzer, "--root", root, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
      { encoding: "utf8" },
    );
    assert.notEqual(analyzed.status, 0, `${kind} result must make the trial incomplete`);
    assert.match(
      `${analyzed.stdout}${analyzed.stderr}`,
      kind === "orphan" ? /orphan tool\/result.*ghost/i : /duplicate tool\/result.*c1/i,
      `${kind} must fail for the call/result relation itself`,
    );
  }
});

test("the analyzer rejects a seq gap and an unclosed step even when turn/end remains", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-gap-"));
  const trial = path.join(root, "quality", "A", "trial-1");
  mkdirSync(trial, { recursive: true });
  const events = [
    { type: "session", cwd: "/tmp/frozen-workspace" },
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    { type: "step/start", seq: 1, data: { turn: 1, step: 1 } },
    {
      type: "request/header",
      seq: 2,
      data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" } } },
    },
    { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } } },
    // seq 4 step/end is deliberately absent; a tail turn/end alone must not
    // turn the damaged raw artifact into complete evidence.
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  writeFileSync(path.join(trial, "session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(path.join(trial, "verdict.json"), `${JSON.stringify({ pass: true, failures: [] })}\n`);

  const analyzed = spawnSync(
    process.execPath,
    [analyzer, "--root", root, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 1, `${analyzed.stdout}${analyzed.stderr}`);
  const report = JSON.parse(analyzed.stdout);
  assert.equal(report.trials[0].complete, false);
  assert.ok(report.trials[0].lifecycle_problems.some((problem) => problem.includes("event seq expected 4")));
  assert.ok(report.trials[0].lifecycle_problems.some((problem) => problem.includes("unmatched turn/end")));
});

test("the analyzer rejects partial or conflicting canonical usage", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");

  const partialRoot = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-partial-"));
  writeAnalyzerTrial(partialRoot, "quality/A/trial-1", {
    usages: [{ inputTokens: 10, outputTokens: 2 }, null],
  });
  const partial = spawnSync(
    process.execPath,
    [analyzer, "--root", partialRoot, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(partial.status, 1, `${partial.stdout}${partial.stderr}`);
  const partialReport = JSON.parse(partial.stdout);
  assert.equal(partialReport.trials[0].usage, "unknown", "one accounted step cannot make the whole trial's usage known");
  assert.equal(partialReport.trials[0].usage_missing_steps, 1);

  const conflictRoot = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-conflict-"));
  writeAnalyzerTrial(conflictRoot, "quality/A/trial-1", {
    usages: [{ inputTokens: 10, outputTokens: 2 }],
    duplicateUsage: { inputTokens: 11, outputTokens: 2 },
  });
  const conflict = spawnSync(
    process.execPath,
    [analyzer, "--root", conflictRoot, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(conflict.status, 1, `${conflict.stdout}${conflict.stderr}`);
  const conflictReport = JSON.parse(conflict.stdout);
  assert.equal(conflictReport.trials[0].usage, "unknown", "conflicting samples for one call are not last-write-wins accounting");
  assert.equal(conflictReport.trials[0].usage_conflicting_steps, 1);
});

test("the analyzer rejects stale extra trials and mismatched cold/warm model-facing prefixes", () => {
  const analyzer = mustExist(path.join(evaluationRoot, "scripts", "analyze-filesystem-evaluation.mjs"), "session analyzer");

  const extraRoot = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-extra-"));
  writeAnalyzerTrial(extraRoot, "quality/A/trial-1");
  writeAnalyzerTrial(extraRoot, "quality/A/trial-2");
  const extra = spawnSync(
    process.execPath,
    [analyzer, "--root", extraRoot, "--verify", "--arms", "A", "--quality-runs", "1", "--cache-pairs", "0"],
    { encoding: "utf8" },
  );
  assert.equal(extra.status, 1, `${extra.stdout}${extra.stderr}`);
  assert.match(extra.stderr, /unexpected trial quality\/A\/trial-2/);

  const identityOnlyRoot = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-prefix-identity-"));
  writeAnalyzerTrial(identityOnlyRoot, "cache/A/pair-1/cold", { initialMessageId: "cold-generated-id" });
  writeAnalyzerTrial(identityOnlyRoot, "cache/A/pair-1/warm", { initialMessageId: "warm-generated-id" });
  const identityOnly = spawnSync(
    process.execPath,
    [analyzer, "--root", identityOnlyRoot, "--verify", "--arms", "A", "--quality-runs", "0", "--cache-pairs", "1"],
    { encoding: "utf8" },
  );
  assert.equal(
    identityOnly.status,
    0,
    "generated user-message identities are persistence metadata, not DeepSeek request-prefix content",
  );

  const pairRoot = mkdtempSync(path.join(tmpdir(), "xuanling-w4-analyzer-prefix-"));
  writeAnalyzerTrial(pairRoot, "cache/A/pair-1/cold", { userText: "cold model-facing content" });
  writeAnalyzerTrial(pairRoot, "cache/A/pair-1/warm", { userText: "warm model-facing content" });
  const pair = spawnSync(
    process.execPath,
    [analyzer, "--root", pairRoot, "--verify", "--arms", "A", "--quality-runs", "0", "--cache-pairs", "1"],
    { encoding: "utf8" },
  );
  assert.equal(pair.status, 1, `${pair.stdout}${pair.stderr}`);
  assert.match(pair.stderr, /cold\/warm request prefix mismatch/);
});

test("catalog inspection, direct probes, and the oracle batch runner exist", () => {
  mustExist(path.join(evaluationRoot, "scripts", "inspect-catalog.ts"), "catalog inspector");
  mustExist(path.join(evaluationRoot, "scripts", "probe-filesystem-tools.ts"), "direct probe harness");
  mustExist(path.join(evaluationRoot, "scripts", "verify-filesystem-fixture.mjs"), "oracle batch runner");
  mustExist(path.join(evaluationRoot, "scripts", "create-fixture.mjs"), "fixture generator");
});

test("the direct probe validates canonical pagination payloads and counts teardown", () => {
  const probePath = mustExist(path.join(evaluationRoot, "scripts", "probe-filesystem-tools.ts"), "direct probe harness");
  const source = readFileSync(probePath, "utf8");
  assert.ok(!/entries\?\s*:\s*unknown\[\]/.test(source), "fs_glob must not parse the fs_list-only entries field");
  assert.match(source, /arrayField\(frame\.structured, 'matches'\)/, "pagination reads the canonical matches array");
  assert.match(source, /'15,15,10'/, "pagination proves all three pages rather than cursor presence only");
  const teardownRecord = source.indexOf("'teardown leaves no residue'");
  const counts = source.lastIndexOf("const counts = {");
  assert.ok(teardownRecord !== -1 && counts > teardownRecord, "counts are frozen only after teardown is recorded");
  assert.match(source, /counts\.observed !== counts\.total/, "exit fails unless every recorded probe is observed");
  assert.match(source, /'--memory-db', path\.join\(workspace, 'memory\.db'\)/, "the probe never opens the default Memory DB");
  assert.ok(!source.includes("Number(testsMatch[1]) === 129"), "native evidence is not inferred from an aggregate suite count");
  assert.match(source, /testNames\.every\(\(name\) => output\.includes\(name\)\)/, "both native contracts must be observed by name");
});

test("evaluation launchers isolate the store that the fs-profile server still opens", () => {
  const settings = readFileSync(
    mustExist(path.join(evaluationRoot, "config", "settings.template.yaml"), "isolated settings template"),
    "utf8",
  );
  assert.match(
    settings,
    /agent-default-model:\s*\n\s+provider: deepseek-official\s*\n\s+model: deepseek-v4-pro\s*\n\s+reasoningEffort: max/,
    "the frozen route uses DSH's registered agent-default-model settings namespace",
  );
  assert.doesNotMatch(settings, /^provider:/m, "unsupported top-level route keys cannot silently fall back to the base model");

  const runner = readFileSync(
    mustExist(path.join(evaluationRoot, "scripts", "run-filesystem-evaluation.mjs"), "live runner"),
    "utf8",
  );
  assert.match(
    runner,
    /XUANLING_TEST_MEMORY_DB:\s*path\.join\(trial\.dir, "memory\.db"\)/,
    "every model trial gets an evidence-local Memory DB",
  );
  assert.match(
    runner,
    /path\.join\(trial\.dshHome, "profiles", "headless", "node_modules", "@xuanling-rs", "xuanling-dsh-skills", "skills"\)/,
    "the child resolves Skills from the profile-local bundle",
  );
  assert.match(runner, /function installSkillsBundle\(/, "profile bundle installation is an explicit runner step");
  assert.match(runner, /skills_bundle_sha256/, "trial metadata records the installed bundle fingerprint");
  assert.match(runner, /env_names: \[[^\]]*"XUANLING_TEST_MEMORY_DB"/s, "the dry-run declares the isolation env name");
  assert.match(runner, /const \[program, \.\.\.args\] = dshArgv\(trial\)/, "live execution splits the exact dry-run argv");
  assert.match(runner, /spawn\(program, args, \{/, "tsx is the executable rather than JavaScript input to node");
  assert.doesNotMatch(runner, /spawn\(process\.execPath, dshArgv\(trial\)/, "live execution must not prepend an unreported node process");

  const inspector = readFileSync(
    mustExist(path.join(evaluationRoot, "scripts", "inspect-catalog.ts"), "catalog inspector"),
    "utf8",
  );
  assert.match(inspector, /'--memory-db', path\.join\(workspace, 'memory\.db'\)/, "catalog inspection uses its temp workspace DB");
  assert.match(inspector, /rmSync\(workspace, \{ recursive: true, force: true \}\)/, "catalog inspection removes the temp workspace");
  assert.match(inspector, /node_modules', '\.bin', 'tsx'/, "catalog dump bypasses pnpm's noisy stdout wrapper");
  assert.match(inspector, /name:\s*'memory_search'/, "hidden dispatch probes the raw server tool name");
  assert.doesNotMatch(
    inspector,
    /name:\s*'mcp__xuanling__memory_search'/,
    "a DSH-mounted name would be rejected before the fs-profile dispatch boundary is exercised",
  );
  assert.doesNotMatch(inspector, /\.\.\.process\.env/, "catalog subprocesses do not inherit unrelated credentials");

  const probe = readFileSync(
    mustExist(path.join(evaluationRoot, "scripts", "probe-filesystem-tools.ts"), "direct probe harness"),
    "utf8",
  );
  assert.doesNotMatch(probe, /\.\.\.process\.env/, "direct-probe subprocesses do not inherit unrelated credentials");
  assert.match(probe, /nonSecretChildEnv\(\{ NO_COLOR: '1', CI: '1' \}\)/, "native contract tests receive only the explicit safe environment");
});

test("the bridge verifier checks the fs profile's exact 16-tool catalog", () => {
  const verifierPath = path.join(testRoot, "scripts", "verify-deepseek-bridge.mjs");
  const verifier = readFileSync(mustExist(verifierPath, "bridge verifier"), "utf8");
  assert.ok(
    verifier.includes("EXACT_FS_PROFILE_TOOLS"),
    "the verifier carries an exact-16 fs profile tool set",
  );
  assert.ok(verifier.includes('args["tool-profile"]'), "the verifier still accepts canonical profiles");
});

test("the snapshot still pins the fs profile catalog the overlays depend on", () => {
  const catalog = JSON.parse(
    readFileSync(path.join(repoRoot, "crates", "xuanling-mcp", "tests", "snapshots", "tools-list.json"), "utf8"),
  );
  assert.equal(catalog.filter((tool) => tool.name.startsWith("fs_")).length, fsProfileCount);
});

test("the report verifier fails closed without a v1 evidence manifest", () => {
  const verifier = mustExist(
    path.join(evaluationRoot, "scripts", "verify-report.mjs"),
    "filesystem evaluation report verifier",
  );
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-w6-report-root-"));
  const report = path.join(root, "report.md");
  writeFileSync(report, "# Incomplete report\n");

  const result = spawnSync(process.execPath, [verifier, report, root], { encoding: "utf8" });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /evidence manifest/i);
});

test("the report verifier scopes the W5 oracle to analyzer trials, not later Web workspaces", () => {
  const verifier = readFileSync(
    mustExist(path.join(evaluationRoot, "scripts", "verify-report.mjs"), "filesystem evaluation report verifier"),
    "utf8",
  );
  assert.match(verifier, /--workspace/, "the verifier independently judges each analyzer-selected workspace");
  assert.doesNotMatch(
    verifier,
    /fixtureVerifierPath, \["--all", root\]/,
    "a W6 web/ subtree must not become a sixteenth W5 fixture verdict",
  );
});

test("the current-policy report verifier rejects the historical pre-policy manifest", () => {
  const verifier = mustExist(
    path.join(evaluationRoot, "scripts", "verify-stage2-report.mjs"),
    "current-policy report verifier",
  );
  const historicalReport = mustExist(path.join(evaluationRoot, "filesystem-tools-report.md"), "historical report");
  const historicalRoot = "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725";
  const verified = spawnSync(process.execPath, [verifier, historicalReport, historicalRoot], { encoding: "utf8" });
  assert.notEqual(verified.status, 0, "a pre-policy v1 manifest cannot satisfy current Stage 2 freshness");
  assert.match(`${verified.stdout}${verified.stderr}`, /current-policy|stage 2|policy hash|schema/i);
});

test("the current-policy report verifier recomputes a v2 corpus and rejects a policy-hash mutation", () => {
  const verifier = mustExist(
    path.join(evaluationRoot, "scripts", "verify-stage2-report.mjs"),
    "current-policy report verifier",
  );
  const root = mkdtempSync(path.join(tmpdir(), "xuanling-stage2-report-v2-"));
  const report = path.join(root, "report.md");
  const fixtureManifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const hashes = {
    skills: "a".repeat(64),
    policy: "b".repeat(64),
    common: "c".repeat(64),
    arms: { A: "d".repeat(64), B: "e".repeat(64), C: "f".repeat(64) },
  };
  const trials = [];
  try {
    for (const arm of ["A", "B", "C"]) {
      const labels = [
        ...[1, 2, 3].map((index) => `quality/${arm}/trial-${index}`),
        `cache/${arm}/pair-1/cold`,
        `cache/${arm}/pair-1/warm`,
      ];
      for (const [index, label] of labels.entries()) {
        writeAnalyzerTrial(root, label, {
          usages: [{
            inputTokens: 100 + index,
            outputTokens: 20 + index,
            cacheReadTokens: 30 + index,
            cacheWriteTokens: index,
          }],
        });
        const trial = path.join(root, ...label.split("/"));
        const workspace = path.join(trial, label.startsWith("cache/") ? "workspace-snapshot" : "workspace");
        copyFixtureFiles(workspace);
        const applied = spawnSync("patch", ["-p1", "--silent", "-i", path.join(fixtureRoot, "solved.patch")], {
          cwd: workspace,
          encoding: "utf8",
        });
        assert.equal(applied.status, 0, `${label}: ${applied.stdout}${applied.stderr}`);
        writeFileSync(path.join(trial, "meta.json"), `${JSON.stringify({
          label,
          incomplete: false,
          duration_ms: 1000 + index,
          secret_redactions: 0,
          secret_scan_mode: "credential_shape",
          credential_source: "file_reference",
          evaluation_schema: "xuanling-dsh-filesystem-safety-stage2/v2",
          task_sha256: fixtureManifest.task_sha256,
          skills_bundle_sha256: hashes.skills,
          strict_overwrite_policy_sha256: hashes.policy,
          common_patch_sha256: hashes.common,
          arm_patch_sha256: hashes.arms[arm],
        }, null, 2)}\n`);
        trials.push({
          label,
          incomplete: false,
          exit: { code: 0, signal: null, spawnError: null },
          oracle_pass: true,
        });
      }
    }
    writeFileSync(path.join(root, "run-summary.json"), `${JSON.stringify({
      evaluation_schema: "xuanling-dsh-filesystem-safety-stage2/v2",
      credential_source: "file_reference",
      strict_overwrite_policy_sha256: hashes.policy,
      trials,
    }, null, 2)}\n`);
    const derivedResult = spawnSync(process.execPath, [verifier, "--derive", root], { encoding: "utf8" });
    assert.equal(derivedResult.status, 0, `${derivedResult.stdout}${derivedResult.stderr}`);
    const derived = JSON.parse(derivedResult.stdout);
    const decision = {
      ...derived,
      stage3: {
        status: "not_triggered_deferred",
        triggers: {
          multi_host_strict_policy: { status: "not_triggered", evidence: "synthetic host scope" },
          dispatch_bypass: { status: "not_triggered", evidence: "synthetic dispatch probe" },
          fs16_contract_gap: { status: "not_triggered", evidence: "synthetic oracle population" },
        },
      },
      decision: { stage2_status: "accepted", stage3_status: "not_triggered_deferred", production_change: false },
    };
    const writeReport = (manifest) => {
      writeFileSync(report, `# Synthetic current-policy report\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`);
    };
    writeReport(decision);
    const passed = spawnSync(process.execPath, [verifier, report, root], { encoding: "utf8" });
    assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);

    writeReport({ ...decision, policy: { ...decision.policy, skills_bundle_sha256: "0".repeat(64) } });
    const mutated = spawnSync(process.execPath, [verifier, report, root], { encoding: "utf8" });
    assert.notEqual(mutated.status, 0, "a report-side policy hash mutation must fail");
    assert.match(`${mutated.stdout}${mutated.stderr}`, /policy.*current-policy evidence/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
