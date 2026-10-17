import assert from 'node:assert/strict'
import test from 'node:test'
import { en } from '../../src/client/shared/i18n/locales.ts'
const t = (k, p = {}) => {
  assert.ok(Object.hasOwn(en, k))
  return en[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]))
}
import { registerHooks } from 'node:module'
const key = Symbol.for('blueprint.test.collisions'),
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
  `export default globalThis[Symbol.for('blueprint.test.collisions')].react; export const createElement=globalThis[Symbol.for('blueprint.test.collisions')].react.createElement;`
)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.collisions')].active.flowApi;
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

import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { nodeContentMinimum } from '../../src/client/features/authoring/logic/graph/node-geometry.ts'
import { effectivePortVisibility } from '../../src/client/features/authoring/logic/graph/port-visibility.ts'
const assertProjectedSafe = (e, p) => {
  assert.equal(p.ok, true)
  const rects = e.nodes.map(n => ({
    ...p.positions.get(n.id),
    width: Math.max(220, n.presentation?.width ?? 220),
    height: Math.max(180, n.presentation?.height ?? 180)
  }))
  for (let i = 0; i < rects.length; i++) for (const b of rects.slice(i + 1)) assert.equal(overlap(rects[i], b), false)
}
const assertCreatedSafe = (e, oldDisplay) => {
  for (const n of e.nodes.filter(n => !oldDisplay.has(n.id))) {
    const size = nodeContentMinimum({
      title: n.label,
      state: 'idle',
      inputs: n.inputs,
      outputs: n.outputs,
      controlOutputs: n.definition?.branches ?? [],
      visibility: effectivePortVisibility(n, e.edges)
    })
    const body = {
      x: n.x,
      y: n.y,
      width: Math.max(size.width, n.presentation?.width ?? 0),
      height: Math.max(size.height, n.presentation?.height ?? 0)
    }
    for (const position of oldDisplay.values())
      assert.equal(overlap(body, { ...position, width: 220, height: 180 }), false, 'new canonical template must avoid existing actual display obstacles')
  }
}
const measurements = e => new Map(e.nodes.map(n => [n.id, { width: 220, height: 180 }]))
const overlap = (a, b) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.01 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.01
async function fixture(valid = false) {
  const d = {
    schemaVersion: 1,
    id: 'Collision',
    name: 'Synthetic',
    resources: {},
    graph: {
      nodes: ['a', 'b', 'c'].map(id => ({ id, kind: 'input', outputs: { value: 'string' } })),
      edges: []
    },
    presentation: {
      nodes: {
        a: { x: 0, y: 0 },
        b: { x: valid ? 400 : 0, y: 0 },
        c: { x: valid ? 800 : 0, y: 0 }
      },
      groups: [
        { id: 'left', label: 'Left', nodeIds: ['a', 'b'] },
        { id: 'right', label: 'Right', nodeIds: ['a', 'c'] },
        { id: 'nested', label: 'Nested', nodeIds: ['a'] }
      ]
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
  f.editor = f.workspace.editor
  await f.workspace.initialize()
  await f.workspace.load(d.id)
  f.editor = f.workspace.editor
  f.flow = () => all(f.render(), n => n.type === 'flow')[0]
  return f
}
test('actual Panel stable collision projection is read-only and separates node bodies', async () => {
  const f = await fixture(),
    before = f.editor.exportDefinition(),
    nodes = () => f.flow().props.nodes.filter(n => n.type === 'blueprint')
  const first = nodes().map(n => ({
    id: n.id,
    ...n.position,
    width: Number(n.style.width),
    height: Number(n.style.minHeight)
  }))
  for (let i = 0; i < first.length; i++) for (const b of first.slice(i + 1)) assert.equal(overlap(first[i], b), false)
  assert.deepEqual(
    nodes().map(n => n.position),
    first.map(n => ({ x: n.x, y: n.y }))
  )
  assert.deepEqual(f.editor.exportDefinition(), before)
  assert.equal(f.editor.canUndo, false)
})
test('actual Panel shared/nested group title strips do not overlap each other or bodies', async () => {
  const f = await fixture(true),
    flow = f.flow(),
    headers = flow.props.nodes.filter(n => n.type === 'presentationGroup').map(n => ({ ...n.position, width: Number(n.style.width), height: 44 })),
    nodes = flow.props.nodes
      .filter(n => n.type === 'blueprint')
      .map(n => ({
        ...n.position,
        width: Number(n.style.width),
        height: Number(n.style.minHeight)
      }))
  for (let i = 0; i < headers.length; i++) {
    for (const b of headers.slice(i + 1)) assert.equal(overlap(headers[i], b), false)
    for (const n of nodes) assert.equal(overlap(headers[i], n), false)
  }
  assert.equal(flow.props.nodes.filter(n => n.id === 'a').length, 1, 'shared member renders once')
})
test('actual GraphEditor explicit Apply resolves once, keeps manual route bytes and Undo restores canonical', () => {
  const d = {
    schemaVersion: 1,
    id: 'Apply',
    name: 'Synthetic',
    resources: {},
    graph: {
      nodes: [
        { id: 'a', kind: 'input', outputs: { value: 'string' } },
        { id: 'b', kind: 'output', inputs: { value: 'string' } }
      ],
      edges: [{ kind: 'data', from: 'a.value', to: 'b.value' }]
    },
    presentation: {
      nodes: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
      edges: [
        {
          kind: 'data',
          from: 'a.value',
          to: 'b.value',
          points: [
            { x: 11, y: 22 },
            { x: 33, y: 44 }
          ]
        }
      ]
    }
  }
  const e = GraphEditor.fromDefinition(d),
    before = e.exportDefinition(),
    p = e.collisionProjection(measurements(e))
  assert.equal(p.ok, true)
  assert.equal(e.canUndo, false)
  assert.deepEqual(e.exportDefinition(), before)
  e.applyCollisionLayout(measurements(e))
  const applied = e.exportDefinition()
  assert.notDeepEqual(applied.presentation.nodes, before.presentation.nodes)
  assert.deepEqual(applied.presentation.edges, before.presentation.edges)
  assert.deepEqual(applied.graph, before.graph)
  assert.equal(e.undo(), true)
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false)
  assert.equal(e.redo(), true)
  assert.deepEqual(e.exportDefinition(), applied)
})
test('pinned unsolved collision returns typed identities and remains atomic', () => {
  const d = {
    schemaVersion: 1,
    id: 'Pinned',
    name: 'Synthetic',
    resources: {},
    graph: { nodes: ['a', 'b'].map(id => ({ id, kind: 'input' })), edges: [] },
    presentation: { nodes: { a: { x: 0, y: 0, pinned: true }, b: { x: 0, y: 0, pinned: true } } }
  }
  const e = GraphEditor.fromDefinition(d),
    before = e.exportDefinition()
  assert.deepEqual(e.collisionProjection(), {
    ok: false,
    code: 'layout-collision-unresolved',
    nodeIds: ['a', 'b']
  })
  assert.throws(
    () => e.applyCollisionLayout(measurements(e)),
    x => x.code === 'layout-collision-unresolved'
  )
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false)
})
test('already valid canonical layout remains unmoved and Apply adds no history', async () => {
  const f = await fixture(true),
    before = f.editor.exportDefinition()
  f.editor.applyCollisionLayout(measurements(f.editor))
  assert.deepEqual(f.editor.exportDefinition(), before)
  assert.equal(f.editor.canUndo, false)
})
import { CanvasInteractions } from '../../src/client/features/authoring/logic/graph/flow-interactions.ts'
const commandFixture = () =>
  GraphEditor.fromDefinition({
    schemaVersion: 1,
    id: 'Commands',
    name: 'Synthetic',
    resources: {},
    graph: {
      nodes: ['a', 'b', 'c'].map(id => ({
        id,
        kind: 'input',
        inputs: { value: 'json' },
        outputs: { value: 'json' }
      })),
      edges: []
    },
    presentation: {
      nodes: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 900, y: 0 } },
      groups: [{ id: 'g', nodeIds: ['a', 'b'] }]
    }
  })
