import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { ConversationController } from '../../src/client/conversation-controller.ts'
import { en } from '../../src/client/locales.ts'
const key = Symbol.for('blueprint.test.frozen.geometry')
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
        f.states[i] = typeof value === 'function' ? value(f.states[i]) : value
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
    if (context.parentURL?.startsWith(client) && spec === 'react')
      return {
        url: url("export default globalThis[Symbol.for('blueprint.test.frozen.geometry')].react"),
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
let View, projectFrozenCanvas
try {
  ;({ ConversationBlueprintView: View } = await import(`${client}conversation-view.ts`))
  ;({ projectFrozenCanvas } = await import(`${client}conversation-canvas.ts`))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})

const all = (tree, p) =>
  !tree || typeof tree !== 'object' ? [] : [...(p(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(c => all(c, p))]
const t = (k, p = {}) => {
  assert.ok(Object.hasOwn(en, k), k)
  return en[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]))
}
function snapshot() {
  return {
    connection: 'connected',
    value: {
      status: 'bound',
      sessionId: 'source',
      runs: [{ runId: 'run', state: 'succeeded', createdAt: 1, definitionRevision: 'frozen' }],
      selected: {
        run: {
          runId: 'run',
          state: 'succeeded',
          seq: 1,
          definitionRevision: 'frozen',
          attempts: [],
          logTail: []
        },
        graph: {
          nodes: [
            {
              id: 'a',
              kind: 'agentTask',
              inputs: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(n => [n, 'string'])),
              outputs: { value: 'string' }
            }
          ],
          edges: []
        },
        presentation: {
          nodes: {
            a: {
              x: 0,
              y: 0,
              width: 220,
              height: 80,
              title: 'Long anonymous frozen title with five independent inputs'
            }
          }
        },
        focusAttemptIds: []
      }
    }
  }
}
async function fixture() {
  const raw = snapshot(),
    controller = new ConversationController(
      {
        async inspectSession() {
          return raw.value
        }
      },
      'source'
    )
  await controller.refresh()
  const state = {
    states: [],
    refs: [],
    effects: [],
    stateCursor: 0,
    refCursor: 0,
    effectCursor: 0
  }
  return {
    raw,
    controller,
    render() {
      seat.active = state
      state.stateCursor = state.refCursor = state.effectCursor = 0
      return View({ controller, sessionId: 'source', t })
    }
  }
}
test('real frozen projection short saved height accounts for complete visible content', () => {
  const raw = snapshot(),
    before = structuredClone(raw),
    p = projectFrozenCanvas(raw, false, true),
    node = p.nodes[0]
  assert.equal(node.style.height, undefined, 'saved height cannot impose fixed outer cap')
  assert.ok(node.style.minHeight > 80)
  assert.equal(raw.value.selected.presentation.nodes.a.height, 80)
  assert.deepEqual(raw, before)
  raw.value.selected.presentation.nodes.a.ports = { inputs: false }
  const hidden = projectFrozenCanvas(raw, false, true).nodes[0]
  assert.ok(hidden.style.minHeight < node.style.minHeight, 'removing input side removes its rows only')
})
test('registered frozen renderer includes member activity in content measurement without DTO writes', async () => {
  const f = await fixture(),
    before = structuredClone(f.raw),
    flow = all(f.render(), n => n.type === 'flow')[0]
  assert.ok(flow)
  const node = flow.props.nodes.find(n => n.id === 'a')
  const Frozen = flow.props.nodeTypes.frozen
  const plain = Frozen({ data: node.data, selected: false })
  seat.active.stateCursor = seat.active.refCursor = seat.active.effectCursor = 0
  const active = Frozen({
    data: {
      ...node.data,
      memberActivities: [
        { memberId: 'one', label: 'Anonymous member one', activity: 'unavailable' },
        { memberId: 'two', label: 'Anonymous member two', activity: 'unavailable' }
      ]
    },
    selected: false
  })
  assert.equal(all(active, n => n.props['data-bp-node-member']).length, 2)
  assert.ok(active.props.style?.minHeight > plain.props.style?.minHeight, 'member rows must raise actual minimum content geometry')
  assert.deepEqual(f.raw, before)
})
test('actual frozen content observer height wins and width key discards stale measurement', async () => {
  const f = await fixture(),
    flow = all(f.render(), n => n.type === 'flow')[0],
    node = flow.props.nodes.find(n => n.id === 'a'),
    Frozen = flow.props.nodeTypes.frozen
  const state = {
    states: [],
    refs: [],
    effects: [],
    stateCursor: 0,
    refCursor: 0,
    effectCursor: 0
  }
  const callbacks = []
  let disconnects = 0
  const prior = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) {
      callbacks.push(callback)
    }
    observe() {}
    disconnect() {
      disconnects++
    }
  }
  const render = data => {
    seat.active = state
    state.stateCursor = state.refCursor = state.effectCursor = 0
    return Frozen({ data, selected: false })
  }
  try {
    let body = render(node.data)
    const wrapper = all(body, n => n.props['data-bp-node-content'] === 'a')[0]
    assert.ok(wrapper)
    wrapper.props.ref.current = { offsetHeight: 1 }
    for (const effect of state.effects)
      if (effect.pending) {
        effect.pending = false
        effect.cleanup = effect.callback()
      }
    assert.equal(callbacks.length, 1)
    callbacks[0]([{ borderBoxSize: [{ blockSize: 630 }] }])
    body = render(node.data)
    assert.equal(body.props.style.minHeight, 630)
    const changed = render({ ...node.data, contentWidth: 420 })
    assert.ok(changed.props.style.minHeight < 630, 'old content height must be unavailable immediately when width changes')
    for (const effect of state.effects)
      if (effect.pending) {
        effect.pending = false
        effect.cleanup = effect.callback()
      }
    assert.ok(disconnects >= 1)
    assert.equal(callbacks.length, 2)
    callbacks[1]([{ borderBoxSize: [{ blockSize: 710 }] }])
    assert.equal(render({ ...node.data, contentWidth: 420 }).props.style.minHeight, 710)
  } finally {
    for (const effect of state.effects) effect.cleanup?.()
    globalThis.ResizeObserver = prior
  }
})

