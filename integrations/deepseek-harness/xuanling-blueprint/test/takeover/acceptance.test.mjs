// W1 C-11: controlled negative acceptance oracle, NEVER a live-provider run.
// The production live suite is exercised through the runner; this is a
// controlled negative, not evidence of a real provider journey.
// No real credential is inherited; network entry points are disabled in the
// child before importing the suite. lib/index.js must already exist (the
// main agent owns build). Source behavior tests live in the other W1 files.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCases, captureEvidenceFingerprint, VerificationNotRunError } from '../../scripts/verify.mjs'
import { REQUIRED_GATES, validateEvidenceManifest, evaluateEvidenceManifest, AcceptanceEvidenceError } from '../acceptance/evidence-manifest.mjs'
import { createNotRunEvidenceManifest } from '../acceptance/manifest.example.mjs'
import { LIVE_BEHAVIOR_FLAGS, LIVE_BEHAVIOR_IDS, LIFECYCLE_BEHAVIOR_FLAGS } from '../acceptance/behavior-evidence.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = resolve(packageRoot, '../../..')
const runner = join(packageRoot, 'scripts/verify.mjs')
const oldReports = join(repoRoot, 'test/blueprint/reports/w7')
const placeholder = 'takeover-placeholder-not-a-provider-key'

function reportHashes(root) {
  if (!existsSync(root)) return {}
  const result = {}
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name)
    if (item.isDirectory()) Object.assign(result, reportHashes(path))
    else if (item.isFile()) result[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return result
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-takeover-acceptance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Whitelist environment instead of copying process.env; in particular do
  // not inherit user's model keys, proxy credentials, NODE_OPTIONS or HOME.
  const env = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh'), TMPDIR: root }
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  mkdirSync(env.HOME)
  mkdirSync(env.DSH_HOME)
  const networkLog = join(root, 'network-attempts.txt')
  const preload = join(root, 'no-network.mjs')
  writeFileSync(
    preload,
    `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  writeFileSync(${JSON.stringify(networkLog)}, 'blocked network attempt\\n', { flag: 'a' });
  const error = new Error('network disabled for controlled takeover oracle');
  error.code = 'TAKEOVER_NETWORK_DISABLED';
  throw error;
};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
dgram.createSocket = deny;
dns.lookup = dns.resolve = deny;
dns.promises.lookup = dns.promises.resolve = deny;
syncBuiltinESMExports();
`
  )
  return { root, env, preload, networkLog }
}

function invoke(f, args, extraEnv = {}) {
  assert.equal(existsSync(join(packageRoot, 'lib/index.js')), true, 'W0 build prerequisite missing: this is NOT a valid product red')
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(f.preload).href, runner, ...args], {
    cwd: packageRoot,
    env: { ...f.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 20_000
  })
  assert.equal(child.error, undefined, `runner launch failure is NOT a valid product red: ${child.error}`)
  assert.equal(child.signal, null, 'timeout/signal is NOT a valid product red')
  return child
}

