#!/usr/bin/env node

// Collects the DSH side of the W4.4 Memory dogfooding protocol. This file is
// deliberately a collector: behavioral assertions live in
// verify-memory-dogfooding.mjs so the post-run oracle is independent of the
// process that launched the model.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { seedDatabase } from "../../deepseek-harness/evaluation/memory-retrieval/seed.mjs";
import { snapshotDatabase } from "../../deepseek-harness/evaluation/memory-retrieval/sqlite-oracle.mjs";

const FROZEN_MODEL = "deepseek-official/deepseek-v4-pro";
const FROZEN_EFFORT = "max";
const TRIAL_TIMEOUT_MS = 20 * 60 * 1000;
const TERM_GRACE_MS = 10_000;
const CASES = ["case-1", "case-2", "case-3", "case-4"];
const SKILL_FILES = [
  "package.json",
  "strict-overwrite-policy.mjs",
  "cordis.patch.yml",
  "skills/xuanling-file-workflow/SKILL.md",
  "skills/xuanling-file-workflow/agents/openai.yaml",
  "skills/xuanling-memory-workflow/SKILL.md",
  "skills/xuanling-memory-workflow/agents/openai.yaml",
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  }
  return values;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function canonicalPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function treeManifest(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        visit(child, childRelative);
      } else if (entry.isFile()) {
        const bytes = readFileSync(child);
        entries.push({ path: childRelative, bytes: bytes.length, sha256: sha256Bytes(bytes) });
      } else {
        throw new Error(`workspace contains unsupported entry: ${child}`);
      }
    }
  };
  visit(root);
  const digest = sha256Bytes(JSON.stringify(entries));
  return { sha256: digest, entries };
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function copySkillsBundle(source, dshHome) {
  const destination = path.join(
    dshHome,
    "profiles",
    "headless",
    "node_modules",
    "@xuanling-rs",
    "xuanling-dsh-skills",
  );
  mkdirSync(destination, { recursive: true });
  for (const relative of SKILL_FILES) {
    const sourceFile = path.join(source, relative);
    const targetFile = path.join(destination, relative);
    const sourceStats = lstatSync(sourceFile);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`skill bundle entry must be a regular non-symlink file: ${sourceFile}`);
    }
    mkdirSync(path.dirname(targetFile), { recursive: true });
    cpSync(sourceFile, targetFile, { force: false, errorOnExist: true });
  }
  const sourceHash = sha256Bytes(SKILL_FILES.map((relative) => `${relative}\0${readFileSync(path.join(source, relative)).toString("base64")}\0`).join(""));
  const installedHash = sha256Bytes(SKILL_FILES.map((relative) => `${relative}\0${readFileSync(path.join(destination, relative)).toString("base64")}\0`).join(""));
  if (sourceHash !== installedHash) throw new Error("profile-local skills bundle fingerprint mismatch");
  return { path: destination, sha256: installedHash };
}

function credentialSource() {
  const environmentPresent = typeof process.env.DEEPSEEK_API_KEY === "string"
    && process.env.DEEPSEEK_API_KEY.length > 0;
  const files = argValues("--credentials-file");
  if (files.length > 1) return { problems: ["--credentials-file may be provided once"], source: null };
  const file = files[0];
  const problems = [];
  if (environmentPresent && file !== undefined) {
    problems.push("exactly one credential source is allowed");
  }
  if (file !== undefined) {
    if (!path.isAbsolute(file)) {
      problems.push("--credentials-file must be absolute");
    } else {
      try {
        const stats = lstatSync(file);
        if (stats.isSymbolicLink() || !stats.isFile()) problems.push("--credentials-file must be a regular file");
        else if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
          problems.push(`--credentials-file must be owner-only (mode ${(stats.mode & 0o777).toString(8)})`);
        }
      } catch (error) {
        problems.push(`cannot stat --credentials-file: ${error?.code ?? String(error)}`);
      }
    }
  }
  if (!environmentPresent && file === undefined) problems.push("DEEPSEEK_API_KEY or --credentials-file is required");
  return {
    problems,
    source: environmentPresent ? { kind: "environment" } : { kind: "file_reference", file },
  };
}

