// PK1 collects both modes in this invocation. Historical receipts, exit-zero
// placeholders and synthetic evaluator fixtures are never lifecycle evidence.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { equalEvidenceFingerprint, validEvidenceFingerprint } from '../acceptance/evidence-manifest.mjs'
import { LIFECYCLE_BEHAVIOR_FLAGS, validLifecycleBehaviorDetail } from '../acceptance/behavior-evidence.mjs'

const PROCESS_TIMEOUT_MS = 20 * 60_000 // Existing package gate bound, not increased.
// The child owns detached CLI groups and their 5s disposal/escalation. Allow
// that bounded cleanup to finish before killing the collector itself; this
// does not extend the 20-minute execution deadline.
const STOP_GRACE_MS = 10_000
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export class LifecycleEvidenceError extends Error {
  constructor(code) {
    super(`Lifecycle evidence rejected (${code})`)
    this.name = 'LifecycleEvidenceError'
    this.code = code
    this.reason_code = code
    this.reasonCode = code
  }
}
const fail = code => {
  throw new LifecycleEvidenceError(code)
}

// No key/proxy/auth/NODE_OPTIONS/npm credential inheritance. The collector
// provisions its own HOME, tools and profile; it never opens a user profile.
function childEnvironment(home) {
  const env = { HOME: home, DSH_HOME: join(home, 'dsh'), NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

async function runLifecycle(script, mode, reportDir, planId, cwd, env) {
  // The separate process group includes npm/pnpm descendants. Timeout and
  // cancellation join child exit before receipts can be read or profiles removed.
  const child = spawn(process.execPath, [script, '--mode', mode, '--report-dir', reportDir, '--plan-id', planId], {
    cwd,
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  })
  let timedOut = false,
    spawnError = false,
    interrupted = false,
    escalation
  const signalGroup = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      /* exit may have won the signal race */
    }
  }
  const stop = () => {
    if (escalation !== undefined) return
    // Signal only the lifecycle supervisor first. It joins its separately
    // supervised CLI groups before it exits. Never read a receipt on timeout.
    signalGroup('SIGTERM')
    escalation = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS)
  }
  const onSignal = () => {
    interrupted = true
    stop()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  const deadline = setTimeout(() => {
    timedOut = true
    stop()
  }, PROCESS_TIMEOUT_MS)
  const result = await new Promise(resolveExit => {
    child.once('error', () => {
      spawnError = true
    })
    child.once('close', (status, signal) => resolveExit({ status, signal }))
  })
  clearTimeout(deadline)
  clearTimeout(escalation)
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  // Check status AND signal AND spawn/timeout failure before opening any file.
  if (spawnError || timedOut || interrupted || result.status !== 0 || result.signal !== null) fail('LIFECYCLE_PROCESS_FAILED')
}

