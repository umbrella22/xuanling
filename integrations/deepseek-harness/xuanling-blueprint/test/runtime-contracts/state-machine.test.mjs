import assert from 'node:assert/strict'
import test from 'node:test'
import { harness } from './agent-fixtures.mjs'

test('W3.1 RunStore rejects an illegal queued to waiting_input transition before writing', async t => {
  const h = await harness(t, { factory: false })
  const handle = await h.service.configuredRuntime()
  const created = await handle.store.createRun(
    { scope: 'run', requestId: 'w3-state-illegal', payloadFingerprint: 'w3-state-illegal' },
    'w3-state-revision',
    JSON.stringify({ schemaVersion: 2, id: 'w3-state', name: 'state', resources: {}, graph: { nodes: [], edges: [] } }),
    '{}'
  )
  const before = await handle.store.get(created.runId)
  await assert.rejects(
    () =>
      handle.store.transition(created.runId, draft => {
        draft.state = 'waiting_input'
      }),
    error => error.code === 'ILLEGAL_TRANSITION'
  )
  assert.deepEqual(await handle.store.get(created.runId), before)
})

test('W3.1 a waiting human decision cancels directly to a known terminal', async t => {
  const h = await harness(t, { factory: false })
  const handle = await h.service.configuredRuntime()
  const created = await handle.store.createRun(
    { scope: 'run', requestId: 'w3-state-cancel-waiting', payloadFingerprint: 'w3-state-cancel-waiting' },
    'w3-state-revision',
    JSON.stringify({ schemaVersion: 2, id: 'w3-state-cancel', name: 'state', resources: {}, graph: { nodes: [], edges: [] } }),
    '{}'
  )
  const intent = await handle.store.recordIntent(created.runId, { nodeId: 'review', kind: 'humanDecision' })
  await handle.store.transition(created.runId, draft => {
    draft.state = 'waiting_input'
    draft.attempts.find(attempt => attempt.attemptId === intent.attemptId).state = 'waiting_input'
  })
  const before = await handle.store.get(created.runId)
  const cancelled = await handle.store.requestCancel(created.runId)
  assert.equal(before.state, 'waiting_input')
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.attempts[0].state, 'cancelled')
  assert.equal(cancelled.attempts[0].diagnostics, undefined)
  assert.equal(cancelled.seq, before.seq + 1)
})