function reportAt(dir) {
  const path = join(dir, 'w7.live-report.json')
  assert.equal(existsSync(path), true, 'explicit route must create a report, not silently fall back to historical w7')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertOldReportsUnchanged(before) {
  assert.deepEqual(reportHashes(oldReports), before, 'REPORT_ROUTE_HISTORY_UNCHANGED: W1 must not overwrite or add historical w7 reports')
}

test('C-11 controlled placeholder + import-only live case must NOT produce a passed report (NOT real live)', t => {
  const f = fixture(t)
  const before = reportHashes(oldReports)
  const reportDir = join(f.root, 'isolated-placeholder-report')
  const child = invoke(f, ['--suite', 'live', '--report-dir', reportDir, '--plan-id', 'dsh-blueprint-takeover-v1'], {
    BP_LIVE_PROVIDER_KEY: placeholder,
    BP_LIVE_PROVIDER_BASE_URL: 'http://127.0.0.1:9'
  })
  assertOldReportsUnchanged(before)
  const report = reportAt(reportDir)
  assert.equal(report.plan_id, 'dsh-blueprint-takeover-v1')
  assert.equal(report.suite, 'live')
  assert.equal(report.runs.length, 1)
  assert.equal(report.runs[0].results[0].id, 'L1', 'must reach the actual live case, not a runner import failure')
  // Before the fix, there is no network attempt and L1 passes with the detail
  // "journey harness ready". The diagnostic message preserves that finding;
  // an actual future guarded call may try network and must still not pass.
  const networkAttempts = existsSync(f.networkLog) ? readFileSync(f.networkLog, 'utf8').trim() : 'none'
  t.diagnostic(
    JSON.stringify({
      oracle: 'controlled-placeholder-not-live',
      report_path: join(reportDir, 'w7.live-report.json'),
      plan_id: report.plan_id,
      passed: report.passed,
      network_attempts: networkAttempts,
      old_reports_unchanged: true
    })
  )
  assert.equal(
    report.passed,
    false,
    `FALSE_LIVE_PASS: a controlled placeholder/import-only run cannot prove a live journey; status=${child.status}; L1=${JSON.stringify(report.runs[0].results[0])}; networkAttempts=${networkAttempts}`
  )
  assert.notEqual(child.status, 0, 'invalid placeholder must not exit with a passed live gate')
})

test('control: report routing preserves explicit missing-credentials not-run and never touches old reports', t => {
  const f = fixture(t)
  const before = reportHashes(oldReports)
  const reportDir = join(f.root, 'explicit-no-key-report')
  const child = invoke(f, ['--suite', 'live', '--report-dir', reportDir, '--plan-id', 'dsh-blueprint-takeover-v1'])
  assertOldReportsUnchanged(before)
  const report = reportAt(reportDir)
  assert.equal(child.status, 1)
  assert.equal(report.passed, false)
  assert.equal(report.plan_id, 'dsh-blueprint-takeover-v1')
  assert.equal(report.scope, null)
  assert.equal(report.repeat, 1)
  assert.equal(report.runs[0].clean_acceptance_count, 0)
  assert.equal(report.runs[0].results[0].status, 'not-run')
  assert.match(report.runs[0].results[0].reason_code, /^[A-Z][A-Z0-9_]+$/)
  assert.equal(existsSync(f.networkLog), false)
  t.diagnostic(
    JSON.stringify({
      oracle: 'missing-credentials-routing',
      report_path: join(reportDir, 'w7.live-report.json'),
      plan_id: report.plan_id,
      passed: report.passed,
      exit_code: child.status,
      old_reports_unchanged: true
    })
  )
})

test('control: explicit report-dir with default plan-id and equals-form options preserves suite outcomes', t => {
  const f = fixture(t)
  const before = reportHashes(oldReports)
  const defaultDir = join(f.root, 'default-plan-id')
  const child = invoke(f, ['--suite=live', `--report-dir=${defaultDir}`])
  assert.equal(child.status, 1)
  assert.equal(reportAt(defaultDir).plan_id, 'dsh-blueprint-plugin-v1', 'no plan-id retains the old default')
  const explicitDir = join(f.root, 'equals-options')
  const explicit = invoke(f, ['--suite=live', `--report-dir=${explicitDir}`, '--plan-id=dsh-blueprint-takeover-v1'])
  assert.equal(explicit.status, 1)
  assert.equal(reportAt(explicitDir).plan_id, 'dsh-blueprint-takeover-v1')
  t.diagnostic(
    JSON.stringify({
      oracle: 'equals-routing-and-default-plan-id',
      default_plan_report_path: join(defaultDir, 'w7.live-report.json'),
      default_plan_id: reportAt(defaultDir).plan_id,
      explicit_report_path: join(explicitDir, 'w7.live-report.json'),
      explicit_plan_id: reportAt(explicitDir).plan_id
    })
  )
  assertOldReportsUnchanged(before)
})

test('control: malformed routing values reject before running cases or writing any report', t => {
  const f = fixture(t)
  const before = reportHashes(oldReports)
  for (const suffix of [['--report-dir'], ['--plan-id'], ['--report-dir='], ['--plan-id='], ['--report-dir', '--plan-id', 'id']]) {
    const child = invoke(f, ['--suite', 'live', ...suffix])
    assert.equal(child.status, 2)
    assert.match(child.stderr, /requires a non-empty value/)
  }
  assertOldReportsUnchanged(before)
})

test('control: original pass/expected-red/wrong-red/no-evidence classification remains unchanged', async () => {
  const results = await runCases([
    { id: 'pass', expect: 'pass', run: () => ({ ok: true }) },
    { id: 'no-evidence', expect: 'pass', run: () => undefined },
    {
      id: 'named-red',
      expect: 'red',
      redCode: 'TEST_DENIED',
      run: () => {
        throw Object.assign(new Error('denied'), { code: 'TEST_DENIED' })
      }
    },
    {
      id: 'wrong-red',
      expect: 'red',
      redCode: 'TEST_DENIED',
      run: () => {
        throw new Error('unrelated')
      }
    },
    { id: 'unexpected-green', expect: 'red', redCode: 'TEST_DENIED', run: () => ({ ok: true }) }
  ])
  assert.deepEqual(
    results.map(result => result.status),
    ['pass', 'fail', 'expected-red', 'fail', 'fail']
  )
})

// C-11 regression: a historical green flag with no current behavioral
// evidence must NEVER satisfy the acceptance required-gates oracle.
test('acceptance rejects historical top-level green empty wrong-plan reports', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-old-aggregator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = [
    'w0/w0.2-probe-report.json',
    'w2/w2.definition-report.json',
    'w2/w2.resources-report.json',
    'w2/w2.security-report.json',
    'w2/w2.critical-report.json',
    'w3/w3.runtime-report.json',
    'w3/w3.recovery-report.json',
    'w4/w4.host-report.json',
    'w4/w4.api-report.json',
    'w5/w5.portability-report.json',
    'w6/w6.browser-report.json',
    'w7/w7.platform-report.json',
    'w8/w8.lifecycle-report.json'
  ]
  for (const rel of old) {
    const path = join(root, 'test/blueprint/reports', rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ passed: true, plan_id: 'obsolete-plan', runs: [], assertions: [] }))
  }
  const { getCases } = await import('../acceptance/acceptance.mjs')
  const cases = await getCases({ repoRoot: root, planId: 'dsh-blueprint-takeover-v1' })
  // Before the fix AC2 is the required-gates case; after the fix the sole
  // explicit-manifest oracle owns that contract. No test weakening.
  const oracle = cases.find(c => c.id === 'AC2') ?? cases[0]
  const [result] = await runCases([oracle])
  t.diagnostic(JSON.stringify({ oracle: 'historical-green-empty-wrong-plan', status: result.status }))
  assert.notEqual(result.status, 'pass', 'FALSE_ACCEPTANCE_PASS: top-level passed on historical empty/wrong-plan reports is not current evidence')
})

const syntheticFingerprint = Object.freeze({ revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) })
const syntheticPlan = 'synthetic-evaluator-calibration-only'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

// Explicitly synthetic receipts, not a network/platform execution claim.
function syntheticLiveDetail() {
  return {
    ok: true,
    behavior_assertions: {
      runId: 'synthetic-run',
      attemptId: 'synthetic-model',
      downstreamAttemptId: 'synthetic-downstream',
      sessionId: 'bp-synthetic-run-synthetic-model-session',
      ...Object.fromEntries(LIVE_BEHAVIOR_FLAGS.map(key => [key, true])),
      output_sha256: 'd'.repeat(64),
      nonce_sha256: 'd'.repeat(64)
    }
  }
}
function syntheticDetail(required, caseId) {
  if (required.suite === 'live') return syntheticLiveDetail()
  if (required.suite === 'platform' && caseId === 'PL1') return { ok: true, platform: required.platform ?? 'darwin', arch: 'arm64' }
  if (required.suite === 'lifecycle')
    return {
      ok: true,
      mode: required.scope,
      artifact_sha256: 'e'.repeat(64),
      behavior_assertions: Object.fromEntries(LIFECYCLE_BEHAVIOR_FLAGS[caseId].map(key => [key, true]))
    }
  return true
}

