import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationController, resolveConversationHost, conversationFocusNodes } from '../../src/client/conversation-controller.ts'
import { projectFrozenCanvas, conversationInspectableCall } from '../../src/client/conversation-canvas.ts'
import { inspectSessionCodec } from '../../src/conversation/contracts.ts'

const summary = (runId, createdAt) => ({ runId, createdAt, state: 'running', definitionRevision: 'frozen-v1', blueprintId: 'blueprint-a' })
const value = (sessionId = 'source', runId = 'new', seq = 1) => ({
  status: 'bound',
  sessionId,
  runs: [summary('new', 2), summary('history', 1)],
  selected: {
    run: {
      runId,
      state: 'running',
      definitionRevision: 'frozen-v1',
      seq,
      attempts: [
        { nodeId: 'worker', attemptId: 'attempt-A', sessionId: 'child-A', attempt: 1, state: 'running' },
        { nodeId: 'parallel', attemptId: 'attempt-B', sessionId: 'child-B', attempt: 1, state: 'preparing' },
        { nodeId: 'legacy', attempt: 0, state: 'succeeded' }
      ],
      logTail: []
    },
    source: { sessionId: 'source', kind: 'tool', callId: 'source-call', turn: 2 },
    graph: {
      nodes: [
        { id: 'worker', kind: 'agentTask', inputs: { 'legal.port': 'json' } },
        { id: 'parallel', kind: 'agentTask', outputs: { result: 'json' } }
      ],
      edges: [{ kind: 'data', from: 'parallel.result', to: 'worker.legal.port' }]
    },
    presentation: {
      nodes: { worker: { x: 420, y: 80, title: '用户原名 / raw', width: 240, collapsed: true, color: 'blue' }, parallel: { x: 10, y: 20 } },
      edges: [{ kind: 'data', from: 'parallel.result', to: 'worker.legal.port', points: [{ x: 300, y: 100 }] }]
    },
    focusAttemptIds: ['attempt-A', 'attempt-B']
  }
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function controlled() {
  const calls = []
  const host = new Proxy(
    {
      inspectSession(args) {
        const task = deferred()
        calls.push({ args, ...task })
        return task.promise
      }
    },
    {
      get(target, key) {
        assert.equal(key, 'inspectSession', 'READONLY_CONTROLLER_MUST_NOT_ACCESS_EXECUTION_OR_LIVE_DOCUMENT')
        return target[key]
      }
    }
  )
  return { controller: new ConversationController(host, 'source'), calls }
}

test('strict native reader preserves proxy receiver, exposes only inspectSession, rejects malformed envelopes and args', async () => {
  let wire = { ok: true, value: { status: 'unbound', sessionId: 'source' } }
  const calls = []
  const namespace = {
    async inspectSession(args) {
      assert.equal(this, namespace)
      calls.push(args)
      return wire
    }
  }
  const host = resolveConversationHost({
    get(key) {
      assert.equal(key, 'remote.blueprint')
      return namespace
    }
  })
  assert.deepEqual(Object.keys(host), ['inspectSession'])
  assert.equal((await host.inspectSession({ sessionId: 'source' })).status, 'unbound')
  await assert.rejects(host.inspectSession({ sessionId: 'source', raw: '/secret' }), { code: 'blueprint/bad-request' })
  assert.equal(calls.length, 1)
  for (const invalid of [null, [], { ok: 'yes' }, { ok: false, error: { body: '/secret' } }]) {
    wire = invalid
    await assert.rejects(host.inspectSession({ sessionId: 'source' }), error => ['blueprint/dto-invalid', 'blueprint/remote-failed'].includes(error.code))
  }
})

test('race: a late old-Session response cannot replace the new Session or any of its facts', async () => {
  const { controller, calls } = controlled()
  const old = controller.refresh()
  controller.setSession('child-B')
  assert.equal(controller.getSnapshot().value, null)
  const current = controller.refresh()
  calls[1].resolve(value('child-B'))
  await current
  const accepted = controller.getSnapshot()
  calls[0].resolve(value('source', 'history', 900))
  await old
  assert.equal(controller.getSnapshot(), accepted)
  assert.equal(accepted.sessionId, 'child-B')
  assert.deepEqual(
    calls.map(call => call.args),
    [{ sessionId: 'source' }, { sessionId: 'child-B' }]
  )
})

test('race: manual historical Run choice wins over old automatic polling and survives later newer Runs', async () => {
  const { controller, calls } = controlled()
  const first = controller.refresh()
  calls[0].resolve(value())
  await first
  const oldPoll = controller.refresh()
  const selected = controller.selectRun('history')
  assert.deepEqual(calls[2].args, { sessionId: 'source', runId: 'history' })
  calls[2].resolve(value('source', 'history', 3))
  await selected
  calls[1].resolve(value('source', 'new', 999))
  await oldPoll
  assert.equal(controller.getSnapshot().value.selected.run.runId, 'history')
  controller.selectAttempt('attempt-B')
  controller.pause()
  controller.resume()
  const reconnect = controller.refresh()
  const next = value('source', 'history', 4)
  next.runs.push(summary('even-newer', 4))
  calls[3].resolve(next)
  await reconnect
  assert.equal(controller.getSnapshot().value.selected.run.runId, 'history')
  assert.equal(controller.getSnapshot().selectedAttemptId, 'attempt-B')
  assert.deepEqual(
    controller.getSnapshot().value.runs.map(run => run.runId),
    ['even-newer', 'new', 'history']
  )
  assert.equal(calls[3].args.runId, 'history')
})

test('race: newer explicit reads win; late failures, offline reads and unmounted responses are inert', async () => {
  const { controller, calls } = controlled()
  const before = controller.refresh(),
    after = controller.refresh()
  calls[1].resolve(value('source', 'new', 2))
  await after
  const accepted = controller.getSnapshot()
  calls[0].reject(new Error('raw credential /secret'))
  await before
  assert.equal(controller.getSnapshot(), accepted)
  const offline = controller.refresh()
  controller.markStale()
  calls[2].resolve(value('source', 'new', 3))
  await offline
  assert.equal(controller.getSnapshot().connection, 'stale')
  assert.equal(controller.getSnapshot().value.selected.run.seq, 2)
  const unmount = controller.refresh()
  controller.pause()
  calls[3].resolve(value('source', 'new', 4))
  await unmount
  await controller.refresh()
  assert.equal(calls.length, 4, 'no polling or commands after observation cleanup')
  controller.resume()
  const remount = controller.refresh()
  calls[4].resolve(value('source', 'new', 5))
  await remount
  assert.equal(controller.getSnapshot().connection, 'connected')
})

test('slow reads are not superseded by periodic polling, and polling resumes after failure', async () => {
  const { controller, calls } = controlled()
  const first = controller.poll()
  await controller.poll()
  await controller.poll()
  assert.equal(calls.length, 1)
  calls[0].reject(new Error('transport unavailable'))
  await first
  const retry = controller.poll()
  calls[1].resolve({ status: 'unbound', sessionId: 'source' })
  await retry
  assert.equal(controller.getSnapshot().value.status, 'unbound')
})

test('race: setSession clears a permanently pending old read so the new Session can poll immediately', async () => {
  const { controller, calls } = controlled()
  const old = controller.poll()
  controller.setSession('child-B')
  const current = controller.poll()
  assert.equal(calls.length, 2, 'new Session must read without waiting for old transport')
  calls[1].resolve(value('child-B'))
  await current
  const accepted = controller.getSnapshot()
  calls[0].resolve(value())
  await old
  assert.equal(controller.getSnapshot(), accepted)
})

test('strict DTO and response identities reject raw fields, foreign Session, bogus focus and wrong historical selection', async () => {
  const good = value()
  assert.equal(inspectSessionCodec().safeParse(good).success, true, 'positive production-codec control')
  const mutations = [
    v => {
      v.raw = 'forbidden'
    },
    v => {
      v.selected.graph.nodes[0].prompt = 'forbidden'
    },
    v => {
      v.sessionId = 'foreign'
    },
    v => {
      v.selected.focusAttemptIds.push('made-up')
    },
    v => {
      v.selected.run.runId = 'foreign-run'
    },
    v => {
      v.runs[0].definitionRevision = 'wrong'
    }
  ]
  for (const mutate of mutations) {
    const { controller, calls } = controlled()
    let read = controller.refresh()
    calls[0].resolve(good)
    await read
    const previous = controller.getSnapshot().value
    const invalid = value()
    mutate(invalid)
    read = controller.refresh()
    calls[1].resolve(invalid)
    await read
    assert.equal(controller.getSnapshot().connection, 'stale')
    assert.equal(controller.getSnapshot().errorCode, 'blueprint/dto-invalid')
    assert.equal(controller.getSnapshot().value, previous)
  }
  const { controller, calls } = controlled()
  const first = controller.refresh()
  calls[0].resolve(good)
  await first
  const history = controller.selectRun('history')
  calls[1].resolve(value())
  await history
  assert.equal(controller.getSnapshot().errorCode, 'blueprint/dto-invalid')
  const again = controller.refresh()
  assert.equal(calls[2].args.runId, 'history')
  calls[2].resolve(value('source', 'history'))
  await again
  assert.equal(controller.getSnapshot().value.selected.run.runId, 'history')
})

test('immutable frozen revision and monotonic sequence reject regressed snapshots; raw transport errors stay static', async () => {
  const { controller, calls } = controlled()
  let read = controller.refresh()
  calls[0].resolve(value('source', 'new', 5))
  await read
  read = controller.refresh()
  calls[1].resolve(value('source', 'new', 4))
  await read
  assert.equal(controller.getSnapshot().value.selected.run.seq, 5)
  read = controller.refresh()
  const changed = value('source', 'new', 6)
  changed.selected.run.definitionRevision = changed.runs[0].definitionRevision = 'live-file-changed'
  calls[2].resolve(changed)
  await read
  assert.equal(controller.getSnapshot().value.selected.run.definitionRevision, 'frozen-v1')
  read = controller.refresh()
  calls[3].reject(new Error('raw-provider-key=/secret'))
  await read
  assert.equal(controller.getSnapshot().errorCode, 'blueprint/remote-failed')
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('raw-provider-key'), false)
})

test('unbound, legacy Attempt and missing host never invent lineage, Attempt ID or a Run', async () => {
  const { controller, calls } = controlled()
  const read = controller.refresh()
  calls[0].resolve({ status: 'unbound', sessionId: 'source' })
  await read
  await controller.selectRun('guessed')
  controller.selectAttempt('guessed')
  assert.equal(calls.length, 1)
  assert.deepEqual(conversationFocusNodes(controller.getSnapshot().value), [])
  const legacy = value()
  delete legacy.selected.source
  legacy.selected.focusAttemptIds = []
  legacy.selected.run.attempts = [{ nodeId: 'worker', state: 'succeeded', attempt: 1 }]
  const again = controller.refresh()
  calls[1].resolve(legacy)
  await again
  assert.equal(controller.getSnapshot().value.selected.run.attempts[0].attemptId, undefined)
  assert.equal(controller.getSnapshot().selectedAttemptId, null)
  const missing = new ConversationController(undefined, 'source')
  await missing.refresh()
  assert.equal(missing.getSnapshot().connection, 'unavailable')
  assert.equal(missing.getSnapshot().value, null)
})

test('ordinary unbound tab cleanup keeps a neutral snapshot and invalidates late reads', async () => {
  const { controller, calls } = controlled()
  const read = controller.refresh()
  calls[0].resolve({ status: 'unbound', sessionId: 'source' })
  await read
  const accepted = controller.getSnapshot()
  const late = controller.refresh()
  controller.pause()
  assert.equal(controller.getSnapshot().connection, 'connected', 'normal tab cleanup is not a failed read')
  assert.equal(controller.getSnapshot().errorCode, null)
  calls[1].reject(new Error('late unavailable'))
  await late
  assert.equal(controller.getSnapshot().value, accepted.value)
  assert.equal(controller.getSnapshot().connection, 'connected')
  controller.resume()
  const again = controller.poll()
  calls[2].resolve({ status: 'unbound', sessionId: 'source' })
  await again
  assert.equal(controller.getSnapshot().connection, 'connected')
  assert.equal(controller.getSnapshot().value.status, 'unbound')
})

test('unbound offline or failed reads remain unavailable and successful empty retries clear the error', async () => {
  const { controller, calls } = controlled()
  const read = controller.refresh()
  calls[0].resolve({ status: 'unbound', sessionId: 'source' })
  await read
  controller.markStale()
  assert.equal(controller.getSnapshot().connection, 'unavailable', 'an empty DTO is not a retained graph')
  const failed = controller.refresh()
  calls[1].reject(new Error('PRIVATE_ERROR_SENTINEL'))
  await failed
  assert.equal(controller.getSnapshot().connection, 'unavailable')
  assert.equal(controller.getSnapshot().errorCode, 'blueprint/remote-failed')
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('PRIVATE_ERROR_SENTINEL'), false)
  const retry = controller.refresh()
  calls[2].resolve({ status: 'unbound', sessionId: 'source' })
  await retry
  assert.equal(controller.getSnapshot().connection, 'connected')
  assert.equal(controller.getSnapshot().errorCode, null)
})

