/** C-01 production driver barriers. Only the public Agent factory/model edge is
 * scripted by the existing fixture; scheduler, executor, Tools, Session and JSON
 * RunStore are real. No sleep, fake clock, replacement driver or seeded success.
 * Every deferred turn is released and the supervised job is joined on failure. */
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import { readyNodes } from '../../src/orchestration/scheduler.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { openBlueprintDomain, RunStore, DurabilityFailureError } from '../../src/persistence/index.ts'
import { harness, agentResources, definition, runArgs } from './agent-fixtures.mjs'

const completed = { kind: 'completed' }
const aborted = { kind: 'aborted', reason: { kind: 'parent' } }
const providerError = { kind: 'error', error: { code: 'TRANSPORT', message: 'controlled provider failure' } }
const runTerminals = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'])

function forkDefinition() {
  return definition(
    [
      { id: 'source', kind: 'input', outputs: { value: 'string' } },
      { id: 'a', kind: 'agentTask', agentRef: 'worker', inputs: { value: 'string' }, outputs: { value: 'string' } },
      { id: 'b', kind: 'agentTask', agentRef: 'worker', inputs: { value: 'string' }, outputs: { value: 'string' } },
      // Join is structural pass-through: its output names must match its input
      // names. This does not ask the join to synthesize an undeclared value.
      { id: 'merge', kind: 'join', join: 'all', inputs: { a: 'string', b: 'string' }, outputs: { a: 'string', b: 'string' } },
      { id: 'sink', kind: 'output', inputs: { a: 'string', b: 'string' }, outputs: { a: 'string', b: 'string' } }
    ],
    agentResources,
    [
      { kind: 'data', from: 'source.value', to: 'a.value' },
      { kind: 'data', from: 'source.value', to: 'b.value' },
      { kind: 'data', from: 'a.value', to: 'merge.a' },
      { kind: 'data', from: 'b.value', to: 'merge.b' },
      { kind: 'data', from: 'merge.a', to: 'sink.a' },
      { kind: 'data', from: 'merge.b', to: 'sink.b' }
    ]
  )
}

async function observe(predicate) {
  // Same finite event-turn I/O observation budget as agent-fixtures. Exhaustion
  // is never success: callers assert the precise missing behavior themselves.
  for (let turn = 0; turn < 20_000; turn++) {
    if (await predicate()) return true
    await nextTurn()
  }
  return false
}

async function fixture(t, cancelModes = {}, { value = forkDefinition(), config = {}, beforeStart, input = { value: 'parallel fixture input' } } = {}) {
  const identity = Promise.withResolvers()
  const controls = new Map()
  const gates = new Map(value.graph.nodes.filter(node => node.kind === 'agentTask').map(node => [node.id, Promise.withResolvers()]))
  const h = await harness(t, {
    config,
    onTurn: async call => {
      const runId = await identity.promise
      const record = await handle.store.get(runId)
      const attempt = record.attempts.find(item => item.sessionId === call.session.id)
      assert.ok(attempt?.intent, 'CONTROL: public followup must have its durable intent first')
      assert.ok(gates.has(attempt.nodeId), 'CONTROL: only declared Agent tasks reach the model boundary')
      assert.equal(controls.has(attempt.nodeId), false, 'CONTROL: each node starts only once')
      const originalCancel = call.agent.cancel
      const control = { call, attempt, originalCancel, cancellations: [] }
      controls.set(attempt.nodeId, control)
      call.agent.cancel = cause => {
        // Handle disposal invokes cancel even after acknowledged quiescence.
        // Only the live effect has a delayed/unknown cancellation contract.
        if (call.agent.status === 'idle') return originalCancel(cause)
        control.cancellations.push(cause)
        if (cancelModes[attempt.nodeId] === 'unknown') throw new Error('controlled unknown cancellation effect')
        if (cancelModes[attempt.nodeId] !== 'delayed') gates.get(attempt.nodeId).resolve({ reason: aborted, text: '' })
      }
      const result = await gates.get(attempt.nodeId).promise
      call.finish(result.reason, result.text)
    }
  })
  const handle = await h.service.runtimeFor(h.runtimeRoot)
  await beforeStart?.(handle)
  const document = await h.save(value)
  const args = runArgs(document, input)
  const preflight = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson })
  assert.equal(preflight.canStart, true, 'CONTROL: a valid same-name join graph must pass public preflight')
  const admission = await h.service.startRun(args)
  identity.resolve(admission.runId)
  const read = () => handle.store.get(admission.runId)
  const release = (nodeId, reason = completed, text = nodeId.toUpperCase()) => gates.get(nodeId).resolve({ reason, text })
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    for (const control of controls.values()) control.call.agent.cancel = control.originalCancel
    for (const nodeId of gates.keys()) release(nodeId)
    await handle.driverTail
    await h.close()
    assert.deepEqual(h.host.errors, [], 'CONTROL: cleanup must not mask a scripted-host error')
    assert.ok(
      h.host.calls.every(call => call.disposed),
      'CONTROL: every published scoped Agent is disposed after cleanup'
    )
  }
  return { h, handle, value, args, admission, controls, read, release, cleanup }
}