// Only temporary SYNTHETIC reports: never the product's evidence directory.
function evaluatorFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-synthetic-evaluator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = { schema_version: 1, plan_id: syntheticPlan, evidence_fingerprint: { ...syntheticFingerprint }, gates: [] }
  const reports = new Map()
  const writeGate = id => {
    const gate = manifest.gates.find(g => g.id === id)
    const bytes = JSON.stringify(reports.get(id))
    writeFileSync(join(root, gate.path), bytes)
    gate.sha256 = digest(bytes)
  }
  for (const required of REQUIRED_GATES) {
    const gate = {
      id: required.id,
      suite: required.suite,
      scope: required.scope,
      minimum_repeat: required.minimum_repeat,
      status: 'passed',
      path: `${required.id}.json`,
      sha256: null
    }
    manifest.gates.push(gate)
    const repeat = required.minimum_repeat
    reports.set(required.id, {
      schema_version: 1,
      plan_id: syntheticPlan,
      suite: required.suite,
      scope: required.scope,
      repeat,
      passed: true,
      clean_acceptance_count: repeat,
      environment: { platform: `${required.platform ?? 'darwin'}/arm64` },
      ...(required.suite === 'lifecycle' ? { mode: required.scope, artifacts: { tarball: { path: 'synthetic-only.tgz', sha256: 'e'.repeat(64) } } } : {}),
      evidence_fingerprint: { ...syntheticFingerprint },
      evidence_fingerprint_after: { ...syntheticFingerprint },
      runs: Array.from({ length: repeat }, (_, i) => ({
        index: i + 1,
        passed: true,
        clean_acceptance_count: i + 1,
        evidence_fingerprint: { ...syntheticFingerprint },
        evidence_fingerprint_after: { ...syntheticFingerprint },
        results: required.required_cases.map(id => ({ id, expect: 'pass', status: 'pass', detail: syntheticDetail(required, id) }))
      }))
    })
    writeGate(required.id)
  }
  const path = join(root, 'synthetic-manifest.json')
  const evaluate = () => {
    writeFileSync(path, JSON.stringify(manifest))
    return evaluateEvidenceManifest({ evidenceManifestPath: path, planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint })
  }
  return { root, path, manifest, reports, writeGate, evaluate }
}

function assertTypedFailure(fn, reason) {
  assert.throws(fn, error => error instanceof AcceptanceEvidenceError && error.reason_code === reason)
}
function assertNotRun(fn, reason) {
  assert.throws(fn, error => error instanceof VerificationNotRunError && error.code === 'VERIFICATION_NOT_RUN' && error.reasonCode === reason)
}

test('acceptance rejects a critical report that omits workspace write policy evidence', t => {
  const fixture = evaluatorFixture(t)
  const critical = fixture.reports.get('critical')
  for (const run of critical.runs) run.results = run.results.filter(result => result.id !== 'T11b')
  fixture.writeGate('critical')
  assertTypedFailure(fixture.evaluate, 'REQUIRED_CASE_MISSING')
})

test('synthetic evaluator only: fixed complete manifest validates; does NOT prove live/OS/lifecycle', t => {
  const f = evaluatorFixture(t)
  assert.equal(f.evaluate().ok, true)
  assert.equal(REQUIRED_GATES.length, 20)
  const expected = [
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
    'package',
    'platform-darwin',
    'platform-linux',
    'platform-win32',
    'lifecycle-web',
    'lifecycle-headless'
  ]
  assert.deepEqual(
    REQUIRED_GATES.map(g => g.id),
    expected
  )
  assert.equal(REQUIRED_GATES.find(g => g.id === 'critical').minimum_repeat, 3)
})

// Main review regressions: these MUST fail against the pre-review evaluator.
for (const [label, gateId, mutate, reason] of [
  [
    'live import-only detail',
    'live',
    report => {
      report.runs[0].results[0].detail = 'ready/import-only'
    },
    'LIVE_BEHAVIOR_INVALID'
  ],
  [
    'live top-level forged behavior',
    'live',
    report => {
      report.behavior_assertions = { runSucceeded: true, nonceMatched: true }
      report.runs[0].results[0].behavior_assertions = report.behavior_assertions
      report.runs[0].results[0].detail = 'ready/import-only'
    },
    'LIVE_BEHAVIOR_INVALID'
  ],
  [
    'OS PL1 contradicts environment',
    'platform-linux',
    report => {
      report.runs[0].results[0].detail = { ok: true, platform: 'darwin', arch: 'arm64' }
    },
    'PLATFORM_BEHAVIOR_INVALID'
  ],
  [
    'lifecycle top-level green lacks behaviors',
    'lifecycle-web',
    report => {
      report.mode = 'web'
      report.artifacts = { tarball: { path: 'synthetic.tgz', sha256: 'd'.repeat(64) } }
      for (const result of report.runs[0].results) result.detail = { ok: true }
    },
    'LIFECYCLE_BEHAVIOR_INVALID'
  ]
]) {
  test(`review regression: rejects ${label}`, t => {
    const f = evaluatorFixture(t)
    mutate(f.reports.get(gateId))
    f.writeGate(gateId)
    assertTypedFailure(f.evaluate, reason)
  })
}