test('missing capability, malformed DTO and remote failure never become an ordinary unbound result', async () => {
  for (const [namespace, expected] of [
    [undefined, 'blueprint/host-unavailable'],
    [{}, 'blueprint/capability-unavailable'],
    [{ inspectSession: async () => ({ ok: true, value: { status: 'unbound', sessionId: 'other' } }) }, 'blueprint/dto-invalid'],
    [{ inspectSession: async () => ({ ok: true, value: { status: 'unbound', sessionId: 'source', runs: [] } }) }, 'blueprint/dto-invalid'],
    [
      { inspectSession: async () => ({ ok: false, error: { code: 'blueprint/durability-failed', raw: 'PRIVATE_ERROR_SENTINEL' } }) },
      'blueprint/durability-failed'
    ]
  ]) {
    const controller = new ConversationController(resolveConversationHost({ get: () => namespace }), 'source')
    await controller.refresh()
    assert.equal(controller.getSnapshot().connection, 'unavailable')
    assert.equal(controller.getSnapshot().errorCode, expected)
    assert.equal(controller.getSnapshot().value, null)
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('PRIVATE_ERROR_SENTINEL'), false)
  }
})

test('frozen XYFlow uses saved positions, exact dotted handles, canonical focus set and static stale/reduced/hidden states', async () => {
  const good = value()
  const before = structuredClone(good)
  const snapshot = { sessionId: 'source', value: good, connection: 'connected', selectedAttemptId: null, errorCode: null }
  const projected = projectFrozenCanvas(snapshot, false, true)
  assert.deepEqual(conversationFocusNodes(good), ['worker', 'parallel'])
  assert.deepEqual(
    projected.nodes.map(node => node.position),
    [
      { x: 420, y: 80 },
      { x: 10, y: 20 }
    ]
  )
  assert.equal(projected.nodes[0].data.title, '用户原名 / raw')
  assert.equal(projected.nodes[0].data.collapsed, true)
  assert.equal(projected.nodes[0].style.width, 240)
  assert.equal(projected.nodes[0].data.state, 'running')
  assert.equal(projected.nodes[0].data.motion, 'pulse')
  assert.equal(
    projected.nodes.every(node => node.data.focused),
    true
  )
  assert.equal(
    projected.nodes.every(node => !node.draggable && !node.connectable && !node.deletable),
    true
  )
  assert.equal(projected.edges[0].targetHandle, 'data:legal.port')
  assert.deepEqual(projected.edges[0].data.points, [{ x: 300, y: 100 }])
  for (const [connection, reduced, visible] of [
    ['stale', false, true],
    ['connected', true, true],
    ['connected', false, false]
  ]) {
    const graph = projectFrozenCanvas({ ...snapshot, connection }, reduced, visible)
    assert.equal(
      graph.nodes.every(node => node.data.motion === 'static'),
      true
    )
    assert.deepEqual(
      graph.nodes.map(node => node.position),
      projected.nodes.map(node => node.position)
    )
  }
  assert.deepEqual(good, before, 'projection never edits frozen data')
  assert.equal(conversationInspectableCall(good, 'source'), 'source-call')
  assert.equal(conversationInspectableCall(good, 'child-A'), undefined)
})

