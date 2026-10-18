import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { harness, definition, agentNode, runArgs, drain, records } from '../runtime-contracts/agent-fixtures.mjs'
import { callerSource } from '../../src/conversation/host-tools.ts'
import { TYPERT } from '../../src/typert.host.ts'
import { inspectSessionCodec, frozenPresentationCodec } from '../../src/conversation/contracts.ts'

async function liveHarness(t, options = {}) {
  const h = await harness(t, { ...options, factory: false })
  const registryFiber = await h.ctx.plugin(AgentRegistry)
  // Public real AgentRegistry owns caller identities; only the model/factory
  // boundary is scripted using the existing public create fixture.
  t.mock.method(h.ctx.agents, 'create', h.host.registry.create.bind(h.host.registry))
  const projectionFiber = await h.ctx.plugin(SessionProjections)
  h.ctx.sessionProjections.register({
    key: 'turnBoundary',
    stateVersion: 1,
    init: () => ({ lastTurn: 0, openTurnStartSeq: null }),
    apply: (state, event) => (event.type === 'turn/start' ? { lastTurn: event.data.turn, openTurnStartSeq: event.seq } : state)
  })
  const add = async (id, origin) => {
    id = SessionId(id)
    const session = Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false, ...(origin ? { origin } : {}) })
    const agent = { id, session, status: 'running', whenIdle: () => Promise.resolve(), cancel() {} }
    const scope = createScope(h.ctx, agent)
    agent.ctx = scope.ctx
    const unregister = await h.ctx.agents.register(agent)
    session.append('turn/start', { turn: 7 })
    t.after(async () => {
      await unregister()
      await scope.dispose()
    })
    return agent
  }
  const caller = await add('root-caller')
  t.after(async () => {
    await projectionFiber.dispose()
    await registryFiber.dispose()
  })
  const tool = (name, args = {}, agent = caller, callId = 'native-call') =>
    h.nativeTools.execute({
      name,
      arguments: args,
      callId: ToolCallId(callId),
      ...(agent === undefined ? {} : { agent }),
      signal: new AbortController().signal
    })
  return { ...h, add, caller, tool }
}
function value(result) {
  assert.equal(result.isError, false, JSON.stringify(result))
  return JSON.parse(
    result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  )
}
const code = expected => error => error.code === expected
const codec = method => TYPERT.invocations.find(invocation => invocation.method === method)

test('W2.1 RunQuery boundary exposes cursor pagination, filters and typed malformed-cursor failure', async t => {
  const h = await liveHarness(t)
  const handle = await h.service.configuredRuntime()
  const definitionJson = JSON.stringify(definition())
  const makeRun = async (index, sessionId, blueprintId, state = 'succeeded') => {
    const inputJson = JSON.stringify({ index })
    const admission = await handle.store.createRun(
      {
        scope: 'run',
        requestId: `w2-query-${index}`,
        payloadFingerprint: createHash('sha256').update(`${definitionJson}\0${inputJson}`).digest('hex')
      },
      'w2-query-revision',
      definitionJson,
      inputJson,
      { blueprintId, source: { sessionId, kind: 'ui' } }
    )
    await handle.store.settleTerminal(admission.runId, state, { reason: 'w2-query-fixture' })
    return admission.runId
  }
  for (let index = 0; index < 45; index++) await makeRun(index, 'w2-session-a', index % 2 === 0 ? 'w2-blueprint-a' : 'w2-blueprint-b')
  await makeRun(100, 'w2-session-b', 'w2-blueprint-a', 'failed')

  assert.equal(typeof h.service.queryRuns, 'function', 'W2.1 QUERY_BOUNDARY_MISSING: history still has no typed query entry point')
  const before = await handle.store.get((await handle.store.listRunIds())[0])
  const first = await h.service.queryRuns({ sessionId: 'w2-session-a', limit: 20 })
  assert.equal(first.runs.length, 20)
  assert.ok(first.nextCursor, 'W2.1 QUERY_CURSOR_MISSING: a bounded page must expose continuation')
  assert.equal(
    first.runs.every(run => run.source?.sessionId === undefined),
    true,
    'W2.1 QUERY_RAW_SOURCE_LEAK: summaries must omit source/session internals'
  )
  const second = await h.service.queryRuns({ sessionId: 'w2-session-a', limit: 20, cursor: first.nextCursor })
  assert.equal(second.runs.length, 20)
  assert.equal(new Set([...first.runs, ...second.runs].map(run => run.runId)).size, 40)
  assert.ok(second.nextCursor)
  const filtered = await h.service.queryRuns({ sessionId: 'w2-session-a', blueprintId: 'w2-blueprint-a', state: 'succeeded', limit: 100 })
  assert.equal(filtered.runs.length, 23)
  await assert.rejects(
    () => h.service.queryRuns({ sessionId: 'w2-session-a', cursor: '%%%invalid%%%' }),
    error => error.code === 'blueprint/invalid-cursor'
  )
  assert.deepEqual(await handle.store.get(before.runId), before, 'W2.1 QUERY_MUTATED_CANONICAL: history reads must not rewrite RunRecord')
})

