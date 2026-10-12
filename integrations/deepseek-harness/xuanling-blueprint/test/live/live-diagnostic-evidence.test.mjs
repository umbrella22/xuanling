import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runCases, VerificationNotRunError } from '../../scripts/verify.mjs'
import { LIVE_BEHAVIOR_FLAGS } from '../acceptance/behavior-evidence.mjs'
import {
  LiveJourneyError as JourneyError, isolatedEnvironment,
  isolatedJourneyEnvironment, runIsolatedJourney,
} from './journey.mjs'
import {
  LiveJourneyError, LIVE_JOURNEY_ERROR_CODES, LIVE_FAILURE_STAGES,
  LIVE_OBSERVER_FLAGS, LIVE_PROVIDER_FAILURE_CODES,
  collectLiveFailureEvidence, projectLiveFailureEvidence, projectLiveJourneyFailure,
} from './live-diagnostic-evidence.mjs'

// Synthetic calibration only: no credentials, Host, SDK, provider or live claim.
const sentinel = 'W4_DIAGNOSTIC_RAW_SENTINEL_DO_NOT_SERIALIZE'
const rawPath = '/private/diagnostic-sentinel-root'
const passCase = error => ({ id: 'L1', title: 'typed ordinary failure', expect: 'pass', run: () => { throw error } })
const noRaw = value => {
  const text = JSON.stringify(value)
  assert.equal(text.includes(sentinel), false)
  assert.equal(text.includes(rawPath), false)
}
const source = readFileSync(new URL('./journey.mjs', import.meta.url), 'utf8')

function actualFacts(stage = 'observer_read') {
  const flags = Object.fromEntries(LIVE_OBSERVER_FLAGS.map(name => [name, name !== 'requestAborted']))
  return { stage, snapshot: {
    runId: sentinel, state: 'failed', inputJson: sentinel,
    attempts: [
      { nodeId: 'model', attemptId: sentinel, state: 'failed', resultKind: 'provider-failed', outputJson: sentinel, diagnostics: { prompt: sentinel } },
      { nodeId: 'downstream', attemptId: sentinel, state: 'skipped', resultKind: undefined, outputJson: sentinel },
    ],
  }, observed: { sessions: [
    { ...flags, sessionId: sentinel, failureCode: 'HTTP_401', failureStatus: 401, raw: sentinel, error: sentinel, path: rawPath },
  ], prompt: sentinel, body: sentinel, root: rawPath } }
}

function decoratedError(code) {
  const error = new JourneyError(code)
  error.message = sentinel
  error.stack = sentinel
  error.cause = { body: sentinel, path: rawPath }
  error.reason_code = sentinel
  error.raw = sentinel
  error.failure_evidence = collectLiveFailureEvidence(actualFacts())
  error.failure_evidence.prompt = sentinel
  error.failure_evidence.root = rawPath
  return error
}

