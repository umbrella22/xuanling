// C-11: closed acceptance requirements, independent of the supplied manifest.
// Synthetic fixtures can calibrate this evaluator, NEVER prove live/OS gates.
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { VerificationNotRunError } from '../../scripts/verify.mjs'
import { validLiveBehaviorDetail, validPlatformBehaviorDetail, validLifecycleBehaviorDetail } from './behavior-evidence.mjs'

export const EVIDENCE_SCHEMA_VERSION = 1
const sequence = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)
const caseIds = {
  foundation: sequence('F', 10),
  definition: sequence('D', 10),
  resources: ['T03-R1', 'T03-R2', 'T03-R3', 'T04-R1', 'T04-R2', 'T04-R3', 'T16-R1', 'T03-R4'],
  runtime: sequence('RT', 12),
  host: ['H1'],
  api: sequence('A', 5),
  portability: sequence('P', 7),
  security: ['T16-S1', 'T16-S2', 'T16-H1', 'T16-H2', 'T16-P1', 'T16-U1'],
  recovery: sequence('RC', 4),
  critical: ['T11b', 'T04-R1', 'T04-R2', 'T04-R3', 'RT1', 'RT3', 'RT11', 'RC1', 'RC2', 'RC3'],
  browser: ['B1'],
  performance: ['PERF1'],
  platform: sequence('PL', 4),
  live: ['L1'],
  package: ['PK1'],
  lifecycle: sequence('PL', 7)
}
const scoped = new Set(['api', 'security', 'recovery', 'critical'])
const normalSuites = [
  'foundation',
  'definition',
  'resources',
  'runtime',
  'host',
  'api',
  'portability',
  'security',
  'recovery',
  'critical',
  'browser',
  'performance',
  'platform',
  'live',
  'package'
]
const spec = (id, suite, scope, extra = {}) =>
  Object.freeze({
    id,
    suite,
    scope,
    minimum_repeat: suite === 'critical' ? 3 : 1,
    required_cases: Object.freeze([...caseIds[suite]]),
    ...extra
  })
export const REQUIRED_GATES = Object.freeze([
  ...normalSuites.map(suite => spec(suite, suite, scoped.has(suite) ? 'all' : null)),
  ...['darwin', 'linux', 'win32'].map(platform => spec(`platform-${platform}`, 'platform', null, { platform })),
  ...['web', 'headless'].map(mode => spec(`lifecycle-${mode}`, 'lifecycle', mode))
])

export class AcceptanceEvidenceError extends Error {
  constructor(reasonCode, gateId = 'manifest') {
    // IDs only come from REQUIRED_GATES, NEVER from untrusted report content.
    super(`${reasonCode}:${gateId}`)
    this.name = 'AcceptanceEvidenceError'
    this.code = 'ACCEPTANCE_EVIDENCE_INVALID'
    this.reason_code = reasonCode
    this.gate_id = gateId
  }
}
const fail = (reason, id) => {
  throw new AcceptanceEvidenceError(reason, id)
}
const notRun = (reason, id = 'manifest') => {
  const error = new VerificationNotRunError(reason, `${reason}:${id}`)
  error.gate_id = id
  throw error
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positive = value => Number.isInteger(value) && value >= 1 && value <= 10
const reasonCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
const keysOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key))
export function validEvidenceFingerprint(value) {
  return (
    object(value) &&
    keysOnly(value, ['revision', 'source_sha256', 'artifact_sha256']) &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{40,64}$/.test(value.revision) &&
    hash(value.source_sha256) &&
    hash(value.artifact_sha256)
  )
}
export function equalEvidenceFingerprint(a, b) {
  return validEvidenceFingerprint(a) && validEvidenceFingerprint(b) && ['revision', 'source_sha256', 'artifact_sha256'].every(key => a[key] === b[key])
}