test('W2.5 explicit Run archive is reversible, hides only the projection and preserves canonical facts', async t => {
  const h = await liveHarness(t)
  const handle = await h.service.configuredRuntime()
  const definitionJson = JSON.stringify(definition())
  const admission = await handle.store.createRun(
    { scope: 'run', requestId: 'w2-archive', payloadFingerprint: 'w2-archive' },
    'w2-archive-revision',
    definitionJson,
    '{}',
    { blueprintId: 'w2-archive-blueprint', source: { sessionId: 'w2-archive-session', kind: 'ui' } }
  )
  await handle.store.settleTerminal(admission.runId, 'succeeded', { reason: 'w2-archive-fixture' })
  const before = await handle.store.get(admission.runId)
  assert.deepEqual(await h.service.archiveRun({ runId: admission.runId }), { runId: admission.runId, archived: true })
  assert.deepEqual(await h.service.queryRuns({ sessionId: 'w2-archive-session' }), { runs: [] })
  assert.equal((await h.service.queryRuns({ sessionId: 'w2-archive-session', includeArchived: true })).runs[0].archived, true)
  assert.deepEqual(await handle.store.get(admission.runId), before, 'archive must not rewrite RunRecord seq/state/attempts')
  assert.deepEqual(await h.service.restoreRun({ runId: admission.runId }), { runId: admission.runId, archived: false })
  assert.equal((await h.service.queryRuns({ sessionId: 'w2-archive-session' })).runs[0].archived, false)

  const active = await handle.store.createRun(
    { scope: 'run', requestId: 'w2-archive-active', payloadFingerprint: 'w2-archive-active' },
    'w2-archive-revision',
    definitionJson,
    '{}',
    { blueprintId: 'w2-archive-blueprint', source: { sessionId: 'w2-archive-session', kind: 'ui' } }
  )
  await assert.rejects(
    () => h.service.archiveRun({ runId: active.runId }),
    error => error.code === 'blueprint/run-lifecycle-conflict'
  )
})

test('host: native tools expose catalog revision, authoritative caller/turn, replay and strict source-free model parameters', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition())
  const catalog = value(await h.tool('blueprint_list'))
  assert.deepEqual(catalog.definitions, [{ blueprintId: doc.blueprintId, name: 'Runtime contracts', documentRevision: doc.documentRevision }])
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, input: {} }
  assert.deepEqual(callerSource(h.service.ctx, { agent: h.caller, callId: ToolCallId('native-call') }), {
    sessionId: h.caller.id,
    kind: 'tool',
    callId: 'native-call',
    turn: 7
  })
  const started = value(await h.tool('blueprint_start', args))
  const replay = value(await h.tool('blueprint_start', args))
  assert.equal(replay.runId, started.runId)
  assert.equal(replay.replayed, true)
  await drain(h)
  assert.equal(h.host.calls.length, 1)
  const saved = (await records(h))[0]
  assert.deepEqual(saved.source, { kind: 'tool', sessionId: h.caller.session.id, callId: 'native-call', turn: 7 })
  assert.equal(saved.blueprintId, doc.blueprintId)
  assert.equal(saved.attempts[0].sessionId, h.host.calls[0].options.sessionId)
  const inspected = value(await h.tool('blueprint_inspect'))
  assert.equal(inspected.status, 'bound')
  assert.equal(inspected.selected.run.runId, started.runId)
  assert.equal(inspectSessionCodec().safeParse(inspected).success, true)
  const spoof = await h.tool('blueprint_start', { ...args, source: { sessionId: 'forged' } }, h.caller, 'forged-call')
  assert.equal(spoof.isError, true)
  assert.equal(spoof.error.info.code, 'INVALID_ARGS')
  assert.equal((await records(h)).length, 1)
  const changed = await h.tool('blueprint_start', { ...args, input: { changed: true } })
  assert.equal(changed.isError, true)
  assert.equal(changed.error.info.code, 'COMMAND_CONFLICT')
  assert.equal((await records(h)).length, 1)
})

