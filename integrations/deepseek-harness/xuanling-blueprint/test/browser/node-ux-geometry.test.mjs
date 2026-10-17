import assert from 'node:assert/strict'
import test from 'node:test'
import { en } from '../../src/client/shared/i18n/locales.ts'
const t = (k, p = {}) => {
  assert.ok(Object.hasOwn(en, k))
  return en[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]))
}
import { registerHooks } from 'node:module'
const key = Symbol.for('blueprint.test.geometry'),
  seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.length ? children : [props?.children] }),
  memo: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState(initial) {
    const f = seat.active,
      i = f.cursor++
    if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      update => {
        f.states[i] = typeof update === 'function' ? update(f.states[i]) : update
      }
    ]
  },
  useRef(initial) {
    const f = seat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useMemo(factory, deps) {
    const f = seat.active,
      i = f.memoCursor++,
      last = f.memos[i]
    if (!last || deps.some((v, j) => !Object.is(v, last.deps[j]))) f.memos[i] = { deps, value: factory() }
    return f.memos[i].value
  },
  useCallback: fn => fn,
  useEffect(effect) {
    if (seat.runBridgeEffect) seat.active.bridgeCleanup = effect()
  }
}
const url = code => `data:text/javascript,${encodeURIComponent(code)}`
const reactUrl = url(
  `export default globalThis[Symbol.for('blueprint.test.geometry')].react; export const createElement=globalThis[Symbol.for('blueprint.test.geometry')].react.createElement;`
)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.geometry')].active.flowApi;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
// Inspector is a frozen opaque boundary here, not a fake editor implementation.
const inspector = url('export function NodeInspector(){}')
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.startsWith(client) && spec === 'react') return { url: reactUrl, shortCircuit: true }
    if (
      (context.parentURL === `${client}features/authoring/ui/panel/panel-composition.tsx` ||
        context.parentURL === `${client}features/authoring/ui/panel/panel-controller.tsx` ||
        context.parentURL === `${client}features/authoring/ui/canvas/canvas-surface.tsx` ||
        context.parentURL === `${client}features/authoring/ui/canvas/canvas-renderers.tsx`) &&
      spec === '@xyflow/react'
    )
      return { url: flow, shortCircuit: true }
    if (
      (context.parentURL === `${client}features/authoring/ui/panel/panel-composition.tsx` ||
        context.parentURL === `${client}features/authoring/ui/panel/panel-controller.tsx`) &&
      spec === '../inspector/inspector-composition.tsx'
    )
      return { url: inspector, shortCircuit: true }
    return next(spec, context)
  }
})
let createBlueprintPanel
try {
  ;({ createBlueprintPanel } = await import(`${client}features/authoring/ui/panel/panel-composition.tsx`))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})

const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]

// Render the real root and child with independent React hook owners. The local
// Flow bridge commits its API before callbacks run, as it does after mounting.
function panelRenderer(Panel, f, t) {
  const owner = { states: [], refs: [], memos: [], cursor: 0, refCursor: 0, memoCursor: 0 }
  f.flowApi = f.flow
  return () => {
    seat.active = owner
    owner.cursor = owner.refCursor = owner.memoCursor = 0
    const entry = Panel({ t })
    f.workspace = entry.props.workspace
    assert.equal(f.workspace, owner.states[0])
    assert.equal(entry.props.workspaceSnapshot, f.workspace.getSnapshot())
    seat.active = f
    f.cursor = f.refCursor = f.memoCursor = 0
    let tree = entry.type(entry.props)
    const provider = all(tree, n => n.type === 'provider')[0]
    assert.ok(provider)
    if (f.providerKey !== provider.props.key) {
      f.bridgeCleanup?.()
      const bridge = all(provider, n => typeof n.type === 'function' && typeof n.props.onReady === 'function')[0]
      assert.ok(bridge)
      seat.runBridgeEffect = true
      try {
        bridge.type(bridge.props)
      } finally {
        seat.runBridgeEffect = false
      }
      f.providerKey = provider.props.key
      f.cursor = f.refCursor = f.memoCursor = 0
      tree = entry.type(entry.props)
    }
    return tree
  }
}