for (const key of [...LIVE_BEHAVIOR_FLAGS, ...LIVE_BEHAVIOR_IDS, 'output_sha256', 'nonce_sha256']) {
  test(`live negative: rejects missing ${key} despite green status`, t => {
    const f = evaluatorFixture(t)
    delete f.reports.get('live').runs[0].results[0].detail.behavior_assertions[key]
    f.writeGate('live')
    assertTypedFailure(f.evaluate, 'LIVE_BEHAVIOR_INVALID')
  })
}
for (const key of LIVE_BEHAVIOR_FLAGS) {
  test(`live negative: rejects false ${key}`, t => {
    const f = evaluatorFixture(t)
    f.reports.get('live').runs[0].results[0].detail.behavior_assertions[key] = false
    f.writeGate('live')
    assertTypedFailure(f.evaluate, 'LIVE_BEHAVIOR_INVALID')
  })
}
for (const [label, mutate] of [
  [
    'different nonce digest',
    facts => {
      facts.nonce_sha256 = 'f'.repeat(64)
    }
  ],
  [
    'malformed output digest',
    facts => {
      facts.output_sha256 = 'not-a-digest'
    }
  ],
  [
    'unrelated session',
    facts => {
      facts.sessionId = 'bp-unrelated-run-model-session'
    }
  ],
  [
    'no session suffix',
    facts => {
      facts.sessionId = `bp-${facts.runId}-${facts.attemptId}-`
    }
  ],
  [
    'same downstream attempt',
    facts => {
      facts.downstreamAttemptId = facts.attemptId
    }
  ],
  [
    'empty run identity',
    facts => {
      facts.runId = ''
    }
  ],
  [
    'truthy instead of true',
    facts => {
      facts.runSucceeded = 1
    }
  ]
]) {
  test(`live negative: rejects ${label}`, t => {
    const f = evaluatorFixture(t)
    mutate(f.reports.get('live').runs[0].results[0].detail.behavior_assertions)
    f.writeGate('live')
    assertTypedFailure(f.evaluate, 'LIVE_BEHAVIOR_INVALID')
  })
}
for (const mode of ['web', 'headless']) {
  for (const [caseId, flags] of Object.entries(LIFECYCLE_BEHAVIOR_FLAGS)) {
    for (const flag of flags) {
      test(`lifecycle negative: ${mode} rejects missing ${caseId}.${flag}`, t => {
        const f = evaluatorFixture(t)
        const id = `lifecycle-${mode}`
        const result = f.reports.get(id).runs[0].results.find(r => r.id === caseId)
        delete result.detail.behavior_assertions[flag]
        f.writeGate(id)
        assertTypedFailure(f.evaluate, 'LIFECYCLE_BEHAVIOR_INVALID')
      })
    }
  }
}
for (const [label, mutate] of [
  [
    'missing mode',
    report => {
      delete report.mode
    }
  ],
  [
    'other mode',
    report => {
      report.mode = 'headless'
    }
  ],
  [
    'other case mode',
    report => {
      report.runs[0].results[3].detail.mode = 'headless'
    }
  ],
  [
    'missing tarball',
    report => {
      delete report.artifacts
    }
  ],
  [
    'malformed artifact digest',
    report => {
      report.artifacts.tarball.sha256 = 'not-a-digest'
    }
  ],
  [
    'empty artifact locator',
    report => {
      report.artifacts.tarball.path = ''
    }
  ],
  [
    'different installed artifact',
    report => {
      report.runs[0].results[2].detail.artifact_sha256 = 'f'.repeat(64)
    }
  ],
  [
    'false behavior behind green status',
    report => {
      report.runs[0].results[4].detail.behavior_assertions.uninstalled = false
    }
  ]
]) {
  test(`lifecycle negative: rejects ${label}`, t => {
    const f = evaluatorFixture(t)
    mutate(f.reports.get('lifecycle-web'))
    f.writeGate('lifecycle-web')
    assertTypedFailure(f.evaluate, 'LIFECYCLE_BEHAVIOR_INVALID')
  })
}
for (const platform of ['darwin', 'linux', 'win32']) {
  test(`platform negative: ${platform} rejects missing PL1 behavior and false arch`, t => {
    const f = evaluatorFixture(t)
    const id = `platform-${platform}`
    const result = f.reports.get(id).runs[0].results[0]
    const original = result.detail
    result.detail = 'ready/import-only'
    f.writeGate(id)
    assertTypedFailure(f.evaluate, 'PLATFORM_BEHAVIOR_INVALID')
    result.detail = { ...original, arch: 'forged_arch' }
    f.writeGate(id)
    assertTypedFailure(f.evaluate, 'PLATFORM_BEHAVIOR_INVALID')
  })
}

test('runner: L1 complete structured facts survive without truncation; import-only/top-level metadata fail and raw fields are dropped', async () => {
  const detail = syntheticLiveDetail()
  const [green] = await runCases([
    {
      id: 'L1',
      expect: 'pass',
      run: () => ({
        ...detail,
        detail: 'PRIVATE_PROVIDER_RAW_KEY',
        raw: 'PRIVATE_PROVIDER_RAW_KEY',
        behavior_assertions: { ...detail.behavior_assertions, raw: 'PRIVATE_PROVIDER_RAW_KEY' }
      })
    }
  ])
  assert.equal(green.status, 'pass')
  assert.deepEqual(green.detail, detail)
  assert.ok(JSON.stringify(green.detail).length > 200)
  assert.doesNotMatch(JSON.stringify(green), /PRIVATE_PROVIDER_RAW_KEY/)
  for (const value of [{ ok: true, detail: 'ready/import-only' }, { ok: true }, true]) {
    const [negative] = await runCases([{ id: 'L1', expect: 'pass', behavior_assertions: detail.behavior_assertions, run: () => value }])
    assert.equal(negative.status, 'fail')
    assert.equal(negative.reason_code, 'LIVE_BEHAVIOR_INVALID')
  }
})

test('runner: PL1 platform receipt is structured without temporary path/200-character truncation', async () => {
  const [result] = await runCases([{ id: 'PL1', expect: 'pass', run: () => ({ ok: true, platform: 'win32', arch: 'x64', tmp: 'x'.repeat(500) }) }])
  assert.deepEqual(result.detail, { ok: true, platform: 'win32', arch: 'x64' })
})

test('acceptance: no manifest, missing file/gate/env and explicit gaps are typed not-run, never green', t => {
  assertNotRun(() => evaluateEvidenceManifest({ planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint }), 'MANIFEST_MISSING')
  const f = evaluatorFixture(t)
  assertNotRun(
    () => evaluateEvidenceManifest({ evidenceManifestPath: f.path, planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint }),
    'MANIFEST_MISSING'
  )
  const last = f.manifest.gates.pop()
  assertNotRun(f.evaluate, 'GATE_MISSING')
  f.manifest.gates.push(last)
  rmSync(join(f.root, last.path))
  assertNotRun(f.evaluate, 'GATE_MISSING')
  f.writeGate(last.id)
  const report = f.reports.get('foundation')
  delete report.environment
  f.writeGate('foundation')
  assertNotRun(f.evaluate, 'ENVIRONMENT_MISSING')
  report.environment = { platform: 'darwin/arm64' }
  f.writeGate('foundation')
  Object.assign(last, { status: 'not-run', reason_code: 'ENVIRONMENT_UNAVAILABLE', path: null, sha256: null })
  assertNotRun(f.evaluate, 'GATE_NOT_RUN')
})

