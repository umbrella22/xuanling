// Production component/callback oracle with controlled React/XYFlow seats.
// This is deterministic client behavior, not installed DSH/browser/provider acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { ConversationController } from '../../src/client/conversation-controller.ts'
import { en, zh } from '../../src/client/locales.ts'

const key = Symbol.for('blueprint.test.conversation.view')
const seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState(initial) {
    const f = seat.active,
      i = f.stateCursor++
    f.states[i] ??= typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      value => {
        f.states[i] = value
      }
    ]
  },
  useRef(initial) {
    const f = seat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useEffect(callback, deps) {
    const f = seat.active,
      i = f.effectCursor++,
      old = f.effects[i]
    if (!old || deps.some((value, index) => value !== old.deps[index])) {
      old?.cleanup?.()
      f.effects[i] = { callback, deps, cleanup: null, pending: true }
    }
  }
}
const url = source => `data:text/javascript,${encodeURIComponent(source)}`
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL === `${client}conversation-view.ts` && spec === 'react')
      return {
        url: url("export default globalThis[Symbol.for('blueprint.test.conversation.view')].react"),
        shortCircuit: true
      }
    if (context.parentURL === `${client}conversation-view.ts` && spec === '@xyflow/react')
      return {
        url: url(
          "export const ReactFlow='flow',Handle='handle',BaseEdge='edge';export const Position={Left:'left',Right:'right'};export const getSmoothStepPath=()=>['M 0 0 L 1 1'];"
        ),
        shortCircuit: true
      }
    return next(spec, context)
  }
})
let View
try {
  ;({ ConversationBlueprintView: View } = await import(`${client}conversation-view.ts`))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})
const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]
const one = (tree, predicate) => {
  const found = all(tree, predicate)
  assert.equal(found.length, 1)
  return found[0]
}
const translate =
  dict =>
  (key, params = {}) => {
    assert.ok(Object.hasOwn(dict, key), `MISSING_VISIBLE_TRANSLATION:${key}`)
    return dict[key].replace(/\{(\w+)\}/g, (_token, name) => String(params[name]))
  }
const data = (runId = 'r1', seq = 1) => ({
  status: 'bound',
  sessionId: 'source',
  runs: [
    { runId: 'r1', state: 'running', createdAt: 2, definitionRevision: 'frozen' },
    { runId: 'r0', state: 'succeeded', createdAt: 1, definitionRevision: 'frozen' }
  ],
  selected: {
    run: {
      runId,
      state: 'running',
      seq,
      definitionRevision: 'frozen',
      logTail: [],
      attempts: [
        { attemptId: 'a1', nodeId: 'n1', attempt: 1, state: 'running' },
        { attemptId: 'a2', nodeId: 'n2', attempt: 1, state: 'running' }
      ]
    },
    source: { sessionId: 'source', kind: 'tool', callId: 'call-1' },
    graph: {
      nodes: [
        { id: 'n1', kind: 'agentTask' },
        { id: 'n2', kind: 'agentTask' },
        { id: 'source', kind: 'input' }
      ],
      edges: []
    },
    presentation: {
      nodes: { n1: { x: 10, y: 20 }, n2: { x: 300, y: 20 }, source: { x: -300, y: 20 } },
      groups: [{ id: 'g', label: '原始分组', nodeIds: ['n1', 'n2', 'source'] }]
    },
    focusAttemptIds: ['a1', 'a2']
  }
})