test('future raw states survive display classification; ambiguous latest ties, terminals and stale facts never pulse', () => {
  const good = value()
  good.selected.run.attempts[0].state = 'future_review_pending'
  const snapshot = { sessionId: 'source', value: good, connection: 'connected', selectedAttemptId: null, errorCode: null }
  let projected = projectFrozenCanvas(snapshot, false, true)
  assert.equal(projected.nodes[0].data.rawState, 'future_review_pending', 'wire fact stays exact')
  assert.equal(projected.nodes[0].data.state, 'unknown', 'unsupported display class is explicitly unknown')
  assert.equal(projected.nodes[0].data.motion, 'static')
  good.selected.run.attempts[0].state = 'running'
  good.selected.run.attempts.push({ nodeId: 'worker', attemptId: 'tie', attempt: 1, state: 'failed' })
  projected = projectFrozenCanvas(snapshot, false, true)
  assert.equal(projected.nodes[0].data.rawState, 'unknown', 'ordinal tie cannot invent which state is latest')
  assert.equal(projected.nodes[0].data.state, 'unknown')
  assert.equal(projected.nodes[0].data.motion, 'static')
  good.selected.run.attempts.pop()
  for (const terminal of ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required']) {
    good.selected.run.state = terminal
    projected = projectFrozenCanvas(snapshot, false, true)
    assert.equal(
      projected.nodes.every(node => node.data.motion === 'static'),
      true,
      terminal
    )
    assert.equal(projected.nodes[0].data.rawState, 'running', 'a terminal Run does not rewrite a recorded Attempt')
  }
  good.selected.run.state = 'running'
  projected = projectFrozenCanvas({ ...snapshot, connection: 'stale' }, false, true)
  assert.equal(projected.nodes[0].data.rawState, 'running')
  assert.equal(projected.nodes[0].data.motion, 'static')
})

