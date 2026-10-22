import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { workflowHost, textResponse } from './public-host-fixture.mjs'
import { echoDefinition, parentDefinition, save } from './child-fixtures.mjs'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'

for (const phase of ['reserved', 'created', 'captured', 'waiting']) {
  test(`restart reconciles the ${phase} child boundary without dispatching or treating it as a root`, async t => {
    const h = await workflowHost(t)
    const runtime = await h.service.configuredRuntime()
    const childRunId = `run-${randomUUID()}`
    const parent = await runtime.store.createRun(
      { scope: 'run', requestId: 'parent', payloadFingerprint: 'parent' },
      'frozen',
      JSON.stringify(echoDefinition('parent')),
      '{}'
    )
    const intent = await runtime.store.recordIntent(parent.runId, { nodeId: 'call', kind: 'blueprintCall' })
    await runtime.store.transition(parent.runId, draft => {
      draft.attempts[0].childRunId = childRunId
    })
    if (phase !== 'reserved') {
      await runtime.store.createRun({ scope: 'child', requestId: childRunId, payloadFingerprint: 'child' }, 'frozen', JSON.stringify(echoDefinition()), '{}', {
        reservedRunId: childRunId,
        parent: { runId: parent.runId, attemptId: intent.attemptId },
        bindingDigests: {}
      })
      if (phase !== 'created') await runtime.store.setBindingDigests(childRunId, {})
      if (phase === 'waiting') {
        await runtime.store.recordIntent(childRunId, { nodeId: 'ask', kind: 'humanDecision' })
        await runtime.store.transition(childRunId, draft => {
          draft.state = 'waiting_input'
          draft.attempts[0].state = 'waiting_input'
        })
      }
    }
    const opened = await openBlueprintDomain({ path: runtime.root })
    try {
      const store = new RunStore(opened.domain)
      await reconcileOnStart(store)
      assert.equal((await store.get(parent.runId)).state, 'recovery_required')
      if (phase !== 'reserved') assert.equal((await store.get(childRunId)).state, 'recovery_required')
      assert.equal(h.adapter.requests.length, 0)
      if (phase !== 'reserved') {
        const record = await store.get(parent.runId)
        await assert.rejects(
          h.service.resolveRecovery({ runId: parent.runId, expectedSeq: record.seq, resolution: 'succeeded', note: 'must not detach unresolved child' }),
          { code: 'blueprint/run-lifecycle-conflict' }
        )
      }
    } finally {
      await opened.close()
    }
  })
}

test('a child human decision suspends its parent and resumes on the independent child scheduler', async t => {
  const h = await workflowHost(t)
  const definition = echoDefinition()
  definition.graph.nodes.splice(1, 0, { id: 'ask', kind: 'humanDecision', branches: ['approve', 'reject'] })
  definition.graph.edges.push({ kind: 'control', from: 'in', to: 'ask' }, { kind: 'control', from: 'ask@approve', to: 'out' })
  const child = await save(h.service, definition)
  const parent = await save(h.service, parentDefinition(child))
  const runtime = await h.service.configuredRuntime()
  const waiting = Promise.withResolvers()
  const transition = runtime.store.transition.bind(runtime.store)
  t.mock.method(runtime.store, 'transition', async (...args) => {
    const record = await transition(...args)
    if (record.parent && record.state === 'waiting_input') waiting.resolve(record)
    return record
  })
  const start = await h.service.startRun({
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"echo"}',
    requestId: 'decision'
  })
  const childRun = await waiting.promise
  assert.equal((await runtime.store.get(start.runId)).state, 'running')
  await h.service.decide({ runId: childRun.runId, decisionId: 'answer', action: 'approve' })
  await runtime.jobs.get(start.runId)
  assert.equal((await runtime.store.get(start.runId)).state, 'succeeded')
})

test('cancel between child creation and dispatch settles the tree without a model request', async t => {
  const h = await workflowHost(t)
  const child = await save(h.service, echoDefinition())
  const parent = await save(h.service, parentDefinition(child))
  const runtime = await h.service.configuredRuntime()
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const create = runtime.store.createRun.bind(runtime.store)
  t.mock.method(runtime.store, 'createRun', async (...args) => {
    const result = await create(...args)
    if (args[4]?.parent) {
      entered.resolve(result)
      await release.promise
    }
    return result
  })
  const start = await h.service.startRun({
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"echo"}',
    requestId: 'cancel-before-dispatch'
  })
  const nested = await entered.promise
  await h.service.cancelRun({ runId: start.runId })
  release.resolve()
  await runtime.jobs.get(start.runId)
  assert.equal((await runtime.store.get(start.runId)).state, 'cancelled')
  assert.equal((await runtime.store.get(nested.runId)).state, 'cancelled')
  assert.equal((await runtime.store.get(nested.runId)).attempts.length, 0)
  assert.equal(h.adapter.requests.length, 0)
})