const stageData = () => {
  const value = data()
  value.selected.run.team = {
    schemaVersion: 1,
    runId: 'r1',
    stageId: 'n1',
    teamId: 'source',
    leadSessionId: 'source',
    attemptId: 'a1',
    taskId: 'native-task',
    taskRevision: 3,
    taskSpecificationFingerprint: 'a'.repeat(64),
    state: 'succeeded',
    updatedAt: 3,
    members: [{ memberId: 'producer', name: 'producer', sessionId: 'child-producer', phase: 'active', status: 'inactive' }],
    outputAcceptance: {
      schemaVersion: 1,
      code: 'accepted',
      runId: 'r1',
      stageId: 'n1',
      taskId: 'native-task',
      attemptId: 'a1',
      sourceSessionId: 'child-producer',
      artifactId: 'artifact',
      digest: 'b'.repeat(64),
      evidenceDigest: 'c'.repeat(64),
      checks: ['schema', 'digest']
    }
  }
  value.selected.run.state = 'succeeded'
  value.selected.run.attempts[0].state = 'succeeded'
  return value
}
function fixture(dict = en) {
  const state = { states: [], refs: [], effects: [], stateCursor: 0, refCursor: 0, effectCursor: 0 }
  let response = data()
  const reads = [],
    inspections = [],
    fits = []
  const controller = new ConversationController(
    {
      async inspectSession(args) {
        reads.push(args)
        return typeof response === 'function' ? response(args) : response
      }
    },
    'source'
  )
  const props = { controller, sessionId: 'source', t: translate(dict), inspectCall: callId => inspections.push(callId) }
  return {
    controller,
    props,
    reads,
    inspections,
    fits,
    setResponse(value) {
      response = value
    },
    render() {
      seat.active = state
      state.stateCursor = state.refCursor = state.effectCursor = 0
      return View(props)
    },
    effects() {
      for (const effect of state.effects)
        if (effect.pending) {
          effect.pending = false
          effect.cleanup = effect.callback()
        }
    },
    cleanup() {
      for (const effect of state.effects) effect.cleanup?.()
    },
    attach(tree) {
      one(tree, node => node.type === 'flow').props.onInit({
        fitView: options => {
          fits.push(options)
          return Promise.resolve(true)
        }
      })
    }
  }
}

test('W3 C-03/C-04/C-07: both locales expose stage, Lead, task revision and artifact acceptance as separate read-only facts', async () => {
  for (const dict of [zh, en]) {
    const f = fixture(dict)
    f.setResponse(stageData())
    await f.controller.refresh()
    const tree = f.render()
    const panel = one(tree, node => node.props['data-bp-team-stage'] === 'n1')
    assert.equal(panel.props['data-bp-team-run'], 'r1')
    assert.equal(panel.props['data-bp-team-state'], 'succeeded')
    const text = JSON.stringify(panel.children)
    for (const fact of ['source', 'native-task', 'child-producer', 'artifact', 'b'.repeat(64), 'schema', 'digest']) {
      assert.ok(text.includes(fact), `visible evidence missing: ${fact}`)
    }
    const task = one(panel, node => node.props['data-bp-team-task-id'] === 'native-task')
    assert.equal(task.props['data-bp-team-task-revision'], 3)
    const member = one(panel, node => node.props['data-bp-member-id'] === 'producer')
    assert.equal(member.props['data-bp-member-phase'], 'active')
    assert.equal(member.props['data-bp-member-status'], 'inactive')
    assert.equal(member.props['data-bp-activity'], 'unavailable', 'terminal inactive is not a live activity observation')
    assert.equal(one(panel, node => node.props['data-bp-team-acceptance']).props['data-bp-team-acceptance'], 'accepted')
    assert.equal(all(panel, node => ['button', 'input', 'textarea', 'form'].includes(node.type)).length, 0)
    f.controller.markStale()
    assert.equal(one(f.render(), node => node.props['data-bp-team-stage']).props['data-bp-team-observation'], 'stale')
  }
})

test('W3 C-09: ordinary conversation renders no TeamStage section', async () => {
  const f = fixture()
  await f.controller.refresh()
  assert.equal(all(f.render(), node => node.props['data-bp-team-stage']).length, 0)
})