function interaction(e) {
  const measured = measurements(e),
    p = e.collisionProjection(measured)
  return new CanvasInteractions(() => ({
    editor: e,
    blueprintId: 'Commands',
    busy: false,
    locked: false,
    composing: false,
    displayPositions: p.ok ? p.positions : new Map(),
    measurements: measured
  }))
}
test('actual drag starts at display origin and preserves undragged display positions', () => {
  const e = commandFixture(),
    i = interaction(e),
    before = e.exportDefinition(),
    p = e.collisionProjection(measurements(e))
  assert.equal(p.ok, true)
  assert.equal(i.beginDrag(['b'], false), true)
  assert.deepEqual(i.gesture.positions.get('b'), p.positions.get('b'))
  i.previewDrag(40, 40)
  assert.equal(i.commitGesture(), true)
  assert.equal(e.nodes.find(n => n.id === 'b').x, p.positions.get('b').x + 40)
  for (const id of ['a', 'c']) {
    const after = e.collisionProjection(measurements(e))
    assert.deepEqual(after.positions.get(id), p.positions.get(id), 'non-dragged display position stays stable')
  }
  assert.equal(e.undo(), true)
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false)
  i.dispose()
})
test('actual group drag is rigid and a fixed member prevents gesture without writes', () => {
  const e = commandFixture(),
    i = interaction(e),
    p = e.collisionProjection(measurements(e))
  const before = e.exportDefinition()
  assert.equal(i.beginDrag(['a', 'b'], false), true)
  i.previewDrag(100, 80)
  i.commitGesture()
  const a = e.nodes.find(n => n.id === 'a'),
    b = e.nodes.find(n => n.id === 'b')
  assert.equal(b.x - a.x, p.positions.get('b').x - p.positions.get('a').x)
  assert.equal(b.y - a.y, p.positions.get('b').y - p.positions.get('a').y)
  e.undo()
  assert.deepEqual(e.exportDefinition(), before)
  e.patchPresentation(['a'], { pinned: true })
  const fixed = e.exportDefinition()
  assert.equal(i.beginDrag(['a', 'b'], false), false)
  assert.deepEqual(e.exportDefinition(), fixed)
  i.dispose()
})
test('actual resize and add each resolve within one undo transaction', () => {
  for (const op of ['resize', 'add']) {
    const e = commandFixture(),
      i = interaction(e),
      before = e.exportDefinition(),
      oldDisplay = e.collisionProjection(measurements(e)).positions
    if (op === 'resize') {
      assert.equal(i.beginResize('a'), true)
      i.previewResize({ width: 500, height: 400 })
      assert.equal(i.commitGesture(), true)
    } else assert.ok(i.add('input', { x: 0, y: 0 }))
    const p = e.collisionProjection(measurements(e))
    assert.equal(p.ok, true)
    assertProjectedSafe(e, p)
    if (op === 'add') assertCreatedSafe(e, oldDisplay)
    if (op === 'add') for (const id of ['a', 'b', 'c']) assert.deepEqual(e.exportLayout().nodes[id], before.presentation.nodes[id])
    assert.equal(e.undo(), true)
    assert.deepEqual(e.exportDefinition(), before)
    assert.equal(e.canUndo, false)
    i.dispose()
  }
})
test('actual clipboard paste resolves in one history edit and fixed collision is recoverable', async () => {
  const e = commandFixture(),
    before = e.exportDefinition(),
    oldDisplay = e.collisionProjection(measurements(e)).positions,
    fragment = e.createClipboard(['c'])
  const i = interaction(e)
  const result = await i.clipboard('paste', { readText: async () => JSON.stringify(fragment) }, { x: 0, y: 0 })
  assert.equal(result.ok, true)
  const p = e.collisionProjection(measurements(e))
  assertProjectedSafe(e, p)
  assertCreatedSafe(e, oldDisplay)
  for (const id of ['a', 'b', 'c']) assert.deepEqual(e.exportLayout().nodes[id], before.presentation.nodes[id])
  assert.equal(e.undo(), true)
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false)
  e.patchPresentation(['a', 'b'], { pinned: true })
  assert.equal(e.collisionProjection().ok, false)
  e.patchPresentation(['b'], { pinned: false })
  assert.equal(e.collisionProjection().ok, true)
  e.applyCollisionLayout(measurements(e))
  assert.equal(e.nodes.find(n => n.id === 'a').x, 0)
})

