import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { activeNode, managedRun } from './managed-fixtures.mjs'
import { publicHost, textResponse, toolResponse } from './public-host-fixture.mjs'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { AGENT_CANCEL_QUIESCENCE_MS, BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'

test('a retry paused during its canonical read cannot return acceptance after the node closes', async t => {
  const h = await activeNode(t)
  await h.service.messageNode(h.args)
  await h.handle.agent.whenIdle()
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const get = h.runtime.store.get.bind(h.runtime.store)
  let reads = 0
  t.mock.method(h.runtime.store, 'get', async (...args) => {
    const record = await get(...args)
    if (++reads === 2) {
      entered.resolve()
      await release.promise
    }
    return record
  })
  const retry = h.service.messageNode(h.args)
  const rejected = assert.rejects(retry, { code: 'blueprint/node-not-active' })
  await entered.promise
  h.binding.close()
  release.resolve()
  await rejected
  assert.equal(h.adapter.requests.length, 1)
})

test('cancel bounds managed waiting and drain when persistence cannot settle', async t => {
  const h = await publicHost(t, [textResponse('Please clarify.')])
  const waiting = Promise.withResolvers(),
    release = Promise.withResolvers()
  const stop = new AbortController()
  let closed = false
  const running = new BlueprintAgentExecutor(h.ctx, h.ctx.agents).execute({
    runId: 'blocked-wait',
    attemptId: 'attempt',
    nodeId: 'review',
    interaction: 'managed',
    agentMd: '',
    skills: [],
    input: 'review',
    cwd: process.cwd(),
    modelSelection: h.selection,
    signal: stop.signal,
    bindManaged: () => ({
      close() {
        closed = true
      },
      async waiting() {
        waiting.resolve()
        await release.promise
      },
      async drain() {
        await release.promise
      },
      dispose() {}
    })
  })
  try {
    await waiting.promise
    stop.abort()
    const result = await Promise.race([running, delay(AGENT_CANCEL_QUIESCENCE_MS * 2, undefined)])
    assert.ok(result, 'cancellation observation must bound the blocked managed wait')
    assert.equal(result.outcome.kind, 'recovery_required')
    assert.equal(closed, true)
  } finally {
    release.resolve()
    await running
  }
})

test('a persisted pending message rejects replay; restart marks the unsettled managed Attempt as recovery_required', async t => {
  const h = await activeNode(t, [])
  const digest = createHash('sha256')
    .update(JSON.stringify([h.args.delivery, h.args.text]))
    .digest('hex')
  await h.runtime.store.transition(h.args.runId, draft => {
    draft.attempts[0].state = 'waiting_input'
    draft.attempts[0].messages = [{ requestId: h.args.requestId, digest, messageId: 'pending-message', state: 'pending', at: Date.now() }]
  })
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-message-unknown' })
  h.binding.dispose()
  await h.handle.dispose()
  const reopened = await openBlueprintDomain({ path: h.runtime.root })
  try {
    const store = new RunStore(reopened.domain)
    await reconcileOnStart(store)
    const recovered = await store.get(h.args.runId)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.attempts[0].state, 'recovery_required')
    assert.equal(recovered.attempts[0].messages[0].state, 'pending')
    assert.equal(h.adapter.requests.length, 0)
    await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-not-active' })
  } finally {
    await reopened.close()
  }
})

test('a failed durable message intent dispatches no input and exposes no raw storage error', async t => {
  const h = await activeNode(t, [])
  t.mock.method(h.runtime.store, 'transition', async () => {
    throw new Error('STORAGE_SECRET_CANARY')
  })
  await assert.rejects(
    h.service.messageNode(h.args),
    error => error.code === 'blueprint/durability-failed' && !JSON.stringify(error).includes('STORAGE_SECRET_CANARY')
  )
  assert.equal(h.adapter.requests.length, 0)
  assert.equal((await h.runtime.store.get(h.args.runId)).attempts[0].messages, undefined)
})

test('unknown acceptance after inbox delivery closes input and preserves a pending receipt for recovery', async t => {
  const h = await activeNode(t)
  const transition = h.runtime.store.transition.bind(h.runtime.store)
  let writes = 0
  t.mock.method(h.runtime.store, 'transition', async (...args) => {
    if (++writes === 2) throw new Error('ACCEPTANCE_STORAGE_CANARY')
    return transition(...args)
  })
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-message-unknown' })
  await h.handle.agent.whenIdle()
  assert.equal(h.unknown(), 1)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal((await h.runtime.store.get(h.args.runId)).attempts[0].messages[0].state, 'pending')
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-not-active' })
})

test('cancel closes admission before its durable cutoff and stops a message paused after intent', async t => {
  const h = await managedRun(t, [textResponse('Please clarify.')])
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const transition = h.runtime.store.transition.bind(h.runtime.store)
  t.mock.method(h.runtime.store, 'transition', async (...args) => {
    const record = await transition(...args)
    if (record.attempts.some(attempt => attempt.messages?.some(message => message.state === 'pending'))) {
      entered.resolve()
      await release.promise
    }
    return record
  })
  const delivery = h.service.messageNode(h.args)
  const rejected = assert.rejects(delivery, { code: 'blueprint/node-not-active' })
  await entered.promise
  await h.service.cancelRun({ runId: h.args.runId })
  await assert.rejects(h.service.messageNode({ ...h.args, requestId: 'after-cutoff' }), { code: 'blueprint/node-not-active' })
  release.resolve()
  await rejected
  await h.job
  assert.equal((await h.runtime.store.get(h.args.runId)).state, 'cancelled')
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.ctx.agents.get(h.args.sessionId), undefined)
})

test('cancel racing accepted completion settles once and drains the native Agent', async t => {
  const h = await managedRun(t, [textResponse('Please clarify.'), toolResponse('structured_output', { text: 'review complete' })])
  let cancellation
  h.ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'structured_output' && !result.isError) cancellation = h.service.cancelRun({ runId: h.args.runId })
  })
  await h.service.messageNode(h.args)
  await cancellation
  await h.job
  const record = await h.runtime.store.get(h.args.runId)
  assert.equal(record.state, 'cancelled')
  assert.equal(record.log.filter(event => event.kind === 'result').length, 1)
  assert.equal(h.ctx.agents.get(h.args.sessionId), undefined)
  await assert.rejects(h.service.messageNode({ ...h.args, requestId: 'late' }), { code: 'blueprint/node-not-active' })
})

test('production driver marks a delivered message with failed acceptance storage as recovery_required', async t => {
  const h = await managedRun(t, [textResponse('Please clarify.'), textResponse('Understood.')])
  const transition = h.runtime.store.transition.bind(h.runtime.store)
  let injected = false
  t.mock.method(h.runtime.store, 'transition', async (runId, reducer) => {
    const record = await h.runtime.store.get(runId)
    const draft = structuredClone(record)
    reducer(draft)
    if (!injected && draft.attempts.some(attempt => attempt.messages?.some(message => message.state === 'accepted'))) {
      injected = true
      throw new Error('acceptance write failed')
    }
    return transition(runId, reducer)
  })
  await assert.rejects(h.service.messageNode(h.args), { code: 'blueprint/node-message-unknown' })
  await h.job
  await h.agent.whenIdle()
  await nextTurn()
  const record = await h.runtime.store.get(h.args.runId)
  assert.equal(record.state, 'recovery_required')
  assert.equal(record.attempts[0].result, undefined)
  assert.equal(record.attempts[0].messages[0].state, 'pending')
  assert.equal(h.ctx.agents.get(h.args.sessionId), undefined)
})