async function fixture() {
  const d = {
    schemaVersion: 1,
    id: 'Geometry',
    name: 'Synthetic',
    resources: { Agent: { kind: 'agent', source: { kind: 'host', id: 'literal-agent' } } },
    graph: {
      nodes: [
        {
          id: 'a',
          kind: 'agentTask',
          agentRef: 'Agent',
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
          title: 'Long anonymous title requiring measured content dimensions'
        }
      },
      groups: [{ id: 'g', nodeIds: ['a'] }]
    }
  }
  const doc = {
    blueprintId: d.id,
    definitionJson: JSON.stringify(d),
    documentRevision: 'doc',
    semanticRevision: 'semantic',
    layoutRevision: 'layout'
  }
  const host = {
    async listDefinitions() {
      return {
        definitions: [
          {
            blueprintId: d.id,
            name: d.name,
            documentRevision: 'doc',
            semanticRevision: 'semantic'
          }
        ]
      }
    },
    async loadDefinition() {
      return doc
    },
    async validate() {
      return { ok: true }
    }
  }
  const f = {
    states: [],
    refs: [],
    memos: [],
    cursor: 0,
    refCursor: 0,
    memoCursor: 0,
    flow: { getNodes: () => [], fitView: async () => true, screenToFlowPosition: p => p }
  }
  const Panel = createBlueprintPanel({
    hostLink: host,
    storage: { getItem: () => null, setItem() {} }
  })
  f.render = panelRenderer(Panel, f, t)
  f.render()
  assert.ok(f.workspace)
  await f.workspace.initialize()
  await f.workspace.load(d.id)
  f.flowNode = () => all(f.render(), n => n.type === 'flow')[0]
  return f
}
test('real editor short saved height grows for title/summary and five port rows without canonical writes', async () => {
  const f = await fixture(),
    before = f.workspace.editor.exportDefinition(),
    node = f.flowNode().props.nodes.find(n => n.id === 'a')
  assert.equal(node.style.height, undefined)
  assert.ok(node.style.minHeight > 80)
  const body = f.flowNode().props.nodeTypes.blueprint({ id: node.id, data: node.data, selected: false })
  assert.ok(all(body, n => n.props.className === 'bp-node-title').length)
  assert.ok(all(body, n => n.props.className === 'bp-node-summary').length)
  assert.equal(all(body, n => n.type === 'handle').length, 6)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  f.workspace.editor.patchPresentation(['a'], { ports: { inputs: false } })
  const hidden = f.flowNode().props.nodes.find(n => n.id === 'a')
  assert.ok(hidden.data.minHeight < node.data.minHeight)
  const rendered = f.flowNode().props.nodeTypes.blueprint({ id: 'a', data: hidden.data, selected: false })
  assert.equal(all(rendered, n => n.type === 'handle').length, 1)
})
test('real editor measured content has priority and invalidates after width/content changes', async () => {
  const f = await fixture(),
    before = f.workspace.editor.exportDefinition()
  f.flowNode().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 360, height: 520 } }])
  let n = f.flowNode().props.nodes.find(n => n.id === 'a')
  assert.deepEqual(n.measured, { width: 360, height: 520 })
  const group = f.flowNode().props.nodes.find(n => n.type === 'presentationGroup')
  assert.ok(group.style.height >= 520)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  f.workspace.editor.patchPresentation(['a'], { width: 420 })
  n = f.flowNode().props.nodes.find(n => n.id === 'a')
  assert.equal(n.measured, undefined, 'old width measurement must not survive changed authored width')
  f.flowNode().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 420, height: 620 } }])
  n = f.flowNode().props.nodes.find(n => n.id === 'a')
  assert.deepEqual(n.measured, { width: 420, height: 620 })
  f.workspace.editor.patchPresentation(['a'], { ports: { inputs: false } })
  assert.equal(f.flowNode().props.nodes.find(n => n.id === 'a').measured, undefined, 'hidden rows invalidate old measured shape')
})
test('real Panel resize preview preserves hidden port, color and collapse presentation', async () => {
  const f = await fixture(),
    editor = f.workspace.editor
  editor.patchPresentation(['a'], { ports: { inputs: false }, color: 'purple', collapsed: true })
  const before = editor.exportDefinition(),
    n = f.flowNode().props.nodes.find(n => n.id === 'a')
  n.data.onResizeStart()
  n.data.onResize({ width: 420, height: 500, x: 0, y: 0 })
  const flow = f.flowNode(),
    preview = flow.props.nodes.find(n => n.id === 'a')
  assert.equal(preview.data.presentation.ports.inputs, false)
  assert.equal(preview.data.presentation.color, 'purple')
  assert.equal(preview.data.presentation.collapsed, true)
  const body = flow.props.nodeTypes.blueprint({ id: 'a', data: preview.data, selected: true })
  assert.equal(body.props['data-bp-color'], 'purple')
  assert.equal(body.props['data-bp-collapsed'], 'true')
  assert.equal(all(body, n => n.type === 'handle' && n.props.type === 'target').length, 0)
  assert.deepEqual(editor.exportDefinition(), before, 'preview must remain derived')
})
test('actual Panel natural-content callback refills invalidated same-size measurement', async () => {
  const f = await fixture(),
    flow = () => f.flowNode(),
    node = () => flow().props.nodes.find(n => n.id === 'a')
  assert.equal(typeof node().data.onContentMeasure, 'function')
  node().data.onContentMeasure(700)
  assert.ok(node().measured.height >= 700)
  f.workspace.editor.patchPresentation(['a'], {
    title: 'Different anonymous title, identical observed size'
  })
  assert.equal(node().measured, undefined)
  node().data.onContentMeasure(700)
  assert.ok(node().measured.height >= 700, 'same size after shape invalidation must refill parent cache')
})