test('host: native missing/stale/forged caller and subagent recursion reject, Host guard still controls execution', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition()),
    args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, input: {} }
  const noCaller = await h.nativeTools.execute({
    name: 'blueprint_start',
    arguments: args,
    callId: ToolCallId('missing'),
    signal: new AbortController().signal
  })
  assert.equal(noCaller.isError, true)
  assert.equal(noCaller.error.info.code, 'session-unavailable')
  const forged = await h.tool('blueprint_start', args, { ...h.caller }, 'forged')
  assert.equal(forged.isError, true)
  assert.equal(forged.error.info.code, 'session-unavailable')
  const stale = await h.tool('blueprint_start', args, { ...h.caller, id: SessionId('stale'), session: Session.create(SessionId('stale')) }, 'stale')
  assert.equal(stale.isError, true)
  assert.equal(stale.error.info.code, 'session-unavailable')
  const child = await h.add('child-caller', 'subagent')
  const nested = await h.tool('blueprint_start', args, child, 'nested')
  assert.equal(nested.isError, true)
  assert.equal(nested.error.info.code, 'nested-run-unavailable')
  await assert.rejects(
    () =>
      h.service.startSessionRun({
        blueprintId: args.blueprintId,
        expectedRevision: args.expectedRevision,
        inputJson: JSON.stringify(args.input),
        requestId: 'nested-ui',
        sessionId: child.id
      }),
    code('blueprint/nested-run-unavailable')
  )
  const disposeGuard = h.nativeTools.guard(() => 'HOST_DENIAL_SECRET_SENTINEL')
  const denied = await h.tool('blueprint_start', args, h.caller, 'denied')
  assert.equal(denied.isError, true)
  disposeGuard()
  assert.deepEqual(await records(h), [])
})

test('host: UI admission validates live caller and source fingerprint prevents same request crossing UI/tool/session', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition()),
    args = runArgs(doc, {}, 'same-request')
  await assert.rejects(() => h.service.startSessionRun({ ...args, sessionId: 'absent' }), code('blueprint/session-unavailable'))
  await assert.rejects(() => h.service.startSessionRun({ ...args, sessionId: h.caller.id, source: { sessionId: 'spoof' } }), code('gateway/bad-request'))
  const a = await h.service.startSessionRun({ ...args, sessionId: h.caller.id })
  const b = await h.service.startSessionRun({ ...args, sessionId: h.caller.id })
  assert.equal(a.runId, b.runId)
  assert.equal(b.replayed, true)
  const other = await h.add('second-root')
  await assert.rejects(() => h.service.startSessionRun({ ...args, sessionId: other.id }), code('COMMAND_CONFLICT'))
  await assert.rejects(() => h.service.startRun(args), code('COMMAND_CONFLICT'))
  await drain(h)
  assert.equal(h.host.calls.length, 1)
  assert.deepEqual((await records(h))[0].source, { sessionId: h.caller.id, kind: 'ui' })
})

