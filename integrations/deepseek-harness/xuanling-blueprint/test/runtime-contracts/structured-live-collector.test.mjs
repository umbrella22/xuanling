// Pure observer/oracle tests. Synthetic event inputs NEVER prove a live gate.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStructuredObserver, assertStructuredJourney, parseCli, classifyFailure, createReceipt,
  createStructuredBlueprint, observeStructuredRun, sha256 } from '../live/runtime-contracts-journey.mjs'
import { configuration, isolatedEnvironment, profilePatch } from '../live/journey.mjs'
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../test/blueprint/package.json'))
const { markAgentLoopRequest, isAgentLoopRequest } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const RUN = 'run-11111111-1111-4111-8111-111111111111'
const ATT = 'att-22222222-2222-4222-8222-222222222222'
const NONCE = 'controlled-nonce-EXACT'
const expected = () => ({ nonce: NONCE, inputJson: JSON.stringify({ nonce: NONCE }), schemaSha256: sha256('schema'),
  agentSha256: sha256('agent'), model: 'fixture-model', semanticRevision: 'saved-document-revision' })
function fixture() {
  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn) }, get(name) { return name === 'agents' ? { currentInitiator: () => initiator } : undefined } }
  let initiator
  const events = []
  const agent = { id: `bp-${RUN}-${ATT}-abcdef12`, ctx: { tools: {} }, session: { snapshotEvents: () => events } }
  const published = []
  const observer = createStructuredObserver(ctx, { nonce: NONCE, isAgentLoopRequest, hash: sha256, flush: facts => published.push(facts) })
  const emit = (event, ...args) => handlers.get(event)?.(...args)
  const start = () => {
    emit('agent/created', { agent })
    emit('agent/inbox/inserted', { agent, message: { content: [{ type: 'text', text: '[blueprint agent]\nPROMPT_SECRET' }] } })
    return emit('agent/request', { agent, signal: new AbortController().signal }, async () => ({ provider: 'fixture-provider', model: 'fixture-model' }))
  }
  const stream = async (marked = true, chunks = [], current = agent) => {
    initiator = current
    const options = Object.freeze({ provider: 'blueprint-live', model: 'fixture-model', sessionId: current.id })
    if (marked) markAgentLoopRequest(options)
    const next = async function* () { yield* chunks }
    const yielded = []
    const iterator = handlers.get('llm/stream')?.(options, next)
    if (iterator) for await (const chunk of iterator) yielded.push(chunk)
    return { yielded, options }
  }
  const result = (args = { nonce: NONCE }, extra = {}, value = { recorded: true }, owner = agent) => {
    const exec = { name: 'structured_output', token: Symbol('execution'), arguments: args, agent: owner, ...extra }
    emit('tools/result', exec, { isError: false, value, concludesTurn: true })
    return exec
  }
  const dispose = (reason = 'completed') => { events.push({ type: 'turn/end', data: { reason: { kind: reason } } }); emit('agent/disposed', { agent }) }
  return { observer, published, agent, events, ctx, emit, start, stream, result, dispose }
}
function snapshot() {
  return { runId: RUN, state: 'succeeded', definitionRevision: 'saved-document-revision', attempts: [
    { nodeId: 'model', attemptId: ATT, state: 'succeeded', resultKind: 'succeeded',
      outputJson: JSON.stringify({ outputs: { payload: { nonce: NONCE } } }), diagnostics: { status: 'available',
        input: { type: 'object', bytes: Buffer.byteLength(expected().inputJson), sha256: sha256(expected().inputJson) },
        resourceDigests: { answerSchema: sha256('schema'), worker: sha256('agent'), $package: sha256('frozen-package') },
        modelSelection: { provider: 'blueprint-live', model: 'fixture-model' }, tools: { effectiveNames: [], denials: [] }, acceptance: { code: 'accepted' } } },
    { nodeId: 'downstream', attemptId: 'att-33333333-3333-4333-8333-333333333333', state: 'succeeded', resultKind: 'succeeded',
      outputJson: JSON.stringify({ outputs: { payload: { nonce: NONCE } } }) },
  ] }
}
async function good() { const h = fixture(); await h.start(); await h.stream(); h.result(); h.dispose(); return h }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)