function attempt(record, nodeId) {
  return record.attempts.find(item => item.nodeId === nodeId)
}

async function assertBothStarted(f) {
  assert.equal(await observe(() => f.controls.has('a')), true, 'CONTROL: first Agent must actually start')
  assert.equal(await observe(() => f.controls.has('b')), true, 'PARALLEL_B_NOT_DISPATCHED: independent B must start while A is held without turn/end')
  const record = await f.read()
  assert.equal(record.state, 'running')
  const a = attempt(record, 'a'),
    b = attempt(record, 'b')
  for (const item of [a, b]) {
    assert.ok(item?.intent, 'each in-flight Agent has an authoritative durable intent')
    assert.equal(item.state, 'running')
    assert.equal(item.result, undefined)
    const control = f.controls.get(item.nodeId)
    assert.equal(item.sessionId, control.call.session.id)
    assert.equal(
      control.call.session.snapshotEvents().some(event => event.type === 'turn/end'),
      false,
      'barrier must hold actual Agent completion'
    )
  }
  assert.notEqual(a.attemptId, b.attemptId)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.notEqual(a.intent.seq, b.intent.seq)
  assert.equal(attempt(record, 'merge'), undefined, 'join-all must wait for both live dependencies')
}

test('C-01 independent Agents overlap, join-all waits both durable results, and replay never dispatches twice', async t => {
  const f = await fixture(t)
  try {
    await assertBothStarted(f)
    const replay = await f.h.service.startRun(f.args)
    assert.equal(replay.runId, f.admission.runId)
    assert.equal(replay.replayed, true)
    assert.equal(f.controls.size, 2)
    f.release('b')
    assert.equal(await observe(async () => attempt(await f.read(), 'b')?.state === 'succeeded'), true, 'B result must become durable independently of A')
    const half = await f.read()
    assert.equal(half.state, 'running')
    assert.equal(attempt(half, 'a').result, undefined)
    assert.equal(attempt(half, 'merge'), undefined, 'one accepted branch must not release join-all')
    f.release('a')
    await f.handle.driverTail
    const finished = await f.read()
    assert.equal(finished.state, 'succeeded')
    assert.deepEqual(attempt(finished, 'sink').result.outcome.outputs, { a: 'A', b: 'B' })
    const merge = attempt(finished, 'merge')
    assert.ok(merge.intent.seq > attempt(finished, 'a').result.seq)
    assert.ok(merge.intent.seq > attempt(finished, 'b').result.seq)
    assert.equal(f.h.host.calls.length, 2)
    const before = structuredClone(finished)
    await f.h.service.startRun(f.args)
    await f.handle.driverTail
    assert.deepEqual(await f.read(), before)
    assert.equal(f.h.host.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('C-01 cancel reaches every live Agent and keeps Run nonterminal until both acknowledge quiescence', async t => {
  const f = await fixture(t, { a: 'delayed', b: 'delayed' })
  try {
    await assertBothStarted(f)
    await f.h.service.cancelRun({ runId: f.admission.runId })
    assert.equal(
      await observe(() => [...f.controls.values()].every(control => control.cancellations.length === 1)),
      true,
      'CANCEL_DID_NOT_REACH_ALL: cancellation must reach both independent controllers'
    )
    assert.equal((await f.read()).state, 'cancelling')
    f.release('a', aborted, '')
    assert.equal(await observe(async () => attempt(await f.read(), 'a')?.result !== undefined), true)
    const half = await f.read()
    assert.equal(half.state, 'cancelling', 'CANCEL_EARLY_TERMINAL: B is still running with no acknowledged outcome')
    assert.equal(attempt(half, 'b').result, undefined)
    assert.equal(attempt(half, 'merge'), undefined)
    f.release('b', aborted, '')
    await f.handle.driverTail
    const finished = await f.read()
    assert.equal(finished.state, 'cancelled')
    assert.ok(['a', 'b'].every(id => attempt(finished, id).state === 'cancelled' && attempt(finished, id).result))
    assert.equal(f.h.host.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('C-01 provider failure stops new dispatch, cancels live sibling and waits for its known settlement', async t => {
  const f = await fixture(t, { b: 'delayed' })
  try {
    await assertBothStarted(f)
    f.release('a', providerError, '')
    assert.equal(
      await observe(() => f.controls.get('b').cancellations.length === 1),
      true,
      'FAILURE_DID_NOT_DRAIN_SIBLING: a failed branch must stop the other live Agent'
    )
    const half = await f.read()
    assert.equal(attempt(half, 'a').state, 'failed')
    assert.equal(attempt(half, 'a').result.outcome.kind, 'provider-failed')
    assert.equal(runTerminals.has(half.state), false, 'FAILURE_EARLY_TERMINAL: Run must not terminalize before sibling quiescence')
    assert.equal(attempt(half, 'b').result, undefined)
    assert.equal(attempt(half, 'merge'), undefined)
    f.release('b', aborted, '')
    await f.handle.driverTail
    const finished = await f.read()
    assert.equal(finished.state, 'failed', 'internal sibling interruption cannot replace the original provider failure with user cancellation')
    assert.equal(attempt(finished, 'b').state, 'cancelled')
    assert.ok(attempt(finished, 'b').result)
    assert.equal(attempt(finished, 'merge'), undefined)
    assert.equal(f.h.host.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('C-01 unknown sibling cancellation remains recovery_required across reopen with no replayed Agent', async t => {
  const f = await fixture(t, { b: 'unknown' })
  try {
    await assertBothStarted(f)
    f.release('a', providerError, '')
    assert.equal(
      await observe(() => f.controls.get('b').cancellations.length === 1),
      true,
      'UNKNOWN_SIBLING_NOT_OBSERVED: failed branch must attempt owned sibling interruption'
    )
    await f.handle.driverTail
    const unknown = await f.read()
    assert.equal(unknown.state, 'recovery_required', 'unknown live effect cannot be reported as failed/cancelled completion')
    assert.equal(attempt(unknown, 'a').state, 'failed')
    assert.equal(attempt(unknown, 'b').state, 'recovery_required')
    assert.equal(attempt(unknown, 'b').result, undefined, 'no fabricated terminal result for unknown effect')
    assert.ok(attempt(unknown, 'b').intent)
    assert.ok(attempt(unknown, 'b').sessionId)
    assert.equal(attempt(unknown, 'merge'), undefined)
    const calls = f.h.host.calls.length
    const replay = await f.h.service.startRun(f.args)
    assert.equal(replay.replayed, true)
    assert.equal(replay.runId, unknown.runId)
    await f.handle.driverTail
    assert.equal(f.h.host.calls.length, calls, 'replay cannot redispatch the unknown effect')
    const previousDomain = f.handle.opened.domain
    // Release only the scripted physical Agent for teardown. It cannot change
    // the already persisted unknown outcome; then close the actual owner.
    await f.cleanup()
    const opened = await openBlueprintDomain({ path: f.h.runtimeRoot })
    try {
      assert.notEqual(opened.domain, previousDomain)
      const store = new RunStore(opened.domain)
      await reconcileOnStart(store)
      assert.deepEqual(await store.get(unknown.runId), unknown, 'fresh domain/reconciliation preserves every known and unknown Attempt fact')
    } finally {
      await opened.close()
    }
  } finally {
    await f.cleanup()
  }
})

test('C-01 control: the valid fork exposes both independent Agent nodes to the production scheduler', () => {
  const value = forkDefinition()
  const snapshot = { attempts: [{ nodeId: 'source', states: ['succeeded'] }], decisions: {} }
  assert.deepEqual(readyNodes(value, snapshot).ready, ['a', 'b'])
})

test('C-01 control: the same fork completes through the production driver with valid join port mappings', async t => {
  const f = await fixture(t)
  try {
    f.release('a')
    f.release('b')
    await f.handle.driverTail
    const finished = await f.read()
    assert.equal(finished.state, 'succeeded')
    assert.deepEqual(attempt(finished, 'sink').result.outcome.outputs, { a: 'A', b: 'B' })
    assert.equal(f.h.host.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

const worker = id => ({ id, kind: 'agentTask', agentRef: 'worker', inputs: { value: 'string' }, outputs: { value: 'string' } })

test('C-01 default capacity is four, and a fifth ready Agent replaces any completed slot', async t => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const value = definition(ids.map(worker), agentResources)
  const f = await fixture(t, {}, { value })
  try {
    assert.equal(await observe(() => ['a', 'b', 'c', 'd'].every(id => f.controls.has(id))), true)
    assert.equal(await observe(() => f.controls.has('e')), false, 'CAPACITY_EXCEEDED: fifth Agent cannot start while four live effects are held')
    f.release('b')
    assert.equal(await observe(() => f.controls.has('e')), true, 'CAPACITY_NOT_REFILLED: any completed slot admits the next ready node')
    const half = await f.read()
    assert.ok(['a', 'c', 'd'].every(id => attempt(half, id).result === undefined))
    assert.equal(attempt(half, 'b').state, 'succeeded')
    for (const id of ids) f.release(id)
    await f.handle.driverTail
    assert.equal((await f.read()).state, 'succeeded')
    assert.equal(f.h.host.calls.length, 5)
  } finally {
    await f.cleanup()
  }
})

test('C-01 configured capacity refills a fast branch descendant while unrelated A is still live', async t => {
  const value = definition(['a', 'b', 'c', 'd'].map(worker), agentResources, [{ kind: 'data', from: 'b.value', to: 'c.value' }])
  const f = await fixture(t, {}, { value, config: { maxConcurrentNodes: 2 } })
  try {
    await assertBothStarted(f)
    assert.equal(await observe(() => f.controls.has('d')), false, 'CAPACITY_EXCEEDED: configuration must bound all live Agents')
    f.release('b')
    assert.equal(await observe(() => f.controls.has('c')), true, 'TOPOLOGY_BATCH_BARRIER: C must follow fast B while A has no turn/end')
    let half = await f.read()
    assert.equal(attempt(half, 'a').result, undefined)
    assert.equal(attempt(half, 'c').state, 'running')
    assert.equal(attempt(half, 'd'), undefined)
    f.release('c')
    assert.equal(await observe(() => f.controls.has('d')), true)
    half = await f.read()
    assert.equal(attempt(half, 'a').result, undefined)
    f.release('d')
    f.release('a')
    await f.handle.driverTail
    assert.equal((await f.read()).state, 'succeeded')
    assert.equal(f.h.host.calls.length, 4)
  } finally {
    await f.cleanup()
  }
})

for (const kind of ['join', 'condition']) {
  test(`C-01 fast branch crosses ${kind} and refills C while unrelated A is still live`, async t => {
    const bridge =
      kind === 'join'
        ? { id: 'bridge', kind, join: 'all', inputs: { value: 'string' }, outputs: { value: 'string' } }
        : {
            id: 'bridge',
            kind,
            inputs: { predicate: 'boolean' },
            branches: ['yes', 'no'],
            condition: { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' }
          }
    const edges =
      kind === 'join'
        ? [
            { kind: 'data', from: 'b.value', to: 'bridge.value' },
            { kind: 'data', from: 'bridge.value', to: 'c.value' }
          ]
        : [
            { kind: 'control', from: 'b', to: 'bridge' },
            { kind: 'control', from: 'bridge@yes', to: 'c' }
          ]
    const value = definition([worker('a'), worker('b'), bridge, worker('c')], agentResources, edges)
    const f = await fixture(t, {}, { value, config: { maxConcurrentNodes: 2 }, input: { value: 'parallel fixture input', predicate: true } })
    try {
      await assertBothStarted(f)
      f.release('b')
      assert.equal(await observe(async () => attempt(await f.read(), 'b')?.state === 'succeeded'), true)
      assert.equal(
        await observe(() => f.controls.has('c')),
        true,
        `STRUCTURAL_BRANCH_STALLED: ready ${kind} and C must advance after B while unrelated A has no turn/end`
      )
      const half = await f.read()
      assert.equal(half.state, 'running')
      assert.equal(attempt(half, 'a').result, undefined)
      assert.equal(attempt(half, 'bridge').state, 'succeeded')
      assert.ok(attempt(half, 'bridge').intent.seq > attempt(half, 'b').result.seq)
      assert.ok(attempt(half, 'c').intent.seq > attempt(half, 'bridge').result.seq)
      if (kind === 'join')
        assert.match(
          f.controls
            .get('c')
            .call.session.snapshotEvents()
            .find(event => event.type === 'user/message').data.content[0].text,
          /B/
        )
      else assert.equal(attempt(half, 'bridge').result.outcome.branch, 'yes')
      f.release('c')
      assert.equal(await observe(async () => attempt(await f.read(), 'c')?.state === 'succeeded'), true)
      assert.equal(attempt(await f.read(), 'a').result, undefined, 'C must finish before A is released')
      f.release('a')
      await f.handle.driverTail
      assert.equal((await f.read()).state, 'succeeded')
      assert.equal(f.h.host.calls.length, 3)
    } finally {
      await f.cleanup()
    }
  })
}

test('C-01 capacity one explicitly preserves serial execution', async t => {
  const f = await fixture(t, {}, { config: { maxConcurrentNodes: 1 } })
  try {
    assert.equal(await observe(() => f.controls.has('a')), true)
    assert.equal(await observe(() => f.controls.has('b')), false)
    f.release('a')
    assert.equal(await observe(() => f.controls.has('b')), true)
    f.release('b')
    await f.handle.driverTail
    assert.equal((await f.read()).state, 'succeeded')
  } finally {
    await f.cleanup()
  }
})

test('C-01 capacity rejects invalid configuration without imposing an arbitrary domain ceiling', async () => {
  for (const maxConcurrentNodes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const ctx = new Context()
    try {
      assert.throws(() => new BlueprintService(ctx, { maxConcurrentNodes }), /maxConcurrentNodes must be a positive safe integer/)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  const ctx = new Context()
  try {
    assert.doesNotThrow(() => new BlueprintService(ctx, { maxConcurrentNodes: Number.MAX_SAFE_INTEGER }))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('C-01 a later sibling provider failure remains failed after earlier A is interrupted', async t => {
  const f = await fixture(t, { a: 'delayed' })
  try {
    await assertBothStarted(f)
    f.release('b', providerError, '')
    assert.equal(await observe(() => f.controls.get('a').cancellations.length === 1), true)
    assert.equal(runTerminals.has((await f.read()).state), false)
    f.release('a', aborted, '')
    await f.handle.driverTail
    const record = await f.read()
    assert.equal(record.state, 'failed', 'SIBLING_CANCEL_REPLACED_FAILURE: insertion order cannot choose interrupted A as the Run terminal')
    assert.equal(attempt(record, 'a').state, 'cancelled')
    assert.equal(attempt(record, 'b').state, 'failed')
  } finally {
    await f.cleanup()
  }
})

test('C-01 cancel drains an already-started resource preparation without late intent or Agent dispatch', async t => {
  const preparation = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let driverEnded = false
  const f = await fixture(
    t,
    {},
    {
      beforeStart: handle => {
        const prepare = handle.snapshots.prepare.bind(handle.snapshots)
        t.mock.method(handle.snapshots, 'prepare', async (...args) => {
          // Admission now resolves every Agent binding before the Run is
          // queued. Hold only the live execution preparation after the Run
          // has entered `running`, otherwise the admission snapshot would be
          // mistaken for the deferred Attempt preparation.
          const current = await handle.store.get(args[0])
          if (args[2].id === 'b' && current.state === 'running') {
            entered.resolve()
            await preparation.promise
          }
          return prepare(...args)
        })
      }
    }
  )
  try {
    assert.equal(await observe(() => f.controls.has('a')), true)
    await entered.promise
    void f.handle.driverTail.then(() => {
      driverEnded = true
    })
    await f.h.service.cancelRun({ runId: f.admission.runId })
    assert.equal(await observe(async () => attempt(await f.read(), 'a')?.result !== undefined), true)
    assert.equal(driverEnded, false, 'PREPARATION_ESCAPED_OWNER: driver must retain the still-preparing job after durable cancel')
    preparation.resolve()
    await f.handle.driverTail
    const record = await f.read()
    assert.equal(record.state, 'cancelled')
    assert.equal(attempt(record, 'b'), undefined)
    assert.equal(f.h.host.calls.length, 1)
  } finally {
    preparation.resolve()
    await f.cleanup()
  }
})

test('C-01 human approval owns Run-wide waiting state only after live Agents drain, then resume is idempotent', async t => {
  const value = definition([worker('a'), { id: 'approval', kind: 'humanDecision' }, worker('b')], agentResources)
  const f = await fixture(t, {}, { value })
  try {
    assert.equal(await observe(() => f.controls.has('a')), true)
    assert.equal(
      await observe(async () => attempt(await f.read(), 'approval') !== undefined),
      false,
      'WAITING_WITH_LIVE_AGENT: approval must wait for exclusive Run ownership'
    )
    assert.equal(f.controls.has('b'), false)
    f.release('a')
    await f.handle.driverTail
    let record = await f.read()
    assert.equal(record.state, 'waiting_input')
    assert.equal(attempt(record, 'a').state, 'succeeded')
    assert.equal(attempt(record, 'approval').state, 'waiting_input')
    assert.equal(attempt(record, 'b'), undefined)
    const args = { runId: record.runId, decisionId: 'approval-once', action: 'approve' }
    assert.equal((await f.h.service.decide(args)).applied, true)
    assert.equal(await observe(() => f.controls.has('b')), true)
    f.release('b')
    await f.handle.driverTail
    record = await f.read()
    assert.equal(record.state, 'succeeded')
    assert.equal((await f.h.service.decide(args)).applied, false)
    assert.deepEqual(await f.read(), record)
  } finally {
    await f.cleanup()
  }
})

test('C-01 a result durability failure drains live siblings before background recovery settlement', async t => {
  const f = await fixture(t, { a: 'delayed' })
  try {
    await assertBothStarted(f)
    const recordResult = f.handle.store.recordResult.bind(f.handle.store)
    t.mock.method(f.handle.store, 'recordResult', async (runId, attemptId, result) => {
      if (attemptId === f.controls.get('b').attempt.attemptId)
        throw new DurabilityFailureError('controlled result write', new Error('controlled storage failure'))
      return recordResult(runId, attemptId, result)
    })
    f.release('b')
    assert.equal(await observe(() => f.controls.get('a').cancellations.length === 1), true)
    const half = await f.read()
    assert.equal(runTerminals.has(half.state), false, 'BACKGROUND_FAILURE_ESCAPED_OWNER: sibling must quiesce before recovery is written')
    assert.equal(attempt(half, 'a').result, undefined)
    f.release('a', aborted, '')
    await f.handle.driverTail
    const record = await f.read()
    assert.equal(record.state, 'recovery_required')
    assert.equal(attempt(record, 'a').state, 'cancelled')
    assert.ok(attempt(record, 'a').result)
    assert.equal(attempt(record, 'b').state, 'recovery_required')
    assert.equal(attempt(record, 'b').result, undefined)
    assert.equal(attempt(record, 'merge'), undefined)
  } finally {
    await f.cleanup()
  }
})

test('C-01 failure cutoff rejects a delayed sibling intent and preserves the original failure', async t => {
  const writing = Promise.withResolvers()
  const releaseWrite = Promise.withResolvers()
  const f = await fixture(
    t,
    {},
    {
      beforeStart: handle => {
        const recordIntent = handle.store.recordIntent.bind(handle.store)
        t.mock.method(handle.store, 'recordIntent', async (runId, value) => {
          if (value.nodeId === 'b') {
            writing.resolve()
            await releaseWrite.promise
          }
          return recordIntent(runId, value)
        })
      }
    }
  )
  try {
    assert.equal(await observe(() => f.controls.has('a')), true)
    await writing.promise
    f.release('a', providerError, '')
    assert.equal(await observe(async () => attempt(await f.read(), 'a')?.state === 'failed'), true)
    releaseWrite.resolve()
    await f.handle.driverTail
    const record = await f.read()
    assert.equal(record.state, 'failed')
    assert.equal(attempt(record, 'a').result.outcome.kind, 'provider-failed')
    assert.equal(attempt(record, 'b'), undefined, 'LATE_INTENT_AFTER_FAILURE: atomic store cutoff must reject the delayed reservation')
    assert.equal(f.h.host.calls.length, 1)
  } finally {
    releaseWrite.resolve()
    await f.cleanup()
  }
})