for (const [label, reason, mutate] of [
  [
    'wrong manifest plan',
    'WRONG_PLAN',
    f => {
      f.manifest.plan_id = 'old-plan'
    }
  ],
  [
    'stale manifest source',
    'EVIDENCE_STALE',
    f => {
      f.manifest.evidence_fingerprint.source_sha256 = 'd'.repeat(64)
    }
  ],
  [
    'bad manifest schema',
    'MANIFEST_SCHEMA_INVALID',
    f => {
      f.manifest.schema_version = 2
    }
  ],
  [
    'duplicate required ID',
    'GATE_ID_INVALID',
    f => {
      f.manifest.gates.push({ ...f.manifest.gates[0] })
    }
  ],
  [
    'unknown gate ID',
    'GATE_ID_INVALID',
    f => {
      f.manifest.gates[0].id = 'UNTRUSTED_RAW_SECRET'
    }
  ],
  [
    'wrong suite',
    'GATE_SCHEMA_INVALID',
    f => {
      f.manifest.gates[0].suite = 'live'
    }
  ],
  [
    'shrunk all scope',
    'GATE_SCHEMA_INVALID',
    f => {
      f.manifest.gates.find(g => g.id === 'api').scope = 'ui'
    }
  ],
  [
    'shrunk critical repeat',
    'GATE_SCHEMA_INVALID',
    f => {
      f.manifest.gates.find(g => g.id === 'critical').minimum_repeat = 1
    }
  ],
  [
    'bad digest shape',
    'GATE_SCHEMA_INVALID',
    f => {
      f.manifest.gates[0].sha256 = 'not-a-sha'
    }
  ],
  [
    'tampered report',
    'EVIDENCE_TAMPERED',
    f => {
      writeFileSync(join(f.root, f.manifest.gates[0].path), 'PRIVATE_RAW_BODY')
    }
  ]
]) {
  test(`synthetic negative: ${label}`, t => {
    const f = evaluatorFixture(t)
    mutate(f)
    assertTypedFailure(f.evaluate, reason)
  })
}

for (const [label, reason, mutate, id = 'foundation'] of [
  [
    'wrong report schema',
    'REPORT_SCHEMA_INVALID',
    r => {
      delete r.schema_version
    }
  ],
  [
    'malformed environment',
    'ENVIRONMENT_SCHEMA_INVALID',
    r => {
      r.environment = { platform: 'PRIVATE_RAW_BODY' }
    }
  ],
  [
    'wrong report plan',
    'WRONG_PLAN',
    r => {
      r.plan_id = 'obsolete-plan'
    }
  ],
  [
    'wrong report suite',
    'REPORT_IDENTITY_INVALID',
    r => {
      r.suite = 'acceptance'
    }
  ],
  [
    'wrong report scope',
    'REPORT_IDENTITY_INVALID',
    r => {
      r.scope = 'ui'
    },
    'api'
  ],
  [
    'stale report before',
    'EVIDENCE_STALE',
    r => {
      r.evidence_fingerprint.artifact_sha256 = 'd'.repeat(64)
    }
  ],
  [
    'changed report after',
    'EVIDENCE_STALE',
    r => {
      r.evidence_fingerprint_after.source_sha256 = 'd'.repeat(64)
    }
  ],
  [
    'stale run before',
    'EVIDENCE_STALE',
    r => {
      r.runs[0].evidence_fingerprint.revision = 'd'.repeat(40)
    }
  ],
  [
    'changed run after',
    'EVIDENCE_STALE',
    r => {
      r.runs[0].evidence_fingerprint_after.source_sha256 = 'd'.repeat(64)
    }
  ],
  [
    'empty runs green flag',
    'REPEAT_OR_RUNS_INVALID',
    r => {
      r.runs = []
    }
  ],
  [
    'empty results green flag',
    'EMPTY_OR_INVALID_RESULTS',
    r => {
      r.runs[0].results = []
    }
  ],
  [
    'missing required case',
    'REQUIRED_CASE_MISSING',
    r => {
      r.runs[0].results.pop()
    }
  ],
  [
    'duplicate result',
    'RESULT_SCHEMA_INVALID',
    r => {
      r.runs[0].results.push({ ...r.runs[0].results[0] })
    }
  ],
  [
    'expected-red cannot count as product green',
    'RESULT_SCHEMA_INVALID',
    r => {
      Object.assign(r.runs[0].results[0], { expect: 'red', status: 'expected-red' })
    }
  ],
  [
    'hidden failed result',
    'RESULT_FAILED',
    r => {
      r.runs[0].results[0].status = 'fail'
    }
  ],
  [
    'ignored result',
    'RESULT_FAILED',
    r => {
      r.runs[0].results[0].status = 'ignored'
    }
  ],
  [
    'false run passed',
    'NONCONTIGUOUS_GREEN',
    r => {
      r.runs[0].passed = false
    }
  ],
  [
    'false clean count',
    'NONCONTIGUOUS_GREEN',
    r => {
      r.runs[1].clean_acceptance_count = 1
    },
    'critical'
  ],
  [
    'insufficient actual repeat',
    'REPEAT_OR_RUNS_INVALID',
    r => {
      r.repeat = 1
      r.runs = r.runs.slice(0, 1)
    },
    'critical'
  ],
  [
    'hidden middle failure',
    'RESULT_FAILED',
    r => {
      r.runs[1].results[0].status = 'fail'
    },
    'critical'
  ],
  [
    'failed report top-level',
    'REPORT_FAILED',
    r => {
      r.passed = false
    }
  ],
  [
    'false final count',
    'REPORT_FAILED',
    r => {
      r.clean_acceptance_count = 0
    }
  ],
  [
    'wrong OS identity',
    'PLATFORM_IDENTITY_INVALID',
    r => {
      r.environment.platform = 'darwin/arm64'
    },
    'platform-win32'
  ]
]) {
  test(`synthetic negative: ${label}`, t => {
    const f = evaluatorFixture(t)
    mutate(f.reports.get(id))
    f.writeGate(id)
    assertTypedFailure(f.evaluate, reason)
  })
}

