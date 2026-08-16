#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { seedDatabase } from "./seed.mjs";
import { assertExpectedSeed, snapshotDatabase } from "./sqlite-oracle.mjs";

const FROZEN_MODEL = "deepseek-official/deepseek-v4-pro";
const FROZEN_EFFORT = "max";
const TRIAL_TIMEOUT_MS = 20 * 60 * 1000;
const TERM_GRACE_MS = 10_000;

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

const allowBillable = process.argv.includes("--allow-billable-live");
const dryRun = process.argv.includes("--dry-run");
const dshRootArg = argValue("--dsh-root");
const binaryArg = argValue("--binary");
const trials = Number(argValue("--trials") ?? 3);
const model = argValue("--model") ?? FROZEN_MODEL;
const reasoningEffort = argValue("--reasoning-effort") ?? FROZEN_EFFORT;
const credentialFileArgs = argValues("--credentials-file");

const memoryRoot = import.meta.dirname;
const testRoot = path.resolve(memoryRoot, "..", "..");
const repoRoot = path.resolve(testRoot, "..", "..");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const evaluationRoot = path.join(testRoot, "evaluation");
const dshRoot = dshRootArg === undefined ? undefined : path.resolve(dshRootArg);
const binary = binaryArg === undefined ? undefined : path.resolve(binaryArg);
const fixtureFile = path.join(memoryRoot, "fixture.json");
const taskFile = path.join(memoryRoot, "task.md");
const memoryPatch = path.join(memoryRoot, "cordis.patch.yml");
const commonPatch = path.join(evaluationRoot, "overlays", "common", "cordis.patch.yml");
const settingsTemplate = path.join(evaluationRoot, "config", "settings.template.yaml");
const adapterPath = path.join(integrationRoot, "xuanling-memory", "schema-adapter.mjs");
const skillsRoot = path.join(integrationRoot, "xuanling-skills");
const skillsPatch = path.join(skillsRoot, "cordis.patch.yml");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
const taskText = readFileSync(taskFile, "utf8").trimEnd();

if (!allowBillable && !dryRun) {
  console.error(
    "run-memory-retrieval: refusing to start a billable model session. "
      + "Use --dry-run for inspection or add --allow-billable-live after explicit authorization.",
  );
  process.exit(1);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function treeSha256(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix === "" ? entry.name : path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        hash.update(`file:${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      } else {
        throw new Error(`unsupported skills bundle entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function preflight() {
  const problems = [];
  if (model !== FROZEN_MODEL) problems.push(`--model must stay ${FROZEN_MODEL}`);
  if (reasoningEffort !== FROZEN_EFFORT) problems.push(`--reasoning-effort must stay ${FROZEN_EFFORT}`);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) {
    problems.push("--trials must be an integer from 1 through 20");
  }
  if (taskText !== fixture.task) problems.push("task.md does not match fixture.task byte-for-byte after its final newline");
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
  if (binary === undefined || !existsSync(binary)) {
    problems.push("--binary <xuanling-mcp> is required");
  } else if (!lstatSync(binary).isFile()) {
    problems.push("--binary must name a regular file");
  }
  for (const file of [
    fixtureFile,
    taskFile,
    memoryPatch,
    commonPatch,
    settingsTemplate,
    adapterPath,
    skillsPatch,
    path.join(skillsRoot, "package.json"),
    path.join(skillsRoot, "skills", "xuanling-memory-workflow", "SKILL.md"),
  ]) {
    if (!existsSync(file)) problems.push(`required evaluation file missing: ${file}`);
  }
  return problems;
}

function resolveCredentialSource(required) {
  const problems = [];
  const environmentPresent = typeof process.env.DEEPSEEK_API_KEY === "string"
    && process.env.DEEPSEEK_API_KEY.length > 0;
  if (credentialFileArgs.length > 1) problems.push("--credentials-file may be provided only once");
  const file = credentialFileArgs.length === 1 ? credentialFileArgs[0] : undefined;
  if (file !== undefined) {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      problems.push("--credentials-file must be one absolute path");
    } else {
      try {
        const stats = lstatSync(file);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          problems.push("--credentials-file must be a non-symlink regular file");
        } else if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
          problems.push(`--credentials-file must be owner-only; mode is ${(stats.mode & 0o777).toString(8)}`);
        }
      } catch (error) {
        problems.push(`cannot stat --credentials-file: ${error?.code ?? String(error)}`);
      }
    }
  }
  if (environmentPresent && file !== undefined) {
    problems.push("exactly one credential source is allowed");
  } else if (required && !environmentPresent && file === undefined) {
    problems.push("DEEPSEEK_API_KEY or --credentials-file is required");
  }
  return {
    problems,
    source: environmentPresent && file === undefined
      ? { kind: "environment" }
      : !environmentPresent && file !== undefined
        ? { kind: "file_reference", file }
        : null,
  };
}

