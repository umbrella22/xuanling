import { managedRun } from './managed-fixtures.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'
import { publicHost, textResponse, toolResponse } from './public-host-fixture.mjs'

test('managed execution does not settle from an ordinary reply and is still cancellable while waiting for clarification', async t => {
  const { ctx, selection } = await publicHost(t, [textResponse('Which cancellation path should I review?')])
  const idle = Promise.withResolvers()
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.id === 'managed-settlement' && status === 'idle') idle.resolve()
  })
  const stop = new AbortController()
  let result
  const running = new BlueprintAgentExecutor(ctx, ctx.agents)
    .execute({
      runId: 'run',
      attemptId: 'attempt',
      nodeId: 'review',
      sessionId: 'managed-settlement',
      interaction: 'managed',
      agentMd: 'Review only.',
      skills: [],
      input: 'review',
      cwd: process.cwd(),
      modelSelection: selection,
      signal: stop.signal
    })
    .then(value => {
      result = value
      return value
    })
  try {
    await idle.promise
    await nextTurn()
    assert.equal(result, undefined, 'ordinary turn/end must not commit managed node success')
    assert.ok(ctx.agents.get('managed-settlement'), 'the same Agent remains live for clarification')
  } finally {
    stop.abort()
    await running
  }
  assert.equal(result.outcome.kind, 'cancelled')
})

test('production driver retains one native Session across clarification and commits one explicit final result', async t => {
  const h = await managedRun(t, [
    textResponse('Which cancellation path matters?'),
    toolResponse('structured_output', { text: 'The cancellation review is complete.' })
  ])
  await nextTurn()
  assert.equal((await h.runtime.store.get(h.args.runId)).attempts[0].result, undefined)
  assert.equal((await h.service.inspectNodeSession({ sessionId: h.args.sessionId })).canMessage, true)
  const receipt = await h.service.messageNode(h.args)
  await h.job
  const record = await h.runtime.store.get(h.args.runId)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.attempts[0].result.outcome.outputs.text, 'The cancellation review is complete.')
  assert.equal(record.attempts[0].sessionId, h.agent.session.id)
  assert.equal(record.log.filter(event => event.kind === 'result').length, 1)
  assert.equal(record.attempts[0].messages[0].messageId, receipt.messageId)
  assert.equal(record.attempts[0].messages[0].state, 'accepted')
  assert.equal(record.definitionJson, h.record.definitionJson)
  assert.equal(h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 2)
  assert.equal(h.ctx.agents.get(h.args.sessionId), undefined)
  await assert.rejects(h.service.messageNode({ ...h.args, requestId: 'late' }), { code: 'blueprint/node-not-active' })
})

test('invalid explicit output and a normal reply leave managed work open until a valid completion arrives', async t => {
  const h = await managedRun(t, [
    toolResponse('structured_output', { text: 5 }),
    textResponse('I need clarification.'),
    toolResponse('structured_output', { text: 'Corrected review.' }, 'final')
  ])
  await nextTurn()
  assert.equal((await h.runtime.store.get(h.args.runId)).attempts[0].result, undefined)
  await h.service.messageNode(h.args)
  await h.job
  const record = await h.runtime.store.get(h.args.runId)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.attempts[0].result.outcome.outputs.text, 'Corrected review.')
})

test('managed waiting obeys the executor deadline instead of turning the last reply into success', async t => {
  const { ctx, selection } = await publicHost(t, [textResponse('Please clarify.')])
  const idle = Promise.withResolvers()
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') idle.resolve()
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const running = new BlueprintAgentExecutor(ctx, ctx.agents).execute({
    runId: 'deadline',
    attemptId: 'attempt',
    nodeId: 'review',
    interaction: 'managed',
    agentMd: '',
    skills: [],
    input: 'review',
    cwd: process.cwd(),
    modelSelection: selection,
    timeoutMs: 100
  })
  await idle.promise
  t.mock.timers.tick(100)
  assert.equal((await running).outcome.kind, 'timeout')
})

test('managed node cannot call workflow mutations even when they appear in the supplied business tool set', async t => {
  const { ctx, selection } = await publicHost(t, [toolResponse('workflow_apply', {}), toolResponse('structured_output', { text: 'finished' }, 'final')])
  let mutations = 0
  ctx.tools.register({
    name: 'workflow_apply',
    description: 'mutation canary',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => [{ type: 'text', text: '{}' }] },
    execute: async () => {
      mutations++
      return {}
    }
  })
  const evidence = await new BlueprintAgentExecutor(ctx, ctx.agents).execute({
    runId: 'immutable',
    attemptId: 'attempt',
    nodeId: 'review',
    interaction: 'managed',
    agentMd: '',
    skills: [],
    input: 'review',
    cwd: process.cwd(),
    modelSelection: selection,
    effectiveToolNames: ['workflow_apply']
  })
  assert.equal(evidence.outcome.kind, 'succeeded')
  assert.equal(mutations, 0)
  assert.ok(evidence.toolDenials.some(denial => denial.toolName === 'workflow_apply' && denial.code === 'tool-not-permitted'))
})