/** Schema and policy validation is separate from I/O; no report directory walk. */
export function validateEvidenceManifest(manifest, { planId, evidenceFingerprint }) {
  if (
    !object(manifest) ||
    !keysOnly(manifest, ['schema_version', 'plan_id', 'evidence_fingerprint', 'gates']) ||
    manifest.schema_version !== EVIDENCE_SCHEMA_VERSION ||
    !Array.isArray(manifest.gates) ||
    typeof manifest.plan_id !== 'string' ||
    !validEvidenceFingerprint(manifest.evidence_fingerprint)
  )
    fail('MANIFEST_SCHEMA_INVALID')
  if (!planId || manifest.plan_id !== planId) fail('WRONG_PLAN')
  if (!equalEvidenceFingerprint(manifest.evidence_fingerprint, evidenceFingerprint)) fail('EVIDENCE_STALE')
  const found = new Map()
  for (const gate of manifest.gates) {
    const required = REQUIRED_GATES.find(item => item.id === gate?.id)
    if (!required || found.has(required.id)) fail('GATE_ID_INVALID')
    const id = required.id
    if (
      !object(gate) ||
      !keysOnly(gate, ['id', 'suite', 'scope', 'minimum_repeat', 'status', 'path', 'sha256', 'reason_code']) ||
      gate.suite !== required.suite ||
      gate.scope !== required.scope ||
      !positive(gate.minimum_repeat) ||
      gate.minimum_repeat < required.minimum_repeat ||
      !['passed', 'not-run'].includes(gate.status)
    )
      fail('GATE_SCHEMA_INVALID', id)
    if (gate.status === 'not-run') {
      if (!reasonCode(gate.reason_code) || ![null, undefined].includes(gate.path) || ![null, undefined].includes(gate.sha256)) fail('GATE_SCHEMA_INVALID', id)
    } else if (typeof gate.path !== 'string' || gate.path.trim() === '' || !hash(gate.sha256) || gate.reason_code !== undefined) fail('GATE_SCHEMA_INVALID', id)
    found.set(id, gate)
  }
  // Missing entries are typed not-run, not permission to shrink requirements.
  return { gates: found, missing: REQUIRED_GATES.filter(item => !found.has(item.id)).map(item => item.id) }
}

function readJson(path, id, expectedHash) {
  // A manifest cannot turn the evaluator into a secret/docs reader. Do not
  // follow symlinks; only explicitly named JSON evidence files are accepted.
  if (typeof path !== 'string' || !/\.json$/i.test(path) || path.split(/[\\/]/).some(part => /^(?:key|docs)$/i.test(part))) fail('EVIDENCE_PATH_INVALID', id)
  let bytes
  try {
    const canonical = realpathSync(path)
    if (canonical.split(/[\\/]/).some(part => /^(?:key|docs)$/i.test(part)) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      fail('EVIDENCE_PATH_INVALID', id)
    bytes = readFileSync(path)
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error
    if (error.code === 'ENOENT') notRun(id === 'manifest' ? 'MANIFEST_MISSING' : 'GATE_MISSING', id)
    fail('EVIDENCE_UNREADABLE', id)
  }
  if (expectedHash !== undefined && createHash('sha256').update(bytes).digest('hex') !== expectedHash) fail('EVIDENCE_TAMPERED', id)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('EVIDENCE_JSON_INVALID', id)
  }
}