function profileBundlePath(dshHome) {
  return path.join(dshHome, "profiles", "headless", "node_modules", "xuanling-dsh-skills");
}

function installSkills(dshHome) {
  const destination = profileBundlePath(dshHome);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(skillsRoot, destination, { recursive: true, force: false, errorOnExist: true });
  const sourceSha = treeSha256(skillsRoot);
  const installedSha = treeSha256(destination);
  if (sourceSha !== installedSha) throw new Error("installed skills bundle fingerprint mismatch");
  return installedSha;
}

function dshArgv() {
  return [
    path.join(dshRoot, "node_modules", ".bin", "tsx"),
    path.join(dshRoot, "apps", "cli", "src", "bin.ts"),
    "--profile", "headless",
    "--patch", skillsPatch,
    "--patch", commonPatch,
    "--patch", memoryPatch,
    "--", taskText,
  ];
}

let credentialSource = null;
function childEnv(trial) {
  const allowed = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const credential = credentialSource?.kind === "environment"
    ? {
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        XUANLING_DSH_CREDENTIALS_FILE: path.join(trial.dshHome, ".credentials.yaml"),
      }
    : credentialSource?.kind === "file_reference"
      ? { XUANLING_DSH_CREDENTIALS_FILE: credentialSource.file }
      : {};
  return {
    ...allowed,
    DSH_HOME: trial.dshHome,
    TSX_TSCONFIG_PATH: path.join(dshRoot, "tsconfig.json"),
    DSH_PERMISSION_MODE: "workspace-write",
    DSH_TELEMETRY_DISABLED: "1",
    XUANLING_DSH_SCHEMA_ADAPTER: adapterPath,
    XUANLING_DSH_SKILLS_ROOT: path.join(profileBundlePath(trial.dshHome), "skills"),
    XUANLING_MCP_BIN: binary,
    XUANLING_TEST_WORKSPACE_ROOT: trial.workspace,
    XUANLING_TEST_MEMORY_DB: trial.database,
    ...credential,
  };
}

function sanitizeOutput(value) {
  if (credentialSource?.kind === "environment") {
    const secret = process.env.DEEPSEEK_API_KEY;
    if (typeof secret !== "string" || secret.length === 0 || !value.includes(secret)) {
      return { text: value, redactions: 0, mode: "exact_value" };
    }
    return {
      text: value.split(secret).join("[REDACTED_PROVIDER_CREDENTIAL]"),
      redactions: value.split(secret).length - 1,
      mode: "exact_value",
    };
  }
  const pattern = /((?:DEEPSEEK_API_KEY|api[_-]?key|token|secret)\s*[:=]\s*)([^\s,;]+)/gi;
  let redactions = 0;
  return {
    text: value.replace(pattern, (_match, prefix) => {
      redactions += 1;
      return `${prefix}[REDACTED_CREDENTIAL_SHAPED_VALUE]`;
    }),
    get redactions() { return redactions; },
    mode: "credential_shape",
  };
}