const allowBillable = process.argv.includes("--allow-billable-live");
const dryRun = process.argv.includes("--dry-run");
const dshRootArg = argValue("--dsh-root");
const binaryArg = argValue("--binary");
const model = argValue("--model") ?? FROZEN_MODEL;
const reasoningEffort = argValue("--reasoning-effort") ?? FROZEN_EFFORT;
const repetitions = Number(argValue("--repetitions") ?? 1);
const dshRoot = dshRootArg === undefined ? undefined : path.resolve(dshRootArg);
const binary = binaryArg === undefined ? undefined : path.resolve(binaryArg);
const scriptRoot = import.meta.dirname;
const testRoot = path.resolve(scriptRoot, "..", "..");
const repoRoot = path.resolve(testRoot, "..");
const evaluationRoot = path.join(testRoot, "deepseek-harness", "evaluation");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const skillsRoot = path.join(integrationRoot, "xuanling-skills");
const memoryPatch = path.join(scriptRoot, "cordis.patch.yml");
const commonPatch = path.join(evaluationRoot, "overlays", "common", "cordis.patch.yml");
const skillsPatch = path.join(skillsRoot, "cordis.patch.yml");
const settingsTemplate = path.join(evaluationRoot, "config", "settings.template.yaml");
const adapterPath = path.join(integrationRoot, "xuanling-memory", "schema-adapter.mjs");
const taskRoot = path.join(scriptRoot, "tasks");
const fixtureRoot = path.join(scriptRoot, "fixtures");
const runId = process.env.XUANLING_DSH_RUN_ID;
const evaluationRootLive = runId === undefined
  ? undefined
  : path.join(os.tmpdir(), `xuanling-dsh-w4-4.${runId}`);

function dshArgv(task) {
  return [
    path.join(dshRoot, "node_modules", ".bin", "tsx"),
    path.join(dshRoot, "apps", "cli", "src", "bin.ts"),
    "--profile", "headless",
    "--patch", skillsPatch,
    "--patch", commonPatch,
    "--patch", memoryPatch,
    "--", task,
  ];
}

function childEnv(trial, credential) {
  const inherited = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const credentialEnv = credential.kind === "environment"
    ? {
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        XUANLING_DSH_CREDENTIALS_FILE: path.join(trial.dshHome, ".credentials.yaml"),
      }
    : { XUANLING_DSH_CREDENTIALS_FILE: credential.file };
  return {
    ...inherited,
    DSH_HOME: trial.dshHome,
    DSH_PERMISSION_MODE: "workspace-write",
    DSH_TELEMETRY_DISABLED: "1",
    TSX_TSCONFIG_PATH: path.join(dshRoot, "tsconfig.json"),
    XUANLING_DSH_SCHEMA_ADAPTER: adapterPath,
    XUANLING_DSH_SKILLS_ROOT: path.join(
      trial.dshHome,
      "profiles",
      "headless",
      "node_modules",
      "@xuanling-rs",
      "xuanling-dsh-skills",
      "skills",
    ),
    XUANLING_MCP_BIN: binary,
    XUANLING_TEST_MEMORY_DB: trial.database,
    XUANLING_TEST_WORKSPACE_ROOT: trial.workspace,
    ...credentialEnv,
  };
}

function sanitizeOutput(value, credential) {
  if (credential.kind === "environment") {
    const secret = process.env.DEEPSEEK_API_KEY;
    if (typeof secret === "string" && secret.length > 0 && value.includes(secret)) {
      return {
        text: value.split(secret).join("[REDACTED_PROVIDER_CREDENTIAL]"),
        redactions: value.split(secret).length - 1,
      };
    }
  }
  let redactions = 0;
  const text = value.replace(/((?:DEEPSEEK_API_KEY|api[_-]?key|token|secret)\s*[:=]\s*)([^\s,;]+)/gi, (_match, prefix) => {
    redactions += 1;
    return `${prefix}[REDACTED_CREDENTIAL_SHAPED_VALUE]`;
  });
  return { text, redactions };
}

function locateSessions(dshHome) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 8 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile() && entry.name === "session.jsonl") found.push(absolute);
    }
  };
  walk(path.join(dshHome, "sessions"), 0);
  return found.sort();
}

async function terminateGroup(child) {
  if (child.pid === undefined) return;
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
    } catch {
      // The group may already be gone.
    }
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  signal("SIGKILL");
}

