import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  configuration,
  isolatedEnvironment,
  profilePatch,
  assertJourney,
  runIsolatedJourney,
  isRunObservationComplete,
  safeRunSnapshot,
  withFixtureProviderReadiness
} from './journey.mjs'
import { VerificationNotRunError } from '../../scripts/verify.mjs'
import { getCases } from './live.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '../..')
const repoRoot = resolve(packageRoot, '../../..')
const synthetic = { key: 'synthetic-W4-do-not-archive', baseUrl: 'https://provider.invalid/v1', model: 'fixture-model', protocol: 'openai-completions' }

// Synthetic snapshots exercise the oracle only; not proof of a live provider.
function fixture() {
  const nonce = 'unique-controlled-nonce'
  const outputJson = JSON.stringify({ outputs: { text: nonce } })
  const snapshot = {
    runId: 'run-fixture',
    state: 'succeeded',
    attempts: [
      { nodeId: 'model', state: 'succeeded', resultKind: 'succeeded', attemptId: 'attempt-fixture', outputJson },
      { nodeId: 'downstream', state: 'succeeded', resultKind: 'succeeded', attemptId: 'downstream-fixture', outputJson }
    ]
  }
  const facts = {
    sessionId: 'bp-run-fixture-attempt-fixture-fixture',
    agentCreated: true,
    inboxSeen: true,
    scopedAgentSeen: true,
    requestSeen: true,
    loopRequestSeen: true,
    responseSeen: true,
    completed: true,
    disposed: true
  }
  return { nonce, snapshot, facts }
}

test('keyless config is typed not-run before any plugin import/profile/provider call', async () => {
  assert.throws(
    () => configuration({}),
    error => error instanceof VerificationNotRunError && error.code === 'VERIFICATION_NOT_RUN' && error.reasonCode === 'LIVE_CONFIGURATION_MISSING'
  )
  const cases = await getCases({ packageRoot: '/nonexistent', repoRoot: '/nonexistent' })
  assert.equal(cases.length, 1)
  // Use an environment-clean child rather than reading/restoring ambient keys.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {getCases} from ${JSON.stringify(join(here, 'live.mjs'))}; const [c]=await getCases({}); try {await c.run(); process.exit(9)} catch(e) {process.stdout.write(JSON.stringify({code:e.code,reason:e.reasonCode})); process.exit(e.code==='VERIFICATION_NOT_RUN'?0:8)}`
    ],
    { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 3000 }
  )
  assert.equal(child.status, 0)
  assert.equal(JSON.parse(child.stdout).reason, 'LIVE_CONFIGURATION_MISSING')
})

test('configuration accepts public protocol aliases without a fixed model and refuses unsupported/auth/placeholder routes', () => {
  for (const [input, expected] of [
    ['openai_responses', 'openai-responses'],
    ['openai_chat_completions', 'openai-completions'],
    ['anthropic_messages', 'anthropic-messages']
  ]) {
    const config = configuration({
      BP_LIVE_PROVIDER_KEY: 'controlled-opaque-value',
      BP_LIVE_PROVIDER_BASE_URL: 'https://provider.invalid/v1',
      BP_LIVE_PROVIDER_MODEL: 'deepseek-flash',
      BP_LIVE_PROVIDER_PROTOCOL: input
    })
    assert.equal(config.protocol, expected)
    assert.equal(config.model, 'deepseek-flash')
  }
  const env = { BP_LIVE_PROVIDER_KEY: 'placeholder', BP_LIVE_PROVIDER_BASE_URL: 'https://provider.invalid', BP_LIVE_PROVIDER_MODEL: 'fixture' }
  assert.throws(() => configuration(env), { code: 'LIVE_SYNTHETIC_CREDENTIAL' })
  assert.throws(() => configuration({ ...env, BP_LIVE_PROVIDER_BASE_URL: 'https://name:secret@provider.invalid' }), { code: 'LIVE_ENDPOINT_INVALID' })
  assert.throws(() => configuration({ ...env, BP_LIVE_PROVIDER_PROTOCOL: 'unknown' }), { code: 'LIVE_PROTOCOL_UNSUPPORTED' })
})