function locateSessions(dshHome) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 7 || !existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute, depth + 1);
      else if (name === "session.jsonl") found.push(absolute);
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

async function runTrial(trial) {
  mkdirSync(trial.workspace, { recursive: true });
  mkdirSync(trial.dshHome, { recursive: true });
  cpSync(settingsTemplate, path.join(trial.dshHome, "settings.yaml"));
  const skillsSha = installSkills(trial.dshHome);
  const seed = await seedDatabase({ binary, database: trial.database, fixture });
  const before = snapshotDatabase(trial.database);
  assertExpectedSeed(before, fixture);
  writeFileSync(path.join(trial.dir, "oracle-before.json"), `${JSON.stringify(before, null, 2)}\n`);

  const [program, ...args] = dshArgv();
  const started = Date.now();
  const child = spawn(program, args, {
    cwd: trial.workspace,
    detached: true,
    env: childEnv(trial),
    stdio: ["ignore", "pipe", "pipe"],
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
    const termTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, TERM_GRACE_MS);
    }, TRIAL_TIMEOUT_MS);
    termTimer.unref();
    const settle = (value) => {
      clearTimeout(termTimer);
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

  const safeStdout = sanitizeOutput(stdout);
  const safeStderr = sanitizeOutput(stderr);
  writeFileSync(path.join(trial.dir, "stdout.log"), safeStdout.text);
  writeFileSync(path.join(trial.dir, "stderr.log"), safeStderr.text);
  const collectionProblems = [];
  if (exit.spawnError !== null) collectionProblems.push(`spawn error: ${exit.spawnError}`);
  if (exit.signal !== null) collectionProblems.push(`child terminated by ${exit.signal}`);
  if (exit.code !== 0 && exit.spawnError === null) collectionProblems.push(`child exited ${exit.code}`);
  const redactions = safeStdout.redactions + safeStderr.redactions;
  if (redactions > 0) collectionProblems.push(`child output contained credential material (${redactions} redaction(s))`);

  const sessions = locateSessions(trial.dshHome);
  if (sessions.length !== 1) collectionProblems.push(`found ${sessions.length} session logs; expected exactly one`);
  if (sessions.length === 1) {
    const target = path.join(trial.dir, "session.jsonl");
    cpSync(sessions[0], target);
    try {
      const header = JSON.parse(readFileSync(target, "utf8").split("\n", 1)[0]);
      if (typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(trial.workspace)) {
        collectionProblems.push("session header cwd does not identify this trial workspace");
      }
    } catch {
      collectionProblems.push("session header is not valid JSON");
    }
  }

  let after = null;
  try {
    after = snapshotDatabase(trial.database);
    writeFileSync(path.join(trial.dir, "oracle-after.json"), `${JSON.stringify(after, null, 2)}\n`);
  } catch (error) {
    collectionProblems.push(`after-oracle failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const incomplete = collectionProblems.length > 0;
  const meta = {
    evaluation_schema: "xuanling-dsh-memory-retrieval/v1",
    trial: trial.index,
    incomplete,
    collection_problems: collectionProblems,
    exit,
    duration_ms: Date.now() - started,
    cwd: trial.workspace,
    memory_db: trial.database,
    credential_source: credentialSource.kind,
    seed,
    argv: [...dshArgv().slice(0, -1), "<task text from memory-retrieval/task.md>"],
    env_names: Object.keys(childEnv(trial)).sort(),
    hashes: {
      fixture: sha256(fixtureFile),
      task: sha256(taskFile),
      memory_patch: sha256(memoryPatch),
      common_patch: sha256(commonPatch),
      settings: sha256(settingsTemplate),
      adapter: sha256(adapterPath),
      skills_patch: sha256(skillsPatch),
      skills_bundle: skillsSha,
      binary: sha256(binary),
    },
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    secret_redactions: redactions,
    secret_scan_mode: safeStdout.mode,
  };
  writeFileSync(path.join(trial.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { trial: trial.index, incomplete, collectionProblems, exit, after };
}

const baseProblems = preflight();
const credential = resolveCredentialSource(!dryRun);
baseProblems.push(...credential.problems);
const runId = process.env.XUANLING_DSH_RUN_ID;
const evalRoot = runId === undefined ? undefined : `/private/tmp/xuanling-dsh-memory-eval.${runId}`;

if (dryRun) {
  if (!allowBillable && runId !== undefined) {
    baseProblems.push("dry-run requires XUANLING_DSH_RUN_ID to be unset");
  }
  const plan = {
    dry_run: true,
    problems: baseProblems,
    trials,
    credential_source: credential.source?.kind ?? "not_provided",
    frozen_route: { model, reasoningEffort },
    argv: dshRoot === undefined
      ? []
      : [...dshArgv().slice(0, -1), "<task text from memory-retrieval/task.md>"],
    env_names: [
      "DSH_HOME",
      "DSH_PERMISSION_MODE",
      "DSH_TELEMETRY_DISABLED",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TERM",
      "TMPDIR",
      "TSX_TSCONFIG_PATH",
      "XUANLING_DSH_CREDENTIALS_FILE",
      "XUANLING_DSH_SCHEMA_ADAPTER",
      "XUANLING_DSH_SKILLS_ROOT",
      "XUANLING_MCP_BIN",
      "XUANLING_TEST_MEMORY_DB",
      "XUANLING_TEST_WORKSPACE_ROOT",
      ...(credential.source?.kind === "environment" ? ["DEEPSEEK_API_KEY"] : []),
    ].sort(),
    hashes: {
      fixture: sha256(fixtureFile),
      task: sha256(taskFile),
      memory_patch: sha256(memoryPatch),
      common_patch: sha256(commonPatch),
      settings: sha256(settingsTemplate),
      adapter: sha256(adapterPath),
      skills_patch: sha256(skillsPatch),
      skills_bundle: treeSha256(skillsRoot),
      binary,
    },
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(baseProblems.length === 0 ? 0 : 1);
}

if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(runId)) {
  baseProblems.push("XUANLING_DSH_RUN_ID must be a fresh 4-64 character identifier");
} else if (existsSync(evalRoot)) {
  baseProblems.push(`evaluation root already exists: ${evalRoot}`);
}
if (baseProblems.length > 0) {
  console.error(`run-memory-retrieval: live preflight failed:\n- ${baseProblems.join("\n- ")}`);
  process.exit(1);
}
credentialSource = credential.source;
mkdirSync(evalRoot, { recursive: true });
const results = [];
for (let index = 1; index <= trials; index += 1) {
  const dir = path.join(evalRoot, `trial-${index}`);
  mkdirSync(dir, { recursive: true });
  const trial = {
    index,
    dir,
    workspace: path.join(dir, "workspace"),
    dshHome: path.join(dir, "dsh-home"),
    database: path.join(dir, "memory.db"),
  };
  try {
    results.push(await runTrial(trial));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      path.join(dir, "meta.json"),
      `${JSON.stringify({
        evaluation_schema: "xuanling-dsh-memory-retrieval/v1",
        trial: index,
        incomplete: true,
        collection_problems: [message],
        exit: { code: null, signal: null, spawnError: null },
        cwd: trial.workspace,
        credential_source: credentialSource.kind,
      }, null, 2)}\n`,
    );
    results.push({ trial: index, incomplete: true, collectionProblems: [message], exit: null });
    break;
  }
}
const summary = {
  schema_version: 1,
  run_id: runId,
  root: evalRoot,
  expected_trials: trials,
  collected_trials: results.length,
  incomplete_trials: results.filter((result) => result.incomplete).length,
  results,
};
writeFileSync(path.join(evalRoot, "runner-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (results.length !== trials || results.some((result) => result.incomplete)) {
  console.error(`run-memory-retrieval: collection incomplete; evidence retained at ${evalRoot}`);
  process.exit(1);
}
