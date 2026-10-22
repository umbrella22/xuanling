import { activeNode } from './managed-fixtures.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { agentNode, definition } from '../runtime-contracts/agent-fixtures.mjs'

test('explicit managed interaction survives strict definition decoding and validation; legacy remains opt-in', () => {
  const legacy = definition()
  const managed = structuredClone(legacy)
  managed.graph.nodes = [agentNode({ interaction: 'managed' })]
  let decoded, failure
  try {
    decoded = decodeDefinition(JSON.stringify(managed))
    validateDefinition(decoded)
  } catch (error) {
    failure = error
  }
  assert.equal(failure, undefined, 'agentTask.interaction=managed must be a supported execution contract')
  assert.equal(decoded.graph.nodes[0].interaction, 'managed')
  assert.equal(decodeDefinition(JSON.stringify(legacy)).graph.nodes[0].interaction, undefined)
})

test('same Run/Attempt/Session accepts one inbox message for concurrent identical retries, without copying its text into RunRecord', async t => {
  const h = await activeNode(t)
  const before = await h.runtime.store.get(h.args.runId)
  const [a, b] = await Promise.all([h.service.messageNode(h.args), h.service.messageNode(h.args)])
  await h.handle.agent.whenIdle()
  assert.equal(a.messageId, b.messageId)
  assert.deepEqual([a.replayed, b.replayed], [false, true])
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.rpcId === h.args.requestId).length, 1)
  const after = await h.runtime.store.get(h.args.runId)
  assert.equal(after.attempts[0].messages[0].state, 'accepted')
  assert.equal(JSON.stringify(after).includes('MESSAGE_BODY_CANARY'), false)
  assert.equal(after.definitionJson, before.definitionJson)
  await assert.rejects(h.service.messageNode({ ...h.args, text: 'changed under same ID' }), { code: 'blueprint/command-conflict' })
  await assert.rejects(h.service.messageNode({ ...h.args, attemptId: 'wrong' }), { code: 'blueprint/node-not-active' })
  await assert.rejects(h.service.messageNode({ ...h.args, sessionId: h.caller.session.id }), { code: 'blueprint/node-not-active' })
  await assert.rejects(h.service.messageNode({ ...h.args, definition: {} }), { code: 'gateway/bad-request' })
  assert.equal((await h.service.inspectNodeSession({ sessionId: h.args.sessionId })).canMessage, true)
})

test('closing and durable cancellation reject messages including retries; terminal Session remains inspectable', async t => {
  const h = await activeNode(t, [])
  h.runtime.managed.closeRun(h.args.runId)
  assert.equal((await h.service.inspectNodeSession({ sessionId: h.args.sessionId })).canMessage, false)
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-not-active' })
  await h.runtime.store.requestCancel(h.args.runId)
  await h.runtime.store.recordResult(h.args.runId, h.args.attemptId, { ok: false, outcome: { kind: 'cancelled' }, evidence: 'fixture-cancelled' })
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-not-active' })
  assert.equal(h.adapter.requests.length, 0)
  assert.equal((await h.service.inspectNodeSession({ sessionId: h.args.sessionId })).state, 'closed')
})

test('a native plugin caller with only the Blueprint dependency can deliver to the same managed Agent', async t => {
  const h = await activeNode(t, undefined, { scopedClient: true })
  // The root Context bypasses Cordis dependency checks. A real gateway/plugin
  // caller injects Blueprint only, so it must not inherit Agent/Session access.
  const receipt = await h.runtime.managed.message(h.args)
  await h.handle.agent.whenIdle()
  assert.equal(receipt.requestId, h.args.requestId)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal((await h.runtime.store.get(h.args.runId)).attempts[0].messages[0].state, 'accepted')
  const replay = await h.service.messageNode(h.args)
  assert.equal(replay.messageId, receipt.messageId)
  assert.equal(replay.replayed, true)
})

test('pending message receipt is never replayed and a missing live Agent cannot be reconstructed by messageNode', async t => {
  const h = await activeNode(t, [])
  h.binding.dispose()
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-session-unavailable' })
  assert.equal(h.adapter.requests.length, 0)
})
