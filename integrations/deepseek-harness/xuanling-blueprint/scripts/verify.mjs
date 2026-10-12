#!/usr/bin/env node
// Blueprint verification runner (plan dsh-blueprint-plugin-v1 §10.2).
//
//   node scripts/verify.mjs --suite <name> [--scope <scope>] [--repeat <n>]
//     [--report-dir <path>] [--plan-id <id>] [--evidence-manifest <path>]
//
// Suites live in test/<suite>/ and export `getCases(helpers)`. A case is
// { id, title, contract?, expect: 'pass' | 'red', redCode?, run }. The runner
// never converts a test failure into a success: `pass` cases must resolve
// truthy, `red` cases must throw the exact named failure (RemoteError code or
// error `code` property) — anything else (unexpected green, wrong error,
// module/compile error, silent skip) fails the suite with the raw detail.
// Suites whose implementation wave has not landed are `registered` only and
// exit non-zero when invoked, so a future/absent command can never pose as
// executable evidence. --repeat N records N consecutive runs under one
// checkout fingerprint; any difference or failure resets the clean count.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { selectLiveBehaviorDetail, validLiveBehaviorDetail } from '../test/acceptance/behavior-evidence.mjs'
import { projectLiveJourneyFailure } from '../test/live/live-diagnostic-evidence.mjs'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..', '..')
// per-wave report root, resolved from the suite's owning wave
const reportDirFor = (wave) => join(REPO_ROOT, 'docs', 'validation', 'blueprint', 'current', wave.toLowerCase())

const SUITES = {
  foundation: { module: join(PACKAGE_ROOT, 'test', 'foundation', 'foundation.mjs'), wave: 'W1', scope: false },
  'red-oracles': { module: join(PACKAGE_ROOT, 'test', 'red-oracles', 'red-oracles.mjs'), wave: 'W1', scope: false },
  definition: { module: join(PACKAGE_ROOT, 'test', 'definition', 'definition.mjs'), wave: 'W2', scope: false },
  resources: { module: join(PACKAGE_ROOT, 'test', 'resources', 'resources.mjs'), wave: 'W2', scope: false },
  runtime: { module: join(PACKAGE_ROOT, 'test', 'runtime', 'runtime.mjs'), wave: 'W3', scope: false },
  host: { module: join(PACKAGE_ROOT, 'test', 'host', 'host.mjs'), wave: 'W4', scope: false },
  api: { module: join(PACKAGE_ROOT, 'test', 'api', 'api.mjs'), wave: 'W4', scope: true },
  portability: { module: join(PACKAGE_ROOT, 'test', 'portability', 'portability.mjs'), wave: 'W5', scope: false },
  security: { module: join(PACKAGE_ROOT, 'test', 'security', 'security.mjs'), wave: 'W2', scope: true },
  recovery: { module: join(PACKAGE_ROOT, 'test', 'recovery', 'recovery.mjs'), wave: 'W3', scope: true },
  critical: { module: join(PACKAGE_ROOT, 'test', 'critical', 'critical.mjs'), wave: 'W2', scope: true },
  browser: { module: join(PACKAGE_ROOT, 'test', 'browser', 'browser.mjs'), wave: 'W6', scope: false },
  performance: { module: join(PACKAGE_ROOT, 'test', 'performance', 'performance.mjs'), wave: 'W6' },
  platform: { module: join(PACKAGE_ROOT, 'test', 'platform', 'platform.mjs'), wave: 'W7', scope: false },
  live: { module: join(PACKAGE_ROOT, 'test', 'live', 'live.mjs'), wave: 'W7' },
  package: { module: join(PACKAGE_ROOT, 'test', 'package', 'package.mjs'), wave: 'W8', scope: false },
  acceptance: { module: join(PACKAGE_ROOT, 'test', 'acceptance', 'acceptance.mjs'), wave: 'W8', scope: false },
}

// Per-suite scope tables (plan §10.2: each suite accepts a fixed list; an
// unknown scope is rejected instead of silently running the wrong slice).
const SUITE_SCOPES = {
  api: ['host', 'ui', 'all'],
  security: ['resources', 'host', 'portability', 'ui', 'all'],
  recovery: ['coordinator', 'portability', 'all'],
  critical: ['resources', 'coordinator', 'host', 'restore', 'all'],
}