test('host: inspectSession enforces membership even with selected runId, frozen white list and child attempt focus', async t => {
  const h = await liveHarness(t)
  const def = definition([agentNode({ inputs: { task: 'string' }, outputs: { answer: 'string' } })])
  def.metadata = { secret: 'RAW_METADATA_SECRET' }
  def.presentation = {
    nodes: { work: { x: 7, y: 9, title: 'Frozen', collapsed: true, pinned: true, width: 280, height: 100, color: 'purple' } },
    groups: [{ id: 'group', label: 'Group', nodeIds: ['work'] }],
    edges: []
  }
  const doc = await h.save(def)
  const started = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.caller.id })
  await drain(h)
  const run = (await records(h))[0]
  const before = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(before.status, 'bound')
  assert.deepEqual(before.selected.graph.nodes, [{ id: 'work', kind: 'agentTask', inputs: { task: 'string' }, outputs: { answer: 'string' } }])
  assert.deepEqual(before.selected.presentation, def.presentation)
  const serialized = JSON.stringify(before)
  for (const secret of ['RAW_METADATA_SECRET', 'AGENT_PROMPT_SECRET_SENTINEL', h.root, 'agentRef', 'resourceDigests']) {
    // Diagnostics contain only hashes; resourceDigests is an existing public field.
    if (secret !== 'resourceDigests') assert.equal(serialized.includes(secret), false)
  }
  const child = await h.service.inspectSession({ sessionId: run.attempts[0].sessionId })
  assert.equal(child.status, 'bound')
  assert.deepEqual(child.selected.focusAttemptIds, [run.attempts[0].attemptId])
  assert.equal(child.selected.run.runId, started.runId)
  assert.deepEqual(await h.service.inspectSession({ sessionId: 'ordinary-unbound' }), { status: 'unbound', sessionId: 'ordinary-unbound' })
  await assert.rejects(() => h.service.inspectSession({ sessionId: 'ordinary-unbound', runId: started.runId }), code('blueprint/run-not-found'))
  await assert.rejects(() => h.service.inspectSession({ sessionId: h.caller.id, runId: 'foreign-run' }), code('blueprint/run-not-found'))
  await h.service.saveDefinition({
    blueprintId: doc.blueprintId,
    expectedRevision: doc.documentRevision,
    definitionJson: JSON.stringify({ ...def, presentation: { nodes: { work: { x: 999, y: 999 } } } })
  })
  assert.deepEqual((await h.service.inspectSession({ sessionId: h.caller.id })).selected.graph, before.selected.graph)
  assert.deepEqual((await h.service.inspectSession({ sessionId: h.caller.id })).selected.presentation, before.selected.presentation)
  assert.equal(codec('inspectSession').result.create().safeParse(before).success, true)
  assert.equal(codec('inspectRun').result.create().safeParse(before.selected.run).success, true)
  assert.equal(
    codec('startSessionRun')
      .parameters[0].codec.create()
      .safeParse({ ...runArgs(doc), sessionId: h.caller.id }).success,
    true
  )
  for (const inject of [
    v => {
      v.rawBody = 'RAW'
    },
    v => {
      v.selected.source.rawBody = 'RAW'
    },
    v => {
      v.selected.graph.nodes[0].agentRef = 'SECRET_PATH'
    },
    v => {
      v.selected.presentation.groups[0].rawBody = 'RAW'
    },
    v => {
      v.selected.run.attempts[0].rawBody = 'RAW'
    }
  ]) {
    const bad = structuredClone(before)
    inject(bad)
    assert.equal(inspectSessionCodec().safeParse(bad).success, false)
  }
  assert.equal(inspectSessionCodec().safeParse({ status: 'unbound', sessionId: 'unbound', runs: [] }).success, false)
  assert.equal(frozenPresentationCodec().safeParse({ ...def.presentation, raw: 'secret' }).success, false)
})

test('host: headless service initializes without Tools and tool registration disappears on plugin disposal', async t => {
  const headless = await harness(t, { tools: false, factory: false })
  assert.equal((await headless.service.ping()).status, 'ok')
  const h = await liveHarness(t)
  assert.ok(h.nativeTools.schemas().some(tool => tool.name === 'blueprint_start'))
  await h.close()
  assert.equal(
    h.nativeTools.schemas().some(tool => tool.name.startsWith('blueprint_')),
    false
  )
})