test('cancelling a parent closes a running managed descendant Session and drains its Agent', async t => {
  const h = await workflowHost(t, { script: [textResponse('Please clarify.')] })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => h.selection })
  const definition = echoDefinition()
  definition.resources = { reviewer: { kind: 'agent', path: 'lib/reviewer.md' } }
  definition.graph.nodes.splice(1, 0, {
    id: 'work',
    kind: 'agentTask',
    agentRef: 'reviewer',
    interaction: 'managed',
    inputs: { value: 'string' },
    outputs: { value: 'string' }
  })
  definition.graph.edges = [
    { kind: 'data', from: 'in.value', to: 'work.value' },
    { kind: 'data', from: 'work.value', to: 'out.value' }
  ]
  const child = await h.service.createBlueprint({ definition, files: [{ path: 'lib/reviewer.md', text: 'Review only.' }] }, 'managed-child', {
    sessionId: h.caller.session.id,
    kind: 'ui'
  })
  const parent = await save(h.service, parentDefinition(child))
  const idle = Promise.withResolvers()
  h.ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.id !== h.caller.session.id && status === 'idle') idle.resolve(agent)
  })
  const start = await h.service.startSessionRun({
    sessionId: h.caller.session.id,
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"echo"}',
    requestId: 'managed-child-start'
  })
  const agent = await idle.promise
  const runtime = await h.service.configuredRuntime()
  const view = await h.service.inspectNodeSession({ sessionId: agent.session.id })
  assert.equal(view.canMessage, true)
  await h.service.cancelRun({ runId: start.runId })
  await assert.rejects(
    h.service.messageNode({
      runId: view.runId,
      attemptId: view.attemptId,
      sessionId: agent.session.id,
      requestId: 'late',
      delivery: 'queue',
      text: 'cannot detach'
    }),
    { code: 'blueprint/node-not-active' }
  )
  await runtime.jobs.get(start.runId)
  assert.equal((await runtime.store.get(start.runId)).state, 'cancelled')
  assert.equal((await runtime.store.get(view.runId)).state, 'cancelled')
  assert.equal(h.ctx.agents.get(agent.session.id), undefined)
  assert.equal(h.adapter.requests.length, 1)
})

for (const outcome of ['failed', 'timeout', 'recovery_required']) {
  test(`a child ${outcome} propagates to its parent without successful output`, async t => {
    const h = await workflowHost(t)
    h.ctx.provide('agentDefaultModel', { currentSelection: () => h.selection })
    const definition = echoDefinition()
    definition.resources = { reviewer: { kind: 'agent', path: 'lib/reviewer.md' } }
    definition.graph.nodes.splice(1, 0, { id: 'work', kind: 'agentTask', agentRef: 'reviewer', inputs: { value: 'string' }, outputs: { value: 'string' } })
    definition.graph.edges = [
      { kind: 'data', from: 'in.value', to: 'work.value' },
      { kind: 'data', from: 'work.value', to: 'out.value' }
    ]
    const child = await h.service.createBlueprint({ definition, files: [{ path: 'lib/reviewer.md', text: 'Review.' }] }, `child-${outcome}`, {
      sessionId: h.caller.session.id,
      kind: 'ui'
    })
    const parent = await save(h.service, parentDefinition(child))
    t.mock.method(BlueprintAgentExecutor.prototype, 'execute', async spec => ({
      sessionId: spec.sessionId,
      agentCreated: false,
      scopedInjections: [],
      inboxSplicedSeen: false,
      toolDenials: [],
      outcome: { ok: false, kind: outcome, detail: outcome },
      acceptance: { code: outcome }
    }))
    const start = await h.service.startSessionRun({
      sessionId: h.caller.session.id,
      blueprintId: parent.blueprintId,
      expectedRevision: parent.documentRevision,
      inputJson: '{"value":"echo"}',
      requestId: 'child-failure'
    })
    const runtime = await h.service.configuredRuntime()
    await runtime.jobs.get(start.runId)
    const record = await runtime.store.get(start.runId)
    assert.equal(record.state, outcome === 'timeout' ? 'timed_out' : outcome)
    const call = record.attempts.find(item => item.nodeId === 'call')
    assert.notEqual(call.result?.ok, true)
    assert.equal(
      record.attempts.some(item => item.nodeId === 'out'),
      false
    )
    assert.equal((await runtime.store.get(call.childRunId)).state, record.state)
  })
}

test('a failed child relation write leaves an undispatched reservation for recovery', async t => {
  const h = await workflowHost(t)
  const child = await save(h.service, echoDefinition())
  const parent = await save(h.service, parentDefinition(child))
  const runtime = await h.service.configuredRuntime()
  const create = runtime.store.createRun.bind(runtime.store)
  t.mock.method(runtime.store, 'createRun', async (...args) => {
    if (args[4]?.parent) throw new Error('CHILD_STORAGE_CANARY')
    return create(...args)
  })
  const start = await h.service.startRun({
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"echo"}',
    requestId: 'relation-failure'
  })
  await runtime.jobs.get(start.runId)
  const record = await runtime.store.get(start.runId)
  assert.equal(record.state, 'recovery_required')
  assert.ok(record.attempts.find(item => item.nodeId === 'call').childRunId)
  assert.equal((await runtime.store.listRunIds()).length, 1)
  assert.equal(h.adapter.requests.length, 0)
  assert.doesNotMatch(JSON.stringify(record), /CHILD_STORAGE_CANARY/)
})