test('environment and profile are isolated; key/base/model/protocol never interpolated into YAML', () => {
  const env = isolatedEnvironment('/isolated', synthetic, {
    PATH: '/bin',
    HOME: '/real',
    OPENAI_API_KEY: 'forbidden',
    DEEPSEEK_API_KEY: 'forbidden',
    NODE_OPTIONS: '--require bad',
    HTTPS_PROXY: 'http://forbidden',
    BP_LIVE_PROVIDER_KEY: 'forbidden'
  })
  assert.equal(env.HOME, '/isolated')
  assert.equal(env.BP_LIVE_PROVIDER_KEY, synthetic.key)
  for (const name of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(env[name], undefined)
  const patch = profilePatch({
    blueprintRoot: '/isolated/bp',
    runtimeRoot: '/isolated/runtime',
    observerModule: '/isolated/observer.mjs',
    toolIds: ['tool-bash']
  })
  assert.match(patch, /apiKeyEnv: BP_LIVE_PROVIDER_KEY/)
  for (const name of ['BASE_URL', 'MODEL', 'PROTOCOL']) assert.match(patch, new RegExp(`!!js process.env.BP_LIVE_PROVIDER_${name}`))
  assert.equal(patch.includes(synthetic.key), false)
  assert.equal(patch.includes(synthetic.baseUrl), false)
  assert.match(patch, /plugins: \[\]/)
  assert.match(patch, /id: tool-bash\n  disabled: true/)
  assert.match(patch, /id: session-persistence-jsonl\n  disabled: true/)
})

test('import/ready/structural-only/provider placeholders cannot satisfy the journey oracle', () => {
  const f = fixture()
  for (const snapshot of [{ ok: true, detail: 'journey harness ready' }, { state: 'ready' }, { ...f.snapshot, attempts: [f.snapshot.attempts[1]] }]) {
    assert.throws(() => assertJourney(snapshot, { sessions: [f.facts] }, f.nonce))
  }
  assert.throws(() => assertJourney(f.snapshot, { sessions: [] }, f.nonce), { code: 'LIVE_AGENT_FACTS_MISSING' })
  for (const field of ['agentCreated', 'inboxSeen', 'scopedAgentSeen', 'requestSeen', 'loopRequestSeen', 'responseSeen', 'completed', 'disposed']) {
    assert.throws(() => assertJourney(f.snapshot, { sessions: [{ ...f.facts, [field]: false }] }, f.nonce), { code: 'LIVE_AGENT_FACTS_MISSING' })
  }
  f.snapshot.attempts[1].outputJson = JSON.stringify({ outputs: { text: 'placeholder' } })
  assert.throws(() => assertJourney(f.snapshot, { sessions: [f.facts] }, f.nonce), { code: 'LIVE_DOWNSTREAM_NONCE_MISSING' })
})

test('oracle emits only bool/IDs/digests and typed sanitized provider failure/timeout', () => {
  const f = fixture()
  const receipt = assertJourney(f.snapshot, { sessions: [f.facts] }, f.nonce)
  assert.equal(receipt.nonceMatched, true)
  assert.equal(JSON.stringify(receipt).includes(f.nonce), false)
  assert.equal(receipt.output_sha256.length, 64)
  for (const [kind, code] of [
    ['provider-failed', 'LIVE_PROVIDER_FAILED'],
    ['timeout', 'LIVE_PROVIDER_TIMEOUT']
  ]) {
    assert.throws(
      () => assertJourney({ state: 'failed', attempts: [{ resultKind: kind, outputJson: 'RAW_SECRET_FROM_PROVIDER' }] }, {}, f.nonce),
      error => error.code === code && !String(error.stack).includes('RAW_SECRET_FROM_PROVIDER')
    )
  }
})

test('journey oracle uses exact canonical attempt session before any legacy prefix candidate', () => {
  const f = fixture()
  const sessionId = 'bp-12345678-1234-1234-1234-123456789abc'
  f.snapshot.attempts[0].sessionId = sessionId
  const receipt = assertJourney(f.snapshot, { sessions: [f.facts, { ...f.facts, sessionId }] }, f.nonce)
  assert.equal(receipt.sessionId, sessionId, 'the reserved canonical execution Session must win over complete legacy-shaped facts')
  assert.equal(receipt.nonceMatched, true)
  assert.equal(receipt.downstreamMatched, true)
})

test('journey oracle rejects wrong Session facts even when their nonce and legacy prefix match', () => {
  const f = fixture()
  const sessionId = 'bp-12345678-1234-1234-1234-123456789abc'
  f.snapshot.attempts[0].sessionId = sessionId
  for (const wrongSession of [f.facts.sessionId, `${sessionId}-suffix`, 'bp-another-reserved-session']) {
    assert.throws(() => assertJourney(f.snapshot, { sessions: [{ ...f.facts, sessionId: wrongSession }] }, f.nonce), { code: 'LIVE_AGENT_FACTS_MISSING' })
  }
  for (const field of ['agentCreated', 'inboxSeen', 'scopedAgentSeen', 'requestSeen', 'loopRequestSeen', 'responseSeen', 'completed', 'disposed']) {
    assert.throws(
      () => assertJourney(f.snapshot, { sessions: [f.facts, { ...f.facts, sessionId, [field]: false }] }, f.nonce),
      { code: 'LIVE_AGENT_FACTS_MISSING' },
      'a complete wrong Session must not compensate for missing canonical Session evidence'
    )
  }
})

test('journey oracle retains prefix fallback only for legacy attempts without sessionId', () => {
  const f = fixture()
  assert.equal(Object.hasOwn(f.snapshot.attempts[0], 'sessionId'), false)
  assert.equal(assertJourney(f.snapshot, { sessions: [f.facts] }, f.nonce).sessionId, f.facts.sessionId)
  assert.throws(() => assertJourney(f.snapshot, { sessions: [{ ...f.facts, sessionId: 'bp-other-run-other-attempt-fixture' }] }, f.nonce), {
    code: 'LIVE_AGENT_FACTS_MISSING'
  })
  f.snapshot.attempts[0].sessionId = ''
  assert.throws(
    () => assertJourney(f.snapshot, { sessions: [f.facts] }, f.nonce),
    { code: 'LIVE_AGENT_FACTS_MISSING' },
    'a present invalid identity must not activate legacy fallback'
  )
})

test('source chain uses supported profile/official Run, read-only observer, and no direct provider HTTP/mock', () => {
  const source = readFileSync(join(here, 'journey.mjs'), 'utf8')
  const observer = readFileSync(join(here, 'observer.mjs'), 'utf8')
  assert.match(source, /'--profile', profile/)
  assert.match(source, /gateway.call\('blueprint\/startRun'/)
  assert.match(source, /gateway.call\('blueprint\/inspectRun'/)
  assert.equal(/routeModule|syntheticRoute|installModelSelection|blueprint-live-route/.test(source), false)
  assert.equal(existsSync(join(here, 'route.mjs')), false, 'no test-only route adapter in the supported live write set')
  assert.match(source, /expectedRevision: definition.documentRevision/)
  assert.match(source, /'model.text', to: 'downstream.text'/)
  assert.equal((source.match(/await fetch\(/g) ?? []).length, 2)
  assert.match(source, /new URL\(`\/api\/\$\{method\}`, url.origin\)/)
  assert.match(observer, /isAgentLoopRequest\(options\)/)
  assert.match(observer, /for await \(const chunk of next\(\)\)/)
  assert.match(observer, /yield chunk/)
  assert.equal(/createAgent\(|\.followup\(|\.stream\(|https?:\/\//.test(observer), false)
  assert.equal(/setFactory|mock|fetch\(config|fetch\(.*baseUrl/.test(source), false)
  assert.equal(/timeoutMs:.*[3-9]\d_000/.test(source), false)
})

test('bounded real DSH Agent failure against synthetic localhost endpoint is sanitized, never live green', { timeout: 45000 }, async t => {
  const canary = 'W4_SYNTHETIC_AUTH_RAW_RESPONSE_CANARY'
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    // Never retain or print request auth/body; emit deliberately hostile error.
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: canary, type: 'authentication_error' } }))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      const prior = requests
      const config = { ...synthetic, protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
      await assert.rejects(runIsolatedJourney({ packageRoot, repoRoot, planId: 'dsh-blueprint-takeover-v1' }, config, { negativeOnly: true }), error => {
        assert.equal(String(error.stack).includes(canary), false)
        assert.equal(String(error.stack).includes(config.key), false)
        assert.equal(String(error.stack).includes(config.baseUrl), false)
        assert.ok(
          error.synthetic_evidence.sessions.some(s => s.agentCreated && s.inboxSeen && s.scopedAgentSeen && s.requestSeen && s.loopRequestSeen && s.disposed),
          'public Agent/inbox/AgentLoop facts must exist'
        )
        assert.equal(error.code, 'LIVE_PROVIDER_FAILED', 'must reach actual Agent provider failure, not boot/fixture/unrelated failure')
        return true
      })
      assert.ok(requests > prior, 'each public protocol must actually call the synthetic error endpoint')
    }
    t.diagnostic(JSON.stringify({ synthetic_only: true, provider_failed: true, request_seen: requests > 0, sanitized: true, live_passed: false }))
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
})

// This fixture calibrates the complete production path, not provider truth.
// A synthetic successful model MUST still fail the live entry point.
test('synthetic nonce response traverses actual Agent/Run/downstream but is never live green', { timeout: 45000 }, async t => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 65536) req.destroy()
    })
    req.on('end', () => {
      const nonce = data.match(/bp-live-[a-f0-9-]{36}/)?.[0]
      // Request stays only in bounded fixture memory; never print/archive it.
      data = ''
      assert.ok(nonce, 'the formal Run input must reach the provider')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'synthetic-completion',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: nonce }, finish_reason: null }]
          }) +
          '\n\n' +
          'data: ' +
          JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const config = { ...synthetic, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
    await assert.rejects(runIsolatedJourney({ packageRoot, repoRoot }, config, { negativeOnly: true }), error => {
      assert.equal(error.code, 'LIVE_SYNTHETIC_SUCCESS_REJECTED')
      assert.equal(error.synthetic_evidence.behavior_assertions.nonceMatched, true)
      assert.equal(error.synthetic_evidence.behavior_assertions.downstreamMatched, true)
      assert.equal(error.synthetic_evidence.behavior_assertions.completed, true)
      const behavior = error.synthetic_evidence.behavior_assertions
      const sessionPrefix = `bp-${behavior.runId}-${behavior.attemptId}-`
      assert.match(behavior.sessionId, /^[A-Za-z0-9_-]+$/, 'actual reserved execution ID must traverse the production Run/Agent path')
      assert.ok(
        behavior.sessionId.startsWith(sessionPrefix) && behavior.sessionId.length > sessionPrefix.length,
        'the real path must bind execution identity to the durable Run and Attempt'
      )
      assert.ok(
        error.synthetic_evidence.sessions.some(
          session => session.sessionId === behavior.sessionId && session.agentCreated && session.completed && session.disposed
        )
      )
      assert.equal(JSON.stringify(error.synthetic_evidence).includes('outputs'), false)
      return true
    })
    assert.equal(requests, 1)
    await assert.rejects(runIsolatedJourney({ packageRoot, repoRoot }, config), { code: 'LIVE_ENDPOINT_INVALID' })
    assert.equal(requests, 1, 'non-negative entry rejects before dispatch')
    t.diagnostic(JSON.stringify({ synthetic_only: true, formal_run_nonce: true, downstream_nonce: true, live_passed: false }))
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

test('provider module readiness is isolated to validated negative idle fixtures', () => {
  const source = 'export function apply() {}\n'
  for (const negativeOnly of [false, true]) assert.equal(withFixtureProviderReadiness(source, 'openai-completions', { negativeOnly }), source)
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    assert.equal(
      withFixtureProviderReadiness(source, protocol, { negativeOnly: true, fixtureProviderIdleTimeoutMs: 100 }),
      `await import("@earendil-works/pi-ai/api/${protocol}")\n${source}`
    )
  }
  for (const fixtureProviderIdleTimeoutMs of [0, -1, 1.5, Infinity, 2147483648]) {
    assert.throws(() => withFixtureProviderReadiness(source, 'openai-completions', { negativeOnly: true, fixtureProviderIdleTimeoutMs }), {
      code: 'LIVE_SYNTHETIC_FIXTURE_INVALID'
    })
  }
  assert.throws(() => withFixtureProviderReadiness(source, 'openai-completions', { fixtureProviderIdleTimeoutMs: 100 }), {
    code: 'LIVE_SYNTHETIC_FIXTURE_INVALID'
  })
  assert.throws(() => withFixtureProviderReadiness(source, '../private-module', { negativeOnly: true, fixtureProviderIdleTimeoutMs: 100 }), {
    code: 'LIVE_SYNTHETIC_FIXTURE_INVALID'
  })
})

test('DSH provider idle settings settle a hanging fixture without a Blueprint total deadline', { timeout: 45000 }, async t => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const start = Date.now()
    const config = { ...synthetic, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
    await assert.rejects(runIsolatedJourney({ packageRoot, repoRoot }, config, { negativeOnly: true, fixtureProviderIdleTimeoutMs: 100 }), error => {
      t.diagnostic(JSON.stringify({ synthetic_only: true, observed_reason_code: error.code, safe_observation: error.synthetic_evidence }))
      assert.equal(error.code, 'LIVE_PROVIDER_FAILED')
      assert.equal(error.synthetic_evidence.run_snapshot.state, 'failed')
      assert.ok(error.synthetic_evidence.run_snapshot.attempts.some(a => a.nodeId === 'model' && a.state === 'failed' && a.resultKind === 'provider-failed'))
      assert.ok(error.synthetic_evidence.sessions.some(s => s.agentCreated && s.inboxSeen && s.loopRequestSeen && s.disposed))
      assert.equal(String(error.stack).includes(config.baseUrl), false)
      return true
    })
    assert.equal(requests, 1, 'the isolated DSH fixture disables retry and settles its one idle request')
    assert.ok(Date.now() - start < 10000, 'the configured DSH idle timeout must settle before the old Blueprint cutoff')
    t.diagnostic(JSON.stringify({ synthetic_only: true, dsh_stream_idle_timeout_ms: 100, blueprint_total_deadline_ms: null, live_passed: false }))
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

test('timeout observation includes the actual production timed_out terminal without increasing its bound', () => {
  const source = readFileSync(join(here, 'journey.mjs'), 'utf8')
  assert.equal(/['"]timed_out['"]/.test(source), true, 'SOURCE RED: production timed_out must be recognized, not misreported as observation timeout')
  assert.equal(isRunObservationComplete('timed_out'), true)
  assert.equal(isRunObservationComplete('running'), false)
  assert.equal((source.match(/isRunObservationComplete\(snapshot.state\)/g) ?? []).length, 2)
  const raw = 'RAW_RESPONSE_AUTH_URL_OR_SECRET'
  const safe = safeRunSnapshot({
    runId: 'run-source',
    state: 'timed_out',
    attempts: [{ attemptId: 'att-source', nodeId: 'model', state: 'timed_out', resultKind: 'timeout', outputJson: raw, secret: raw }]
  })
  assert.equal(JSON.stringify(safe).includes(raw), false)
  assert.equal(safe.state, 'timed_out')
  assert.equal(safe.attempts[0].resultKind, 'timeout')
  assert.equal(safe.attempts[0].output_sha256.length, 64)
  assert.throws(() => assertJourney({ state: 'timed_out', attempts: [{ resultKind: 'timeout' }] }, {}, 'nonce'), { code: 'LIVE_PROVIDER_TIMEOUT' })
  assert.match(source, /const deadline = Date.now\(\) \+ 30000/)
})