test('host: global/legacy start remains unbound; multiple source Runs use stable descending createdAt/runId selection', async t => {
  const h = await liveHarness(t)
  const def = definition([{ id: 'out', kind: 'output' }], {})
  const doc = await h.save(def)
  const global = await h.service.startRun(runArgs(doc, {}, 'global'))
  await drain(h)
  assert.equal(Object.hasOwn((await records(h))[0], 'source'), false)
  const starts = []
  for (const requestId of ['a', 'b', 'c']) starts.push(await h.service.startSessionRun({ ...runArgs(doc, {}, requestId), sessionId: h.caller.id }))
  await drain(h)
  const store = [...h.service.runtimes.values()][0].opened.domain.table('runs')
  // Equal creation times are legitimate; exercise the deterministic tie-break.
  for (const start of starts) {
    const run = await store.get(start.runId)
    await store.put(start.runId, { ...run, createdAt: 100 })
  }
  const selected = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.deepEqual(
    selected.runs.map(run => run.runId),
    starts
      .map(run => run.runId)
      .sort()
      .reverse()
  )
  assert.equal(selected.selected.run.runId, selected.runs[0].runId)
  const historical = await h.service.inspectSession({ sessionId: h.caller.id, runId: starts[0].runId })
  assert.equal(historical.selected.run.runId, starts[0].runId)
  await assert.rejects(() => h.service.inspectSession({ sessionId: h.caller.id, runId: global.runId }), code('blueprint/run-not-found'))
  assert.deepEqual(await h.service.inspectSession({ sessionId: 'legacy-ordinary' }), { status: 'unbound', sessionId: 'legacy-ordinary' })
})

test('host: inspectSession selected run and root focus share a single aggregate cut during intent race', async t => {
  const h = await liveHarness(t)
  const handle = await h.service.configuredRuntime()
  const def = definition([agentNode()])
  const { runId } = await handle.store.createRun(
    { scope: 'run', requestId: 'cut-race', payloadFingerprint: 'cut' },
    'cut-revision',
    JSON.stringify(def),
    '{}',
    { blueprintId: def.id, source: { sessionId: h.caller.id, kind: 'ui' } }
  )
  const get = handle.store.get.bind(handle.store)
  let injected = false
  t.mock.method(handle.store, 'get', async id => {
    const captured = await get(id)
    if (id === runId && !injected) {
      injected = true
      await handle.store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask', sessionId: 'concurrent-child' })
    }
    return captured
  })
  const cut = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(injected, true, 'actual durable intent lands between selected capture and projection')
  assert.equal(cut.selected.run.state, 'queued')
  assert.deepEqual(cut.selected.run.attempts, [])
  assert.deepEqual(cut.selected.focusAttemptIds, [])
  const fresh = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(fresh.selected.run.state, 'running')
  assert.deepEqual(
    fresh.selected.focusAttemptIds,
    fresh.selected.run.attempts.map(a => a.attemptId)
  )
  const child = await h.service.inspectSession({ sessionId: 'concurrent-child' })
  assert.deepEqual(child.selected.focusAttemptIds, fresh.selected.focusAttemptIds)
})

test('host: root focus includes every canonical active/waiting/recovery Attempt and terminal latest; child focus stays exact', async t => {
  const h = await liveHarness(t)
  const handle = await h.service.configuredRuntime()
  const def = definition(
    [
      { id: 'one', kind: 'input' },
      { id: 'two', kind: 'output' }
    ],
    {}
  )
  const { runId } = await handle.store.createRun({ scope: 'run', requestId: 'focus', payloadFingerprint: 'focus' }, 'revision', JSON.stringify(def), '{}', {
    source: { sessionId: h.caller.id, kind: 'ui' }
  })
  const first = await handle.store.recordIntent(runId, { nodeId: 'one', kind: 'agentTask', sessionId: 'one-child' })
  const second = await handle.store.recordIntent(runId, { nodeId: 'two', kind: 'agentTask', sessionId: 'two-child' })
  await handle.store.transition(runId, draft => {
    draft.attempts[0].state = 'waiting_input'
    draft.attempts[1].state = 'recovery_required'
  })
  assert.deepEqual((await h.service.inspectSession({ sessionId: h.caller.id })).selected.focusAttemptIds, [first.attemptId, second.attemptId])
  assert.deepEqual((await h.service.inspectSession({ sessionId: 'one-child' })).selected.focusAttemptIds, [first.attemptId])
  assert.deepEqual((await h.service.inspectSession({ sessionId: 'two-child' })).selected.focusAttemptIds, [second.attemptId])
  await handle.store.recordResult(runId, first.attemptId, { ok: true, outcome: { kind: 'succeeded' }, evidence: 'known' })
  await handle.store.recordResult(runId, second.attemptId, { ok: true, outcome: { kind: 'succeeded' }, evidence: 'known' })
  await handle.store.settleTerminal(runId, 'succeeded')
  assert.deepEqual((await h.service.inspectSession({ sessionId: h.caller.id })).selected.focusAttemptIds, [second.attemptId])
  assert.deepEqual((await h.service.inspectSession({ sessionId: 'one-child' })).selected.focusAttemptIds, [first.attemptId])
})