function regularFreshFile(path, directory) {
  const rel = relative(resolve(directory), resolve(path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  try {
    // Canonicalize only the owned root (e.g. macOS /var -> /private/var);
    // reject symlink files/components or an artifact escaping that root.
    return lstatSync(path).isFile() && realpathSync(path) === join(realpathSync(directory), rel)
  } catch {
    return false
  }
}

function validTimes(value) {
  const start = Date.parse(value.started_at ?? value.started),
    finish = Date.parse(value.finished_at ?? value.finished)
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start
}

function readFreshReceipt(reportDir, mode, planId, expectedFingerprint) {
  const reportPath = join(reportDir, `w8.lifecycle-${mode}-report.json`)
  if (!regularFreshFile(reportPath, reportDir)) fail('LIFECYCLE_RECEIPT_MISSING')
  let report, receiptBytes
  try {
    receiptBytes = readFileSync(reportPath)
    report = JSON.parse(receiptBytes.toString('utf8'))
  } catch {
    fail('LIFECYCLE_RECEIPT_INVALID')
  }
  const fpEqual = fp => validEvidenceFingerprint(fp) && validEvidenceFingerprint(expectedFingerprint) && equalEvidenceFingerprint(fp, expectedFingerprint)
  if (
    !object(report) ||
    report.schema_version !== 1 ||
    report.plan_id !== planId ||
    report.suite !== 'lifecycle' ||
    report.scope !== mode ||
    report.mode !== mode ||
    report.passed !== true ||
    !object(report.environment) ||
    report.environment.platform !== `${process.platform}/${process.arch}` ||
    !fpEqual(report.evidence_fingerprint) ||
    !fpEqual(report.evidence_fingerprint_after) ||
    !Number.isInteger(report.repeat) ||
    report.repeat < 1 ||
    report.repeat > 10 ||
    report.clean_acceptance_count !== report.repeat ||
    !Array.isArray(report.runs) ||
    report.runs.length !== report.repeat ||
    !validTimes(report)
  )
    fail('LIFECYCLE_RECEIPT_INVALID')

  const required = Object.keys(LIFECYCLE_BEHAVIOR_FLAGS)
  for (const [index, run] of report.runs.entries()) {
    if (
      !object(run) ||
      run.index !== index + 1 ||
      run.passed !== true ||
      run.clean_acceptance_count !== index + 1 ||
      !fpEqual(run.evidence_fingerprint) ||
      !fpEqual(run.evidence_fingerprint_after) ||
      !validTimes(run) ||
      !Array.isArray(run.results) ||
      run.results.length !== required.length
    )
      fail('LIFECYCLE_RECEIPT_INVALID')
    const seen = new Set()
    for (const result of run.results) {
      if (
        !object(result) ||
        !required.includes(result.id) ||
        seen.has(result.id) ||
        result.expect !== 'pass' ||
        result.status !== 'pass' ||
        !validLifecycleBehaviorDetail(result.detail, result.id, report)
      )
        fail('LIFECYCLE_BEHAVIOR_INVALID')
      seen.add(result.id)
    }
    if (seen.size !== required.length) fail('LIFECYCLE_BEHAVIOR_INVALID')
  }
  const artifact = report.artifacts?.tarball
  if (!object(artifact) || typeof artifact.path !== 'string' || artifact.path.trim() === '') fail('LIFECYCLE_ARTIFACT_INVALID')
  const artifactPath = isAbsolute(artifact.path) ? artifact.path : resolve(reportDir, artifact.path)
  if (!regularFreshFile(artifactPath, reportDir)) fail('LIFECYCLE_ARTIFACT_INVALID')
  let bytes
  try {
    bytes = readFileSync(artifactPath)
  } catch {
    fail('LIFECYCLE_ARTIFACT_INVALID')
  }
  if (bytes.length === 0 || sha256(bytes) !== artifact.sha256) fail('LIFECYCLE_ARTIFACT_INVALID')
  return { mode, receipt_sha256: sha256(receiptBytes), artifact_sha256: artifact.sha256 }
}

export async function getCases(helpers) {
  const { packageRoot, repoRoot, reportDir, planId, evidenceFingerprint, VerificationNotRunError } = helpers
  return [
    {
      id: 'PK1',
      title: 'T17: fresh packed web and headless lifecycle (install, ping, disable, uninstall, baseline intact)',
      contract: 'C-17',
      expect: 'pass',
      run: async () => {
        if (!existsSync(join(packageRoot, 'lib', 'index.js'))) {
          if (VerificationNotRunError) throw new VerificationNotRunError('LIFECYCLE_ARTIFACT_MISSING', 'A Main-built plugin artifact is required')
          fail('LIFECYCLE_ARTIFACT_MISSING')
        }
        if (typeof reportDir !== 'string' || typeof planId !== 'string' || planId === '') fail('LIFECYCLE_CONTEXT_INVALID')
        const root = resolve(reportDir)
        mkdirSync(root, { recursive: true })
        const executionDir = mkdtempSync(join(root, 'lifecycle-fresh-'))
        const cwd = join(repoRoot, 'test', 'blueprint'),
          script = join(cwd, 'capabilities', 'lifecycle.mjs')
        const receipts = []
        for (const mode of ['web', 'headless']) {
          const modeDir = join(executionDir, mode),
            home = join(executionDir, `launcher-home-${mode}`)
          mkdirSync(home)
          await runLifecycle(script, mode, modeDir, planId, cwd, childEnvironment(home))
          receipts.push(readFreshReceipt(modeDir, mode, planId, evidenceFingerprint))
        }
        // Only owned fields; no child logs, arbitrary receipt body, URL or auth.
        return { ok: true, detail: { modes: receipts, freshReceiptsValidated: true } }
      }
    }
  ]
}