test('actual conversation dimensions update derived group, survive same-shape poll, invalidate width/shape/Run', async () => {
  const f = await fixture()
  f.raw.value.selected.presentation.groups = [{ id: 'g', nodeIds: ['a'] }]
  await f.controller.refresh()
  const flow = () => all(f.render(), n => n.type === 'flow')[0],
    group = () => flow().props.nodes.find(n => n.type === 'frozenGroup')
  const before = structuredClone(f.raw),
    initialHeight = group().style.height
  assert.equal(typeof flow().props.onNodesChange, 'function')
  flow().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 440, height: 700 } }])
  assert.ok(group().style.height >= 700)
  assert.ok(group().style.height > initialHeight)
  assert.ok(group().style.width >= 440)
  assert.deepEqual(f.raw, before, 'measured dimensions never enter frozen DTO')
  await f.controller.refresh()
  assert.ok(group().style.height >= 700, 'poll same shape retains measurement')
  f.raw.value.selected.presentation.nodes.a.width = 460
  await f.controller.refresh()
  assert.ok(group().style.height < 700, 'width changes discard stale content dimensions')
  flow().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 460, height: 720 } }])
  assert.ok(group().style.height >= 720)
  f.raw.value.selected.presentation.nodes.a.ports = { inputs: false }
  await f.controller.refresh()
  assert.ok(group().style.height < 720, 'row shape change discards stale dimensions')
  flow().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 460, height: 740 } }])
  assert.ok(group().style.height >= 740)
  f.raw.value.selected.run.runId = 'next-run'
  f.raw.value.runs = [{ runId: 'next-run', state: 'succeeded', createdAt: 2, definitionRevision: 'frozen' }]
  await f.controller.refresh()
  assert.ok(group().style.height < 740, 'Run identity never reuses earlier dimensions')
})
test('actual frozen natural callback refills same-size shape and retry same display retains geometry', async () => {
  const f = await fixture()
  f.raw.value.selected.presentation.groups = [{ id: 'g', nodeIds: ['a'] }]
  f.raw.value.selected.run.state = 'running'
  f.raw.value.selected.run.attempts = [{ attemptId: 'attempt-one', nodeId: 'a', attempt: 1, state: 'running' }]
  f.raw.value.runs[0].state = 'running'
  await f.controller.refresh()
  const flow = () => all(f.render(), n => n.type === 'flow')[0],
    node = () => flow().props.nodes.find(n => n.id === 'a'),
    group = () => flow().props.nodes.find(n => n.type === 'frozenGroup')
  assert.equal(typeof node().data.onContentMeasure, 'function')
  node().data.onContentMeasure(700)
  assert.ok(group().style.height >= 700)
  f.raw.value.selected.presentation.nodes.a.title = 'Different anonymous title with identical observed dimensions'
  await f.controller.refresh()
  assert.ok(group().style.height < 700)
  node().data.onContentMeasure(700)
  assert.ok(group().style.height >= 700, 'same dimensions must refill parent after title key changes')
  f.raw.value.selected.run.seq++
  f.raw.value.selected.run.attempts = [{ attemptId: 'attempt-two', nodeId: 'a', attempt: 2, state: 'running' }]
  await f.controller.refresh()
  assert.ok(group().style.height >= 700, 'retry ordinal/id alone does not change visible content shape')
})