test('readonly view provides collector identities, real focus set, native inspectCall and both locales without a composer or close seat', async () => {
  for (const dict of [zh, en]) {
    const f = fixture(dict)
    await f.controller.refresh()
    const tree = f.render(),
      flow = one(tree, node => node.type === 'flow')
    f.attach(tree)
    assert.equal(tree.props['data-bp-conversation'], 'root')
    assert.equal(tree.props['data-bp-session'], 'source')
    assert.equal(tree.props['data-bp-run-id'], 'r1')
    assert.equal(tree.props['data-bp-frozen-revision'], 'frozen')
    assert.equal(all(tree, node => ['input', 'textarea', 'form'].includes(node.type)).length, 0)
    assert.deepEqual(
      all(tree, node => node.props['data-bp-attempt-id']).map(node => node.props['data-bp-attempt-id']),
      ['a1', 'a2']
    )
    assert.deepEqual(flow.props.fitViewOptions.nodes, [{ id: 'n1' }, { id: 'n2' }, { id: 'source' }, { id: 'bp:frozen-group:g' }])
    assert.equal(flow.props.nodesDraggable, false)
    assert.equal(flow.props.nodesConnectable, false)
    assert.equal(flow.props.edgesReconnectable, false)
    assert.equal(flow.props.deleteKeyCode, null)
    const toolbar = one(tree, node => node.type === 'header')
    assert.deepEqual(
      all(toolbar, node => node.type === 'button').map(node => node.props['aria-label']),
      ['conversation.refresh', 'conversation.focus', 'conversation.fit', 'conversation.inspectCall'].map(key => dict[key])
    )
    for (const button of all(toolbar, node => node.type === 'button')) {
      assert.ok(button.props.title)
      assert.equal(all(button, node => node.type === 'svg').length, 1)
    }
    one(toolbar, node => node.props['aria-label'] === dict['conversation.focus']).props.onClick()
    assert.deepEqual(f.fits[0].nodes, [{ id: 'n1' }, { id: 'n2' }])
    one(toolbar, node => node.props['aria-label'] === dict['conversation.fit']).props.onClick()
    assert.deepEqual(f.fits[1].nodes, [{ id: 'n1' }, { id: 'n2' }, { id: 'source' }, { id: 'bp:frozen-group:g' }])
    one(toolbar, node => node.props['aria-label'] === dict['conversation.inspectCall']).props.onClick()
    assert.deepEqual(f.inspections, ['call-1'])
    one(tree, node => node.props['data-bp-attempt-id'] === 'a2').props.onClick()
    assert.equal(f.controller.getSnapshot().selectedAttemptId, 'a2')
    assert.deepEqual(f.fits[2].nodes, [{ id: 'n2' }])
    const group = flow.props.nodes.find(node => node.type === 'frozenGroup')
    const groupTree = flow.props.nodeTypes.frozenGroup({ data: group.data })
    assert.equal(groupTree.props['data-bp-group'], 'g')
    assert.equal(groupTree.props['aria-label'], translate(dict)('group.ariaLabel', { label: '原始分组' }))
    assert.equal(all(groupTree, node => node.type === 'button').length, 0, 'readonly group has no resize, delete or ungroup action')
  }
})

test('member reasoning appears as read-only thinking activity and stale observations cannot look live', async () => {
  const f = fixture(zh)
  const value = data()
  value.selected.run.team = {
    schemaVersion: 1,
    stageId: 'n1',
    runId: 'r1',
    teamId: 'team',
    leadSessionId: 'source',
    attemptId: 'a1',
    taskSpecificationFingerprint: 'a'.repeat(64),
    state: 'active',
    updatedAt: 1,
    members: [{ memberId: 'member', name: 'producer', phase: 'active', status: 'running', sessionId: 'child' }],
    runtime: {
      attemptId: 'a1',
      observedAt: 10,
      members: [
        {
          memberId: 'member',
          sessionId: 'child',
          activity: 'thinking',
          updatedAt: 9,
          requestOrdinal: 1,
          requestStartedAt: 2,
          lastProgressAt: 9,
          textDeltas: 0,
          reasoningDeltas: 3,
          toolCallDeltas: 0
        }
      ]
    }
  }
  f.setResponse(value)
  await f.controller.refresh()
  const tree = f.render()
  const row = one(tree, node => node.props['data-bp-member-id'] === 'member')
  assert.equal(row.props['data-bp-activity'], 'thinking')
  assert.ok(JSON.stringify(row.children).includes('思考中'))
  assert.equal(all(row, node => node.type === 'button').length, 0, 'activity display issues no native mutation')
  f.controller.markStale()
  const stale = one(f.render(), node => node.props['data-bp-member-id'] === 'member')
  assert.equal(stale.props['data-bp-activity'], 'unavailable')
  assert.ok(JSON.stringify(stale.children).includes('活动状态不可用'))
})