test('host: durable admission failure creates no Agent and intent write failure retains source without effect', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition())
  const handle = await h.service.configuredRuntime()
  const runs = handle.opened.domain.table('runs')
  const fail = t.mock.method(runs, 'put', async () => {
    throw new Error('RAW_DISK_SECRET /private/location')
  })
  await assert.rejects(
    () => h.service.startSessionRun({ ...runArgs(doc, {}, 'write-fail'), sessionId: h.caller.id }),
    error => {
      assert.equal(JSON.stringify(error).includes('RAW_DISK_SECRET'), false)
      return error.code === 'blueprint/durability-failed'
    }
  )
  assert.equal(h.host.calls.length, 0)
  assert.deepEqual(await handle.store.listRunIds(), [])
  fail.mock.restore()
  const recordIntent = handle.store.recordIntent.bind(handle.store)
  const failIntent = t.mock.method(handle.store, 'recordIntent', async (...args) => {
    const update = t.mock.method(runs, 'update', async () => {
      throw new Error('intent disk full')
    })
    try {
      return await recordIntent(...args)
    } finally {
      update.mock.restore()
    }
  })
  const started = await h.service.startSessionRun({ ...runArgs(doc, {}, 'intent-fail'), sessionId: h.caller.id })
  // Original driver propagates the typed durability failure to supervision.
  // Observe its real job without treating the fixture's expected driver rejection as an unrelated failure.
  await handle.jobs.get(started.runId)
  failIntent.mock.restore()
  assert.equal(h.host.calls.length, 0)
  const saved = await handle.store.get(started.runId)
  assert.deepEqual(saved.source, { sessionId: h.caller.id, kind: 'ui' })
  assert.equal(saved.state, 'failed')
  assert.deepEqual(saved.attempts, [])
  const projected = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(projected.selected.run.state, 'failed')
  assert.equal(JSON.stringify(projected).includes('intent disk full'), false)
})

test('host: cancel between durable intent and Agent creation preserves exact session and dispatches no followup', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition())
  const handle = await h.service.configuredRuntime()
  const recordIntent = handle.store.recordIntent.bind(handle.store)
  let committed
  t.mock.method(handle.store, 'recordIntent', async (...args) => {
    const intent = await recordIntent(...args)
    committed = await handle.store.get(args[0])
    await h.service.cancelRun({ runId: args[0] })
    return intent
  })
  const started = await h.service.startSessionRun({ ...runArgs(doc, {}, 'cancel-before-create'), sessionId: h.caller.id })
  await drain(h)
  assert.equal(h.host.calls.length, 0)
  assert.ok(committed.attempts[0].sessionId)
  assert.equal(committed.attempts[0].result, undefined)
  const saved = await handle.store.get(started.runId)
  assert.equal(saved.state, 'cancelled')
  assert.equal(saved.attempts[0].sessionId, committed.attempts[0].sessionId)
  assert.equal(saved.attempts[0].result.evidence, 'cancel-before-dispatch')
  assert.deepEqual(saved.source, { sessionId: h.caller.id, kind: 'ui' })
})

