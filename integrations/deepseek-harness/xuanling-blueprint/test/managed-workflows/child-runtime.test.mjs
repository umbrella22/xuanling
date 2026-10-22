import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowHost, textResponse } from './public-host-fixture.mjs'
import { saveDefinitionDocument } from '../../src/definition/persist.ts'
import { echoDefinition, parentDefinition, save, check } from './child-fixtures.mjs'

async function run(h, document, requestId = 'parent-start') {
  const args = { blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson: '{"value":"echo"}', requestId }
  assert.equal((await check(h.service, document)).canStart, true)
  const started = await h.service.startRun(args)
  const runtime = await h.service.configuredRuntime()
  await runtime.jobs.get(started.runId)
  return { runtime, started, record: await runtime.store.get(started.runId), args }
}

test('a pinned child executes on an independent scheduler and returns its declared output once', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const child = await save(h.service, echoDefinition())
  const parent = await save(h.service, parentDefinition(child))
  const result = await run(h, parent)
  assert.equal(result.record.state, 'succeeded')
  const call = result.record.attempts.find(item => item.nodeId === 'call')
  const nested = await result.runtime.store.get(call.childRunId)
  assert.equal(nested.state, 'succeeded')
  assert.deepEqual(nested.parent, { runId: result.record.runId, attemptId: call.attemptId })
  assert.equal(nested.documentRevision, child.documentRevision)
  assert.equal(call.result.outcome.outputs.value, 'echo')
  assert.equal(result.record.attempts.find(item => item.nodeId === 'out').result.outcome.value.value, 'echo')
  const replay = await h.service.startRun(result.args)
  assert.equal(replay.runId, result.started.runId)
  assert.equal(replay.replayed, true)
  assert.equal((await result.runtime.store.listRunIds()).length, 2)
})

test('two parallel references to one child allocate distinct Runs and deep calls stay in the same tree', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const leaf = await save(h.service, echoDefinition('leaf'))
  const child = await save(h.service, parentDefinition(leaf, 'child'))
  const definition = parentDefinition(child)
  const left = definition.graph.nodes[1]
  left.id = 'left'
  definition.graph.nodes.splice(2, 0, { ...structuredClone(left), id: 'right' })
  definition.graph.nodes.at(-1).inputs = { left: 'string', right: 'string' }
  definition.graph.edges = [
    { kind: 'data', from: 'in.value', to: 'left.value' },
    { kind: 'data', from: 'in.value', to: 'right.value' },
    { kind: 'data', from: 'left.value', to: 'out.left' },
    { kind: 'data', from: 'right.value', to: 'out.right' }
  ]
  const parent = await save(h.service, definition)
  const result = await run(h, parent)
  assert.equal(result.record.state, 'succeeded')
  const calls = result.record.attempts.filter(item => item.childRunId)
  assert.equal(new Set(calls.map(item => item.childRunId)).size, 2)
  const ids = await result.runtime.store.listRunIds()
  assert.equal(ids.length, 5)
  for (const id of ids) assert.equal((await result.runtime.store.get(id)).state, 'succeeded')
  assert.deepEqual(result.record.attempts.find(item => item.nodeId === 'out').result.outcome.value, { left: 'echo', right: 'echo' })
})

test('a child executes historical package bytes and exposes immutable parent-child navigation', async t => {
  const h = await workflowHost(t, { script: [textResponse('completed')] })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => h.selection })
  const definition = echoDefinition()
  definition.resources = { reviewer: { kind: 'agent', path: 'lib/reviewer.md' } }
  definition.graph.nodes.splice(1, 0, { id: 'work', kind: 'agentTask', agentRef: 'reviewer', inputs: { value: 'string' }, outputs: { value: 'string' } })
  definition.graph.edges = [
    { kind: 'data', from: 'in.value', to: 'work.value' },
    { kind: 'data', from: 'work.value', to: 'out.value' }
  ]
  const child = await h.service.createBlueprint({ definition, files: [{ path: 'lib/reviewer.md', text: 'PINNED_OLD_REVIEWER' }] }, 'historical-child', {
    sessionId: h.caller.session.id,
    kind: 'ui'
  })
  const parent = await save(h.service, parentDefinition(child))
  const changed = JSON.parse(child.definitionJson)
  changed.name = 'Latest child'
  saveDefinitionDocument(
    h.service.blueprintRoot(child.blueprintId),
    changed,
    child.documentRevision,
    {},
    new Map([['lib/reviewer.md', Buffer.from('LATEST_REVIEWER_MUST_NOT_RUN')]])
  )
  const start = await h.service.startSessionRun({
    sessionId: h.caller.session.id,
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"echo"}',
    requestId: 'historical-start'
  })
  const runtime = await h.service.configuredRuntime()
  await runtime.jobs.get(start.runId)
  const record = await runtime.store.get(start.runId)
  assert.equal(record.state, 'succeeded')
  assert.match(JSON.stringify(h.adapter.requests), /PINNED_OLD_REVIEWER/)
  assert.doesNotMatch(JSON.stringify(h.adapter.requests), /LATEST_REVIEWER_MUST_NOT_RUN/)
  const view = await h.service.inspectSession({ sessionId: h.caller.session.id, runId: start.runId })
  const call = view.selected.run.attempts.find(item => item.nodeId === 'call')
  assert.ok(call.childRunId)
  assert.deepEqual(view.selected.graph.nodes.find(item => item.id === 'call').blueprintRef, {
    blueprintId: child.blueprintId,
    documentRevision: child.documentRevision
  })
  const nested = await h.service.inspectSession({ sessionId: h.caller.session.id, runId: call.childRunId })
  assert.deepEqual(nested.selected.run.parent, { runId: start.runId, attemptId: call.attemptId })
  assert.equal(nested.selected.run.documentRevision, child.documentRevision)
})