async function runTrial(trial, credential) {
  mkdirSync(trial.dir, { recursive: true });
  mkdirSync(trial.workspace, { recursive: true });
  mkdirSync(trial.dshHome, { recursive: true });
  const fixture = path.join(fixtureRoot, trial.caseId);
  if (existsSync(fixture)) copyTree(fixture, trial.workspace);
  const beforeWorkspace = treeManifest(trial.workspace);
  writeFileSync(path.join(trial.dir, "workspace-before.json"), `${JSON.stringify(beforeWorkspace, null, 2)}\n`);
  writeFileSync(path.join(trial.dshHome, "settings.yaml"), readFileSync(settingsTemplate));
  const skills = copySkillsBundle(skillsRoot, trial.dshHome);
  await seedDatabase({ binary, database: trial.database, fixture: { records: [] } });
  const beforeMemory = snapshotDatabase(trial.database);
  writeFileSync(path.join(trial.dir, "memory-before.json"), `${JSON.stringify(beforeMemory, null, 2)}\n`);

  const task = readFileSync(path.join(taskRoot, `${trial.caseId}.md`), "utf8").trimEnd();
  const [program, ...args] = dshArgv(task);
  const startedAt = Date.now();
  const child = spawn(program, args, {
    cwd: trial.workspace,
    detached: true,
    env: childEnv(trial, credential),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => {
    let killTimer = null;
    const timeout = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, TERM_GRACE_MS);
    }, TRIAL_TIMEOUT_MS);
    timeout.unref();
    const settle = (value) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve(value);
    };
    child.once("error", (error) => {
      spawnError = String(error);
      settle({ code: null, signal: null, spawnError });
    });
    child.once("close", (code, signal) => settle({ code, signal, spawnError }));
  });
  await terminateGroup(child);

  const safeStdout = sanitizeOutput(stdout, credential);
  const safeStderr = sanitizeOutput(stderr, credential);
  writeFileSync(path.join(trial.dir, "stdout.log"), safeStdout.text);
  writeFileSync(path.join(trial.dir, "stderr.log"), safeStderr.text);
  const collectionProblems = [];
  if (exit.spawnError !== null) collectionProblems.push(`spawn error: ${exit.spawnError}`);
  if (exit.signal !== null) collectionProblems.push(`child terminated by ${exit.signal}`);
  if (exit.code !== 0 && exit.spawnError === null) collectionProblems.push(`child exited ${exit.code}`);
  const sessions = locateSessions(trial.dshHome);
  if (sessions.length !== 1) collectionProblems.push(`found ${sessions.length} session logs; expected exactly one`);
  if (sessions.length === 1) {
    const target = path.join(trial.dir, "session.jsonl");
    cpSync(sessions[0], target, { force: false, errorOnExist: true });
    try {
      const header = JSON.parse(readFileSync(target, "utf8").split("\n", 1)[0]);
      if (typeof header.cwd !== "string" || canonicalPath(header.cwd) !== canonicalPath(trial.workspace)) {
        collectionProblems.push("session header cwd does not identify this trial workspace");
      }
    } catch {
      collectionProblems.push("session header is not valid JSON");
    }
  }

  let afterMemory = null;
  try {
    afterMemory = snapshotDatabase(trial.database);
    writeFileSync(path.join(trial.dir, "memory-after.json"), `${JSON.stringify(afterMemory, null, 2)}\n`);
  } catch (error) {
    collectionProblems.push(`after Memory oracle failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const afterWorkspace = treeManifest(trial.workspace);
  writeFileSync(path.join(trial.dir, "workspace-after.json"), `${JSON.stringify(afterWorkspace, null, 2)}\n`);
  const redactions = safeStdout.redactions + safeStderr.redactions;
  if (redactions > 0) collectionProblems.push(`child output contained credential material (${redactions} redaction(s))`);
  const meta = {
    evaluation_schema: "xuanling-dsh-w4-4-memory/v1",
    case: trial.caseId,
    repetition: trial.repetition,
    incomplete: collectionProblems.length > 0,
    collection_problems: collectionProblems,
    exit,
    duration_ms: Date.now() - startedAt,
    cwd: trial.workspace,
    memory_db: trial.database,
    credential_source: credential.kind,
    argv: [...dshArgv("<task text from dsh-w4-4/tasks>").slice(0, -1), "<task text>"],
    env_names: Object.keys(childEnv(trial, credential)).sort(),
    hashes: {
      task: sha256File(path.join(taskRoot, `${trial.caseId}.md`)),
      memory_patch: sha256File(memoryPatch),
      common_patch: sha256File(commonPatch),
      skills_patch: sha256File(skillsPatch),
      settings: sha256File(settingsTemplate),
      adapter: sha256File(adapterPath),
      binary: sha256File(binary),
      skills_bundle: skills.sha256,
    },
    workspace_before_sha256: beforeWorkspace.sha256,
    workspace_after_sha256: afterWorkspace.sha256,
    secret_redactions: redactions,
  };
  writeFileSync(path.join(trial.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { case: trial.caseId, repetition: trial.repetition, incomplete: meta.incomplete, collection_problems: collectionProblems, exit };
}

function preflight() {
  const problems = [];
  if (!allowBillable && !dryRun) problems.push("live run requires --allow-billable-live");
  if (model !== FROZEN_MODEL) problems.push(`--model must stay ${FROZEN_MODEL}`);
  if (reasoningEffort !== FROZEN_EFFORT) problems.push(`--reasoning-effort must stay ${FROZEN_EFFORT}`);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    problems.push("--repetitions must be an integer from 1 through 10");
  }
  if (dshRoot === undefined || !existsSync(dshRoot)) {
    problems.push("--dsh-root <deepseek-harness checkout> is required");
  } else {
    for (const file of [
      path.join(dshRoot, "node_modules", ".bin", "tsx"),
      path.join(dshRoot, "apps", "cli", "src", "bin.ts"),
    ]) {
      if (!existsSync(file)) problems.push(`required DSH launcher missing: ${file}`);
    }
  }
  if (binary === undefined || !existsSync(binary)) problems.push("--binary <xuanling-mcp> is required");
  else if (!lstatSync(binary).isFile()) problems.push("--binary must name a regular file");
  for (const file of [memoryPatch, commonPatch, skillsPatch, settingsTemplate, adapterPath, ...SKILL_FILES.map((file) => path.join(skillsRoot, file))]) {
    if (!existsSync(file)) problems.push(`required evaluation file missing: ${file}`);
  }
  for (const caseId of CASES) {
    const task = path.join(taskRoot, `${caseId}.md`);
    if (!existsSync(task)) problems.push(`required case input missing: ${task}`);
    if (caseId !== "case-2" && !existsSync(path.join(fixtureRoot, caseId))) {
      problems.push(`required case fixture missing: ${path.join(fixtureRoot, caseId)}`);
    }
  }
  return problems;
}

const credentials = credentialSource();
const problems = preflight();
problems.push(...credentials.problems);
if (dryRun) {
  if (runId !== undefined) problems.push("dry-run requires XUANLING_DSH_RUN_ID to be unset");
  const plan = {
    dry_run: true,
    problems,
    cases: CASES,
    repetitions,
    frozen_route: { model, reasoningEffort },
    argv: dshRoot === undefined ? [] : [...dshArgv("<task text>").slice(0, -1), "<task text>"],
    credential_source: credentials.source?.kind ?? "not_provided",
    env_names: [
      "DEEPSEEK_API_KEY", "DSH_HOME", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_DISABLED",
      "HOME", "LANG", "LC_ALL", "PATH", "TERM", "TMPDIR", "TSX_TSCONFIG_PATH",
      "XUANLING_DSH_CREDENTIALS_FILE", "XUANLING_DSH_SCHEMA_ADAPTER", "XUANLING_DSH_SKILLS_ROOT",
      "XUANLING_MCP_BIN", "XUANLING_TEST_MEMORY_DB", "XUANLING_TEST_WORKSPACE_ROOT",
    ].sort(),
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(runId)) {
  problems.push("XUANLING_DSH_RUN_ID must be a fresh 4-64 character identifier");
} else if (existsSync(evaluationRootLive)) {
  problems.push(`evaluation root already exists: ${evaluationRootLive}`);
}
if (problems.length > 0) {
  console.error(`run-memory-dogfooding: preflight failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

mkdirSync(evaluationRootLive, { recursive: true });
const results = [];
let trialNumber = 0;
for (const caseId of CASES) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    trialNumber += 1;
    const dir = path.join(evaluationRootLive, `trial-${String(trialNumber).padStart(2, "0")}-${caseId}-r${repetition}`);
    const trial = {
      dir,
      caseId,
      repetition,
      workspace: path.join(dir, "workspace"),
      dshHome: path.join(dir, "dsh-home"),
      database: path.join(dir, "memory.db"),
    };
    try {
      results.push(await runTrial(trial, credentials.source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify({
        evaluation_schema: "xuanling-dsh-w4-4-memory/v1",
        case: caseId,
        repetition,
        incomplete: true,
        collection_problems: [message],
        exit: { code: null, signal: null, spawnError: null },
        credential_source: credentials.source.kind,
      }, null, 2)}\n`);
      results.push({ case: caseId, repetition, incomplete: true, collection_problems: [message] });
      break;
    }
  }
}
const summary = {
  schema_version: 1,
  run_id: runId,
  root: evaluationRootLive,
  expected_trials: CASES.length * repetitions,
  collected_trials: results.length,
  incomplete_trials: results.filter((result) => result.incomplete).length,
  dsh_revision: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
  results,
};
writeFileSync(path.join(evaluationRootLive, "runner-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.collected_trials !== summary.expected_trials || summary.incomplete_trials > 0) process.exit(1);