test('acceptance: supplied failure is not masked by missing gate or environment', t => {
  const f = evaluatorFixture(t)
  f.manifest.gates = f.manifest.gates.filter(g => g.id !== 'foundation')
  f.reports.get('critical').runs[1].results[0].status = 'fail'
  f.writeGate('critical')
  assertTypedFailure(f.evaluate, 'RESULT_FAILED')
})

test('acceptance: typed not-run report is non-green and malicious reason/body never echoed', async t => {
  const f = evaluatorFixture(t)
  const r = f.reports.get('live')
  Object.assign(r, { passed: false, clean_acceptance_count: 0 })
  Object.assign(r.runs[0], { passed: false, clean_acceptance_count: 0 })
  Object.assign(r.runs[0].results[0], { status: 'not-run', reason_code: 'LIVE_CREDENTIALS_MISSING', detail: 'PRIVATE_PROVIDER_RESPONSE' })
  f.writeGate('live')
  assertNotRun(f.evaluate, 'GATE_NOT_RUN')
  const [result] = await runCases([{ id: 'synthetic', expect: 'pass', run: f.evaluate }])
  assert.equal(result.status, 'not-run')
  assert.equal(result.reason_code, 'GATE_NOT_RUN')
  assert.equal(result.gate_id, 'live')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_RESPONSE/)
  r.passed = true
  f.writeGate('live')
  assertTypedFailure(f.evaluate, 'FALSE_NOT_RUN_PASS')
})

test('runner: typed not-run, ordinary fail, empty cases and expected-red stay distinct and redacted', async () => {
  const raw = 'PRIVATE_PROVIDER_RAW_KEY'
  const results = await runCases([
    {
      id: 'missing',
      expect: 'pass',
      run: () => {
        throw new VerificationNotRunError('LIVE_CREDENTIALS_MISSING', raw)
      }
    },
    {
      id: 'ordinary',
      expect: 'pass',
      run: () => {
        throw new Error(raw)
      }
    },
    {
      id: 'red',
      expect: 'red',
      redCode: 'DENIED',
      run: () => {
        throw Object.assign(new Error(raw), { code: 'DENIED' })
      }
    },
    {
      id: 'wrong',
      expect: 'red',
      redCode: 'DENIED',
      run: () => {
        throw new Error(raw)
      }
    }
  ])
  assert.deepEqual(
    results.map(r => r.status),
    ['not-run', 'fail', 'expected-red', 'fail']
  )
  assert.equal(results[0].reason_code, 'LIVE_CREDENTIALS_MISSING')
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE_PROVIDER_RAW_KEY/)
  assert.equal((await runCases([]))[0].reason_code, 'EMPTY_CASES')
})