function validateReport(report, gate, required, context) {
  const id = required.id
  if (!object(report) || report.schema_version !== EVIDENCE_SCHEMA_VERSION) fail('REPORT_SCHEMA_INVALID', id)
  if (report.plan_id !== context.planId) fail('WRONG_PLAN', id)
  if (report.suite !== required.suite || report.scope !== required.scope) fail('REPORT_IDENTITY_INVALID', id)
  if (
    !equalEvidenceFingerprint(report.evidence_fingerprint, context.evidenceFingerprint) ||
    !equalEvidenceFingerprint(report.evidence_fingerprint_after, context.evidenceFingerprint)
  )
    fail('EVIDENCE_STALE', id)
  const missingEnvironment =
    report.environment === undefined || report.environment === null || (object(report.environment) && report.environment.platform === undefined)
  if (
    !missingEnvironment &&
    (!object(report.environment) ||
      typeof report.environment.platform !== 'string' ||
      !/^(?:darwin|linux|win32)\/[a-z0-9_]+$/.test(report.environment.platform))
  )
    fail('ENVIRONMENT_SCHEMA_INVALID', id)
  if (!missingEnvironment && required.platform && report.environment.platform.split('/')[0] !== required.platform) fail('PLATFORM_IDENTITY_INVALID', id)
  if (
    !positive(report.repeat) ||
    report.repeat < gate.minimum_repeat ||
    !Array.isArray(report.runs) ||
    report.runs.length !== report.repeat ||
    report.runs.length === 0
  )
    fail('REPEAT_OR_RUNS_INVALID', id)
  let sawNotRun = false
  let cleanCount = 0
  for (let i = 0; i < report.runs.length; i++) {
    const run = report.runs[i]
    if (!object(run) || run.index !== i + 1 || !Array.isArray(run.results) || run.results.length === 0) fail('EMPTY_OR_INVALID_RESULTS', id)
    if (
      !equalEvidenceFingerprint(run.evidence_fingerprint, context.evidenceFingerprint) ||
      !equalEvidenceFingerprint(run.evidence_fingerprint_after, context.evidenceFingerprint)
    )
      fail('EVIDENCE_STALE', id)
    const ids = new Set()
    let runNotRun = false
    for (const result of run.results) {
      if (!object(result) || typeof result.id !== 'string' || ids.has(result.id) || result.expect !== 'pass') fail('RESULT_SCHEMA_INVALID', id)
      ids.add(result.id)
      if (result.status === 'not-run' && reasonCode(result.reason_code)) runNotRun = true
      else if (result.status !== 'pass') fail('RESULT_FAILED', id)
      else {
        // A green status/ID is not behavioral evidence. Never fall back to
        // report/case-level metadata when the detail receipt is missing.
        if (required.suite === 'live' && result.id === 'L1' && !validLiveBehaviorDetail(result.detail)) fail('LIVE_BEHAVIOR_INVALID', id)
        if (required.suite === 'platform' && result.id === 'PL1') {
          // Missing environment stays typed not-run, but malformed PL1 is
          // still a known failure and must not be masked by that gap.
          const claimedEnvironment = missingEnvironment ? `${result.detail?.platform}/${result.detail?.arch}` : report.environment.platform
          if (!validPlatformBehaviorDetail(result.detail, claimedEnvironment)) fail('PLATFORM_BEHAVIOR_INVALID', id)
        }
        if (required.suite === 'lifecycle' && required.required_cases.includes(result.id) && !validLifecycleBehaviorDetail(result.detail, result.id, report))
          fail('LIFECYCLE_BEHAVIOR_INVALID', id)
      }
    }
    if (required.required_cases.some(caseId => !ids.has(caseId))) fail('REQUIRED_CASE_MISSING', id)
    if (runNotRun) {
      if (run.passed !== false || run.clean_acceptance_count !== 0 || report.passed !== false) fail('FALSE_NOT_RUN_PASS', id)
      sawNotRun = true
      cleanCount = 0
    } else {
      cleanCount++
      if (run.passed !== true || run.clean_acceptance_count !== cleanCount) fail('NONCONTIGUOUS_GREEN', id)
    }
  }
  if (sawNotRun) {
    if (report.clean_acceptance_count !== 0) fail('FALSE_NOT_RUN_PASS', id)
    notRun('GATE_NOT_RUN', id)
  }
  if (report.passed !== true || report.clean_acceptance_count !== report.repeat) fail('REPORT_FAILED', id)
  if (missingEnvironment) notRun('ENVIRONMENT_MISSING', id)
}

export function evaluateEvidenceManifest({ evidenceManifestPath, planId, evidenceFingerprint }) {
  if (!evidenceManifestPath) notRun('MANIFEST_MISSING')
  const path = resolve(evidenceManifestPath)
  const manifest = readJson(path, 'manifest')
  const context = { planId, evidenceFingerprint }
  const { gates, missing } = validateEvidenceManifest(manifest, context)
  // Inspect all supplied gates first: a known failed/tampered/stale receipt
  // must not be masked by a missing environment or another not-run entry.
  let pending = missing.length ? { reason: 'GATE_MISSING', id: missing[0] } : null
  for (const required of REQUIRED_GATES) {
    const gate = gates.get(required.id)
    if (!gate) continue
    if (gate.status === 'not-run') {
      pending ??= { reason: 'GATE_NOT_RUN', id: required.id }
      continue
    }
    try {
      const report = readJson(resolve(dirname(path), gate.path), required.id, gate.sha256)
      validateReport(report, gate, required, context)
    } catch (error) {
      if (!(error instanceof VerificationNotRunError)) throw error
      pending ??= { reason: error.reasonCode, id: required.id }
    }
  }
  if (pending) notRun(pending.reason, pending.id)
  return { ok: true, schema_version: EVIDENCE_SCHEMA_VERSION, checked_gates: REQUIRED_GATES.length }
}