test('host: running cancel/reopen keeps caller and execution association, explicit settlement and no automatic redispatch', async t => {
  const began = Promise.withResolvers()
  const h = await liveHarness(t, {
    onTurn: call => {
      began.resolve(call)
    }
  })
  const doc = await h.save(definition())
  const started = await h.service.startSessionRun({ ...runArgs(doc, {}, 'cancel-during-turn'), sessionId: h.caller.id })
  const call = await began.promise
  const whileRunning = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(whileRunning.selected.run.state, 'running')
  assert.deepEqual(whileRunning.selected.focusAttemptIds, [whileRunning.selected.run.attempts[0].attemptId])
  assert.equal(whileRunning.selected.run.attempts[0].sessionId, call.options.sessionId)
  await h.service.cancelRun({ runId: started.runId })
  await drain(h)
  const settled = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(settled.selected.run.state, 'cancelled')
  assert.equal(settled.selected.run.attempts[0].state, 'cancelled')
  assert.equal(h.host.calls.length, 1)
  await h.close()
  const reopened = new Context()
  const fiber = await reopened.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  t.after(async () => {
    await fiber.dispose()
    await reopened.fiber.dispose()
  })
  assert.deepEqual(await reopened.blueprint.inspectSession({ sessionId: h.caller.id }), settled)
  const child = await reopened.blueprint.inspectSession({ sessionId: call.options.sessionId })
  assert.equal(child.selected.run.runId, started.runId)
  assert.deepEqual(child.selected.focusAttemptIds, settled.selected.focusAttemptIds)
  const cancelledAgain = await reopened.blueprint.cancelRun({ runId: started.runId })
  assert.equal(cancelledAgain.state, 'cancelled')
  assert.equal((await reopened.blueprint.inspectRun({ runId: started.runId })).seq, settled.selected.run.seq)
  await fiber.dispose()
  await reopened.fiber.dispose()
})

test('host: unknown native effect retains original intent ID and source across process-equivalent reopen', async t => {
  const h = await liveHarness(t, { onTurn: call => call.quiesceWithoutEnd() })
  const doc = await h.save(definition())
  const started = await h.service.startSessionRun({ ...runArgs(doc, {}, 'unknown-effect'), sessionId: h.caller.id })
  await drain(h)
  const before = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.equal(before.selected.run.state, 'recovery_required')
  assert.equal(before.selected.run.attempts[0].state, 'recovery_required')
  assert.equal(before.selected.run.attempts[0].sessionId, h.host.calls[0].options.sessionId)
  assert.deepEqual(before.selected.focusAttemptIds, [before.selected.run.attempts[0].attemptId])
  assert.equal((await records(h))[0].attempts[0].result, undefined)
  await h.close()
  const ctx = new Context()
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  t.after(async () => {
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
  assert.deepEqual(await ctx.blueprint.inspectSession({ sessionId: h.caller.id }), before)
  assert.equal((await ctx.blueprint.inspectSession({ sessionId: h.host.calls[0].options.sessionId })).selected.run.runId, started.runId)
  await fiber.dispose()
  await ctx.fiber.dispose()
})

test('host: existing group and routed-edge presentation fields round-trip through frozen inspect view', async t => {
  const h = await liveHarness(t)
  const def = definition(
    [
      { id: 'input', kind: 'input', outputs: { value: 'string' } },
      { id: 'output', kind: 'output', inputs: { value: 'string' } }
    ],
    {},
    [{ kind: 'data', from: 'input.value', to: 'output.value' }]
  )
  def.presentation = {
    nodes: { input: { x: -12.5, y: 0.25, title: 'Existing input', color: 'default' }, output: { x: 425, y: 77, width: 240, height: 84 } },
    groups: [{ id: 'layout-group', label: 'Existing layout', nodeIds: ['input', 'output'] }],
    edges: [
      {
        kind: 'data',
        from: 'input.value',
        to: 'output.value',
        points: [
          { x: 1.25, y: 10 },
          { x: 40, y: -5 }
        ]
      }
    ]
  }
  const doc = await h.save(def)
  await h.service.startSessionRun({ ...runArgs(doc, { value: 'typed user output' }, 'existing-layout'), sessionId: h.caller.id })
  await drain(h)
  const view = await h.service.inspectSession({ sessionId: h.caller.id })
  assert.deepEqual(view.selected.presentation, def.presentation)
  assert.deepEqual(view.selected.graph, def.graph)
  assert.equal(inspectSessionCodec().safeParse(view).success, true)
})

test('host: model-facing failures expose only static codes, no raw dependency error or forged source/path', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition()),
    args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, input: {} }
  t.mock.method(h.service, 'listDefinitions', async () => {
    throw new Error('RAW_PROVIDER_SECRET /private/user/location')
  })
  const failed = await h.tool('blueprint_list')
  assert.equal(failed.isError, true)
  assert.equal(failed.error.info.code, 'blueprint/tool-failed')
  assert.equal(failed.error.message, 'blueprint/tool-failed')
  for (const raw of ['RAW_PROVIDER_SECRET', '/private/user/location']) assert.equal(JSON.stringify(failed).includes(raw), false)
  for (const name of ['source', 'sessionId', 'callId', 'turn', 'rootDir', 'runtimeRoot']) {
    const result = await h.tool('blueprint_start', { ...args, [name]: 'FORGED_RAW_SECRET /private/user/location' }, h.caller, `bad-${name}`)
    assert.equal(result.isError, true)
    assert.equal(result.error.info.code, 'INVALID_ARGS')
    assert.equal(result.error.message, 'INVALID_ARGS')
    assert.equal(JSON.stringify(result).includes('FORGED_RAW_SECRET'), false)
  }
  assert.deepEqual(await records(h), [])
})