test('frozen presentation groups preserve labels and saved bounds without acquiring edit capability or live files', () => {
  const good = value()
  good.selected.presentation.nodes.worker.height = 180
  good.selected.presentation.nodes.parallel.width = 200
  good.selected.presentation.nodes.parallel.height = 160
  good.selected.presentation.groups = [
    { id: 'crew', label: '冻结分组 / raw', nodeIds: ['worker', 'parallel', 'missing', 'worker'] },
    { id: 'empty', label: 'Not rendered', nodeIds: ['missing'] }
  ]
  const snapshot = { sessionId: 'source', value: good, connection: 'connected', selectedAttemptId: null, errorCode: null }
  const original = structuredClone(good)
  const { groups } = projectFrozenCanvas(snapshot, false, true)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].data.groupId, 'crew')
  assert.equal(groups[0].data.label, '冻结分组 / raw')
  assert.deepEqual(groups[0].data.nodeIds, ['worker', 'parallel'])
  assert.deepEqual(groups[0].position, { x: -14, y: -48 })
  assert.deepEqual(groups[0].style, { width: 698, height: 332, pointerEvents: 'none' })
  assert.equal(groups[0].draggable, false)
  assert.equal(groups[0].connectable, false)
  assert.equal(groups[0].deletable, false)
  assert.equal(groups[0].selectable, false)
  assert.deepEqual(good, original)
})