test('poll updates keep viewport identity and issue no fit; explicit historical selection changes the frozen view once', async () => {
  const f = fixture()
  await f.controller.refresh()
  const initial = f.render(),
    flow = one(initial, node => node.type === 'flow')
  f.attach(initial)
  f.setResponse(data('r1', 2))
  await f.controller.poll()
  const next = one(f.render(), node => node.type === 'flow')
  assert.equal(next.props.key, flow.props.key)
  assert.deepEqual(f.fits, [], 'render/polling must not imperatively recenter')
  f.setResponse(args => data(args.runId ?? 'r1', 3))
  one(f.render(), node => node.type === 'select').props.onChange({ currentTarget: { value: 'r0' } })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.controller.getSnapshot().value.selected.run.runId, 'r0')
  const history = one(f.render(), node => node.type === 'flow')
  assert.notEqual(history.props.key, flow.props.key)
  await f.controller.poll()
  assert.equal(one(f.render(), node => node.type === 'flow').props.key, history.props.key)
  assert.equal(f.reads.at(-1).runId, 'r0')
  assert.deepEqual(f.fits, [])
})

test('clicking a node with several canonical Attempts does not guess a latest identity; explicit list choice remains available', async () => {
  const f = fixture(),
    source = data()
  source.selected.run.attempts.push({ nodeId: 'n1', attemptId: 'a3', attempt: 1, state: 'failed' })
  f.setResponse(source)
  await f.controller.refresh()
  const tree = f.render(),
    flow = one(tree, node => node.type === 'flow')
  flow.props.onNodeClick(
    {},
    flow.props.nodes.find(node => node.id === 'n1')
  )
  assert.equal(f.controller.getSnapshot().selectedAttemptId, null)
  one(tree, node => node.props['data-bp-attempt-id'] === 'a3').props.onClick()
  assert.equal(f.controller.getSnapshot().selectedAttemptId, 'a3')
})

test('raw state is rendered verbatim, future/ambiguous/terminal/offline states stop pulse and unavailable native inspection stays disabled', async () => {
  const f = fixture(),
    source = data()
  source.selected.run.attempts[0].state = 'future_state'
  f.setResponse(source)
  await f.controller.refresh()
  let tree = f.render(),
    flow = one(tree, node => node.type === 'flow')
  const renderedNode = node => flow.props.nodeTypes.frozen({ data: node.data, selected: false })
  let node = flow.props.nodes.find(node => node.id === 'n1')
  let dom = renderedNode(node)
  assert.equal(dom.props['data-bp-raw-state'], 'future_state')
  assert.equal(dom.props['data-bp-state'], 'unknown')
  assert.equal(dom.props['data-bp-motion'], 'static')
  f.controller.markStale()
  tree = f.render()
  flow = one(tree, n => n.type === 'flow')
  assert.equal(
    flow.props.nodes.filter(node => node.type === 'frozen').every(node => renderedNode(node).props['data-bp-motion'] === 'static'),
    true
  )
  f.props.inspectCall = undefined
  assert.equal(one(f.render(), node => node.props['aria-label'] === en['conversation.inspectCall']).props.disabled, true)
  f.props.sessionId = 'another-session'
  assert.equal(all(f.render(), node => node.type === 'flow').length, 0, 'render guard never shows old Session before effect')
})

test('observation mount/cleanup reads only and releases polling/listeners without touching owner draft or pendingInteraction', async t => {
  const f = fixture(),
    events = new Map(),
    timers = new Map()
  const globals = ['document', 'setInterval', 'clearInterval', 'addEventListener', 'removeEventListener']
  const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const owner = { draft: '原生 draft', pendingInteraction: { id: 'native-interaction', sessionId: 'source' } }
  const before = structuredClone(owner)
  f.props.nativeOwner = owner
  globalThis.document = {
    visibilityState: 'visible',
    getElementById: () => ({}),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name)
  }
  globalThis.addEventListener = (name, fn) => events.set(name, fn)
  globalThis.removeEventListener = name => events.delete(name)
  globalThis.setInterval = fn => {
    const id = timers.size + 1
    timers.set(id, fn)
    return id
  }
  globalThis.clearInterval = id => timers.delete(id)
  f.render()
  f.effects()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.reads.length, 1)
  assert.equal(timers.size, 1)
  events.get('offline')()
  assert.equal(f.controller.getSnapshot().connection, 'stale')
  f.cleanup()
  assert.equal(timers.size, 0)
  assert.equal(events.size, 0)
  await f.controller.refresh()
  assert.equal(f.reads.length, 1)
  assert.deepEqual(owner, before, 'consumer does not write native draft or interaction; mounted DSH retention remains a live gate')
})

