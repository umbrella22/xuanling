import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { ConversationController } from '../../src/client/features/conversation/logic/conversation-controller.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
const key = Symbol.for('blueprint.test.frozen.collisions')
const seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useMemo(factory) {
    return factory()
  },
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
        url: url("export default globalThis[Symbol.for('blueprint.test.frozen.collisions')].react"),
        shortCircuit: true
      }
    if (context.parentURL?.startsWith(`${client}features/conversation/`) && spec === '@xyflow/react')
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
  ;({ ConversationBlueprintView: View } = await import(`${client}features/conversation/ui/conversation-view.tsx`))
  ;({ projectFrozenCanvas } = await import(`${client}features/conversation/ui/conversation-canvas.ts`))
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

test('actual frozen projection separates bodies and shared/intersect/nested headers without canonical writes', () => {
  const raw = snapshot()
  raw.value.selected.graph.nodes = ['a', 'b', 'c'].map(id => ({
    id,
    kind: 'input',
    outputs: { value: 'string' }
  }))
  raw.value.selected.presentation = {
    nodes: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 } },
    groups: [
      { id: 'left', nodeIds: ['a', 'b'] },
      { id: 'right', nodeIds: ['a', 'c'] },
      { id: 'outer', nodeIds: ['a', 'b', 'c'] }
    ]
  }
  const before = structuredClone(raw)
  const p = projectFrozenCanvas(raw, false, true),
    again = projectFrozenCanvas(raw, false, true),
    overlap = (a, b) =>
      Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.01 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.01
  const nodes = p.nodes.map(n => ({
    ...n.position,
    width: Number(n.style.width),
    height: Number(n.style.minHeight)
  }))
  for (let i = 0; i < nodes.length; i++) for (const b of nodes.slice(i + 1)) assert.equal(overlap(nodes[i], b), false)
  const headers = p.groups.map(n => ({
    ...n.position,
    width: Number(n.style.width),
    height: 44
  }))
  for (let i = 0; i < headers.length; i++) {
    for (const b of headers.slice(i + 1)) assert.equal(overlap(headers[i], b), false)
    for (const n of nodes) assert.equal(overlap(headers[i], n), false)
  }
  assert.deepEqual(p, again)
  assert.deepEqual(raw, before)
  assert.equal(p.nodes.filter(n => n.id === 'a').length, 1)
})
test('registered frozen renderer consumes collision projection without writable node handles', async () => {
  const f = await fixture(),
    flow = all(f.render(), n => n.type === 'flow')[0]
  assert.ok(flow)
  const n = flow.props.nodes.find(n => n.id === 'a'),
    body = flow.props.nodeTypes.frozen({ data: n.data, selected: false })
  assert.equal(body.props['data-bp-node'], 'a')
  assert.ok(all(body, e => e.type === 'handle').every(h => h.props.isConnectable === false))
  assert.equal(n.draggable, false)
  assert.equal(n.connectable, false)
})
import { avoidGroupHeaders } from '../../src/client/features/authoring/logic/graph/layout-collisions.ts'
test('group header projection is permutation stable and outer title precedes nested title', () => {
  const frames = [
    { id: 'z', groupId: 'z', nodeIds: ['a'], x: 0, y: 0, width: 400, height: 400 },
    { id: 'a', groupId: 'a', nodeIds: ['a', 'b'], x: 0, y: 0, width: 400, height: 400 },
    { id: 'm', groupId: 'm', nodeIds: ['c'], x: 0, y: 0, width: 400, height: 400 }
  ]
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ]
  let oracle
  for (const order of permutations) {
    const result = avoidGroupHeaders(
      order.map(i => frames[i]),
      []
    )
    const positions = Object.fromEntries(result.map(f => [f.id, { x: f.x, y: f.y }]))
    if (!oracle) oracle = positions
    else assert.deepEqual(positions, oracle, 'ordering must not depend on input array permutation')
    assert.ok(positions.a.y < positions.z.y, 'containing group title must be above child title')
  }
})