test('C-03/C-04 live collector: public marker + authoritative result works without text-delta', async () => {
  const h = await good()
  const facts = assertStructuredJourney(snapshot(), h.observer.snapshot(), expected())
  assert.equal(facts.authoritativeStructuredResult, true)
  assert.equal(facts.exactNonceMatched, true)
  assert.equal(facts.downstreamMatched, true)
  assert.equal(facts.schemaValidAcceptance, true)
  assert.equal(h.observer.snapshot().sessions[0].textDeltaCount, 0)
})
test('C-03 live observer: stream is lossless and exact marker object is not copied', async () => {
  const h = fixture(); await h.start()
  const chunk = { type: 'tool-call-end', nonce: 'RAW_STREAM_SECRET' }
  const { yielded, options } = await h.stream(true, [chunk])
  assert.equal(isAgentLoopRequest(options), true)
  assert.equal(isAgentLoopRequest({ ...options }), false)
  assert.equal(yielded[0], chunk)
  assert.equal(h.observer.snapshot().sessions[0]?.markedRequestCount, 1)
})
for (const [title, chunks] of [
  ['text-only JSON', [{ type: 'text-delta', text: JSON.stringify({ nonce: NONCE }) }]],
  ['prompt echo', [{ type: 'text-delta', text: '[blueprint agent] ' + NONCE }]],
  ['tool-call without result', [{ type: 'tool-call-end', name: 'structured_output', arguments: { nonce: NONCE } }]],
]) test(`C-03 live collector rejects ${title} as capture`, async () => {
  const h = fixture(); await h.start(); await h.stream(true, chunks); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
for (const [title, args] of [['wrong nonce', { nonce: 'wrong' }], ['trimmed nonce', { nonce: ` ${NONCE}` }],
  ['extra field', { nonce: NONCE, extra: true }], ['string JSON', JSON.stringify({ nonce: NONCE })], ['null', null]]) {
  test(`C-03 live observer rejects ${title}`, async () => {
    const h = fixture(); await h.start(); await h.stream(); h.result(args); h.dispose()
    rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_NONCE_MISMATCH')
  })
}
for (const [title, change] of [
  ['unmarked request', async h => h.stream(false)],
  ['foreign initiator', async h => h.stream(true, [], { id: h.agent.id })],
  ['cumulative marker leak', async h => { await h.stream(); await h.stream(false) }],
]) test(`C-03 marker attribution rejects ${title}`, async () => {
  const h = fixture(); await h.start(); await change(h); h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_MARKER_MISSING')
})
test('C-03 authority never borrows a same-ID foreign Agent result', async () => {
  const h = fixture(); await h.start(); await h.stream(); h.result(undefined, {}, undefined, { id: h.agent.id }); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
for (const value of [{ recorded: false }, { recorded: true, extra: 1 }, JSON.stringify({ recorded: true }), null]) {
  test(`C-03 tools/result receipt shape rejects ${JSON.stringify(value)}`, async () => {
    const h = fixture(); await h.start(); await h.stream(); h.result(undefined, {}, value); h.dispose()
    rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
  })
}
test('C-03 tool error does not authorize otherwise correct nonce', async () => {
  const h = fixture(); await h.start(); await h.stream()
  h.emit('tools/result', { name: 'structured_output', agent: h.agent, arguments: { nonce: NONCE }, token: Symbol() }, { isError: true, error: { message: 'RAW_ERROR_SECRET' } }); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
for (const outcome of ['pending', 'failed', 'wrong-token', 'wrong-agent', 'committed']) test(`C-03 PTC parent barrier ${outcome}`, async () => {
  const h = fixture(); await h.start(); await h.stream()
  const token = Symbol('parent'); h.result(undefined, { parent: token })
  assert.equal(h.observer.snapshot().sessions[0]?.authoritativeResultCount, 0)
  if (outcome !== 'pending') h.emit('tools/result', { name: 'run_code', token: outcome === 'wrong-token' ? Symbol() : token,
    agent: outcome === 'wrong-agent' ? { id: h.agent.id } : h.agent }, { isError: outcome === 'failed', value: {} })
  h.dispose()
  if (outcome === 'committed') assert.equal(assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()).authoritativeStructuredResult, true)
  else rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
test('C-03 completed terminal cannot be borrowed from an earlier turn', async () => {
  const h = await good(); h.dispose('error')
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_TERMINAL_INCOMPLETE')
})
for (const state of ['running', 'timed_out', 'failed', 'recovery_required', 'cancelled']) test(`C-04 live state ${state} is never success`, async () => {
  const h = await good(); const s = snapshot(); s.state = state
  rejects(() => assertStructuredJourney(s, h.observer.snapshot(), expected()), state === 'running' ? 'STRUCTURED_OBSERVATION_TIMEOUT' : 'STRUCTURED_RUN_NOT_SUCCEEDED')
})
for (const [title, edit, code] of [
  ['saved admission revision', s => s.definitionRevision = 'other', 'STRUCTURED_SAVED_REVISION_MISMATCH'],
  ['legacy diagnostics', s => s.attempts[0].diagnostics = { status: 'unavailable' }, 'STRUCTURED_DIAGNOSTICS_UNAVAILABLE'],
  ['invented schema-valid spelling', s => s.attempts[0].diagnostics.acceptance.code = 'schema-valid', 'STRUCTURED_ACCEPTANCE_MISMATCH'],
  ['changed model', s => s.attempts[0].diagnostics.modelSelection.model = 'other', 'STRUCTURED_MODEL_MISMATCH'],
  ['changed schema', s => s.attempts[0].diagnostics.resourceDigests.answerSchema = sha256('other'), 'STRUCTURED_SCHEMA_DIGEST_MISMATCH'],
  ['changed agent', s => s.attempts[0].diagnostics.resourceDigests.worker = sha256('other'), 'STRUCTURED_AGENT_DIGEST_MISMATCH'],
  ['changed input', s => s.attempts[0].diagnostics.input.bytes++, 'STRUCTURED_INPUT_DIGEST_MISMATCH'],
  ['effective permissions', s => s.attempts[0].diagnostics.tools.effectiveNames.push('forbidden'), 'STRUCTURED_TOOL_POLICY_MISMATCH'],
  ['text producer only', s => s.attempts[0].outputJson = JSON.stringify({ outputs: { payload: NONCE } }), 'STRUCTURED_OUTPUT_MISMATCH'],
  ['wrong downstream', s => s.attempts[1].outputJson = JSON.stringify({ outputs: { payload: { nonce: 'wrong' } } }), 'STRUCTURED_DOWNSTREAM_MISMATCH'],
  ['text downstream JSON', s => s.attempts[1].outputJson = JSON.stringify({ outputs: { payload: JSON.stringify({ nonce: NONCE }) } }), 'STRUCTURED_DOWNSTREAM_MISMATCH'],
]) test(`C-04 durable oracle rejects ${title}`, async () => {
  const h = await good(); const s = snapshot(); edit(s)
  rejects(() => assertStructuredJourney(s, h.observer.snapshot(), expected()), code)
})
test('C-08 observer projection omits prompts, nonce, raw tool arguments/results/errors and IDs', async () => {
  const h = fixture(); await h.start(); await h.stream(true, [{ type: 'text-delta', text: 'RAW_TEXT_SECRET' }])
  h.result({ nonce: NONCE, extra: 'RAW_ARGS_SECRET' }); h.emit('agent/error', { agent: h.agent, error: new Error('RAW_ERROR_SECRET') }); h.dispose()
  const text = JSON.stringify(h.published)
  for (const forbidden of [NONCE, 'PROMPT_SECRET', 'RAW_TEXT_SECRET', 'RAW_ARGS_SECRET', 'RAW_ERROR_SECRET', RUN, ATT]) assert.equal(text.includes(forbidden), false)
  assert.equal(h.observer.snapshot().sessions[0]?.runtimeErrorSeen, true)
})
test('C-08 missing environment is typed not-run, raw errors are fixed nonzero codes', () => {
  let missing; try { configuration({}) } catch (error) { missing = error }
  assert.deepEqual(classifyFailure(missing), { status: 'not-run', code: 'LIVE_CONFIGURATION_MISSING', exit_code: 2 })
  assert.deepEqual(classifyFailure(new Error('SECRET endpoint auth prompt')), { status: 'failed', code: 'STRUCTURED_LIVE_FAILED', exit_code: 1 })
})
test('C-08 CLI accepts only frozen plan and absolute report dir, no credential flags', () => {
  assert.deepEqual(parseCli(['--plan-id', 'dsh-blueprint-runtime-contracts-v1', '--report-dir', '/tmp/report']), { planId: 'dsh-blueprint-runtime-contracts-v1', reportDir: '/tmp/report' })
  for (const args of [[], ['--key', 'SECRET'], ['--plan-id', 'other', '--report-dir', '/tmp/report'],
    ['--plan-id', 'dsh-blueprint-runtime-contracts-v1', '--report-dir', 'relative']]) rejects(() => parseCli(args), 'STRUCTURED_CLI_INVALID')
})
test('C-08 CLI rejects every U+0000 through U+001F report-dir character', () => {
  for (let code = 0; code <= 0x1f; code++) {
    const reportDir = '/tmp/report' + String.fromCharCode(code)
    rejects(() => parseCli(['--plan-id', 'dsh-blueprint-runtime-contracts-v1', '--report-dir', reportDir]), 'STRUCTURED_CLI_INVALID')
  }
})
test('C-08 CLI preserves allowed space, DEL and higher Unicode report-dir characters', () => {
  for (const code of [0x20, 0x7f, 0x80, 0x4e2d, 0x1f600]) {
    const reportDir = '/tmp/report' + String.fromCodePoint(code)
    assert.deepEqual(parseCli(['--plan-id', 'dsh-blueprint-runtime-contracts-v1', '--report-dir', reportDir]), { planId: 'dsh-blueprint-runtime-contracts-v1', reportDir })
  }
})
test('C-08 receipts whitelist fields, bind both fingerprints and reject stale success', () => {
  const before = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  const spec = { planId: 'dsh-blueprint-runtime-contracts-v1', reportDir: '/tmp/report', cwd: '/workspace/blueprint',
    startedAt: '2026-10-06T00:00:00.000Z', finishedAt: '2026-10-06T00:00:01.000Z', before, after: before,
    result: { status: 'passed', code: 'STRUCTURED_LIVE_VERIFIED', exit_code: 0 },
    identity: { os: 'darwin', arch: 'arm64', osRelease: '25.0', node: 'v24.11.1', dshVersion: '0.2.1-alpha.1' },
    protocol: 'openai-completions', assertions: { exactNonceMatched: true, raw: 'SECRET' }, raw: 'SECRET' }
  const r = createReceipt(spec)
  assert.equal(r.status, 'passed'); assert.equal(r.before.source_sha256, before.source_sha256)
  assert.equal(r.after.artifact_sha256, before.artifact_sha256); assert.equal(r.identity.dshVersion, '0.2.1-alpha.1')
  assert.equal(r.exact_command, 'node test/live/runtime-contracts-journey.mjs --plan-id dsh-blueprint-runtime-contracts-v1 --report-dir /tmp/report')
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  const stale = createReceipt({ ...spec, after: { ...before, source_sha256: 'd'.repeat(64) } })
  assert.equal(stale.status, 'failed'); assert.equal(stale.reason_code, 'STRUCTURED_FINGERPRINT_CHANGED'); assert.equal(stale.exit_code, 1)
})
test('C-03 temporary definition has object-root schema, one scoped model and exact JSON downstream', () => {
  // Return bytes without disk writes: runner writes these only under its temp root.
  const b = createStructuredBlueprint()
  assert.ok(b.definition, 'STRUCTURED_BLUEPRINT_CAPABILITY_MISSING')
  assert.equal(b.definition.id, 'live-journey')
  assert.equal(b.definition.graph.nodes[0].outputSchemaRef, 'answerSchema')
  assert.equal(b.definition.graph.nodes[0].outputs.payload, 'json')
  const schema = JSON.parse(b.schemaBytes)
  assert.equal(schema.type, 'object'); assert.deepEqual(schema.required, ['nonce']); assert.equal(schema.additionalProperties, false)
  assert.equal(b.definition.graph.nodes.filter(n => n.kind === 'agentTask').length, 1)
})


test('C-03 public config/profile preserve responses protocol without leaking provider config', () => {
  const env = { BP_LIVE_PROVIDER_KEY: 'opaque-credential-sentinel', BP_LIVE_PROVIDER_BASE_URL: 'https://provider.invalid/v1',
    BP_LIVE_PROVIDER_MODEL: 'fixture-model', BP_LIVE_PROVIDER_PROTOCOL: 'openai-responses' }
  const config = configuration(env)
  assert.equal(config.protocol, 'openai-responses')
  const isolated = isolatedEnvironment('/temporary-home', config, { PATH: '/bin', SECRET: 'never-inherit' })
  assert.equal(isolated.BP_LIVE_PROVIDER_PROTOCOL, 'openai-responses')
  assert.equal(Object.hasOwn(isolated, 'SECRET'), false)
  const patch = profilePatch({ blueprintRoot: '/temporary-blueprint', runtimeRoot: '/temporary-runtime', observerModule: '/temporary-observer' })
  assert.equal(patch.includes('process.env.BP_LIVE_PROVIDER_PROTOCOL'), true)
  assert.equal(patch.includes('blueprints'), true)
  assert.equal(patch.includes('live-journey'), true)
  assert.equal(patch.includes(env.BP_LIVE_PROVIDER_KEY), false)
  assert.equal(patch.includes(env.BP_LIVE_PROVIDER_BASE_URL), false)
})
test('C-03 observer still forwards an unmarked stream and does not borrow its text', async () => {
  const h = fixture(); await h.start()
  const chunk = { type: 'text-delta', text: 'raw-unmarked-text' }
  const { yielded } = await h.stream(false, [chunk])
  assert.equal(yielded[0], chunk)
  assert.equal(h.observer.snapshot().sessions[0].markedRequestCount, 0)
  assert.equal(h.observer.snapshot().sessions[0].textDeltaCount, 0)
})
test('C-03 aborted request with later correct result cannot be accepted', async () => {
  const h = fixture(); await h.start(); await h.stream()
  const controller = new AbortController()
  await h.emit('agent/request', { agent: h.agent, signal: controller.signal }, async () => ({}))
  controller.abort(); h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_MARKER_MISSING')
})
test('C-03 stream failure cannot authorize subsequent forged success', async () => {
  const h = fixture(); await h.start()
  // Establish exact current initiator, then throw in the next marked stream.
  await h.stream(false)
  const options = { provider: 'blueprint-live', model: 'fixture-model', sessionId: h.agent.id }; markAgentLoopRequest(options)
  const chunks = h.emit('llm/stream', options, async function* () { yield await Promise.reject(new Error('RAW_STREAM_ERROR_SECRET')) })
  await assert.rejects(async () => { for await (const _ of chunks) {} }, /RAW_STREAM_ERROR_SECRET/)
  h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_MARKER_MISSING')
  assert.equal(JSON.stringify(h.observer.snapshot()).includes('RAW_STREAM_ERROR_SECRET'), false)
})
test('C-03 PTC failed parent cannot later be committed by duplicate success', async () => {
  const h = fixture(); await h.start(); await h.stream()
  const token = Symbol('parent'); h.result(undefined, { parent: token })
  const exec = { name: 'run_code', token, agent: h.agent }
  h.emit('tools/result', exec, { isError: true }); h.emit('tools/result', exec, { isError: false, value: {} }); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
test('C-03 pending PTC capture cannot borrow a same-string token', async () => {
  const h = fixture(); await h.start(); await h.stream()
  h.result(undefined, { parent: Symbol('same-description') })
  h.emit('tools/result', { name: 'run_code', token: Symbol('same-description'), agent: h.agent }, { isError: false, value: {} }); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AUTHORITY_MISSING')
})
test('C-03 successful disposal requires a real terminal turn/end', async () => {
  const h = fixture(); await h.start(); await h.stream(); h.result()
  h.emit('agent/disposed', { agent: h.agent })
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_TERMINAL_INCOMPLETE')
})
test('C-03 scoped fact is not satisfied by a root-context Agent', async () => {
  const h = fixture(); h.agent.ctx = h.ctx; await h.start(); await h.stream(); h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_AGENT_FACTS_MISSING')
})
test('C-04 observer deadline stops at 30s without sleep or provider retry', async () => {
  let clock = 0, calls = 0, waits = 0
  await assert.rejects(() => observeStructuredRun(async () => { calls++; clock += 10000; return { state: 'running' } }, {
    now: () => clock, pause: async ms => { assert.equal(ms <= 50, true); waits++; clock += ms },
  }), error => error.code === 'STRUCTURED_OBSERVATION_TIMEOUT')
  assert.equal(calls, 3); assert.equal(waits, 2)
})
test('C-04 observation rejects a terminal response received beyond the fixed deadline', async () => {
  let clock = 0
  await assert.rejects(() => observeStructuredRun(async () => { clock = 30001; return snapshot() }, { now: () => clock, pause: async () => {} }),
    error => error.code === 'STRUCTURED_OBSERVATION_TIMEOUT')
})
test('C-04 terminal failure stops observation immediately, it is never retried into success', async () => {
  let calls = 0
  const result = await observeStructuredRun(async () => { calls++; return { state: 'failed' } }, { now: () => 0, pause: async () => assert.fail('must not pause') })
  assert.equal(result.state, 'failed'); assert.equal(calls, 1)
})

test('C-03 marker cannot be borrowed from another session even with the right initiator', async () => {
  const h = fixture(); await h.start(); await h.stream(false)
  const options = { sessionId: 'foreign-session', provider: 'blueprint-live', model: 'fixture-model' }
  markAgentLoopRequest(options)
  for await (const _ of h.emit('llm/stream', options, async function* () {})) {}
  h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_MARKER_MISSING')
})
test('C-08 actual marked LLM route must equal durable modelSelection, not just defaults', async () => {
  const h = fixture(); await h.start(); await h.stream(false)
  const options = { sessionId: h.agent.id, provider: 'foreign-provider', model: 'foreign-model' }
  markAgentLoopRequest(options)
  for await (const _ of h.emit('llm/stream', options, async function* () {})) {}
  h.result(); h.dispose()
  rejects(() => assertStructuredJourney(snapshot(), h.observer.snapshot(), expected()), 'STRUCTURED_MODEL_MISMATCH')
  const archived = JSON.stringify(h.observer.snapshot())
  assert.equal(archived.includes('foreign-provider'), false); assert.equal(archived.includes('foreign-model'), false)
})

test('C-08 failure receipt preserves only fixed acceptance/result codes, never raw failures', () => {
  const fingerprint = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  const spec = { reportDir: '/tmp/report', cwd: '/workspace/blueprint', before: fingerprint, after: fingerprint,
    identity: { os: 'darwin', arch: 'arm64', osRelease: '25.0', node: 'v24.11.1', dshVersion: '0.2.1-alpha.1' },
    assertions: { acceptance_code: 'accepted', producer_result_code: 'succeeded', raw: 'RAW_ERROR_SECRET' },
    result: { status: 'failed', code: 'STRUCTURED_ACCEPTANCE_MISMATCH', exit_code: 1 } }
  const receipt = createReceipt(spec)
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.exit_code, 1)
  assert.equal(receipt.assertions.acceptance_code, 'accepted')
  const unknown = createReceipt({ ...spec, result: { status: 'RAW_STATUS_SECRET', code: 'RAW_ERROR_SECRET', exit_code: 0 } })
  assert.equal(unknown.status, 'failed'); assert.equal(unknown.exit_code, 1)
  assert.equal(unknown.reason_code, 'STRUCTURED_LIVE_FAILED')
  assert.equal(JSON.stringify(unknown).includes('RAW_'), false)
})