test('host: UI/tool command-key collision cannot rebind source kind; same native call in a later turn conflicts', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition())
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, input: {} }
  const callId = 'collision-call'
  const toolRequestId = `blueprint-tool-${createHash('sha256')
    .update(JSON.stringify([h.caller.id, callId]))
    .digest('hex')}`
  await h.service.startSessionRun({
    blueprintId: args.blueprintId,
    expectedRevision: args.expectedRevision,
    inputJson: JSON.stringify(args.input),
    sessionId: h.caller.id,
    requestId: toolRequestId
  })
  const conflict = await h.tool('blueprint_start', args, h.caller, callId)
  assert.equal(conflict.isError, true)
  assert.equal(conflict.error.info.code, 'COMMAND_CONFLICT')
  const started = value(await h.tool('blueprint_start', args, h.caller, 'turn-call'))
  h.caller.session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
  h.caller.session.append('turn/start', { turn: 8 })
  const later = await h.tool('blueprint_start', args, h.caller, 'turn-call')
  assert.equal(later.isError, true)
  assert.equal(later.error.info.code, 'COMMAND_CONFLICT')
  await drain(h)
  assert.equal(h.host.calls.length, 2)
  const saved = (await records(h)).find(run => run.runId === started.runId)
  assert.equal(saved.source.turn, 7)
  assert.equal(saved.source.callId, 'turn-call')
})

test('host: native creation rejection retains durable source/intent identity and static result without inventing a Session', async t => {
  const h = await liveHarness(t)
  const doc = await h.save(definition())
  let reservedId
  t.mock.method(h.ctx.agents, 'create', async options => {
    reservedId = options.sessionId
    const saved = (await records(h))[0]
    assert.equal(saved.attempts[0].sessionId, reservedId)
    throw new Error('RAW_CREATION_SECRET /private/native/create')
  })
  const started = await h.service.startSessionRun({ ...runArgs(doc, {}, 'creation-rejected'), sessionId: h.caller.id })
  await drain(h)
  const saved = (await records(h))[0]
  assert.equal(saved.state, 'failed')
  assert.equal(saved.attempts[0].sessionId, reservedId)
  assert.deepEqual(saved.source, { sessionId: h.caller.id, kind: 'ui' })
  assert.equal(h.host.calls.length, 0)
  assert.equal(h.ctx.agents.get(SessionId(reservedId)), undefined)
  const view = await h.service.inspectSession({ sessionId: reservedId })
  assert.equal(view.selected.run.runId, started.runId)
  for (const raw of ['RAW_CREATION_SECRET', '/private/native/create']) assert.equal(JSON.stringify(view).includes(raw), false)
})