test('explicit Apply without required measurements rejects atomically', () => {
  const e = commandFixture(),
    before = e.exportDefinition()
  assert.throws(
    () => e.applyCollisionLayout(),
    error => error.code === 'missing-measurement'
  )
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false)
})
test('remote paste does not persist estimated positions of existing unmeasured nodes', () => {
  const e = commandFixture()
  e.nodes.find(n => n.id === 'b').y = 80
  const before = e.exportDefinition().presentation.nodes
  const result = e.pasteClipboard(e.createClipboard(['c']), { x: 3000, y: 3000 })
  assert.equal(result.ok, true)
  for (const id of ['a', 'b', 'c']) assert.deepEqual(e.exportLayout().nodes[id], before[id], 'new-node settling cannot write fallback geometry for old nodes')
})
test('actual clone of projected multi-member group preserves displayed relative positions', () => {
  const e = commandFixture(),
    i = interaction(e),
    p = e.collisionProjection(measurements(e))
  assert.equal(p.ok, true)
  const before = e.exportDefinition()
  assert.equal(i.beginDrag(['a', 'b'], true), true)
  i.previewDrag(1000, 1000)
  assert.equal(i.commitGesture(), true)
  const clones = e.nodes.filter(n => !['a', 'b', 'c'].includes(n.id))
  assert.equal(clones.length, 2)
  assert.equal(clones[1].x - clones[0].x, p.positions.get('b').x - p.positions.get('a').x)
  assert.equal(clones[1].y - clones[0].y, p.positions.get('b').y - p.positions.get('a').y)
  e.undo()
  assert.deepEqual(e.exportDefinition(), before)
  i.dispose()
})
test('actual Panel resize before fresh measurement keeps unrelated canonical coordinates', async () => {
  const f = await fixture()
  f.editor.nodes.find(n => n.id === 'b').y = 80
  const before = f.editor.exportDefinition(),
    flow = f.flow()
  flow.props.onNodesChange([
    { type: 'dimensions', id: 'a', dimensions: { width: 220, height: 180 } },
    { type: 'dimensions', id: 'b', dimensions: { width: 220, height: 180 } },
    { type: 'dimensions', id: 'c', dimensions: { width: 220, height: 180 } }
  ])
  const n = f.flow().props.nodes.find(n => n.id === 'a')
  n.data.onResizeStart()
  n.data.onResize({ width: 420, height: 400, x: 0, y: 0 })
  f.flow()
  n.data.onResizeEnd({ x: 0, y: 0 })
  const after = f.editor.exportDefinition()
  assert.deepEqual(after.presentation.nodes.b, before.presentation.nodes.b, 'missing fresh size must not settle old nodes with estimates')
  assert.deepEqual(after.presentation.nodes.c, before.presentation.nodes.c)
  if (f.editor.canUndo) {
    f.editor.undo()
    assert.deepEqual(f.editor.exportDefinition(), before)
    assert.equal(f.editor.canUndo, false)
  } else assert.deepEqual(after, before, 'refused resize rolls back atomically')
})
import { spawnSync } from 'node:child_process'
test('fractional world coordinates terminate collision projection within bounded process', () => {
  const moduleUrl = new URL('../../src/client/features/authoring/logic/graph/layout-collisions.ts', import.meta.url).href
  const script = `import {projectLayoutCollisions} from ${JSON.stringify(moduleUrl)};const r=projectLayoutCollisions([{id:'fixed',x:0,y:7.41,width:220,height:114.5,pinned:true},{id:'move',x:0,y:7.140000000000001,width:220,height:114.5}]);console.log(JSON.stringify({ok:r.ok,positions:r.ok?[...r.positions]:null}));`
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], { timeout: 3000, encoding: 'utf8' })
  assert.equal(child.error, undefined, 'projection must terminate; timeout is not an accepted geometry result')
  assert.equal(child.status, 0)
  const r = JSON.parse(child.stdout)
  assert.equal(r.ok, true)
  const positions = new Map(r.positions)
  assert.deepEqual(positions.get('fixed'), { x: 0, y: 7.41 })
  assert.ok(positions.get('move').y >= 7.41 + 114.5 + 14 - 1e-9)
})