function relocatedRunner(t, suiteBody = 'return [{ id: "SYNTHETIC", expect: "pass", run: () => true }]') {
  const root = mkdtempSync(join(tmpdir(), 'bp-synthetic-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const pkg = join(repo, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
  for (const dir of ['scripts', 'src', 'lib/nested', 'test/foundation', 'test/acceptance', 'config']) mkdirSync(join(pkg, dir), { recursive: true })
  mkdirSync(join(repo, '.github/workflows'), { recursive: true })
  mkdirSync(join(repo, 'test/blueprint'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{}\n')
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(pkg, 'src/index.ts'), 'export const synthetic = true\n')
  writeFileSync(join(pkg, 'lib/index.js'), 'export const synthetic = true\n')
  writeFileSync(join(pkg, 'lib/nested/second.js'), 'export const second = true\n')
  writeFileSync(join(pkg, 'scripts/verify.mjs'), readFileSync(runner))
  writeFileSync(join(pkg, 'test/acceptance/behavior-evidence.mjs'), readFileSync(join(packageRoot, 'test/acceptance/behavior-evidence.mjs')))
  const diagnosticEvidence = join(pkg, 'test/live/live-diagnostic-evidence.mjs')
  const diagnosticBytes = readFileSync(join(packageRoot, 'test', 'live', 'live-diagnostic-evidence.mjs'))
  mkdirSync(dirname(diagnosticEvidence), { recursive: true })
  writeFileSync(diagnosticEvidence, diagnosticBytes)
  assert.deepEqual(readFileSync(diagnosticEvidence), diagnosticBytes, 'relocated runner diagnostic module must preserve the real dependency bytes')
  writeFileSync(
    join(pkg, 'test/foundation/foundation.mjs'),
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerificationNotRunError } from '../../scripts/verify.mjs';
let count = 0;
export async function getCases(helpers) { ${suiteBody} }`
  )
  const fp = () => captureEvidenceFingerprint({ packageRoot: pkg, repoRoot: repo })
  const reportDir = join(repo, 'docs/validation/blueprint/current/synthetic-only')
  const invokeRunner = (extra = []) => {
    const child = spawnSync(
      process.execPath,
      [join(pkg, 'scripts/verify.mjs'), '--suite', 'foundation', '--report-dir', reportDir, '--plan-id', syntheticPlan, ...extra],
      {
        cwd: pkg,
        env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        encoding: 'utf8'
      }
    )
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.equal(existsSync(join(reportDir, 'w1.foundation-report.json')), true, `synthetic runner must emit report: ${child.stderr}`)
    return { child, report: JSON.parse(readFileSync(join(reportDir, 'w1.foundation-report.json'), 'utf8')) }
  }
  return { root, repo, pkg, fp, reportDir, invokeRunner }
}

test('fingerprint: relocated roots, deterministic ordering, all source/config/test/CI/root-manifest and lib JS bytes', t => {
  const f = relocatedRunner(t)
  const before = f.fp()
  assert.deepEqual(Object.keys(before), ['revision', 'source_sha256', 'artifact_sha256'])
  assert.match(before.source_sha256, /^[a-f0-9]{64}$/)
  assert.match(before.artifact_sha256, /^[a-f0-9]{64}$/)
  assert.equal(before.revision, 'unknown', 'non-git synthetic root is honest about missing revision')
  for (const path of [
    join(f.pkg, 'src/index.ts'),
    join(f.pkg, 'config/settings.json'),
    join(f.pkg, 'test/control.mjs'),
    join(f.pkg, 'scripts/helper.mjs'),
    join(f.pkg, 'vite.config.ts'),
    join(f.repo, 'test/blueprint/probe.mjs'),
    join(f.repo, '.github/workflows/blueprint.yml'),
    join(f.repo, 'package.json')
  ]) {
    const previous = f.fp()
    writeFileSync(path, 'changed synthetic bytes')
    assert.notEqual(f.fp().source_sha256, previous.source_sha256, path)
    assert.equal(f.fp().artifact_sha256, previous.artifact_sha256)
  }
  const previous = f.fp()
  writeFileSync(join(f.pkg, 'lib/nested/second.js'), 'changed artifact')
  assert.notEqual(f.fp().artifact_sha256, previous.artifact_sha256)
  assert.equal(f.fp().source_sha256, previous.source_sha256)
  // The same bytes under another absolute root produce the same digest;
  // no cwd/global PACKAGE_ROOT is accidentally used by the export.
  const other = relocatedRunner(t)
  const third = relocatedRunner(t)
  assert.deepEqual(other.fp(), third.fp())
  const files = ['z.ts', 'a.ts', 'middle.ts']
  for (const name of files) writeFileSync(join(other.pkg, 'src', name), name)
  for (const name of [...files].reverse()) writeFileSync(join(third.pkg, 'src', name), name)
  assert.deepEqual(other.fp(), third.fp())
})

test('fingerprint: reports, docs, key, dependencies, caches, dist, artifacts, logs/tgz do not poison source', t => {
  const f = relocatedRunner(t)
  const before = f.fp()
  for (const dir of [
    join(f.pkg, 'node_modules'),
    join(f.pkg, 'dist'),
    join(f.pkg, '.cache'),
    join(f.pkg, 'artifacts'),
    join(f.pkg, 'test/reports'),
    join(f.repo, 'test/blueprint/reports'),
    join(f.repo, 'docs/validation/blueprint/current'),
    join(f.repo, 'docs'),
    join(f.repo, 'key'),
    join(f.pkg, 'test/docs'),
    join(f.pkg, 'test/key')
  ]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SENSITIVE_NOT_SOURCE.json'), 'synthetic excluded bytes')
  }
  for (const name of ['trace.log', 'packed.tgz']) writeFileSync(join(f.pkg, 'test', name), 'excluded')
  writeFileSync(join(f.pkg, 'lib/map.js.map'), 'non-JS artifact')
  assert.deepEqual(f.fp(), before)
  const { report, child } = f.invokeRunner(['--repeat', '3'])
  assert.equal(child.status, 0)
  assert.equal(report.passed, true, 'synthetic runner calibration ONLY')
  assert.deepEqual(report.evidence_fingerprint, report.evidence_fingerprint_after)
  assert.deepEqual(f.fp(), before, 'writing report did not change source')
  assert.ok(report.fingerprint, 'legacy field retained')
  assert.deepEqual(
    report.runs.map(r => r.clean_acceptance_count),
    [1, 2, 3]
  )
  assert.ok(report.runs.every(r => typeof r.duration_ms === 'number' && r.duration_ms >= 0))
})

test('runner: fail between green runs resets real clean count, not loop index', t => {
  const f = relocatedRunner(t, 'count++; return [{ id: "SYNTHETIC", expect: "pass", run: () => count !== 2 }]')
  const { report, child } = f.invokeRunner(['--repeat', '3'])
  assert.equal(child.status, 1)
  assert.equal(report.passed, false)
  assert.deepEqual(
    report.runs.map(r => r.clean_acceptance_count),
    [1, 0, 1]
  )
  assert.equal(report.clean_acceptance_count, 0)
})

for (const [label, body] of [
  [
    'source change',
    'count++; return [{ id: "SYNTHETIC", expect: "pass", run: () => { if (count === 1) writeFileSync(join(helpers.packageRoot, "src/index.ts"), "changed source"); return true } }]'
  ],
  [
    'artifact change',
    'count++; return [{ id: "SYNTHETIC", expect: "pass", run: () => { if (count === 1) writeFileSync(join(helpers.packageRoot, "lib/nested/second.js"), "changed JS"); return true } }]'
  ],
  ['empty suite', 'return []'],
  ['typed missing env', 'throw new VerificationNotRunError("ENVIRONMENT_UNAVAILABLE", "PRIVATE_PROVIDER_RESPONSE")']
]) {
  test(`runner negative: ${label} cannot produce passed evidence`, t => {
    const f = relocatedRunner(t, body)
    const { report, child } = f.invokeRunner(['--repeat', '3'])
    assert.equal(child.status, 1)
    assert.equal(report.passed, false)
    assert.deepEqual(
      report.runs.map(r => r.clean_acceptance_count),
      [0, 0, 0]
    )
    assert.equal(report.clean_acceptance_count, 0)
    if (label === 'typed missing env') {
      assert.equal(report.runs[0].results[0].status, 'not-run')
      assert.equal(report.runs[0].results[0].reason_code, 'ENVIRONMENT_UNAVAILABLE')
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_RESPONSE/)
    } else if (label.endsWith('change')) {
      assert.notDeepEqual(report.evidence_fingerprint, report.evidence_fingerprint_after)
      assert.equal(report.runs[0].results.at(-1).reason_code, 'EVIDENCE_STALE')
    } else assert.equal(report.runs[0].results[0].reason_code, 'EMPTY_CASES')
  })
}

test('runner controls: evidence-manifest is acceptance-only; malformed values still reject before reports', t => {
  const f = fixture(t)
  const before = reportHashes(oldReports)
  for (const suffix of [['--evidence-manifest'], ['--evidence-manifest='], ['--evidence-manifest', '--repeat', '3']]) {
    const child = invoke(f, ['--suite', 'acceptance', ...suffix])
    assert.equal(child.status, 2)
    assert.match(child.stderr, /requires a non-empty value/)
  }
  const child = invoke(f, ['--suite', 'live', '--evidence-manifest', join(f.root, 'anything.json')])
  assert.equal(child.status, 2)
  assert.match(child.stderr, /only valid for acceptance/)
  assertOldReportsUnchanged(before)
})

test('runner acceptance: missing explicit manifest emits not-run, exit 1 and clean count 0 with stable fingerprint', t => {
  const f = fixture(t)
  const reportDir = join(f.root, 'missing-manifest')
  const child = invoke(f, ['--suite=acceptance', `--report-dir=${reportDir}`, `--plan-id=${syntheticPlan}`, '--repeat=3'])
  assert.equal(child.status, 1)
  const report = JSON.parse(readFileSync(join(reportDir, 'w8.acceptance-report.json'), 'utf8'))
  assert.equal(report.passed, false)
  assert.deepEqual(
    report.runs.map(r => r.clean_acceptance_count),
    [0, 0, 0]
  )
  assert.ok(report.runs.every(r => r.results[0].status === 'not-run' && r.results[0].reason_code === 'MANIFEST_MISSING'))
  // Main must rerun under a source freeze if the live worker edited mid-run.
  assert.deepEqual(report.evidence_fingerprint, report.evidence_fingerprint_after)
})

test('acceptance example: complete fixed not-run bootstrap cannot generate passed product evidence', t => {
  const f = evaluatorFixture(t)
  const manifest = createNotRunEvidenceManifest({ planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint })
  assert.deepEqual(
    manifest.gates.map(g => g.id),
    REQUIRED_GATES.map(g => g.id)
  )
  assert.ok(manifest.gates.every(g => g.status === 'not-run' && g.path === null && g.sha256 === null))
  assert.equal(validateEvidenceManifest(manifest, { planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint }).missing.length, 0)
  writeFileSync(f.path, JSON.stringify(manifest))
  assertNotRun(
    () => evaluateEvidenceManifest({ evidenceManifestPath: f.path, planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint }),
    'GATE_NOT_RUN'
  )
})

test('acceptance: corrupted JSON and key/docs evidence paths fail typed without reading content', t => {
  const f = evaluatorFixture(t)
  const gate = f.manifest.gates[0]
  const bytes = 'PRIVATE_RAW_BODY:not-json'
  writeFileSync(join(f.root, gate.path), bytes)
  gate.sha256 = digest(bytes)
  assertTypedFailure(f.evaluate, 'EVIDENCE_JSON_INVALID')
  for (const dir of ['key', 'docs']) {
    gate.path = `${dir}/unread-evidence.json`
    // Deliberately no such file: path policy must reject before any open.
    assertTypedFailure(f.evaluate, 'EVIDENCE_PATH_INVALID')
  }
  writeFileSync(f.path, bytes)
  assertTypedFailure(
    () => evaluateEvidenceManifest({ evidenceManifestPath: f.path, planId: syntheticPlan, evidenceFingerprint: syntheticFingerprint }),
    'EVIDENCE_JSON_INVALID'
  )
})

test('acceptance: malformed evidence cannot hide behind missing environment in same gate', t => {
  const f = evaluatorFixture(t)
  const report = f.reports.get('foundation')
  delete report.environment
  report.runs[0].results[0].status = 'fail'
  f.writeGate('foundation')
  assertTypedFailure(f.evaluate, 'RESULT_FAILED')
})

test('runner: typed not-run between actual greens resets streak with overall false', t => {
  const f = relocatedRunner(
    t,
    'count++; return [{ id: "SYNTHETIC", expect: "pass", run: () => { if (count === 2) throw new VerificationNotRunError("ENVIRONMENT_UNAVAILABLE", "private"); return true } }]'
  )
  const { report, child } = f.invokeRunner(['--repeat', '3'])
  assert.equal(child.status, 1)
  assert.equal(report.passed, false)
  assert.deepEqual(
    report.runs.map(r => r.clean_acceptance_count),
    [1, 0, 1]
  )
  assert.equal(report.clean_acceptance_count, 0)
})

test('runner import: stdin entrypoint does not start main and exported fingerprint works', t => {
  const f = relocatedRunner(t)
  const source = `import { captureEvidenceFingerprint } from ${JSON.stringify(pathToFileURL(join(f.pkg, 'scripts/verify.mjs')).href)};
console.log(JSON.stringify(captureEvidenceFingerprint({packageRoot: ${JSON.stringify(f.pkg)}, repoRoot: ${JSON.stringify(f.repo)}})));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-', '--suite', 'foundation', '--report-dir', f.reportDir], {
    cwd: f.pkg,
    input: source,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, `STDIN_IMPORT_MUST_NOT_THROW: ${child.stderr}`)
  assert.deepEqual(JSON.parse(child.stdout), f.fp())
  assert.equal(existsSync(f.reportDir), false, 'import must not start main or write reports')
})

test('runner import: missing non-file host entrypoint also leaves helpers importable', t => {
  const f = relocatedRunner(t)
  const source = `process.argv[1] = ${JSON.stringify(join(f.root, 'entrypoint-does-not-exist'))};
const { captureEvidenceFingerprint } = await import(${JSON.stringify(pathToFileURL(join(f.pkg, 'scripts/verify.mjs')).href)});
console.log(JSON.stringify(captureEvidenceFingerprint({packageRoot: ${JSON.stringify(f.pkg)}, repoRoot: ${JSON.stringify(f.repo)}})));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: f.pkg,
    input: source,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), f.fp())
  assert.equal(existsSync(f.reportDir), false)
})

test('runner control: symlink CLI entrypoint still executes main', t => {
  const f = relocatedRunner(t)
  const alias = join(f.root, 'verify-symlink.mjs')
  symlinkSync(join(f.pkg, 'scripts/verify.mjs'), alias, 'file')
  const child = spawnSync(process.execPath, [alias, '--suite', 'foundation', '--report-dir', f.reportDir, '--plan-id', syntheticPlan], {
    cwd: f.pkg,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /verify: suite foundation PASSED/)
  const report = JSON.parse(readFileSync(join(f.reportDir, 'w1.foundation-report.json'), 'utf8'))
  assert.equal(report.plan_id, syntheticPlan)
  assert.equal(report.runs[0].results[0].id, 'SYNTHETIC')
})
