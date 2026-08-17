#!/usr/bin/env node
// Live runner for the filesystem A/B/C evaluation (C-06/C-07/C-10).
//
// Gates, in order:
//   1. Without --allow-billable-live nothing starts: the run refuses before
//      touching the network, the model, or any state (exit 1).
//   2. --dry-run prints the redacted plan (argv, env NAMES, paths, fixture
//      hashes) and exits 0 without spawning dsh at all.
//   3. A live run requires a fresh XUANLING_DSH_RUN_ID (target root must not
//      exist) and exactly one credential source: DEEPSEEK_API_KEY in the
//      environment or an owner-only external --credentials-file reference.
//
// Route is frozen: --model must equal deepseek-official/deepseek-v4-pro and
// --reasoning-effort must equal max (C-07 same-yardstick rule).
//
// Every trial gets: a fresh workspace materialized from the frozen fixture,
// an isolated DSH_HOME with the no-secret settings template, the skills
// bundle + common + arm overlays, workspace-write permission, telemetry off,
// an external TERM→grace→KILL timeout on the child process group, an
// independent oracle verdict, and a copied raw session log.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const FROZEN_MODEL = "deepseek-official/deepseek-v4-pro";
const FROZEN_EFFORT = "max";
const TRIAL_TIMEOUT_MS = 20 * 60 * 1000;
const TERM_GRACE_MS = 10_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  }
  return values;
}

function argNumber(name, fallback) {
  const raw = argValue(name);
  return raw === undefined ? fallback : Number(raw);
}

const allowBillable = process.argv.includes("--allow-billable-live");
const dryRun = process.argv.includes("--dry-run");
const armsArg = argValue("--arms") ?? "A,B,C";
const arms = armsArg.split(",").map((arm) => arm.trim()).filter(Boolean);
const qualityRuns = argNumber("--quality-runs", 3);
const cachePairs = argNumber("--cache-pairs", 1);
const model = argValue("--model") ?? FROZEN_MODEL;
const reasoningEffort = argValue("--reasoning-effort") ?? FROZEN_EFFORT;
const credentialsFileArgs = argValues("--credentials-file");

const scriptDir = import.meta.dirname;
const testRoot = path.resolve(scriptDir, "..", "..");
const repoRoot = path.resolve(testRoot, "..", "..");
const integrationRoot = path.join(repoRoot, "integrations", "deepseek-harness");
const dshRoot = argValue("--dsh-root");
const binary = argValue("--binary") ? path.resolve(argValue("--binary")) : path.join(repoRoot, "target", "debug", "xuanling-mcp");
const evaluationRoot = path.join(testRoot, "evaluation");
const fixtureRoot = path.join(evaluationRoot, "fixtures", "fs-workload");
const skillsPatch = path.join(integrationRoot, "xuanling-skills", "cordis.patch.yml");
const skillsBundleRoot = path.join(integrationRoot, "xuanling-skills");
const strictOverwritePolicy = path.join(skillsBundleRoot, "strict-overwrite-policy.mjs");
const commonPatch = path.join(evaluationRoot, "overlays", "common", "cordis.patch.yml");
const armPatch = (arm) => path.join(evaluationRoot, "overlays", arm, "cordis.patch.yml");
const adapterPath = path.join(integrationRoot, "xuanling-memory", "schema-adapter.mjs");
const settingsTemplate = path.join(evaluationRoot, "config", "settings.template.yaml");
const createFixture = path.join(scriptDir, "create-fixture.mjs");
const oracle = path.join(fixtureRoot, "oracle.mjs");
const skillsBundleFiles = [
  "package.json",
  "strict-overwrite-policy.mjs",
  "cordis.patch.yml",
  "skills/xuanling-file-workflow/SKILL.md",
  "skills/xuanling-file-workflow/agents/openai.yaml",
  "skills/xuanling-memory-workflow/SKILL.md",
  "skills/xuanling-memory-workflow/agents/openai.yaml",
];

