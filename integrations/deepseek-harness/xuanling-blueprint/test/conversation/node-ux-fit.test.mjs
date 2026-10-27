import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { ConversationController } from '../../src/client/features/conversation/logic/conversation-controller.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
const key = Symbol.for('blueprint.test.frozen.fit')
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
        url: url("export default globalThis[Symbol.for('blueprint.test.frozen.fit')].react"),
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
let View
try {
  ;({ ConversationBlueprintView: View } = await import(`${client}features/conversation/ui/conversation-view.tsx`))
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
test('initial frozen Fit waits for measurements, includes group IDs and permits tiny zoom', async () => {
  const f = await fixture()
  f.raw.value.selected.presentation.groups = [{ id: 'g', nodeIds: ['a'] }]
  await f.controller.refresh()
  const tree = f.render(),
    flow = all(tree, n => n.type === 'flow')[0],
    root = all(tree, n => n.props['data-bp-conversation'] === 'root')[0]
  assert.equal(flow.props.fitView, false, 'automatic pre-measurement fit must be disabled')
  assert.ok(flow.props.minZoom <= 0.001, 'large complete graph needs zoom below old .15 clamp')
  assert.equal(root.props['data-bp-layout-ready'], 'false', 'mount cannot announce completed initial measured fit')
  assert.deepEqual(
    flow.props.fitViewOptions.nodes.map(node => node.id),
    ['a', 'bp:frozen-group:g'],
    'Fit targets include the group header, not only graph nodes'
  )
})

test('frozen Fit consumes complete rendered content and does not refit on poll', async () => {
  const f = await fixture()
  f.raw.value.selected.presentation.groups = [{ id: 'g', nodeIds: ['a'] }]
  await f.controller.refresh()
  const render = () => {
    const tree = f.render()
    return {
      tree,
      flow: all(tree, n => n.type === 'flow')[0],
      root: all(tree, n => n.props['data-bp-conversation'] === 'root')[0]
    }
  }
  let current = render(),
    node = current.flow.props.nodes.find(node => node.id === 'a')
  const frozen = current.flow.props.nodeTypes.frozen({ data: node.data, selected: false })
  assert.ok(all(frozen, n => n.props['data-bp-node-content'] === 'a').length, 'production renderer exposes a measurable content wrapper')
  assert.equal(all(frozen, n => n.props['data-bp-node-member']).length, 0)
  assert.equal(all(frozen, n => n.type === 'handle').length, 6, 'all five inputs and output remain in the DOM')
  node.data.onContentMeasure(300)
  current = render()
  assert.equal(current.root.props['data-bp-layout-ready'], 'false', 'content measurement alone cannot unlock Fit before XYFlow dimensions')
  current.flow.props.onNodesChange([
    { type: 'dimensions', id: 'a', dimensions: { width: 220, height: 300 } },
    { type: 'dimensions', id: 'bp:frozen-group:g', dimensions: { width: 268, height: 392 } }
  ])
  current = render()
  assert.equal(current.root.props['data-bp-layout-ready'], 'true', 'layout becomes ready only after content and XYFlow dimensions')
  const calls = []
  current.flow.props.onInit({
    fitView: options => {
      calls.push(options)
      return Promise.resolve(true)
    }
  })
  const fitEffect = seat.active.effects.find(effect => effect.pending && effect.deps.includes(true))
  if (fitEffect) {
    fitEffect.callback()
    fitEffect.pending = false
  }
  await f.controller.refresh()
  current = render()
  const secondFitEffect = seat.active.effects.find(effect => effect.pending && effect.deps.includes(true))
  secondFitEffect?.callback()
  assert.equal(calls.length, 1, 'same Run poll does not move the user viewport or fit again')
})

test('frozen Fit refuses a partial XYFlow graph when an internal node is missing', async () => {
  const f = await fixture()
  f.raw.value.selected.presentation.groups = [{ id: 'g', nodeIds: ['a'] }]
  await f.controller.refresh()
  const render = () => {
    const tree = f.render()
    return { tree, flow: all(tree, n => n.type === 'flow')[0] }
  }
  let current = render(),
    node = current.flow.props.nodes.find(node => node.id === 'a')
  node.data.onContentMeasure(300)
  current = render()
  current.flow.props.onNodesChange([
    { type: 'dimensions', id: 'a', dimensions: { width: 220, height: 300 } },
    { type: 'dimensions', id: 'bp:frozen-group:g', dimensions: { width: 268, height: 392 } }
  ])
  current = render()
  const calls = []
  current.flow.props.onInit({
    fitView: options => {
      calls.push(options)
      return Promise.resolve(true)
    },
    getInternalNode: () => undefined
  })
  const fitEffect = seat.active.effects.find(effect => effect.pending && effect.deps.includes(true))
  if (fitEffect) {
    fitEffect.callback()
    fitEffect.pending = false
  }
  assert.equal(calls.length, 0, 'missing internal nodes must keep automatic Fit locked')
})