test('unbound has no synthetic nodes; unavailable reads retain an explicit refresh action', async () => {
  const f = fixture()
  f.setResponse({ status: 'unbound', sessionId: 'source' })
  await f.controller.refresh()
  const tree = f.render()
  assert.equal(all(tree, node => node.type === 'flow').length, 0)
  assert.equal(tree.props['data-bp-run-id'], '')
  assert.equal(one(tree, node => node.type === 'select').props.disabled, true)
  f.setResponse(() => {
    throw new Error('raw-provider-error')
  })
  await f.controller.refresh()
  assert.equal(one(f.render(), node => node.props.role === 'status').children[0], en['conversation.unavailable'])
  assert.equal(one(f.render(), node => node.props['aria-label'] === en['conversation.refresh']).props.disabled, false)
})

test('ordinary conversation empty state is neutral in both locales before and after a normal tab remount', async () => {
  for (const [dict, expected] of [
    [zh, '当前对话未关联蓝图，暂无实时蓝图可显示。'],
    [en, 'This conversation has no linked blueprint. No live blueprint is available to display.']
  ]) {
    const f = fixture(dict)
    f.setResponse({ status: 'unbound', sessionId: 'source' })
    await f.controller.refresh()
    for (const remount of [false, true]) {
      if (remount) {
        f.controller.pause()
        f.controller.resume()
      }
      const tree = f.render()
      assert.equal(tree.props['data-bp-connection'], 'connected')
      assert.equal(one(tree, node => node.props.className === 'bp-conversation-empty').children[0], expected)
      assert.equal(one(tree, node => node.props.role === 'status').children[0], dict['conversation.unbound'])
      assert.equal(all(tree, node => node.type === 'flow').length, 0)
    }
  }
})

test('new session render hides previous session failure until its own read settles', async () => {
  const f = fixture()
  f.setResponse(() => {
    throw new Error('old transport failure')
  })
  await f.controller.refresh()
  f.props.sessionId = 'new-ordinary'
  const pending = f.render()
  assert.equal(pending.props['data-bp-connection'], 'loading')
  assert.equal(one(pending, node => node.props.role === 'status').children[0], en['conversation.loading'])
  assert.equal(one(pending, node => node.props.className === 'bp-conversation-empty').children[0], en['conversation.loading'])
  f.controller.setSession('new-ordinary')
  f.setResponse({ status: 'unbound', sessionId: 'new-ordinary' })
  await f.controller.refresh()
  assert.equal(one(f.render(), node => node.props.role === 'status').children[0], en['conversation.unbound'])
})

test('a real failure after an empty read displays loading failure instead of successful empty copy', async () => {
  for (const dict of [zh, en]) {
    const f = fixture(dict)
    f.setResponse({ status: 'unbound', sessionId: 'source' })
    await f.controller.refresh()
    f.setResponse(() => {
      throw new Error('PRIVATE_ERROR_SENTINEL')
    })
    await f.controller.refresh()
    const tree = f.render()
    assert.equal(tree.props['data-bp-connection'], 'unavailable')
    assert.equal(one(tree, node => node.props.className === 'bp-conversation-empty').children[0], dict['conversation.unavailable'])
    assert.equal(one(tree, node => node.props.role === 'status').children[0], dict['conversation.unavailable'])
    assert.equal(JSON.stringify(tree).includes('PRIVATE_ERROR_SENTINEL'), false)
    f.setResponse({ status: 'unbound', sessionId: 'source' })
    await f.controller.refresh()
    assert.equal(one(f.render(), node => node.props.className === 'bp-conversation-empty').children[0], dict['conversation.unboundHelp'])
  }
})