const taskText = readFileSync(path.join(fixtureRoot, "task.md"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ---------------------------------------------------------------------------
// Gate 1: the billable switch. --dry-run is the safe inspection mode and is
// allowed without it; everything else refuses before touching anything.
// ---------------------------------------------------------------------------
if (!allowBillable && !dryRun) {
  console.error(
    "run-filesystem-evaluation: refusing to start. Real-model evaluation is billable;\n" +
      "rerun with --allow-billable-live (and a fresh XUANLING_DSH_RUN_ID) to start it.\n" +
      "Use --dry-run to print the redacted plan without starting anything.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared preflight.
// ---------------------------------------------------------------------------
function preflight() {
  const problems = [];
  if (model !== FROZEN_MODEL) problems.push(`--model must stay ${FROZEN_MODEL}`);
  if (reasoningEffort !== FROZEN_EFFORT) problems.push(`--reasoning-effort must stay ${FROZEN_EFFORT}`);
  if (arms.length === 0 || new Set(arms).size !== arms.length || !arms.every((arm) => ["A", "B", "C"].includes(arm))) {
    problems.push(`--arms must be a non-empty unique A/B/C subset, got ${armsArg}`);
  }
  if (!Number.isSafeInteger(qualityRuns) || qualityRuns < 0) {
    problems.push(`--quality-runs must be a non-negative integer`);
  }
  if (!Number.isSafeInteger(cachePairs) || cachePairs < 0) {
    problems.push(`--cache-pairs must be a non-negative integer`);
  }
  if (qualityRuns === 0 && cachePairs === 0) problems.push(`at least one quality run or cache pair is required`);
  if (!dshRoot || !existsSync(dshRoot)) problems.push("--dsh-root <deepseek-harness checkout> is required");
  if (dshRoot && existsSync(dshRoot)) {
    for (const file of [path.join(dshRoot, "node_modules", ".bin", "tsx"), path.join(dshRoot, "apps", "cli", "src", "bin.ts")]) {
      if (!existsSync(file)) problems.push(`required DSH launcher missing: ${file}`);
    }
  }
  for (const file of [
    skillsPatch,
    ...skillsBundleFiles.map((file) => path.join(skillsBundleRoot, file)),
    commonPatch,
    ...arms.map(armPatch),
    adapterPath,
    settingsTemplate,
    binary,
  ]) {
    if (!existsSync(file)) problems.push(`required file missing: ${file}`);
  }
  return problems;
}

function resolveCredentialSource(required) {
  const problems = [];
  const environmentPresent = typeof process.env.DEEPSEEK_API_KEY === "string"
    && process.env.DEEPSEEK_API_KEY.length > 0;
  if (credentialsFileArgs.length > 1) {
    problems.push("--credentials-file may be provided only once");
  }
  const file = credentialsFileArgs.length === 1 ? credentialsFileArgs[0] : undefined;
  if (file !== undefined) {
    if (typeof file !== "string" || file.length === 0 || file.startsWith("--")) {
      problems.push("--credentials-file requires one absolute path");
    } else if (!path.isAbsolute(file)) {
      problems.push("--credentials-file must be an absolute path");
    } else {
      try {
        const stats = lstatSync(file);
        if (stats.isSymbolicLink()) problems.push("--credentials-file must not be a symlink");
        else if (!stats.isFile()) problems.push("--credentials-file must name a regular file");
        else if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
          problems.push(
            `--credentials-file must be owner-only (no group/other permission bits; mode ${(stats.mode & 0o777).toString(8)})`,
          );
        }
      } catch (error) {
        problems.push(`cannot stat --credentials-file: ${error?.code ?? String(error)}`);
      }
    }
  }
  if (environmentPresent && file !== undefined) {
    problems.push("exactly one credential source is allowed; environment and --credentials-file are ambiguous");
  } else if (required && !environmentPresent && file === undefined) {
    problems.push("exactly one credential source is required: DEEPSEEK_API_KEY or --credentials-file");
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

const runId = process.env.XUANLING_DSH_RUN_ID;
const evalRoot = runId ? path.join(tmpdir(), `xuanling-dsh-fs-eval.${runId}`) : undefined;
let credentialSource = null;

function childEnv(trial) {
  // Explicit allowlist: never forward the whole parent environment — an
  // unrelated credential must not leak into the harness process.
  const allowlist = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    LANG: process.env.LANG ?? "",
    LC_ALL: process.env.LC_ALL ?? "",
    TERM: process.env.TERM ?? "",
  };
  const credentialEnv = credentialSource?.kind === "file_reference"
    ? { XUANLING_DSH_CREDENTIALS_FILE: credentialSource.file }
    : credentialSource?.kind === "environment"
      ? {
          // Pin the provider's file layer to this isolated, absent path. The
          // environment remains the only configured credential source.
          XUANLING_DSH_CREDENTIALS_FILE: path.join(trial.dshHome, ".credentials.yaml"),
          DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        }
      : {};
  return {
    ...allowlist,
    DSH_HOME: trial.dshHome,
    TSX_TSCONFIG_PATH: path.join(dshRoot, "tsconfig.json"),
    DSH_PERMISSION_MODE: "workspace-write",
    DSH_TELEMETRY_DISABLED: "1",
    XUANLING_DSH_SKILLS_ROOT: path.join(trial.dshHome, "profiles", "headless", "node_modules", "xuanling-dsh-skills", "skills"),
    XUANLING_DSH_SCHEMA_ADAPTER: adapterPath,
    XUANLING_TEST_MCP_BIN: binary,
    XUANLING_TEST_WORKSPACE_ROOT: trial.workspace,
    XUANLING_TEST_MEMORY_DB: path.join(trial.dir, "memory.db"),
    ...credentialEnv,
  };
}

function treeSha256(root) {
  const hash = createHash("sha256");
  const visit = (directory, relative = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        hash.update(`file:${entryRelative}\0`);
        hash.update(readFileSync(entryPath));
        hash.update("\0");
      } else {
        throw new Error(`unsupported bundle entry: ${entryPath}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function profileSkillsBundlePath(dshHome) {
  return path.join(dshHome, "profiles", "headless", "node_modules", "xuanling-dsh-skills");
}

function installSkillsBundle(dshHome) {
  const destination = profileSkillsBundlePath(dshHome);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    throw new Error(`refusing to reuse profile-local skills bundle: ${destination}`);
  }
  cpSync(skillsBundleRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const sourceSha256 = treeSha256(skillsBundleRoot);
  const installedSha256 = treeSha256(destination);
  if (sourceSha256 !== installedSha256) {
    throw new Error(`profile-local skills bundle fingerprint mismatch: ${sourceSha256} != ${installedSha256}`);
  }
  return { path: destination, sha256: installedSha256 };
}

function dshArgv(trial) {
  // The fixture workspace has no package.json: `pnpm dsh` there fails with
  // ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND. Drive the harness checkout's own
  // source CLI through its tsx binary (absolute paths), with cwd = workspace.
  return [
    path.join(dshRoot, "node_modules", ".bin", "tsx"),
    path.join(dshRoot, "apps", "cli", "src", "bin.ts"),
    "--profile", "headless",
    "--patch", skillsPatch,
    "--patch", commonPatch,
    "--patch", armPatch(trial.arm),
    "--", taskText,
  ];
}

function prepareTrial(trial) {
  mkdirSync(trial.dir, { recursive: true });
  const materialized = spawnSync(process.execPath, [createFixture, "--dest", trial.workspace], { encoding: "utf8" });
  if (materialized.status !== 0) {
    throw new Error(`fixture materialization failed for ${trial.label}:\n${materialized.stdout}${materialized.stderr}`);
  }
  mkdirSync(trial.dshHome, { recursive: true });
  cpSync(settingsTemplate, path.join(trial.dshHome, "settings.yaml"));
  trial.skillsBundle = installSkillsBundle(trial.dshHome);
}

function locateSessionLogs(dshHome) {
  const found = [];
  const problems = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (error?.code !== "ENOENT") problems.push(`cannot read session directory ${dir}: ${error?.code ?? String(error)}`);
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let stats;
      try {
        stats = statSync(abs);
      } catch (error) {
        problems.push(`cannot stat session artifact ${abs}: ${error?.code ?? String(error)}`);
        continue;
      }
      if (stats.isDirectory()) walk(abs, depth + 1);
      else if (name === "session.jsonl") found.push(abs);
    }
  };
  walk(path.join(dshHome, "sessions"), 0);
  return { found, problems };
}

/** Parse the first line of a raw session log and return its header fields. */
function sessionHeader(file) {
  try {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine);
    return header !== null && typeof header === "object" ? header : null;
  } catch {
    return null;
  }
}

function sanitizeChildOutput(text) {
  if (credentialSource?.kind === "environment") {
    const credential = process.env.DEEPSEEK_API_KEY;
    if (!credential || !text.includes(credential)) return { text, redactions: 0, mode: "exact_value" };
    const redactions = text.split(credential).length - 1;
    return {
      text: text.split(credential).join("[REDACTED_PROVIDER_CREDENTIAL]"),
      redactions,
      mode: "exact_value",
    };
  }
  // File-reference mode never reads the credential body. Catch only an
  // accidentally rendered credential-shaped assignment in child output.
  const pattern = /((?:DEEPSEEK_API_KEY|api[_-]?key|token|secret|credential)\s*[:=]\s*)([^\s,;]+)/gi;
  let redactions = 0;
  const sanitized = text.replace(pattern, (_match, prefix) => {
    redactions += 1;
    return `${prefix}[REDACTED_CREDENTIAL_SHAPED_VALUE]`;
  });
  return { text: sanitized, redactions, mode: "credential_shape" };
}

function runTrial(trial) {
  const started = Date.now();
  const [program, ...args] = dshArgv(trial);
  const child = spawn(program, args, {
    cwd: trial.workspace,
    env: childEnv(trial),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group may already be gone.
    }
  };

  const settled = new Promise((resolve) => {
    // Timeout order is TERM first; only after TERM does the grace KILL
    // timer start — a KILL timer armed at spawn would cut every trial
    // short after TERM_GRACE_MS.
    let termTimer = null;
    let killTimer = null;
    const settle = (payload) => {
      if (termTimer !== null) clearTimeout(termTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve(payload);
    };
    child.once("error", (error) => {
      spawnError = String(error);
      settle({ code: null, signal: null, spawnError });
    });
    child.once("close", (code, signal) => {
      settle({ code, signal, spawnError });
    });
    termTimer = setTimeout(() => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), TERM_GRACE_MS);
    }, TRIAL_TIMEOUT_MS);
    termTimer.unref();
  });

  return settled.then((exit) => {
    const safeStdout = sanitizeChildOutput(stdout);
    const safeStderr = sanitizeChildOutput(stderr);
    writeFileSync(path.join(trial.dir, "stdout.log"), safeStdout.text);
    writeFileSync(path.join(trial.dir, "stderr.log"), safeStderr.text);

    // Session evidence: every session log under this trial's isolated
    // DSH_HOME, each verified against the trial's workspace via its header.
    const sessionScan = locateSessionLogs(trial.dshHome);
    const sessionLogs = sessionScan.found;
    const headerProblems = [];
    for (const log of sessionLogs) {
      const header = sessionHeader(log);
      if (header === null) {
        headerProblems.push(`${path.basename(log)}: unparseable session header`);
      } else if (typeof header.cwd !== "string" || header.cwd.length === 0) {
        // A missing cwd makes the trial's identity unverifiable: fail closed.
        headerProblems.push(`${path.basename(log)}: session header carries no cwd`);
      } else if (path.resolve(header.cwd) !== path.resolve(trial.workspace)) {
        headerProblems.push(`${path.basename(log)}: header cwd ${header.cwd} != trial workspace`);
      }
    }
    const sessionLogFound = sessionLogs.length > 0;
    const collectionProblems = [];
    if (spawnError !== null) collectionProblems.push(`spawn error: ${spawnError}`);
    if (exit.signal !== null) collectionProblems.push(`terminated by ${exit.signal}`);
    if (exit.code !== 0 && spawnError === null) collectionProblems.push(`child exited ${exit.code}`);
    if (!sessionLogFound) collectionProblems.push("no session.jsonl under the trial DSH_HOME");
    if (sessionLogs.length > 1) collectionProblems.push(`${sessionLogs.length} session logs (expected 1)`);
    collectionProblems.push(...sessionScan.problems);
    const secretRedactions = safeStdout.redactions + safeStderr.redactions;
    if (secretRedactions > 0) collectionProblems.push(`child output contained the provider credential (${secretRedactions} occurrence(s), redacted)`);
    collectionProblems.push(...headerProblems);

    sessionLogs.forEach((log, index) => {
      const target = sessionLogs.length === 1
        ? path.join(trial.dir, "session.jsonl")
        : path.join(trial.dir, `session-${index + 1}.jsonl`);
      cpSync(log, target);
    });

    // Cache cold/warm sessions intentionally reuse one cwd. Preserve the
    // post-session tree before the next fixture materialization so the batch
    // oracle can independently re-judge both temporal states afterwards.
    let workspaceSnapshot = null;
    if (trial.kind === "cache-cold" || trial.kind === "cache-warm") {
      const candidate = path.join(trial.dir, "workspace-snapshot");
      try {
        cpSync(trial.workspace, candidate, { recursive: true, force: false, errorOnExist: true });
        workspaceSnapshot = candidate;
      } catch (error) {
        collectionProblems.push(`cannot snapshot cache workspace: ${error?.code ?? String(error)}`);
      }
    }
    const incomplete = collectionProblems.length > 0;

    const verdict = spawnSync(process.execPath, [oracle, "--workspace", trial.workspace], { encoding: "utf8" });
    let oracleVerdict;
    try {
      oracleVerdict = JSON.parse(verdict.stdout);
    } catch {
      oracleVerdict = { pass: false, failures: ["oracle produced no verdict"] };
    }
    writeFileSync(path.join(trial.dir, "verdict.json"), `${JSON.stringify(oracleVerdict, null, 2)}\n`);
    writeFileSync(
      path.join(trial.dir, "meta.json"),
      `${JSON.stringify(
        {
          arm: trial.arm,
          label: trial.label,
          kind: trial.kind,
          exit,
          incomplete,
          collection_problems: collectionProblems,
          duration_ms: Date.now() - started,
          fixture: manifest.fixture,
          task_sha256: manifest.task_sha256,
          argv: [...dshArgv(trial).slice(0, -1), "<task text from fixtures/fs-workload/task.md>"],
          env_names: Object.keys(childEnv(trial)).sort(),
          memory_db: path.join(trial.dir, "memory.db"),
          cwd: trial.workspace,
          workspace_snapshot: workspaceSnapshot,
          settings_sha256: sha256(settingsTemplate),
          adapter_sha256: sha256(adapterPath),
          skills_patch_sha256: sha256(skillsPatch),
          skills_bundle_sha256: trial.skillsBundle?.sha256 ?? treeSha256(profileSkillsBundlePath(trial.dshHome)),
          skills_bundle_path: profileSkillsBundlePath(trial.dshHome),
          common_patch_sha256: sha256(commonPatch),
          arm_patch_sha256: sha256(armPatch(trial.arm)),
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
          stdout_persisted_bytes: Buffer.byteLength(safeStdout.text),
          stderr_persisted_bytes: Buffer.byteLength(safeStderr.text),
          secret_redactions: secretRedactions,
          secret_scan_mode: safeStdout.mode,
          credential_source: credentialSource.kind,
          evaluation_schema: "xuanling-dsh-filesystem-safety-stage2/v2",
          strict_overwrite_policy_sha256: sha256(strictOverwritePolicy),
        },
        null,
        2,
      )}\n`,
    );
    return {
      trial,
      exit,
      incomplete,
      collectionProblems,
      oracle: oracleVerdict,
      sessionLogCount: sessionLogs.length,
      workspaceSnapshot,
      stdoutTail: safeStdout.text.slice(-2000),
      stderrTail: safeStderr.text.slice(-2000),
    };
  });
}

// ---------------------------------------------------------------------------
// Gate 2: dry-run plan (nothing spawns).
// ---------------------------------------------------------------------------
if (dryRun) {
  const problems = preflight();
  const credentialResolution = resolveCredentialSource(false);
  problems.push(...credentialResolution.problems);
  if (!allowBillable && runId !== undefined && evalRoot !== undefined) {
    problems.push(`dry-run must not name a live root: unset XUANLING_DSH_RUN_ID (got ${runId})`);
  }
  const plan = {
    dry_run: true,
    problems,
    credential_source: credentialResolution.source?.kind ?? "not_provided",
    frozen_route: { model, reasoningEffort },
    fixture: { root: fixtureRoot, task_sha256: manifest.task_sha256, files: Object.keys(manifest.files).length },
    hashes: {
      adapter: sha256(adapterPath),
      skills_patch: sha256(skillsPatch),
      skills_bundle: existsSync(skillsBundleRoot) ? treeSha256(skillsBundleRoot) : null,
      strict_overwrite_policy: sha256(strictOverwritePolicy),
      skills_bundle_profile_path: path.join("profiles", "headless", "node_modules", "xuanling-dsh-skills"),
      common_patch: sha256(commonPatch),
      arm_patches: Object.fromEntries(arms.map((arm) => [arm, sha256(armPatch(arm))])),
      settings_template: sha256(settingsTemplate),
      binary,
    },
    arms: arms.map((arm) => ({
      arm,
      quality_runs: qualityRuns,
      cache_pairs: cachePairs,
      // The exact live argv (redacted task text) — the dry-run is the launch
      // oracle, so it must never drift from what runTrial spawns.
      argv: [...dshArgv({ arm }).slice(0, -1), "<frozen task text>"],
      env_names: ["DSH_HOME", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_DISABLED", "TSX_TSCONFIG_PATH", "XUANLING_DSH_SCHEMA_ADAPTER", "XUANLING_DSH_SKILLS_ROOT", "XUANLING_TEST_MCP_BIN", "XUANLING_TEST_WORKSPACE_ROOT", "XUANLING_TEST_MEMORY_DB", "XUANLING_DSH_CREDENTIALS_FILE", ...(credentialResolution.source?.kind === "environment" ? ["DEEPSEEK_API_KEY"] : []), "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].sort(),
    })),
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Gate 3: live preflight.
// ---------------------------------------------------------------------------
const liveProblems = preflight();
const credentialResolution = resolveCredentialSource(true);
liveProblems.push(...credentialResolution.problems);
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(runId)) {
  liveProblems.push("XUANLING_DSH_RUN_ID must be a fresh 4-64 char [A-Za-z0-9-] identifier");
} else if (existsSync(evalRoot)) {
  liveProblems.push(`eval root already exists: ${evalRoot} (never overwrite evidence; pick a new run id)`);
}
if (liveProblems.length > 0) {
  console.error(`run-filesystem-evaluation: live preflight failed:\n- ${liveProblems.join("\n- ")}`);
  process.exit(1);
}
credentialSource = credentialResolution.source;

mkdirSync(evalRoot, { recursive: true });
const trialSpecs = [];
for (const arm of arms) {
  for (let index = 1; index <= qualityRuns; index += 1) {
    const dir = path.join(evalRoot, "quality", arm, `trial-${index}`);
    trialSpecs.push({ arm, kind: "quality", label: `quality/${arm}/trial-${index}`, dir, workspace: path.join(dir, "workspace"), dshHome: path.join(dir, "dsh-home") });
  }
  for (let index = 1; index <= cachePairs; index += 1) {
    // Cold and warm share one workspace PATH so the request prefix matches;
    // the fixture is re-materialized between the two sessions.
    const base = path.join(evalRoot, "cache", arm, `pair-${index}`);
    trialSpecs.push(
      { arm, kind: "cache-cold", label: `cache/${arm}/pair-${index}/cold`, dir: path.join(base, "cold"), workspace: path.join(base, "shared-workspace"), dshHome: path.join(base, "cold", "dsh-home") },
      { arm, kind: "cache-warm", label: `cache/${arm}/pair-${index}/warm`, dir: path.join(base, "warm"), workspace: path.join(base, "shared-workspace"), dshHome: path.join(base, "warm", "dsh-home") },
    );
  }
}

const results = [];
for (const spec of trialSpecs) {
  const currentCredential = resolveCredentialSource(true);
  if (currentCredential.problems.length > 0
    || currentCredential.source?.kind !== credentialSource.kind
    || currentCredential.source?.file !== credentialSource.file) {
    throw new Error(`credential source changed during evaluation: ${currentCredential.problems.join("; ") || "source identity changed"}`);
  }
  if (spec.kind === "cache-warm" || spec.kind === "cache-cold") {
    // Re-materialize the shared cache workspace before each session.
    rmSync(spec.workspace, { recursive: true, force: true });
  }
  if (!existsSync(spec.workspace)) {
    prepareTrial(spec);
  } else {
    mkdirSync(spec.dir, { recursive: true });
    mkdirSync(spec.dshHome, { recursive: true });
    cpSync(settingsTemplate, path.join(spec.dshHome, "settings.yaml"));
    spec.skillsBundle = installSkillsBundle(spec.dshHome);
  }
  process.stderr.write(`run-filesystem-evaluation: starting ${spec.label}\n`);
  const result = await runTrial(spec);
  results.push(result);
  process.stderr.write(
    `run-filesystem-evaluation: ${spec.label} exit=${JSON.stringify(result.exit)} oracle=${result.oracle.pass ? "PASS" : "FAIL"} sessions=${result.sessionLogCount}` +
      (result.incomplete ? ` INCOMPLETE: ${result.collectionProblems.join("; ")}\n` : "\n"),
  );
}

writeFileSync(
  path.join(evalRoot, "run-summary.json"),
  `${JSON.stringify(
    {
      eval_root: evalRoot,
      run_id: runId,
      frozen_route: { model, reasoningEffort },
      credential_source: credentialSource.kind,
      evaluation_schema: "xuanling-dsh-filesystem-safety-stage2/v2",
      strict_overwrite_policy_sha256: sha256(strictOverwritePolicy),
      dsh_root: dshRoot,
      binary,
      trials: results.map((result) => ({
        label: result.trial.label,
        arm: result.trial.arm,
        kind: result.trial.kind,
        exit: result.exit,
        incomplete: result.incomplete,
        collection_problems: result.collectionProblems,
        oracle_pass: result.oracle.pass === true,
        session_log_count: result.sessionLogCount,
        workspace_snapshot: result.workspaceSnapshot,
      })),
    },
    null,
    2,
  )}\n`,
);
// Oracle failures are valid model outcomes and do NOT fail the run; anything
// that makes the EVIDENCE incomplete does (spawn error, abnormal exit,
// missing/ambiguous session log, header mismatch).
const incomplete = results.filter((result) => result.incomplete);
const oracleFails = results.filter((result) => result.oracle.pass !== true);
console.error(
  `run-filesystem-evaluation: ${results.length} trial(s), ${results.length - oracleFails.length} oracle pass, ` +
    `${incomplete.length} incomplete; evidence at ${evalRoot}`,
);
if (incomplete.length > 0) {
  console.error(
    `run-filesystem-evaluation: collection incomplete, refusing to report success:\n- ${incomplete
      .map((result) => `${result.trial.label}: ${result.collectionProblems.join("; ")}`)
      .join("\n- ")}`,
  );
  process.exit(1);
}
process.exit(0);