test('D-01: journey re-exports the exact trusted pure error class, without a verify-to-journey cycle', () => {
  assert.equal(JourneyError, LiveJourneyError)
  const verify = readFileSync(new URL('../../scripts/verify.mjs', import.meta.url), 'utf8')
  assert.equal(/from ['"][^'"]*live\/journey\.mjs/.test(verify), false)
  assert.match(verify, /import \{ projectLiveJourneyFailure \} from '\.\.\/test\/live\/live-diagnostic-evidence\.mjs'/)
})

test('D-01: exact static code vocabulary covers every current journey throw, not an arbitrary LIVE prefix', () => {
  // Include the existing ternary failure expression; the two NotRun literals
  // belong to VerificationNotRunError, not the LiveJourneyError vocabulary.
  const emitted = [...source.matchAll(/'(LIVE_[A-Z_]+)'/g)].map(match => match[1])
    .filter(code => !['LIVE_CONFIGURATION_MISSING', 'LIVE_HOST_OR_ARTIFACT_MISSING'].includes(code))
  assert.deepEqual([...new Set(emitted)].sort(), [...LIVE_JOURNEY_ERROR_CODES].sort())
  assert.equal(Object.isFrozen(LIVE_JOURNEY_ERROR_CODES), true)
  assert.equal(LIVE_JOURNEY_ERROR_CODES.includes('LIVE_CONFIGURATION_MISSING'), false)
  assert.equal(LIVE_JOURNEY_ERROR_CODES.includes('LIVE_HOST_OR_ARTIFACT_MISSING'), false)
})

for (const code of LIVE_JOURNEY_ERROR_CODES) {
  test(`D-01: runCases preserves trusted ${code} as fail, with only fixed failure evidence`, async () => {
    const [row] = await runCases([passCase(decoratedError(code))])
    assert.equal(row.status, 'fail')
    assert.equal(row.expect, 'pass')
    assert.equal(row.reason_code, code)
    assert.equal(row.detail, code)
    assert.deepEqual(row.failure_evidence, collectLiveFailureEvidence(actualFacts()))
    assert.deepEqual(Object.keys(projectLiveJourneyFailure(decoratedError(code))).sort(), ['failure_evidence', 'reason_code'])
    noRaw(row)
  })
}

test('D-01: all six main correct-red reasons pass through the actual runCases error exit', async () => {
  const codes = ['LIVE_PROVIDER_TIMEOUT', 'LIVE_PROVIDER_FAILED', 'LIVE_AGENT_NONCE_MISSING', 'LIVE_AGENT_FACTS_MISSING', 'LIVE_HOST_BOOT_TIMEOUT', 'LIVE_JOURNEY_FAILED']
  const rows = await runCases(codes.map(code => passCase(new JourneyError(code))))
  assert.deepEqual(rows.map(row => row.reason_code), codes)
  assert.deepEqual(rows.map(row => row.status), codes.map(() => 'fail'))
  assert.equal(rows.every(row => !Object.hasOwn(row, 'failure_evidence')), true)
})

test('D-01: forged names, ordinary errors, prototype forgeries and strings stay generic at runCases', async () => {
  const plain = { name: 'LiveJourneyError', code: 'LIVE_PROVIDER_TIMEOUT', reason_code: 'LIVE_PROVIDER_TIMEOUT', message: sentinel, failure_evidence: collectLiveFailureEvidence(actualFacts()) }
  const namedError = Object.assign(new Error(sentinel), plain)
  const prototypeForgery = Object.assign(Object.create(LiveJourneyError.prototype), plain)
  const inputs = [plain, namedError, prototypeForgery, sentinel, null, undefined]
  for (const error of inputs) {
    assert.equal(projectLiveJourneyFailure(error), null)
    const [row] = await runCases([passCase(error)])
    assert.equal(row.status, 'fail')
    assert.equal(row.reason_code, 'VERIFICATION_FAILED')
    assert.equal(row.detail, 'VERIFICATION_FAILED')
    assert.equal(Object.hasOwn(row, 'failure_evidence'), false)
    noRaw(row)
  }
})

test('D-01: trusted instances with unknown / malformed codes do not expand the static whitelist', async () => {
  for (const code of ['LIVE_FUTURE_ERROR', 'LIVE_PROVIDER_TIMEOUT_EXTRA', 'LIVE_CONFIGURATION_MISSING', sentinel, '', null, 401, { raw: sentinel }]) {
    const error = new LiveJourneyError(code)
    error.failure_evidence = collectLiveFailureEvidence(actualFacts())
    const [row] = await runCases([passCase(error)])
    assert.equal(projectLiveJourneyFailure(error), null)
    assert.equal(row.status, 'fail')
    assert.equal(row.reason_code, 'VERIFICATION_FAILED')
    assert.equal(Object.hasOwn(row, 'failure_evidence'), false)
    noRaw(row)
  }
})

test('D-01: accessor codes and malicious toJSON/raw fields cannot cross the evidence boundary', async () => {
  const error = decoratedError('LIVE_PROVIDER_FAILED')
  error.toJSON = () => { throw new Error(sentinel) }
  error.failure_evidence.toJSON = () => { throw new Error(sentinel) }
  const [row] = await runCases([passCase(error)])
  noRaw(row)
  assert.equal(row.reason_code, 'LIVE_PROVIDER_FAILED')
  const getter = new LiveJourneyError('LIVE_PROVIDER_FAILED')
  Object.defineProperty(getter, 'code', { get: () => 'LIVE_PROVIDER_FAILED' })
  assert.equal(projectLiveJourneyFailure(getter), null)
})

test('D-01: not-run, exact expected-red, wrong red and unexpected green classifications remain unchanged', async () => {
  const missing = new VerificationNotRunError('LIVE_CONFIGURATION_MISSING', sentinel)
  const rows = await runCases([
    { ...passCase(missing), expect: 'red', redCode: 'LIVE_CONFIGURATION_MISSING' },
    { ...passCase(decoratedError('LIVE_PROVIDER_TIMEOUT')), expect: 'red', redCode: 'LIVE_PROVIDER_TIMEOUT' },
    { ...passCase(new Error(sentinel)), expect: 'red', redCode: 'LIVE_PROVIDER_TIMEOUT' },
    { id: 'green', title: 'unexpected green', expect: 'red', redCode: 'LIVE_PROVIDER_TIMEOUT', run: () => true },
    { ...passCase({ code: 'LIVE_PROVIDER_TIMEOUT', message: sentinel }), expect: 'red', redCode: 'LIVE_PROVIDER_TIMEOUT' },
  ])
  assert.deepEqual(rows.map(row => row.status), ['not-run', 'expected-red', 'fail', 'fail', 'expected-red'])
  assert.equal(rows[0].reason_code, 'LIVE_CONFIGURATION_MISSING')
  assert.equal(rows[1].detail, 'exact expected failure')
  assert.equal(rows[2].detail, 'wrong failure')
  assert.equal(rows[3].detail, 'unexpected green')
  assert.equal(rows.every(row => !Object.hasOwn(row, 'failure_evidence')), true)
  noRaw(rows)
})

test('D-01: L1 success still requires the original complete authority / nonce facts', async () => {
  const facts = { runId: 'run-fixture', attemptId: 'att-model', downstreamAttemptId: 'att-downstream', sessionId: 'bp-run-fixture-att-model-session', output_sha256: 'a'.repeat(64), nonce_sha256: 'a'.repeat(64), ...Object.fromEntries(LIVE_BEHAVIOR_FLAGS.map(name => [name, true])) }
  const valid = { ok: true, behavior_assertions: facts, prompt: sentinel }
  const [green] = await runCases([{ id: 'L1', expect: 'pass', run: () => valid }])
  assert.equal(green.status, 'pass')
  assert.deepEqual(green.detail, { ok: true, behavior_assertions: facts })
  assert.equal(Object.hasOwn(green, 'failure_evidence'), false)
  noRaw(green)
  for (const name of LIVE_BEHAVIOR_FLAGS) {
    const [red] = await runCases([{ id: 'L1', expect: 'pass', run: () => ({ ok: true, behavior_assertions: { ...facts, [name]: false } }) }])
    assert.equal(red.status, 'fail')
    assert.equal(red.reason_code, 'LIVE_BEHAVIOR_INVALID')
  }
})

test('D-02: fixed schema contains only observed stage / states / counts / public booleans / provider classification', () => {
  const evidence = collectLiveFailureEvidence(actualFacts())
  assert.deepEqual(Object.keys(evidence), ['schemaVersion', 'stage', 'run_state', 'attempt_count', 'model', 'downstream', 'session_count', 'observer', 'provider_failure'])
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.stage, 'observer_read')
  assert.equal(evidence.run_state, 'failed')
  assert.equal(evidence.attempt_count, 2)
  assert.deepEqual(evidence.model, { state: 'failed', resultKind: 'provider-failed' })
  assert.deepEqual(evidence.downstream, { state: 'skipped', resultKind: null })
  assert.equal(evidence.session_count, 1)
  assert.deepEqual(evidence.provider_failure, { code: 'HTTP_401', status: 401 })
  for (const name of LIVE_OBSERVER_FLAGS) assert.deepEqual(evidence.observer[name], { seen: name !== 'requestAborted', count: name === 'requestAborted' ? 0 : 1 })
  assert.deepEqual(projectLiveFailureEvidence(evidence), evidence)
  noRaw(evidence)
})

test('D-02: unavailable facts are null / unknown, not invented zeros or events from a failure code', () => {
  const absent = collectLiveFailureEvidence({ stage: 'host_launch_requested' })
  assert.equal(absent.stage, 'host_launch_requested')
  assert.equal(absent.run_state, 'unknown')
  assert.equal(absent.attempt_count, null)
  assert.equal(absent.session_count, null)
  assert.deepEqual(absent.model, { state: 'unknown', resultKind: null })
  assert.deepEqual(absent.downstream, { state: 'unknown', resultKind: null })
  for (const name of LIVE_OBSERVER_FLAGS) assert.deepEqual(absent.observer[name], { seen: null, count: null })
  for (const code of ['LIVE_AGENT_FACTS_MISSING', 'LIVE_PROVIDER_TIMEOUT', 'LIVE_AGENT_NONCE_MISSING']) {
    const error = new LiveJourneyError(code)
    error.failure_evidence = absent
    assert.deepEqual(projectLiveJourneyFailure(error).failure_evidence, absent)
  }
  const empty = collectLiveFailureEvidence({ stage: 'run_observed', snapshot: { state: 'running', attempts: [] }, observed: { sessions: [] } })
  assert.equal(empty.attempt_count, 0)
  assert.equal(empty.session_count, 0)
  for (const name of LIVE_OBSERVER_FLAGS) assert.deepEqual(empty.observer[name], { seen: false, count: 0 })
})

test('D-02: all stage enums survive exactly, arbitrary stages / states / resultKinds do not', () => {
  for (const stage of LIVE_FAILURE_STAGES) assert.equal(collectLiveFailureEvidence({ stage }).stage, stage)
  for (const stage of [sentinel, 'provider_timeout', '', null, {}, []]) assert.equal(collectLiveFailureEvidence({ stage }).stage, 'unknown')
  const evidence = collectLiveFailureEvidence({ stage: sentinel, snapshot: { state: sentinel, attempts: [{ nodeId: 'model', state: sentinel, resultKind: sentinel }] }, observed: { sessions: [{ sessionId: sentinel, agentCreated: 'true', failureCode: sentinel, failureStatus: '401' }] } })
  assert.equal(evidence.run_state, 'unknown')
  assert.deepEqual(evidence.model, { state: 'unknown', resultKind: null })
  assert.deepEqual(evidence.observer.agentCreated, { seen: false, count: 0 })
  assert.deepEqual(evidence.provider_failure, { code: null, status: null })
  noRaw(evidence)
})

test('D-02: observer counts require exact public boolean true, never raw IDs or truthy strings', () => {
  const evidence = collectLiveFailureEvidence({ stage: 'run_observed', observed: { sessions: [
    { agentCreated: true, requestSeen: true, responseSeen: false, sessionId: sentinel },
    { agentCreated: false, requestSeen: 'true', responseSeen: true, sessionId: rawPath },
    { agentCreated: 1, requestSeen: {}, responseSeen: true, raw: sentinel },
  ] } })
  assert.equal(evidence.session_count, 3)
  assert.deepEqual(evidence.observer.agentCreated, { seen: true, count: 1 })
  assert.deepEqual(evidence.observer.requestSeen, { seen: true, count: 1 })
  assert.deepEqual(evidence.observer.responseSeen, { seen: true, count: 2 })
  noRaw(evidence)
})

test('D-02: only the original observer provider failure code whitelist and valid integer HTTP statuses survive', () => {
  for (const code of LIVE_PROVIDER_FAILURE_CODES) {
    const evidence = collectLiveFailureEvidence({ observed: { sessions: [{ failureCode: code, failureStatus: 503 }] } })
    assert.deepEqual(evidence.provider_failure, { code, status: 503 })
  }
  for (const invalid of [sentinel, 'HTTP_999', {}, 401]) {
    const evidence = collectLiveFailureEvidence({ observed: { sessions: [{ failureCode: invalid, failureStatus: 401 }] } })
    assert.deepEqual(evidence.provider_failure, { code: null, status: 401 })
    noRaw(evidence)
  }
  for (const invalid of [99, 600, -1, 401.5, '401', sentinel, null, NaN, Infinity]) {
    const evidence = collectLiveFailureEvidence({ observed: { sessions: [{ failureCode: 'HTTP_401', failureStatus: invalid }] } })
    assert.deepEqual(evidence.provider_failure, { code: 'HTTP_401', status: null })
  }
})

test('D-02: malformed schema and evidence values cannot leak or impersonate valid facts', async () => {
  for (const value of [undefined, null, true, [], sentinel, {}, { schemaVersion: '1' }, { schemaVersion: 2 }]) {
    assert.equal(projectLiveFailureEvidence(value), null)
    const error = new LiveJourneyError('LIVE_JOURNEY_FAILED')
    error.failure_evidence = value
    const [row] = await runCases([passCase(error)])
    assert.equal(Object.hasOwn(row, 'failure_evidence'), false)
    noRaw(row)
  }
  for (const invalid of [-1, 0.5, '1', sentinel, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    const evidence = projectLiveFailureEvidence({ schemaVersion: 1, stage: sentinel, run_state: {}, attempt_count: invalid, session_count: invalid, model: { state: [], resultKind: sentinel }, downstream: sentinel, observer: Object.fromEntries(LIVE_OBSERVER_FLAGS.map(name => [name, { seen: 'true', count: invalid, raw: sentinel }])), provider_failure: { code: sentinel, status: invalid }, error: sentinel, body: sentinel, root: rawPath })
    assert.equal(evidence.attempt_count, null)
    assert.equal(evidence.session_count, null)
    assert.equal(evidence.stage, 'unknown')
    assert.equal(evidence.run_state, 'unknown')
    for (const name of LIVE_OBSERVER_FLAGS) assert.deepEqual(evidence.observer[name], { seen: null, count: null })
    noRaw(evidence)
  }
})

test('D-02: inherited fields, getters and toJSON are not public evidence data', () => {
  const value = Object.create({ stage: 'run_observed', run_state: 'succeeded', attempt_count: 9 })
  value.schemaVersion = 1
  Object.defineProperty(value, 'model', { get: () => { throw new Error(sentinel) } })
  value.toJSON = () => { throw new Error(sentinel) }
  const evidence = projectLiveFailureEvidence(value)
  assert.equal(evidence.stage, 'unknown')
  assert.equal(evidence.run_state, 'unknown')
  assert.equal(evidence.attempt_count, null)
  assert.deepEqual(evidence.model, { state: 'unknown', resultKind: null })
  noRaw(evidence)
})

test('D-02: ordinary early failure uses runIsolatedJourney + runCases without Host or provider and does not invent completed stages', async () => {
  const [row] = await runCases([{ id: 'L1', expect: 'pass', run: () => runIsolatedJourney({}, { key: 'controlled-opaque-value', baseUrl: 'https://user:password@provider.invalid', model: 'fixture', protocol: 'openai-responses' }) }])
  assert.equal(row.status, 'fail')
  assert.equal(row.reason_code, 'LIVE_ENDPOINT_INVALID')
  assert.equal(row.failure_evidence.stage, 'initial')
  assert.equal(row.failure_evidence.run_state, 'unknown')
  assert.equal(row.failure_evidence.attempt_count, null)
  assert.equal(row.failure_evidence.session_count, null)
  noRaw(row)
})

test('D-02: ordinary missing config remains typed not-run without a fake failure_evidence', async () => {
  const [row] = await runCases([{ id: 'L1', expect: 'pass', run: () => runIsolatedJourney({}, { key: '', baseUrl: '', model: '', protocol: 'openai-responses' }) }])
  assert.equal(row.status, 'not-run')
  assert.equal(row.reason_code, 'LIVE_CONFIGURATION_MISSING')
  assert.equal(Object.hasOwn(row, 'failure_evidence'), false)
})

test('D-02: ordinary projection precedes original cleanup; negativeOnly synthetic_evidence is unchanged', () => {
  assert.match(source, /if \(negativeOnly\) safeObserved = \{ \.\.\.observed, run_snapshot: safeRunSnapshot\(snapshot\) \}/)
  assert.match(source, /if \(\(error instanceof LiveJourneyError \|\| error instanceof VerificationNotRunError\) && safeObserved\) failure\.synthetic_evidence = safeObserved/)
  const capture = source.indexOf('failure.failure_evidence = collectLiveFailureEvidence')
  const cleanup = source.indexOf('} finally {', capture)
  assert.equal(capture > 0, true)
  assert.equal(cleanup > capture, true)
  assert.equal(source.indexOf("gateway.call('blueprint/cancelRun'", cleanup) > cleanup, true)
  assert.equal(source.indexOf('await stop(child)', cleanup) > cleanup, true)
  assert.equal(source.indexOf('rmSync(temp', cleanup) > cleanup, true)
  assert.equal((source.match(/isRunObservationComplete\(snapshot\.state\)/g) ?? []).length, 2)
  assert.equal((source.match(/await fetch\(/g) ?? []).length, 2)
  assert.match(source, /const deadline = Date\.now\(\) \+ 30000/)
  assert.match(source, /setTimeout\(resolvePoll, 50\)/)
})

const config = { key: 'synthetic-environment-only', baseUrl: 'https://provider.invalid/v1', model: 'fixture', protocol: 'openai-responses' }
const inherited = { PATH: '/bin', NODE_OPTIONS: '--require hostile', BP_LIVE_DIAGNOSTIC_BUDGET_FILE: '/private/hostile', BP_LIVE_PROVIDER_KEY: sentinel, OPENAI_API_KEY: sentinel, HTTPS_PROXY: sentinel }
const isolatedHome = resolve('/isolated/live-diagnostic-fixture')

test('D-03 seam: normal isolated journey inherits neither Node options nor an ambient budget', () => {
  const normal = isolatedJourneyEnvironment(isolatedHome, config, undefined, inherited)
  assert.deepEqual(normal, isolatedEnvironment(isolatedHome, config, inherited))
  for (const name of ['NODE_OPTIONS', 'BP_LIVE_DIAGNOSTIC_BUDGET_FILE', 'OPENAI_API_KEY', 'HTTPS_PROXY']) assert.equal(Object.hasOwn(normal, name), false)
  assert.equal(normal.BP_LIVE_PROVIDER_PROTOCOL, 'openai-responses')
  assert.equal(normal.BP_LIVE_PROVIDER_KEY, config.key)
})

test('D-03 seam: only explicit budget injects a fileURL preload after isolation, with exact report path', () => {
  const preloadPath = resolve('/isolated/space 中文/#preload.mjs')
  const reportPath = resolve('/isolated/report-budget.json')
  const budget = { preloadPath, reportPath }
  const env = isolatedJourneyEnvironment(isolatedHome, config, budget, inherited)
  assert.deepEqual(env, { ...isolatedEnvironment(isolatedHome, config, inherited), NODE_OPTIONS: '--import ' + pathToFileURL(preloadPath).href, BP_LIVE_DIAGNOSTIC_BUDGET_FILE: reportPath })
  assert.equal(env.NODE_OPTIONS.includes('hostile'), false)
  assert.deepEqual(budget, { preloadPath, reportPath })
  assert.equal(source.includes('const env = isolatedJourneyEnvironment(home, config, diagnosticBudget)'), true)
  assert.equal(source.indexOf('const env = isolatedJourneyEnvironment(home, config, diagnosticBudget)') < source.indexOf('const host = boot(cli, profile, env, cwd)'), true)
})

test('D-03 seam: malformed / implicit budget cannot create Node option inheritance', () => {
  for (const budget of [null, {}, { preloadPath: 'relative.mjs', reportPath: resolve('/isolated/report') }, { preloadPath: resolve('/isolated/preload'), reportPath: 'relative.json' }, { preloadPath: 1, reportPath: resolve('/isolated/report') }]) {
    assert.throws(() => isolatedJourneyEnvironment(isolatedHome, config, budget, inherited), { name: 'TypeError', message: 'invalid diagnostic budget paths' })
  }
})