test('bound read failures retain the same frozen graph and stop its live activity', async () => {
  const f = fixture()
  await f.controller.refresh()
  const previous = f.controller.getSnapshot().value
  f.setResponse(() => {
    throw new Error('PRIVATE_ERROR_SENTINEL')
  })
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().value, previous)
  const tree = f.render(),
    flow = one(tree, node => node.type === 'flow')
  assert.equal(tree.props['data-bp-connection'], 'stale')
  assert.equal(tree.props['data-bp-run-id'], previous.selected.run.runId)
  assert.equal(tree.props['data-bp-frozen-revision'], previous.selected.run.definitionRevision)
  assert.ok(flow.props.nodes.every(node => node.data.motion !== 'pulse'))
  assert.equal(all(tree, node => node.props.className === 'bp-conversation-empty').length, 0)
  assert.equal(JSON.stringify(tree).includes('PRIVATE_ERROR_SENTINEL'), false)
})

test('bound empty graphs keep an empty initial fit while explicit focus remains attempt-scoped', async () => {
  const f = fixture(),
    empty = data()
  empty.selected.graph = { nodes: [], edges: [] }
  empty.selected.presentation = { nodes: {}, groups: [] }
  empty.selected.run.attempts = []
  empty.selected.focusAttemptIds = []
  f.setResponse(empty)
  await f.controller.refresh()
  const tree = f.render(),
    flow = one(tree, node => node.type === 'flow')
  assert.deepEqual(flow.props.fitViewOptions.nodes, [])
  assert.equal(one(tree, node => node.props['aria-label'] === en['conversation.focus']).props.disabled, true)

  f.setResponse(data())
  await f.controller.refresh()
  const populated = f.render()
  f.attach(populated)
  one(populated, node => node.props['aria-label'] === en['conversation.focus']).props.onClick()
  assert.deepEqual(f.fits.at(-1).nodes, [{ id: 'n1' }, { id: 'n2' }])
})

test('legal humanDecision without branches renders every frozen approve/reject/control handle and preserves dotted Chinese data ports', async () => {
  const f = fixture(),
    frozen = data()
  frozen.selected.graph = {
    nodes: [
      { id: 'review', kind: 'humanDecision' },
      { id: 'approved', kind: 'output', inputs: { '用户.结果': 'json' } },
      { id: 'rejected', kind: 'output', outputs: { '中文.port': 'json' } }
    ],
    edges: [
      { kind: 'control', from: 'review@approve', to: 'approved' },
      { kind: 'control', from: 'review@reject', to: 'rejected' },
      { kind: 'control', from: 'review', to: 'approved' },
      { kind: 'data', from: 'rejected.中文.port', to: 'approved.用户.结果' }
    ]
  }
  frozen.selected.presentation = { nodes: {} }
  frozen.selected.run.attempts = []
  frozen.selected.focusAttemptIds = []
  f.setResponse(frozen)
  await f.controller.refresh()
  const flow = one(f.render(), node => node.type === 'flow')
  const rendered = new Map(flow.props.nodes.map(node => [node.id, flow.props.nodeTypes.frozen({ data: node.data, selected: false })]))
  for (const edge of flow.props.edges) {
    assert.equal(
      all(rendered.get(edge.source), node => node.type === 'handle' && node.props.id === edge.sourceHandle && node.props.type === 'source').length,
      1,
      `FROZEN_SOURCE_HANDLE_MISSING:${edge.source}:${edge.sourceHandle}`
    )
    assert.equal(
      all(rendered.get(edge.target), node => node.type === 'handle' && node.props.id === edge.targetHandle && node.props.type === 'target').length,
      1,
      `FROZEN_TARGET_HANDLE_MISSING:${edge.target}:${edge.targetHandle}`
    )
  }
  assert.deepEqual(
    all(rendered.get('review'), node => node.type === 'handle' && node.props.type === 'source').map(node => node.props.id),
    ['control:control', 'control:approve', 'control:reject']
  )
  assert.equal(
    flow.props.nodes.every(node => !node.connectable && !node.draggable),
    true
  )
})