export function scanForSecrets(text) {
  const patterns = [
    ['bp-canary', /BP[_-]?SECRET[_-]?CANARY/],
    ['openai-key', /sk-[A-Za-z0-9]{20,}/],
    ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
    ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ['aws-key', /AKIA[0-9A-Z]{16}/],
  ]
  const found = []
  for (const [name, re] of patterns) {
    if (re.test(text)) found.push(name)
  }
  return found
}

export function makeIsolatedHome(label = 'bp-verify') {
  const root = mkdtempSync(join(tmpdir(), `${label}-${Date.now()}-`))
  const env = {
    DSH_HOME: join(root, 'dsh'),
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    npm_config_cache: join(root, 'npm-cache'),
  }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  return {
    root,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Package-management guard: npm/pnpm must only ever run inside the plugin
 * package or the isolated probe workspace — never the repo root (W0 incident
 * prevention). */
export function assertAllowedNpmCwd(cwd) {
  const real = resolve(cwd)
  const allowed = [PACKAGE_ROOT, join(REPO_ROOT, 'test', 'blueprint')]
  if (!allowed.some(root => real === root || real.startsWith(root + sep))) {
    throw new Error(`npm cwd ${real} is outside the allowed roots ${allowed.join(', ')}`)
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** No docs, key files, reports, dependency trees or delivery archives are
 * read. Labels are root-relative POSIX paths (not machine absolute paths).
 * Symlinks are hashed as link metadata, NEVER followed into credentials.
 * Missing roots are represented, so absent artifacts cannot hash as present.
 */
export function captureEvidenceFingerprint({ packageRoot = PACKAGE_ROOT, repoRoot = REPO_ROOT } = {}) {
  const excluded = new Set(['node_modules', 'lib', 'reports', 'dist', '.cache', '.git', 'artifacts', 'docs', 'key'])
  const excludedFile = name => /\.(?:tgz|log)$/i.test(name)
  const collect = (root, prefix, artifacts = false) => {
    const files = []
    const walk = (path) => {
      if (!existsSync(path)) { files.push([`${prefix}/!missing`, 'missing']); return }
      const stat = lstatSync(path)
      const rel = relative(root, path).split(sep).join('/')
      if (stat.isSymbolicLink()) {
        // Do not read a symlink target, even when it masquerades as config.
        files.push([`${prefix}/${rel}`, sha256(`symlink:${readlinkSync(path)}`)])
      } else if (stat.isDirectory()) {
        for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          if ((!artifacts && excluded.has(item.name)) || excludedFile(item.name)) continue
          walk(join(path, item.name))
        }
      } else if (stat.isFile() && (!artifacts || path.endsWith('.js'))) {
        files.push([`${prefix}/${rel}`, sha256(readFileSync(path))])
      }
    }
    walk(root)
    return files
  }
  const source = []
  for (const dir of ['src', 'config', 'test', 'tests', 'scripts', 'examples']) {
    source.push(...collect(join(packageRoot, dir), `plugin/${dir}`))
  }
  // All root-level plugin manifests/configuration, but never README/docs or
  // arbitrary secret files. Nested configuration is covered by config/.
  if (existsSync(packageRoot)) {
    for (const item of readdirSync(packageRoot, { withFileTypes: true })) {
      if (/^(?:package\.json|pnpm-lock\.ya?ml|pnpm-workspace\.ya?ml|cordis\.patch\.ya?ml|yarn\.lock|(?:.+\.)?config\.(?:json|[cm]?js|ts)|tsconfig(?:\.[^.]+)?\.json|\.eslintrc(?:\..+)?|eslint\.config\.[cm]?js)$/.test(item.name)) {
        source.push(...collect(join(packageRoot, item.name), `plugin/${item.name}`))
      }
    }
  }
  source.push(...collect(join(repoRoot, 'test', 'blueprint'), 'repo/test/blueprint'))
  source.push(...collect(join(repoRoot, '.github', 'workflows'), 'repo/.github/workflows'))
  source.push(...collect(join(repoRoot, 'package.json'), 'repo/package.json'))
  const digest = files => sha256(JSON.stringify(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
  const rev = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return {
    revision: rev.status === 0 ? rev.stdout.trim() : 'unknown',
    source_sha256: digest(source),
    artifact_sha256: digest(collect(join(packageRoot, 'lib'), 'plugin/lib', true)),
  }
}

export class VerificationNotRunError extends Error {
  constructor(reasonCode, message) {
    super(message)
    this.name = 'VerificationNotRunError'
    this.code = 'VERIFICATION_NOT_RUN'
    this.reasonCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(reasonCode) ? reasonCode : 'ENVIRONMENT_UNAVAILABLE'
    this.reason_code = this.reasonCode
  }
}

const evidenceEqual = (a, b) => ['revision', 'source_sha256', 'artifact_sha256'].every(key => a[key] === b[key])
const errorResult = (error, id = 'runner', title = 'suite module executed') => {
  const notRun = error instanceof VerificationNotRunError
  const acceptance = error?.code === 'ACCEPTANCE_EVIDENCE_INVALID'
    && /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.reason_code)
  const liveFailure = projectLiveJourneyFailure(error)
  const reason = notRun ? error.reasonCode : acceptance ? error.reason_code : liveFailure?.reason_code ?? 'VERIFICATION_FAILED'
  const gateId = (notRun || acceptance) && /^(?:manifest|[a-z][a-z-]{0,39})$/.test(error?.gate_id) ? error.gate_id : undefined
  return {
    id, title, expect: 'pass', status: notRun ? 'not-run' : 'fail', reason_code: reason,
    ...(gateId ? { gate_id: gateId } : {}),
    ...(liveFailure?.failure_evidence ? { failure_evidence: liveFailure.failure_evidence } : {}),
    // Never serialize arbitrary exception messages/stacks/provider payloads.
    detail: gateId ? `${reason}:${gateId}` : reason,
  }
}

function fingerprint() {
  const rev = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? 'unknown'
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' })
  const trackedDiff = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--binary', 'HEAD', '--',
    'integrations/deepseek-harness/xuanling-blueprint/src',
    'integrations/deepseek-harness/xuanling-blueprint/config',
    'integrations/deepseek-harness/xuanling-blueprint/test',
    'integrations/deepseek-harness/xuanling-blueprint/scripts',
    'integrations/deepseek-harness/xuanling-blueprint/*config*',
    'integrations/deepseek-harness/xuanling-blueprint/package*.json',
    'integrations/deepseek-harness/xuanling-blueprint/cordis.patch.yml',
    'test/blueprint', '.github/workflows', 'package.json',
    ':(glob,exclude)**/reports/**', ':(glob,exclude)**/docs/**', ':(glob,exclude)**/key/**'], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  })
  return {
    revision: rev,
    status_sha256: sha256(status.stdout ?? Buffer.alloc(0)),
    tracked_diff_sha256: sha256(trackedDiff.stdout ?? Buffer.alloc(0)),
    suite_files: {},
  }
}

function isExpectedRed(error, redCode) {
  if (error === null || typeof error !== 'object') return false
  return error?.code === redCode || error?.failure?.code === redCode
}

function isTruthyEvidence(value) {
  if (value === true) return true
  if (value !== null && typeof value === 'object' && value.ok === true) return true
  return false
}

export async function runCases(cases) {
  const results = []
  if (!Array.isArray(cases) || cases.length === 0) return [{ id: 'runner', title: 'nonempty suite', expect: 'pass', status: 'fail', reason_code: 'EMPTY_CASES', detail: 'empty cases are not evidence' }]
  for (const testCase of cases) {
    const started = new Date().toISOString()
    let outcome
    try {
      const value = await testCase.run()
      outcome = { ok: true, value }
    } catch (error) {
      outcome = { ok: false, error }
    }
    const finished = new Date().toISOString()
    if (!outcome.ok && outcome.error instanceof VerificationNotRunError) {
      results.push({ ...testCase, ...errorResult(outcome.error, testCase.id, testCase.title), started, finished })
    } else if (testCase.expect === 'red') {
      if (outcome.ok) {
        results.push({ ...testCase, expect: 'red', status: 'fail', detail: 'unexpected green', started, finished })
      } else if (isExpectedRed(outcome.error, testCase.redCode)) {
        results.push({ ...testCase, expect: 'red', status: 'expected-red', detail: 'exact expected failure', started, finished })
      } else {
        results.push({ ...testCase, expect: 'red', status: 'fail', detail: 'wrong failure', started, finished })
      }
    } else if (outcome.ok && isTruthyEvidence(outcome.value)) {
      let detail
      if (testCase.id === 'L1') {
        detail = selectLiveBehaviorDetail(outcome.value)
        if (!validLiveBehaviorDetail(detail)) {
          results.push({ ...testCase, expect: 'pass', status: 'fail', reason_code: 'LIVE_BEHAVIOR_INVALID',
            detail: 'LIVE_BEHAVIOR_INVALID', started, finished })
          continue
        }
      } else if (testCase.id === 'PL1' && outcome.value?.platform !== undefined) {
        // OS identity is a full structured receipt; temporary paths are not
        // part of the evidence contract and must not truncate its fields.
        detail = { ok: outcome.value.ok === true, platform: outcome.value.platform, arch: outcome.value.arch }
      } else {
        detail = JSON.stringify(outcome.value)?.slice(0, 200)
      }
      results.push({ ...testCase, expect: 'pass', status: 'pass', detail, started, finished })
    } else if (outcome.ok) {
      const message = 'case resolved without affirmative evidence; not a pass'
      results.push({ ...testCase, expect: 'pass', status: 'fail', detail: message, started, finished })
    } else {
      results.push({ ...testCase, ...errorResult(outcome.error, testCase.id, testCase.title), started, finished })
    }
  }
  return results
}

async function runSuiteOnce(suiteName, suiteDef, scope, reportRouting = {}) {
  if (!existsSync(suiteDef.module)) {
    throw new Error(`suite module missing: ${suiteDef.module} (wrong failure — build/import problems must not count as test evidence)`)
  }
  const { getCases } = await import(pathToFileURL(suiteDef.module).href)
  const helpers = {
    packageRoot: PACKAGE_ROOT,
    repoRoot: REPO_ROOT,
    runCases,
    makeIsolatedHome,
    assertAllowedNpmCwd,
    scanForSecrets,
    VerificationNotRunError,
    scope,
    ...reportRouting,
  }
  const cases = await getCases(helpers)
  return await runCases(cases)
}

async function main() {
  const argv = process.argv.slice(2)
  // Explicit report routing does not alter suite selection or case outcomes.
  const reportOption = (flag) => {
    const inline = argv.find(arg => arg.startsWith(`${flag}=`))
    const index = argv.indexOf(flag)
    if (inline === undefined && index < 0) return undefined
    const value = inline === undefined ? argv[index + 1] : inline.slice(flag.length + 1)
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      process.stderr.write(`verify: ${flag} requires a non-empty value\n`)
      process.exit(2)
    }
    return value
  }
  const reportDirArg = reportOption('--report-dir')
  const planIdArg = reportOption('--plan-id')
  const evidenceManifestArg = reportOption('--evidence-manifest')
  const suiteName = (argv.find(a => a.startsWith('--suite=')) ?? '').split('=')[1]
    ?? argv[argv.indexOf('--suite') + 1]
  const scopeArg = (argv.find(a => a.startsWith('--scope=')) ?? '').split('=')[1]
    ?? (argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : undefined)
  const repeat = Number((argv.find(a => a.startsWith('--repeat=')) ?? '').split('=')[1]
    ?? (argv.includes('--repeat') ? argv[argv.indexOf('--repeat') + 1] : '1'))

  if (!suiteName || !SUITES[suiteName]) {
    process.stderr.write(`verify: unknown or missing --suite (${suiteName ?? 'none'}); known: ${Object.keys(SUITES).join(', ')}\n`)
    process.exit(2)
  }
  if (evidenceManifestArg !== undefined && suiteName !== 'acceptance') {
    process.stderr.write('verify: --evidence-manifest is only valid for acceptance\n')
    process.exit(2)
  }
  const suiteDef = SUITES[suiteName]
  if (!suiteDef.module) {
    process.stderr.write(`verify: suite "${suiteName}" is registered for ${suiteDef.wave} but has no cases yet; it must not run early (no future-command evidence)\n`)
    process.exit(2)
  }
  let scope
  if (suiteDef.scope) {
    const allowed = SUITE_SCOPES[suiteName] ?? ['all']
    scope = scopeArg ?? 'all'
    if (!allowed.includes(scope)) {
      process.stderr.write(`verify: suite "${suiteName}" rejects scope "${scope}"; known: ${allowed.join(', ')}\n`)
      process.exit(2)
    }
  } else if (scopeArg !== undefined) {
    process.stderr.write(`verify: suite "${suiteName}" does not take --scope\n`)
    process.exit(2)
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    process.stderr.write(`verify: --repeat must be an integer in [1,10]\n`)
    process.exit(2)
  }

  const evidenceBefore = captureEvidenceFingerprint()
  const fp = fingerprint()
  const reportDir = reportDirArg === undefined ? reportDirFor(suiteDef.wave) : resolve(reportDirArg)
  for (const rel of [suiteDef.module, join(PACKAGE_ROOT, 'lib', 'index.js')]) {
    if (existsSync(rel)) fp.suite_files[rel] = sha256(readFileSync(rel))
  }
  const report = {
    schema_version: 1,
    runner: 'xuanling-blueprint/verify.mjs',
    plan_id: planIdArg ?? 'dsh-blueprint-plugin-v1',
    suite: suiteName,
    scope: scope ?? null,
    repeat,
    fingerprint: fp,
    evidence_fingerprint: evidenceBefore,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cwd: process.cwd(),
    },
    runs: [],
    started_at: new Date().toISOString(),
  }

  let allPassed = true
  let cleanCount = 0
  for (let i = 1; i <= repeat; i++) {
    const runStarted = new Date().toISOString()
    const runClock = performance.now()
    const runBefore = captureEvidenceFingerprint()
    let results
    try {
      results = await runSuiteOnce(suiteName, suiteDef, scope, {
        reportDir,
        planId: report.plan_id,
        evidenceFingerprint: evidenceBefore,
        evidenceManifestPath: evidenceManifestArg === undefined ? undefined : resolve(evidenceManifestArg),
      })
    } catch (error) {
      results = [errorResult(error)]
    }
    const runAfter = captureEvidenceFingerprint()
    const stable = evidenceEqual(evidenceBefore, runBefore) && evidenceEqual(runBefore, runAfter)
    if (!stable) results.push({ id: 'runner-stability', title: 'evidence remained stable', expect: 'pass', status: 'fail', reason_code: 'EVIDENCE_STALE', detail: 'evidence changed during verification' })
    const runOk = results.length > 0 && stable && results.every(r => r.status === 'pass' || r.status === 'expected-red')
    cleanCount = runOk ? cleanCount + 1 : 0
    allPassed = allPassed && runOk
    report.runs.push({
      index: i,
      started: runStarted,
      finished: new Date().toISOString(),
      passed: runOk,
      clean_acceptance_count: cleanCount,
      duration_ms: performance.now() - runClock,
      evidence_fingerprint: runBefore,
      evidence_fingerprint_after: runAfter,
      results,
    })
    for (const r of results) {
      process.stdout.write(`[${suiteName}#${i}] ${r.status.toUpperCase()} ${r.id}: ${r.title}${r.detail ? ` — ${r.detail}` : ''}\n`)
    }
  }

  report.finished_at = new Date().toISOString()
  report.evidence_fingerprint_after = captureEvidenceFingerprint()
  report.passed = allPassed && evidenceEqual(evidenceBefore, report.evidence_fingerprint_after)
  report.clean_acceptance_count = report.passed ? cleanCount : 0
  if (!report.passed && !evidenceEqual(evidenceBefore, report.evidence_fingerprint_after)) {
    for (const run of report.runs) run.clean_acceptance_count = 0
  }
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, `${suiteDef.wave.toLowerCase()}.${suiteName.replace(/[^a-z0-9-]/gi, '-')}-report.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const redCount = report.runs[0]?.results.filter(r => r.status === 'expected-red').length ?? 0
  process.stdout.write(`verify: suite ${suiteName} ${report.passed ? 'PASSED' : 'FAILED'} (${repeat} run(s), ${redCount} expected-red); report: ${reportPath}\n`)
  process.exit(report.passed ? 0 : 1)
}

const isDirectRun = (() => {
  // stdin/eval/import hosts can provide a non-file argv[1]. Exporting
  // helpers must not depend on that host entrypoint existing on disk.
  if (!process.argv[1] || process.argv[1] === '-') return false
  try {
    // Canonical paths preserve direct CLI execution through symlinks and
    // platforms with aliased temporary roots (e.g. /var -> /private/var).
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isDirectRun) {
  main().catch(() => {
    process.stderr.write('verify: fatal verification failure\n')
    process.exit(1)
  })
}
